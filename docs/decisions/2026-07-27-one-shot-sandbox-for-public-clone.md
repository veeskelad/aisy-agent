# ADR-0066: Одноразовый изолированный sidecar для публичного clone

**Статус:** Принято
**Дата:** 2026-07-27
**Теги:** security, projects, sandbox

## Контекст

Aisy должна уметь создавать Project из публичного HTTPS Git-репозитория. До
скачивания код может проверить URL, DNS-ответ и запретить приватные, loopback,
link-local и зарезервированные адреса. Этого недостаточно: Git принимает и
распаковывает недоверенный pack до того, как Aisy успевает просканировать дерево.
Процесс на хосте поэтому остаётся уязвимым к исчерпанию диска, памяти, CPU и PID,
а также может унаследовать credentials или доступ к внутренней сети.

Clone является отдельной capability: он требует сети, но получаемые байты
недоверенны. Общий sandbox без сети не подходит, а обычный host Git не может
надёжно обеспечить все необходимые лимиты и сетевую изоляцию одновременно.

## Решение

Публичный clone выполняется только в одноразовом sandbox-container/sidecar,
запускаемом доверенным supervisor. Live-композиция clone по умолчанию выключена
и включается только при наличии реализации, которая применяет и подтверждает
весь профиль ниже.

1. Aisy канонизирует credential-free HTTPS URL, запрещает redirect и до запуска
   получает конечный непустой набор публичных IP-адресов.
2. Контейнер не имеет прямого внешнего маршрута. Единственный сетевой путь —
   доверенный egress-gateway, которому передаются точные IP:443 и TLS hostname.
   Gateway соединяется только с этим набором адресов и сохраняет проверку
   сертификата/SNI исходного hostname. Worker подключён только к внутренней
   `ipvlan`-сети без parent-интерфейса; gateway одновременно подключён к ней и
   к внешней bridge-сети с явно выбранным default gateway. Внутренняя сеть не
   даёт worker маршрут к интерфейсам хоста.
3. Worker не получает host mount. Репозиторий создаётся в `tmpfs` с жёстким
   лимитом размера; после успешного clone supervisor экспортирует только
   `/workspace/repo/.` в уже существующий пустой staging-каталог. Home, vault,
   SSH agent, Git config, credentials, control plane, Docker socket и остальные
   каталоги хоста недоступны. После экспорта существующий descriptor-aware
   confinement scan отклоняет symlink, hardlink, special file и выход за root
   до атомарной публикации.
4. Образ закреплён по digest. Root filesystem read-only; пользователь non-root;
   capabilities отсутствуют; `no-new-privileges` включён; host network и
   privileged mode запрещены.
5. Supervisor применяет жёсткие лимиты времени, размера `tmpfs`, RAM, CPU и PID,
   проверяет фактический Docker inspect до старта worker, уничтожает worker,
   gateway и сеть перед ответом и возвращает code-verifiable attestation точного
   policy hash. Отсутствующая, несовпадающая либо выданная до успешной очистки
   attestation означает отказ.
6. Git запускается без hooks, credential helper, submodules и LFS smudge;
   разрешён только протокол HTTPS, redirects запрещены.
7. После успешного clone Aisy выполняет существующий confinement scan. Только
   затем staging атомарно публикуется как Project. Ошибка clone, лимита,
   attestation или scan использует существующий quarantine/recovery путь.

Приватные репозитории и передача credentials не входят в это решение. Для них
потребуется отдельный capability и отдельное согласование модели секретов.

## Последствия

- **Положительно:** недоверенный Git pack не обрабатывается процессом на хосте;
  SSRF/DNS-rebinding не дают доступ к внутренней сети; resource exhaustion
  ограничен до анализа дерева; credentials отсутствуют по конструкции.
- **Нейтрально:** нужен доверенный supervisor и egress-gateway, способные
  применить профиль и вернуть attestation; Aisy проверяет этот контракт до
  публикации Project. Runtime должен поддерживать internal `ipvlan`,
  multi-network gateway priority, cgroup-лимиты и `tmpfs` quota. Минимум —
  Docker Engine 29.5.2: `gw-priority` появился в 28, а ветка 29.5 содержит
  security-исправления `docker cp` для недоверенной файловой системы контейнера.
  Supervisor проверяет server version до создания ресурсов; doctor также обязан
  fail closed при несовместимой версии.
- **Отрицательно:** clone требует container runtime и дополнительный сетевой
  компонент; запуск медленнее host Git; приватный clone отложен.

## Рассмотренные альтернативы

**Git на хосте с `http.curloptResolve`.** Точно связывает hostname с IP и может
запретить redirect, но не изолирует парсер pack, credentials и ресурсы хоста.

**Обычный контейнер с внешней сетью.** Ограничивает ресурсы, но DNS rebinding,
redirect или иной исходящий запрос всё ещё может достичь непроверенного адреса.

**Sandbox с `network=none`.** Имеет сильную изоляцию, но не способен получить
репозиторий; отдельная загрузка на хосте возвращает исходную проблему парсинга.

## Ссылки

- [ADR-0010: Break the Lethal Trifecta](./2026-06-11-break-lethal-trifecta.md)
- [ADR-0012: Docker Sandbox as Default](./2026-06-11-docker-sandbox-default.md)
- [ADR-0028: Default-Quarantine for External Input](./2026-06-11-default-quarantine-external-input.md)
- [Git HTTP configuration](https://git-scm.com/docs/git-config)
- [Git protocol allowlist](https://git-scm.com/docs/git)
- [libcurl `CURLOPT_RESOLVE`](https://curl.se/libcurl/c/CURLOPT_RESOLVE.html)
- [Docker: networking](https://docs.docker.com/engine/network/)
- [Docker: создание internal network](https://docs.docker.com/reference/cli/docker/network/create/)
- [Docker: драйвер `ipvlan`](https://docs.docker.com/engine/network/drivers/ipvlan/)
- [Docker: ограничения ресурсов контейнера](https://docs.docker.com/engine/containers/resource_constraints/)
- [Docker: hardening параметров `container run`](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker Engine 28: появление `gw-priority`](https://docs.docker.com/engine/release-notes/28/)
- [Docker Engine 29: исправления безопасности `docker cp`](https://docs.docker.com/engine/release-notes/29/)

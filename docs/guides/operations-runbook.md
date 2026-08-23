# Эксплуатационный runbook

Операции после запуска Aisy. Документ также закрывает требование EU AI Act к
operator runbooks; см. [карту соответствия](../compliance/eu-ai-act.md).

> **Статус:** автоматическое восстановление Node runtime/manager по ADR-0071
> подключено и принято на целевом хосте. Exact opt-in Docker startup recovery
> barrier по ADR-0089 подключён в production-коде, но ещё не прошёл target
> service-manager/real-Docker rehearsal. Docker sidecar create/use остаются
> выключены. Ни одна запись ниже не разрешает ручное удаление lease/ledger DB,
> legacy residue или обход quarantine.

## Проверка состояния и первичная диагностика

| Симптом | Первый шаг | Затем |
|---|---|---|
| Любое отклонение | `aisy doctor` | исправить красные проверки; `--fix` применяет только безопасные недеструктивные операции |
| Агент молчит в Telegram | строка `telegram` в `doctor` | проверить доступность подключения и ровно одного разрешённого оператора |
| Не прошла проверка памяти | строка `memory` в `doctor` | повреждённый derived index перестраивается через `aisy doctor --fix` с повторным применением forget invariant |
| Неожиданно высокий расход | `/usage` в чате | бюджеты ограничены кодом (spec 09); повышать лимиты только осознанно |
| Нужен отчёт об ошибке | `aisy diagnostics` | создаёт redacted bundle без секретов и тел фактов |

## Регулярные операции

- **Ночная консолидация** около 03:30 по локальному времени архивирует журналы,
  консолидирует память (`generator → отдельный judge → staging`), выполняет
  hygiene, отправляет git backup и готовит утреннюю approval-card. Без нажатия
  оператора изменения не попадают в live memory.
- **Резервные копии** отправляются только fast-forward. Ошибка показывается в
  утренней карточке. Доступность backup remote проверяется ежемесячно.
- **Забывание** необратимо: hash-chained forget-list и tombstones запрещают
  ночному циклу воскресить удалённый факт. Повторное добавление возможно только
  как отдельное человеческое действие.
- **Monitoring** по умолчанию активен, но при пустом registry не выполняет
  HTTP/model/Telegram I/O. Источник добавляется в Telegram через
  `📡 Монитор → 🔭 Источники`; первая строка — public HTTPS URL, следующие —
  необязательные критерии. RSS проверяется не чаще раза в 15 минут, Web — раза
  в 60 минут; daily digest по умолчанию формируется в 08:00 timezone оператора.
  Пауза сохраняет read-only grant exact domain, удаление отзывает его и
  сохраняет уже собранный корпус.

## Аварийные сценарии

| Инцидент | Действие |
|---|---|
| Подозрение на prompt injection | Недоверенный span блокирует outbound и Tier-2/3 действия. Получить `aisy diagnostics` и проверить immutable hash-chained trace. |
| Зацикливание | Loop Guardian (периоды 1/2/3) и глобальный budget остановят цикл и запишут событие. Проверить причину и построить новый план. |
| Повреждён derived SQLite index | `doctor` должен вернуть явную ошибку, а не пустой результат; `--fix` вызывает `rebuildFromFiles()` и повторно применяет forget invariant. |
| Manager завершён через `SIGKILL` | В service-managed режиме ОС перезапускает parent. Новый parent получает manager SQLite lease, ждёт освобождения runtime-liveness lease прежним child и только затем начинает recovery. Не удалять DB и не принимать решение по PID/возрасту файла. |
| Второй manager или прямой `aisy run` во время работы service | Проигравший запуск обязан завершиться без checkpoint/provider/tool/Telegram I/O. Не обходить singleton и не удалять lease DB. |
| Ошибка identity lease DB | Не создавать anchor и не переинициализировать DB вручную. `${journalRoot}/.transcript-writer-lease/transcript-writer-lease.sqlite3`, его anchor `transcript-writer-lease.sqlite3.identity.json` и permanent barrier должны совпасть по `databaseId/dev/ino`; role anchor exact `transcript-writer`. Anchor + missing/empty/mismatch/corrupt DB означает fail-closed; автоматический anchor recovery допустим только для валидной DB в доказанном bootstrap crash window. |
| Durable quarantine | Сервис остаётся zero-child. Собрать redacted diagnostics; выполнять только отдельную одобренную recovery-операцию для указанного code-only класса ошибки. Restart loop и ожидание времени не снимают quarantine. |
| `OWNED_DOCKER_PARENT_BROKER_REQUIRED` | Удалить legacy Docker activation из `aisy run/supervise` и оставить non-Docker режим. Старые поля не мигрируются в новый parent path. Если нужен только startup recovery barrier, выполнить exact enrollment ниже; это не возвращает Docker Bash/Whisper/clone. `doctor` остаётся доступен. |
| Writer lease transcript занят другим process | При enabled journal runtime обязан завершиться до provider/tool/Telegram I/O. Не удалять DB/barrier и не принимать решение по PID/времени; проверить, что запущен ровно один service/direct runtime. После фактического OS exit `BEGIN IMMEDIATE` освобождается ядром. |
| Legacy `.transcript-writer.lock/` или `owner.json` | Это permanent fail-closed compatibility residue, а не «старый файл». Runtime и doctor не удаляют его. Остановить service и выполнять только отдельный согласованный cutover после доказанной quiescence всех legacy/new writer. После cutover на этом пути остаётся regular file mode `0600` exact `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}`. |
| Barrier имеет `nlink=2` | Runtime автоматически завершает только exact crash boundary, когда существует ровно один same-inode private `..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`: удаляет temp и fsync-ит directory. Любой иной hardlink/residue остаётся fail-closed. `aisy doctor`, включая `--fix`, ничего не меняет и сообщает corrupt. |
| Corrupt/unsafe/identity drift writer DB или anchor | Не переинициализировать DB, не создавать anchor и не заменять inode вручную. Собрать redacted diagnostics; enabled runtime остаётся остановленным до отдельного forward-repair решения. |
| Нужен временный rollback полного журнала | Для текущего binary использовать только exact `AISY_SESSION_JOURNAL=0`. Этот режим не читает и не меняет DB, anchor, barrier или transcript. Не запускать старый binary: permanent regular `.transcript-writer.lock` намеренно блокирует его directory-lock path. |
| Потерян или заменён credential | Обновить локальный vault, затем проверить доступность через `aisy doctor`. |
| Нужно немедленно остановить monitoring egress/delivery | Установить exact `AISY_MONITORING=0` и выполнить штатный restart supervisor. Это отключает source UI/scheduler/delivery, но не удаляет `monitoring.db`, grants, evidence и ready digests. Не удалять DB или source вручную. |
| Monitoring source перешёл в паузу | Открыть его карточку в `📡 Монитор → 🔭 Источники`. `collector-error`, budget/context failure и quarantine не обходить расширением домена; исправить причину и нажать «Возобновить». Для смены domain удалить прежний source и добавить новый. |
| Monitoring delivery повторяет failure без нового сообщения | Не удалять `monitoring-telegram-delivery.json`: `sending` означает неоднозначный результат после возможного принятия Telegram. Установить `AISY_MONITORING=0`, сверить чат и локальный digest/receipt; повтор exact key автоматически запрещён. |
| `OWNED_DOCKER_PRODUCTION_CONFIG_INVALID` | Проверить exact набор из пяти `AISY_OWNED_DOCKER_*` полей в parent service environment. Не переносить их в runtime `.env` и не ослаблять проверку identity. |
| `OWNED_DOCKER_SUPERVISOR_REQUIRED` | Запуск выполнен через direct `aisy run`. Снять Docker recovery opt-in либо использовать service-managed `aisy supervise`; direct run не получает recovery authority. |
| Supervisor остаётся zero-child после Docker opt-in | Остановить restart loop, проверить наличие предварительного enrollment и соответствие installation ID, canonical socket, daemon ID/version. Missing ledger или drift не исправлять reinit поверх существующего state; собрать redacted diagnostics и выполнить согласованный rollback либо отдельное forward-migration решение. |
| Восстановление из backup | См. [развёртывание](deployment.md#секреты-и-резервное-копирование). |

## Parent Docker recovery barrier

Этот opt-in нужен только хосту, который уже принял риск доступа parent к Docker
socket. Он восстанавливает ранее зарегистрированные owned resources до первого
child spawn, но не включает Docker Bash, Whisper или restricted clone.

1. Остановить Aisy service и доказать отсутствие старого parent/child. Не
   удалять manager/runtime lease или существующий Docker ledger.
2. Из доверенного host inventory получить canonical абсолютный Unix socket,
   exact daemon ID и совместимую server version (не ниже `29.5.2`). Создать один
   installation ID как 32 random bytes в lowercase hex и сохранить его в
   конфигурации хоста; автоматического trust-on-first-use нет.
3. В том же `HOME`/`XDG_STATE_HOME`, который использует service, передать ровно
   `AISY_OWNED_DOCKER_RECOVERY=1`, `AISY_OWNED_DOCKER_SOCKET`,
   `AISY_OWNED_DOCKER_INSTALLATION_ID`, `AISY_OWNED_DOCKER_SERVER_ID` и
   `AISY_OWNED_DOCKER_SERVER_VERSION`, затем один раз выполнить
   `aisy docker enroll`. Команда создаёт private v4 ledger, но не запускает
   child и не отправляет Docker mutation.
4. Закрепить те же пять полей только в parent service environment и запустить
   `aisy supervise`. Успех означает завершённый recovery barrier до первого
   child; поля удаляются на child boundary.
5. Из того же parent environment выполнить `aisy doctor --only=sidecars`.
   Проверка обязана показать `sidecars.owned-docker-recovery` как ready; doctor
   делает только read-only ledger/daemon probe и не заменяет startup recovery.

Rollback текущего binary: удалить все пять полей из parent service environment
и штатно перезапустить supervisor. Ledger сохраняется для последующего
расследования/возврата; удалять его вручную нельзя. Смена socket inode, daemon
ID/version или installation ID не является обычным restart. Текущая команда
enrollment намеренно не перезаписывает прежний ledger: для смены identity нужно
отдельное forward-migration решение после доказанного zero owned resources.

Manager lease освобождается ядром и потому не требует аварийной команды для
«stale manager lock». Будущая аварийная консоль остаётся нужна для иных
случаев: corrupt durable state, недоказуемой execution authority, legacy
writer cutover и forward repair повреждённого transcript state. Она не должна
выполнять PID/`mtime`/time-based takeover.

Steady-state writer lease по ADR-0068, как и manager/runtime lease, использует
local-FS SQLite `BEGIN IMMEDIATE`: hard crash holder автоматически освобождает
kernel lock. Но это не разрешает автоматический repair DB/anchor или legacy
directory. Exact compatibility barrier `.transcript-writer.lock` является
regular private file и сохраняется навсегда, в том числе при
`AISY_SESSION_JOURNAL=0`.

Публичные состояния writer lease ограничены
`held-by-another-process`, `legacy-residue`, `lease-unsafe`, `lease-corrupt`,
`lease-unavailable` и `lease-lost`. Внутренние пути, SQLite-текст и owner data
в операторский ответ не включаются.

`aisy doctor` для writer state только read-only: `--fix` не получает lease, не
завершает bootstrap, не создаёт anchor и не удаляет residue. До LIVE отдельный
self-test на фактическом journal filesystem должен доказать contention,
`SIGKILL` release и повторный захват того же DB inode. NFS/SMB не
поддерживаются. Evidence текущего среза: transcript-тесты на реальных процессах
— 12/12; объединённая process-матрица — 31/31; полный App gate — 132 файла
тестов успешно / 1 пропущен, 1031 тест пройден / 1 пропущен; typecheck App и
upstream-сборка зелёные. Self-test на целевой FS, ручной legacy cutover и
LIVE-активация этим не заявляются.

Runtime-liveness SQLite lease доказывает завершение Node runtime, но не
произвольных orphan descendants и внешних sidecar effects. До LIVE activation
обязателен отдельный process-group/sidecar corpus. NFS/SMB для lease DB не
поддерживаются.

Практический урок Docker: контейнер и сеть принадлежат daemon, а не процессу
Node, который вызвал CLI. При hard crash `finally`, локальные created-флаги и
обычная process group исчезают раньше ресурса. Поэтому отсутствие старого PID
не разрешает новый sidecar effect; activated Docker path обязан сначала пройти
durable reconcile ADR-0089 и доказать отсутствие exact owned resources.

Ещё один важный crash-случай: пустой `docker ps/inspect` сразу после restart не
доказывает, что прежний create-запрос не был принят daemon и не завершится
позже. Поэтому intent переводится в `attempted` до отправки create. Если после
restart object ID ещё не виден, runtime остаётся в quarantine; запись нельзя
очищать по одному пустому scan. Это отказ безопасностью, а не Docker-сбой,
который разрешено скрыть retry нового child.

Практический урок SQLite для Docker ledger: даже открытие базы через
`better-sqlite3` с `readonly: true` может материализовать persistent `-wal/-shm`.
Поэтому zero-mutation refusal нельзя доказывать флагом библиотеки. До первого
SQLite open Aisy читает raw header через `O_RDONLY|O_NOFOLLOW`, проверяет
rollback-journal bytes, application/user version и companion artifacts. Hot
private `-journal` читается для committed identity proof; RW recovery начинается
только после exact activation proof и захвата writer lease.

Практический урок endpoint attestation: сохранённые socket path, daemon ID и
server version сами по себе не доказывают, что следующая команда уйдёт тому же
daemon. Отдельные `docker version` и `docker rm` запускаются разными процессами,
между ними endpoint можно заменить. Поэтому LIVE cleanup требует attestation и
операции на одном закреплённом Engine HTTP соединении; разрыв или смена
generation означают quarantine. CLI adapter остаётся только dormant
диагностическим слоем и не разрешён для mutation path.

Parent-only `removeExact` — библиотечный recovery primitive внутри startup
recovery manager, а не
операторская cleanup-команда. Наличие восьми корректных labels само по себе не
даёт права на удаление: объект должен совпасть с одной `bound` row текущего
recovery ledger по всей operation/resource identity. Broker удерживает recovery
dispatch barrier, повторно доказывает объект на той же socket generation,
адресует DELETE только по immutable ID и требует post-inspect `404`.
Неоднозначный результат оставляет durable intent для quarantine. Нельзя
заменять broker ручным `docker rm`, возвращать legacy activation settings или
считать startup recovery разрешением sidecar create/use.

Практический урок Unix socket/Node HTTP: одного `socketPath` недостаточно.
Закреплённая proof-сессия сверяет canonical path и inode до connect и после
каждого ответа, запрещает symlink и world-writable socket, а
`version → info → inspect` проводит через один физический socket без reconnect.
`Connection` является списком токенов, поэтому `keep-alive, close` тоже означает
неоднозначность. Полные raw headers и trailers проверяются по cardinality;
молчаливая обрезка Node не принимается как attestation. Любой abort, timeout,
truncation или endpoint drift закрывает сессию, а не запускает retry.

Практический урок нормализации: Docker CLI Go-template и raw Engine JSON — два
представления одного inspect, а не два разных ownership-контракта. Projection
hash, разбор восьми `com.aisy.resource.*` labels и network endpoint count должны
проходить один bounded normalizer. Иначе исправление в pinned path может не
попасть в recovery CLI или наоборот. Нормализатор не возвращает raw Docker
document и не включает его в ошибку; malformed/hostile shape даёт только
стабильный code-only отказ.

Практический урок Node abort: проверка одного prototype у `AbortSignal` не
доказывает genuine platform object и допускает собственные getters/methods.
Recovery broker снимает descriptor snapshot без выполнения caller-кода,
проверяет signal захваченным intrinsic getter и дальше работает только с
broker-owned composite. Это сохраняет code-only ошибки даже для forged object,
Proxy и accessor overrides.

Практический урок semantic plan: намерение sidecar и фактическая Docker
проекция — разные доказательства. План может заранее зафиксировать roster,
порядок attestation/start/wait, hashes, лимиты и обязательные manifests, но не
имеет права выдумывать inherited image defaults или результат Engine inspect.
Поэтому dormant draft не содержит Docker request, `prepareInput`, финальный
projection/policy hash или mutation capability. Для restricted clone raw TLS
hostname и IP set заменены SHA-256 commitments; для Whisper действует baseline
ADR-0072 3 GiB/2000m/64 PID до отдельного измерительного evidence.

Появление branded semantic draft не разрешает запуск контейнера. До create/use
обязательны реальные image-runtime и Engine create→inspect manifests; clone
дополнительно требует IPAM reservation, exact endpoint membership и bounded
archive-stream manifest. Отсутствие любого из них должно давать fail-closed, а
не fallback к старому CLI supervisor.

Evidence shared normalizer: normalization/CLI/coordinator 43/43, App
typecheck/build и полный App regression 1189 passed / 17 skipped; fixture
process leak не обнаружен, независимый review P0=0, P1=0. Лимиты normalizer:
1 MiB cumulative UTF-8, 1 MiB canonical JSON, 50 000 узлов, depth 32 и 4096
network endpoints.

Legacy Docker activation в direct/supervised child теперь отказывает до state и
внешнего I/O. Это намеренный safety gate: отсутствие Bash/Whisper Docker port в
child лучше, чем контейнер без durable intent и recovery epoch. Настройка не
переносится молча — оператор получает стабильный
`OWNED_DOCKER_PARENT_BROKER_REQUIRED`.

Evidence child-denial gate: policy/CLI/IPC/parent 69/69, App typecheck/build и
полный App regression 1141 passed / 17 skipped; fixture process leak не
обнаружен. Это подтверждает отказ legacy path, но не активирует parent broker.

Evidence pinned read-only proof-сессии: собственный корпус 41/41, совместно с
Engine transport 55/55, App typecheck/build и полный App regression 1182 passed
/ 17 skipped; fixture process leak не обнаружен, независимый review P0=0,
P1=0. Этот исторический read-only evidence сам по себе не доказывает create/use,
`removeExact` либо реальный daemon.

Исторический evidence parent-only `removeExact`: broker 27/27, объединённый
broker/pinned/normalizer/Engine/ledger/coordinator gate 131/131; App
typecheck/build и полный App regression 1216 passed / 17 skipped зелёные;
diff-check чистый, fixture process leak не обнаружен; независимый review P0=0,
P1=0. Актуальный production gate ledger/enrollment/adapter/policy/manager/
supervisor/CLI doctor — 101/101, Core onboarding/doctor — 93/93; полный Core —
2333 passed / 1 skipped, полный App — 2400 passed / 18 skipped. Это
подключает startup cleanup barrier, но не create/use и не заменяет real-Docker
rehearsal.

Evidence dormant semantic plans: три новых корпуса 29/29; объединённый
semantic + существующий Whisper/clone supervisor срез 49/49; App
typecheck/build и diff-check зелёные; полный App regression — 1245 passed / 17
skipped (141 test files passed / 5 skipped). Это только проверка code-owned contracts:
Docker daemon, ledger mutation, parent/child IPC и LIVE path не вызывались.

Для Docker authority-hash запрещена канонизация целого объекта через
`JSON.stringify`: унаследованный `toJSON` может изменить expected и observed
projection одинаково. Shared normalizer использует ручную scalar-only
канонизацию и проверяется frozen golden hashes; gate normalizer/CLI — 22/22,
полный App regression — 1246 passed / 17 skipped.

Read-only image evidence снимается только через one-shot pinned session:
`version → info → images/<digest>/json` на одном Unix socket, без tag, pull,
registry credentials, retry или mutation. `404` не является evidence; invalid
per-call options отказывают до расходования session. Gate: 55/55 собственных и
104/104 объединённых Docker tests; полный App regression — 1260 passed / 17
skipped.

Полученный evidence можно передать только в code-owned
`createDockerImageRuntimeManifest`. Подделанный структурный объект factory
отклоняет. Успех означает лишь, что endpoint, RepoDigest, отдельный image ID,
platform и разрешённые inherited runtime defaults зафиксированы в frozen
manifest с domain-separated hashes. Неизвестное поле Config, чужой
`com.aisy.*` label или environment name вне allowlist — повод остановить
активацию и пересобрать/переаттестовать образ, а не расширять allowlist на
работающей системе. Image ID нельзя сравнивать с RepoDigest: в Docker это разные
content-addressed объекты. Gate manifest-а: 13/13 собственных и 117/117
объединённых Docker security tests; полный App regression — 1273 passed / 17
skipped. Manifest не является sealing, ledger publication или разрешением
create/use/LIVE.

При диагностике container projection нельзя проверять только `Config.Image`:
это create reference, а фактически исполняемый config Docker сообщает отдельно
в top-level `Image`. Shared normalizer и CLI обязаны получать оба значения;
top-level ID имеет вид `sha256:<64 lowercase hex>`. Missing/malformed ID или
изменение одного из двух значений меняет/отклоняет projection до ledger
authority. Актуальный gate: normalization/CLI/recovery 50/50, объединённый
Docker security 132/132, полный App 1274 passed / 17 skipped.

Не используйте полный V1 inspect hash как pre-create ожидание: Docker
материализует часть Config/HostConfig только после `create`. Для будущего
direct Engine broker предусмотрена selected projection V2. Она хеширует exact
code-owned safety fields до create, а после create выбирает те же поля из
inspect. Расхождение V2 hash или image ID означает quarantine/no start; нельзя
подставлять daemon defaults, расширять normalizer на ходу или записывать V2 в
старое поле V1. Текущий V2 слой dormant: Engine I/O, prepare и mutation в нём
отсутствуют. Проверенный gate: V2 8/8, объединённый Docker contract 67/67,
workspace typecheck/build, полный App 1282 passed / 17 skipped, P0=0/P1=0.

Genuine Whisper/Bash create plan не является разрешением запуска. Он доказывает
совпадение semantic draft, pinned image, текущего root identity и selected V2
projection; raw root/command остаются скрыты. Перед будущим create parent обязан
повторно проверить root identity, получить ledger-owned ownership labels и
one-shot seal. Один projection-only match без exact ownership/epoch/ledger
binding запрещено трактовать как bind/start authority.

Runtime в такой план нельзя передать вручную. Он должен прийти из genuine
endpoint-bound probe `/version` + `/info`; отсутствие builtin seccomp,
`userns`/`rootless` или reviewed runtime закрывает операцию. Значение
`degraded-no-gvisor` видно в плане и меняет isolation-profile hash; политика
high-risk tools должна отклонить его до будущего create.

Практический урок runtime probe: строка `runsc` в конфигурации доказывает только
намерение caller, но не наличие gVisor у того Docker daemon, который выполнит
create. Поэтому runtime выводится из pinned `/info`, привязывается к endpoint и
профилю, а поддельный spread/clone evidence отвергается до request generation.

Практический урок безопасных Docker maps: code-owned maps без prototype и maps
из `JSON.parse` с `Object.prototype` являются двумя допустимыми представлениями.
Descriptor-only validator обязан явно принимать ровно эти два prototype и
по-прежнему запрещать Proxy, accessors, symbols и произвольную цепочку prototype;
иначе genuine image labels ложно выглядят как Docker drift.

Проверенный gate create-plan среза: pinned runtime + create-plan 63/63,
объединённый Docker security/contract 130/130, workspace typecheck/build,
полный App regression 1290 passed / 17 skipped и независимый kill-matrix
P0=0/P1=0.

Не записывайте selected V2 hash в legacy `projection_hash` schema v3. Это поле
означает полный post-create V1 и до Docker create неизвестно. Schema v4 хранит
immutable create contract/hash отдельно, а bound V1 оставляет `NULL` до
атомарного bind с object ID. Любой v1–v3 ledger для нового binary — offline-only;
автоматическое открытие, in-place или down migration запрещены.
Полная проверка v4 operations/resources и их phase/nullability/integrity связей
выполняется до `enterRecovery` и до Docker probe: corrupt row не должна успеть
изменить manager epoch/state или вызвать внешний I/O.

Проверенный dormant v4 gate: ledger/coordinator/normalizer/CLI/pinned Engine/
recovery broker 160/160; Docker-oriented corpus 282 passed / 1 opt-in live smoke
skipped; workspace typecheck/build; полный App regression 1301 passed / 17
skipped; fixture processes после тестов отсутствуют; независимый review
P0=0/P1=0. Реальный Docker daemon и LIVE wiring не активировались.

Evidence offline/process foundation и dormant Docker ledger/coordinator/adapter:
operational denial даёт code-only отказ, а не ложный proof; последний targeted
ledger/coordinator/CLI/Engine gate 70/70, App typecheck/build зелёные;
полный App regression — 1136 passed / 1 skipped; предыдущий workspace gate —
Core 2039 passed / 1 skipped, Telegram 146
passed, полный App после atomic test-marker fix дважды прошёл без failures —
1105 passed / 1 skipped и 1104 passed / 2 skipped. Python sidecars 52 passed /
1 skipped, Ruff зелёный. Проверка после gate не нашла fixture processes. Это не
является LIVE activation, wiring sidecars или real-Docker доказательством
ADR-0089.

Зафиксированный offline/process gate: targeted unit 79/79, real-process parent
10/10, Telegram recovery 9/9; workspace — Core 2019 passed / 1 skipped,
Telegram 146, App 1013 passed / 1 skipped после typecheck/build; Python
sidecars 52 passed / 1 skipped, Ruff зелёный. После корпуса fixture process
leak равен нулю; это не расширяет гарантию на произвольные descendants.

## Аудит и записи

- **Неизменяемый trace:** каждый model/tool/approval call находится в
  append-only hash-chained журнале Observability. Compaction создаёт view, а не
  переписывает исходный trace (ADR-0040).
- **Approval records:** каждое подтверждение карточки фиксирует actor, время и
  action hash (spec 02/05, ADR-0029).
- **Персональные данные и секреты:** удаляются на journal sink и из diagnostics
  bundle.

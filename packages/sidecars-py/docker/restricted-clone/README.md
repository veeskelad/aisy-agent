# Образы restricted public clone

Dockerfile содержит две независимые цели:

- `gateway` — одноразовый HTTP CONNECT gateway, который принимает только
  утверждённый hostname:443 и соединяется напрямую с точным набором IP;
- `worker` — credential-free Git clone worker, пишущий только в capped tmpfs.

Оба базовых образа при сборке обязательны в форме `name@sha256:<digest>`.
`PYTHON_BASE_IMAGE` должен содержать Python 3.12+, а `CLONE_BASE_IMAGE` — Python
3.12+ и Git. Теги без digest, автоматическая установка пакетов и загрузка
зависимостей во время production clone запрещены.

Пример воспроизводимой сборки:

```bash
docker build --pull=false \
  --build-arg PYTHON_BASE_IMAGE="registry.example/python@sha256:<digest>" \
  --build-arg CLONE_BASE_IMAGE="registry.example/python-git@sha256:<digest>" \
  --target gateway -t aisy/restricted-clone-gateway:build \
  -f docker/restricted-clone/Dockerfile .

docker build --pull=false \
  --build-arg PYTHON_BASE_IMAGE="registry.example/python@sha256:<digest>" \
  --build-arg CLONE_BASE_IMAGE="registry.example/python-git@sha256:<digest>" \
  --target worker -t aisy/restricted-clone-worker:build \
  -f docker/restricted-clone/Dockerfile .
```

После сборки образы публикуются в доверенный registry и в конфигурацию Aisy
записываются только их полные digest-qualified references. Runtime использует
`--pull=never` и не загружает образ во время операции clone.

Supervisor требует Docker Engine 29.5.2 или новее и проверяет server version до
создания сети. Это одновременно обеспечивает `gw-priority` и исправленный путь
`docker cp` для экспорта из недоверенной файловой системы контейнера. Более
старый либо нераспознаваемый runtime закрывает clone без создания ресурсов.

Read-only smoke несовместимого локального daemon запускается из корня
репозитория явно и не входит в обычный test suite:

```bash
pnpm --filter @aisy/app exec vitest run --mode=restricted-clone-smoke \
  src/restricted-clone-docker-supervisor.integration.spec.ts
```

Внутренний guard этого теста разрешает только `docker version`; любая команда
создания сети или контейнера отклоняется до вызова Docker. Smoke должен
проходить только на Engine ниже 29.5.2. Полный E2E профиля требует совместимого
Engine и отдельного согласования live-активации.

Read-only подготовка конфигурации для `aisy doctor`:

```text
AISY_RESTRICTED_CLONE_ENABLED=false
AISY_RESTRICTED_CLONE_WORKER_IMAGE=registry.example/aisy/worker@sha256:<digest>
AISY_RESTRICTED_CLONE_GATEWAY_IMAGE=registry.example/aisy/gateway@sha256:<digest>
```

Сначала оставляют `ENABLED=false`: doctor возвращает warning и не обращается к
Docker от имени restricted clone. После загрузки обоих exact RepoDigest и
успешной проверки runtime значение можно предложить к отдельной live-активации.

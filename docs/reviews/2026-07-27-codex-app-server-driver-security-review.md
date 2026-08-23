# Проверка безопасности Codex app-server driver

Дата: 2026-07-27
Область: Component 16, supervised Codex subscription runtime, stable JSONL
protocol subset, Node stdio transport, streaming, cancellation и durable
restart binding

## Проверенные инварианты

- Driver принимает только exact profile `codex-app-server-v2@0.144.5` и перед
  открытием session повторно проверяет фактический `codex-cli 0.144.5`.
  Неизвестная версия закрывается стабильным `CODEX_PROTOCOL_UNSUPPORTED`.
- `codex --version` parser извлекает только официальный version marker и
  отбрасывает warning, path и environment detail из объединённого stdout/stderr.
- Version/login/status/logout и app-server используют один canonical
  owner-controlled executable. Auth port допускает только exact `--version`,
  `login --device-auth`, `login status` и `logout` и получает общий безопасный
  allowlist процесса.
- Handshake использует stable API без `experimentalApi`: `initialize`,
  `initialized`, `thread/start|resume`, `turn/start`, `turn/interrupt`.
- Новый thread запускается только с exact Project root,
  `sandbox=read-only`, `approvalPolicy=never` и reviewer `user`. Model, root,
  Project и Session проходят bounded deterministic validation.
- Persisted binding содержит только Project, Session, opaque Codex thread id и
  protocol profile. Resume принимает exact record; cross-project/session,
  corrupted profile и substituted thread закрываются без создания replacement.
- Каждое поддерживаемое delta/item/completion notification обязано совпасть с
  активными threadId и turnId. Unbound/foreign event прерывает turn до выдачи
  его content наружу.
- Reply ограничен 4 MiB, prompt — 2 MiB на каждую часть. Raw protocol errors,
  close errors и provider output не входят в `BrainEvent.failed`.
- До Aisy-owned tool bridge все command/file/MCP/dynamic/collaboration items и
  любые server-initiated requests запрещены. Driver вызывает `turn/interrupt`,
  не auto-approve и не переносит raw action в event.
- Abort до start не открывает app-server. Abort активного turn посылает
  best-effort interrupt и закрывает session, чтобы разблокировать event stream.
- Node transport принимает только canonical absolute, owner-owned executable и
  рабочий каталог без group/world write. Spawn использует exact
  `app-server --listen stdio://`,
  `shell=false` и pipe-only stdio.
- Environment дочернего процесса строится по allowlist. Provider/API keys и
  произвольные parent variables не наследуются; stderr только дренируется и
  отбрасывается.
- Request/notification methods allowlisted. JSONL frame, pending map и event
  queue bounded; malformed/oversized input, unknown/replayed id, timeout,
  overflow и второй event consumer закрывают всё соединение.
- SQLite store использует canonical private path, каталог `0700`, файл `0600`,
  `journal_mode=DELETE`, `synchronous=FULL`, `secure_delete=ON` и
  `BEGIN IMMEDIATE`. Startup проверяет exact schema, отсутствие лишних объектов,
  integrity и каждую сохранённую binding row.
- Уникальный thread не может принадлежать двум Project/Session. Два store
  instance имеют одного winner; identical retry остаётся идемпотентным.

## Доказательства

- `codex-app-server-driver.spec.ts`: 15 tests — exact request profile, streaming,
  restart resume, corrupt binding, foreign/unbound events, native tool denial,
  server request denial, output cap, pre-start и mid-stream cancellation,
  unsupported version и auth lifecycle.
- `codex-auth.spec.ts`: 10 tests — safe device challenge, exact official
  commands, warning-safe version parsing, status/logout redaction, exact
  executable, process allowlist и config/command denial.
- `codex-app-server-node.spec.ts`: 13 tests — exact spawn/env/path permissions, framing,
  correlation, method allowlist, protocol violations, bounded queue, timeout,
  single consumer и idempotent close.
- `sqlite-codex-thread-store.spec.ts`: 9 tests — real restart, collision,
  cross-process winner, canonical permissions/symlink, exact schema и dormant
  corruption detection.
- `codex-app-server-node.integration.spec.ts`: real filesystem store + JSONL
  fake child, exact start на первом процессе и resume после restart.
- `codex-read-only-runtime.spec.ts`: 2 app tests — production factory restart
  resume, idempotent close и no-store-on-invalid-config.
- `codex-capability-bridge.spec.ts` и `codex-capability-executor.spec.ts`: 12
  core tests — exact authority/provenance, replay/budget/abort, HARD_DENY,
  approval и exact-binding grant.
- `codex-capability-runtime.spec.ts`: реальный Project-root effect через свежую
  durable lease; Workspace root остаётся неизменным.
- `codex-app-server-real.integration.spec.ts`: opt-in account-free test прошёл
  против реального установленного `codex-cli 0.144.5`; проверены version и
  stable stdio handshake в изолированном временном профиле без login/turn.
- Полный gate: core 1436 passed и 1 opt-in skipped, app 276/276, Telegram
  104/104; opt-in real-process smoke отдельно прошёл 1/1; workspace typecheck
  зелёный.

## Незавершённые границы

- MCP wire adapter к Aisy-owned typed tool/approval bridge отсутствует.
  Read-only driver не должен использоваться как замена action-required runtime.
- Официальный custom `dynamicTools` flow является experimental и требует
  `experimentalApi=true`, поэтому он намеренно не включён. Stable локальный
  MCP wire adapter к Aisy-owned bridge требует отдельного решения/ADR после
  публикации финальной MCP schema.
- Добавлены transport-independent capability bridge и общий Safety/Approval
  executor: authority и provenance замкнуты на exact
  Project/Session/thread/turn, model args не могут назначить себе provenance,
  действуют tool allowlist, active-binding check, call budget, idempotent retry,
  altered-replay denial, HARD_DENY и scoped grants. App seam выполняет эффект
  только через свежую durable Project lease; targeted gate 12/12 + app E2E 1/1.
- MCP `2026-07-28` пока доступен как locked RC/draft и меняет handshake/session
  на stateless per-request contract. Wire adapter откладывается до финальной
  schema 28 июля; core bridge от protocol era не зависит.
- Pinned Codex binary содержит markers как `2026-07-28`, так и legacy revisions.
  Это подтверждает наличие protocol code, но не negotiated client behavior;
  positive/negative controlled-server E2E после GA остаётся обязательным.
- Live composition, Telegram routing и activation не выполнялись.

## Вывод

Контур безопасно доказывает version-pinned session/stream/cancel, bounded Node
JSONL transport и durable filesystem restart без передачи control plane Codex.
Production readiness не заявляется до MCP wire adapter и live routing/activation.

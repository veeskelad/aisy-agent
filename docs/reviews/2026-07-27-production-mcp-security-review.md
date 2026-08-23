# Security/restart/rollback review: production gate MCP

**Дата:** 2026-07-27  
**Область:** core MCP manager, durable allowlist, startup catalog, Node store,
частичная проводка `aisy run`  
**Результат:** critical/high findings в реализованной offline-границе закрыты;
review не разрешает transport dependency, external connect или live activation.

## Найдено и исправлено

### F-1 — `call()` обходил connect gauntlet

Allowlisted policy можно было вызвать напрямую: call path проверял egress и
credential, но не повторял live pin/descriptor hash. Теперь каждый call на том
же handle до invocation проверяет pin и `tools/list`; mismatch завершает handle,
выдаёт событие и не вызывает tool.

### F-2 — missing pin/hash проверялись после process creation

Первый вариант per-call hardening создавал handle до отказа по отсутствующему
pin/hash. Проверки перенесены перед scoped credential resolution и любым
process/network I/O. Параметризованный regression подтверждает ноль spawn/invoke.

### F-3 — risk class отсутствовал в resolved authority

Tier и outbound были human-owned, но `readOnly/idempotent/destructive` оставался
только текстом спецификации. `riskClass` стал обязательной частью
`McpToolPolicy` и `ResolvedMcpCall`; production parser запрещает несовместимые
read-only sink и destructive non-sink.

### F-4 — core manager принимал невалидированный произвольный object config

Добавлен production manifest gate с exact fields, bounds, duplicate/collision
checks, fixed transport forms, exact pin, approved-descriptor hash и policy ↔
descriptor relation. Startup manager строится только из defensive snapshot.

## Restart и rollback

- invalid approved state сохраняется в атомарном quarantine;
- restart принудительно архивирует quarantined entry;
- исходный allowlist не удаляется и доступен для post-mortem;
- transient outage/missing credential не превращается в durable ban;
- transport остаётся выключен, поэтому rollback текущего инкремента — удалить
  новый allowlist/quarantine state или оставить пустой manifest; внешних
  процессов и удалённых изменений нет.

## Остаточные ограничения

- Stdio/Streamable HTTP adapter не реализован и не выбран. Добавление official
  MCP SDK является consequential dependency и требует отдельного ADR оператора.
- Preview `McpCapabilityRuntime` теперь выполняет concrete policy resolution до
  HookGate, frozen safe-summary menu и bounded defang/classifier/quarantine
  result gate. Он не подключён к `aisy run`, поэтому это доказательство
  pre-live границы, а не разрешение live release.
- MCP menu пока не входит в live frozen prefix, а main/subagent providers не
  получают dynamic MCP schemas.
- HTTP OAuth 2.1, DNS rebinding/redirect checks, timeouts, frame limits,
  cancellation и process supervision должны быть доказаны transport E2E до
  активации.

## Ремедиация после review

- `McpManager.resolve` возвращает immutable human-owned tier/outbound/risk без
  process/network I/O; startup catalog сверяет exact owner, uniqueness и
  `rw/tier` каждой menu line.
- HookGate оценивает concrete `mcp:read|write:<server.tool>`, поэтому generic
  wrapper/grant не скрывает Tier-2/3 и narrowing.
- Resolution создаёт только pending binding. Авторизация становится исполнимой
  после финального Safety/human `allow`; deny/reject очищает её. Executor
  one-use, проверяет fingerprint и повторно резолвит policy перед invocation.
- Menu summary и result проходят InputGuard; подозрительный/oversize/invalid
  result заменяется фиксированным кодом без raw content.
- Targeted regression: 158 MCP/catalog/HookGate/Safety тестов.
- SHA-256 не является MAC против процесса с теми же OS-правами; локальная
  граница доверия остаётся account + `0700`/`0600`.

## Доказательства инкремента

- 55 targeted core/capability tests;
- 3 Node persistence/restart tests;
- полный regression: build/typecheck зелёные; 1135 core + 101 Telegram +
  174 app = 1410 TypeScript tests; Python — 29 passed, 1
  platform-specific skip; Ruff и `git diff --check` зелёные;
- Локальный приватный эталон подтверждён как ignored; tracked/staged файлов из
  него нет, имя и путь не публикуются.

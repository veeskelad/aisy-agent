# Security/restart/rollback review: durable subagent resume

**Дата:** 2026-07-27  
**Область:** Core delegation persistence и Node filesystem adapter  
**Результат:** critical/high findings отсутствуют после исправлений; live cutover
не разрешён этим review.

## Проверенные границы

- resume выполняется до выдачи handle и до model/tool I/O;
- exact binding, lifecycle, task, scope, AgentCard и capability set;
- seq/prevHash/content hash shard’а и checkpoint head;
- run-level budget после параллельных child tasks и restart;
- atomic publication, permissions, torn snapshot, quarantine и rollback;
- path traversal и чрезмерный размер persisted input;
- отсутствие transcript/content в observability event.

## Найдено и исправлено

### F-1 — устаревшая копия общего бюджета в child snapshot

Первый вариант сохранял run budget в каждой делегации. Если A и B работали
параллельно, запись A могла остаться с бюджетом до завершения B; crash + resume A
восстанавливал бы меньший расход. Общий budget и terminal sets вынесены в
отдельный атомарный `run-state.json`. Child record и ledger проверяются совместно;
несогласованное состояние после межфайлового сбоя quarantined, а не исполняется.
Regression test восстанавливает A после затрат A+B и получает полную сумму.

### F-2 — неограниченный persisted input

Чтение повреждённого гигантского JSON/JSONL могло вызвать memory/disk DoS.
Node adapter теперь ограничивает JSON-файлы одним MiB, shard — 32 MiB и проверяет
размер до чтения/публикации. Ошибка записи откатывает in-memory append/status/
budget transition и не возвращает успешный результат.

### F-3 — path traversal через delegation id

Filesystem adapter принимает только один безопасный path segment
`[A-Za-z0-9._-]+`, отдельно запрещая `.` и `..`. Отказ происходит до чтения или
записи пути; это покрыто тестом `../outside`.

## Restart и rollback

- Spawn создаёт checkpoint до запуска child work; каждый append продвигает его.
- Manifest публикуется последним и содержит SHA-256 shard/checkpoint. Torn или
  смешанный snapshot не возобновляется.
- Quarantine создаёт отдельный marker, не удаляет и не переписывает исходный
  shard/checkpoint/manifest. Ручной post-mortem и восстановление возможны.
- Selection switch не меняет binding. Archive Project/Session закрывает resume
  через code-owned lifecycle resolver.
- Legacy/unbound state не получает global/Workspace fallback.

## Остаточные ограничения

- SHA-256 даёт tamper evidence для случайной порчи и несогласованной записи, но
  не является MAC против атакующего с теми же правами OS, способного переписать
  все файлы и hashes. Текущая граница доверия — локальный operator account и
  каталоги `0700`/файлы `0600`; signing key потребует отдельного ADR.
- Node store пока не подключён к live `aisy.ts`. Run-id allocation, startup scan,
  automated recovery UI, cancellation и Telegram status cards остаются закрыты
  до согласованного activation/cutover.

## Доказательства

- 39 core orchestration tests;
- 3 Node filesystem/restart tests;
- полный regression: build/typecheck зелёные; 1075 core + 101 Telegram +
  168 app = 1344 TypeScript tests; Python — 29 passed, 1 platform-specific skip;
  Ruff и `git diff --check` зелёные.

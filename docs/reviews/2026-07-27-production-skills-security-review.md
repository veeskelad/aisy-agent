# Security/restart/rollback review: production Skills runtime

**Дата:** 2026-07-27  
**Область:** active Skills catalog, Node persistence, Agent Loop prompt wiring,
main/goal/subagent composition  
**Результат:** critical/high findings после исправлений отсутствуют; review не
разрешает MCP activation, AgentCard CRUD или Workspace v2 cutover.

## Проверенные границы

- fixed-path чтение и защита от name/path traversal;
- hash, identity, version, verification section и trace-verified gate;
- duplicate/malformed/oversized manifest entries и Skill body;
- code-owned `touchedPaths` перед делегацией;
- menu-in-prefix/body-on-trigger и стабильность session snapshot;
- фильтрация Skills capability matrix субагента до model I/O;
- atomic quarantine, restart и recoverable rollback;
- отсутствие секретов и полного body в quarantine state.

## Найдено и исправлено

### F-1 — `touchedPaths` читались из сырого manifest после валидации

Первый вариант искал запись в исходном массиве manifest при каждом запросе и
к тому же обращался к переменной вне её lexical scope. Проверенные пути теперь
копируются в immutable startup catalog одновременно с body/menu. Метод выдаёт
копию только для полностью принятого активного Skill.

### F-2 — недостаточно строгий portable path contract

Проверка запрещала absolute path и сегмент `..`, но оставляла неоднозначные
пустые/`.` сегменты и Windows separator. Теперь запрещены пустая строка,
`/absolute`, `.`, `..`, `//`, обратная косая черта и NUL. Параметризованный
regression test подтверждает fail-closed поведение.

## Restart и rollback

- Catalog является startup snapshot: hot rewrite manifest не меняет права
  уже работающей session.
- При tamper создаётся `skills-quarantine.json`; после restart запись
  принудительно представляется archived.
- Quarantine не удаляет `SKILL.md` и manifest. Rollback recoverable: оператор
  может исследовать исходные байты и отдельно опубликовать проверенную revision.
- Повреждение основного manifest quarantines `__manifest__` и запускает Aisy без
  Skills, а не с частично разобранными правами.

## Остаточные ограничения

- SHA-256 защищает от порчи и несогласованной публикации, но не является MAC
  против процесса с теми же OS-правами. Текущая граница доверия — локальный
  account и permissions `0700`/`0600`.
- Автоматического unquarantine нет намеренно. Recovery/doctor UI и atomic
  promotion manifest+Skill требуют следующего инкремента.
- Main agent пока получает все активные Skills; отдельная main AgentCard matrix
  не подключена. Subagent matrix уже fail-closed.
- `traceVerified` сейчас является закреплённым результатом promotion pipeline;
  live повторное выполнение verification probes и telemetry результата ещё не
  подключены.
- MCP registry отсутствует, поэтому никакой MCP capability этим изменением не
  активирована.

## Доказательства инкремента

- core typecheck и build зелёные;
- 123 целевых core tests;
- app typecheck зелёный;
- 3 Node persistence/restart tests;
- полный regression: build/typecheck зелёные; 1111 core + 101 Telegram +
  171 app = 1383 TypeScript tests; Python — 29 passed, 1
  platform-specific skip; Ruff и `git diff --check` зелёные;
- Локальный приватный эталон подтверждён как ignored; tracked/staged файлов из
  него нет, имя и путь не публикуются.

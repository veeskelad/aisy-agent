# Security review: offline-миграция legacy memory

**Дата:** 2026-07-27  
**Область:** `legacy-memory-migration.ts`, protected-ledger candidate,
canonical fact files, restart/rollback boundary  
**Решение:** offline preparation допустима; live cutover запрещён до отдельного
согласования и реализации нового write WAL.

## Проверенный результат

Legacy `memory.db` можно подготовить к переходу без изменения authoritative
source. Модуль создаёт consistent serialized backup, физически отдельный ledger
candidate без derived FTS и canonical markdown только для live/non-forgotten
фактов. Единственная достижимая конечная фаза — `VERIFIED`.

## Границы и доказательства

| Риск | Code-owned граница | Доказательство |
|---|---|---|
| Silent field loss | Exact source schema; неизвестная колонка блокирует план | Тест schema drift |
| Resurrection при миграции | `published=1` только при `invalid_at IS NULL` и отсутствии fact key в `do_not_remember` | Tombstone и forgotten строки остаются `published=0`, без файла |
| Потеря provenance/relations | Ledger↔backup сравнение всех исходных колонок и `rowid` | Lossless fixture с authority/confidence/provenance/supersedes/contradicts/extends |
| Подмена forget-list | Полная legacy hash-chain проверяется до планирования и после записи candidate | Chain-tamper test |
| Derived truth становится authoritative | Candidate schema не содержит FTS; исходная FTS остаётся только в backup | Проверка `sqlite_master` |
| Source меняется во время подготовки | Serialized source SHA сверяется до первого artifact и перед `VERIFIED`, затем на каждом resume | Stale-source test |
| Partial crash | Durable phases `PREPARED → COPIED → VERIFIED`; повторный запуск создаёт только отсутствующие exact artifacts | Restart из частично созданных каталогов |
| Artifact/path substitution | Канонические absolute paths, обязательные private `0700/0600`, exclusive create, nlink/realpath checks, per-file SHA/size, ledger/file semantic verification | Unsafe-source-mode, file-tamper и mutated-plan-path tests |
| Неявная активация | В модуле нет install, rename-to-live, write-enable или cutover surface | API review |

## Остаточные блокеры

- Новый protected-ledger WAL записи
  `PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED` ещё не является
  live write path.
- Cutover должен повторно quiesce legacy writer, проверить source SHA, создать
  exact rollback point и потребовать отдельное operator approval.
- Receipt-bound all-project search, production Node factory и Telegram consent
  для embeddings ещё не завершены.
- Derived `verifyLive` должен быть связан с опубликованным новым ledger, а не с
  legacy adapter.

До закрытия этих пунктов legacy database остаётся единственным authoritative
memory store; `VERIFIED` candidate не читается и не изменяется live runtime.

## Regression evidence

- 10 targeted migration tests;
- 1226 core, 224 app и 102 Telegram gateway tests (1552 TypeScript total);
- 34 Python tests passed, 1 platform-specific skip;
- workspace typecheck/build, Ruff и `git diff --check` прошли;
- Локальный приватный эталон остаётся ignored, не содержит tracked paths и не
  называется в публичных материалах.

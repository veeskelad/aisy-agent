# Security review: scoped hybrid memory runtime

**Дата:** 2026-07-27  
**Статус:** принято с блокирующими условиями для live activation  
**Scope:** ADR-0065 core retrieval, sqlite-vec derived store, OpenRouter
embedding adapter, cache/revoke boundary

## Итог

Offline production seam соответствует принятому направлению: keyword остаётся
локальной обязательной leg, semantic хранится в отдельной derived БД на scope,
hybrid использует RRF `k=60`, а provider failure не расширяет scope. Новый код
не подключён к `aisy run`, не читает live key и не меняет canonical memory.

## Проверенные границы

| Граница | Доказательство |
|---|---|
| Cross-project isolation | Каждый store фиксирует exact `scope_json`; wrong-scope candidate/search блокируется до provider/store publication |
| Forget/tombstone | Injected `verifyLive` обязателен на upsert и каждом KNN result; нарушение отключает semantic scope и не маскируется hybrid fallback |
| Sensitive egress | Query/chunk проходят deterministic credential/path/entropy scan до `fetch`; sensitive input не создаёт cache/vector |
| Cache ordering | Document cache публикуется только после успешного `verifyLive + upsert`; filter rejection удаляет cache key |
| Revocation | In-memory gate и AbortController закрываются до persisted revoke; затем provider key обнуляется и cache/vector rows удаляются |
| Provider response | Fixed HTTPS origin, redirect error, bounded bytes, exact model/count/index/dimensions/finite-number validation, redacted typed errors |
| Restart | Scope, descriptor, schema, revoke state, cache и vector rows проверяются после повторного открытия реального sqlite-vec файла |
| Dependency | `sqlite-vec` закреплён точно на `0.1.9`; real extension tests исполняют insert/KNN/delete/restart, а не mock SQL |

## Исправления по review

1. vec0 rowid передаётся как SQLite INTEGER (`bigint` binding); KNN использует
   разрешённый extension контракт `ORDER BY distance`.
2. Одинаковый `scope/path/chunk` с другим content hash считается stale-index
   corruption, а не отдельным результатом.
3. Keyword failure не выдаётся за semantic degradation; integrity failures
   derived index проходят hard failure.
4. Document vector больше не попадает в cache до protected-ledger publication.
5. Wrong `projectId` блокируется до внешнего embedding request.
6. Body-stream/health callback errors OpenRouter нормализуются без раскрытия
   URL, key или upstream response body.

## Блокеры live activation

- `verifyLive` должен быть связан с новым protected ledger и полным
  `published=1 / invalid_at / do_not_remember / contentHash` verdict, а не с
  legacy `Memory` store;
- нужен global+exact-project router и отдельный receipt-bound all-project path;
- deterministic chunker/file WAL и lossless migration ещё не завершены;
- Telegram onboarding должен отдельно показать, что query и выбранные chunks
  покидают сервер, проверить model/revision/dimensions/health и получить consent;
- production factory должна создавать scope DB только в защищённом control root
  и отклонять symlink/path substitution;
- reconnect после revoke должен создавать новый provider instance и проходить
  явное operator approval до `enableAfterReconnect`;
- native package поддерживает ограниченный набор OS/architectures; doctor и CI
  должны проверять extension load на каждой поддерживаемой release platform.

До закрытия этих пунктов feature gate остаётся выключенным; migration cutover и
live activation не выполняются.

## Evidence

- 16 тестов hybrid/RRF/scope/degradation/scanner/cache-key/TOCTOU;
- 8 тестов реального sqlite-vec store, включая restart/revoke/filter/path failure;
- 4 теста OpenRouter adapter;
- 5 integration-тестов provider → cache → sqlite-vec → restart/revoke;
- полный regression: 1542 TypeScript tests (1216 core, 102 Telegram gateway,
  224 app), 34 Python tests passed и 1 platform-specific skip;
- workspace typecheck/build, Ruff и `git diff --check` проходят.

Официальные контракты зависимости: [sqlite-vec для Node.js](https://alexgarcia.xyz/sqlite-vec/js.html),
[KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html),
[OpenRouter Embeddings API](https://openrouter.ai/docs/api/reference/embeddings).

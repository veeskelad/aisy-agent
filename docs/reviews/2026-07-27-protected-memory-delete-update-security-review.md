# Security-review DELETE/FORGET/UPDATE защищённой памяти

Дата: 2026-07-27  
Статус: mutation contract и Node preview router приняты; live activation и
migration cutover запрещены до оставшихся runtime-gates и явного согласования
оператора.

## Проверенный результат

Проверены `protected-memory-deletion.ts`, `protected-memory-update.ts`,
SQLite ledger/WAL/outbox, физически отдельный FTS5, sqlite-vec/cache, immutable
canonical fact files и lease-bound `protected-scoped-memory.ts`. Композиция
доступна только как Node preview и не заменяет legacy `Memory.commit()`.

## Найдено и исправлено

1. Human-confirmed forget не мог повысить уже существующий автоматический
   tombstone до permanent forget. Теперь исходный `invalid_at` сохраняется, в
   hash-chained `do_not_remember` добавляется подтверждённая запись, а отдельный
   audit `ts` фиксирует момент человеческого подтверждения.
2. Completed retry первоначально мог принять успешный audit, не обнаружив
   повторное появление удалённого файла или vector/cache. DELETE/FORGET и UPDATE
   теперь повторно проверяют все ledger, FTS, file и derived postconditions.
3. Outbox с `delivered=0` и уже удалённым recovery WAL не имел исполнимого пути
   завершения. Reopen и `integrityCheck` теперь считают такое состояние
   повреждением ledger и fail closed.
4. UPDATE нельзя выполнять как две независимые операции «ADD нового, DELETE
   старого»: crash между ними оставлял бы неоднозначную live-истину. Новый WAL
   сначала создаёт unpublished replacement и устанавливает его файл, затем в
   одной ledger transaction переводит old→tombstone и new→live; readers
   блокируются до завершения FTS/derived/file/audit фаз.
5. Audit delivery не заявляется как физически exactly-once. Crash после внешнего
   эффекта и до локальной отметки закономерно вызывает повторную попытку;
   стабильный `event_id` и обязательный idempotent receiver обеспечивают
   effective-once результат без конфликтующего события.
6. Первый scoped adapter деградировал почти любую ошибку Project к global и тем
   самым мог скрыть recovery conflict, scope mismatch или неподтверждённый
   canonical file. Теперь деградация ограничена отсутствующим Project runtime и
   производным keyword index; protected ledger, scope, file и все recovery
   ошибки fail closed.
7. Human-confirmed delete/forget больше не доверяет одному model-facing boolean:
   mutation service вызывается только после отдельного code-owned authorization
   callback, связанного с lease, fact id, reason и exact scope.
8. Callback больше не получает только логический `factId`: scoped router до
   карточки загружает immutable target и проверяет owner/scope, operation/key,
   canonical path/content hash и installed/absent file state. Карточка Tier-3
   hash-pin включает все эти поля и reason hash.
9. Gateway теперь возвращает code-minted proof точной card/action/hash проверки
   и step-up. Memory authority не принимает совместимый generic `confirmed` без
   proof, stale/future proof или несовпадающие поля.
10. Одноразовый HMAC-receipt сохраняет consumed tombstone до TTL в private
    atomic JSON store. После restart повторное consume/reissue невозможно;
    symlink/hardlink/public mode, schema tamper и durable I/O failure fail closed.
11. Разрешение не возвращается до доставки отдельного audit
    `memory.permanence.authorized`, который связывает card tap, lease/scope и
    точные operation/key/path/content identity факта.

## Инварианты

| Риск | Детерминированная граница | Доказательство |
|---|---|---|
| Воскрешение permanent forget | Append-only hash-chain + protected count/head anchor + проверка перед read/write | Promotion и chain/reopen tests |
| Старый факт остаётся в FTS/vector/file | Фазовый purge и terminal/completed postcondition probes | Delete и update restart matrices |
| Новая версия видна до readable file | `published=false` до verified install; scope WAL блокирует readers | Update phase tests |
| Crash между old/new | Atomic ledger swap, затем idempotent FTS switch под WAL | 14 update durable boundaries |
| Потерянный или конфликтующий audit | Hashed outbox, exact event schema, stable idempotency key, WAL удаляется последним | Delivery-before/after-mark tests |
| Чужой Project/owner | Lease проверяется до storage resolution; SQLite закреплён за exact owner/profile/scope | Foreign-scope и reopen identity tests |
| Durable state подменён | Exact schema, JSON hash, phase/effect recovery-shape и orphan-outbox checks | Strict parser и corruption tests |
| Replay/TOCTOU permanent approval | Gateway nonce + exact action hash + step-up; target-bound HMAC receipt и consumed tombstone | Authority, nonce-store и restart E2E |
| Подмена target между карточкой и mutation | Immutable ledger identity + canonical file verification; deletion service повторно загружает и сверяет target | Scoped-router exact-binding tests |

## Доказательства

- 9 core DELETE/FORGET tests: strict schemas, permanent/non-permanent semantics,
  tombstone→forget promotion, 13 logical crash boundaries, reader gate и scope deny;
- 4 Node DELETE/FORGET tests: 9 реальных DB/file/vector/audit boundaries,
  completed state, promotion и orphan-outbox fail-closed;
- 2 strict UPDATE schema tests;
- 4 Node UPDATE tests: 14 реальных durable boundaries, idempotent completed
  retry, deliberate resurrection detection, second-update semantics, reader
  gate, scope deny и orphan-outbox fail-closed;
- 4 unified recovery-gate tests: все три WAL family, exact single-family
  dispatch, multi-family conflict, final integrity и foreign scope;
- 16 protected scoped-router tests: global/exact-project isolation,
  deterministic merge, controlled degradation, canonical-file check,
  recovery/ledger fail-closed, mutation mapping, exact-target/tombstone checks и
  authorization deny;
- 8 core permanence-authority tests: Tier-3/step-up, exact action hash, stale,
  mismatch, generic-proof deny, consume и audit fail-closed;
- 7 app nonce-store tests: atomic issue/consume, consumed tombstone, restart,
  replay, corruption, permissions и symlink deny;
- 2 app Node-authority tests и 1 полный Gateway→protected Project forget→restart
  E2E с отсутствием recall и проверкой SQLite/file integrity;
- 4 app preview tests, включая настоящий global+project ADD→FTS search через
  раздельные Node ledger/file/barrier runtimes и доказательство `off → null`;
- 1 сквозной app restart/isolation test: durable Project provisioning,
  `remember/search_memory`, восстановление exact project/session/generation,
  receipt-bound switch в Workspace и отрицательный recall project-факта;
- regression существующих publication, migration, file, FTS и semantic tests.

Текущий regression: 1324 core, 247 app и 102 Telegram tests; полный workspace
typecheck/build был зелёным после permanence-инкремента, а последующий app
typecheck/build — после attachment-aware turn wiring. Предыдущий Python
regression: 34 tests и 1 platform skip; Python-код этим инкрементом не изменялся.

## Оставшиеся release-blockers

- model-facing/live binding preview router в `aisy run` (до согласования должен
  оставаться выключенным);
- approved owner binding/install verified migration candidate;
- live E2E, restart и rollback rehearsal. Live activation и необратимый cutover
  выполняются только после явного согласования оператора.

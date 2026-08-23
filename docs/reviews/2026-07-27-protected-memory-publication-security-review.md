# Security review: protected memory publication WAL

**Дата:** 2026-07-27  
**Область:** `protected-memory-publication.ts`, WP-27 core protocol  
**Решение:** core state machine допустима для offline adapter work; live memory
commit и migration cutover запрещены.

## Проверенный результат

Новый fact publication protocol устраняет независимую публикацию ledger,
canonical file, keyword projection или audit. Durable WAL остаётся reader gate
до полного `AUDITED` и подтверждённого удаления; recovery идемпотентно
повторяет эффекты.

## Границы и доказательства

| Риск | Code-owned граница | Доказательство |
|---|---|---|
| Модель выбирает fact identity/path | `prepareFact` проходит strict metadata check, `factKey=H(keyTokens)`; path вычисляется из fact id | Invalid metadata и exact path tests |
| Запись в чужой Project | Exact project lease check до storage/barrier | Foreign-project negative test |
| Два writer публикуют scope | Обязательный `withScopeExclusive` port охватывает полный WAL/recovery цикл | Dependency contract и scope trace |
| Ledger видим без файла | Pending row имеет `published=false`; file hash проверяется до publication | Collision/hash crash tests |
| FTS видим без ledger truth | Publication port обязан идемпотентно связать ledger+keyword; reader дополнительно требует отсутствие WAL | 11 crash boundaries и visibility gate |
| Audit потерян/дублирован | Outbox создаётся с pending row; delivery idempotent; WAL удаляется только после audit verification | Audit-before/after crash tests, delivery count=1 |
| Restart в промежуточной фазе | Strict WAL snapshot содержит полный fact identity; recovery сортирует и повторяет exact effects | Crash matrix PREPARED…AUDITED |
| Stale/tampered durable state | Exact-schema parser, owner/scope/content/path verification; malformed WAL/file tamper fail closed | Malformed WAL и tamper tests |
| Reader начинает до recovery | `assertScopeRecovered` под тем же exclusive barrier отклоняет любой open WAL | Каждый crash point проверяет read gate |

## Остаточные блокеры

- Нужны реальные Node adapters: private WAL files, protected SQLite ledger,
  physically separate FTS database, confined canonical file install и audit
  outbox delivery с fsync/restart evidence.
- Нужны отдельные update/delete/forget transitions, сохраняющие tombstone и
  hash-chain invariants без раннего физического удаления.
- Derived vector `verifyLive` должен читать published ledger verdict после
  завершённого scope recovery.
- Legacy `Memory.commit()` остаётся authoritative; переключение возможно
  только внутри отдельно согласованного feature-gated cutover.

До этого state machine не экспортируется в model tools и не обслуживает live
Telegram turns.

## Regression evidence

- 19 targeted core tests, включая 11 crash boundaries;
- общий regression: 1256 core, 229 app, 102 Telegram gateway tests;
- 34 Python tests passed, 1 platform-specific skip.

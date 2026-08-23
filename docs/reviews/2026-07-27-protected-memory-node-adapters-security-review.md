# Security-review Node-адаптеров защищённой памяти

Дата: 2026-07-27  
Статус: offline-инкремент принят; live activation запрещена до mutation WAL и
явного согласования оператора.

## Проверенный результат

Проверены SQLite ledger/WAL/outbox, физически отдельный FTS5 index, immutable
canonical fact files и межпроцессный scope barrier. Композиция не подключена к
`aisy run`, не получает пользовательские ключи и не изменяет legacy memory.

## Найдено и исправлено

1. Первоначальный CAS пересчитывал hash из повторно сериализованного WAL.
   Исправлено на сравнение с exact сохранённым `wal_hash`.
2. Outbox мог использоваться для восстановления owner без предварительной
   проверки его hash. Теперь outbox валидируется до rehydration и при каждом
   открытии store.
3. Обычная hash-chain не обнаруживает удаление последней forget-row. В
   защищённый control добавлены `forget_count` и `forget_head_hash`; их
   несоответствие блокирует open/read/write.
4. Физические ledger и FTS первоначально не были закреплены за owner/profile.
   Control schema и все mutation boundaries теперь требуют exact
   owner/profile/scope. Offline migration candidate намеренно хранит NULL owner
   и остаётся непригодным для live open до approved binding/cutover. Identity
   probe выполняется до создания FTS, поэтому ошибочная попытка open не оставляет
   derived side effect.
5. Directory-lock с time-based takeover был отвергнут: после падения нельзя
   доказать, что процесс действительно умер. Barrier реализован отдельной
   SQLite transaction; OS освобождает lock и откатывает owner row при смерти
   процесса.
6. Прямая запись в final staging-файл не доказывала recovery при смерти процесса
   посреди write. Staging переведён на `random temp → fsync → hard-link final →
   unlink temp`; следующий запуск очищает безопасные orphan temp и завершает
   оборванную link/unlink границу по inode и link count.

## Доказательства

- 19 unit tests core publication protocol;
- 6 tests file-store: private immutable install, hard-link restart, partial-temp
  recovery, collision, symlink и staged tamper;
- 4 tests scope-barrier: release/rollback, identity binding, конкуренция другого
  процесса, recovery после `SIGKILL` и path-swap deny перед каждым acquire;
- 9 Node integration tests: 12 durable fault points с закрытием и повторным
  открытием реальных SQLite-файлов, recovery gate, ledger/FTS separation,
  owner rebinding/unbound-candidate deny, keyword/outbox tamper, forget guard и
  chain-tail truncation;
- 10 lossless migration tests после расширения protected schema.

## Оставшиеся release-blockers

- отдельный crash-safe WAL для update/delete/forget;
- tombstone + append-only forget row + purge всех derived indexes + удаление
  canonical live file + audit как один recoverable mutation contract;
- approved owner binding/install для verified migration candidate;
- feature-gated runtime composition и полный live E2E/rollback только после
  явного согласования оператора.

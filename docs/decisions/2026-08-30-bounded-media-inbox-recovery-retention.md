# ADR-0113: Ограниченное хранение recovery-архивов media inbox

**Статус:** Принято
**Дата:** 2026-08-30
**Теги:** telegram, voice, durability, recovery, retention

## Контекст

Singleton writer media inbox переносит lock умершего процесса в приватный
recovery-архив. Это не пользовательская память и не содержимое вложения, а
временное доказательство для exact restore, если следующий запуск не сможет
открыть новый writer. Архивы сохранялись без удаления, тогда как read-only
Doctor намеренно считал набор больше 64 повреждённым. После достаточного числа
штатных restart накопление само отключало вложения и voice: новый lock был
здоров, но проверить весь безграничный архив уже было нельзя.

Нельзя исправлять это возрастом lock, PID takeover, безусловным recursive
delete или мутацией из Doctor. Cleanup должен переживать crash, не касаться
активного lock и отказываться при неизвестной структуре либо подмене пути.

## Решение

1. Recovery-архив считается завершённым временным rollback-evidence. После
   успешного захвата новым singleton writer код сохраняет восемь самых новых
   валидных архивов и удаляет более старые. Порядок определяется проверенным
   `acquiredAt`, затем каноническим именем каталога; `mtime`, PID и возраст
   текущего lock не дают полномочий на cleanup.
2. Retention запускается либо под живым process-lifetime writer без активного
   ingest, либо перед recovery под exact lock прежнего writer, для которого
   startup-barrier доказал смерть процесса и удерживает quiescence lease.
   Maintenance/recovery port выдаёт startup-коду закрытую identity-печать
   своего inbox root, lock и `owner.json`; она не является полномочием модели.
   Сам cleanup
   выполняет существующий one-shot Python boundary без shell, унаследованных
   credentials и сетевого доступа. Он открывает root, lock, archive и GC через
   `O_NOFOLLOW` и удерживает directory descriptors до завершения операции.
   Сам worker удерживает advisory lease на постоянном private regular-file
   внутри inbox. SIGKILL родительского Node не освобождает authority orphan
   worker: немедленный restart ждёт тот же lease, затем заново сверяет exact
   writer и inventory. Lease-файл не удаляется, чтобы unlink не создавал два
   независимых lock inode.
   Перед первой мутацией boundary полностью проверяет каждый archive,
   `owner.json`, device/inode identities, отсутствие symlink/лишних entries и
   непересечение canonical имён archive/GC. Startup принимает не более 256
   archive + pending GC. Если найден dead writer, cleanup всегда выполняется
   до его архивирования: при потолке он оставляет восемь entries, затем archive
   dead writer создаёт девятый. Crash до, во время или после cleanup оставляет
   тот же exact lock и не более 256 entries, поэтому следующий startup повторяет
   операцию идемпотентно и никогда не должен создавать 257-й entry.
   `rename`, `unlink` и `rmdir` выполняются только
   descriptor-relative; непосредственно перед каждым из них повторно сверяются
   exact writer, исходный inbox path, прикреплённость открытого parent directory
   и exact child identity. Кроме создания/открытия code-owned постоянного
   lease-file неизвестное, подменённое или большее состояние, обнаруженное
   preflight, оставляет archive и GC без мутаций и завершается fail-closed.
3. Удаляемый archive сначала атомарно переносится в приватный
   `.writer-lock-gc`, после чего fsync фиксирует обе директории. Только затем
   удаляются exact `owner.json` и пустой каталог. Следующий запуск распознаёт
   только эту закрытую структуру и завершает оборванный GC. Текущий
   `.writer.lock`, `records`, `objects`, `intents`, transcript и память не
   меняются.
4. `aisy doctor` остаётся read-only. Он не запускает retention и не удаляет
   recovery-evidence. Валидный over-retained набор до repair ceiling даёт
   предупреждение до следующего startup; после успешного cleanup Doctor видит
   bounded structurally-valid набор. Любое известное состояние с валидным
   набором до 256 включительно repairable: absent получает нового writer,
   abandoned сначала теряет пустой lock, held проходит pre-archive cleanup.
   Corrupt archive, GC residue неизвестной формы или набор больше 256 остаются
   high-severity fail.
5. Runtime пишет только redacted receipt с количеством retained/removed.
   Raw owner, nonce, PID, абсолютные пути и содержимое вложений не выходят в
   Telegram или журнал. Exact restore доступен только для retained archives.
   Если startup отказался, он различает code-only категории: занятый другим
   процессом inbox и повреждённое/переполненное recovery-state, которое нужно
   проверить через `aisy doctor`; неизвестная причина не называется живым
   writer.
6. Граница не объявляет POSIX name-based `renameat`/`unlinkat` атомарным
   compare-and-swap по inode: такого примитива для directory entries нет.
   Враждебный процесс с тем же Unix UID, меняющий приватный inbox между последней
   сверкой и syscall, находится вне threat model — он уже может переписать весь
   state и исполняемый код Aisy. От него требуется отдельная OS/user isolation.
   Если path drift всё же наблюдается на следующем checkpoint, cleanup
   останавливается, ничего рекурсивно не удаляет и оставляет закрытый GC-residue
   для следующего запуска/Doctor, а не заявляет ложный успех.

## Последствия

- **Положительное:** повторные restart больше не превращают здоровый inbox в
  постоянный отказ после достижения счётчика.
- **Положительное:** существующее переполненное, но валидное состояние
  ремонтируется code-owned способом без SSH-удаления и без потери вложений.
- **Положительное:** crash в любой точке cleanup сходится на следующем startup.
- **Нейтральное:** оператор может восстановить только восемь последних
  recovery locks; более старые остаются представлены redacted runtime-журналом.
- **Отрицательное:** неизвестное, подменённое или чрезмерно большое состояние
  по-прежнему требует отдельного операторского решения.
- **Отрицательное:** защита от произвольного конкурентного same-UID процесса не
  решается retention-протоколом и требует изоляции Unix-пользователя.

## Рассмотренные альтернативы

**Не ограничивать архив.** Отклонено: inspection становится небounded, а
существующий защитный лимит вновь выключит media после достаточного числа
restart.

**Удалять старые каталоги из Doctor или по `mtime`.** Отклонено: read-only
диагностика получила бы скрытую destructive authority, а wall clock не
доказывает ни завершённость recovery, ни отсутствие writer.

**Удалять весь архив при каждом startup.** Отклонено: исчезает последнее exact
rollback-evidence и невозможно восстановить owner после сбоя нового запуска.

## Ссылки

- [ADR-0089 — Долговечное восстановление внешних ресурсов sidecar](./2026-08-01-durable-external-sidecar-resource-recovery.md)
- [ADR-0098 — Root-owned proxy облачной транскрипции](./2026-08-13-systemd-encrypted-voice-credential-proxy.md)
- [Компонент 02 — Gateway Connectivity](../specs/02-gateway-connectivity.md)
- [Компонент 13 — Onboarding and Operations](../specs/13-onboarding-and-operations.md)

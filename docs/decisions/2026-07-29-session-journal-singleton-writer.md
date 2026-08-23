# ADR-0068: Единственный process-lifetime writer журнала сессий

**Статус:** Принято
**Дата:** 2026-07-29
**Теги:** transcript, durability, safety

## Контекст

Core сериализует append только внутри одного процесса. Node-персистентность
хранит общий `transcript-v2.jsonl`, session manifest и WAL, поэтому два процесса
с одним `AISY_HOME` могут прочитать одинаковый head и начать несовместимые
commit. Проверки conflict/quarantine обнаруживают часть гонок, но обнаружение не
заменяет запрет второго writer.

Service manager обычно поднимает один экземпляр unit/LaunchAgent, однако ручной
`aisy run`, второй supervisor или ошибочная конфигурация обходят эту гарантию.
До включения live journal нужен доказуемый межпроцессный барьер, иначе transcript
перестаёт быть достоверным источником evidence.

Первая реализация использовала каталог `.transcript-writer.lock/` с
`owner.json`. После `SIGKILL` такой каталог остаётся на диске: возраст записи,
PID, boot id и process-start identity могут помочь диагностике, но не являются
kernel-proof завершения writer. Автоматический takeover по этим данным
небезопасен, а обязательное ручное удаление residue мешает автоматическому
возврату production runtime.

При этом просто убрать старый путь нельзя. Старый binary считает успешный
`mkdir(.transcript-writer.lock)` достаточным правом писать журнал; значит, новый
контур обязан навсегда не дать такому binary получить параллельное владение.

## Решение

Журнал сессий пишет **ровно один процесс**, который весь свой lifetime
удерживает kernel-released SQLite lease на локальной файловой системе.

1. Steady-state lease — отдельная приватная SQLite DB
   `${journalRoot}/.transcript-writer-lease/transcript-writer-lease.sqlite3`.
   Каталог `.transcript-writer-lease/` имеет mode `0700`, DB — `0600`.
   Writer открывает `BEGIN IMMEDIATE` с нулевым ожиданием и удерживает
   транзакцию до release либо OS exit. Второй writer получает стабильный
   fail-closed отказ до transcript, provider, tool и Telegram I/O. После
   `SIGKILL` транзакцию освобождает ядро, поэтому новый process может получить
   lease без PID, `mtime`, stale unlink или time-based takeover.
2. Lease DB содержит ровно одну exact-schema запись identity: role
   `transcript-writer` и случайный `database_id` из 64 lowercase hex. Immutable
   private anchor
   `${journalRoot}/.transcript-writer-lease/transcript-writer-lease.sqlite3.identity.json`
   имеет mode `0600` и exact shape
   `{version:1,role:'transcript-writer',databaseId,dev,ino}`. Он обязан совпасть
   с DB metadata и фактическими device/inode. Неизвестное поле, иная роль,
   identity drift, symlink, hardlink вне разрешённого bootstrap window или
   небезопасные права закрывают запуск без mutation.
3. Lease directory имеет mode `0700`, DB, anchor и compatibility barrier —
   `0600`. DB работает в rollback-journal mode с `locking_mode=NORMAL`,
   `synchronous=FULL`, `trusted_schema=OFF` и `busy_timeout=0`. WAL/SHM,
   небезопасный companion и невалидный rollback journal дают fail-closed отказ;
   recovery допустим только после exact identity/schema validation.
4. Bootstrap crash-safe: private `O_EXCL` temp полностью инициализируется,
   fsync-ится и публикуется через atomic hardlink с directory fsync. Exact
   `nlink=2` crash-state можно завершить только после полного совпадения
   identity. Valid DB без anchor восстанавливает anchor лишь в доказанном
   bootstrap crash window. Anchor при missing/empty/mismatch/corrupt DB не
   разрешает reinitialize или repair.
5. Путь `${journalRoot}/.transcript-writer.lock` становится постоянным
   **compatibility barrier**: после согласованного cutover новый binary
   публикует там private regular file mode `0600` с exact JSON
   `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}`. Поля
   identity обязаны совпасть с lease DB и anchor. Старый directory-lock client
   всегда получает `EEXIST` и не может стать writer. Barrier не удаляется при
   штатном release, crash, rollback текущего binary или upgrade. Acquisition
   автоматически завершает только exact crash boundary публикации: barrier
   имеет `nlink=2` и существует ровно один same-inode private temp
   `..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`. Тогда temp удаляется
   и journal root fsync-ится. Любой иной hardlink/residue остаётся fail-closed;
   doctor ничего не исправляет и классифицирует состояние как corrupt.
6. Существующий legacy directory `.transcript-writer.lock/` вместе с его
   `owner.json` не преобразуется и не удаляется автоматически: он даёт
   fail-closed `legacy-residue` до открытия lease DB и внешнего I/O. Regular
   barrier с неизвестными/неexact bytes даёт `lease-corrupt`, а symlink,
   special node, небезопасные права или неразрешённый hardlink — `lease-unsafe`.
   Публичные классы отказа ограничены стабильным набором
   `held-by-another-process`,
   `legacy-residue`, `lease-unsafe`, `lease-corrupt`, `lease-unavailable` и
   `lease-lost`; приватные filesystem/SQLite детали наружу не выходят.
7. Переход от legacy directory lock выполняется только как отдельный ручной
   cutover после доказанной quiescence: service остановлен, ни один legacy/new
   writer не работает, exact residue проверен и сохранён для диагностики.
   Runtime и `aisy doctor` не выводят это доказательство из PID, возраста или
   содержимого `owner.json`.
8. Acquisition происходит до чтения transcript manifest, WAL и общего JSONL.
   При включённом journal любой отказ lease останавливает **весь full runtime**,
   а не деградирует его до режима без recorder. До отказа запрещены provider,
   tool и Telegram I/O. Setup-only Telegram, который не запускает full runtime
   и не пишет transcript, остаётся вне этого gate.
9. Production transcript store принимает только живой lease и повторно
   проверяет DB/anchor/transaction ownership перед `start`, `history`, `record`
   и recovery I/O. Потеря lease закрывает дальнейшую работу code-only ошибкой.
10. `aisy doctor` выполняет только read-only inspection. Он не получает lease,
    не завершает bootstrap, не удаляет legacy residue, не пересоздаёт anchor и
    не снимает quarantine даже с `--fix`.
11. Единственный текущий rollback-путь — exact
    `AISY_SESSION_JOURNAL=0` в том же binary. Он не открывает и не изменяет
    transcript lease/DB/barrier и запускает прежнюю composition без recorder.
    Значения кроме exact `0` не ослабляют gate. Это не разрешение запускать
    старый binary: permanent compatibility barrier остаётся на месте.
12. Lease поддерживается только на локальной filesystem. NFS, SMB и иные
    сетевые/multi-host FS запрещены. До LIVE обязателен process-level self-test
    на фактическом journal filesystem: A удерживает lease, B получает busy, A
    завершается через `SIGKILL`, B автоматически захватывает тот же DB inode.

## Проверки перед активацией

- два реальных OS-процесса получают ровно одного writer и выполняют внешний
  sentinel только после lease;
- после `SIGKILL` holder следующий process автоматически захватывает lease без
  overlap и без изменения DB/anchor/barrier;
- clean release допускает fresh process на том же exact DB inode;
- legacy directory/residue, corrupt DB, unsafe path/permissions, companion,
  anchor mismatch и inode replacement дают zero transcript/provider/tool/
  Telegram I/O и не изменяют evidence;
- bootstrap fault matrix проверяет каждый шаг temp → initialized DB → hardlink
  → anchor → permanent barrier → fsync, включая единственный автоматически
  завершаемый barrier-state `nlink=2` + один exact same-inode compat temp;
- exact regular compatibility barrier переживает release/restart, а legacy
  `mkdir` client стабильно получает `EEXIST`;
- `AISY_SESSION_JOURNAL=1` при любом lease failure завершает полный runtime до
  внешнего sentinel; exact `AISY_SESSION_JOURNAL=0` сохраняет current-binary
  rollback и ничего не чинит;
- `aisy doctor` остаётся byte-for-byte read-only для clean, busy, legacy,
  corrupt и bootstrap residue;
- self-test проходит отдельно на целевых Linux и macOS local filesystems и
  отказывает для неподдерживаемой topology.

**Evidence реализации:** transcript-тесты на реальных процессах — 12/12;
объединённая process-матрица — 31/31; полный App gate — 132 файла тестов
успешно / 1 пропущен, 1031 тест пройден / 1 пропущен; typecheck App и
upstream-сборка зелёные. Это доказывает текущий срез кода и процессов, но не
LIVE-активацию, ручной legacy cutover или self-test на фактической целевой
filesystem.

## Последствия

- **Положительные:** single-writer authority освобождается ядром после hard
  crash; restart не зависит от PID/времени; permanent barrier не даёт старому
  binary обойти новый протокол; при включённом журнале невозможна тихая
  деградация до неполного evidence.
- **Нейтральные:** появляются отдельная SQLite DB, immutable anchor и постоянный
  compatibility file; для каждой целевой filesystem нужен self-test; doctor
  остаётся только инспектором.
- **Отрицательные:** legacy directory требует отдельного ручного
  proven-quiescence cutover; corrupt/unsafe/identity-drift state останавливает
  весь enabled runtime; старый binary больше нельзя использовать как rollback.

## Рассмотренные альтернативы

**Оставить directory lock и автоматизировать stale recovery.** PID, boot id,
process-start identity, `mtime` и timeout не доказывают смерть writer. Ошибочный
takeover допускает два процесса — отклонено.

**Удалять `.transcript-writer.lock` после перехода.** Это снова позволяет
старому binary создать directory и писать параллельно SQLite writer —
отклонено. Путь навсегда занят exact regular barrier.

**Полагаться только на supervisor.** Не закрывает direct `aisy run`, второй
supervisor и ошибочную service-конфигурацию — отклонено.

**Lock на каждую session.** Не защищает общий `transcript-v2.jsonl` и global
event-id lookup — отклонено для текущего layout.

**Doctor как автоматический recovery writer.** Read-only диагностика не должна
сама менять authority или угадывать quiescence. Recovery остаётся отдельной
явной операцией — отклонено.

## Ссылки

- Предложение: [Варианты singleton writer для transcript v2](../reviews/2026-07-27-transcript-singleton-writer-options.md)
- Спецификация: [23-full-fidelity-session-transcript.md](../specs/23-full-fidelity-session-transcript.md)
- Связано: [ADR-0064](./2026-07-26-full-fidelity-session-transcript.md), [ADR-0071](./2026-07-29-execution-recovery-parent-supervisor.md)

# Компонент 23: Полный журнал сессии v2

**Статус:** LIVE в current-binary composition: Node WAL/restart,
authoritative session-start, singleton writer, compaction, reply checkpoint и
durable media inbox подключены. Target-FS writer self-test и long-session
Telegram E2E остаются отдельными acceptance gates; day-log/maintenance и
`SessionActivityJournal` остаются dormant, legacy migration не выполняется без
реальных v1-данных
**Связанные ADR:** ADR-0064, ADR-0068, ADR-0040, ADR-0060, ADR-0063
**Зависит от:** Agent Loop (01), Context Engine (15), Projects/Sessions (17)

## 1. Назначение

Журнал v2 хранит точную нормализованную последовательность span, из которой
Aisy может восстановить контекст новой сессии после restart. Он отделён от
старого audit/event log: audit остаётся content-redacted, а приватный transcript
содержит пользовательский текст, ответы модели, code-owned system spans и
результаты инструментов.

Полнота относится к span, который Aisy фактически использует в своём
нормализованном контексте. Неограниченный сырой stdout инструмента не становится
контекстом: сначала действует существующий лимит и нормализация Agent Loop, затем
получившийся tool span сохраняется без дальнейшего изменения.

## 2. Владелец и manifest

Каждая сессия привязана ровно к одному сочетанию:

```ts
interface TranscriptBinding {
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
}
```

`manifest.json` schema v1 хранит binding, следующий `sessionSeq`, текущую голову
hash chain, замороженный prefix, capability resume, время создания и обновления.
Допустимы только два режима:

- `exact-v2` — содержит проверяемый frozen prefix и может принимать строки;
- `metadata-only` — содержит только SHA-256 legacy log и никогда не изображает
  старый диалог, которого нет на диске.

Prefix bytes кодируются base64, но SHA-256 вычисляет core, а не caller.
Breakpoints строго возрастают, лежат внутри prefix и ограничены четырьмя.
Неизвестные поля, чужой binding и несовпадающий prefix hash закрывают сессию.

## 3. Строка и hash chain

Каждая строка содержит `eventId`, полный binding, `sessionSeq`, роль,
provenance, content, timestamp, code-owned `loadBearing` с версией
классификатора, предыдущий hash и собственный hash.

SHA-256 вычисляется по domain-separated canonical array всех полей, кроме самого
`rowHash`. Caller не может передать `loadBearing`, classifier version, sequence
или hash. Перед append и exact resume core проверяет весь manifest и всю цепочку;
idempotent duplicate не обходит эту проверку.

Append сериализуется внутри session и идемпотентен по глобальному `eventId`.
Повтор с тем же event id, но другим content/binding/timestamp, считается
конфликтом и переводит сессию в quarantine.

## 4. Per-turn recorder

`TranscriptRecorder` — необязательный seam Agent Loop. Если он не установлен,
legacy composition работает как раньше. Если установлен, turn обязан получить
от transport два стабильных значения:

- `turnId` — уникальный идентификатор входного события;
- `turnTs` — исходный timestamp, повторно используемый при retry.

Отсутствие любого значения блокирует turn до provider и tool I/O. Номер события
внутри turn начинается с 1. Durable `eventId` равен SHA-256 от
`[domain, sessionId, turnId, ordinal]`; приватный content в id не входит.

Для интерактивного Telegram turn transport вычисляет `turnId` из домена,
разрешённого chat id и упорядоченного списка `update_id` точного coalesced batch;
текст сообщений в идентификатор не входит. `turnTs` равен самому раннему
Telegram `message.date` в batch. Та же transport metadata сохраняется для
steering-сообщений и передаётся следующему turn после drain. Пустая или
невалидная metadata, включая повтор `update_id` внутри batch, отклоняется до
runner. Изменение состава или порядка batch намеренно создаёт другой `turnId`.

Перед первой строкой Agent Loop собирает обычный memory prefix, применяет
prefix extension и передаёт точные bytes/breakpoints/timestamp в `start()`.
Для новой session recorder создаёт manifest из этого snapshot. Для существующей
exact-v2 session manifest является authority: `start()` возвращает сохранённый
snapshot, и Agent Loop заменяет текущий memory candidate перед model I/O. Поэтому
изменившиеся после restart DNA, memory или Skills-menu не меняют историю уже
открытой session и не ломают exact resume.

Session-start идемпотентен. Ошибка создания/чтения manifest прекращает turn до
записи входа и provider/tool I/O. Metadata-only manifest нельзя открыть как
exact-v2.

Перед каждым новым turn recorder читает уже durable rows через `read()`, поэтому
manifest, sequence и вся hash chain проверяются до model I/O. Затем Context
Engine строит read-time view:

- under budget все строки остаются verbatim с исходными role/provenance/order;
- при compaction summary получает непривилегированную role `user` и самый
  строгий provenance покрываемых строк; untrusted text не повышается до system;
- load-bearing строки сохраняются verbatim;
- pinned prefix учитывается в token budget, но не дублируется в history spans,
  потому что provider получает его отдельными bytes;
- projected history добавляется перед spans текущего turn и никогда не
  записывается повторно.

Ошибка чтения, metadata-only режим или невалидный UTF-8 frozen prefix закрывают
resume до provider. Изменение compaction view не меняет durable transcript.

Recorder сохраняет события в фактическом порядке:

1. все входные spans, включая lazy Skill body;
2. code-owned action-contract system span, если он нужен;
3. каждый ответ provider, включая пустой preamble;
4. tool span после успешного выполнения и PostToolUse, причём используется имя
   реально разрешённого или модифицированного вызова;
5. recovery instruction и deterministic failure reply, если action contract не
   подтверждён.

Ответы модели и результаты инструментов имеют `provenance: untrusted`.
Code-owned system/failure spans имеют `provenance: operator`. Tool span,
переданный следующему synthesis round, является тем же объектом содержания,
который ушёл в transcript.

Сбой записи входа прекращает turn до provider. Сбой записи ответа provider
прекращает turn до последующего tool dispatch. Сбой после уже выполненного
инструмента не может отменить внешний эффект, поэтому ошибка выходит наружу и
не маскируется успешным ответом.

Каждый вызов `start()`, `history()` и `record()` можно обернуть в
`makeLeaseBoundTranscriptRecorder`. Обёртка создаётся только при точном
совпадении operator/profile/project/session между immutable
`TurnContextLease` и transcript binding. Перед обращением к delegate она
повторно проверяет `sessionId` запроса, резервирует операцию lease и отмечает
начало I/O. Чужая session, закрытый или устаревший lease отклоняются до
transcript I/O; операция, уже начавшая I/O до quiesce, может завершиться, а
switch barrier ждёт её drain. Обёртка не меняет content и authority transcript.

App предоставляет production-фабрику
`makeNodeLeaseBoundSessionTranscriptRecorder`, которая собирает Node
persistence, core transcript, history projector, recorder и lease wrapper.
Фабрика ленивая: создание объекта и ошибочный binding не создают каталоги и не
читают файлы; private storage открывается только внутри первого разрешённого
lease operation. Binding и budget копируются и замораживаются при сборке, поэтому
последующая мутация входного объекта не меняет authority. Установка результата
в live runner остаётся явным действием composition root.

Для nightly подготовлена отдельная read-only проекция
`projectSessionTranscriptDayLog`. Она принимает только полный exact-Session
hash chain, повторно проверяет binding, непрерывную sequence, event-id и hashes,
выбирает один UTC-день и выдаёт bounded `NormalizedDayLog`. Строки `system`
исключаются: в них находятся DNA, bodies Skills и code-owned action contracts,
которые не являются воспоминаниями оператора. `user`/`assistant` становятся
`utterance`, а `tool` — только `tool-result`; свободный текст никогда не
разбирается как `tool-call` или `decision-journal`.

Node-источник `makeNodeLeaseBoundTranscriptDayLogSource` открывает persistence
лениво только внутри разрешённой операции exact Project/Session lease,
замораживает binding и возвращает наружу только стабильный code-only отказ.
Он не расширяет Project authority до Workspace и сам по себе не активирует
nightly composition.

Неактивированный `makeNightlyProjectMaintenanceCoordinator` связывает этот
источник с explicit durable Workspace/Project binding snapshot и отдельным
`ProjectService` maintenance lease. Каждый Project обрабатывается изолированно;
restart повторяет те же bindings, а обязательный forget-filter может только
удалять записи из проверенного day log. Coordinator не перечисляет registry,
не следует interactive selection и не активирует generator, judge или live
scheduler.

Production-preview seam
`makeNodeProtectedMemoryNightlyProjectMaintenanceCoordinator` подставляет в
coordinator обязательный protected-memory forget adapter. Он использует один
deterministic normalizer с memory write path, проверяет verified global и
exact-Project forget-list и допускает только removal-only результат.
Версионированная structured activity authority теперь реализована offline, но
ещё не передана этому coordinator или live composition; поэтому
`tool-call`/`decision-journal` здесь по-прежнему fail closed, а текст tool result
не превращается в такие события.

Offline `SessionActivityJournal` v1 задаёт versioned authority для
интерактивного ingress и background dispatch, не активируя transport. Telegram
ingress имеет content-independent identity из `chatBindingHash + updateId`;
идентичный retry идемпотентен, а изменённые bytes под той же identity приводят к
quarantine. Seal принимает только явный упорядоченный список pending ingress,
атомарно связывает его с одним dispatch, сохраняет этот порядок и берёт
`turnTs` из самого раннего исходного сообщения. Для trigger/goal/nightly
background identity строится из exact binding, типа источника, `sourceId` и
`occurrenceId`; повтор той же occurrence возвращает тот же prepared dispatch.

Dispatch проходит строгую FSM `prepared → provider-pending →
provider-recorded → tool-pending → tool-recorded → … → terminal` с
монотонными `revision`, `operationSeq` и CAS. Переход `*-recorded` обязан
приложить следующую transcript evidence: exact ordinal, вычисляемый event id и
row hash проверенной transcript chain. Recovery ничего не выводит из текста:
`provider-pending/provider-recorded` и `tool-pending/tool-recorded`
консервативно возвращают соответствующий outcome-uncertain interruption,
расхождение transcript — `TRANSCRIPT_DIVERGED`, а terminal state повторно
возвращает сохранённый `TurnResult` без provider/tool dispatch. Явный
interruption сохраняется и повторяется после реконструкции runtime.

Preview-only Node store выбирает каталог по hash полного
operator/profile/Project/Session binding, требует private `0700/0600`,
отклоняет symlink, небезопасные права, подмену inode и control file больше
8 MiB. Публикация использует private temporary file, `fsync`, atomic rename и
directory `fsync`; CAS сверяет наблюдённые revision и digest точных bytes.
Повреждённый JSON, неизвестные поля, binding/identity conflict и tamper не
переписываются как валидное состояние, а переводятся в durable quarantine.
Node-тест подтверждает восстановление стабильной background identity новым
runtime и изоляцию одинаковых session id по полному binding. Контракт и store
явно preview-only: multi-process singleton writer, live import/composition и
activation отсутствуют.

## 5. Node persistence и recovery

Durable layout:

```text
~/.aisy/
  transcript-v2.jsonl
  sessions/<sessionId>/
    manifest.json
    append.wal.json       # существует только при незавершённом commit
    quarantine.json       # существует после fail-closed отказа
```

Каталоги имеют mode `0700`, файлы — `0600`. Manifest публикуется атомарно;
append проходит WAL → fsync → JSONL row → fsync → manifest → fsync → удаление
WAL. Ошибка после публикации WAL возвращает `TranscriptCommitUncertainError`, а
не ложный definitive failure.

На startup WAL восстанавливается exactly once. Частичный хвост JSONL можно
обрезать только тогда, когда он является точным prefix ожидаемой WAL row.
Посторонний хвост не изменяется: session получает durable quarantine.

Размеры ограничены: frozen prefix — 4 MiB, content строки — 1 MiB, physical row
— 2 MiB, control file — 8 MiB, текущий общий JSONL — 256 MiB.

## 6. Legacy и rollback

Legacy `session-log.jsonl` не переписывается. Старая сессия регистрируется как
`metadata-only`; продолжение создаёт новую exact-v2 session и первую
load-bearing migration-boundary row со ссылкой на id и hash источника.

### 6.1 Forget-safe resume projection — ОТЛОЖЕНО ADR

Exact private transcript, persisted frozen prefix и их hashes при `/resume` не
изменяются. Но они не передаются provider напрямую: resume assembler каждый раз
применяет текущие protected-memory tombstones, preference/skill revocations и
source forget filters к provider-facing view. Если view отличается от
persisted provider binding, server-side provider thread не resume-ится;
создаётся linked provider generation с отдельным projection hash и code-owned
control row. Raw audit остаётся byte-identical.

Факт или learned preference, забытые после исходной Session, не могут попасть в
provider prompt, retrieval, tool args или terminal quote при resume. Filter
failure закрывает только provider resume и не уничтожает audit. Эта граница
нужна до заявления forget-safe provider resume. Текущий LIVE `/resume`
переключает exact Session через one-use authority и controlled restart, но не
заявляет отдельную повторную фильтрацию старого transcript сверх существующей
provider projection; private audit при этом не переписывается.

До live activation recorder по-прежнему включается только явной production
composition. После появления SQLite writer lease rollback текущего binary имеет
ровно одну форму: exact `AISY_SESSION_JOURNAL=0`. В этом режиме runtime не
открывает и не изменяет lease DB, anchor, permanent compatibility barrier,
manifest, WAL или `transcript-v2.jsonl` и продолжает прежний путь без recorder.
Любое другое значение не ослабляет enabled gate.

Путь `.transcript-writer.lock` после согласованного cutover навсегда занят exact
private regular compatibility barrier. Поэтому запуск старого binary не является
rollback: его directory-lock acquisition обязан получить `EEXIST`. Существующий
legacy directory/residue переводится только отдельной ручной операцией после
доказанной quiescence всех writer; runtime и doctor не удаляют и не преобразуют
его автоматически. После будущего необратимого `V2_WRITES_ENABLED` rollback без
recorder не разрешён; нужен forward repair по migration manifest.

## 7. Текущая граница готовности

Реализованы core contract, hash chain, legacy boundary, Node WAL/restart,
authoritative session-start и проводка recorder через `AgentLoop`/`AgentRunner`.
Не реализованы и не включены:

- LIVE-развёртывание, ручной legacy cutover и self-test writer lease на целевой
  filesystem; current-binary composition уже получает recorder под SQLite lease;
- подключение offline `SessionActivityJournal` к Telegram ingress/coalescing и
  goal/trigger/nightly dispatch: обе identity реализованы, но production
  transport их ещё не публикует;
- live partial-turn recovery coordinator: core уже консервативно различает
  ready/completed/outcome-uncertain/transcript-diverged, но production runtime
  ещё не применяет этот verdict к provider/tool dispatch;
- retention/rotation/экспорт и operator recovery UI;
- migration cutover и `V2_WRITES_ENABLED`.

Уточнённый singleton writer определён
[ADR-0068](../decisions/2026-07-29-session-journal-singleton-writer.md).
Steady-state authority — kernel-released local-filesystem SQLite transaction
`BEGIN IMMEDIATE`, удерживаемая process lifetime. Exact layout:

- каталог `${journalRoot}/.transcript-writer-lease/` mode `0700`;
- DB `transcript-writer-lease.sqlite3` mode `0600` с одной exact-schema
  identity row: role `transcript-writer` и `database_id` из 64 lowercase hex;
- immutable anchor `transcript-writer-lease.sqlite3.identity.json` mode `0600`
  с exact `{version:1,role:'transcript-writer',databaseId,dev,ino}`;
- permanent regular barrier `${journalRoot}/.transcript-writer.lock` mode
  `0600` с exact
  `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}`.

DB, anchor, barrier и фактические device/inode обязаны совпадать. Symlink,
unsafe permissions, identity drift, corrupt DB, WAL/SHM или unsafe companion
закрывают acquisition без mutation.

Bootstrap использует полностью initialized private `O_EXCL` temp, fsync,
atomic hardlink и directory fsync. Exact `nlink=2` crash-state завершается лишь
после полной проверки; valid DB без anchor может восстановить anchor только в
доказанном bootstrap crash window. Anchor при missing/empty/mismatch/corrupt DB
никогда не разрешает reinitialize.

Путь `.transcript-writer.lock` является постоянным compatibility barrier.
Exact regular file запрещает старому directory-lock client стать writer.
Acquisition автоматически завершает только exact crash boundary: barrier
`nlink=2` и ровно один same-inode private temp
`..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`; temp удаляется с
directory fsync. Любой иной hardlink/residue остаётся fail-closed, а doctor
read-only классифицирует его как corrupt.
Legacy directory с `owner.json` даёт fail-closed `legacy-residue`; regular
barrier с неexact bytes — `lease-corrupt`, а symlink, special node,
небезопасные права или неразрешённый hardlink — `lease-unsafe`. Никакого
PID/`mtime`/timeout takeover нет. Legacy cutover требует отдельной ручной
proven-quiescence операции.
Остальные публичные классы отказа: `held-by-another-process`, `lease-unsafe`,
`lease-corrupt`, `lease-unavailable` и `lease-lost`; внутренние пути и SQLite
details не раскрываются.

Acquisition выполняется до manifest/WAL/JSONL и до provider/tool/Telegram I/O.
При enabled journal любой busy/corrupt/unsafe/legacy/identity отказ завершает
весь full runtime: тихая деградация до неполного журнала запрещена. Setup-only
Telegram не пишет transcript и остаётся вне full-runtime gate. Текущий binary
можно явно откатить exact `AISY_SESSION_JOURNAL=0`; этот режим ничего не чинит и
не удаляет permanent barrier. `aisy doctor` только читает и классифицирует
состояние, включая при `--fix`: он не захватывает lease, не завершает bootstrap,
не создаёт anchor и не удаляет residue.

Перед LIVE обязателен process-level self-test на фактической локальной
filesystem: один process удерживает lease, второй получает busy, первый
завершается через `SIGKILL`, второй автоматически захватывает тот же DB inode.
NFS, SMB и иные network/multi-host filesystems не поддерживаются.

Исторический pre-activation evidence этого среза: transcript-тесты на реальных
процессах — 12/12;
объединённая process-матрица — 31/31; полный App gate — 132 файла тестов
успешно / 1 пропущен, 1031 тест пройден / 1 пропущен; typecheck App и
upstream-сборка зелёные. Последующие production merges подключили recorder,
compaction, reply checkpoint и durable media inbox; target-FS self-test,
long-session acceptance и dormant контуры ниже всё ещё не закрыты.

Проекция day log и offline per-Project maintenance coordinator реализованы, но
их live-подключение остаётся выключенным. Nightly Workspace-session не получает
права читать Projects: список exact bindings должен быть подготовлен отдельной
явной authority. Структурированный activity source v1 теперь существует
offline, но ещё не подключён к day-log/maintenance pipeline;
реконструировать `tool-call`/`decision-journal` из текста tool result запрещено.

Поверх `SessionActivityJournal` реализован отдельный durable Telegram preview:
coordinator принимает и атомарно запечатывает ordered ingress только под exact
operator/profile/Project/Session/chat binding; reply checkpoint связывает тот
же dispatch с owner/revision и не делает blind resend после неоднозначной
доставки; media journal сохраняет content-independent ingress/group identity,
порядок album, capped members, voice outcome и pending acknowledgement. Fresh
runtime повторно проверяет checksum, identity и полный binding и выполняет zero
Telegram I/O для неоднозначного pending состояния. Reply checkpoint и durable
media inbox уже подключены; `SessionActivityJournal` coordinator и structured
day-log/maintenance pipeline остаются вне `bot.ts`/`aisy.ts`.

## 8. Критерии приёмки

1. **AC-23-1:** manifest и rows принимают только exact schema и exact binding.
2. **AC-23-2:** prefix hash и row hash вычисляет core по всем authority fields.
3. **AC-23-3:** concurrent appends дают непрерывный per-session sequence.
4. **AC-23-4:** duplicate проверяется только после проверки всей цепочки.
5. **AC-23-5:** metadata-only session не принимает строки; продолжение создаёт
   явную migration boundary.
6. **AC-23-6:** crash после WAL/row/manifest восстанавливается exactly once.
7. **AC-23-7:** посторонний partial tail и WAL с неизвестным authority field не
   публикуются и вызывают quarantine.
8. **AC-23-8:** recorder без stable turn authority не вызывает provider/tool.
9. **AC-23-9:** порядок input → assistant → effective tool → assistant совпадает
   с synthesis context и durable ordinals.
10. **AC-23-10:** failure recorder блокирует дальнейший необратимый шаг.
11. **AC-23-11:** legacy composition без recorder сохраняет прежнее поведение.
12. **AC-23-12:** новая session фиксирует фактический model prefix, а restart с
    изменившимся memory candidate использует сохранённый manifest prefix.
13. **AC-23-13:** restart загружает проверенную prior history через Context
    Engine, сохраняет роли/provenance и не записывает projected spans повторно.
14. **AC-23-14:** transcript binding обязан точно совпадать с immutable lease;
    request session и stale lease отклоняются до delegate I/O, а начатая до
    quiesce операция дренируется до закрытия lease.
15. **AC-23-15:** одинаковый Telegram batch даёт одинаковые content-independent
    `turnId/turnTs`; изменение membership/order меняет id, а timestamp берётся
    из самого раннего update.
16. **AC-23-16:** production Node factory отклоняет lease/binding mismatch без
    filesystem I/O, захватывает binding до lazy I/O и собирает полный
    restart-capable recorder только при первом разрешённом вызове.
17. **AC-23-17:** day-log projector принимает только полный exact-binding
    hash chain, исключает system rows и сохраняет provenance остальных rows.
18. **AC-23-18:** projector не выводит `tool-call`/`decision-journal` из
    свободного текста и при превышении bounds отказывает без truncation.
19. **AC-23-19:** Node day-log source читает только exact Project/Session под
    активным lease, переживает restart и скрывает повреждение за code-only
    ошибкой; mismatch/stale lease не создаёт storage.
20. **AC-23-20:** durable maintenance binding snapshot принимает один exact
    Workspace/system-session и bounded unique Project/system-session bindings,
    переживает restart, не хранит roots/content и карантинирует invalid bytes
    без автоматической перезаписи.
21. **AC-23-21:** offline coordinator захватывает отдельный maintenance lease
    для каждого explicit Project, применяет обязательный removal-only
    forget-filter и возвращает раздельные snapshots; stale Workspace, Project
    corruption или fabricated filter output не приводят к cross-Project I/O.
22. **AC-23-22:** protected-memory composition удаляет exact/residual forgotten
    transcript records по global+exact-Project verdict, повторяет результат
    после restart и скрывает recovery/tamper detail; stale lease и unknown
    structured activity блокируются до неавторизованного runtime/content I/O.
23. **AC-23-23:** offline `SessionActivityJournal` v1 идемпотентно принимает
    exact Telegram ingress, атомарно связывает его явный порядок и создаёт
    стабильную background occurrence identity; строгие FSM/revision/
    operation-sequence CAS и transcript ordinal/event/hash evidence запрещают
    пропуски и поддельное recorded-состояние. Recovery состояний
    `pending`/`recorded` консервативно
    прерывается, terminal replay не вызывает внешний dispatch. Node store
    использует hash полного binding, private atomic files, observed-byte CAS и
    durable quarantine. Контракт остаётся preview-only без singleton writer и
    production wiring.
24. **AC-23-24:** durable Telegram preview сохраняет один полный binding от
    ordered ingress до reply/media checkpoint, изолирует одинаковые Session ID
    разных Projects, после restart восстанавливает exact order/terminal state и
    не повторяет неоднозначный send/download. Binding/checksum/identity drift
    карантинируется либо возвращает code-only denial до Telegram I/O; `bot.ts` и
    `aisy.ts` остаются неподключёнными.

25. **AC-23-25:** local-FS SQLite `BEGIN IMMEDIATE` writer lease выдаётся ровно
    одному process и удерживается до release/OS exit; второй process выполняет
    zero transcript/provider/tool/Telegram I/O, а после real `SIGKILL` holder
    replacement автоматически получает тот же exact DB inode без PID, `mtime`,
    stale unlink или time-based takeover.
26. **AC-23-26:**
    `${journalRoot}/.transcript-writer-lease/transcript-writer-lease.sqlite3`
    содержит одну exact role/database-id row, а immutable соседний
    `transcript-writer-lease.sqlite3.identity.json` точно равен
    `{version:1,role:'transcript-writer',databaseId,dev,ino}` и совпадает с
    DB/device/inode. Crash-safe initialized-temp/hardlink/fsync bootstrap
    безопасно завершает только exact `nlink=2` window; corrupt/unsafe/identity
    drift, anchor+missing/empty/mismatch и unsafe companions дают zero-mutation
    refusal.
27. **AC-23-27:** permanent regular `${journalRoot}/.transcript-writer.lock`
    mode `0600` с exact
    `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}` запрещает
    legacy `mkdir` client после каждого release/restart. Автоматически
    завершается только exact barrier crash boundary: `nlink=2` и один
    same-inode `..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`; иной
    hardlink/residue отказывает без mutation. Legacy directory/residue никогда
    не преобразуется автоматически и требует отдельного ручного
    proven-quiescence cutover.
28. **AC-23-28:** enabled lease failure останавливает весь runtime до первого
    внешнего эффекта; exact `AISY_SESSION_JOURNAL=0` сохраняет current-binary
    rollback без чтения/mutation writer state. Doctor для всех состояний
    read-only и не выполняет recovery даже с `--fix`.
29. **AC-23-29:** activation self-test на фактических Linux/macOS local
    filesystems доказывает contention, crash-release и exact identity; NFS/SMB
    блокируют LIVE.
30. **AC-23-30:** provider-facing projection завершённой action-группы удаляет
    только code-owned contract/recovery spans и все assistant attempts кроме
    terminal reply. Operator input и значимые tool spans сохраняют порядок;
    durable transcript rows, ordinals и hash chain остаются byte-неизменными.
    Для ordinary-группы raw неподтверждённая атрибуция текущему входу также
    остаётся в audit row, но отсутствует в следующем provider prompt. Untrusted
    assistant ingress до первого code-owned action boundary сохраняется и
    может обосновать terminal warning; assistant attempts после boundary таким
    основанием не являются.

## 9. Трассировка тестов

- `app/transcript-writer-lease.spec.ts`: AC-23-25…28, exact schema/bootstrap/
  compatibility, exact barrier crash boundary и read-only inspection;
- `app/transcript-writer-lease.integration.spec.ts`: real-process contention,
  `SIGKILL` reacquire, no-overlap, legacy barrier и enabled/rollback sentinel —
  **12/12**;
- объединённая process-матрица writer/supervisor — **31/31**;
- полный App gate — **132 файла тестов успешно / 1 пропущен, 1031 тест пройден /
  1 пропущен**; typecheck App и upstream-сборка зелёные;
- target-filesystem activation self-test: AC-23-29 — **обязателен перед LIVE,
  evidence отсутствует**;
- `runtime/session-transcript.spec.ts`: AC-23-1…5;
- `app/session-transcript-store.spec.ts`: AC-23-6, 7 и file modes;
- `runtime/session-transcript-recorder.spec.ts`: deterministic ids, binding и
  exact-fields gate;
- `agent-loop/agent-loop.spec.ts`: AC-23-8…10 и code-owned spans;
- `agent-loop/agent-loop.spec.ts`: AC-23-30, разделение полного audit-журнала и
  очищенной provider-facing истории;
- `runtime/agent-runner.spec.ts`: lazy augmentation и AC-23-11.
- `app/session-transcript-runtime.spec.ts`: AC-23-9, 11, 12 через реальный Node
  store и новый AgentRunner после restart; AC-23-13 проверяет model request.
- `runtime/session-transcript-history.spec.ts`: verbatim role/order, строгий
  summary provenance, load-bearing preservation и metadata-only deny.
- `runtime/lease-bound-transcript-recorder.spec.ts`: AC-23-14 для start/history/
  record, binding/request mismatch, stale-before-I/O и in-flight drain.
- `app/bot-session.spec.ts`: AC-23-15 для exact batch, retry, membership/order и
  invalid metadata; live handler передаёт authority в `AgentRunner.handle()`.
- `app/session-transcript-runtime.spec.ts`: AC-23-16 и реальный
  AgentRunner→lease wrapper→recorder→Node store restart path.
- `runtime/transcript-day-log.spec.ts`: AC-23-17, 18, включая binding/sequence/
  hash/duplicate/date/bounds и запрет текстовой реконструкции событий.
- `app/transcript-day-log-runtime.spec.ts`: AC-23-19, two-Project isolation,
  fresh-runtime restart, stale/mismatch zero-I/O и redacted corruption.
- `app/nightly-maintenance-binding-store.spec.ts`: AC-23-20, strict schema,
  deterministic restart, quarantine, bounds и private file mode.
- `runtime/project-service.spec.ts` и
  `app/nightly-project-maintenance.integration.spec.ts`: AC-23-21, targeted
  drain/barrier, Project A/B isolation, restart и filter subset invariant.
- `memory/fact-key.spec.ts`,
  `runtime/protected-memory-deletion-node.integration.spec.ts` и
  `app/nightly-protected-memory-forget-filter.integration.spec.ts`: AC-23-22,
  shared normalizer, real global/Project forget ledger, residual fail-safe,
  restart, stale/recovery/schema denial и redacted telemetry.
- `runtime/session-activity-journal.spec.ts`: AC-23-23, exact ingress/background
  identity, ordered seal, FSM/CAS, transcript evidence, conservative
  interruption и terminal replay без внешнего исполнителя;
- `app/session-activity-journal-store.spec.ts`: AC-23-23, хранение по полному binding,
  private atomic publication, повторная загрузка новым runtime, observed-byte
  CAS, отказ для небезопасного пути/превышения размера, durable quarantine и
  preview-only guard.
- `app/bot-streaming-activity-coordinator.spec.ts`: AC-23-24, exact full-binding
  ingress/seal, Project isolation и conflict/binding denial;
- `app/bot-streaming-restart.integration.spec.ts`: AC-23-24, fresh-runtime
  reply restart, terminal replay и zero-I/O для ambiguous send;
- `app/telegram-reply-stream-checkpoint.spec.ts`: AC-23-24, owner/revision
  fencing, binding hash и pending-delivery restart verdict;
- `app/bot-media-ingress-journal.spec.ts` и
  `app/bot-media-restart.integration.spec.ts`: AC-23-24, content-independent
  media/album identity, full-binding isolation, ordering, acknowledgement и
  fresh-runtime recovery без redownload.

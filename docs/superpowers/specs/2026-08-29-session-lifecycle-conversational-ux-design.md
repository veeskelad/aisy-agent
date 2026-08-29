# Разговорное управление, живой Telegram и lifecycle Session

**Дата:** 2026-08-29

**Статус:** дизайн подтверждён указаниями оператора 2026-08-29

**Связанное решение:** ADR-0112; дополнения к ADR-0108, ADR-0110 и ADR-0111

## 1. Проверяемый результат

Aisy принимает обычные фразы для настройки поддерживаемых функций, но меняет
состояние только через закрытые typed operations. Session автоматически получает
осмысленное имя, её можно переименовать, продолжить или удалить из Telegram.
Удаление Session не стирает память, навыки, стиль и разрешения.

Обычный чат звучит как разговор. Он не показывает внутренние protocol receipts,
recovery phases, таймеры, workspace labels, tool history или рассуждения. Эти
данные остаются в server-side журнале, `doctor` и явном debug.

## 2. Границы

В срез входят:

1. auto-name первой содержательной Session темы и явное переименование;
2. detail-card Session и удаление с одним подтверждением;
3. crash-safe purge registry/transcript и controlled restart active Session;
4. session-independent ordinary grants и более строгие Project/path overlays;
5. typed conversational configuration без self-source modification;
6. полный inventory code-owned Telegram copy и автоматический copy contract;
7. production migration, rollback и live acceptance через `@monday_aibot`.

Не входят удаление долговременной памяти вместе с Session, ослабление deny,
автоматическая установка произвольного кода, свободная правка `SOUL.md` или
`SKILL.md`, а также раскрытие server-side диагностики в обычном ответе.

## 3. Session lifecycle

Отдельный private `session-labels-v1` store различает временное и
пользовательское имя без изменения registry schema и без доверия строке
`New session`. Код записывает `temporary` только вместе с созданием новой
Session. Отсутствующая metadata у legacy Session означает `explicit`: старое
имя никогда не расширяется или не переименовывается по совпадению literal.

Registry и отдельный label store связывает внешний
`SessionCreationCoordinator`. До создания interactive, daily-rotation или
delete-replacement Session он пишет внешний WAL с deterministic create key,
заранее выбранным session id и `temporary` metadata. Повтор после crash
доделывает ровно ту же пару registry/label либо откатывает ещё не опубликованные
temporary bytes. Startup repair завершается до Telegram polling, поэтому crash
между registry create и label write не оставляет Session с потерянной семантикой
имени. Все три пути создания обязаны использовать coordinator.

Первый eligible turn может выпустить typed proposal с `turnId`, opaque target,
expected generation/name revision и коротким именем. Eligible означает:
authenticated operator text, не команда/кнопка, после NFKC содержит не менее
трёх word tokens или 12 Unicode code points. Proposal атомарно сохраняется как
`pending-delivery`; он не меняет registry во время model/tool execution.
Только existing `afterReplyDelivered` callback переводит exact proposal в
`committed` и вызывает rename, пока label остаётся `temporary`. Failed,
interrupted или ambiguous delivery не переименовывает Session; startup удаляет
orphan pending после terminal turn recovery. Имя нормализуется, ограничивается
64 видимыми символами и не содержит control/markup. Явное переименование
публикует `explicit`; auto-rename больше его не меняет.

Список Session остаётся компактным. Нажатие на строку открывает detail-card:

- текущая/дата/число ходов без UUID в основном тексте;
- `Продолжить` для неактивной Session;
- `Переименовать` запускает bounded one-message form;
- `Удалить` выпускает одноразовый preview.

Preview удаления: `Удалить сессию «…»? В Aisy её нельзя будет восстановить.
Память о тебе, навыки и разрешения останутся.` Operational backup retention
задаётся отдельно от Session lifecycle; restore всегда применяет tombstone до
запуска и не возвращает удалённую Session в live Aisy.
Кнопки: `Удалить` и `Отмена`. Тап связывается с exact owner, project/session,
selection generation, transcript head и source Telegram update. Любой stale tap
перерисовывает актуальную карточку, но registry, transcript, label metadata и
delete journal остаются byte-identical.

Удаление хранит WAL вне target Session control directory, в отдельном
single-writer `session-deletions/` root, и проходит фазы:

`prepared-and-fenced → replacement-selected → dependants-settled →
provider-purge-pending → provider-purged → transcript-rewrite-prepared → transcript-rewritten →
registry-removed → target-controls-removed → terminal → restart-requested →
restart-acknowledged`.

Durable marker `prepared-and-fenced` устанавливает `SessionLifecycleFence`.
Его publication и любая `list/get/switch/resume`, `acquireTurnContext`,
retry/continuation или background/system lease линейризованы одним per-owner
`SessionLifecycleCoordinator`: operation берёт lock, повторно читает общую
fence/selection revision и выполняет CAS одной registry publication. Нельзя
сначала проверить fence, а потом отдельно выбрать target. После marker target
скрыт и недоступен. Для active target coordinator держит тот же lock, пока
`replacement-selected` не опубликует новую selection generation; ни один ход не
видит dangling selection. Старый binding после fence даёт typed
`session-deleted`, не provider/tool I/O. Durable fence загружается до выдачи
первого lock после restart.

Для неактивной Session `replacement-selected` является no-op. Для активной код
под тем же неотпущенным lifecycle lock выбирает последнюю active Session либо
создаёт одну временную Session и увеличивает generation; marker уже сделал
target недоступным, но никакой конкурентный consumer не войдёт до публикации
replacement selection. Сразу после этой bounded publication owner lifecycle
lock освобождается; durable fence продолжает блокировать только target.
До fence coordinator выполняет code-local zero-I/O capability preflight всех
зависимостей. Adapter с provider-local persistence обязан уметь детерминированно
выпустить resumable purge handle; `unsupported` останавливает preview без state
mutation. После fence transient/ambiguous provider purge никогда не откатывает
и не делает Session доступной: handle переходит в durable retry вне owner
lifecycle lock и вне общего transcript gate, а unrelated Session продолжают
turns и append. Lifecycle заканчивается только после exact terminal success.
Текущий Claude adapter проходит preflight как
`no-session-persistence`.

Crash recovery продолжает exact внешний WAL; ни одна фаза не может выбрать
другой target по имени или mtime. Только фаза `transcript-rewrite-prepared`
берёт exclusive maintenance gate общего transcript writer непосредственно перед
fresh snapshot: gate запрещает и drain-ит append всех interactive, background и
system Session, а каждый обычный append проверяет тот же gate непосредственно
перед I/O. Под gate общий `transcript-v2.jsonl` переписывается атомарно во
временный private-файл строками других Session, fsync-ится, публикуется rename и
WAL переводится в `transcript-rewritten`; затем gate сразу освобождается. Crash
освобождает OS lock, а recovery повторно берёт gate и идемпотентно завершает exact
rewrite прежде чем разрешить следующую фазу. Append чужой Session не может
попасть между snapshot и rename; race corpus доказывает либо append-before-copy,
либо append-after-release без потери строки.

Target manifest/WAL/quarantine и attachment directory удаляются только в
отдельной `target-controls-removed` фазе после durable `registry-removed`.
Внешний delete WAL и tombstone остаются до terminal/restart acknowledgement,
поэтому crash после любой публикации сначала восстанавливает durable fence и
selection. Local bounded фазы repair заканчиваются до writer release; pending
provider purge возобновляется отдельным worker после release и блокирует только
target. Tombstone содержит exact owner/project/session ids,
purge revision/date и terminal operation hash, но не имя, transcript content,
старый hash head или attachment names. Эти ids нужны, чтобы fail-closed
разрешать старые durable bindings и не воскресить удалённую Session.

Controlled restart получает deterministic idempotency key из delete operation
hash. Crash до/после supervisor ACK повторяет reconcile, но не создаёт второй
restart intent или вторую startup-реплику.

Пока есть active turn, retry, parent continuation или nonterminal delegation
exact Session, delete возвращает короткое `Сессия ещё занята. Попробуй после
завершения работы.` До успешной проверки занятости разрешён только code-local
zero-I/O preflight; durable fence, provider purge и изменение зависимых данных
ещё не начинаются.

Матрица связанных данных:

| Данные с `sessionId` | После delete |
|---|---|
| Registry row, label metadata, raw transcript, attachments/inbox | физически удалены exact-operation cleanup |
| Active turn/retry/continuation/nonterminal delegation | delete запрещён до terminal |
| Terminal delegation/tool payload | raw payload удалён; bounded receipt сохраняется с tombstone |
| Goal, trigger, monitor, digest, current task/future job | existing paused/disabled state; sidecar reason `context-deleted`, без provider/tool I/O и автоматического rebind |
| Telegram outbox/replay evidence | доводится до terminal, затем raw Session payload удаляется; transport receipt остаётся |
| Принятые Project-файлы и `ProjectFileManifest` | файлы сохраняются как данные Project; обязательный provenance `sessionId` остаётся, но tombstone запрещает трактовать его как resumable Session |
| Непринятые Session attachments/inbox | физически удаляются вместе с target controls |
| Legacy `session-log.jsonl` | остаётся byte-identical/checksum-anchored metadata-only audit по ADR-0064; tombstone исключает resume и live Session projection |
| Legacy session grant | disabled/revocable, никогда не расширяется |
| Workspace/Project similar grant, memory, Skill, preference | сохраняется без изменения |
| Provider-local Session/thread | unsupported preflight отказывает до fence; resumable handle после fence повторяется до terminal purge; current Claude adapter доказывает `--no-session-persistence` |
| Backup | immutable backup не переписывается и не доступен UI; restore обязан применить tombstone до запуска, bytes очищает отдельная configured retention policy |
| Новый purge-audit store | только content-redacted tombstone и terminal operation receipt; legacy metadata-only audit остаётся по своей строке выше |

## 4. Разговорная конфигурация

Модель получает закрытые инструменты `list_sessions` и `configure_agent` с
версионированным набором операций. `list_sessions` возвращает не id, а bounded
one-turn opaque handles, привязанные к trusted owner/project/generation.
Для main Agent это обязательные code-owned platform-controls: при включённой
AgentCard они добавляются сверх её workload allowlist с фиксированными
минимальными tiers, не открывая ни одного другого отсутствующего в карте tool.
`configure_agent` первого среза принимает `session.rename`,
`session.request-delete` и строгий policy overlay. Для current target допустим
literal `current`; inactive target задаётся только выданным handle. Resolver
сам восстанавливает owner/project/session/path из trusted binding/handle.
Модель передаёт допустимое значение, но не выбирает authority.

`session.request-delete` не удаляет данные и не является approval: операция
только создаёт code-owned preview с одноразовым Telegram token. Exact deletion
authority появляется лишь после authenticated tap. Button, direct command и
LLM используют один preview resolver. Preview подменяет terminal model reply и
доставляется тем же durable reply stream как одно сообщение с кнопками; отдельное
«карточка подготовлена» пользователю не отправляется. Exact rename и выпуск
preview дают operation-aware typed receipt для action-contract, однако receipt
preview доказывает только показ подтверждения, а не удаление Session.

Project/path overlay выражает только narrowing: `ask-before-delete`,
`read-only`, `no-egress`, `confirm-writes`. Код сравнивает overlay с baseline и
отвергает любое ослабление. Исходники Aisy, constitution, system prompts,
provider envelope, tool registry и safety rules не являются configurable
resources и не доступны этому инструменту.

Папка выбирается не свободной строкой модели. Read-only resolver
`resolve_policy_path` принимает operator-visible candidate, проходит путь
component-by-component от trusted Project root без symlink traversal, проверяет
root confinement и возвращает one-turn opaque handle. Перед commit resolver
повторно сверяет device/inode, Project-relative identity и policy revision.
Наложения наследуются от Project к самой глубокой папке; при конфликте действует
самое строгое правило. Ужесточение применяется сразу через CAS. Ослабление или
отзыв overlay — отдельное widening-действие с одним authenticated tap. UI умеет
показать и отозвать точные Project-relative overlays без раскрытия host path.

Короткие direct commands и Telegram buttons вызывают те же resolvers. Они нужны
как deterministic fallback, а не как отдельный продуктовый путь.

## 5. Разрешения

Существующий durable similar-grant schema v3 остаётся каноном и не содержит
Session id для scope `workspace|project`. Чистый `operator/global` scope не
вводится. Matcher всегда сохраняет exact operator/profile, Project boundary,
operation, resource hash, risk ceiling и policy revision.

Ordinary Tier-2 confirmation создаёт текущий Workspace/Project scope, который
уже умеет удалить Session id через `contextBinding`, и переживает Session
rotation/delete. Новая migration schema не нужна. Старые session-bound grants
не расширяются: они видимы для отзыва и перестают действовать вместе с прежней
Session. Tier-3, irreversible/destructive,
credential/authority changes и HARD_DENY никогда не создают grant. Существующие
persisted v3 records читаются byte-for-byte прежним store.

Project/path overlay проверяется после grant и может вернуть `ask` или `deny`.
Поэтому глобальное разрешение не отменяет просьбу `в этой папке всегда спрашивай
перед удалением`.

## 6. Telegram copy contract

Обычный режим:

- быстрый answer/tool result — только terminal ответ;
- долгая работа — одна редактируемая строка `Работаю…`, при полезности с
  конкретным человеческим глаголом, без таймера и истории;
- destructive preview — действие, target и одно последствие;
- плановый restart — `Перезапускаюсь. Скоро вернусь.`;
- startup после него — `Снова на связи.` не более одного раза;
- provider/runtime error — `Не получилось ответить. Попробовать ещё раз?`;
- delivery error — `Не смог отправить ответ. Попробуй ещё раз.`.

В code-owned обычном render запрещены внутренние значения `intent`, `receipt`,
`checkpoint`, `authority`, `schema`, `binding`, `runtime`, `System:`,
«доказательство», «проверяемый результат», «общая папка», внутренние ids,
токены, стоимость, таймеры, названия инструментов, chain-of-thought и объяснение
собственных safety-проверок. Запрет относится к server-owned диагностической
проекции, а не к словам вообще: прямой вопрос оператора о runtime, стоимости
или архитектуре получает нормальный содержательный ответ модели.

Debug/doctor имеют отдельные renderers и могут показывать bounded code/revision/
phase без raw dialogue, secrets и chain-of-thought. Model-facing instruction
запрещает обсуждать control/provenance без прямого вопроса оператора; это
проверяется replay/eval corpus обычных реплик и прямых технических вопросов,
но не объявляется hard safety boundary.

## 7. Ошибки, restart и rollback

Restart-intent записывается до exit, но его durable acknowledgement не
отправляется в Telegram. Неуспешная запись отвечает `Не получилось
перезапуститься. Я остаюсь на связи.` и не выходит. Exact replay старого update
подавляется существующим retained evidence.

Единый bootstrap write barrier полностью восстанавливает create WAL, загружает
delete WAL/fences/tombstones и доказывает valid replacement selection до запуска
Telegram polling, scheduler, goals/triggers/monitors, background/system workers
и maintenance. Незавершённая local bounded delete phase, включая transcript
rewrite, заканчивается под barrier. Единственное safe resumable состояние —
`provider-purge-pending`: durable fence и replacement уже опубликованы, target
не выдаётся ни одному consumer, а retry worker стартует после release barrier.
Так unrelated Session продолжают работать, пока old binary всё ещё запрещён.

Session create/delete WAL восстанавливается только новым binary с exact schema.
Managed rollback до предыдущего release разрешён только до durable
`prepared-and-fenced`: coordinator отменяет ещё не опубликованный preview/WAL.
После fence возможен только roll-forward, даже если transcript ещё не переписан,
потому что selection, jobs или leases уже могли измениться. Updater оставляет
write/fence barrier, новый binary возобновляет exact recorded phase и проходит
все оставшиеся фазы по порядку до `terminal`; только terminal
certificate разрешает запуск старого binary. Старый binary не читает create/delete
WAL и потому никогда не стартует при любом nonterminal record. Terminal delete
не меняет schema registry, manifest или jobs: ProjectFileManifest сохраняет
обязательный `sessionId`, jobs используют существующее paused/disabled состояние,
а новая причина хранится в sidecar. Legacy Session label metadata трактуется как
explicit, поэтому downgrade не требует dual-read. Restore любого старого backup
сначала запускает deletion-aware restore helper, применяет tombstones и только
потом выдаёт writer lease; запуск binary напрямую на backup fail-closed по
minimum-readable-release marker.

## 8. Детерминированная проверка

Обязательные corpus:

1. auto-name применяется один раз и не перезаписывает explicit name;
2. rename через LLM tool, direct command и кнопку приводит к одной service
   mutation;
3. stale/foreign/replayed delete tap не меняет registry, transcript, label
   metadata и delete journal; transport redraw/replay receipt допускается;
4. delete inactive Session убирает registry row, transcript rows и control dir;
5. delete active Session создаёт/выбирает replacement, purges exact target и
   делает один restart;
6. fault injection на каждой purge phase после restart приводит к одному
   terminal состоянию без resurrection и без удаления чужой Session; concurrent
   append другой interactive/background/system Session не теряется;
   list/switch/resume/turn/background races после fence не получают target;
7. memory, active Skills, preferences и grants byte-identical до/после delete;
8. ordinary grant переживает daily rotation и delete, Project/path narrowing
   по-прежнему спрашивает;
9. попытка configure source/prompt/safety даёт zero-I/O typed отказ;
   AgentCard без новых имён всё равно получает только два platform-controls;
   rename/delete-preview завершают action-contract без recovery-round, а preview
   приходит одним terminal сообщением с кнопками;
10. каждый code-owned обычный renderer проходит forbidden-diagnostic-copy
    corpus; debug/doctor — отдельный allowlist; provider replay/eval различает
    обычную реплику и прямой технический вопрос;
11. restart видим как две короткие человеческие реплики без внутренней
    квитанции и без replay loop;
12. future goals/triggers/monitors/tasks используют существующее paused/disabled
    состояние и sidecar reason `context-deleted`; raw attachment/provider state
    очищается, grants/memory/Skills/preferences сохраняются согласно матрице;
13. managed rollback corpus запрещает старый binary при nonterminal create/delete
    WAL; terminal state остаётся читаемым предыдущим release, а restore старого
    backup через обязательный helper не воскрешает Session;
14. fault injection каждой фазы Session creation не оставляет registry без label
    metadata и не создаёт две replacement Session;
15. принятые Project-файлы и schema manifest byte-compatible переживают delete,
    target rows исчезают из transcript-v2, legacy session-log/anchor остаются
    byte-identical metadata-only, а новый audit не содержит dialogue content;
16. path overlay corpus покрывает symlink swap, escape, stale handle/revision,
    nested strictest-wins, immediate tighten и подтверждённое relax/revoke;
17. bootstrap corpus не запускает ни один transport/background/system writer до
    terminal create repair и применения delete fence/tombstone/replacement;
    `provider-purge-pending` после этого возобновляется асинхронно и блокирует
    только target, остальные local phases завершаются до release;
18. provider capability preflight отказывает до fence; fault injection перед и
    во время provider I/O восстанавливает exact `provider-purge-pending`, а
    transient/ambiguous purge возобновляется до одного terminal результата, не
    удерживая lifecycle/transcript locks и не блокируя unrelated Session.

Отдельный недетерминированный release gate выполняется в production:
create → auto/explicit rename → resume → delete inactive → delete active →
restart, затем простой разговор, memory recall и один разрешённый tool call.

## 9. Доставка

Изменение поставляется последовательно: creation coordinator и label sidecar;
session lifecycle fence; global transcript writer
gate; purge authority/external WAL/tombstones и dependant matrix; transcript
delete; registry/service API; Telegram cards/forms; typed configuration; copy
renderers/tests. Existing grant schema v3 не мигрирует. До delete
cutover старый archive остаётся доступен. Managed release сохраняет previous
commit; production deploy выполняется только после targeted/full tests,
typecheck/build, leak/private-reference scan и независимого review.

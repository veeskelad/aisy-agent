# Component 17: Workspace, Projects, Sessions, Context and Files — Specification

**Статус:** LIVE в production composition; целевой Telegram/restart E2E остаётся
частью финальной production-приёмки
**Component:** 17 / 17
**Related ADRs:** ADR-0006, ADR-0007, ADR-0008, ADR-0023, ADR-0040, ADR-0060, ADR-0063, ADR-0066
**Normative design:** [Workspace and Project Context](../superpowers/specs/2026-07-26-workspace-project-context-design.md)
**Depends on:** 01 Core, 03 Memory, 05 Safety, 12 Observability, 15 Context Engine

> Workspace carries Aisy's persistent identity and personal memory. Projects are
> code-enforced work boundaries. Sessions are resumable append-only
> conversations owned by exactly one Workspace/Project context.

## 1. Purpose

A single operator needs one persistent personal Aisy and several independent
bodies of work. Aisy's character, operator profile, goals and durable personal
memory remain available everywhere. Project files, work notes, knowledge,
tasks, skills, agents, jobs, grants and current work never leak into another
project.

Every live turn has a code-resolved identity:

`operator_id + profile_id + project_id + session_id + selection_generation`.

The special Workspace is represented by a non-archivable registry record with
`kind="workspace"`; real projects have `kind="project"`. The compatibility
field name `projectId` refers to either kind until a later public-API rename.

## 2. Context and memory hierarchy

Context follows ADR-0063 and the normative design:

1. **Frozen global DNA** — `constitution.md`, `SOUL.md`, `USER.md`,
   generated `MEMORY.md`, `MISSION.md`, `GOALS.md`, `PROJECTS.md`,
   `PREFERENCES.md`, `LEARNED.md`, `CLAUDE.md`, and `SERVICES.md`.
2. **Lazy global memory** — explicit cross-project journal entries, global
   knowledge catalogue and explicitly-global retrieval.
3. **Active project** — only for `kind=project`: repository files, project
   memory/knowledge, tasks, skills, agents, grants and `.current-task.md`.
4. **Session** — append-only transcript, tool observations and read-time
   compaction view, owned by one context.
5. **Turn tail** — authenticated operator input, scoped retrieval and tool
   results under one immutable lease.

A session captures one stable prefix snapshot at creation. Resuming that
session reloads the same bytes/hash; only a new session sees newer DNA.
Compaction remains a view and never rewrites the transcript.

Текущий live `MemoryPort` собирает все 11 global DNA files в фиксированном
ADR-0063 порядке. `AgentRunner` замораживает этот source snapshot на Session;
реальный filesystem integration доказывает, что правка `MISSION.md` не меняет
два turn существующей Session, но видна новой. Durable transcript integration
отдельно доказывает возврат старых exact bytes/hash после restart.

Текущий preview-инкремент `LayeredContextAssembler` собирает lazy-слои 2/3
отдельно от frozen DNA и transcript history. Он принимает только immutable
`TurnContextLease`, строит retrieval query только из authenticated operator
user spans, не запрашивает Project-источник из Workspace и принимает
project excerpt лишь при точном `project:<lease.projectId>`. Порядок global →
active Project, тип источника, rank и bytewise tie-break задаёт код. Все
прочитанные Markdown/excerpt bytes входят в модель как `untrusted user` spans,
поэтому не получают system-привилегий и включают outbound narrowing.
Если switch начинается во время чтения, повторная lease-проверка отклоняет
старый контекст до model call; недоступный Project retrieval допускает только
явную degraded-сигнализацию, global retrieval и уже проверенные fixed files
активного Project, но не подстановку другого Project или непроверенный hit.
App preview-фабрика сама оборачивает runner этим assembler, поэтому
`buildRunner` не может случайно проигнорировать слой.

Production source adapter теперь читает global journal и knowledge catalogue
через отдельный exact Workspace `ResolvedWorkBinding`, а `.current-task.md`,
сегодняшний project journal, memory/knowledge catalogues — только через
confinement текущего Project lease. Один вызов scoped memory делится на global
и exact-project hits только при наличии protected `scopeId`, реального
`sourcePath` и provenance; legacy hit без этих полей fail-closed. Реальный
Node→Python descriptor-relative integration проводит оба root через preview
runtime и `AgentRunner` до model request. Live wiring в `aisy run` остаётся
выключенным до migration/activation gate.

The global daily journal contains cross-project-safe content and opaque
project-event references only. Project detail remains local unless the operator
explicitly promotes it. Automatic recall searches only Workspace plus the
active Project. From the Workspace context, explicit read-only `search_all_projects` requires
a one-use authenticated-operator receipt bound to owner, Workspace session,
generation, query hash, mode and archive flag. It may fan out across isolated active-project
indexes, but every labelled hit exposes only a one-use capability bound to its
exact project/path/chunk/content hash. Model, prompt-injected, nested,
missing/replayed/stale/wrong-query/wrong-mode/wrong-archive requests and arbitrary-path opens fail
closed. It never changes files or automatic context; mutation requires an
authorized switch to the owning Project.

## 3. Registry, selection and leases

Registry state is version 2. Each operator/profile owns exactly one Workspace
record and zero or more Project records. A persisted selection includes
`projectId`, `sessionId`, and a monotonic `generation`.

At every turn the control plane acquires an immutable `TurnContextLease` with
owner, context kind/id/root, session, generation and lease id. File tools,
memory, bash, approvals, agents, goals, triggers, monitors, digests and events
must consume a lease or durable work binding; no live path may fall back to
process cwd, Telegram chat id or a mutable global root.

Switching is a barrier. `ProjectService` requires a one-use,
owner/target/session/generation-bound `SwitchAuthorityReceipt` minted only from
the authenticated operator message or verified callback. It quiesces the old
interactive lease, consumes the receipt with `generation+1`, then assembles the
target session. Missing, replayed, stale or wrong-target receipts fail at the
mutation boundary.
Old/untrusted spans do not cross the barrier. Durable jobs retain their original
project/session binding and are never retargeted by an interactive switch.

Для обслуживания Project `ProjectService` предоставляет отдельный
`maintenance` lease только по явному exact Project/system-session binding.
До его выдачи code-owned barrier запрещает новые interactive/background
операции целевого Project и дожидается уже начатых leases; Workspace и другие
Projects не блокируются. Barrier удерживается до явного release и снимается
также при ошибке вызывающего coordinator. Workspace binding не может быть
превращён в Project maintenance authority, а текущая selection не используется.

## 4. Lifecycle

The shared `ProjectService` backs Telegram, deterministic natural-language
routing and structured tools:

- Workspace/context list and switch;
- project create, restricted HTTPS clone, register-existing, archive and restore;
- session create, rename, switch, search, archive and restore;
- lease acquisition;
- attachment inbox import.

Project creation and clone stage the filesystem, reserve slug/root against
concurrent requests, validate the complete tree, publish registry/session
state atomically and regenerate `PROJECTS.md`. Archive is non-destructive.
Archiving the active project atomically closes its lease, selects Workspace and
increments generation; archiving the active session selects/creates a
replacement in the same publication. Restore revalidates root/overlap and never
auto-selects. There is no hard-delete operation in this component.

Текущий lifecycle-инкремент поднимает archive/restore Project и Session в
единый `ProjectService`. Archive требует отдельный purpose-bound
`ProjectLifecycleAuthority`; `SwitchAuthorityReceipt` для него не принимается.
До drain устанавливается code-owned transition barrier: новый interactive
lease владельца и новый background lease точного Project/Session отклоняются
до CAS-публикации либо recovery. Registry проверяет `expectedGeneration`,
повторный archive и stale transition до persistence. Активный Project получает
Workspace replacement lease, активная Session — другую/новую Session; inactive
archive не меняет selection. Restore Project сначала вызывает инъекционную
canonical root revalidation и никогда не выбирает восстановленный контекст.
Без lifecycle-authority/root-validator весь lifecycle API выключен. Durable
registry restart подтверждает archived state, replacement selection и
монотонную generation. Production-preview authority теперь имеет отдельный от
switch HMAC-domain и purpose tag, exact binding на operator/profile/action/
Project/Session/generation/source-message hash, TTL не более пяти минут и
durable одноразовый nonce с consumed tombstone. Nonce-файл публикуется через
private temp, `fsync`, atomic rename и directory `fsync`; небезопасный path,
права, symlink, hardlink, corrupt schema и оставшийся temp дают fail closed.
Перезапуск не возрождает использованный receipt, а `SwitchAuthorityReceipt`
не проходит строгую lifecycle schema даже при совпавших id/secret. Над preview
seam `ProjectService` реализован неактивированный Telegram/NL-адаптер
двухшагового archive Project/Session. Первая exact RU/EN-команда только
показывает confirmation и не выпускает receipt; `confirm` повторно проверяет
operator/chat, общий одноразовый домен Telegram `update_id`, TTL, target
identity и `selection.generation`, затем связывает receipt с provenance
исходной команды и callback подтверждения. Cancel, expiry, replay, foreign или
malformed callback, identity/generation drift и внутренний сбой завершаются без
мутации и без раскрытия внутренних деталей. Pending token удаляется до issue и
mutation, поэтому неудачный confirm также нельзя повторить. Live wiring
остаётся выключенным.

Операции создания, переименования и поиска Session также проходят через
`ProjectService`. Preview-адаптер Telegram принимает только сообщение, уже
аутентифицированное Gateway, связывает команды с exact operator/profile и
использует `selection.generation` как compare-and-swap для мутаций текущего
контекста. Если между разбором команды и публикацией произошёл switch, create
или rename завершается `STALE_GENERATION` без записи. Обычный диалог адаптер не
перехватывает; создание Session не переключает текущую Session. Адаптер пока не
подключён к live-боту. Preview archive использует готовые durable
`ProjectLifecycleAuthority` и confirmation flow, но archive/restore не
экспонируются в live composition до отдельной активации.

Над этими адаптерами добавлен неактивированный транспортный seam в
`makeTelegramBot`. Обе зависимости необязательны: их отсутствие сохраняет прежний
путь без перехвата lifecycle/session-команд. После успешной аутентификации
Gateway и до coalescing, получения turn runtime, model/tool I/O transport
проверяет команды строго в порядке lifecycle → Session → существующий
переключатель Project; первый обработавший адаптер завершает маршрут. Lifecycle callback
маршрутизируется по точному префиксу `project-lifecycle:v1:` раньше
`project:` и общих callback-карт. В оба пути передаются фактические
`ctx.chat.id` и `ctx.update.update_id`. Карточка подтверждения получает
code-owned кнопки; `archived`/`cancelled`/`stale` редактируют исходное сообщение
обычным текстом, а при ошибке редактирования transport отправляет тот же
безопасный текст новым reply; `unavailable` и исключения не раскрывают
внутренние детали. Тесты отдельно доказывают нулевое получение turn runtime и
нулевой вызов модели для обработанной команды/callback. `aisy.ts` эти
необязательные зависимости не передаёт: live wiring и
activation остаются выключенными.

`register-existing` реализован как неактивированный preview-путь
`ProjectProvisioner → ProjectService`. Он принимает только абсолютную
canonical-директорию, отвергает root и symlink, фиксирует `device:inode`,
выполняет полный confinement tree-scan и повторно проверяет ту же identity до
публикации. Root/slug сверяются с активными и архивными контекстами до и после
scan. Исходное дерево не изменяется, не переносится и не получает служебных
файлов; в реестр публикуются `origin=registered`, новая Session и lease. Поздняя
ошибка после durable publication возвращает recovery-required вместо опасного
повторного retry. Node-тест подтверждает canonical real-directory и symlink
deny; live Telegram UI остаётся выключенным.

Безопасный clone принимает только HTTPS URL без userinfo,
нестандартного порта, query, fragment, управляющих символов и пустого либо
начинающегося с `-` первого компонента пути. До файловой reservation он
получает ограниченный набор A/AAAA и закрывает весь запрос, если хотя бы один
адрес не относится к публичному IPv4 либо IPv6 global-unicast. Результат
фиксирует точный набор проверенных адресов, исходное TLS-имя и запрет
redirect. По [ADR-0066](../decisions/2026-07-27-one-shot-sandbox-for-public-clone.md)
transport обязан использовать одноразовый digest-pinned sandbox без прямого
внешнего маршрута, credentials, host network и Docker socket. Единственный
сетевой путь проходит через egress-gateway с exact IP:443 и TLS hostname;
rootfs read-only, пользователь non-root, capabilities отсутствуют, а лимиты
disk/RAM/CPU/PID/time обязательны.

App-адаптер формирует immutable policy, связывает её SHA-256 с execution id и
device/inode staging-каталога, принимает только точную attestation применённой
изоляции и требует уничтожения sandbox до ответа. Identity staging повторно
проверяется после запуска. Затем дерево проходит confinement scan и использует
общие atomic publish и quarantine create-пути. Без доверенного supervisor и
egress-gateway clone выключен.

Текущая неактивированная production-реализация использует два закреплённых по
digest образа и доверенный Node supervisor. Worker подключён только к
`ipvlan --internal` без parent-интерфейса; двухсетевой gateway имеет внешний
маршрут и принимает только HTTP CONNECT для exact TLS hostname:443, после чего
соединяется напрямую с одним из проверенных IP без DNS. Redirect и
`Proxy-Authorization` запрещены. Git запускается argv-массивом без shell,
prompt, credential helper, hooks, submodules и LFS smudge.

Host staging не монтируется в worker. Clone живёт в ограниченном `tmpfs`, а
supervisor после `ready` экспортирует только `/workspace/repo/.` в заранее
проверенный пустой staging. До старта он сверяет фактические image/user/env,
labels, network mode, read-only rootfs, capabilities, seccomp,
`no-new-privileges`, отсутствие bind mounts и точные RAM/CPU/PID/tmpfs limits.
До создания сети supervisor требует Docker Engine не ниже 29.5.2; локальный
runtime 27.4.0 и любой malformed version fail closed без мутации Docker state.
`aisy doctor` использует тот же code-owned predicate версии и digest, показывает
`warn` при disabled-by-default состоянии и high-severity `fail` для включённой,
но неготовой конфигурации. Post-upgrade gate также включает эту проверку.
OOM получает исход `quota-exceeded`; cancel и timeout используют отдельный
cleanup без отменённого signal. Attestation с `sandboxDestroyed=true` выдаётся
только после удаления worker, gateway и сети; ошибка cleanup закрывает операцию.

Контракт и supervisor покрыты 23 TypeScript-тестами вместе с sidecar transport;
gateway/worker — 8 Python-тестами. В это число входит opt-in read-only smoke,
который на реальном локальном Docker Engine 27.4.0 разрешает только запрос
server version и подтверждает отказ до любой команды создания ресурса.
Проверяются exact egress, отсутствие credentials/mount/socket/host network,
ослабленный inspect, OOM, timeout, cancel, пустой staging, export order и
fail-closed cleanup. Live-композиция и
полный Docker E2E на совместимом Engine ≥29.5.2 остаются выключены до отдельного
activation approval и restart/quota/escape/rollback gate; поэтому WP-19…WP-22
ещё не считаются полностью закрытыми.

Natural-language commands such as “работаем над X” switch before project-local
retrieval or I/O. Ambiguous targets show owner-bound choices and do not mutate
state.

## 5. Files, roots and attachments

Fresh defaults are `~/workspace` and `~/projects/<slug>`; ordinary descendants
of home are valid. A context root cannot be home itself or its ancestor, and it
must be disjoint (neither ancestor nor descendant) from `~/.aisy`, vault, inbox,
session, index, migration and staging roots.

Every file operation performs lexical registry validation and race-safe,
descriptor-relative confinement. Symlinks, magic links, mount crossings,
absolute/traversing paths and cross-project session ids fail before target I/O.
Bash is available only in a sandbox that mounts the leased root and no
home/control-plane/secret state.

Production-preview `bash` использует отдельный one-shot Docker supervisor и
immutable `TurnContextLease`. До первого Docker/filesystem I/O lease проходит
switch barrier; затем supervisor проверяет canonical identity exact root,
daemon-wide `userns`/rootless, создаёт только digest-pinned image с обязательным
`runsc`, `network=none`, read-only rootfs, non-root user, `cap-drop=ALL`,
`no-new-privileges`, builtin seccomp и лимитами RAM/CPU/PID/time/output. До
исполнения он сверяет фактический `container inspect`, затем раздельно выполняет
`start`, bounded `wait`, повторный `inspect` и только после аттестации immutable
config/final exited state читает bounded `logs`. Ненулевой exit команды берётся
из `wait` и обязан совпасть с `State.ExitCode`; вывод никогда не берётся из
`start --attach`. OOM, timeout, abort, output overflow и Docker infrastructure
error возвращаются как code-only failure. Контейнер удаляется до завершения lease operation даже при
ошибке. В контейнер монтируется только exact leased root; home, control plane,
Docker socket, credentials и сеть отсутствуют. Disk quota Project остаётся
отдельным deployment prerequisite. Этот factory пока не подключён к legacy
`aisy run` или live v2 composition.

`makeNodeProjectToolsInteractiveTurnRuntimeFactory` связывает этот supervisor,
manifest-aware attachment view и descriptor-relative file tools с одним и тем
же coordinator/lease production-preview Project runtime. Сама композиция не
обращается к Docker; первый CLI/filesystem I/O возможен только после acquire и
turn execution. Закрытый lease отклоняет повторный `bash` до Docker I/O. Factory
не меняет provider tool catalog и не активирует v2 routing.

Lease-bound `edit_file` реализован как одна descriptor-relative операция:
unique exact replacement по умолчанию, явный `replaceAll`, повторная проверка
открытого файла и directory entry перед atomic publication, сохранение обычных
mode bits и code-only ошибки без file content. Preview composition проводит
инструмент через тот же lease/switch barrier; legacy `aisy run` его не
рекламирует до v2 activation.

Incoming attachments remain in the external inbox with untrusted provenance.
Explicit import verifies owner/session/hash, resolves a code-owned relative
destination and atomically publishes the project file plus append-only manifest.
Interrupted import leaves the inbox object recoverable and publishes no partial
file.

Текущая core-реализация предоставляет project-only state machine
`makeAttachmentImportService`. Она принимает immutable `TurnContextLease`,
проверяет exact operator/profile/session и code-owned size cap, никогда не
использует `originalName` как путь и выбирает только
`imports/<fileId>`/`knowledge/imports/<fileId>`. Manifest всегда получает
`provenance=untrusted`. Один project scope сериализует операции, а WAL проходит
`PREPARED → MANIFEST_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`.
Повтор после каждого durable boundary заново проверяет actual inbox hash и
идемпотентно продолжает; inbox не удаляется.
Опубликованный manifest и установленный hash повторно проверяются перед cleanup,
поэтому один forged `AUDITED` WAL не становится authority.

Production seam `makeNodeAttachmentImportRuntime` подключает этот контракт к
защищённому Node store и одноразовому Python sidecar, не активируя v2 routing.
Inbox имеет два code-owned пространства: `records/<fileId>.json` и
`objects/<fileId>`. WAL, manifests, audit receipts и staging находятся под
`<controlRoot>/attachment-import/` с режимами `0700/0600`, bounded JSON,
create-once/CAS-shaped переходами, `fsync` файла и каталога и no-follow чтением.

Binary attachment bytes не проходят через JSON/stdout. Sidecar открывает inbox,
staging и Project roots descriptor-relative с `O_NOFOLLOW`, запрещает symlink,
hardlink, special file и mount crossing, повторно считает SHA-256 во время
streaming copy и публикует destination через no-overwrite hard-link boundary.
Детерминированный временный файл принадлежит зарезервированному namespace
`.aisy-import-<operationId>.tmp`; recovery завершает или очищает только этот
code-owned объект. Отличающийся destination возвращает collision и не
перезаписывается.

`makeManifestAwareConfinementPort` закрывает окно `FILE_INSTALLED` до
`PUBLISHED`: read/list не показывают неопубликованный import, опубликованный
файл сверяется с manifest hash/size на каждом read/list, запись в reserved import
namespace запрещена. Нефильтруемый root/import scan закрыт fail-closed до
появления descriptor-sidecar scan с manifest filter.

`makeTelegramAttachmentInbox` реализует неактивированный Telegram ingress для
document/audio/photo/video/voice/animation. Код проверяет allowlisted chat до
скачивания, снимает immutable snapshot binding и Telegram metadata, вычисляет
code-owned `tg-<sha256>` file id и provenance reference без публикации raw
Telegram file id. Binary body записывается потоково с composition-owned limit,
SHA-256, `fsync` и no-overwrite hard-link boundary; exact inbox record
публикуется только после durable object. Повтор после restart возвращает уже
проверенный object/record без повторного скачивания, а orphan object после crash
принимается только после повторного download и exact byte/hash comparison.
`makeTelegramBotApiAttachmentDownloadPort` использует фиксированный официальный
Bot API origin, запрещает redirect и server-supplied path escape, ограничивает
metadata response, применяет официальный 20 MiB ceiling
[`getFile`](https://core.telegram.org/bots/api#getfile) и редактирует ошибки.
Handler в `makeTelegramBot` зарегистрирован всегда. При наличии optional inbox
он сохраняет каждый document/audio/photo/video/voice/animation без model turn;
без dependency ничего не скачивает и возвращает явную redacted деградацию вместо
молчаливого drop. Для Telegram album первый update захватывает binding всей
группы, каждый object сохраняется сразу и последовательно, а bounded debounce
отправляет одну summary-card. Лимит Telegram — десять downloads; oversized или
частично неуспешная группа получает один redacted partial verdict. Текущая
композиция `aisy.ts` намеренно не передаёт inbox dependency до согласованной
activation.

`makeNodeAttachmentAwareInteractiveTurnRuntimeFactory` подключает
`import_attachment` к точному turn lease в preview/v2 composition и одновременно
заменяет обычный confinement на manifest-aware wrapper. Инструмент принимает
только `fileId` и code-owned destination `project-file|knowledge`, не возвращает
модели untrusted `originalName` или внутреннюю ошибку sidecar, а выдаёт только
проверенные path/hash/size/provenance/publication metadata. После restart тот же
вызов идемпотентно получает опубликованный manifest, а `read_file` видит файл
только после `PUBLISHED`.

Граница текущего инкремента: этот factory ещё не передан в `aisy run`,
process-wide singleton writer не принят отдельным ADR, collision-choice UI
отсутствует, а kill -9/disk-full/real mount fixtures остаются до live activation.
WP-23/24 имеют реальный Node/Python restart path и неактивированные Telegram
intake + model-tool seams. Единый preview E2E теперь проходит через настоящий
grammY handler, `ProjectService`, lease-bound memory/file tools и Python sidecar:
Project A импортирует и читает вложение, Project B и Workspace не видят его и
проектную память, после restart Project A восстанавливает точную Session,
память и опубликованный файл. Это доказательство композиционного seam, но не
разрешение на переключение live `aisy run`.

Трассировка тестов: 11 core tests; 4 Node store tests; 13 Node→Python runtime
integration tests, включая восемь durable crash points, binary/no-overwrite и
manifest visibility, а также exact turn-tool import/read после restart;
5 Python worker tests для descriptor/path/hash границ;
15 Node Telegram inbox tests для media parsing, exact publication, трёх crash
boundaries, immutable authority, restart/no-redownload, authz/limits,
collision/symlink и official Bot API path gate.
Дополнительно 6 grammY media transport tests доказывают live explicit degrade,
document + batched photo album под одним binding, single summary, partial failure,
десятиэлементный download cap и redacted failure.

### 5.1. Управление контекстом в Telegram

`makeTelegramProjectControls` является code-owned адаптером одного
`ProjectService` для inline-кнопок и высокочастотных русских/английских команд.
Callback содержит только непрозрачный короткоживущий process-epoch token;
target, owner и ожидаемое поколение остаются во внутреннем pending map. Любой
новый render инвалидирует прежнюю карточку, restart меняет epoch, а успешный tap
удаляет token до выдачи одноразового `SwitchAuthorityReceipt`. Lifetime-set не
разрешает повторно выдать retired token; bounded token space исчерпывается
fail-closed и требует restart вместо ABA-reuse.

Текстовый pre-router вызывается только после `Gateway.onUpdate` и дополнительно
проверяет exact `telegram:<chatId>` owner. Receipt-bound source hash включает
`chatId`, `updateId`, SHA-256 нормализованного сообщения, target и generation.
Поддержаны точные формы `работаем над`, `переключись на`, `выбери проект`,
`work on`, `switch to` и `select project`; обычный текст не перехватывается.
Exact name/slug разрешается по registry. Несколько совпадений возвращают
owner-bound inline choices и не меняют selection; неизвестная цель задаёт один
фокусированный вопрос без model turn и filesystem I/O.

Menu, русская и английская ветви вызывают один `ProjectService`, поэтому
публикуют одинаковую persisted selection и получают следующий immutable lease.
Allowlist middleware отбрасывает foreign chat до adapter/API mutation;
stale/replayed/wrong-generation callback не может выдать или потребить
действительный receipt. Inline keyboard не содержит пустой последней строки.

Трассировка: 9 unit-тестов контроллера, 4 transport-теста grammY и один единый
двухпроектный Telegram restart E2E; полный app regression содержит 261 test,
workspace typecheck/build зелёные. Они покрывают WP-34…WP-37 на
неактивированном production seam. Перед live cutover всё ещё обязательны
composition wiring в `aisy.ts`, migration/rollback gate и отдельное согласование
оператора.

## 6. Memory and file placement

The model selects a semantic category; code selects the physical destination.
Global facts/preferences/goals/learned patterns route to Workspace. Project
notes, knowledge, tasks, skills and current task route only to the active
project. Cross-project promotion is explicit.

Readable live facts are canonical files under the owning memory tree.
`constitution.md` remains human/operator-only and cannot be mutated by model or
profile tools. `MEMORY.md` is a deterministic generated prefix/index capped at
10 KiB with an 8 KiB consolidation warning. A protected, backup-verified
ledger database preserves tombstones, relationships and the hash-chained forget
ledger; physically separate FTS/vector/cache databases are disposable and may
be rebuilt only while that ledger verifies. Ledger corruption fails closed and
is restored from verified backup, never inferred from live files. Memory and
attachment multi-resource writes use scope-exclusive WAL state machines;
readers expose only published rows whose file/hash agrees, and recovery runs
before serving the scope. Every commit, rebuild, snapshot and lazy load applies
the same forgetting invariant.

Retrieval implements ADR-0065's three modes: always-available scoped FTS5/BM25
keyword search; semantic cosine/KNN over local sqlite-vec indexes using a pinned
OpenRouter embedding adapter; and hybrid search with per-leg cap 20, RRF
`k=60` and the normative stable tie-break order. Query plus selected chunks
are disclosed before provider opt-in. Cache/index metadata keys provider, model id,
model revision, dimensions, normalization/chunker version and content hash;
changing any field rebuilds only its scope. Provider failure visibly degrades
to keyword; revocation blocks calls and purges provider-scoped derived data.
Workspace, each Project and monitoring remain separate vector scopes.
Deterministic secret scanning prevents matching paths, chunks and queries from
leaving the host; arbitrary project source indexing requires explicit opt-in.

## 7. Durable jobs and autonomy

Every goal, trigger, monitor, digest, subagent, grant and current-task record
has a non-null Workspace/Project/Session binding. It reacquires that binding
after restart and never follows the interactive selection. Archiving pauses
bound jobs and disables bound grants until restore.

Legacy records tied to a legacy session bind to its migrated Project. Unscoped
legacy work is quarantined paused; unscoped grants are disabled pending explicit
operator assignment.

## 8. Migration and rollback

V1 migration never declares the legacy default root to be global Workspace,
because live v1 derived it from `AISY_WORKSPACE ?? process.cwd()`. All v1 rows
become legacy Projects with ids/roots/sessions/selection preserved. A separate
Workspace is created at the explicit v2 global root.

Migration runs under an exclusive maintenance lock and durable phase manifest.
It copies the full memory ledger losslessly and preserves the legacy event log
byte-for-byte, but marks legacy sessions `metadata-only` because missing
conversation content cannot be reconstructed. New v2 sessions use the
full-fidelity hash-chained envelope of ADR-0064. After validation it writes
`V2_WRITES_ENABLED` durably before releasing any write gate; automatic rollback
is forbidden from that point. Earlier phases restore exact backups and only
manifest-created artifacts. Crashes must leave exactly one schema authoritative.

Текущий read-only readiness gate не умеет менять phase и всегда возвращает
`activationRequiresApproval=true`. Он отдельно проверяет registry/memory
bundle evidence, пять live-runtime поверхностей (registry, scoped memory,
layered context, transcript, confinement), доступность exclusive lock,
проверенный backup и rollback rehearsal. До `V2_WRITES_ENABLED` результат
может быть только `ready-for-approval`/`committed-awaiting-enable` с
`rollback-or-resume`; после включения writes автоматический rollback
детерминированно запрещён и остаётся только `active-forward-repair`.
Незавершённые `PREPARED/COPIED`, tamper или missing runtime evidence дают
fail-closed verdict. `aisy doctor` принимает этот probe read-only и включает
его в `--post-upgrade`; отсутствие подготовленной миграции остаётся warning,
поскольку v1 всё ещё authoritative. Read-only инспекторы уже перепроверяют
registry manifest и byte-exact backup/candidate. В `VERIFIED` live registry
обязан совпадать с v1 backup, в `COMMITTED` — с cutover candidate; после
`V2_WRITES_ENABLED` live bytes уже изменяемы и проверяются отдельной runtime
поверхностью, а не сравнением с историческим candidate. Memory inspector
заново строит план из legacy SQLite и проверяет manifest, source hash, все
artifact hash/size, ledger schema, forget-chain и опубликованные fact files.
Ошибка или подмена превращается
только в fail-closed evidence без внутренних путей. Проверка остаётся
advisory: она не берёт lock и не может быть authority для cutover; activation
обязана повторить её под exclusive lock. Persisted rollback rehearsal,
production doctor wiring и activation receipt/cutover API остаются следующим
неактивированным шагом.

Production composition также обязана иметь один durable migration authority.
Существующие registry и memory manifests пока независимы: совпадение их phase
не доказывает, что bundles созданы одной операцией и для одного source state.
До live doctor wiring нужно либо включить memory artifacts в общий Workspace v2
manifest, либо связать оба manifest через отдельный checksummed receipt с exact
`migrationId`/digest. Простое сканирование каталога и выбор «последнего» memory
manifest запрещено как неоднозначное.

## 9. Failure and degraded modes

| Failure | Behaviour |
|---|---|
| Registry absent | create Workspace/session idempotently |
| Registry v1 | exclusive, journalled v1→v2 migration |
| Registry corrupt | fail closed; doctor offers evidence-backed recovery |
| Workspace identity unavailable | block agent turns; keep diagnostics/menu |
| Project root unavailable | block its file/memory jobs; never substitute another root |
| Project index unavailable | global-only automatic recall with warning; never substitute another project |
| Embedding provider unavailable | semantic reports unavailable; hybrid visibly degrades to keyword |
| Sandbox unavailable | disable bash; keep confined file tools |
| Active archive | atomically select Workspace/replacement session and increment generation; no archived selection persists |
| Stale lease/callback | reject before I/O and redraw current state |
| Clone/import interrupted | no registry/file/manifest publication; preserve recovery object |

## 10. Normative acceptance criteria

The individual `WP-01` through `WP-41` checks in the normative design are
mandatory and cannot be replaced by a narrower group-level test. They map to
this component contract as follows:

1. **AC-17-1 — registry and lossless migration:** WP-01…WP-07.
2. **AC-17-2 — context/session isolation and frozen resume:** WP-08…WP-15.
3. **AC-17-3 — confined files, create/clone and attachments:** WP-16…WP-24.
4. **AC-17-4 — memory routing and hybrid/all-project retrieval:** WP-25…WP-33.
5. **AC-17-5 — Telegram and natural-language parity:** WP-34…WP-37.
6. **AC-17-6 — durable runtime ownership and audit:** WP-38…WP-41.
7. **AC-17-7 — read-only migration readiness:** registry inspector проверяет
   phase-dependent live bytes до writes-enable и exact backup/candidate без
   lock/write; после writes-enable mutable live registry проверяется отдельной
   runtime-поверхностью. Memory inspector заново доказывает
   source/manifest/artifact/ledger/fact
   эквивалентность. Tamper и corrupt manifest дают fail-closed evidence, а
   успешный advisory verdict всё равно требует повторной проверки под lock и
   явного approval перед activation.
8. **AC-17-8 — единая authority миграции:** readiness не может стать
   `ready-for-approval`, пока registry и memory evidence не связаны одним
   durable migration id/digest. Несколько несвязанных или неоднозначных
   manifests дают fail-closed verdict; выбор по mtime/имени запрещён.
9. **AC-17-9 — Project maintenance isolation:** exact Project maintenance lease
   дренирует активные leases и блокирует новые leases только этого Project;
   активный Workspace/другой Project не блокируется, а release восстанавливает
   обычное получение leases.
10. **AC-17-10 — maintenance authority:** Workspace binding, stale/forged lease
    и wrong role отклоняются code-only; ни registry enumeration, ни mutable
    interactive selection не создают неявной authority на обслуживание Project.
11. **AC-17-11 — durable lifecycle authority:** archive receipt имеет отдельные
    purpose/HMAC-domain и nonce store, exact binding на полный lifecycle intent,
    TTL и one-use. Wrong action/Project/Session/generation/message hash,
    tamper, expiry, replay после restart, лишние поля и switch receipt
    отклоняются до lease drain и registry mutation. Создание preview runtime не
    регистрирует Telegram-команды и не выполняет live-активацию.
12. **AC-17-12 — двухшаговый preview archive:** exact RU/EN-команда до
    `confirm` не выпускает lifecycle receipt и не меняет registry. Confirm
    повторно доказывает operator/chat, глобально одноразовый `update_id`, TTL,
    provenance исходной команды и callback, target identity и generation.
    Cancel, expiry, replay, malformed/foreign callback, неоднозначный target,
    identity/generation drift и внутренняя ошибка завершаются без archive и без
    утечки деталей; preview controls не являются live wiring.
13. **AC-17-13 — неактивированный транспортный seam Telegram:** только прошедший Gateway
    текст маршрутизируется lifecycle → Session → Project до coalescing и
    получения turn runtime; lifecycle callback использует отдельный точный
    namespace и сохраняет exact chat/update provenance. Обработанный исход даёт
    нулевые runtime/model I/O, а terminal edit имеет fallback тем же безопасным
    обычным reply. Ошибки редактируются, а отсутствие необязательных зависимостей сохраняет прежний
    путь. Production `aisy.ts` seam не активирует.

Трассировка AC-17-12: `packages/app/src/telegram-project-lifecycle-controls.spec.ts`.

Трассировка AC-17-13:
`packages/app/src/bot-project-lifecycle-controls.spec.ts` и
`packages/app/src/bot-session-controls.spec.ts`.

Release evidence must include unit/integration suites, adversarial confinement
and clone tests, crash-at-every-migration-phase fixtures, and a two-project
Telegram E2E trace proving switch, session resume, attachment import and
negative recall isolation.

## 11. Delivery slices

1. Registry v2, selection generation, project lifecycle and migration lock.
2. Project service, staged create/register/clone and doctor recovery.
3. Immutable leases and removal of startup-root/chat-id fallbacks.
4. Layered global/project memory, frozen session manifests, OpenRouter
   embeddings, scoped sqlite-vec/cache/RRF and explicit all-project search.
5. Race-safe confinement, root-only sandbox and attachment import.
6. Durable job/grant bindings and archived-context lifecycle.
7. Explicit per-Project maintenance leases for bounded background processing.
8. Telegram/NL controls, switch barrier and full E2E evidence.

## 12. References

- [Approved architecture](../superpowers/specs/2026-07-26-workspace-project-context-design.md)
- [ADR-0060](../decisions/2026-07-26-project-scoped-sessions-file-ownership.md)
- [ADR-0063](../decisions/2026-07-26-layered-workspace-project-memory.md)
- [ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)
- [ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)
- [ADR-0040](../decisions/2026-06-13-context-engine-compaction-as-view.md)
- [ADR-0064](../decisions/2026-07-26-full-fidelity-session-transcript.md)
- [ADR-0065](../decisions/2026-07-26-hybrid-vector-keyword-retrieval.md)

## Live-композиция реестра

`aisy run` знает только реестр v2 — v1-пути в live-композиции нет вовсе.
Первый запуск публикует свежее v2-состояние; миграционный gate из стартового пути
убран, потому что мигрировать нечего. Legacy-файл `projects.json`, если он есть,
остаётся на диске нетронутым и никогда не читается live-путём. Повреждённый
v2-реестр закрывает live writes и отправляет к `aisy doctor`, а не пытается быть
частично прочитанным.

Миграционный слой v1→v2 (подготовка, cohort binding, репетиция отката, activation
authority, cutover) остаётся в кодовой базе как отдельный инструмент для
установок, где v1-данные нужно перенести, но в старте продукта не участвует.

Композиция обращается к реестру через узкую поверхность
`LiveProjectRegistryView` (активный selection, snapshot и создание сессии).
`isDefault` выводится из v2-поля `kind === 'workspace'` и не хранится вторым
источником истины; snapshot отдаёт защитные копии, поэтому мутация результата не
меняет реестр.

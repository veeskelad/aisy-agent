# Компонент 19: Долговечные checkpoint’ы субагентов

**Статус:** Supervised LIVE в `master` и развёрнут на целевом хосте: invocation, child
runtime, Journal V2, operation-control, provider/tool receipts, registry
retirement, private exact parent continuation, durable retry/cancel actor,
Telegram callback, startup exact-span replay, durable `/stop`, durable reply
release и общий process crash corpus подключены. Локальный regression,
merge/deploy и process-level recovery пройдены; ordinary Telegram delegation,
ambiguity и `/stop` остаются gate финальной операторской приёмки.
**Связанные ADR:** ADR-0039, ADR-0052, ADR-0060, ADR-0069, ADR-0071
**Зависит от:** Orchestration (11), Safety (05), Projects/Sessions (17),
Observability (12)

## 1. Назначение

Компонент сохраняет состояние каждой делегации так, чтобы после аварийного
завершения процесса Aisy продолжил тот же subagent shard без потери audit trail,
подмены контекста или сброса общего бюджета. Восстановление выполняется до выдачи
`DelegationHandle`, а значит до любого model/tool I/O.

Production-контракт охватывает не только child checkpoint, но и весь
верхнеуровневый execution: exact Telegram session/turn, ожидание решения,
execution actor, `/stop`, Telegram delivery и recovery делегаций. На одну
установку допускается ровно один активный верхнеуровневый execution; внутри него
write-disjoint child могут выполняться параллельно до code-owned ceiling.

Однозначно завершённые операции воспроизводятся из receipt без повторного
внешнего вызова. Если crash оставил доказательство начала, но не завершения
provider/tool effect, компонент фиксирует ambiguity и ждёт точного решения
оператора вместо автоматического retry.

## 2. Неизменяемые данные делегации

Checkpoint содержит и при resume повторно проверяет:

- exact identity верхнеуровневого execution:
  `ResolvedWorkBinding + sessionId + turnId` и genuine tool-call position;
- exact `ResolvedWorkBinding` родительского Workspace/Project/Session;
- исходный `DelegationTask`, включая scope, budget slice и retry policy;
- полную разрешённую `AgentCard`, `name@revision`, hash и вычисленные
  tools/Skills/MCP;
- hash-chained shard с монотонным `seq` и `prevHash`;
- `snapshotPrefixHash` и `lastSeq` checkpoint’а;
- run-level budget в канонических целых наносах USD, а также множества
  active/terminal task IDs DAG;
- operation records с exact key, request/authority hashes, policy revision,
  состояниями `prepared|settled|ambiguous` и code-owned receipts;
- durable approval record: exact nonce, action hash, operator/chat,
  binding/session/turn, run/delegation/task/operation key, Agent Card
  revision/hash, decision, actor claim и stop state;
- compact terminal `TaskObservation` для `completed`/`failed`, достаточный для
  повторной выдачи результата родителю без child transcript и нового списания
  бюджета.

Изменение binding, session/turn, task, AgentCard, capability set, scope, policy,
operation request, shard или checkpoint не считается миграцией. Запись
переводится в карантин либо стабильный fail-closed refusal, а resume завершается
до provider/tool I/O.

## 3. Дисковый формат

Node adapter использует layout ADR-0039:

```text
.aisy/runs/<runId>/
├── run-state.json                # общий budget и active/terminal sets DAG
└── delegations/
    ├── <delegationId>.jsonl
    └── <delegationId>/
        ├── checkpoint.json
        ├── manifest.json
        └── quarantine.json       # появляется только при отказе проверки
```

Логическая запись имеет `schemaVersion: 1`. Каждая стоимость до terminal
transition округляется decimal half-up до `10^-9 USD`; run ledger складывает
только полученные целые nanos и публикует обратно каноническое число USD.
Неканонический или небезопасный старый ledger не мигрирует автоматически:
recovery останавливается fail-closed до выдачи handle и внешнего I/O.

Shard и checkpoint публикуются через
exclusive temp → `fsync(file)` → atomic rename → `fsync(directory)` с mode
`0600`; каталоги создаются с mode `0700`. Manifest записывается последним и
содержит SHA-256 обоих файлов. Общий бюджет не копируется из потенциально
устаревшей child-записи: он читается из отдельного атомарного `run-state.json`.
Сбой между rename создаёт torn/inconsistent snapshot, который
не проходит проверку и не возобновляется. Исходные файлы при карантине не
удаляются, поэтому возможен ручной post-mortem и rollback.

JSON-файлы ограничены одним MiB, shard — 32 MiB, а сериализуемое значение —
глубиной 128 уровней; превышение блокируется до хеширования/публикации. DAG
ограничен 256 задачами, 2048 рёбрами и 64 зависимостями на задачу. Эти значения
принадлежат storage/runtime adapter и не расширяют iteration/spend budgets
субагента.

Node adapter принимает только canonical private directory: symlink/non-directory,
чужой owner и group/world permissions отклоняются. Файлы открываются с
`O_NOFOLLOW`, проверяются через descriptor как private regular file с одним hard
link. На время recovery → execution → terminal commit runtime удерживает
exclusive `.runtime.lock`; stale lock автоматически не крадётся.

### 3.1. Приватное продолжение родительского хода

До первого provider/tool I/O родитель фиксирует отдельный bounded continuation:
exact `ResolvedWorkBinding`, `sessionId`, `turnId`, `turnTs`, supervisor binding,
policy revision и уже собранные входные spans вместе с memory/language context.
Raw spans остаются только в private-файле `0600`, не входят в execution-card,
actor record или observability. Суммарный текст ограничен 96 KiB, весь файл —
128 KiB, количество spans — 128.

Запись имеет собственные domain-separated continuation hash и checksum,
публикуется через `fsync(file) → atomic rename → fsync(directory)` и допускает
только один active turn. Повтор считается replay только при полном совпадении
identity и spans; другой turn получает bounded busy. Terminal transition требует
exact owner/revision/hash CAS и receipt. Symlink, hardlink, чужой owner,
неприватные permissions, замена каталога и checksum drift закрывают чтение и
новый admission.

Non-recoverable ошибка обычного provider-turn закрывает его active continuation
до release supervisor lease, если actor отсутствует и exact registry пуст.
Crash между capture и этим закрытием не создаёт бесконечный recovery-loop:
следующий fresh turn под genuine held lease может CAS-закрыть только такую же
non-ambiguous orphan-запись и повторить admission. Наличие ambiguity, actor или
любого exact durable run запрещает автоматическое закрытие; payload и текст
диалога не входят в terminal receipt или observability.

### 3.2. Журнал внешних операций

Provider и tool не вызываются напрямую из восстановленного child state. Каждый
effect сначала получает operation key, вычисленный кодом из run/binding,
delegation/task, фазы, ordinal, canonical request hash, sealed authority hash и
policy revision. Ни plan, ни model arguments не выбирают ключ или путь файла.

Запись проходит фазы:

```text
prepared -> settled -> verified/terminal
    |
    +---- crash без settled -> ambiguous -> retry-once | cancel
```

- `prepared` fsync-ится до внешнего I/O и содержит только bounded private
  request evidence и budget reservation;
- `settled` атомарно связывает bounded private result с code-owned receipt,
  cumulative cost и effect evidence;
- settled replay читает сохранённый result/receipt и не вызывает внешний port;
- `prepared` без `settled` после crash никогда не становится автоматическим
  retry;
- unresolved/ambiguous operation не может пройти verifier или terminal commit.

Provider/read-only operation получает `retry-once`; mutation tool получает
`new-task-only` до первого dispatch из code-owned каталога effect. Для
`new-task-only` recovery не запрашивает retry authority и возвращает
`DELEGATION_MANUAL_RECOVERY_REQUIRED`: повтор возможен только как новая явная
задача с новым step-up, binding и budget admission.

Общий observability log получает только IDs/hashes, phase, policy revision,
status и bounded cost counters. Raw prompt, command, path, arguments, provider
body, tool result и credentials остаются в private run root и не попадают в
карточки или общие события.

Стоимость считается только по settled receipts и conservative holds:

```text
settled cost + held ambiguous maxima + retry reservation <= task slice
```

После task slice применяются run/global/daily budgets. Approval не повышает ни
один потолок.

## 4. Жизненный цикл

Checkpoint создаётся при `spawn()` и обновляется после каждого shard append.
`fail()` и `complete()` сохраняют status, budget, terminal sets и terminal
`TaskObservation`. После restart runtime сначала проверяет один immutable run
snapshot и весь exact active set. Terminal records проходят Core recovery до
выдачи active handles; затем один `recoverActive(exactIds)` атомарно выдаёт всю
группу либо не выдаёт ни одного handle. Отдельный `recover(delegationId)`
сохраняется как совместимый узкий API и при первом cold access также
гидратирует всех active siblings.

Recovery:

1. загружает versioned snapshot;
2. проверяет file digests, shard chain и checkpoint head;
3. сравнивает binding/task/card/capabilities с текущей code-owned authority;
4. спрашивает lifecycle resolver, активен ли сохранённый binding;
5. восстанавливает shard и общий бюджет;
6. для terminal-записи возвращает defensive copy сохранённого observation без
   изменения состояния и повторного списания бюджета;
7. для прерванной active-группы возвращает handles только после полной проверки
   всех siblings; отдельный ручной `resume()` failed-задачи остаётся явной
   операцией, предварительно восстанавливает полный active set и не выполняется
   startup recovery автоматически.

Production-preview runtime требует явную policy
`resume-active-replay-terminal` и выполняет recovery до spawn новых задач. Перед
первым child I/O task ID записывается в run-level active set. Если такой ID есть
в ledger, но его child snapshot отсутствует или противоречит состоянию run,
recovery останавливается fail-closed и не перезапускает child. Перед первым
resumed I/O и после каждого resumed terminal runtime проверяет точное совпадение
трёх представлений стоимости: суммы terminal observations, manager ledger и
актуального persisted ledger. Iterations/wall складываются как safe integers,
а USD — только через общий Core-конвертер в наносы; расхождение в любую сторону
даёт recovery denial. Перед
terminal commit он сохраняет в shard ограниченный `runtime.verified-result` или
стабильный code-only отказ. Поэтому crash между проверкой результата и
`complete()` восстанавливается без повторного child/verifier I/O. Только
parent-owned verifier формирует `summary`/`result`, доступные родителю; raw
candidate остаётся внутри child boundary. Child handle не содержит `complete()`
и `fail()`, не может записывать зарезервированные `runtime.*` entries, а после
возврата candidate его append/tool capability отзывается. Terminal transition
одноразовый; старый handle после terminal/resume не может дописать shard или
повторно начислить стоимость.

Child и verifier возвращают cancellable operation. `CANCELLED` фиксируется только
после успешного `cancel()`-ack, который обязан означать фактические interrupt/
kill и wait/inspect внешнего эффекта; без ack shard остаётся non-terminal и
runtime возвращает `DELEGATION_CANCELLATION_UNCONFIRMED`. Стоимость child и
verifier берётся не из model candidate, а из обязательного code-owned cumulative
meter. Каждое показание meter канонизируется тем же Core-конвертером до budget и
monotonicity checks; значения в одном nano считаются равными, а реальное
уменьшение хотя бы на один nano закрывается как meter failure.
Invalid/over-budget result сохраняет каноническую фактически измеренную
стоимость и не передаётся verifier/родителю.

Смена текущего interactive selection не перенаправляет делегацию Project A в
Project B. Если Project/Session A архивирован, lifecycle resolver закрывает
resume. Legacy/unbound, повреждённые и уже quarantined записи не получают
fallback в Workspace/global scope.

### 4.1. Global-one-active execution

Обычный turn, durable pause, callback, execution actor и `/stop` используют
один глобальный durable execution lease. Lease хранит exact
`ResolvedWorkBinding + sessionId + turnId` и проходит состояния:

```text
idle -> running -> paused-awaiting-approval -> resume-ready -> running -> terminal
                  \___________________________/          |
                              |                          |
                              +------> cancelling <------+
```

В `running|paused-awaiting-approval|resume-ready|cancelling` сообщение из любой
session не создаёт второй верхнеуровневый turn. Gateway отвечает bounded
busy-статусом без текста текущей задачи. Это ограничение не отключает bounded
parallel child scheduler: независимые child одного current turn продолжают
работать параллельно, а пересекающиеся scopes сериализуются.

### 4.2. Durable approval и execution actor

При ambiguity controller выполняет следующий протокол:

1. до отправки карточки сохраняет `paused-awaiting-approval`, exact nonce,
   action hash, допустимые решения и все authority bindings из §2;
2. публикует только варианты `retry-once` и `cancel`; `session`, `always` и
   похожие grants запрещены (`canRememberSimilar=false`);
3. callback проверяет operator/chat/action/nonce и одной транзакцией записывает
   decision + `resume-ready`; callback не вызывает provider/tool;
4. supervisor-owned execution actor под parent recovery lease атомарно claims
   решение и непосредственно перед новым `prepared` повторно проверяет binding,
   Agent Card, capability matrix, policy и budgets;
5. повторная доставка callback возвращает уже сохранённый ответ и не создаёт
   второго consume или dispatch;
6. crash после решения, actor claim или до нового `prepared` продолжает тот же
   exact turn и использует то же решение; crash после нового dispatch создаёт
   новую ambiguity и требует новый nonce.

Неоднозначный Tier-3 effect нельзя повторить внутри прежнего run. Controller
фиксирует `MANUAL_RECOVERY_REQUIRED`; новая попытка возможна только как новая
явная задача с обычным step-up.

`/stop` одной durable CAS-операцией конкурирует с callback и actor claim,
переводит execution в `cancelling` и инвалидирует pending nonce/card. Проигравший
callback/actor не выполняет I/O. `CANCELLED` публикуется только после
подтверждённого прекращения owned effect; иначе сохраняется recoverable
ambiguity, а не ложный terminal.

### 4.3. Единый startup recovery envelope

Recovery разрешён только supervised composition. Startup coordinator:

1. удерживает manager lease ADR-0071;
2. до чтения/repair run state получает runtime-liveness fence и доказывает
   отсутствие прежнего runtime;
3. после protocol-v2 hello/capture выдаёт replacement child одноразовый parent
   recovery lease, связанный с exact binding/session/turn;
4. не отпускает lease между восстановлением Telegram delivery, approval/stop
   state и delegation DAG;
5. открывает admission нового turn только когда весь envelope пришёл к
   согласованному terminal/no-state состоянию; corrupt, foreign или incomplete
   cross-subsystem state остаётся fail-closed.

Direct `aisy run` не получает этот lease и поэтому не сканирует, не читает
payload, не repair’ит и не восстанавливает durable delegation. Допускается
единственное legacy read-only execution-card refusal exception: direct может
прочитать минимальные метаданные старой карточки, чтобы вернуть стабильный отказ
и подсказать supervised запуск. Эта проверка не читает delegation payload, не
изменяет state и не выдаёт approval/actor/continuation authority.

## 5. Границы текущего инкремента

Supervised Telegram turn теперь передаёт genuine per-turn supervisor lease в
production importer. `spawn_subagent` в этом turn использует opaque durable run
root, exact immutable depth-1 authority, bounded scheduler, Journal V2 и
operation-control. Provider/tool ports публикуют code-owned receipts; terminal
replay той же parent tool position не создаёт второго provider effect или
списания. Direct `aisy run` сохраняет прежний ephemeral rollback и не читает
durable runs.

Финальный supervised Telegram-ответ сначала публикует private reply checkpoint,
повторно подтверждает exact terminal delivery через read-only inspection, затем
выполняет `releaseDurably` и передаёт receipt обратно supervisor. Crash между
release и consume восстанавливается из exact private reply evidence до внешнего
startup I/O. При attempted/uncertain Telegram write нет blind fallback-send.

Это ещё не целевой production cutover. Активный child run после process crash
pure-валидируется, stale lock снимается только под genuine recovery context, а
checkpoint-bound lease и прежний owner передаются повторно доставленному
Telegram turn. Terminal run удаляется из bounded registry только после
успешного replay; private run evidence остаётся для idempotent повторения.
До provider I/O Telegram теперь сохраняет private exact parent spans; ambiguity
останавливает Core как genuine control-flow interruption, а не превращается в
текст tool-result. Retry/cancel card записывает callback без provider/tool I/O,
planned restart восстанавливает exact spans без нового recall/voice ingress,
actor claim после crash проходит exact journal reconciliation. Scheduler,
goals и forward recovery не стартуют, пока foreground envelope ждёт решения.
После durable Telegram release continuation получает terminal receipt до
consume supervisor receipt. `/stop` активного handler по-прежнему начинает с
`AbortController`, а paused/resume actor использует общий durable CAS:
`paused|resume-ready → cancelling(receipt) → actor terminal → parent terminal →
exact registry retire`. Receipt принимается только для exact ambiguous journal
slot при свободном transient run lock и held supervisor lease. Crash между
этими шагами повторяет переход, не оживляет nonce и не публикует ложный
`CANCELLED`. Общий real-process corpus покрывает pause до delivery, delivered
card, callback, claim, applied resolution, stop до callback, после callback,
после claim и после actor cancellation terminal.

Genuine позиция `{sessionId, turnId, ordinal}` считается кодом по всем
запрошенным моделью tool calls, включая отклонённые. Process-local authority
действительна только для exact `spawn_subagent`; structural copy, чужой tool
context и model arguments её не подтверждают. Invocation binding преобразует
`binding + sessionId + turnId + ordinal` в opaque SHA-256 run root с domain
separator. Изменённый plan/task/card на прежнем root отклоняется до child I/O.

В отдельных dormant-срезах уже реализованы:

- bounded inventory/expected sequence operation slots с V1/V2 barrier;
- conservative budget holds, attempt/resolution и одноразовая
  `retry-once|cancel` authority поверх ambiguity;
- additive V2 adapter, который связывает exact Journal V2 attempt с
  operation-control, требует code-owned maximum quote до `start`, reconciles
  settled receipt после crash и не принимает `retry-once` для mutation;
- durable `paused-awaiting-approval → resume-ready → cancelling|terminal`
  actor с exact callback/step-up/cancellation authority; production подключает
  retry/cancel, crash-after-claim reconciliation и `/stop` quiescence receipt;
- genuine supervisor recovery lease и dormant coordinator с фиксированным
  порядком `Telegram → approval/stop → delegation`: Telegram и actor уже имеют
  конкретные adapters, release выполняется только после clean-прохода всех
  трёх шагов, continuation сохраняет тот же lease до полной повторной сверки;
- recovery context имеет process-local provenance: structural copy или
  самостоятельно собранный `{isHeld: () => true}` отклоняются до чтения state;
- Core recovery preflight читает и проверяет весь exact run inventory, active
  siblings, terminal observations и aggregate budget без установки state,
  выдачи handle, quarantine, events или записи; production-preview runtime
  обязан пройти этот preflight до первого `recover()`/`recoverActive()`;
- App inspector переиспользует тот же raw-draft + Core preflight для одного
  уже существующего exact run root под transient run lock; missing root
  отклоняется без создания каталога, а child/verifier ports не принимаются;
- отдельный private registry хранит не более 64 code-owned exact records
  `{runId, bindingHash, binding, plan, phase}` в checksummed V1 snapshot. Он не
  сканирует run-каталоги и не восстанавливает plan из Journal V2. Invocation
  принимает binding только из genuine held IPC lease и выполняет
  `register → createRuntime → activate → execute → retire` с повторной проверкой lease на
  границах: поэтому crash в `registered` до activation считается terminal
  только при missing/empty exact root, а `active` без полного state всегда
  отклоняется;
- concrete delegation recovery port принимает только genuine context единого
  coordinator, выбирает records только по exact supervisor `bindingHash` и
  вызывает inspector без child/verifier callbacks. Для active record genuine
  context после доказанной quiescence может удалить только exact private
  O_EXCL-token `.runtime.lock`; PID и возраст файла не являются evidence,
  malformed/public/symlink target остаётся нетронутым. Любой corrupt, foreign
  или неполный active run даёт code-only denial; хотя бы один active run даёт
  continuation, а полностью terminal inventory — terminal.
- Telegram composition имеет LIVE supervised per-turn runner seam: после durable
  `prepare`, supervisor `checkpoint-bound` ACK и публикации redacted
  execution-card он принимает только genuine held IPC lease, строит runner и
  передаёт ему первый provider call. Structural copy, missing/lost authority и
  ошибка builder закрывают ход без provider и без fallback в legacy runner.
  Production composition передаёт этот seam только под genuine supervisor
  session; structural/fake lease не включает durable importer.

До production cutover осталось собрать поверх этих примитивов:

- supervisor-owned wiring approval actor и durable `/stop` к exact parent turn;
- global-one-active execution state с exact session identity;
- production capture/retire wiring уже реализованного private exact parent
  continuation к исходному Telegram handler и actor resume;
- cross-subsystem consistency rules поверх реального run inventory;
- startup action composition, которая продолжает exact parent turn до единого
  terminal reply, не отпуская recovery lease между Telegram, actor и DAG;
- повторно проверить Linux/macOS service artifacts, запускающие
  `aisy supervise` с restart/stop policy;
- общий Telegram + actor + delegation real-process corpus; child-only пять
  обязательных crash boundaries уже проходят.

Direct `aisy run` остаётся rollback-путём без delegation recovery. Явный legacy
ephemeral dispatcher может применяться только к новым direct-вызовам, не читает
и не удаляет durable runs. Legacy read-only execution-card refusal exception из
§4.3 не меняет эту границу.

LIVE/production-ready можно заявить только после service artifacts и успешного
real-process corpus: kill после `prepared`, после фактического external response,
после `settled`, verifier и terminal commit; restart должен доказать отсутствие
повторного effect/cost, безопасную ambiguity и один terminal ответ. До этого
отдельные рабочие срезы могут быть смержены только как dormant.

## 6. Критерии приёмки

1. **AC-19-1** — crash/restart продолжает shard с `lastSeq + 1` и сохраняет
   run-level budget.
2. **AC-19-2** — подмена shard payload/hash/seq или checkpoint head блокирует
   resume и создаёт recoverable quarantine marker.
3. **AC-19-3** — подмена binding, task, scope, AgentCard или capabilities
   блокирует resume до выдачи handle.
4. **AC-19-4** — выбор Project B не меняет сохранённый binding Project A.
5. **AC-19-5** — архивирование Project/Session A блокирует resume.
6. **AC-19-6** — legacy/unbound snapshot не повышается до global/Workspace.
7. **AC-19-7** — parent получает только compact `TaskObservation`; transcript
   остаётся в child shard.
8. **AC-19-8** — delegation id с path traversal отклоняется до filesystem I/O.
9. **AC-19-9** — terminal observation повторно выдаётся после restart без child
   или verifier I/O и без повторного списания run budget.
10. **AC-19-10** — crash после durable verified draft, но до `complete()`,
    завершается из shard без повторного исполнения child/verifier.
11. **AC-19-11** — cancellation сохраняет code-only terminal result; raw child
    error/result не попадает в parent observation или runtime event.
12. **AC-19-12** — не прошедший verifier или budget validation candidate
    завершается fail-closed; parent не получает raw candidate.
13. **AC-19-13** — child не имеет terminal authority и не может подделать
    зарезервированный `runtime.*` checkpoint.
14. **AC-19-14** — повторный terminal call, append старого handle и повторный
    recovery уже выданного active handle блокируются до mutation/budget charge.
15. **AC-19-15** — cancel без подтверждённой остановки не создаёт ложный
    terminal `CANCELLED`.
16. **AC-19-16** — verifier принимает только literal `verified === true`; truthy
    значения и неизвестный reason code закрываются как `VERIFICATION_FAILED`.
17. **AC-19-17** — один `runRoot` имеет ровно одного process owner; concurrent
    runtime получает стабильный lock denial до child I/O.
18. **AC-19-18** — duplicate/cyclic/colliding DAG и symlinked/public state-root
    отклоняются до recovery/spawn.
19. **AC-19-19** — отсутствие snapshot для task ID из durable active set
    останавливает recovery до child/verifier/tool I/O.
20. **AC-19-20** — чрезмерный DAG, слишком глубокое/широкое или не-JSON значение
    отклоняются до клонирования, хеширования и mutation.
21. **AC-19-21** — immutable delegation authority связывает exact
    delegation/task/child-session/binding, DNA, capability matrix, scope и
    budget; любое расхождение hash/seal/session блокируется до provider/tool I/O,
    а restart принимает только единственную первую authority seal.
22. **AC-19-22** — bounded scheduler не превышает заданный concurrency ceiling,
    сериализует пересекающиеся scopes, наблюдает cancellation между chunks и
    после restart повторяет только manager-owned terminal state; неопределённая
    persistence оставляет задачу pending и возвращает `interrupted`.
23. **AC-19-23** — executor получает immutable code-owned
    `{sessionId, turnId, ordinal}`; два запуска того же turn/tool position дают
    одинаковую позицию, новый turn отличается, отклонённый call занимает своё
    место, model arguments не могут подменить identity, а structural copy и
    authority другого tool name не проходят provenance check.
24. **AC-19-24** — genuine parent position детерминированно выбирает opaque run
    root внутри code-owned state root; replay использует тот же root, другой
    turn — другой, plan/path arguments не влияют на путь, changed semantic plan
    блокируется до child I/O, а turn cancellation достигает runtime без влияния
    на durable identity.
25. **AC-19-25** — provider/tool operation fsync’ит `prepared` до I/O;
    `settled + receipt` воспроизводится без второго внешнего вызова и расхода,
    а `prepared` без `settled` после crash становится ambiguity без авторетрая.
26. **AC-19-26** — ambiguity допускает только exact `retry-once|cancel` nonce;
    другое действие, operator/chat/session/turn/operation/card/policy drift,
    replay и scopes `session|always|similar` блокируются до I/O.
27. **AC-19-27** — pause/nonce сохраняются до card send, callback только
    durably пишет decision, actor одноразово claims его под parent lease; crash
    до/после send, tap, decision, claim и нового `prepared` не теряет решение и
    не создаёт второй consume/dispatch.
28. **AC-19-28** — `/stop` одной durable CAS выигрывает или проигрывает callback
    и actor claim, инвалидирует проигравшую карточку и не публикует `CANCELLED`
    без подтверждённого прекращения effect; restart сохраняет победившее
    состояние.
29. **AC-19-29** — на установку активен один top-level execution с exact
    binding/session/turn; сообщение из любой session не создаёт второй parent
    turn, но child одного turn достигают code-owned concurrency ceiling и
    сериализуют пересекающиеся scopes.
30. **AC-19-30** — один parent recovery lease непрерывно охватывает Telegram
    delivery, approval/stop и delegation recovery; отсутствие lease, потеря IPC,
    живой старый runtime или cross-subsystem drift дают zero repair и zero
    Telegram/provider/tool I/O.
31. **AC-19-31** — direct `aisy run` не сканирует и не восстанавливает delegation;
    legacy read-only execution-card inspection возвращает только стабильный
    refusal, не читает delegation payload, не меняет state и не выдаёт authority.
32. **AC-19-32** — production import graph включает durable adapter только под
    `aisy supervise`; Linux/macOS service artifacts и real-process kill corpus
    доказывают boundaries `prepared`/external response/`settled`/verifier/
    terminal до присвоения статуса LIVE.
33. **AC-19-33** — cold recovery pure-валидирует один run snapshot, exact полный
    active set и запрошенные terminal/failed records до выдачи authority;
    повреждение одного active sibling выдаёт zero handles/events/child I/O, а
    terminal replay завершается до единственного `recoverActive(exactIds)`.
34. **AC-19-34** — каждый charge до lifecycle transition канонизируется в целые
    USD nanos; порядок завершения не меняет ledger, overflow даёт zero mutation,
    а restart требует exact terminal aggregate = manager = persisted ledger до
    первого resumed I/O и после каждого нового terminal result.
35. **AC-19-35** — dormant provider/tool adapter воспроизводит exact
    `settled + receipt` без второго port-вызова; `prepared` без `settled`
    выдаёт genuine recoverable pause, оставляет task active и после повторного
    restart снова даёт zero provider/verifier/terminal I/O.
36. **AC-19-36** — provider operation связывается с exact provider identity,
    child session/turn и request projection; tool operation принимает только
    genuine Core context и связывает name/args/provenance/session/turn/ordinal.
    Стоимость берётся только из отдельного port receipt, а mutation без
    `actionStatus=verified` и evidence не достигает verifier.
37. **AC-19-37** — invocation публикует bounded checksummed exact-run record до
    создания runtime и активирует его до `execute`, принимая binding только из
    genuine held IPC lease и перепроверяя его на каждой границе; registry не
    сканирует каталоги и не выводит plan из Journal. Genuine startup context
    читает только records своего binding: `registered` missing/empty безопасно
    terminal, `registered` с child state и `active` без state отклоняются,
    active exact continuation удерживает общий parent lease.
38. **AC-19-38** — после реального `SIGKILL` lock-holder genuine startup context
    удаляет только exact private single-link `.runtime.lock` active run и
    продолжает recovery; PID/mtime не участвуют в решении, structural context,
    malformed token, public file, symlink, inode drift или потеря authority дают
    zero unauthorized unlink и code-only denial.
39. **AC-19-39** — supervised Telegram turn строит runner только после
    checkpoint-bound ACK из genuine held IPC lease; structural copy и потеря
    lease до provider дают zero builder/provider fallback, а legacy runner не
    вызывается. Без явного production builder прежний путь не меняется.
40. **AC-19-40** — replacement runtime при exact active delegation принимает
    прежние Telegram checkpoint owner/revision/message и checkpoint-bound
    recovery lease без второго `begin`/bind ACK; boot update-check остаётся
    закрыт до handoff. Mismatch, второй claim или terminal checkpoint дают
    fail-closed без fresh-turn fallback.
41. **AC-19-41** — `/stop` после завершения Telegram handler сначала выигрывает
    actor cancellation CAS, затем под global recovery lease и exact run lock
    доказывает отсутствие выполняющегося effect, сохраняет domain-separated
    quiescence receipt в private parent continuation и только после этого
    публикует terminal cancellation.
42. **AC-19-42** — crash после actor cancel, после сохранения quiescence receipt,
    после actor terminal или до registry retirement продолжает ту же cancellation
    без второго callback/provider/tool I/O; exact run retirement идемпотентен, а
    отсутствие или drift receipt блокирует ложное сообщение об остановке.
43. **AC-19-43** — общий real-process corpus с genuine supervisor lease проходит
    девять границ card/callback/claim/applied-resolution/stop, включая
    `SIGSTOP`/`SIGKILL`, без blind retry, позднего I/O и второй доставки callback.
44. **AC-19-44** — non-recoverable provider failure при active continuation без
    actor/ambiguity/exact run публикует terminal receipt до release lease, а
    fresh admission после crash CAS-закрывает доказанную orphan-запись и
    запускает следующий turn. `paused|cancelling`, ambiguity, actor/run или
    отказ runtime-proof сохраняют busy/fail-closed без второго provider/tool I/O.

## 7. Трассировка тестов нового additive-контракта

- `runtime/agent-capabilities.spec.ts`: AC-19-21, deterministic authority hashes
  и отказ при identity/capability/budget drift;
- `runtime/sub-agent-runner.spec.ts`: AC-19-21, seal-before-provider, exact
  restart seal, session routing, off-card/do-not-touch/spend denial;
- `runtime/delegation-driver.spec.ts`: AC-19-22, concurrency ceiling, write-scope
  serialization, cancellation, code-only failure, terminal replay и uncertain
  persistence.
- `agent-loop/agent-loop.spec.ts`, `runtime/execute-tool.spec.ts`: AC-19-23,
  стабильная позиция при replay, ordinal после deny и отдельная передача
  identity в `spawn_subagent`.
- `durable-delegation-invocation.spec.ts`, `durable-delegation-runtime.spec.ts`:
  AC-19-24, opaque deterministic run root, genuine identity, cancellation и
  fail-closed plan drift до child I/O; AC-19-33…AC-19-34, exact active-set
  recovery, terminal-first authority ordering, canonical live meter и exact
  restart aggregate.
- `orchestration/orchestration.spec.ts`: AC-19-33…AC-19-34, атомарное
  восстановление нескольких active siblings, cold terminal/failed recovery,
  per-charge USD nanos, независимость от порядка и zero-mutation overflow.
- `durable-delegation-live-adapter.spec.ts` и
  `durable-delegation-production.spec.ts`,
  `durable-delegation-production.integration.spec.ts`: AC-19-35…AC-19-37,
  exact settled
  replay, genuine ambiguity pause через повторные restart, provider/tool turn
  binding, quote/hold до внешнего I/O, task budget denial с zero dispatch,
  one-shot attempt 2, receipts-only cost, mutation evidence, cancellation
  cleanup, supervised production importer и terminal replay без второго
  provider effect; real-process `SIGKILL` после `prepared`, external response,
  `settled`, verifier и terminal подтверждает ambiguity либо terminal replay с
  одним provider call.
- `durable-reply-release.spec.ts`, `telegram-reply-stream.spec.ts` и
  `bot-streaming-restart.integration.spec.ts`: private terminal delivery
  receipt, read-only release confirmation, отсутствие blind fallback и
  recovery parent receipt после crash между release/consume.
- `durable-delegation-operation-journal.spec.ts`: dormant-часть AC-19-25…26,
  bounded inventory, V1/V2 barrier, exact attempt family, corruption, fsync,
  concurrency и restart без автоматического повтора.
- `durable-delegation-operation-control.spec.ts`: dormant-часть AC-19-25…26 и
  AC-19-34, immutable sealed retry, task/run/global/daily budget holds,
  one-shot resolution authority, exact receipts и fail-closed SQLite state.
- `durable-turn-actor.spec.ts`: dormant-часть AC-19-26…28, durable pause/card,
  callback/stop/claim CAS, step-up, подтверждённая cancellation, expiry,
  restart, clock rollback, unified recovery adapter и один active actor без
  provider/tool I/O.
- `execution-startup-recovery-coordinator.spec.ts` и
  `telegram-execution-startup-recovery.spec.ts`: dormant-часть AC-19-30,
  genuine lease provenance, фиксированный порядок подсистем, lease-loss окна,
  отказ structural recovery context до чтения state, Telegram terminal delivery
  без промежуточного release и повторная полная сверка continuation.
- `durable-parent-continuation.spec.ts`,
  `durable-delegation-turn-coordinator.spec.ts`, `bot-streaming.spec.ts`:
  private `0600` payload, exact replay,
  global-one-active busy, exact persisted ambiguity metadata, terminal
  CAS/receipt, bounded spans, checksum drift, symlink refusal, one-shot card,
  callback-only decision, claim reconciliation и startup exact-span replay в
  production wiring.
- `durable-parent-continuation-admission.spec.ts`, `bot-streaming.spec.ts`:
  AC-19-44, exact CAS retirement доказанной non-ambiguous orphan-записи,
  retirement provider failure до release и отказ без runtime-proof.
- `durable-delegation-live-adapter.spec.ts` и
  `durable-delegation-production.integration.spec.ts`: module-issued one-shot
  retry authority для exact provider ambiguity и запрет повторного mutation
  tool через `new-task-only`; raw request в evidence не публикуется.
- `orchestration.spec.ts` и `durable-delegation-runtime.spec.ts`: pure cold
  preflight полного delegation inventory, mixed active/terminal, empty,
  terminal-only, missing shard и budget drift; до успешного preflight нет
  handle, quarantine, recovery events, state install или child I/O.
- `delegation-persistence.spec.ts`: recovery inspection не создаёт missing run
  root и не превращает потерянный state в допустимый `none`.
- `durable-delegation-run-registry.spec.ts`,
  `durable-delegation-invocation.spec.ts` и
  `execution-startup-recovery-coordinator.spec.ts`: AC-19-37, private bounded
  snapshot/checksum, отсутствие directory discovery, exact binding filter,
  порядок register/activate/execute, pre-activation crash window, structural
  context denial и active continuation под тем же parent lease.
- `durable-delegation-startup-recovery.integration.spec.ts` и
  `execution-startup-recovery-coordinator.spec.ts`: AC-19-38, реальный lock-holder
  после `SIGKILL`, genuine quiescence handoff, durable unlink и negative corpus
  malformed/public/symlink без PID/mtime takeover.
- `bot-streaming.spec.ts`, `telegram-execution-stream.spec.ts`: AC-19-39…40,
  genuine checkpoint-bound lease до builder, запрет structural authority copy,
  отсутствие legacy/provider fallback при потере authority и exact adoption
  прежней execution-card без второго begin/bind.
- `durable-parent-continuation.spec.ts`,
  `durable-turn-actor-production-ports.spec.ts`,
  `durable-delegation-turn-coordinator.spec.ts` и `bot-streaming.spec.ts`:
  AC-19-41…42, durable cancellation receipt, quiescence-before-terminal,
  restart-safe actor reconciliation, idempotent exact run retirement и
  fail-closed Telegram acknowledgement.
- `durable-turn-envelope.integration.spec.ts`: AC-19-43, девять
  real-process `SIGSTOP`/`SIGKILL` границ общего Telegram/delegation envelope.

Production wiring private parent continuation, actor/global execution state,
startup exact-span coordinator и service composition опубликованы runtime
commit `854c956`; следующий `master@482ee88` меняет только release evidence.
Локальный post-merge gate проходит App 2335/2335, Core
2293/2293, Telegram 187/187, workspace `typecheck` и `build`. Exact release
развёрнут на `fr1`: target Core — 2293 passed / 1 skipped, Telegram — 187
passed, production child recovery — 6/6, общий envelope — 9/9; каждый старый
process-fixture файл, упавший от накопленной нагрузки, повторно проходит
изолированно без увеличения timeout или skip. `doctor` даёт 13 pass / 5
contract-defined warnings / 0 fail. Controlled child `SIGKILL` и direct-run
rollback rehearsal возвращают одну healthy supervised parent/child пару.
До user-accepted LIVE остаются операторские Telegram ambiguity, `/stop`,
ordinary delegation и voice/Skill/MCP/provider E2E; voice отдельно заблокирован
тем, что transcription provider на целевом хосте ещё не выбран.

## 8. Целевая приёмка supervised composition

Статус `release-ready LIVE` допустим только после следующего corpus на `fr1`.
Каждый шаг записывает code-only результат и exact release commit; содержимое
сообщений, memory facts, credentials и raw durable state в отчёт не попадают.

1. **Pre-deploy:** чистый checkout, локальная `ext4`, Node 22, достаточное место,
   активный user-systemd unit с `aisy supervise`; сохранить текущий rollback
   commit и подтвердить отсутствие незакоммиченных файлов. `pnpm` вызывается с
   явным Node bin в `PATH`: неинтерактивный SSH shell NVM не загружает.
2. **Release build:** получить exact объединённый commit, выполнить frozen
   install, workspace typecheck/build и полный Core/App/Telegram corpus. Затем
   повторить private-reference/secret scan над release diff.
3. **Doctor:** запустить doctor из нового `dist` при работающем service. Живой
   transcript lease считается pass; пустой MCP catalog, optional Docker и
   невыбранная transcription допустимы только как contract-defined pass/warn.
   Любой high/critical fail запрещает продолжение и включает rollback.
4. **Обычный Telegram envelope:** один текстовый turn даёт одну streaming card
   и один terminal reply; повторный callback не создаёт второй turn. Затем
   оператор проверяет voice ingress, Project-scoped memory write/recall,
   Skill toggle, один разрешённый stdio MCP call, provider switch и обычный
   `spawn_subagent`. Эти действия используют тестовые non-secret значения.
5. **Durable ambiguity:** безопасный read-only provider fixture оставляется на
   exact `prepared` boundary, runtime завершается через `SIGKILL`, systemd
   поднимает replacement. Карточка доставляется один раз, exact retry выполняет
   не более одного второго attempt, cancel не вызывает provider/tool повторно.
6. **Durable `/stop`:** на ожидающей карточке `/stop` получает quiescence
   receipt до terminal cancellation. Следующий restart не воскрешает карточку,
   run registry пуст для exact binding, поздний callback остаётся недействителен.
7. **Restart:** во время обычного delegated turn и отдельно после terminal
   reply receipt завершить child через `SIGKILL`. Parent остаётся единственным,
   systemd restart counter увеличивается ровно ожидаемо, replacement не
   дублирует внешний effect или Telegram delivery.
8. **Rollback rehearsal:** после штатной quiescence остановить service и
   запустить тот же release binary через direct `aisy run`; он не читает и не
   восстанавливает delegation state. Завершить direct run, вернуть
   `aisy supervise`, повторить doctor и один текстовый turn. Rollback на старый
   commit не выполняется поверх непроверенного нового durable state: для него
   сначала нужен отдельный compatibility verdict либо сохранённый state backup.
9. **Финал:** user-systemd active, один parent и один child, `NRestarts` без
   необъяснимого роста, checkout чистый, doctor без high/critical fail. Матрица
   получает фактические receipts/counts и только тогда меняет branch-only на
   target-accepted LIVE.

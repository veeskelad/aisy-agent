# LIVE-восстановление агентных команд

**Дата:** 2026-08-09  
**Статус:** согласованный дизайн; часть dormant-примитивов реализована, LIVE-гейты открыты  
**Связанные решения:** ADR-0039, ADR-0052, ADR-0069, ADR-0071, ADR-0092  
**Исполняемая спецификация:** `docs/specs/19-durable-subagent-resume.md`

## 1. Результат для пользователя

Обычный инструмент `spawn_subagent` становится долговечным по умолчанию. Aisy
может поручить анализ, реализацию и проверку разным агентам; завершённые части
команды переживают перезапуск, а незавершённые продолжаются с последнего
доказанного checkpoint. Пользователю не нужен отдельный режим или новая команда.
В production это восстановление доступно только в supervised-запуске: parent
доказывает, что прежний runtime завершён, и выдаёт новому runtime одноразовое
право продолжить exact turn. Прямой `aisy run` не получает это право.

Пример:

1. агент-аналитик завершил исследование;
2. агент-разработчик изменяет код;
3. процесс Aisy аварийно перезапустился;
4. Telegram повторно доставил тот же незавершённый turn;
5. Aisy повторно выдал уже сохранённый результат аналитика и продолжил
   разработчика, не запуская аналитика заново;
6. после завершения отдельный проверяющий этап подтвердил результат, и родитель
   получил компактное наблюдение без полного child-transcript.

Если авария произошла ровно во время внешнего действия и нельзя доказать,
успело ли оно завершиться, Aisy не повторяет его вслепую. Он показывает
одноразовое подтверждение точного повтора или отмены. Это выбранный оператором
вариант: безопасная остановка важнее автоматизма в неоднозначной точке.

## 2. Текущее состояние и разрыв

В опубликованном `master` уже есть:

- живой, но недолговечный `spawn_subagent`;
- durable persistence, recovery и run lock;
- genuine identity позиции вызова `{sessionId, turnId, ordinal}`;
- opaque run root, связанный с exact WorkBinding;
- sealed AgentCard/DNA/capability authority;
- bounded scheduler и manager-owned terminal observations;
- стабильный Telegram `turnId`, который повторяется вместе с незавершённым
  update после аварийного завершения процесса.

Разрыв состоит не в новом оркестраторе. `aisy run` всё ещё создаёт старый
in-memory manager и старый sub-agent runner. Production-preview runtime не
получает настоящие child, verifier, cost и ambiguous-retry ports. Поэтому
сохранённые checkpoint существуют только в offline-тестах.

## 3. Границы среза

### Входит

- заменить живой ephemeral-dispatch на existing genuine durable dispatcher;
- запускать child только через sealed AgentCard/DNA authority;
- ограничить реальную параллельность code-owned значением;
- сохранять provider responses и tool results как bounded private checkpoints;
- восстанавливать только доказанные settled-результаты;
- останавливать неоднозначный повтор до exact одноразового approval;
- учитывать стоимость из durable provider receipts, а не из model summary;
- передавать `/stop` до child/provider/tool и ждать прекращения owned effects;
- оставить существующий пользовательский `spawn_subagent` и существующие
  approval cards;
- добавить rollback на старый ephemeral runtime только как явную аварийную
  настройку оператора;
- обновить ADR-0052, русскую спецификацию 19 и production-матрицу.

### Не входит

- MCP-инструменты внутри субагента: live MCP composition остаётся за Claude;
- новые Telegram-кнопки, меню или onboarding;
- вложенные субагенты глубже одного уровня;
- автоматическое создание AgentCard из Telegram;
- Docker/процессная изоляция child;
- автоматический повтор действий с предельным воздействием;
- общий сетевой proxy, monitoring и обучаемая автономность.

## 4. Архитектура

### 4.1. Production composition adapter

Новый App-компонент собирает уже существующие примитивы и возвращает функцию с
тем же контрактом, который использует `makeLiveToolExecutor`:

```text
spawn(planJson, genuineToolContext) -> TaskObservation[]
```

Компонент:

1. создаётся per-turn только после durable checkpoint bind/start и получает
   genuine held IPC execution lease; structural/lost authority не может
   деградировать в старый runner;
2. проверяет genuine tool context именно для `spawn_subagent`;
3. нормализует план один раз и получает opaque run root из binding/turn/ordinal;
4. создаёт `makeNodeDurableDelegationRuntime` с policy
   `resume-active-replay-terminal`;
5. разрешает AgentCard и child capability matrix из frozen live catalog;
6. создаёт sealed child runner до первого provider/tool I/O;
7. запускает bounded scheduler с code-owned ceiling;
8. возвращает только manager-owned terminal observations.

Additive Telegram seam реализован отдельно от production importer: при его
отсутствии старый runner работает без изменений, а при наличии отсутствие
genuine lease закрывает ход до provider и не разрешает fallback. Это позволяет
проверить authority boundary до подключения реальных provider/tool ports, но
не является LIVE-активацией.

Модель не выбирает путь, run ID, concurrency, retry authority, budget allowance
или provider/tool checkpoint identity.

### 4.2. Sealed child runner

Durable runtime передаёт child не полный `DelegationHandle`, а ограниченный
execution handle. В него добавляется manager-owned проверка shard chain,
необходимая `makeBoundSubAgentRunner`. До создания provider он фиксирует:

- exact parent binding и child session;
- AgentCard name, body, provenance и revision/hash;
- разрешённые tools, skills и MCP set;
- `owns`/`doNotTouch`;
- iteration/spend/replan/concurrency limits.

Изменение AgentCard, scope, active skill, tool schema или binding после restart
не считается обновлением текущей задачи. Resume закрывается как authority drift
до provider/tool I/O.

### 4.3. Durable operation journal

Для каждого provider и tool вызова child создаётся code-owned identity:

```text
delegation + phase(provider|tool) + ordinal + canonical request hash
```

Перед внешним действием shard получает `prepared`. После доказанного завершения
он получает `settled` с bounded result и code-owned usage/effect metadata.
Приватные payload-файлы остаются внутри уже защищённого run root: directories
`0700`, files `0600`, no symlink/hardlink traversal, existing size/depth limits.

При restart child turn воспроизводится от начала, но wrapper:

- возвращает exact settled provider response без нового provider request;
- возвращает exact settled tool result без повторного tool effect;
- останавливается на первом `prepared` без соответствующего `settled`.

Таким образом, повторяется вычисление локального loop, но не доказанные внешние
действия.

### 4.4. Неоднозначный внешний вызов

`prepared` без `settled` означает: запрос мог не уйти, мог завершиться, а мог
успеть изменить внешний мир до аварии. Автоматический retry запрещён.

Runtime формирует code-owned pending action, связанный с:

- exact WorkBinding и run root hash;
- delegation/task/phase/ordinal;
- canonical request hash;
- AgentCard authority hash;
- текущей policy revision;
- верхней границей дополнительного task budget.

Approval использует существующий Telegram transport и вид карточки, но authority
ожидания хранится не в promise процесса, а в приватном durable journal. До
показа карточки runtime атомарно записывает `awaiting-approval` с exact binding,
request/action hash, policy revision, task budget ceiling, nonce и состоянием
`issued`. Telegram получает только bounded идентификаторы.

После restart supervisor recovery lease разрешает прочитать эту запись и
переиздать карточку с новым transport/card ID, но с тем же action identity.
Старая карточка становится недействительной. Tap сначала проходит обычную
проверку operator/chat/action hash, затем одной транзакцией переводит nonce в
`consumed` и сохраняет решение. Только durable `approved-once` может создать
`prepared` новой попытки. Повторная доставка callback возвращает уже сохранённый
результат и не создаёт второе разрешение или второй dispatch.

Исходный Telegram handler не ждёт tap на незавершаемом promise. После durable
`awaiting-approval` и успешной отправки карточки он публикует bounded
`paused-awaiting-approval` и заканчивается, чтобы long polling мог получить
следующий update. Это завершает только transport handler, но не durable task.

Callback handler также не запускает provider/tool сам. Он проверяет exact
карточку, устойчиво сохраняет решение и `resume-ready`, отвечает Telegram и
заканчивается. После него supervisor-owned execution actor атомарно claims
`resume-ready` и продолжает тот же binding/turn через обычный recovery lease.
После restart actor находит сохранённое решение сам. Crash после tap, но до
actor claim, после claim или до новой `prepared` не теряет решение и не создаёт
второй dispatch.

Обычный turn, durable pause, callback, resume actor и `/stop` используют один
durable execution lease и одну state machine. В первой production-версии lease
остаётся глобальным для одной установки Aisy и хранит exact session identity:

```text
idle -> running -> paused-awaiting-approval -> resume-ready -> running -> terminal
                         |                         |
                         +------> cancelling <----+
```

Для одной установки одновременно существует не более одного владельца
верхнеуровневого execution. Новое обычное сообщение из этой или другой session
во время `running`, `paused-awaiting-approval`, `resume-ready` или `cancelling`
не начинает второй turn: Gateway отвечает bounded статусом текущей задачи, а
update можно повторить после её завершения. Внутренние child-задачи одного turn
по-прежнему могут выполняться параллельно в пределах code-owned ceiling. Это
правило действует одинаково до и после restart и сохраняет действующий
cardinality-one контракт ADR-0071. Bounded multi-session authority index —
отдельное будущее решение, не скрытая часть этого среза.

Дополнительно:

- `canRememberSimilar=false`;
- допустимы только «повторить один раз» или «отменить»;
- raw prompt, command, path, provider body, tool args и credential не попадают в
  карточку или observability event;
- подтверждение durably записывается до нового dispatch;
- crash до dispatch переиспользует то же подтверждение;
- crash после нового dispatch создаёт новую неоднозначность и требует нового
  решения.

Для любого неоднозначного Tier-3 provider/tool effect in-place retry отсутствует
без дополнительных категорий и исключений. Runtime возвращает
`MANUAL_RECOVERY_REQUIRED`; пользователь начинает новую явную задачу, которая
проходит обычную Tier-3 границу и step-up заново.

Отмена фиксирует code-only terminal `CANCELLED_AMBIGUOUS`. Неподтверждённый
raw candidate не передаётся родителю.

### 4.5. Стоимость

Стоимость берётся только из settled provider response и durable usage receipt.
Provider wrapper добавляет receipt в shard до публикации response child loop.
`readCost` суммирует receipts по exact delegation и сверяет монотонность с
run-level budget.

Неоднозначный provider attempt консервативно удерживает code-owned allowance.
Если пользователь подтверждает ещё один вызов, runtime создаёт отдельное
одноразовое ambiguity allowance только из неиспользованного остатка того же task
slice. В каждый момент выполняется:

```text
settled cost + held ambiguous maxima + new retry reservation <= task slice
```

Та же сумма не может превышать run/global/daily budgets. Если прежняя
неоднозначная попытка уже удерживает весь task slice, повтор блокируется даже
после approval. Карточка прямо предупреждает, что предыдущий запрос мог быть
оплачен.

Model output не сообщает цену и не может увеличить allowance. Повтор без
доступного budget завершается `TASK_BUDGET_EXCEEDED` без provider I/O.

### 4.6. Проверка результата

Verifier port является code-owned и отдельным от child candidate. Минимальная
LIVE-версия использует уже сформированное child action evidence:

- для действий с эффектом требуется `actionStatus=verified` и postcondition
  после последней mutation;
- для read/reasoning задач требуется bounded successful result и отсутствие
  unresolved operation;
- shard chain, sealed authority и cumulative cost проверяются повторно;
- verifier выпускает evidence ID только из exact run/delegation/terminal hash.

Непроверенный результат становится code-only `UNVERIFIED_RESULT`; raw candidate
остаётся в child shard. Будущий отдельный judge-model может усилить смысловую
оценку, но не нужен для безопасного LIVE cutover и не заменяет code evidence.

### 4.7. Отмена и restart

Каждый child run связывается с `ToolExecutionContext.signal`, но `/stop` владеет
не только этим временным signal. Он атомарно переводит global durable state
из `running|paused-awaiting-approval|resume-ready` в `cancelling`, одновременно
инвалидирует pending card/nonce и закрывает admission callback/actor/new turn.
Late tap получает сохранённый `cancelled`, а проигравший actor claim не делает
provider/tool I/O.

Если child ещё работает, отмена передаётся текущему port и ждёт подтверждения
завершения owned effect. Только после этого runtime сохраняет terminal
`CANCELLED`. Без подтверждения остаётся recoverable ambiguous checkpoint, а
ложная отмена не публикуется. Crash в любой точке продолжает `cancelling` под
parent recovery lease; состояние не возвращается в `resume-ready` само.

Telegram long polling обрабатывает update последовательно и запрашивает
следующий offset только после handler. Аварийное завершение посреди turn не
подтверждает update, поэтому после supervised restart приходит тот же update и
получается тот же `turnId`. Ожидание approval является исключением не из
последовательности, а из длительности handler: durable pause позволяет handler
завершиться, callback приходит отдельным update, а actor продолжает исходный
turn после устойчивого решения. Штатное завершение также не должно заранее
подтверждать другой in-flight update.

Durable recovery допускается только после обязательного admission ADR-0071:

1. parent supervisor удерживает manager lease;
2. до чтения, repair или открытия run-state он доказывает quiescence прежнего
   runtime через runtime-liveness fence;
3. новый child проходит protocol-v2 hello, capture exact binding и
   `checkpoint-bound` ACK;
4. parent выдаёт одноразовый recovery lease именно этому child/turn;
5. child сверяет lease до и после каждого ожидания и до Telegram/provider/tool
   I/O.

Нет lease, потерян IPC, не доказана quiescence или запущен direct mode — recovery
закрывается с `EXECUTION_AUTHORITY_UNAVAILABLE`, без чтения/repair durable run и
без внешних действий. Это не silent fallback на ephemeral retry.

## 5. LIVE cutover и rollback

Durable runtime становится default для интерактивного main-agent
`spawn_subagent` только внутри production supervisor composition. Service unit
запускает supervisor, а не `aisy run` напрямую. Existing external tool schema и
Telegram UX не меняются.

Аварийный rollback — явная operator setting, которая возвращает legacy
ephemeral dispatcher только для новых direct-вызовов и одновременно выключает
durable recovery. Она не читает и не удаляет durable runs и не пытается
преобразовать их в ephemeral tasks. Direct `aisy run` удерживает общий liveness
fence по ADR-0071, но не читает и не восстанавливает durable delegation state.
Doctor/status должен сообщать число active/awaiting-approval/ambiguous/
quarantined durable runs без payload.

Перед изменением `packages/app/src/bin/aisy.ts` ветка повторно синхронизируется
с опубликованным commit Claude. Функциональный adapter и тесты живут в новых
файлах; production importer добавляется последним небольшим diff. Файлы MCP,
compaction, onboarding и Telegram buttons не меняются.

На текущем dormant-этапе additive V2 adapter уже связывает Journal V2 с exact
operation-control inventory, резервирует task/run/global/daily hold по bounded
quote до `start`, воспроизводит `settled + receipt` без нового списания и
принимает attempt 2 только с genuine one-shot resolution authority. Mutation
не получает `retry-once`. Перед LIVE injected provider/tool ports должны быть
заменены конкретными SDK/executor wrappers с доверенными quote, receipt и
mutation evidence; authority по-прежнему выдаёт только supervisor-owned actor.

Dormant startup coordinator уже принимает только genuine IPC recovery lease и
непрерывно проводит его через `Telegram → approval/stop → delegation`.
Telegram terminal delivery и actor recovery подключены конкретными adapters;
все clean-состояния дают единственный release, а continuation повторно сверяет
весь envelope под тем же lease. И lease, и передаваемый adapters recovery
context имеют process-local provenance; structural copies отклоняются до чтения
state. Concrete delegation port уже существует, но остаётся dormant: production
importer и cross-subsystem real-process kill corpus отсутствуют.

До выдачи active handle Core теперь выполняет отдельный cold preflight всего
exact run inventory: run ledger, каждый active/terminal child, scope siblings,
terminal observations и aggregate budget. Preflight не устанавливает state, не
quarantine'ит, не emit'ит и не выдаёт authority; production-preview runtime
сравнивает его snapshot с последующим terminal replay. Private code-owned
registry теперь хранит bounded checksummed inventory точных run roots, bindings
и plans; сканирование каталогов или восстановление plan из Journal V2 запрещено.
Invocation регистрирует record до создания runtime и переводит его в `active`
непосредственно перед execute; supervisor binding берётся только из genuine held
IPC lease и перепроверяется на границах. App inspector одного exact run использует
тот же preflight под transient run lock и не имеет child/verifier callbacks, а
concrete coordinator port агрегирует только records exact supervisor binding.
Supervisor-authorized handoff `.runtime.lock` после `SIGKILL` уже проверен
real-process тестом: удаляется только exact private token active record, а
malformed/public/symlink target остаётся нетронутым; PID/mtime не используются.
Этот слой пока dormant; production wiring и authority удаления terminal records
не готовы.

## 6. Ошибки и наблюдаемость

Публичные/Telegram ошибки остаются стабильными и не содержат raw payload:

- `DELEGATION_RETRY_APPROVAL_REQUIRED`;
- `DELEGATION_AMBIGUOUS_CANCELLED`;
- `DELEGATION_MANUAL_RECOVERY_REQUIRED`;
- `DELEGATION_BUDGET_EXCEEDED`;
- `DELEGATION_AUTHORITY_DRIFT`;
- `DELEGATION_RECOVERY_DENIED`.

События содержат только binding hash, run/delegation/task IDs, phase, ordinal,
policy revision, status и bounded cost counters. Provider text, tool result,
пути, команды, MCP payload и credential values не журналируются в общий
observability log.

## 7. Проверки

Детерминированные тесты должны доказать:

- одинаковая genuine-позиция вызова восстанавливает тот же run, а другая,
  поддельная или повторно использованная позиция отклоняется;
- изменение binding, AgentCard, capability matrix, policy или budget после
  restart закрывается до provider/tool I/O;
- settled provider response и settled tool result воспроизводятся без второго
  внешнего вызова;
- авария после `prepared`, но до `settled`, создаёт безопасную остановку;
- аварии после durable `awaiting-approval`, выдачи карточки, tap, сохранения
  решения, создания новой `prepared` и dispatch не теряют решение и не дают
  второй consume; callback redelivery/replay возвращает сохранённый результат;
- исходный Telegram handler заканчивается после durable pause, callback реально
  принимается следующим update, callback handler только пишет `resume-ready`, а
  execution actor продолжает exact turn без concurrent второго dispatch;
- новое сообщение из любой session во время pause/resume не начинает второй
  верхнеуровневый turn; `/stop` до tap,
  после tap и одновременно с actor claim одним durable CAS инвалидирует карточку
  и даёт zero позднего provider/tool I/O; restart сохраняет победившее состояние;
- точное одноразовое подтверждение разрешает один повтор, а отмена, replay,
  подделка и попытка выдать разрешение «для похожих» или «навсегда» не работают;
- неоднозначный Tier-3 вызов требует новой явной задачи и не повторяется внутри
  старого run;
- стоимость считается по settled receipts, неоднозначный вызов удерживает
  allowance, сумма settled/held/new не превышает один task slice, а global/daily
  budget остаётся сильнее approval; полностью удержанный slice блокирует retry;
- отмена не публикует ложный terminal, пока текущий внешний effect не завершён;
- ограничение параллельности действует при реально пересекающихся child runs;
- terminal replay не запускает child, verifier, provider или tool повторно;
- смена project root, archive root, ownership или run lock закрывает recovery;
- повреждённый checkpoint переводится в quarantine без чтения payload наружу;
- повторная доставка одного Telegram update продолжает тот же durable turn;
- recovery без genuine parent lease, при живом прежнем runtime, потере IPC или в
  direct mode даёт zero durable-state read/repair и zero external I/O;
- LIVE import graph использует durable adapter, а legacy runtime доступен только
  через явную операторскую настройку;
- в tracked файлах нет секретов, личного состояния и материалов приватного
  эталона.

Отдельный real-process fixture завершает Aisy в контрольных точках: после
`prepared`, после фактического внешнего результата, после `settled`, после
verifier и после terminal commit. После supervised restart проверяется, что
settled effects и стоимость не дублируются, неоднозначный effect не повторяется
без решения пользователя, а terminal публикуется ровно один раз.

Финальный gate включает затронутые targeted suites, package suites, workspace
typecheck/build, `git diff --check`, проверку production import graph и
privacy-scan tracked файлов.

## 8. Критерии готовности

Срез готов к merge, когда одновременно выполнены условия:

1. Обычный `spawn_subagent` в supervised production runtime использует durable
   runtime по умолчанию; direct `aisy run` не получает recovery authority.
2. Сохранённый этап после restart не вызывает provider или tool второй раз.
3. Неоднозначный внешний вызов останавливается и предлагает только точный
   одноразовый повтор или отмену.
4. Ожидание решения, nonce и consume сохраняются durable; restart безопасно
   переиздаёт exact карточку, а старый или повторный tap не создаёт dispatch.
5. Исходный handler завершается на durable pause; callback сохраняет
   `resume-ready`, а supervisor-owned actor продолжает исходный turn без
   блокировки long polling и без второго dispatch.
6. Обычный turn, pause, callback, actor и `/stop` делят один глобальный durable
   execution lease с exact session identity; новое сообщение из любой session
   не создаёт параллельный верхнеуровневый turn, а победивший `/stop`
   инвалидирует карточку и запрещает поздний resume. Внутренний bounded parallel
   child scheduler остаётся доступен одной текущей задаче.
7. Разрешение «для похожих» и «навсегда» недоступно для неоднозначного повтора.
8. Любой неоднозначный Tier-3 effect нельзя повторить внутри прежнего run.
9. AgentCard/DNA, tools, skills, binding и budgets закреплены до первого I/O и
   повторно проверяются при recovery.
10. Стоимость и дополнительный allowance выводятся только из code-owned durable
   receipts; settled, held и retry reservation вместе не превышают один task
   slice и общие лимиты.
11. `/stop` прекращает новые операции и не сообщает об отмене до завершения или
   фиксации неоднозначности текущего effect.
12. Повторно доставленный Telegram update продолжает тот же turn без второго
   terminal response.
13. Recovery начинается только после manager lease, доказанной quiescence,
    protocol-v2 binding и одноразового parent lease; direct mode закрыт.
14. Doctor/status показывает только безопасные счётчики durable runs без
    содержимого задач и результатов.
15. Явный legacy rollback влияет только на новые вызовы и не удаляет durable
    состояние.
16. ADR, русская спецификация, тесты и production composition описывают один и
    тот же контракт; все заявленные проверки зелёные.

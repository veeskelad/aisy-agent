# Ежедневная сессия и адаптивное поведение Aisy

**Дата:** 2026-08-28

**Статус:** дизайн подтверждён оператором 2026-08-28

**Связанные решения:** ADR-0040, ADR-0059, ADR-0061, ADR-0064, ADR-0079,
ADR-0093, ADR-0103, ADR-0108; спецификации 01, 03, 08, 10, 17, 21, 23 и 24

## 1. Результат

Production-агент ведёт естественный разговор, реально использует tools, память
и субагентов, запоминает явно сообщённые факты, учится предпочтительному стилю
и повторяемым процедурам. Служебные проверки остаются внутри harness и не
становятся темой ответа. Оператор подтверждает обычный класс действий один раз;
повторный вопрос появляется только при изменении scope/risk либо перед точным
необратимым действием.

Каждую ночь Aisy начинает новую интерактивную Session. Полный transcript старой
Session не удаляется и доступен через `/resume`. Консолидация долговременной
памяти выполняется по воскресеньям в настроенное время `AISY_NIGHTLY_AT`.

## 2. Выбранный подход

Выбран отдельный ежедневный lifecycle Session, а не prompt-only смягчение и не
перезапись transcript summary:

- transcript остаётся append-only и пригодным для точного resume/audit;
- новая Session получает свежий frozen prefix, актуальную память, Skills и
  personality overlay без накопленных model attempts;
- воскресная memory consolidation не является условием обычного `remember`;
- внутренний verifier проверяет реальные эффекты, но transport показывает один
  естественный terminal result;
- `SOUL.md` остаётся стабильным характером, а операторские привычки живут в
  отдельном versioned `PREFERENCES/LEARNED` overlay.

## 3. Минимальный scope и не-цели

В срез входят:

1. ежедневная crash-safe ротация активной интерактивной Session;
2. `/resume` как прямой путь к списку и восстановлению прошлой Session;
3. воскресное расписание memory consolidation;
4. точные уведомления для `0` и `N > 0` staged changes;
5. автоматический durable similar-grant после первого обычного подтверждения;
6. точная отдельная карточка только для необратимого/деструктивного действия;
7. естественный terminal renderer без внутренних id, recovery и safety theatre;
8. немедленное запоминание явных фактов и поправок стиля;
9. автоматическая активация typed communication preferences и typed
   procedural skills без расширения полномочий;
10. production cutover, restart/rollback и живые Telegram acceptance cases.

Не входят fine-tuning модели, удаление transcript, автоматическая установка
неизвестного кода, выдача новых credentials/egress, grant для Tier-3/HARD_DENY,
самостоятельная правка `constitution.md` или свободная model-authored правка
`SOUL.md`/`SKILL.md`.

## 4. Ежедневный Session lifecycle

### 4.1 Раздельные расписания

Scheduler хранит два независимых durable high-water. Оба scoped по exact
`botId + operatorId + profileId`; rotation record дополнительно связывает
Project, source Session и selection generation:

- `lastSessionResetDate`: каждый локальный календарный день после
  `AISY_NIGHTLY_AT`;
- `lastMemoryConsolidationDate`: только воскресенье после того же времени.

На воскресном слоте memory consolidation выполняется первой. Её результат
записывается в durable notification payload, затем выполняется Session reset.
В остальные дни создаётся только новая Session. Startup catch-up сохраняется:
пропущенный слот выполняется один раз после запуска, без повторной ротации того
же local date.

### 4.2 Crash-safe state machine

Ротация имеет monotonic phases:

`due → preparing → prepared → switched → restart_requested →
notification_pending → dispatching → delivered|ambiguous`.

Coordinator сначала атомарно поднимает transition barrier и фиксирует exact
selection generation. Если operator switch уже начался или snapshot успел
измениться, rotation остаётся `due`: intent и новая Session не создаются. Только
после barrier code-owned coordinator атомарно пишет `preparing` с
deterministic create key и заранее выбранным `newSessionId`:

`bot + operator + profile + project + sourceSession + generation + localDate`.

Registry получает idempotent `createSessionOnce(createKey, newSessionId)`,
поэтому crash до/после create и до/после публикации `prepared` не оставляет
неидентифицируемую Session и не создаёт вторую.

Durable record содержит local date, исходный/новый session id, project id,
selection generation и bounded notification kind без текста переписки. Он не
хранит memory facts, raw transcript или Telegram token/chat id.

- `preparing`: durable intent и exact будущий Session id записаны до create;
- `prepared`: создана новая Session, но selection ещё старая;
- `switched`: отдельный rotation authority атомарно выбрал новую Session;
- `restart_requested`: внешний supervisor получил запрос restart;
- `dispatching`: outbox начал единственную попытку Telegram send;
- `delivered|ambiguous`: response доказан либо повтор запрещён из-за
  недоказуемого результата send.

Restart на любой фазе продолжает её идемпотентно. Если process видит selection
на новой Session, он не создаёт вторую. Если switch не доказан, прежняя Session
остаётся активной. Marked date не публикуется раньше `switched`.

Автоматический switch не подделывает operator receipt. Для него вводится
отдельный `SessionRotationAuthority`, разрешённый только включённой оператором
daily policy. Receipt purpose-bound к exact owner/profile/bot/project,
source/new Session, expected generation, local date и create key, имеет durable
one-use nonce и не принимается обычным interactive switch path.

Новый interactive lease после barrier не выдаётся; уже выданный drain-ится до
switch. Поэтому turn, стартующий одновременно с reset, либо получает старый
lease раньше barrier и завершается, либо ждёт новую Session. Forged, replayed,
stale, wrong-date и wrong-generation rotation receipts ничего не меняют.
Crash до `preparing` освобождает barrier и оставляет `due`; после `preparing`
recovery повторно получает barrier только для записанной generation. Stale
generation завершает record как `cancelled-stale`, освобождает barrier и
сохраняет уже идентифицируемую, но неактивную Session для обычного lifecycle
archive; новый intent строится только из актуальной selection.
Durable goals, triggers, monitoring и subagent runs сохраняют исходный binding
и не перенацеливаются на новую Session.

### 4.3 Уведомление после restart

Уведомление отправляет только новый процесс после загрузки нового frozen
prefix. Это исключает потерю одноразового transport context при restart.

- Обычный день: `🌅 Начала новую сессию. Память и незавершённая работа
  сохранены. /resume — вернуться к прошлому разговору.`
- Воскресенье, `0` правок: `🌅 Начала новую сессию. Память проверена: новых
  правок нет. /resume — вернуться к прошлому разговору.` После этого notice
  transport хранит одноразовый `zero-staging` context: следующий bare `Покажи`
  отвечает `Новых правок нет.` без card и provider, затем context снимается.
- Воскресенье, `N > 0`: `🌅 Начала новую сессию. N правок памяти ждут решения.
  Покажи — открою карточку. /resume — вернуться к прошлому разговору.`
- Частичный результат: `🌅 Начала новую сессию. Память проверена частично:
  N правок доступны, K проектов требуют повторной проверки. /resume — вернуться
  к прошлому разговору.` При `N > 0` добавляется `Покажи — открою доступные
  правки.`

Bare `Покажи` получает transport `open-staging` shortcut только для доказанного
`complete-n` либо `partial-failure` с `N > 0`; partial card содержит только
успешные Project artifacts. `zero-staging` существует только для
`complete-zero` и является отдельным no-provider handler, а не открытием карточки.
`partial-failure` с `N = 0` получает одноразовый code-owned ответ `Доступных
правок нет; часть проектов не проверена.` без provider и не называется нулевым
успехом.
Stale, already-consumed и post-restart payload без exact weekly result не
вооружают ни один handler. Конкретное `Покажи файл` остаётся обычным inspect
request.

Перед send outbox публикует `dispatching`. Подтверждённый Telegram response даёт
`delivered`; restart/ошибка после начала send без доказанного response даёт
`ambiguous` и не повторяется. Гарантия — durable at-most-once dispatch, а не
недоказуемая exactly-once delivery. Doctor видит phase/recovery code без текста
уведомления.

Если weekly catch-up завершился уже после daily reset, отдельный result outbox
не повторяет фразу о начале Session. Он отправляет только соответствующий
результат: `Память проверена: новых правок нет.`, `Память проверена: N правок
ждут решения. Покажи — открою карточку.` либо `Память проверена частично: N
правок доступны, K проектов требуют повторной проверки.` Transport contexts и
at-most-once правила остаются теми же.

### 4.4 `/resume`

`/resume` без аргументов открывает существующий Session list view, newest-first,
с датой, коротким именем и количеством turns, не показывая raw transcript.
Выбор Session использует существующий one-use switch receipt и controlled
restart. `/resume <id-prefix>` допускается только для единственного exact
совпадения в активном Project; ambiguous/unknown prefix ничего не переключает.

Private audit сохраняет точный старый frozen prefix и transcript по ADR-0064,
но provider-facing resume view каждый раз строится через текущий forget/
tombstone и preference/skill-revocation filter. Если projection отличается от
persisted provider binding, старый provider thread не resume-ится: создаётся
новая linked generation той же Session с отдельным projection hash. Raw bytes и
hash audit не меняются. Забытый факт нельзя процитировать, найти retrieval-ом,
передать tool'у или вернуть из provider-local history. Повторный `/resume`
текущей Session отвечает одной строкой без restart.

## 5. Воскресная консолидация памяти

Daily Session reset не запускает generator/judge и не создаёт staging.
Низкозатратные archival/day-log, retention, disk hygiene и backup сохраняют
свою ежедневную cadence. Воскресенье включает bounded model stages: memory
generator/judge, conflict/dedup и free-form skill drafts.

Weekly source — не один воскресный day log. Durable cohort фиксирует exact
Workspace/Project bindings и общий cutoff, а каждый member имеет собственный
key `bot + operator + profile + contextKind + projectId`, cursor range
`(lastSuccessfulConsolidationCursor, cutoff]` и terminal state. Records читаются
в code-owned stable order под exact maintenance lease и имеют durable consumed
identity.

Успешный Project сохраняет result и cursor в cohort, но не повторяет provider
call при retry другого Project. Transient failure оставляет только этот member
pending; permanent context corruption становится explicit quarantined member и
не расширяет другие leases. Aggregate weekly result имеет code-owned variant
`complete-zero | complete-n(n) | partial-failure(n, failedMemberCount,
boundedCodes)` и публикуется после terminal state всех members, не смешивая
content между Projects. Quarantined member всегда даёт `partial-failure`, даже
если успешный staging пуст. Недоступный
provider вызывает catch-up в понедельник или после следующего startup, не
ожидая ещё неделю. Если catch-up завершился до ближайшего daily reset, результат
входит в его startup notice; если reset уже был, отдельный durable weekly-result
outbox отправляет тот же aggregate contract и вооружает transport только после
`delivered`. Ручной `/consolidate` создаёт idempotent ad-hoc cohort и не
подменяет scheduled cursors. Cross-cohort artifact registry индексируется по
exact member scope, source consumed ids hash, input projection hash,
live-memory/precondition snapshot hash, generator/judge config hashes и policy
revision. Поэтому следующий scheduled
member с тем же input присоединяет уже доказанный terminal artifact, продвигает
только свой scheduled cursor и не повторяет provider call/card; любое отличие
создаёт новый run.

Переиспользование проходит code-owned lifecycle matrix:

| Manual artifact state | Scheduled member |
|---|---|
| `pending` с валидными hashes/preconditions | присоединяет ту же pending card, считает её в `N`, второй card/provider call не создаёт |
| `approved/applying/ambiguous` | сначала восстанавливает exact promotion WAL; aggregate ждёт terminal outcome |
| `applied` | фиксирует `deduped-applied`, продвигает cursor, в `N` не считает |
| `rejected` | фиксирует `deduped-rejected`, продвигает cursor, в `N` не считает |
| `expired` | детерминированно revalidate; при успехе выпускает новый nonce для того же artifact без provider, при mismatch запускает новый keyed run |
| `forgotten/revoked` | никогда не reuse; повторяет forget-filter/projection и строит новый key/run |
| `corrupt` | quarantines member и даёт `partial-failure` |

Restart сохраняет state и не вооружает shortcut для consumed artifact.

Явное `remember` публикует защищённый факт в том же turn и отвечает естественно:
`Запомнил, что ты любишь получать деньги.` Weekly job нужен для conflict/dedup,
forget enforcement, свободных skill drafts и maintenance, а не для того, чтобы
вчерашний факт впервые стал доступен.

При нулевом staging Gateway не выпускает approval card и не обещает показать
несуществующие элементы. При `N > 0` card ids/hash берутся из exact weekly run
и повторно сверяются при открытии.

## 6. Риск-пропорциональные подтверждения

### 6.1 Что выполняется без вопроса

Answer-only разговор, memory search, чтение, вычисления, безопасные локальные
inspection tools, вызов уже разрешённого tool/MCP и делегирование в уже
разрешённом scope выполняются сразу. Harness может проверять status/receipt
внутри, но terminal reply содержит результат, а не отчёт о проверяющем.

### 6.2 Первое подтверждение становится правилом

Обычная подтверждённая Tier-2 карточка автоматически создаёт durable
code-derived similar grant. Отдельная кнопка «навсегда» не требуется.
Matcher остаётся из ADR-0093:

`tool + operation + resourceHash + WorkBinding + riskCeiling + policyRevision`.

Tap и grant связывает code-owned `approvalOperationId` из exact card id,
action hash и matcher hash. Private WAL проходит
`approval_consumed → grant_persisted|grant_failed → call_released`.
Duplicate callback/restart продолжает ту же operation и не создаёт второе
правило или второй dispatch. Pre-dispatch WAL failure блокирует call. Если exact
grant persist доказанно не удался, WAL фиксирует `grant_failed`, однократно
разрешает уже подтверждённый exact call и terminal result одной строкой
сообщает, что постоянное правило не сохранилось; следующий similar call снова
спросит. Post-write ambiguity восстанавливается readback/CAS до release call.

Plan approval до tap показывает bounded code-owned список
`planStepId/ordinal → plannedCallHash → matcherHash → savedScopeLabel`,
включённый в `planHash`; два одинаковых calls в разных позициях имеют разные
`planStepId`.
Grant не публикуется авансом на весь план: при фактическом admit exact
disclosed step создаётся deterministic child `approvalOperationId` и проходит
тот же WAL. Skipped, undisclosed, reordered/drifted step не получает grant.

Grant подавляет только последующие `ask` того же или меньшего риска. Обычная
карточка один раз сообщает: подтверждение сохранит правило для показанного
scope, отозвать его можно через `/grants`. Другой
Project/resource/operation, выросший risk или новая policy revision спрашивают
снова. `/grants` показывает и отзывает правило. Модель не создаёт matcher и не
может расширить его текстом.

Матрица режимов:

| Режим | Direct similar grant | Inferred learned autonomy |
|---|---|---|
| `auto` | применяется | применяется |
| `plan` | применяется только к exact approved plan step после plan approval | не применяется |
| `confirm` | не применяется: оператор явно выбрал ask-every-time | не применяется |

Production default для `@monday_aibot` — `auto`. Переключение в `confirm`
является явным временным ужесточением и не удаляет grants.

### 6.3 Что спрашивает каждый раз

Конкретное Tier-3, необратимое либо явно деструктивное действие не читает и не
создаёт persistent grant. Карточка показывает:

- точный target и effect;
- наиболее вероятное последствие;
- доступен ли rollback и что он не восстановит;
- кнопки выполнить/отменить.

Отдельный model round для «объяснения безопасности» не запускается: текст
строится code-owned risk descriptor. HARD_DENY остаётся запретом, а не
карточкой.

### 6.4 Verification без служебного диалога

`inspect-required`, `mutate-required` и `delegate-required` продолжают требовать
реального observation/receipt/postcondition. Но recovery instructions,
provider attempts, receipt ids, `delegationId`, внутренние `System:` labels и
время внутренних этапов не выходят пользователю и не входят в следующую
provider-facing историю.

Если tool не выполнился, агент пишет один конкретный человеческий результат:
что не получилось и что нужно для продолжения. Фраза «отсутствует проверяемое
доказательство» допустима только операторскому debug/doctor view, не обычному
чату.

## 7. Личность и обучение общению

### 7.1 Стабильный характер

`SOUL.md` задаёт постоянное ядро: живой русский язык, первое/второе лицо,
result-first, отсутствие канцелярита, filler и вымышленных объяснений. Он не
перечисляет каждую safety policy и не инструктирует модель постоянно говорить
о проверках. `constitution.md` и code-owned HARD_DENY остаются неизменными.

Agent-authored правка `SOUL.md` запрещена. Operator edit применяется со
следующей Session и сообщается оператору.

### 7.2 Явные предпочтения применяются сразу

Фразы оператора вида «говори короче», «не показывай служебные id», «пиши
„Запомнил, что ты…“» создают typed communication preference в exact operator
scope после одного authenticated turn. Source text хранится только в protected
memory provenance; prompt overlay содержит bounded normalized descriptor,
revision и rollback pointer.

`PreferenceScope = botId + operatorId + profileId`;
`PreferenceKey = PreferenceScope + descriptorFamily`. Взаимоисключающие values
одной family заменяют только её pointer, независимые families (например,
краткость и скрытие служебных id) активны одновременно. Immutable
`PreferenceRevision` содержит registry descriptor, source kind
`explicit|inferred`, policy revision, createdAt и hashed evidence refs без raw
dialogue. Store использует write-ahead lifecycle
`queued → validated → prepared → active`, atomic CAS active/previous pointers и
private modes. Crash каждого transition восстанавливается идемпотентно.
Pre-CAS failure новой revision оставляет прежний active неизменным;
post-CAS ambiguity восстанавливается из WAL/readback. Доказанная corruption
временно suppress'ит чтение повреждённой family до repair, не удаляя revisions
и не выключая независимые families; при отсутствии валидного active эта family
деградирует к стабильному `SOUL.md`.

Первая явная коррекция действует со следующего turn. Новая Session включает её
в обычный `PREFERENCES/LEARNED` snapshot. Повторное исправление создаёт новую
revision и сохраняет previous. Precedence:

`текущий authenticated operator turn > explicit preference > inferred
preference > SOUL defaults`.

Ни один preference не может спорить с constitution или code policy. Forget
сначала атомарно снимает overlay, затем удаляет evidence/artifact; reverse edge
source→revision и tombstone запрещают resurrection после restart. Rollback
возвращает только previous revision того же descriptor/scope.

### 7.3 Неявные привычки требуют повторения

Без явной формулировки code-owned observer может выбрать только descriptor из
закрытого communication registry. Два delivery-confirmed совпадения в разных
Session создают typed preference; same-session, retry, model self-report и
untrusted content не считаются. Такой preference меняет только форму ответа и
не может добавить tool, scope, authority или external action.

### 7.4 Процедуры и Skills

Повторяемый verified workflow после двух разных Session проходит существующий
ADR-0108 generator → validators → separate judge → shadow replay и может
активировать typed auto-skill без карточки. Daily reset делает независимые
Session естественными, но не подделывает второй success.

Свободный Markdown Skill, новый executable/tool, новый egress или расширение
AgentCard остаются staged изменением с явным подтверждением. Обновление typed
recipe в прежнем vocabulary/scope активируется автоматически с rollback.

## 8. Ошибки, restart и rollback

- Недоступный weekly provider не блокирует ежедневную новую Session; startup
  notice честно сообщает только факт reset, а consolidation retry остаётся
  отдельным.
- Недоступный supervisor оставляет durable phase `switched`; следующий startup
  завершает notice, а текущий process больше не принимает новый turn со старым
  binding.
- Неоднозначная Telegram delivery не повторяется автоматически; outbox хранит
  terminal `delivered|ambiguous`, а Doctor показывает recovery code без текста
  сообщения.
- Повреждённый rotation record quarantines только auto-reset. Telegram, память,
  tools и ручной `/resume` продолжают работать; Doctor даёт точный repair code.
- Managed rollback сохраняет старую Session активной, если новый binary не
  доказал `switched`. Уже выполненный registry switch не откатывается молча;
  previous binary читает обычный registry selection.
- Preference/typed-skill revision имеет previous pointer и удаляется через
  существующий forget cascade. Session reset не является забыванием.

## 9. Acceptance criteria

1. Каждый local date после configured slot создаёт не более одной новой
   интерактивной Session и выполняет controlled restart.
2. Обычный weekday reset не вызывает model stages; catch-up exact пропущенного
   weekly slot вызывает их перед ближайшим reset либо доставляет отдельным
   durable weekly-result outbox после уже выполненного reset.
3. Active turn откладывает reset; после завершения создаётся ровно одна Session.
4. Concurrent operator switch в границах snapshot/barrier/intent/create и crash
   до/после intent persist, create, prepared persist, switch и restart
   восстанавливается без duplicate Session/switch; forged/replayed/stale
   rotation authority и concurrent turn fail safely.
5. `/resume` list и exact unique prefix возвращают старую Session через
   receipt-bound switch/restart; ambiguous/unknown/current не мутируют state.
6. Weekly `0` отправляет no-changes text, не создаёт card и даёт одноразовый
   deterministic ответ `Новых правок нет.` на bare `Покажи` без provider только
   для `complete-zero`; quarantined member никогда не превращается в этот state.
7. Weekly `complete-n` и `partial-failure(N > 0)` вооружают single-use `Покажи`
   только после `delivered` startup notice нового process либо отдельного
   weekly-result outbox и открывают exact доступный staging без provider call.
8. Первое Tier-2 confirmation раскрывает exact saved scope и создаёт durable
   similar grant; второй exact similar call после restart не спрашивает в
   `auto`/допустимом exact plan step, а explicit `confirm` спрашивает.
   Crash/duplicate callback на каждой phase approval→grant→dispatch не создаёт
   второй grant/call; proven persist failure выполняет exact call один раз без
   сохранённого правила.
9. Different resource/project/risk/policy и любой Tier-3 снова требуют точное
   подтверждение; HARD_DENY не становится grantable.
10. Destructive card содержит target, consequence и rollback availability без
    model round.
11. Answer-only turn не запускает action recovery; successful tool/memory/
    delegation reply не показывает internal verification text или ids.
12. Явный факт публикуется в защищённую память в том же turn и получает ровно
    одно естественное подтверждение во втором лице.
13. Явная communication correction активируется со следующего turn; два
    implicit совпадения разных Session активируют только registry descriptor.
14. Communication preference store проходит crash/CAS/corruption/rollback и
    forget-first tests; current turn/explicit/inferred/SOUL precedence точна,
    две descriptor families независимы, failed update сохраняет прежний active,
    rollback одной family не меняет другую; preference и typed skill не
    расширяют tools/authority.
15. Full Core/App tests, typecheck/build, restart/rollback faults,
    `git diff --check`, Gitleaks и public private-reference scans зелёные.
16. Resume Session, созданной до forget/revoke, не раскрывает старый fact/
    preference provider'у или tool, сохраняя byte-identical private audit.
17. Weekly range/cursor обрабатывает Monday–Sunday ровно один раз; missed Sunday
    catch-up и A-success/B-failure/restart не пропускают, не дублируют и не
    смешивают Project evidence. A-success/B-quarantined даёт честный
    `partial-failure`, открывает только A staging и не сообщает `complete-zero`.
    Manual-success→Sunday с exact тем же artifact key не повторяет provider call
    или card, но атомарно продвигает scheduled member cursor.
18. Notification outbox доказывает at-most-once dispatch: `ambiguous` не
    resend-ится и виден Doctor, `delivered` вооружает exact transport context.
19. Production acceptance в `@monday_aibot` подтверждает daily reset,
    `/resume`, weekly complete `0`/`N` и partial-failure, память, повторный tool
    без карточки, destructive warning и естественный диалог; тестовые memory
    facts после проверки удалены.
20. Multi-step plan card hash включает все persistent scope disclosures; grants
    появляются только у фактически admitted exact steps. Skipped, reordered,
    undisclosed и drifted steps не получают grant и не вызывают call. Два
    byte-identical calls в разных positions имеют разные `planStepId`/child WAL;
    replay одного не поглощает и не дублирует другой.

## 10. Rollout

Activation идёт по dependency matrix; наличие кода не считается LIVE:

| Зависимость | Текущая граница | Gate этого rollout |
|---|---|---|
| Protected memory commit | preview/dormant по компоненту 03 | approved migration binding, live-compatible E2E и rollback rehearsal |
| Session transport lifecycle | часть adapters dormant по компоненту 17 | live `/resume`, rotation authority и barrier integration |
| Transcript recovery/projection | recorder частично LIVE, recovery coordinator dormant по компоненту 23 | forget-safe provider projection и target writer self-test |
| Typed auto-skills | explicit canary по ADR-0108 | ADR-0110 является release decision только после clean two-session target evidence и rollback compatibility |
| Typed preferences | новый private store | Doctor, crash corpus, forget/rollback и zero-overlay degradation |

1. Feature flags включаются на target только после deterministic corpus и
   rollback test каждого store.
2. Сначала deploy с read-only Doctor probes и выключенной ротацией.
3. Затем one-shot manual rotation rehearsal с сохранением previous release.
4. После restart включаются daily reset и Sunday consolidation schedule.
5. Typed communication learning и auto-skills включаются только при healthy
   private stores; failure деградирует к стабильному `SOUL.md`, а не ломает bot.
6. Строка production acceptance остаётся pending, пока её dependency gate не
   закрыт реальным trace. Финальная матрица разделяет LIVE code, deployed и
   behavioural acceptance.

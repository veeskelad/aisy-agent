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

Scheduler хранит два независимых durable high-water:

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

`due → prepared → switched → restart_requested → notified`.

Durable record содержит local date, исходный/новый session id, project id,
selection generation и bounded notification kind без текста переписки. Он не
хранит memory facts, raw transcript или Telegram token/chat id.

- `prepared`: создана новая Session, но selection ещё старая;
- `switched`: существующий `SwitchAuthority` атомарно выбрал новую Session;
- `restart_requested`: внешний supervisor получил запрос restart;
- `notified`: новый процесс отправил единственное startup-уведомление.

Restart на любой фазе продолжает её идемпотентно. Если process видит selection
на новой Session, он не создаёт вторую. Если switch не доказан, прежняя Session
остаётся активной. Marked date не публикуется раньше `switched`.

Ротация не обрывает активный Telegram turn и не отбирает lease у выполняемого
действия. При `agentState=running` она остаётся `due` и повторяется ближайшим
scheduler tick после освобождения. Durable goals, triggers, monitoring и
subagent runs сохраняют исходный binding и не перенацеливаются на новую Session.

### 4.3 Уведомление после restart

Уведомление отправляет только новый процесс после загрузки нового frozen
prefix. Это исключает потерю одноразового transport context при restart.

- Обычный день: `🌅 Начала новую сессию. Память и незавершённая работа
  сохранены. /resume — вернуться к прошлому разговору.`
- Воскресенье, `0` правок: `🌅 Начала новую сессию. Память проверена: новых
  правок нет. /resume — вернуться к прошлому разговору.`
- Воскресенье, `N > 0`: `🌅 Начала новую сессию. N правок памяти ждут решения.
  Покажи — открою карточку. /resume — вернуться к прошлому разговору.`

Bare `Покажи` получает transport shortcut только в последнем случае. Empty,
stale, already-consumed и post-restart payload без staged ids не вооружают
shortcut. Конкретное `Покажи файл` остаётся обычным inspect request.

### 4.4 `/resume`

`/resume` без аргументов открывает существующий Session list view, newest-first,
с датой, коротким именем и количеством turns, не показывая raw transcript.
Выбор Session использует существующий one-use switch receipt и controlled
restart. `/resume <id-prefix>` допускается только для единственного exact
совпадения в активном Project; ambiguous/unknown prefix ничего не переключает.

Возврат не копирует summary в новую Session: он загружает точный старый frozen
prefix и transcript по ADR-0064. Повторный `/resume` текущей Session отвечает
одной строкой без restart.

## 5. Воскресная консолидация памяти

Daily Session reset не запускает generator/judge и не создаёт staging. Полный
memory consolidation pipeline выполняется только по воскресеньям. Ручной
`/consolidate` остаётся доступен в любой день и не меняет weekly high-water.

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

Grant подавляет только последующие `ask` того же или меньшего риска. Другой
Project/resource/operation, выросший risk или новая policy revision спрашивают
снова. `/grants` показывает и отзывает правило. Модель не создаёт matcher и не
может расширить его текстом.

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
Запомнил, что ты…» создают typed communication preference в exact operator
scope после одного authenticated turn. Source text хранится только в protected
memory provenance; prompt overlay содержит bounded normalized descriptor,
revision и rollback pointer.

Первая явная коррекция действует со следующего turn. Новая Session включает её
в обычный `PREFERENCES/LEARNED` snapshot. Повторное исправление создаёт новую
revision и сохраняет previous.

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
  terminal delivery state и Doctor показывает ambiguity без текста сообщения.
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
2. Sunday catch-up выполняет consolidation до reset; weekday catch-up не
   вызывает generator/judge.
3. Active turn откладывает reset; после завершения создаётся ровно одна Session.
4. Crash на каждой phase восстанавливается без duplicate Session, switch или
   notification.
5. `/resume` list и exact unique prefix возвращают старую Session через
   receipt-bound switch/restart; ambiguous/unknown/current не мутируют state.
6. Weekly `0` отправляет no-changes text, не создаёт card, не вооружает
   `Покажи` и не вызывает provider для этого follow-up.
7. Weekly `N > 0` вооружает single-use `Покажи` только после startup delivery
   нового process и открывает exact staging без provider call.
8. Первое Tier-2 confirmation создаёт durable similar grant; второй exact
   similar call после restart не спрашивает.
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
14. Communication preference и typed skill не расширяют tools/authority;
    forgotten source или rollback снимает overlay.
15. Full Core/App tests, typecheck/build, restart/rollback faults,
    `git diff --check`, Gitleaks и public private-reference scans зелёные.
16. Production acceptance в `@monday_aibot` подтверждает daily reset,
    `/resume`, weekly `0`/`N`, память, повторный tool без карточки, destructive
    warning и естественный диалог; тестовые memory facts после проверки удалены.

## 10. Rollout

1. Feature flags включаются на target только после deterministic corpus и
   rollback test.
2. Сначала deploy с read-only Doctor probes и выключенной ротацией.
3. Затем one-shot manual rotation rehearsal с сохранением previous release.
4. После restart включаются daily reset и Sunday consolidation schedule.
5. Typed communication learning и auto-skills включаются только при healthy
   private stores; failure деградирует к стабильному `SOUL.md`, а не ломает bot.
6. Финальная матрица разделяет LIVE code, deployed и behavioural acceptance.

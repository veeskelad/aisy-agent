# Проверяемое автоматическое обучение приватным навыкам

**Дата:** 2026-08-24  
**Статус:** дизайн одобрен оператором 2026-08-24  
**Связанные решения:** ADR-0015, ADR-0016, ADR-0017, ADR-0025, ADR-0061,
ADR-0103, ADR-0108; спецификации компонентов 6, 10, 12, 21 и 24

## 1. Результат

Aisy после двух проверенных успешных выполнений одного процесса в разных
сессиях самостоятельно создаёт, проверяет и активирует его как приватный навык.
Активация происходит без отдельной карточки, но не выдаёт ни одного нового
разрешения: существующие
HARD_DENY, approvals, sandbox, budgets, egress и durable authority продолжают
решаться кодом на каждом исполнении.

## 2. Минимальный scope и не-цели

В этот срез входят:

- code-owned fingerprint повторяемого процесса;
- два проверенных успеха в разных durable session id;
- typed recipe generator → validators → separate judge → shadow replay;
- атомарная scoped-активация приватного навыка со следующего хода;
- аудит, restart recovery, disable/remove и автоматический rollback новой
  ревизии после проверенного отказа;
- короткое человеко-понятное Telegram-уведомление об активации.

Не входят обучение модели или fine-tuning, публикация пользовательских навыков,
автоматическое расширение approvals/egress, перенос секретов или переписки в
skill, обучение по неподтверждённым ответам модели, а также ослабление порогов
обучаемой автономности ADR-0061. Навык запоминает процедуру; scoped autonomy
grant по-прежнему выдаётся отдельным существующим процессом.

## 3. Что считается проверенным повторением

Agent Loop создаёт `VerifiedWorkflowEvidence` только для terminal success, у
которого каждый обязательный effect имеет receipt identity и проверенный
postcondition. Evidence связывает durable session/turn id, tool ordinals,
receipt ids, verification kinds и project/resource scope. Ход из narrowed или
untrusted context, `actionStatus: unverified`, ambiguous effect, отмена либо
пропущенный postcondition evidence не создаёт.

`AutoSkillScope` состоит из exact nullable botId, operatorId, profileId,
projectId, resourceScope и capabilityRevision. Поля выводятся только из trusted
TurnContextLease, bot ownership registry и resolved capability matrix. Predicate
learning равен `trusted && !narrowed`. Fixed-order UTF-8 JSON с explicit null
сравнивается bytewise; CAS key равен domain-separated SHA-256. `sessionId` в
scope не входит: он используется только как identity независимой демонстрации.
Код строит fingerprint из
упорядоченной последовательности
`autonomyWorkflowStep`/`similarDescriptor`, типов проверки и стабильной
`AutoSkillScope`. Сырые аргументы, ответы инструментов и текст
переписки в fingerprint не входят.

Счётчик принимает один успех на durable session id. Retry, replay, восстановление
того же turn, повтор внутри одной сессии и одинаковый receipt не увеличивают
счётчик. Неуспех, ambiguous effect, пропущенный postcondition, отмена оператора
или изменившаяся scope-boundary не считаются демонстрацией.

Перед выпуском terminal reply runtime синхронно дожидается одной bounded local
transaction: idempotent upsert evidence, enqueue candidate job и запись durable
reply-release state. Она не вызывает model/network I/O. После commit terminal
reply выпускается, а generator worker стартует асинхронно. Evidence и reply
связывают exact `operationId`, `receiptId`, `turnId`; crash/replay возвращает тот
же release state. Ключ job существует до имени навыка и связывает fingerprint,
две evidence identity, `AutoSkillScope`, schema revision и policy revision.
CAS базовой revision выполняется позже, после code-derived имени. Два
одновременных вторых успеха могут создать только один job.

## 4. Typed recipe вместо свободной инструкции

Для generator строится bounded redacted trace:

- последовательность разрешённых tool/capability descriptors;
- абстрактные placeholders вместо конкретных значений;
- типы postcondition и факт их успешной проверки;
- project/resource scope как категориальная граница, без абсолютных домашних
  путей, chat/user id и содержимого пользовательской памяти.

Из кандидата детерминированно запрещаются credentials, tokens, environment
values, персональные факты, raw transcript, raw tool output, hostnames/IP,
домашние пути, поля authority/trust и инструкции обхода проверок. При
невозможности безопасно обобщить процесс job карантинится без активации.

Generator не пишет Markdown. Модель возвращает только строго разобранный
`SkillRecipeDraft`:

- упорядоченные descriptor ids только из исходного evidence;
- typed placeholder ids;
- typed postcondition ids из закрытого code-owned registry.

Имя, triggers, `AutoSkillScope`, capability revision, display title/description
и verification text добавляет код из registry; model output этих полей не
принимается. В v1 placeholder source — закрытый enum `current_request` или
`verified_scope_metadata`. Resolver не хранит конкретное значение в recipe и
перед каждым запуском получает его из текущего operator request или exact
проверенной scope metadata. Missing/ambiguous value блокирует planning до
HookGate. Процессы, которым нужны другие источники, v1 карантинит.

Из draft код детерминированно строит переносимый `SKILL.md` и content-addressed
recipe manifest. Свободного тела, shell, URL, пути или новых tool names в нём
нет. `SKILL.md` остаётся читаемым представлением procedural memory, но source of
truth для исполнения — typed manifest.

Auto-skill загружается не как `operator` system span, а как отдельный
`learned-procedure` span ниже constitution/operator/project instructions. Он
может предложить только sequence из manifest и не может задавать стиль ответа,
политику или authority. Обычные human-authored и свободные agent-authored
`SKILL.md` сохраняют human-tap promotion по ADR-0015/0016.

## 5. Gates автоматической активации

Кандидат активируется только при последовательном успехе всех gates:

1. strict recipe schema, parser формата и exact artifact/manifest hash;
2. typed `descriptors_exist`, `slot_arity_matches`,
   `postconditions_registered`, rejection extra model fields и отсутствие
   любых шагов вне исходного evidence; `has_verification_section` проверяет
   только детерминированный renderer, не model text;
3. code-owned проверка отсутствия authority fields, секретов, персональных
   значений и запрещённых путей;
4. отдельный skill judge видит только typed recipe, deterministic rendering,
   diff и validators; exact `(provider, model, revision)` обязан отличаться от
   generator identity, иначе job fail-closed;
5. artifact-bound shadow runner исполняет recipe planner над двумя закреплёнными
   redacted fixtures и проверяет exact planned descriptor sequence и typed
   postconditions; изменённый/пропущенный step или отсутствующий обязательный
   effect обязаны дать FAIL;
6. compare-and-swap проверяет, что base revision навыка не изменилась;
7. atomic private activation записывает новую ревизию и rollback pointer.

Недоступный judge, совпадающий generator/judge identity, invalid output,
validator failure, trace mismatch или revision conflict означает «не
активировать». Fail-open для skill promotion запрещён.

Отдельный human tap не нужен только для этого typed auto-skill класса: он не
может выразить новый tool, scope или authority. Каждый будущий tool call заново
проходит обычный HookGate. Если процедура требует подтверждения, Aisy
продолжает его спрашивать. Новый ADR явно supersede-ит human-gate только в этой
узкой части ADR-0015/0016; scoped autonomy grants ADR-0061 и остальные
promotions не меняются.

## 6. Scoped private state, lifecycle и rollback

Автоматические навыки живут только в приватном runtime state под `AISY_HOME` с
каталогами `0700` и файлами `0600`. Публичный repository хранит лишь реализацию
механизма, ADR, спецификации и обезличенные fixtures. Пользовательский skill,
его evidence, telemetry и audit никогда не коммитятся в source Git.

Content-addressed revision ledger хранит immutable manifests и отдельный active
pointer для exact `AutoSkillScope`. Single-writer activation
queue и CAS сериализуют revisions разных навыков без общего перезаписываемого
WAL. Durable previous pointer сохраняется, пока текущая revision активна. Новый
процесс сначала восстанавливает незавершённую activation job, затем собирает
scoped menu. `prepared` не является authority; после crash source of truth —
завершённая active revision либо previous.

Invocation receipt связывает exact skill hash, scope, planned steps и их
verification receipts. Закрытый permanent failure enum:
`descriptor_missing`, `placeholder_missing`, `postcondition_mismatch`,
`required_step_omitted`, `scope_mismatch`. Он считается принадлежащим revision
только когда planner/invocation receipt содержит её hash; provider/network/
timeout и иные environment failures всегда transient. Permanent receipt
немедленно выключает revision и возвращает previous. Повторная генерация той же
неудачной revision запрещена tombstone. Re-enable заново запускает все
validators, judge identity check и shadow replay.

Forget — crash-safe state machine: `forget_claimed` атомарно снимает active
pointer и learned overlay; `purging` удаляет artifact, manifest и replayable
evidence; `tombstoned` оставляет только минимальный anti-resurrection record.
Recovery продолжает незавершённую фазу и никогда не возвращает pointer на уже
claimed revision. Audit минимизируется до keyed high-entropy hash, outcome,
policy revision и времени с bounded retention; session/chat/user ids, тексты и
unhashed low-entropy values не сохраняются. Cascade применяется при удалении
Project/session и явном «забудь этот навык».

Candidate lifecycle также durable:
`queued → generated → validated → shadow_verified → prepared → active`, с
terminal `quarantined|demoted|forgotten`. Каждая фаза idempotent и hash-bound;
recovery повторяет только локально доказанно незавершённый переход.

Store поддерживает durable reverse edges
`session/project → evidence → job → revision`. Удаление source session/Project
сначала вызывает `claimBySource`: одной транзакцией tombstone-ит все зависимые
jobs/revisions и снимает их active pointers/overlays. Только receipt этого claim
разрешает source store начать purge. После source purge recovery доводит
`purging → tombstoned`. Crash до claim оставляет source на месте; crash после
claim не может вернуть зависимый skill. Session без reverse edges ничего не
демоутит. Удаление любой из двух evidence sessions снимает revision, потому что
после forgetting её proof threshold больше не доказуем.

## 7. Scope и пользовательский контракт

Scoped manifest виден только в исходном `AutoSkillScope`. Project A не получает
навык Project B; child AgentCard наследует его лишь при exact binding и
разрешённом capability catalog. После activation versioned late catalog
добавляет learned-procedure overlay в следующий turn текущей сессии, не меняя
замороженные memory/history snapshots и стабильный prefix. Новая сессия строит
обычный menu уже с этой revision.

Основной ответ задачи не задерживается generator/judge. Candidate worker
ограничен отдельным budget/rate limit. При успешной активации Aisy планирует
at-most-once уведомление:

```text
Я запомнил этот способ работы как навык: <короткое название>.
```

Hash, gate, evidence id и внутренний статус пользователю не показываются.
Durable outbox claim создаётся до Telegram I/O, положительный message receipt
завершает delivery. Ambiguous send не повторяется автоматически: уведомление
может отсутствовать, но дубля не будет, а Doctor покажет bounded ambiguous
count. При отказе gates молчаливое отсутствие активации не превращает успешную
задачу в ошибку; причина остаётся в приватном audit и Doctor status.

## 8. Production composition

LIVE runtime переиспользует существующие parser/catalog primitives, но получает
минимальные отдельные `SkillRecipeGeneratorPort` и `SkillRecipeJudgePort` со
строгими JSON schemas и удостоверенной `(provider, model, revision)` identity.
Текущий nightly `draftSkills(): []`, memory-diff judge и warning при совпадении
identity не считаются реализацией этого контракта и не переиспользуются как
ложный gate.

Новый bounded evidence/job/revision store соединяет Agent Loop verified receipt
с immediate worker. Сборка создаётся в `aisy run`, передаёт binding-aware late
catalog в skill prompt runtime и регистрирует lifecycle status в Doctor.

Первый production rollout — explicit canary `AISY_AUTO_SKILLS=1` на target
operator instance. После полного race/restart/adversarial corpus и schema
rollback gate это может стать default-on отдельным release решением. Kill
switch отключает новые observations/jobs и learned overlays, не удаляя private
state. Откат binary сохраняет state; неизвестная schema fail-closed не
загружается. Миграция v1↔v2 проверяется до cutover.

## 9. Детерминированная приёмка

Готовность подтверждают тесты:

1. два успеха одной сессии, retry и replay не активируют skill;
2. два verified success разных сессий активируют ровно одну revision;
3. untrusted/narrowed, unverified, failure, ambiguous и missing postcondition
   evidence не создают;
4. concurrent second successes и cross-session replay одного receipt дают один
   evidence/job/activation;
5. secret/personal/raw-path/authority injection карантинится до judge;
6. judge unavailable или same identity, replay mismatch и revision conflict
   fail-closed;
7. сломанный candidate step проваливает artifact-bound shadow replay даже при
   двух успешных исходных traces;
8. scoped skill доступен со следующего хода только в Project A; Project B и
   child без exact binding/capability его не видят;
9. каждый tool call сохраняет approvals,
   sandbox, budgets, egress и HARD_DENY;
10. crash в каждой durable phase восстанавливается без duplicate candidate,
   commit или activation;
11. permanent receipt exact revision возвращает durable previous после
    активации другого skill; transient failure не демоутит;
12. disable/re-enable/remove/restart, concurrent activation и crash phases
    сохраняют revisions и replay tombstones;
13. forget Project/session/skill не оставляет replayable/raw personal evidence
    и не допускает resurrection; crash до/после reverse-edge claim сохраняет
    порядок, а несвязанная session не демоутит skill;
14. Telegram E2E accepted-send даёт одно короткое уведомление без внутренних
    receipt/status; ambiguous send не повторяется и виден Doctor;
15. full package tests, workspace typecheck/build, Doctor, managed
    update/restart/rollback и финальный provenance/secret scan зелёные.

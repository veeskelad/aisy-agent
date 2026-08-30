# ADR-0108: Типизированные auto-skills активируются без выдачи полномочий

**Статус:** Принято
**Дата:** 2026-08-25
**Теги:** skills, safety, learning

## Контекст

ADR-0015 и ADR-0016 требуют human tap для любого agent-authored `SKILL.md`.
Это необходимо для свободного Markdown: production runtime загружает его как
долговечную инструкцию, и даже защищённые HookGate tool calls не устраняют
влияние текста на стратегию и ответы модели.

Оператор выбрал более быстрый путь для повторяемых процедур: после двух
проверенных успехов в разных сессиях Aisy должна самостоятельно запомнить
процесс. Простое снятие human gate превратило бы модельный текст в authority и
противоречило бы основной границе Aisy. Поэтому автоматизация допустима только
для представления, которое по конструкции не умеет выражать новые полномочия.

## Решение

Вводится отдельный класс **typed auto-skill**. Модель возвращает только
идентификаторы descriptors, placeholders и postconditions из закрытых
code-owned registry. Имя, triggers, scope, display text, verification и
читаемый `SKILL.md` детерминированно строит код. Source of truth —
content-addressed typed recipe manifest; свободный Markdown не исполняется.

Auto-skill может активироваться без human tap только при одновременном
выполнении условий:

1. два verified terminal success с разными durable session id и одним
   code-derived fingerprint;
2. code-owned predicate равен `trusted && !narrowed`, а каждый effect имеет
   receipt и проверенный postcondition;
3. strict schema и validators не допускают новых descriptors, scope, authority,
   секретов или конкретных персональных значений;
4. отдельный judge имеет другую exact provider/model/revision identity;
5. artifact-bound shadow replay воспроизводит оба очищенных fixture;
6. compare-and-swap и private revision ledger атомарно публикуют scoped pointer.

`AutoSkillScope` включает exact nullable bot, operator, profile, project,
resource scope и capability-catalog revision, но не session id. Все поля
выводятся из trusted runtime binding, canonical JSON сравнивается bytewise и
образует `scopeKey`. Active/previous CAS pointer отдельно связывает scopeKey с
code-derived skill identity, поэтому несколько skills одного scope независимы.
Identity строится только из exact scope и ordered descriptor ids; registry,
placeholder и postcondition revisions остаются в workflow fingerprint и могут
без потери previous pointer заменить revision того же skill.
Typed skill входит в prompt как
`learned-procedure` ниже constitution/operator/project instructions. Каждый
реальный tool call повторно проходит approvals, HARD_DENY, sandbox, budgets и
egress. Auto-skill не создаёт autonomy grant; ADR-0061 остаётся неизменным.
Для закрытых single-step recipes planning также принадлежит коду: exact scoped
manifest и текущий запрос дают typed ToolCall, а не доверие Markdown-тексту.
Synthesis ответа остаётся у provider, но action-required ход не может заранее
выдать потоковое подтверждение эффекта, а execution receipt принимается только
при exact session/turn/monotonic ordinal binding.

Agent-authored свободный `SKILL.md`, nightly draft, imported edit и любое
изменение, которое способно добавить текст, tool, scope или authority,
по-прежнему требуют staging и human tap по ADR-0015/0016/0029.

Первый LIVE rollout — explicit operator canary. Default-on требует отдельного
release решения после race/restart/adversarial и rollback gates.
Rollback на binary, не знающий private schema, разрешён только managed
coordinator-ом. Он сначала публикует durable write barrier, дожидается quiesce
обычных writers, затем завершает только доказанно recoverable reverse-edge
phases и выдаёт exact state-hash/target-commit-bound `rollback-safe`
certificate. Barrier повторно проверяется непосредственно перед atomic active
switch и остаётся после него, поэтому старый уже запущенный v2 process не может
создать late edge. Новый edge, in-flight mutation, corruption или target drift
блокируют `--rollback` и любой non-descendant `--allow-rewrite`. После
roll-forward barrier снимает только explicit команда v2-aware active release;
downgrade target этого сделать не может.
Если retained `previous` является потомком текущего rollback release, возврат к
нему считается roll-forward, а не второй rollback: updater заново проверяет
release, сохраняет действующий barrier при atomic switch и не пытается выдать
несовместимый downgrade-certificate. Уже активный новый binary затем снимает
barrier explicit командой, привязанной к exact current commit. Non-descendant
`previous` по-прежнему проходит полный rollback-certificate gate.
Retained release перед roll-forward проверяется по существующему integrity
record до любого rebuild: updater не может перехешировать и тем самым узаконить
изменённый ignored runtime-файл.

Если active release при штатном managed rollback встречает exact persistent
barrier, optional typed auto-skill canary не должен выводить из строя весь
agent runtime. Composition фиксирует degraded-событие, не открывает store и
запускает Telegram, память, providers и обычные tools без auto-skill planning,
observation и overlays. Это исключение распознаёт только точный
certified barrier после read-only проверки его phase, certificate и exact
persisted state, независимо от canary-флага. Corrupt или crash-left `preparing`
barrier, неизвестная ошибка store и запуск barrier вне rollback-aware
composition остаются fail-closed. Source-forget во время паузы не объявляет
очистку выполненной. Возврат к новой версии всё так же требует explicit
`--resume-auto-skills`, после которого runtime открывает store заново.

Store handle, который увидел barrier или ошибку durable persist, становится
`poisoned`. Persistent epoch меняется при rollback и explicit resume, поэтому
даже idle pre-barrier handle не может записать старый in-memory snapshot после
roll-forward; требуется открыть state заново. Каждая составная мутация, включая
публикацию artifact, держит private in-flight marker; после аварийного
завершения coordinator сверяет владельца marker по PID, удаляет только marker
доказанно завершившегося процесса и повторно проверяет state. Живой или
неоднозначный владелец блокирует rewrite и любую очистку других marker до
глобальной quiescence. Marker v2 связывает exact temporary basename; после
смерти owner временный state/artifact удаляется до снятия marker, а потерявший
marker temporary fail-closed. Artifact marker также содержит exact revision
hash: directory удаляется только если durable state не содержит эту revision.
Poisoned/fenced handle не обслуживает execution-facing
reads. Provider failover разрешён только до
первой code-owned попытки tool execution: exact-turn ordinal checkpoint
синхронно записывается до вызова инструмента, observational progress не даёт
authority. Durable delegation хеширует только serializable projection с
`toolOrdinalBase`, а ephemeral `markToolAttempt` проверяет отдельно и возвращает
неперечисляемым только непосредственно на provider dispatch. Failed или неоднозначная provider-попытка делает весь turn
непригодным для learning, даже если следующий локальный шаг успешен.

Delivery callback связывает exact evidence id, session и turn. Source-wide
nonterminal claim запрещает новое evidence того же source через restart.
Artifact сохраняется только при неоднозначности после atomic state rename;
доказанная ошибка до rename удаляет artifact этой попытки. Durable idempotency
`remember` использует code-owned operation id как fact id защищённого
publication ledger: restart replay завершает ту же операцию, а другой факт с тем
же id fail-closed.

## Последствия

- **Положительное:** повторяемая процедура становится доступной без карточки,
  но модель не может записать произвольную долговечную инструкцию.
- **Положительное:** private typed manifest проверяем, scoped, забываем и
  откатываем по content hash; пользовательские artifacts не попадают в source
  Git.
- **Нейтральное:** ADR-0015 и ADR-0016 частично заменены только для typed
  zero-authority класса; их human gate остаётся каноном для свободных skills.
- **Нейтральное:** ADR-0061 продолжает независимо управлять scoped autonomy
  grants и не получает более мягкий порог.
- **Отрицательное:** v1 сможет выучить только процессы, чьи шаги и значения
  выражаются закрытыми registry; остальные кандидаты будут карантиниться.
- **Отрицательное:** нужны durable evidence/job/revision state machines,
  отдельные generator/judge ports и shadow runner.

## Рассмотренные альтернативы

**Автоматически активировать свободный Markdown.** Отклонено: такой текст
получает prompt-authority и может менять поведение вне HookGate.

**Сохранять human tap для всех skills.** Безопасно, но не выполняет выбранный
контракт автоматического обучения после повторения.

**Пусть judge решает, безопасен ли свободный текст.** Отклонено: probabilistic
judge не является детерминированной enforcement boundary.

## Ссылки

- [ADR-0015 — staged skill creation](./2026-06-11-skill-format-staged-creation.md)
- [ADR-0016 — generator и separate judge](./2026-06-11-generator-judge-self-learning.md)
- [ADR-0017 — external trace verification](./2026-06-11-external-verification-by-traces.md)
- [ADR-0029 — approval provenance](./2026-06-11-human-confirmation-provenance-binding.md)
- [ADR-0061 — scoped autonomy promotion](./2026-07-26-demonstration-grounded-autonomy-promotion.md)
- [Утверждённый дизайн](../superpowers/specs/2026-08-24-verified-auto-skill-learning-design.md)

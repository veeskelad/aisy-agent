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
Typed skill входит в prompt как
`learned-procedure` ниже constitution/operator/project instructions. Каждый
реальный tool call повторно проходит approvals, HARD_DENY, sandbox, budgets и
egress. Auto-skill не создаёт autonomy grant; ADR-0061 остаётся неизменным.

Agent-authored свободный `SKILL.md`, nightly draft, imported edit и любое
изменение, которое способно добавить текст, tool, scope или authority,
по-прежнему требуют staging и human tap по ADR-0015/0016/0029.

Первый LIVE rollout — explicit operator canary. Default-on требует отдельного
release решения после race/restart/adversarial и rollback gates.
Rollback на binary, не знающий private schema, разрешён только managed
coordinator-ом после завершения reverse-edge phases и выдачи exact
state-hash/target-commit-bound `rollback-safe` certificate.

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

# ADR-0112: Разговорное управление без самопереписывания и удаление Session

**Статус:** Принято
**Дата:** 2026-08-29
**Теги:** sessions, personality, approvals, tools, telegram

## Контекст

В Aisy уже существуют Session list/resume, переименование текущей Session,
архивирование и typed-настройки общения. Однако обычный пользователь видит
несколько несогласованных поверхностей: Session по умолчанию называется
`New session`, удалить её нельзя, настройка части функций требует точной
команды, а execution/restart-карточки показывают внутренние слова вроде
«намерение», «доказательство», `Gateway`, scope и таймеров.

Оператор выбрал разговорный интерфейс: почти весь доступный функционал должен
настраиваться обычной просьбой к модели. При этом модель не должна получать
право менять исходный код harness, safety-границы или собственные системные
инструкции. Удаление означает удаление самой Session и её transcript, но не
долговременной памяти, Skills или ранее выданных разрешений. Разрешения не
должны исчезать при ежедневной смене Session; для отдельного Project или папки
оператор может задать более строгий режим.

## Решение

1. Свободная реплика остаётся входом LLM, но любое изменение конфигурации или
   lifecycle выполняется только закрытым typed-инструментом. Его schema,
   допустимые операции, scope и postcondition принадлежат коду. Модель не может
   редактировать source tree Aisy, constitution, provider envelope, safety
   policy или каталог полномочий.
2. Для надёжных повседневных операций Telegram сохраняет code-owned кнопки и
   короткие прямые команды как fallback. LLM и кнопка вызывают один и тот же
   service API; параллельного «разговорного» хранилища нет. `list_sessions` и
   `configure_agent` являются обязательными platform-controls основного агента:
   старая AgentCard не может случайно скрыть их, но это исключение не добавляет
   карте файловые, сетевые, MCP или execution-возможности.
3. Новая Session получает временное имя. Во время первого содержательного хода
   модель может предложить короткое название через закрытую операцию
   `configure_agent(session.propose-name)`. Код, а не модель, определяет
   содержательность exact authenticated turn. Предложение
   хранится pending и применяется code-owned callback только после успешной
   доставки terminal reply, пока имя остаётся временным. Явное переименование
   оператора всегда имеет приоритет и запрещает последующее auto-rename. После
   restart неоднозначный pending-proposal отбрасывается без переименования:
   временное имя безопаснее догадки о доставке. Повреждение или недоступность
   этого optional store сначала приводит к durable retire всего неоднозначного
   pending-файла и созданию пустого store. Если self-heal невозможен, отключается
   только auto-name; Telegram и обычные ответы продолжают работать. Физическое
   удаление Session при этом отказывается до ремонта store, чтобы не объявить
   успех с оставшейся metadata.
4. Карточка Session содержит `Продолжить`, `Переименовать` и `Удалить`.
   Удаление — отдельная purpose-bound lifecycle operation. Перед ней
   показывается ровно одна terminal-карточка: какая Session удаляется и что её переписку нельзя
   восстановить. Active Session сначала атомарно получает replacement selection,
   затем её registry row и transcript удаляются под quiescence; после завершения
   выполняется один controlled restart.
5. Удаление Session не затрагивает protected/global/project memory, active
   typed Skills, communication preferences и обычные Workspace/Project approval
   grants. Raw transcript, Session attachments и provider-local history удаляются;
   content-redacted tombstone/operation receipt остаются, а restore старого
   backup обязан повторно применить tombstone. Из live Aisy Session исчезает
   сразу и не восстанавливается через пользовательский интерфейс; operational
   backups живут по отдельной настроенной политике retention. Session-local незавершённые
   turns/retries/delegations сначала должны стать terminal либо операция
   отказывается без частичного удаления. Долговечные будущие jobs не
   переназначаются молча: они используют существующее paused/disabled состояние,
   а причина `context-deleted` хранится в backward-compatible sidecar.
6. Durable ordinary grant после первого подтверждения использует существующий
   schema-v3 matcher и не включает Session id. Его область — точный
   operator/profile и Workspace или Project; resource matcher и policy revision
   остаются обязательными. Чистый global/operator scope не создаётся. Отдельный
   project/path policy overlay может только ужесточить правила, например всегда
   подтверждать запись в конкретной папке или спрашивать перед удалением во всём
   Project. Ни модель, ни overlay не могут
   ослабить HARD_DENY, sandbox, egress, budget или обязательное подтверждение
   необратимого действия. Снятие уже установленного overlay — отдельное Tier-3
   действие: один authenticated tap разрешает только exact change, карточка
   показывает точный code-owned Project-relative путь или весь Project, и
   remembered grant не создаётся. Folder matching использует
   component-by-component canonical identity без symlink traversal, а сами
   `read_file`, `write_file` и `list_dir` выполняются через привязанную к
   Project lease descriptor-relative confinement. Admission связывает exact
   Session/turn/ordinal с device/inode root и каждого существующего
   компонента; worker повторно сверяет эти pin уже по открытым
   дескрипторам. Alias, escape, symlink и подмена обычного
   каталога между policy admission и effect отклоняются fail-closed.
   Project-wide `no-egress` целиком
   запрещает opaque Bash/MCP и HTTP-watch, поскольку их безопасную сетевую
   семантику нельзя вывести из строки модели.
7. Обычный Telegram-режим показывает только разговор и необходимое состояние:
   быстрый результат без промежуточной карточки; одна редактируемая короткая
   карточка для действительно долгой работы; одно ясное подтверждение для
   деструктивного действия. Receipt/checkpoint/authority/schema, внутренние
   проверки, ids, таймеры, scope, tool history и рассуждения остаются в
   server-side диагностике либо явном debug/doctor.
8. Плановый restart говорит до выхода `Перезапускаюсь. Скоро вернусь.`, а новый
   process — не более одного раза `Снова на связи.`. Внутренняя запись
   restart-intent не получает отдельного пользовательского acknowledgement.
   Ошибка обычного ответа сводится к `Не получилось ответить. Попробовать ещё
   раз?` и одной рабочей кнопке.
9. Все code-owned пользовательские строки проходят единый copy-contract test:
   обычные renderers не могут публиковать закрытый служебный словарь; debug и
   doctor проверяются отдельно. Model reply дополнительно получает instruction
   не обсуждать внутренний provenance/control protocol без прямого вопроса.
10. Успешный `configure_agent` возвращает внутренний typed control receipt.
    Action-contract принимает его как доказательство exact rename либо выдачи
    delete-preview и не запускает лишний recovery-round. Receipt остаётся
    server-side; preview не считается физическим удалением и не создаёт deletion
    authority до authenticated Telegram tap. Provider action evidence для
    `configure_agent` связано с exact operation, поэтому replay другой
    policy-операции не проходит проверку эффекта.

## Последствия

- **Положительное:** меню, свободная просьба и LLM-tools ведут к одному
  проверяемому изменению, а обычный диалог перестаёт быть консолью runtime.
- **Положительное:** ежедневный reset и удаление Session не сбрасывают выученные
  разрешения, память и стиль.
- **Положительное:** исходный код и полномочия остаются code-owned, несмотря на
  широкую разговорную поверхность настройки.
- **Нейтральное:** удаление требует общего writer barrier, отдельного
  WAL/repair пути для append-only transcript и tombstone без удалённого текста.
- **Нейтральное:** старые session-bound grants больше не действуют, остаются
  доступными для отзыва из owner/Project grant UI и не должны молча становиться
  более широкими.
- **Отрицательное:** автоматическое имя зависит от корректного typed tool call;
  при его отсутствии Session остаётся с временным именем до следующего хода или
  явного переименования.
- **Отрицательное:** полное удаление active Session требует quiescence и один
  controlled restart, поэтому оно не может быть мгновенной простой записью.

## Рассмотренные альтернативы

**Оставить только команды и кнопки.** Надёжно, но противоречит выбранному
разговорному управлению и заставляет помнить синтаксис.

**Разрешить модели править `SOUL.md`, Skills или исходный код напрямую.**
Отклонено: свободный текст получил бы долговечную authority и смог бы менять
границы собственных полномочий.

**Считать archive удалением.** Отклонено: archive сохраняет transcript и
поддерживает restore, тогда как оператор запросил удаление самой Session.

**Удалять вместе с Session память, Skills и grants.** Отклонено: Session —
контекст разговора, а не контейнер всей личности и выученного поведения.

## Ссылки

- [ADR-0060 — Project-scoped sessions](./2026-07-26-project-scoped-sessions-file-ownership.md)
- [ADR-0064 — Full-fidelity transcript](./2026-07-26-full-fidelity-session-transcript.md)
- [ADR-0093 — Code-derived similar grants](./2026-08-09-code-derived-similar-approval-grants.md)
- [ADR-0108 — Typed auto-skills](./2026-08-25-typed-auto-skills-without-authority.md)
- [ADR-0110 — Одно подтверждение и typed style](./2026-08-28-one-confirmation-adaptive-style.md)
- [ADR-0111 — Молчаливое применение выученного контекста](./2026-08-28-silent-learned-context-and-bounded-onboarding.md)
- [Утверждённый дизайн](../superpowers/specs/2026-08-29-session-lifecycle-conversational-ux-design.md)

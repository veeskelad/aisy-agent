# ADR-0092: Plan Mode как исследование перед автоматическим выполнением

**Статус:** Принято; пункт 3 заменён [ADR-0100](./2026-08-14-plan-mode-waits-for-approval.md)

> **Изменено 2026-08-14:** план больше не выполняется автоматически. Между
> подачей и первым шагом стоит согласие оператора — фаза `approved`. Всё
> остальное решение (research-доказательства, plan drift, `attempted`/
> `ambiguous`, идемпотентность подачи, хранение только имён и хэшей) в силе.
**Дата:** 2026-08-09
**Теги:** agent-loop, safety, approvals

## Контекст

ADR-0083 определил `plan` как режим, в котором чтение разрешено, а любое
действие заблокировано до ручного переключения режима. Для оператора это
выглядит как тупик: агент может рассказать план, но не может продолжить задачу
сам. Это не соответствует выбранному продуктовому поведению.

Оператор определил Plan Mode иначе: это обязательная подготовительная фаза
задачи. Агент сначала собирает информацию, исследует код, документы и доступные
источники, затем формирует план и выполняет его. Дополнительное подтверждение
«выполняй» для обычных действий не нужно. Опасные действия продолжают проходить
через code-owned approvals; для повторяющейся работы оператору нужен отдельный
вариант «разрешить похожие в этом проекте навсегда».

В Core уже есть plan linter и проверяемые TODO из ADR-0026, но LIVE provider
adapters не выпускают `ModelResponse.plan`. Production `/mode plan` поэтому
реально реализует только вечную блокировку записи. Кроме того, существующий
durable grant v2 связан в основном с именем tool и WorkBinding: для полного
host Bash или другого широкого инструмента это слишком грубо, чтобы называться
«похожим действием».

## Решение

`plan` становится persistent режимом `research → submit → execute → verify`, а
не ручным стоп-краном между планом и выполнением.

1. Для action-required задачи code-owned runtime открывает фазу `research`.
   В ней разрешены только catalog tools с эффектом чтения/поиска. Успешное
   research-наблюдение durable связывается с точной session/turn identity.
2. Завершение исследования оформляется внутренним `submit_plan`, а не свободной
   фразой модели. Submission содержит bounded список точных будущих tool calls;
   runtime сохраняет только tool names и хэши нормализованных аргументов, не
   plaintext содержимое или секреты. План без успешного research evidence не
   принимается.
3. После принятия план выполняется автоматически в том же turn. Отдельная
   кнопка Execute и ручное переключение `/mode auto` не требуются. Каждый call
   всё равно проходит общий HookGate, HARD_DENY, narrowing, budgets и обычные
   approvals. `plan` никогда сам не включает `bypass`.
4. Runtime допускает только следующий exact call принятого плана. Другой tool,
   другие аргументы, другой WorkBinding, новый policy revision или новый scope
   считаются plan drift: mutation не начинается, текущий план отзывается и
   задача возвращается в `research`.
5. До side effect durable записывается `attempted`, после результата — terminal
   receipt. Crash в промежутке оставляет `ambiguous`: действие не повторяется
   автоматически. Оператор получает code-only отказ и новый план может
   продолжиться только после отдельного recovery/проверки фактического мира.
6. Режим и progress переживают restart. Повтор того же `submit_plan` для той же
   session/turn/plan identity идемпотентен; уже завершённые шаги не выполняются
   повторно. Новая задача снова начинает с исследования.
7. Answer-only запрос может завершиться после исследования без submission:
   план нужен перед действием, а не перед объяснением.
8. «Разрешить похожие навсегда» становится отдельным durable grant нового
   поколения. Similarity вычисляет код по tool, нормализованной operation,
   WorkBinding, resource selector и risk ceiling. Модель не пишет matcher.
   Старые tool-only grants не повышаются автоматически до similar grants и в
   `plan` игнорируются. Новые правила реализованы в ADR-0093.
9. Предельно разрушительные действия в обычных режимах не наследуют broad или
   similar grant и требуют отдельного решения по действующему Safety contract.
   Явный host Bash `bypass` ADR-0091 остаётся отдельным принятым риском и никогда
   не включается из Plan Mode.
10. Telegram показывает progress и approval cards, но не владеет состоянием
    плана. Backend выдаёт детерминированные фазы; transport только отображает их
    и передаёт решение оператора.
11. Provider-neutral protocol использует внутренний tool `submit_plan` с одним
    bounded JSON-аргументом. API-модель возвращает его через обычный tool call,
    а Claude/Codex subscription — через тот же локальный MCP bridge. Protocol
    разделён на две code-owned проверки: preflight до Safety/approval не даёт
    незапланированному действию создать лишнюю карточку, а admission после
    approval durable пишет `attempted` непосредственно перед executor.
    `submit_plan` перехватывается preflight и не попадает в пользовательский
    executor. Research evidence засчитывается только после общего output filter:
    скрытый или не доставленный модели read-результат не считается анализом.
12. Каждый provider-owned tool loop возвращает code-owned `sessionId/turnId`
    исходного operator turn. Локальный thread/turn провайдера не заменяет эту
    identity. Без transport-owned `turnId` Plan Mode делает zero tool I/O.
13. Protocol перед admission создаёт caller-detached snapshot exact call. После
    durable `attempted` executor получает только этот snapshot, поэтому поздняя
    мутация provider args не меняет выполняемое действие. Thrown или malformed
    terminal result оставляет `attempted`; restart переводит его в `ambiguous`.
14. LIVE composition устанавливает один контракт на обоих путях — native
    AgentRunner и subscription MCP capability executor. Интерактивные API,
    Claude и Codex получают `submit_plan`; compaction, nightly и sub-agent
    providers не получают внутренний tool. Unplanned acting call отклоняется до
    approval, exact planned call повторно сверяется после approval.
15. Provider-neutral protocol сохраняет code-owned terminal receipt
    `verified:true` при нормализации результата как в `auto`/`confirm`, так и в
    exact planned call. Принимается только literal `true` в точной структуре
    `{ok, output, verified}`; другое значение или дополнительное поле дают
    `PLAN_EXECUTOR_RESULT_INVALID`. Receipt остаётся in-process evidence и не
    может быть изготовлен provider text, progress или MCP JSON.

## Последствия

- **Положительное:** пользователь даёт одну задачу и получает исследование,
  понятный план и выполнение без лишнего ритуала переключения режима.
- **Положительное:** модель не может объявить «я всё продумала» и сразу вызвать
  другой tool: exact-call gate и durable state находятся вне prompt.
- **Положительное:** restart не превращает неизвестный side effect в слепой
  retry, а завершённые шаги не повторяются.
- **Нейтральное:** ADR-0083 остаётся действующим для `auto` и `confirm`, но его
  пункт о ручном выходе из `plan` заменён этим ADR. Пункт 5 ADR-0091 читается с
  той же поправкой; сам `bypass` не меняется.
- **Нейтральное:** backend и общий protocol активированы в production
  composition; отдельный Telegram rendering фаз остаётся улучшением UX, а не
  условием корректности выполнения.
- **Отрицательное:** Plan Mode добавляет минимум один research tool round и
  один structured submission, поэтому тратит больше времени и токенов.
- **Отрицательное:** `ambiguous` после crash иногда требует ручной проверки,
  зато Aisy не удваивает внешний эффект.

## Рассмотренные альтернативы

**Оставить ручное переключение после плана.** Отклонено оператором: режим должен
готовить задачу к выполнению, а не перекладывать запуск каждого обычного плана на
пользователя.

**Считать любой текстовый ответ планом.** Отклонено: модель может написать
убедительный текст и вызвать несвязанный tool; code-owned exact-call gate
невозможен без структурированного submission.

**Разрешать действия после любого одного чтения без точного плана.** Отклонено:
это превращает research в формальный `ls` и не связывает анализ с последующими
аргументами.

**Повторять attempted call после restart.** Отклонено: для сообщения, платежа,
деплоя или внешней записи повтор может удвоить необратимый эффект.

## Ссылки

- [ADR-0026 — Plan Mode, clarification и verified TODO](./2026-06-11-plan-mode-clarification-verified-todo.md)
- [ADR-0047 — Scoped approval grants](./2026-06-16-scoped-approval-grants.md)
- [ADR-0093 — Code-derived similar grants](./2026-08-09-code-derived-similar-approval-grants.md)
- [ADR-0083 — Режимы исполнения](./2026-07-29-execution-modes.md)
- [ADR-0091 — Полный host Bash bypass](./2026-08-08-explicit-host-bash-bypass.md)
- [ADR-0059 — Action contracts и verified completion](./2026-07-26-action-contracts-verified-completion.md)

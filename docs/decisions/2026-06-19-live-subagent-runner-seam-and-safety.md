# ADR-0052: Живой runner субагентов и его модель безопасности

**Статус:** Принято
**Дата:** 2026-06-19
**Последнее уточнение:** 2026-08-10
**Связано:** ADR-0039, ADR-0050, ADR-0051, ADR-0069, ADR-0071

## Контекст

ADR-0039 определил first-class делегацию: Agent Cards, goal-DAG,
непересекающиеся write scopes, checkpoint/resume и cascade-skip. Первоначальная
реализация подключила `DelegationManager`, `makeSubAgentRunner` и явный
`spawn_subagent`, но живой production-путь остался эфемерным: после аварии он не
может доказать, завершился ли конкретный provider/tool effect, сохранить
ожидание подтверждения или продолжить exact parent turn без повторного расхода.

Для production-восстановления недостаточно повторно запустить весь DAG. Падение
между внешним вызовом и сохранением ответа создаёт принципиальную
неопределённость: вызов мог выполниться и списать бюджет, даже если локального
результата нет. Автоматический replay в таком состоянии может повторить
изменение или оплату.

Одновременно нужно сохранить исходные решения runtime:

1. субагент не наследует approval grants родителя;
2. делегацию явно запускает инструмент `spawn_subagent`;
3. готовые задачи с непересекающимися write scopes могут выполняться
   параллельно, а пересекающиеся сериализуются;
4. вложенная делегация остаётся запрещённой;
5. модель не выбирает durable identity, concurrency, retry authority или
   бюджет.

## Решение

### Изолированный child runner

Каждая делегация получает отдельный `AgentRunner`, собранный
`makeSubAgentRunner`. Его authority задаётся кодом:

- свежая пустая `GrantStore`: подтверждения родителя не наследуются;
- exact запечатанная Agent Card определяет tools, Skills, MCP, model policy,
  iteration ceiling и budget slice;
- scoped executor разрешает запись только в `owns` за вычетом `doNotTouch`;
- сужение после untrusted input наследуется консервативно;
- Tier 3 нельзя разрешить durable grant’ом;
- child не получает `spawn_subagent`, поэтому глубина графа равна одному;
- встроенная `general` остаётся зарезервированной, неизменяемой и read-only.

До первого provider/tool I/O runtime запечатывает exact parent binding,
`sessionId`, `turnId`, позицию tool call, task/delegation IDs, Agent Card
`name@revision` и hash, capability matrix, scopes, budgets и policy revision.
Любой drift после restart блокирует продолжение до внешнего I/O. Уже
запущенная делегация всегда продолжает с той же ревизией карты; текущая active
ревизия registry не подменяет seal.

### Явная делегация и ограниченная параллельность

`spawn_subagent` принимает одну задачу либо goal-DAG. `DelegationManager`
нормализует вход один раз, после чего code-owned scheduler:

- выполняет готовые write-disjoint задачи параллельно, но не выше заданного
  ceiling;
- перед каждым batch повторно проверяет пересечение scopes;
- сериализует пересекающиеся задачи;
- явно отмечает downstream задачи как `cascade-skip` после upstream failure;
- возвращает родителю только manager-owned terminal observations.

Это внутренняя параллельность одного верхнеуровневого execution. На уровне
установки действует global-one-active envelope ADR-0071: одновременно есть не
более одной верхнеуровневой задачи с exact session identity. Сообщение из другой
сессии не создаёт второй parent turn и получает bounded busy-ответ. Расширение
до нескольких независимых верхнеуровневых sessions потребует отдельного ADR.

### Долговечная операция и receipt

Каждый provider/tool effect получает code-owned operation key, связанный с
run, binding, delegation, task, фазой, ordinal, canonical request hash,
authority hash и policy revision. Модель не может задать или заменить ни одно
поле identity.

Операция проходит следующие устойчивые состояния:

1. **`prepared`** публикуется с fsync до внешнего I/O и резервирует бюджет;
2. внешний port выполняет exact request;
3. **`settled`** публикуется только вместе с bounded private result и
   code-owned receipt результата/стоимости;
4. verifier принимает только `settled` evidence и отсутствие unresolved
   операций;
5. terminal observation фиксируется manager’ом и при replay выдаётся без
   повторного child/provider/tool/verifier I/O.

`prepared` без доказанного `settled` после crash — **ambiguity**, а не ошибка
для автоматического retry. Runtime приостанавливает exact turn и допускает
только одноразовое решение оператора: повторить точную операцию либо отменить.
Разрешения «для похожих» и «навсегда» недоступны. Неоднозначный Tier-3 effect
внутри прежнего run не повторяется: для него нужна новая явная задача и обычный
step-up.

Стоимость выводится только из durable receipts и консервативных holds. Перед
повтором код проверяет:

```text
settled cost + ambiguous holds + retry reservation <= task slice
```

Затем применяются run/global/daily ceilings. Approval не расширяет бюджет.

Внутри delegation manager каждый `IterationCost.spendUsd` до изменения
lifecycle переводится общим code-owned конвертером в целые наносы USD с
decimal half-up. Общий ledger складывает только safe integer nanos; terminal
observation и публичное число USD получают каноническое значение из этой суммы.
Это устраняет зависимость от порядка сложения binary float. Overflow,
неканонический persisted ledger или расхождение exact terminal aggregate с
manager/persisted ledger закрываются до следующего child I/O. Формат пока
остаётся schema v1: старые неканонические значения fail-closed, автоматическая
миграция до LIVE не выполняется.

Cold recovery рассматривает active child как одну группу. Сначала на одном run
snapshot pure-валидируются все active siblings и запрошенные terminal/failed
records, затем terminal replay завершается без active authority, и только после
этого один `recoverActive(exactIds)` выдаёт всю группу handles. Частичное
восстановление и повторный spawn уже активного sibling запрещены.

### Durable approval, execution actor и остановка

Ожидание решения не держит in-memory promise. До отправки карточки устойчиво
сохраняются pause, exact nonce, action hash, binding/session/turn,
operation key, Agent Card revision/hash и policy revision. Callback проверяет
operator/chat/action/nonce и только записывает exact решение; он не вызывает
provider или tool.

Продолжение выполняет supervisor-owned execution actor. Под parent recovery
lease он атомарно claims решение и непосредственно перед I/O повторно проверяет
binding, sealed authority, policy и бюджет. Crash после tap не теряет решение и
не создаёт второй consume или dispatch.

`/stop` конкурирует с callback и actor claim одной durable state machine.
Победившая остановка инвалидирует nonce, запрещает новый dispatch и ждёт
подтверждённого прекращения owned effect. Если прекращение эффекта доказать
нельзя, сохраняется ambiguity; ложный `CANCELLED` не публикуется.

### Граница LIVE-активации

Durable runtime становится production-путём только внутри supervised
composition ADR-0071. Direct `aisy run` не получает authority восстановления
делегаций и не читает, не repair’ит и не преобразует их state. Он может лишь
выполнить узкую legacy read-only проверку старой execution-card, достаточную для
стабильного отказа и указания запустить supervised service; это исключение не
выдаёт continuation authority.

Наличие core/runtime adapter само по себе не означает LIVE. Заявить
`spawn_subagent` долговечным production-путём можно только после одновременного
выполнения условий:

- production import graph использует durable adapter по умолчанию только под
  supervisor;
- поставлены Linux/macOS service artifacts, запускающие `aisy supervise`, с
  restart/stop policy;
- real-process corpus проходит kill-points после `prepared`, фактического
  external response, `settled`, verifier и terminal commit;
- тот же corpus доказывает единый startup recovery envelope для Telegram и
  delegation, отсутствие повторного effect/cost и безопасную ambiguity;
- package/workspace tests, typecheck, build и privacy scan зелёные.

До этого допустим merge dormant-компонентов, но статус LIVE или
production-ready запрещён.

Проверяемый dormant adapter уже фиксирует `prepared` до внешнего I/O,
воспроизводит `settled + receipt` без второго port-вызова и при неопределённом
результате выдаёт genuine runtime pause без verifier и terminal publication.
Это не закрывает LIVE-гейт: перед активацией обязательны durable inventory всех
operation slots, conservative budget holds и attempt/retry authority, а также
конкретные доверенные provider/tool ports с квитанциями и mutation evidence.

## Последствия

- **Положительные:** завершённые child-этапы и подтверждённая стоимость не
  повторяются после restart; неопределённый effect останавливается вместо
  слепого replay; identity, DNA, scopes, approvals и бюджеты сохраняют exact
  authority; внутренний bounded parallel остаётся доступен.
- **Нейтральные:** появляются operation journal, receipts, durable approval
  state machine, execution actor и обязательная supervised composition. Direct
  mode остаётся rollback/diagnostic путём без delegation recovery.
- **Отрицательные:** редкая ambiguity требует решения пользователя; fresh grant
  store увеличивает число подтверждений; global-one-active временно
  сериализует разные верхнеуровневые sessions; service и real-process corpus
  становятся обязательной частью релиза.

## Рассмотренные альтернативы

**Автоматически повторять любой `prepared` effect.** Отклонено: отсутствие
локального результата не доказывает, что внешний вызов не произошёл; возможны
двойное изменение и двойная оплата.

**Наследовать grants родителя.** Отклонено: скомпрометированная дочерняя задача
получила бы полномочия, выданные в другом контексте.

**Запускать готовые задачи только последовательно.** Отклонено: безопасная
параллельность уже доказуема через bounded scheduler и повторную проверку
непересекающихся scopes.

**Разрешить несколько верхнеуровневых sessions сразу.** Отложено: для этого
нужен bounded multi-session authority index с отдельными fairness, recovery и
budget-инвариантами.

**Восстанавливать delegation в direct `aisy run`.** Отклонено: direct mode не
имеет parent recovery lease и не может доказать quiescence старого runtime.

## Ссылки

- [ADR-0039](./2026-06-12-first-class-subagent-delegation.md) — исходный дизайн делегации.
- [ADR-0047](./2026-06-16-scoped-approval-grants.md) — grants и approvals.
- [ADR-0050](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md) — providers и бюджеты.
- [ADR-0051](./2026-06-17-loop-control-abort-and-mid-turn-budget.md) — abort и mid-turn budget.
- [ADR-0069](./2026-07-29-agent-card-lifecycle.md) — immutable Agent Card revision.
- [ADR-0071](./2026-07-29-execution-recovery-parent-supervisor.md) — parent recovery authority.
- [Спецификация 19](../specs/19-durable-subagent-resume.md) — исполнимый контракт.

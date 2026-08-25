# Естественное подтверждение durable memory

**Дата:** 2026-08-24  
**Статус:** дизайн одобрен оператором 2026-08-24  
**Связанные решения:** ADR-0017, ADR-0102; спецификации компонентов 1 и 3

## Результат

После успешной записи пользовательского факта Aisy подтверждает тот же факт
естественной фразой, а не внутренним статусом:

```text
Пользователь: запомни, что я предпочитаю краткие отчёты
Aisy: Запомнил, что ты предпочитаешь краткие отчёты
```

## Контракт

Remember принимает ровно одно из полей `fact` или legacy `text`. Значение —
короткое утверждение в форме, пригодной и для личной памяти, и для ответа
пользователю. Для факта о пользователе модель передаёт второе лицо, например
`ты предпочитаешь краткие отчёты`. Для безличного факта допустимо
`production cutover принят 24 августа 2026`.

Именно эта строка записывается в canonical memory. Отдельного модельного
`acknowledgement` нет, поэтому сохранить чай и подтвердить кофе невозможно.
Пользователь видит сохранённую формулировку и может сразу её исправить.
Отдельного subject-поля этот срез не вводит. Существующая owner/profile/scope
привязка personal memory задаёт prompt-рамку «ты = текущий оператор»;
second-person text остаётся byte-identical и не может попасть в память другого
owner/profile/Project.

Код проверяет `oneOf`: missing и одновременные `fact + text` отклоняются до
mutation; legacy `text` нормализуется в `fact`. Далее проверяются одна непустая
строка, bounded length, отсутствие control chars и служебных receipt/status
prefixes. После durable `COMMITTED` executor возвращает typed receipt
`{ ok:true, output, verified:true, mutationReceipt:{
kind:'memory.remember/v1', operationId,
receiptId, turnId, fact, committed:true } }`. Durable terminal outbox атомарно
связывает receipt с состоянием reply release, а `output` рендерит код, не
synthesis model: byte-exact `Запомнил, что <fact>`. Renderer не добавляет и не
удаляет пунктуацию внутри `fact`. AgentLoop заново вычисляет receipt из exact
tool call args и code-owned `sessionId + turnId + global ordinal`; внешний
provider execution с receipt другого факта, хода или позиции не получает
пользовательского подтверждения.

`operationId` передаётся в protected scoped memory как deterministic fact id
существующего publication ledger. Поэтому новый executor после process restart
повторяет ту же durable операцию, а не создаёт второй короткий факт. Тот же
operation id с другим exact fact отклоняется до новой публикации. Volatile Map
ускоряет только replay внутри процесса и не является authority.

До commit, при validation failure, `BLOCKED`, ambiguous effect или ошибке слово
«Запомнил» не выводится. Старый вызов с допустимым `text` мигрируется как alias
на один release cycle, но receipt всё равно содержит одну exact строку; затем
alias удаляется отдельным compatibility решением. Legacy retry использует
прежний operationId и получает тот же receipt/reply-release state без второй
mutation.

## Границы

Срез не вводит параллельную storage/index/forgetting schema, не пытается выполнять морфологическую
перезапись регулярными выражениями и не доверяет модели заявлять о совершённой
mutation. Он меняет только форму входа remember и code-owned terminal receipt.

## Детерминированная приёмка

1. Exact `fact` записан и exact reply равен
   `Запомнил, что ты предпочитаешь краткие отчёты`.
   Отдельные byte-exact fixtures с `fact` без точки и с точкой доказывают, что
   renderer не добавляет и не удаляет пунктуацию.
2. Безличный факт даёт естественное `Запомнил, что production cutover принят…`.
3. Нельзя передать разные stored/ack strings: второго поля не существует;
   missing и одновременные `fact + text` отклоняются.
4. Invalid input не начинает mutation, legacy `text` даёт тот же typed receipt,
   а legacy replay не создаёт второй effect.
5. Blocked, failed и ambiguous write не выводят «Запомнил».
6. Synthesis model не может переписать или скрыть committed acknowledgement.
7. Retry/replay receipt не создаёт повторную запись или второй terminal reply.
8. Existing scoped Project memory и Telegram integration corpus остаются
   зелёными; retrieval сохраняет owner second-person факта.
9. Provider-supplied current-turn context не может легализовать receipt другого
   `fact`, `turnId` или ordinal; локальные и subscription tool calls используют
   один `toolOrdinalBase`/high-water mark.
10. Restart между durable memory commit и reply replay оставляет один live fact;
    повтор возвращает `Запомнил, что …`, конфликтующий fact fail-closed.

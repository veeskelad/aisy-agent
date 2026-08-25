# Естественное подтверждение durable memory

**Дата:** 2026-08-24  
**Статус:** дизайн одобрен оператором 2026-08-24  
**Связанные решения:** ADR-0017, ADR-0102; спецификации компонентов 1 и 3

## Результат

После успешной записи пользовательского факта Aisy подтверждает тот же факт
естественной фразой, а не внутренним статусом:

```text
Пользователь: запомни я люблю получать деньги
Aisy: Запомнил, что ты любишь получать деньги
```

## Контракт

Remember принимает ровно одно из полей `fact` или legacy `text`. Значение —
короткое утверждение в форме, пригодной и для личной памяти, и для ответа
пользователю. Для факта о пользователе модель передаёт второе лицо, например
`ты любишь получать деньги`. Для безличного факта допустимо
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
`{ ok:true, output, verified:true, mutationReceipt:{ kind, operationId,
receiptId, turnId, fact, committed:true } }`. Durable terminal outbox атомарно
связывает receipt с состоянием reply release, а `output` рендерит код, не
synthesis model: `Запомнил, что <fact>`. Точка добавляется только если её нет.

До commit, при validation failure, `BLOCKED`, ambiguous effect или ошибке слово
«Запомнил» не выводится. Старый вызов с допустимым `text` мигрируется как alias
на один release cycle, но receipt всё равно содержит одну exact строку; затем
alias удаляется отдельным compatibility решением. Legacy retry использует
прежний operationId и получает тот же receipt/reply-release state без второй
mutation.

## Границы

Срез не меняет storage/index/forgetting schema, не пытается выполнять морфологическую
перезапись регулярными выражениями и не доверяет модели заявлять о совершённой
mutation. Он меняет только форму входа remember и code-owned terminal receipt.

## Детерминированная приёмка

1. Exact `fact` записан и exact reply равен
   `Запомнил, что ты любишь получать деньги`.
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

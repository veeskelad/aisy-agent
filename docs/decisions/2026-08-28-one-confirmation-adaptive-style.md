# ADR-0110: Одно подтверждение обучает разрешению, стиль — отдельный typed overlay

**Статус:** Принято
**Дата:** 2026-08-28
**Теги:** approvals, personality, learning

## Контекст

Action contracts и postcondition verification предотвращают выдуманное
выполнение, но их служебные recovery-реплики не должны звучать в обычном
диалоге. Существующие similar grants требуют отдельного выбора «навсегда», а
inferred learned autonomy созревает несколько дней. Поэтому оператор может
подтвердить одну и ту же нормальную операцию много раз и всё равно видеть
карточки вместо результата.

Одновременно Aisy должна учиться общению. Автоматическая правка `SOUL.md`
смешала бы устойчивую личность со случайным контекстом, а свободный generated
Skill мог бы получить prompt-authority. Нужна отдельная граница между характером,
операторскими предпочтениями и полномочиями tools.

## Решение

1. Первое подтверждение обычной Tier-2 операции автоматически создаёт durable
   code-derived similar grant ADR-0093. Отдельная кнопка «навсегда» не нужна;
   карточка заранее показывает exact scope правила и `/grants` для отзыва.
   Одноразовый callback уже связывает tap с exact card/action; после него
   `GrantStore` атомарно публикует code-derived matcher. Если запись правила
   доказанно не удалась, уже подтверждённый exact вызов не превращается в
   ложный отказ, но следующий похожий вызов снова спросит. Отдельный WAL между
   tap, grant и dispatch не вводится в этом срезе: повтор внешнего эффекта
   предотвращает существующий durable turn envelope, а grant не является
   журналом выполнения.
2. Matcher остаётся scoped по tool, operation, resource hash, WorkBinding,
   risk ceiling и policy revision. Grant подавляет только последующий `ask` и
   никогда не обходит HARD_DENY, narrowing, sandbox, egress или budget.
3. Tier-3, необратимое и явно деструктивное действие не читает и не создаёт
   grant. Каждая exact карточка code-owned показывает target, последствие и
   доступность rollback.
4. Verification mutation/delegation остаётся обязательной внутри harness, но
   transport показывает один terminal result. Recovery instructions, receipt/
   delegation ids, provider attempts и неподтверждённые объяснения не входят в
   пользовательский ответ или следующую provider-facing историю. Обычная
   runtime-ошибка также не публикует exception message, class, schema, таймер,
   workspace или внутренние шаги: server-side checkpoint сохраняет
   content-redacted диагностическую фазу, а одна существующая execution-card
   превращается в короткое «Не получилось
   ответить» с кнопкой повторения. Отдельная вторая error-card отправляется
   только как fallback, если первую технически нельзя переиспользовать. Штатный
   restart также не публикует таймер, workspace, plan/tool history и
   служебную формулировку «прервано»: одна карточка кратко говорит,
   что агент снова на связи и ход нужно повторить.
5. `SOUL.md` остаётся стабильным операторски управляемым ядром. Явная поправка
   общения создаёт versioned typed preference и действует со следующего turn.
   Грамматический род — самостоятельная mutually-exclusive family
   `masculine-russian|feminine-russian`, поэтому его исправление не меняет
   tone, verbosity, memory acknowledgement или полномочия tools. Code-owned
   Telegram notices, которые обходят provider overlay, используют тот же
   выбранный род либо нейтральную форму; они не имеют независимой скрытой
   личности.
6. Неявное обучение общению выбирает только descriptor закрытого registry и
   требует два delivery-confirmed совпадения в разных Session. Preference не
   может добавить tool, scope, authority или external effect.
7. Повторяемые процедуры продолжают ADR-0108 typed auto-skill path. Новые tools,
   executable, egress, AgentCard authority и свободный Markdown остаются
   staged изменением с явным подтверждением.
8. Явные durable факты публикуются защищённым `remember` в том же turn;
   недельная consolidation не является prerequsite их доступности.

Матрица precedence для grants:

| Режим | Direct similar grant | Inferred learned autonomy |
|---|---|---|
| `auto` | применяется | применяется |
| `plan` | применяется к exact approved plan step | не применяется |
| `confirm` | не применяется | не применяется |

`confirm` остаётся явным ask-every-time override. Production default — `auto`.
В режиме plan действует существующее одобрение exact `planHash`. Автоматическая
публикация отдельных persistent grants для каждого plan-step **отложена**:
текущий срез не создаёт заранее разрешения для пропущенных или невыполненных
шагов. Если такой UX понадобится, он требует отдельного ADR с disclosure и
restart-контрактом, а не скрытого расширения этой карточки.
Эта ADR заменяет пункт 7 ADR-0093 только для `auto/plan` и уточняет пункт 2
ADR-0103: inferred autonomy не действует в `confirm/plan`; direct operator grant
не является inferred autonomy.

Typed preference имеет exact `PreferenceScope = botId + operatorId + profileId`
и `PreferenceKey = PreferenceScope + descriptorFamily`. Immutable revision
хранит registry descriptor, source kind, hashed evidence refs и policy revision.
Каждая family хранится отдельным атомарно заменяемым private snapshot с
`active/previous`: write failure оставляет прежний active в текущем процессе,
а restart читает полностью старую либо полностью новую ревизию. Corruption
suppress'ит только повреждённую family до repair, не выключая независимые
families; при отсутствии валидного active она деградирует к стабильному
`SOUL.md`. Precedence равно `current
authenticated turn > explicit preference > inferred preference > SOUL
defaults`; constitution/code policy всегда выше. Forget сначала снимает overlay,
оставляет tombstone ревизии и не сохраняет raw dialogue. Rollback возвращает
только previous revision того же key. Многофазный preference WAL с repair UI
**отложен** до появления внешнего concurrent writer.

Закрытый registry включает family `grammatical-gender`. Явная фраза оператора
«отвечай в мужском/женском роде» активирует соответствующий descriptor со
следующего turn; в durable state остаются descriptor и hash evidence, но не
исходная реплика. Противоположный descriptor создаёт новую revision той же
family, поэтому rollback и forget не затрагивают остальные настройки общения.

Это решение заменяет отдельный выбор persistent scope ADR-0093 для обычной
успешно подтверждённой Tier-2 карточки в `auto/plan`. Granularity, deny
precedence и Tier-3 границы ADR-0093 сохраняются. Inferred autonomy ADR-0103
остаётся только для процессов, не получивших прямого operator grant.

## Последствия

- **Положительное:** нормальная подтверждённая рутина больше не спрашивает одно
  и то же после restart.
- **Положительное:** пользователь видит результат работы tools, а не внутренний
  протокол доказательств.
- **Положительное:** Aisy быстро принимает явные исправления стиля и безопасно
  выводит повторяемые предпочтения.
- **Нейтральное:** `/grants` и forget/rollback остаются способом увидеть,
  отозвать и восстановить learned state.
- **Отрицательное:** ошибочно подтверждённая Tier-2 операция сохраняет scoped
  правило до отзыва или policy revision; карточка должна ясно описывать scope.
- **Отрицательное:** новые communication patterns вне закрытого registry нельзя
  вывести неявно; оператор формулирует их явно либо ждёт обновления кода.

## Рассмотренные альтернативы

**Сохранять правило только по отдельной кнопке «навсегда».** Отклонено
оператором как повторяющийся контроль без дополнительной пользы.

**Убрать verification полностью.** Отклонено: tools должны реально работать,
а не только звучать уверенно. Проверка остаётся внутренней и пропорциональной
эффекту.

**Автоматически переписывать `SOUL.md` или свободный `SKILL.md`.** Отклонено:
случайный model text стал бы долговечной инструкцией и мог бы расширить
поведение вне подтверждённого scope.

## Ссылки

- [ADR-0059 — action contracts](./2026-07-26-action-contracts-verified-completion.md)
- [ADR-0061 — demonstration-grounded autonomy](./2026-07-26-demonstration-grounded-autonomy-promotion.md)
- [ADR-0093 — similar grants](./2026-08-09-code-derived-similar-approval-grants.md)
- [ADR-0108 — typed auto-skills](./2026-08-25-typed-auto-skills-without-authority.md)
- [Утверждённый дизайн](../superpowers/specs/2026-08-28-daily-session-adaptive-agent-design.md)

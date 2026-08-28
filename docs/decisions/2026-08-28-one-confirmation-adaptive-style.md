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
   Exact card/action/matcher связывает code-owned `approvalOperationId`.
   Private WAL проходит `approval_consumed → grant_persisted|grant_failed →
   call_released`: duplicate callback/restart не создаёт второй grant или call.
   До доказанного grant write вызов не выпускается; доказанный persist failure
   один раз выполняет уже подтверждённый exact call без правила и сообщает
   одной строкой, что постоянное разрешение не сохранилось.
2. Matcher остаётся scoped по tool, operation, resource hash, WorkBinding,
   risk ceiling и policy revision. Grant подавляет только последующий `ask` и
   никогда не обходит HARD_DENY, narrowing, sandbox, egress или budget.
3. Tier-3, необратимое и явно деструктивное действие не читает и не создаёт
   grant. Каждая exact карточка code-owned показывает target, последствие и
   доступность rollback.
4. Verification mutation/delegation остаётся обязательной внутри harness, но
   transport показывает один terminal result. Recovery instructions, receipt/
   delegation ids, provider attempts и неподтверждённые объяснения не входят в
   пользовательский ответ или следующую provider-facing историю.
5. `SOUL.md` остаётся стабильным операторски управляемым ядром. Явная поправка
   общения создаёт versioned typed preference и действует со следующего turn.
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
Для plan approval карточка до tap показывает bounded code-owned список
`planStepId/ordinal → plannedCallHash → matcherHash → savedScopeLabel`,
включённый в `planHash`; identity уникальна для каждого occurrence.
Каждый фактически admitted exact step получает deterministic child
`approvalOperationId` и проходит тот же WAL; пропущенный, непоказанный,
reordered или drifted step не получает grant.
Эта ADR заменяет пункт 7 ADR-0093 только для `auto/plan` и уточняет пункт 2
ADR-0103: inferred autonomy не действует в `confirm/plan`; direct operator grant
не является inferred autonomy.

Typed preference имеет exact `PreferenceScope = botId + operatorId + profileId`
и `PreferenceKey = PreferenceScope + descriptorFamily`. Immutable revision
хранит registry descriptor, source kind, hashed evidence refs и policy revision.
Write-ahead lifecycle и CAS active/previous pointer переживают crash. Pre-CAS
failure оставляет прежний active этой family; post-CAS ambiguity читается из
WAL/store. Corruption suppress'ит только повреждённую family до repair, не
удаляя revisions и не выключая независимые families; при отсутствии валидного
active она деградирует к стабильному `SOUL.md`. Precedence равно `current
authenticated turn > explicit preference > inferred preference > SOUL
defaults`; constitution/code policy всегда выше. Forget сначала снимает overlay,
затем очищает evidence с anti-resurrection tombstone. Rollback возвращает
только previous revision того же key.

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

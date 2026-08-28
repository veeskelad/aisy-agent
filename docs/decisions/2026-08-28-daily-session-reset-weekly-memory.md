# ADR-0109: Ежедневная новая Session и воскресная консолидация памяти

**Статус:** Принято
**Дата:** 2026-08-28
**Теги:** sessions, memory, nightly

## Контекст

Интерактивная Telegram Session сохраняет frozen prefix и модельную историю.
Append-only transcript и read-time compaction защищают аудит, но не дают
естественной календарной границы: старые вычисления, служебные объяснения и
случайные формулировки могут неделями влиять на новый разговор.

Существующий nightly scheduler одновременно означает ежедневную memory
consolidation. Для обычного `remember` это не нужно: защищённый факт публикуется
сразу, а generator/judge полезны как периодическая гигиена. Оператор выбрал
новую Session каждую ночь, `/resume` для прошлого разговора и полную
consolidation по воскресеньям.

## Решение

Session rotation и memory consolidation становятся двумя независимыми
scheduled lifecycle.

1. После configured local `AISY_NIGHTLY_AT` runtime один раз за календарный
   день и exact bot/operator/profile создаёт и выбирает новую Session активного
   Project, затем выполняет controlled restart. Отдельный purpose-bound
   `SessionRotationAuthority` сначала поднимает transition barrier, затем
   сверяет generation, пишет intent и создаёт Session; он дожидается старых
   leases и не принимается interactive switch path.
2. Полный transcript и frozen prefix старой Session не изменяются. `/resume`
   показывает и выбирает прежние Session через существующий one-use
   switch-authority и restart.
3. После barrier и повторной проверки generation write-ahead record фиксирует
   deterministic create key и заранее выбранный id до создания Session.
   Idempotent registry create закрывает crash между side effect и phase persist.
   Если generation устарела, record становится `cancelled-stale`, уже созданная
   Session остаётся неактивной и проходит обычный archive lifecycle. Новый
   intent строится только из актуальной selection. High-water scoped по
   bot/operator/profile.
4. Memory generator/judge, conflict/dedup и free-form skill drafts выполняются
   только по воскресеньям либо вручную. Ежедневные archival/day-log, retention,
   disk hygiene и backup сохраняются. Weekly cohort фиксирует общий cutoff и
   exact Project members; каждый member имеет собственный cursor range после
   прошлого успешного cutoff и terminal state. Успех одного Project не
   продвигает cursor другого, failure оставляет pending только его, а missed
   Sunday catch-up выполняется после следующего startup. Aggregate result
   публикуется после terminal state всех members как `complete-zero`,
   `complete-n` либо честный `partial-failure`; quarantined member нельзя
   представить как «правок нет». Поздний результат получает отдельный durable
   at-most-once outbox без повторного утверждения о начале Session, если daily
   reset уже состоялся. Exact manual/scheduled input переиспользует доказанный
   artifact по source/projection/precondition/config hashes без повторного
   provider call, сохраняя отдельные scheduled cursors. В `N` входит только
   valid `pending`; applied и
   rejected dedupe продвигают scheduled cursor без новой card, expired требует
   revalidation, forgotten/revoked запрещает reuse, corrupt даёт
   `partial-failure`.
5. Только доказанный `complete-zero` не обещает карточку. Следующий bare
   `Покажи` получает одноразовый code-owned ответ `Новых правок нет.` без
   provider. При `N > 0` новый process выдаёт single-use shortcut на exact
   staging. `partial-failure` сообщает число непроверенных Projects и открывает
   только доказанный успешный staging.
6. Durable goals, triggers, monitoring и subagent runs сохраняют исходный
   binding. Session rotation не является забыванием и не удаляет память,
   Skills, grants или transcript.
7. `/resume` не меняет private audit, но provider projection всегда повторно
   применяет текущие forget tombstones и revocations. Изменившаяся projection
   начинает linked provider generation вместо server-side resume старой history.
8. Startup notification использует durable at-most-once outbox с terminal
   `delivered|ambiguous`; ambiguous dispatch не повторяется.

## Последствия

- **Положительное:** новый день начинается без накопленной model history, но с
  актуальной памятью, Skills и стабильной личностью.
- **Положительное:** `/resume` возвращает точный разговор, а не summary,
  поэтому audit и незавершённая работа сохраняются.
- **Положительное:** weekly generator/judge снижает стоимость и шум, не
  задерживая явные memory writes.
- **Нейтральное:** воскресенье использует прежнее configurable local time;
  ручной `/consolidate` не меняет weekly high-water.
- **Отрицательное:** daily rotation требует crash-safe state machine и
  controlled restart; недоступный supervisor откладывает завершение.
- **Отрицательное:** возврат к старой Session также требует restart, потому что
  frozen prefix, leases и provider thread binding создаются на startup.

## Рассмотренные альтернативы

**Ежедневно переписывать summary той же Session.** Отклонено: summary может
закрепить ошибочную модельную формулировку и разрушает точный `/resume`.

**Сбрасывать только после 24 часов бездействия.** Отклонено: старый контекст
может пережить несколько календарных дней активного использования.

**Оставить ежедневную memory consolidation.** Отклонено: явная память уже
публикуется в turn, а ежедневный generator/judge создаёт лишние cost и cards.

## Ссылки

- [ADR-0040 — compaction как view](./2026-06-13-context-engine-compaction-as-view.md)
- [ADR-0064 — full-fidelity transcript](./2026-07-26-full-fidelity-session-transcript.md)
- [ADR-0079 — дневник дня](./2026-07-29-daily-journal-as-late-context.md)
- [Утверждённый дизайн](../superpowers/specs/2026-08-28-daily-session-adaptive-agent-design.md)

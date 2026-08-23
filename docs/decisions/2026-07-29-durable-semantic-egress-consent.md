# ADR-0088: Долговечное согласие на semantic egress памяти

**Статус:** Принято
**Дата:** 2026-07-29
**Теги:** memory, privacy, consent

## Контекст

ADR-0065 разрешает semantic/hybrid retrieval через OpenRouter только после
подключения provider и явного disclosure: наружу могут уйти текст запроса и
фрагменты памяти. Он также требует немедленно блокировать вызовы и очищать
provider-scoped derived state при revoke. Реализованные provider, sqlite-vec,
scanner, cache/revoke и reconciler пока остаются offline foundation.

Для live composition недостаточно boolean `enabled=true`. Согласие должно
переживать restart, быть связано с человеком, профилем, точным назначением,
provider connection, embedding descriptor и текстом disclosure. Иначе старое
подтверждение можно было бы переиспользовать после смены account, model или
категории отправляемых данных.

## Решение

Semantic egress разрешает отдельная code-owned `SemanticEgressAuthorityV1`.
Provider connection по ADR-0087 необходима, но сама по себе не является
согласием на отправку памяти.

Durable record содержит exact schema, `authorityId`, монотонную revision,
state/timestamps и следующие обязательные binding:

- actor: authenticated human `operatorId` и `profileId`;
- provider: `providerId`, `connectionId` и exact connection revision;
- purpose: только `memory.semantic-embedding.v1`;
- data scope: опубликованная live protected memory этого профиля — global и все
  текущие/будущие принадлежащие ему Projects; query и eligible fact chunks.
  Monitoring, transcripts, DNA/config, attachments, knowledge zones и archive
  не входят без новой purpose/disclosure revision;
- полный descriptor: provider, model id/revision, dimensions,
  normalization version и chunker version плюс hash его canonical serialization;
- disclosure: code-owned revision и hash, destination/provider, категории
  `query + chunks`, scope policy и точная формулировка, что Aisy запрашивает
  `data_collection=deny`, но не выдаёт это за гарантию третьей стороны;
- ссылки на code-minted approval proof и consumed one-use nonce, без текста
  запроса, chunks, source paths, credential или provider response.

Disclosure card создаётся только для текущей authority revision. Human tap
связывается с actor/profile/provider connection/purpose/descriptor/disclosure;
generic boolean, model claim, replay, stale card или изменённое поле не дают
разрешения. Любое изменение connection revision, purpose, descriptor, data scope
или disclosure делает прежнее согласие `BLOCKED` и требует нового tap.
До показа карточки runtime одной SQLite-транзакцией сохраняет
`AWAITING_CONSENT`, one-use nonce и redacted `disclosure_issued` в outbox.
Подтверждение одной транзакцией проверяет revision и exact binding, гасит nonce,
публикует `CONSENTED` и добавляет `consent_granted`. Раздельные публичные
store/nonce API запрещены: падение между этими действиями не должно оставлять
неаудированное или повторно используемое согласие.

Состояния и переходы:

`DISABLED → AWAITING_CONSENT → CONSENTED → ACTIVE`.

- `ACTIVE ↔ DEGRADED` допускается только для той же exact authority после
  content-free health check; в degraded semantic недоступен, hybrid явно
  использует keyword.
- Config `off` или `provider=none` переводит runtime в `SUSPENDED`: zero provider
  I/O, vector DB не открывается, consent не удаляется. Возврат exact config идёт
  через health check, а не через silent widening.
- Explicit disconnect/revoke сначала атомарно публикует `REVOKING`, увеличивает
  generation и запрещает новые вызовы; затем abort всех in-flight requests,
  фактический drain выданных use-lease, purge query/document cache и vectors во
  всех принадлежащих scope, проверка пустоты, durable audit и только потом
  `REVOKED`. Сам факт отправки `AbortSignal` не считается drain: зависший или
  игнорирующий abort владелец удерживает состояние `REVOKING` до `release`.
  Если уже началась code-owned публикация, revoke синхронно закрывает локальный
  gate и посылает abort, но durable `REVOKING` линейно ждёт окончания этого
  publish-fence; поэтому callback не может пересечь уже записанную границу.
- Ошибка purge, corrupt/unknown state или неоднозначная revision оставляет
  `REVOKING` либо `BLOCKED`; semantic I/O запрещён. `REVOKED` нельзя re-enable
  без нового consent proof.

На restart runtime сначала одной recovery-транзакцией восстанавливает все
authority. Незавершённая карточка другого boot остаётся исторически видимой как
`AWAITING_CONSENT` с `invalidatedAt`, но её nonce инвалидируется, revision и
generation увеличиваются, а старый tap больше не принимается даже при неудачной
очистке Telegram UI. Прежние `ACTIVE`/`DEGRADED` переходят в `SUSPENDED` и не
отправляют memory content до exact binding check и нового content-free health;
`REVOKING` возвращается recovery coordinator и завершает purge до создания
provider/reconciler. Неизвестная будущая schema и старый binary fail closed к
keyword-only. Каждый embed call повторно проверяет durable authority revision и
runtime generation непосредственно перед proxy I/O; reconciler запускается
только в `ACTIVE`.

Receipt `search_all_projects` остаётся дополнительной authority чтения и не
заменяет consent. Semantic revoke не удаляет credential, используемый другими
purpose; revoke provider connection, напротив, каскадно блокирует semantic.

Effective-once audit использует namespace `memory.semantic_egress.*`:
`disclosure_issued`, `consent_granted`, `activated`, `degraded`, `suspended`,
`stale`, `request_started`, `request_completed`, `revoke_started`,
`purge_completed`, `revoked`, `blocked`. События содержат только authority/
revision, actor/profile, connection revision, purpose, descriptor id,
disclosure revision/hash, transition, bounded kind/count/bytes/scope reference,
stable code и timestamp. Content, content hash, path, secret и upstream detail
запрещены. Existing `memory.embedding_input_blocked` остаётся redacted событием
scanner.
Record, nonce mutation и все соответствующие outbox events фиксируются одной
транзакцией. Outbox доставляется at-least-once строго в порядке durable
insertion sequence; устойчивый
`eventId` делает приём effective-once у идемпотентного получателя. Подтверждение
доставки атомарно принимает только текущую голову очереди, а exact повтор уже
подтверждённого события идемпотентен. Private outbox anchor хранит
минимальные code-only входы для повторного вычисления lifecycle/request/recovery
`eventId` после restart, но не попадает в доставляемое событие. После crash
недоставленные события повторяются, а несовпадающий payload, anchor или
`eventId` считается corruption и закрывает semantic path. Consent DB открывает
только владелец отдельной singleton SQLite writer lease; второй процесс
fail-closed не достигает consent DB и не создаёт штатный rollback journal,
который другой процесс мог бы ошибочно принять за tamper.

Offline recovery worker читает bounded batch, но доставляет его строго
последовательно: событие `n+1` не достигает sink до definitive
`accepted | duplicate-exact` и durable head-ack события `n`. Delivery timeout,
abort до ack, неизвестный ответ, `not-head`, `unknown` и любая ошибка не
подтверждают событие и останавливают pass. Delivery, durable read и head-ack
имеют отдельные code-owned timeout; delivery дополнительно получает
`AbortSignal`. Поздний
результат любой из этих операций не продолжает pass и не запускает следующую
доставку. `ACK_TIMEOUT` неоднозначен: ack мог durable примениться, поэтому он не
считается успехом, а следующий pass заново читает фактическую голову.
Concurrent passes для одного durable port коалесцируются, а stop идемпотентен.
Sink обязан хранить
идемпотентность по `eventId` и на duplicate сравнивать exact canonical payload.
Durable port является проверенной внутренней границей: до возврата события он
повторно связывает payload, private anchor и `eventId`; worker затем независимо
проверяет exact redacted envelope и никогда не передаёт anchor в sink.

Старт каждого semantic-вызова использует не общий transition, а отдельную
атомарную операцию `consumeUseIfActive`: exact `ACTIVE`, authority id/revision,
generation и binding hash проверяются в той же транзакции, где гасится use nonce
и создаётся `request_started`. До успешного commit provider I/O запрещён.
Authority регистрирует use-lease под per-slot барьером и выдаёт владельцу
`AbortSignal`; публикация derived state возможна только через метод lease под
тем же барьером. Поэтому публикация либо линейно завершается до `REVOKING` и
затем попадает под purge, либо после `REVOKING` не запускается вовсе.
`DEGRADED`, `SUSPENDED`, `BLOCKED` и повторная boot recovery используют ту же
границу: локальный gate и signal закрываются немедленно, а durable transition
ждёт уже вошедший publish callback. Неоднозначная ошибка durable revoke также
оставляет процесс локально закрытым и abort'ит выданные lease.

Это решение не является live activation. До реализации broker/proxy integration
и startup/post-commit composition
`aisy run` не отправляет query или chunks внешнему embedding provider.

## Последствия

- **Положительное:** отправка памяти становится проверяемым человеческим
  решением, а не следствием наличия API key или config flag.
- **Положительное:** revoke и restart имеют fail-closed порядок, исключающий
  позднюю запись vector/cache после отзыва.
- **Нейтральное:** смена account/model/disclosure требует повторного consent и
  rebuild затронутого derived scope.
- **Отрицательное:** отдельная authority state machine, durable nonce/outbox и
  fault-injection matrix усложняют live composition.

## Рассмотренные альтернативы

**Считать подключение OpenRouter согласием на embeddings.** Отклонено: один
credential может обслуживать другие purpose, не отправляющие личную память.

**Хранить один бессрочный consent по имени provider.** Отклонено: он пережил бы
смену account, model, data scope или disclosure без нового решения оператора.

**Удалять consent при аварийном `off`.** Отклонено: rollback должен мгновенно
останавливать egress без необратимого изменения operator-owned выбора; explicit
revoke остаётся отдельной purge-операцией.

## Ссылки

- [ADR-0065 — hybrid vector and keyword retrieval](./2026-07-26-hybrid-vector-keyword-retrieval.md)
- [ADR-0058 — первоначальная настройка и подключения «мозга»](./2026-07-26-telegram-first-bootstrap-brain-connections.md)
- [ADR-0087 — opaque secret broker/backend/proxy](./2026-07-29-opaque-secret-broker-backend-proxy.md)
- [ADR-0029 — provenance человеческого подтверждения](./2026-06-11-human-confirmation-provenance-binding.md)

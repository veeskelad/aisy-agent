# Компонент 18: Мониторинг и evidence-linked дайджесты

**Статус:** RSS/Web LIVE в коде; целевая эксплуатационная приёмка ожидается
**Компонент:** 18 / 18  
**Связанные ADR:** ADR-0062, ADR-0060, ADR-0061, ADR-0027, ADR-0018  
**Зависит от:** Projects/Sessions (17), Safety (05), Provider Routing (09),
Observability (12), Triggers (14)

## 1. Назначение

Компонент превращает внешние источники в воспроизводимый локальный корпус и
мобильный дайджест, где каждый вывод связан с первичным evidence. Периодический
LLM heartbeat запрещён: сбор и change detection выполняются детерминированным
кодом, а scorer вызывается только для новых, изменённых или ранее не оценённых
элементов под отдельным бюджетом.

Базовый конвейер:

```text
source registry → deterministic collector → normalize/hash/dedupe → SQLite/FTS5
→ budgeted scorer (untrusted) → decay/diversity rank → evidence-linked digest
→ staged operator feedback
```

## 2. Граница ответственности

Компонент владеет:

- registry источников Telegram, RSS, YouTube, GitHub и web;
- immutable `WorkBinding` каждой source/digest/feedback записи;
- deterministic HTTP collection, cursor/ETag и ограничением размера ответа;
- нормализацией, content hash, дедупликацией и локальным SQLite/FTS5;
- budget gate для scorer, time decay, source/author diversity;
- persisted delivery window и evidence links;
- staged feedback `important | not-useful`, который сам не меняет policy.

Компонент не владеет:

- токенами и API secrets: в registry хранится публичный locator, secret lookup
  остаётся в Vault/connection layer;
- разрешением внешних действий: Safety и egress guard остаются обязательными;
- Telegram rendering и фактической отправкой: delivery adapter получает только
  due digest после повторной проверки binding;
- автоматическим promotion preference/policy: feedback проходит ADR-0061.

## 3. Долговечная модель

`MonitoringSource`, `MonitoringDigest` и `MonitoringFeedback` имеют
`schemaVersion` и non-null `ResolvedWorkBinding`. Route key определяется как:

- Workspace: owner/profile/workspace-project/`workspace`;
- Project: owner/profile/project/`project`;
- Session: owner/profile/project/session/`session`.

Project A никогда не читает источники, evidence или digest Project B. Смена
interactive selection не меняет сохранённый route. Legacy/unscoped или
повреждённая запись переводится в `quarantined` и исключается из poll/delivery;
она не становится global.

SQLite хранит:

- `monitoring_sources` — type, locator, criteria, interval, cursor, lifecycle;
- `monitoring_evidence` — source/external id, primary URL, title/text/author,
  publication/collection time, hash, provenance, score и scoring state;
- `monitoring_fts` — rebuildable FTS5 index;
- `monitoring_digests` — binding, окно выборки/доставки, items и receipt;
- `monitoring_feedback` — только staged feedback.

Файл базы создаётся с mode `0600`; каталог управления — `0700`. WAL/backup
входят в тот же защищённый control root и migration/rollback manifest.

## 4. Сбор и change detection

Core collector принимает только public HTTP(S) locator и отклоняет userinfo,
localhost и private/link-local literal адреса до port I/O. Реальный network I/O
обязан идти через внедрённый `MonitoringHttpPort`: этот security boundary
выполняет DNS/IP allowlisting, проверяет каждый redirect до следующего запроса
и прекращает чтение после `maxBytes`. В Node composition нет ambient/global
`fetch` fallback: без egress-authorized порта monitoring не собирается.

Добавление source устойчиво сохраняет code-owned grant
`exact sourceId → exact HTTPS domain`. Для URL locator domain берётся из
нормализованного URL; для Telegram channel и YouTube channel ID код выводит
соответственно `t.me` и `www.youtube.com`. Разрешены только HTTPS, port 443 и
GET; userinfo, credential-like query, IP literal, wildcard и наследование
subdomain запрещены. Пауза source оставляет grant неизменным, но poll не
выполняется. Удаление одной транзакцией ставит source tombstone и очищает grant;
ответ, завершившийся одновременно с удалением, отбрасывается до collector/
storage. Locator/domain immutable: смена domain требует удаления source и новой
явной регистрации. Legacy source без grant не получает authority при миграции
и карантинируется.

`MonitoringHttpPort.get` всегда получает exact `sourceId`. Перед DNS, перед
каждым redirect-hop и после awaited transport он повторно читает grant. Каждый
DNS-ответ должен быть публичным, выбранный IP закрепляется в socket lookup и
сверяется с фактическим remote address при сохранённом TLS server name.
Same-domain redirect проходит полную проверку заново; cross-domain redirect
закрывается до второго запроса. Port не принимает Authorization/cookies и не
имеет global/ambient fetch fallback.

RSS/Atom и публичные feeds используются для RSS, YouTube и GitHub releases.
Публичная Telegram web-страница и обычная web-страница нормализуются локально.
Ответ ограничен двумя мегабайтами до разбора. Cursor — ETag, Last-Modified или
SHA-256 body. Одинаковый cursor возвращает пустой batch.

Public HTTP(S) invariant повторно проверяется на общей ingest-границе: даже
внедрённый или будущий collector не может сохранить localhost/private literal,
userinfo или неподдерживаемую схему и не вызывает scorer после такого отказа.

Каждый item нормализуется, получает canonical primary URL и content hash.
Одинаковый `(route, content_hash)` не создаёт вторую evidence запись. Изменение
существующего `(source, externalId)` инвалидирует только его старый score и FTS
row. Неизменённый ранее оценённый item не вызывает scorer.

## 5. Scoring и безопасность модели

Scorer получает только новый/изменённый/pending item, критерии источника и
code-owned поля:

```ts
{ provenance: 'untrusted', outboundAllowed: false }
```

Он возвращает ограниченный `score 0..1`, категорию
`critical | important | useful | noise`, summary и `whyUseful`. Невалидный
ответ не публикуется; item остаётся `needsScoring` для явной повторной попытки.
Лимит `maxScoringCalls` проверяется кодом до каждого batch.

## 6. Построение и доставка дайджеста

Выборка ограничена binding и временным окном. `noise` исключён по умолчанию.
Итоговый rank:

```text
rank = rawScore × 0.5 ^ (ageHours / halfLifeHours)
```

После сортировки применяются `maxItems`, `maxPerSource` и `maxPerAuthor`.
Каждый `DigestItem` обязательно содержит `evidenceId`, `sourceId` и
`primaryUrl`; summary без ссылки не считается evidence-linked результатом.

Digest сохраняется со статусом `ready`, `notBefore` и `expiresAt`. Delivery
worker перед внешним I/O снова разрешает exact binding. Archived/missing
контекст переводит digest в `paused`; delivered ставится только по receipt
адаптера. Code-owned coordinator ограничивает один tick диапазоном 1–100
дайджестов и передаёт адаптеру `digest.id` как стабильный idempotency key.
Пустой receipt или исключение адаптера не раскрывает текст ошибки и оставляет
digest в `ready` для контролируемого повтора. Просроченный ready digest
становится `expired` и не отправляется. Сам coordinator не содержит таймера и
конкретного транспорта: его создание не активирует сеть или Telegram.

Telegram view формируется отдельно в чистом gateway: русские заголовки,
категория, ограниченные summary/`whyUseful` и кликабельный `primaryUrl` для
каждого показанного пункта. До транспорта валидируется весь digest, untrusted
текст и HTML attributes экранируются, а видимая длина не превышает 4096
символов. Adapter принимает только exact `telegram:<chatId>`, совпадающий с
code-owned `allowedChatId`; foreign/malformed route и пустой digest дают ноль
I/O. Egress guard проверяет тот же exact HTML payload, который затем отправляет
transport. Receipt строится только из положительного Telegram `message_id`.
Создание view/adapter не регистрирует handler, timer или scheduler.

Production Telegram adapter ставит durable `0600` at-most-once fence до
`sendMessage`. Ledger связывает `digest.id` с exact chat и hash уже проверенного
HTML. Сохранённый receipt после restart возвращается без повторного Telegram I/O.
Если процесс потерял ответ после возможного принятия сообщения Telegram, запись
остаётся `sending`: автоматический повтор запрещён как ambiguous вместо риска
дублирующей доставки. Повреждённый ledger не сбрасывается и отключает LIVE tick.

Единый app scheduler предоставляет optional `tickMonitoring`, изолированный от
trigger/goal/nightly ошибок. Callback отсутствует по умолчанию и поэтому ничего
не активирует. Production composition вправе передать его только вместе с
явными budget, egress и delivery ports; откат — удалить callback, не меняя
сохранённые sources/evidence/digests.

Первый LIVE-срез включает source-management UI для `rss` и `web`, bounded
`tickMonitoring`, scorer без tool catalog и Telegram delivery adapter. Startup
и scheduler при пустом registry выполняют zero HTTP/model/Telegram I/O. Добавление
source — единственная активация его exact-domain grant и последующего poll.
Откат `AISY_MONITORING=0` убирает UI/tick/delivery без удаления DB.

Telegram-кнопка «Монитор» перед каждым локальным чтением повторно разрешает
exact binding. Root screen показывает aggregate counters и ведёт в bounded
каталог. Каталог раскрывает только kind, exact hostname, состояние и период;
path/query, criteria, cursor, evidence и digest content в UI не попадают.
Callback — code-minted process-local one-use token, связанный с principal,
message id, exact binding/source и operation; replay, foreign principal,
старый message и смена binding дают zero mutation. Remove имеет отдельный
confirmation screen и отзываёт grant, но сохраняет evidence/digests.

RSS по умолчанию собирается не чаще раза в 15 минут, Web — раза в 60 минут.
Один scheduler tick ограничен 3 sources, 20 collected items и 8 scoring calls.
Daily digest по умолчанию строится в 08:00 timezone оператора за предшествующие
24 часа, живёт 48 часов и содержит не более 10 items, 3 на source и 2 на
author. Bounded environment overrides не могут создать отрицательный или
неограниченный budget. Durable marker и проверка exact binding/window в DB не
дают restart построить второй digest того же окна.

Ошибка optional DB/state даёт явное «состояние недоступно», оставляет
сбор/доставку выключенными и не отключает базового агента.

## 7. Failure modes и rollback

| Сбой | Поведение |
|---|---|
| Context archived/missing | source/digest paused до collector/delivery I/O |
| Collector/network error | code-only failure; source paused, без scorer |
| Scoring budget исчерпан | evidence остаётся pending, другие scores не повторяются |
| Scorer error/invalid output | item остаётся pending, digest его не использует |
| Повреждённый/unscoped record | persisted quarantine, не global fallback |
| DB/FTS повреждён | monitoring fail-loud/unavailable без пустого fallback; базовый агент остаётся доступен, rebuild FTS идёт из evidence, не наоборот |
| Delivery без receipt | статус не меняется на delivered |
| Telegram send остался ambiguous | durable fence запрещает повтор exact key; LIVE требует операторского разбора, а не угадывает результат |

Откат не удаляет evidence: scheduler/delivery останавливается, SQLite и bindings
сохраняются для повторной проверки или возврата к предыдущему runtime.

## 8. Критерии приёмки

1. **AC-18-1:** source без валидного binding не регистрируется.
2. **AC-18-2:** restart восстанавливает exact binding и cursor.
3. **AC-18-3:** source Project A не виден из Project B после switch/restart.
4. **AC-18-4:** archive останавливает poll до collector/scorer I/O.
5. **AC-18-5:** одинаковый уже оценённый item вызывает ноль scorer/model calls.
6. **AC-18-6:** изменение item инвалидирует и пересчитывает только этот item.
7. **AC-18-7:** одинаковый content hash в одном route дедуплицируется.
8. **AC-18-8:** scorer всегда получает `untrusted` и `outboundAllowed=false`.
9. **AC-18-9:** scoring budget оставляет лишние items pending и не теряет их.
10. **AC-18-10:** FTS5 search возвращает evidence только своего binding.
11. **AC-18-11:** egress port отклоняет private/DNS-rebound redirect до второго HTTP request.
12. **AC-18-12:** egress port прекращает чтение response body при `maxBytes`.
13. **AC-18-13:** все пять connector families имеют deterministic adapters.
14. **AC-18-14:** ranking применяет time decay и source/author diversity.
15. **AC-18-15:** каждый digest item содержит primary evidence URL.
16. **AC-18-16:** restart сохраняет due digest и его Project A binding.
17. **AC-18-17:** archive перед delivery ставит digest на паузу без I/O.
18. **AC-18-18:** feedback сохраняется staged и cross-project feedback запрещён.
19. **AC-18-19:** unscoped persisted digest карантинируется, а не становится global.
20. **AC-18-20:** delivery status меняется только после непустого receipt.
21. **AC-18-21:** passive live composition восстанавливает source counts после
    restart и не вызывает HTTP, scheduler или delivery I/O.
22. **AC-18-22:** status source повторно разрешает exact binding до store read,
    а UI не содержит locator/criteria/content.
23. **AC-18-23:** binding/DB failure возвращает только безопасный unavailable
    status с выключенными collection/delivery и не раскрывает ошибку.
24. **AC-18-24:** Telegram-кнопка «Монитор» показывает monitoring status,
    а не spend report, и не запускает model turn.
25. **AC-18-25:** регистрация сохраняет exact `sourceId → HTTPS domain` grant;
    pause/resume его не меняют, exact remove отзывает, а foreign binding не
    может поставить source на паузу, возобновить или удалить.
26. **AC-18-26:** locator/domain immutable; попытка изменить domain через
    update отклоняется, старый grant сохраняется, новый появляется только у
    новой явно зарегистрированной source.
27. **AC-18-27:** egress допускает только exact host/443/GET и публичный
    DNS-pinned address; parent/sibling subdomain, IP literal, userinfo,
    credential-like query и нестандартный порт дают zero DNS/transport I/O.
28. **AC-18-28:** same-domain redirect повторяет authority+DNS gauntlet, а
    cross-domain redirect закрывается до второго transport request.
29. **AC-18-29:** удаление во время awaited response не передаёт body collector;
    legacy source без persisted grant не получает authority и карантинируется.
30. **AC-18-30:** production composition создаёт hardened port, но без
    scheduler/source UI/delivery остаётся пассивной и выполняет zero startup HTTP.
31. **AC-18-31:** LIVE Telegram UI регистрирует только RSS/Web HTTPS source через
    principal/message-bound one-use token; callback replay или foreign/stale
    binding даёт zero mutation.
32. **AC-18-32:** каталог source не показывает path/query/criteria/cursor/content,
    pause сохраняет exact grant, а подтверждённый remove атомарно его отзывает.
33. **AC-18-33:** пустой registry выполняет zero collector/scorer/delivery I/O;
    непустой tick соблюдает code-owned limits sources/items/scoring calls.
34. **AC-18-34:** monitoring scorer использует provider без tools, а invalid,
    timed-out или tool-calling response оставляет item pending.
35. **AC-18-35:** restart между build и delivery не создаёт второй digest exact
    binding/window; delivery status появляется только после Telegram receipt.
36. **AC-18-36:** `AISY_MONITORING=0` отключает UI/tick/delivery без удаления
    sources, grants, evidence или ready digests.
37. **AC-18-37:** Telegram send-ledger сохраняет claim до transport I/O; restart
    возвращает известный receipt без повтора, а `sending` или reuse exact key с
    другим chat/payload дают zero повторных Telegram I/O.

## 9. Проверки релиза

- deterministic collector fixtures и cursor/idempotency tests;
- dedupe/change/zero-model/budget tests;
- arbitrary collector не обходит public-evidence ingest invariant и даёт ноль
  storage/scorer effects;
- FTS5 binding isolation;
- digest golden data с decay/diversity/evidence links;
- restart/switch/archive/quarantine tests;
- delivery coordinator tests: bounded batch, binding-before-I/O, stable
  idempotency key, empty receipt и redacted adapter failure;
- Telegram renderer/adapter tests: HTML injection, URL attribute escaping,
  4096 limit, exact chat route, guard-before-send, empty/no-I/O и receipt;
- Telegram send-ledger tests: atomic `0600` state, receipt recovery после
  restart, payload/route mismatch и fail-closed ambiguous send без повтора;
- scheduler test: optional monitoring tick выполняется каждый цикл, а его ошибка
  не блокирует nightly и следующий pump;
- passive status tests: restart восстанавливает counts без HTTP I/O,
  binding проверяется до store read, Telegram показывает только
  aggregate status и не запускает turn;
- SSRF/DNS/redirect и body-limit security tests конкретного egress-port adapter;
- lifecycle corpus exact grant: register, pause, resume, foreign remove,
  immutable domain, exact remove, legacy migration и revoke во время response;
- полный `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` до подключения
  scheduler и Telegram delivery.

# Первый LIVE-срез monitoring: RSS/Web → Telegram

**Дата:** 2026-08-12
**Статус:** реализован в коде (вариант A); целевая приёмка ожидается
**Связанные решения:** ADR-0062, ADR-0084, спецификация компонента 18

## 1. Результат

После обновления `aisy run` monitoring перестаёт быть только пассивным
локальным registry. Оператор может из Telegram добавить RSS или обычную HTTPS
страницу, приостановить, возобновить и удалить источник. In-process scheduler
собирает только due sources, оценивает новые или изменённые материалы моделью
без tools, один раз в сутки строит evidence-linked digest и доставляет его в
тот же allowlisted Telegram chat.

Добавление источника является явным действием, которое одновременно сохраняет
code-owned read-only grant только на exact HTTPS domain этого source. Пауза
останавливает poll, но сохраняет grant; удаление ставит tombstone и атомарно
отзывает grant. Parent, sibling и subdomain не наследуют разрешение.

## 2. Минимальный scope

В первый LIVE-срез входят:

- connector families `rss` и `web`;
- Telegram-каталог текущего exact WorkBinding;
- добавление source из одного сообщения: первая строка — HTTPS URL, остальные
  строки — необязательные критерии этого source;
- pause, resume и двухшаговый remove;
- bounded collection/scoring tick;
- один daily digest с durable защитой от повторной сборки того же окна;
- доставка через существующий renderer, exact chat route и Gateway safety
  guard;
- restart, binding, zero-source/zero-I/O и rollback tests.

Не входят Telegram/YouTube/GitHub source UI, произвольное редактирование locator,
настройка расписания и ranking в Telegram, monitoring feedback/follow-ups и
автоматическое расширение egress. Эти части остаются dormant, хотя их core
primitives уже существуют.

## 3. Telegram authority и приватность

Callback содержит только случайный process-local one-use token. Token связан с
exact `{chatId, userId, messageId, binding, sourceId, operation}` и тратится до
первого `await`. Старый экран, другой principal, повторный tap или сменившийся
binding не выполняют mutation.

Каталог показывает kind, exact hostname, состояние и период, но не path/query,
criteria, cursor, evidence или digest content. URL из формы проходит существующий
registry validator: только HTTPS/443 без userinfo, IP literal и credential-like
query. Locator immutable; для смены domain нужно удалить source и добавить новый.

Удаление имеет отдельный confirmation screen. Оно отзыёт только grant exact
source и не удаляет собранные evidence/digest, поэтому operational rollback не
теряет корпус.

## 4. Production composition

Monitoring runtime создаётся после provider composition. Scorer использует
routine/default adapter с пустым tool catalog; untrusted material не получает
outbound/tool authority. Без доступного provider item остаётся pending.

Scheduler получает `tickMonitoring` только когда runtime собран и
`AISY_MONITORING != 0`. Default-on безопасен: до явного добавления source tick
делает локальные bounded reads и zero HTTP/model/Telegram I/O.

Значения по умолчанию:

- RSS poll — 15 минут, Web poll — 60 минут;
- один tick: до 3 sources, 20 collected items и 8 scoring calls;
- digest — 08:00 в timezone оператора, окно 24 часа, expiry 48 часов;
- до 10 items, 3 на source и 2 на author.

Bounds и digest time могут быть сужены environment configuration; invalid
значение не активирует unbounded работу, а откатывается к безопасному default.
Daily state хранит только дату/границы окна, без locator/content, атомарно с
mode `0600`. Перед новым digest runtime проверяет как state, так и уже
сохранённый exact binding/window, поэтому restart после build не создаёт второй
digest.

Delivery повторно разрешает binding, проверяет Gateway outbound lock и exact
allowlisted chat, затем отправляет тот HTML payload, который прошёл guard.
Digest становится `delivered` только после положительного Telegram
`message_id`. Durable `0600` ledger сохраняет claim exact `digest.id + chat +
payload hash` до transport I/O и кеширует receipt: restart после receipt не
повторяет send. Потерянный ответ после возможного принятия Telegram остаётся
ambiguous и fail-closed — автоматический повтор того же key запрещён.

## 5. Failure и rollback

- ошибка одного source не останавливает scheduler или базовый агент;
- context/archive failure паузит source/digest до внешнего I/O;
- scorer timeout/invalid JSON оставляет evidence pending;
- Telegram failure не создаёт delivery receipt;
- ambiguous Telegram send сохраняет durable fence и не повторяется автоматически;
- повреждённый monitoring DB/state даёт unavailable status и не включает
  ambient fetch;
- `AISY_MONITORING=0` убирает source controls и `tickMonitoring`, сохраняя DB;
- откат binary сохраняет sources, grants, evidence и ready digests.

## 6. Проверка

Готовность подтверждают:

1. one-use principal/message-bound callbacks и stale/replay tests;
2. add/pause/resume/remove corpus с exact grant lifecycle;
3. RSS/Web-only validation и отсутствие path/query в UI;
4. bounded tick, scorer-without-tools и zero-source/zero-I/O tests;
5. daily-window idempotency после restart;
6. delivery guard-before-send, exact chat и receipt-after-send tests;
7. restart recovery и ambiguous-send/no-repeat tests durable Telegram ledger;
8. production composition test с `collectionActive=true` и
   `deliveryActive=true` только при активированном runtime;
9. package tests, workspace typecheck/build и `git diff --check`.

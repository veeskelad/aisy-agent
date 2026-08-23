# Security/restart/rollback review: журнал сессии v2

**Дата:** 2026-07-27  
**Область:** core transcript, Node WAL store, offline Agent Loop/AgentRunner seam  
**Результат:** critical/high findings реализованной офлайн-границы закрыты;
review не разрешает live activation или migration cutover.

## Найдено и исправлено

### F-1 — Caller мог попытаться передать load-bearing authority

Append принимает только input fields. `loadBearing`, classifier version,
sequence и hashes вычисляет core; любой лишний ключ отклоняется до classifier и
persistence.

### F-2 — Idempotent duplicate мог скрыть повреждённую цепочку

Duplicate теперь ищется только после полной проверки manifest, sequence и hash
chain. Повтор event id не превращает повреждённую session в успешную.

### F-3 — Metadata-only manifest мог скрыть физические rows

Read и append проверяют отсутствие строк у legacy session. Найденная строка
вызывает quarantine; exact resume не фабрикуется.

### F-4 — Crash после WAL мог выглядеть как окончательный отказ

После durable публикации WAL adapter возвращает отдельный uncertain outcome.
Restart завершает commit exactly once, а retry с тем же event id становится
duplicate.

### F-5 — Recovery мог обрезать чужой partial tail

Обрезается только byte-prefix точной row из WAL. Любой чужой фрагмент остаётся
неизменным и переводит session в quarantine. WAL и row также проходят
exact-fields gate; скрытый authority field отклоняется до публикации row и
изменения manifest.

### F-6 — Per-turn idempotency могла зависеть от текста

Event id строится только из domain, session, transport-owned turn id и ordinal.
Приватный content не попадает в identifier. Stable timestamp обязателен, поэтому
точный retry формирует тот же append, а несовпадающий retry закрывается.

### F-7 — Ошибка transcript могла пропустить следующий tool dispatch

Вход записывается до provider, ответ provider — до обработки tool calls. Ошибка
recorder прекращает цепочку и не позволяет последующему инструменту выполниться.

### F-8 — Hook-modified tool мог попасть в историю под старым именем

Tool span создаётся из effective call после PreToolUse/PostToolUse. Один и тот же
span сохраняется и передаётся synthesis round; исходное имя модели не выдаётся
за реально выполненное.

### F-9 — Ответ модели наследовал доверие оператора

Assistant responses и tool results маркируются `untrusted`. Только system spans
и deterministic failure reply, созданные кодом, получают operator provenance.

### F-10 — Manifest и model prefix могли разойтись

Agent Loop раньше замораживал prefix внутри себя, а recorder начинался только с
append. Теперь обязательный session-start получает точный объединённый snapshot
до первой строки. При restart существующий manifest возвращает stored prefix и
заменяет изменившийся memory/Skills candidate до model I/O. Реальный
AgentRunner→Node store test доказывает совпадение model bytes, manifest hash и
продолжение sequence/hash head после restart.

### F-11 — Durable rows не возвращались в model history

Новый AgentRunner раньше продолжал hash chain, но provider видел только текущий
turn. Теперь history projector сначала вызывает проверяющий всю цепочку
`transcript.read()`, затем применяет Context Engine как read-only view. Pinned
prefix не дублируется; verbatim сохраняет role/provenance, summary становится
непривилегированным user span со строгим provenance. Это не позволяет
скомпактированному untrusted content получить system priority. Agent Loop
добавляет view перед текущим входом и не пишет его обратно. Restart integration
проверяет фактический второй model request, а не только состояние файлов.

### F-12 — Resume мог читать или писать transcript после смены контекста

Добавлена `makeLeaseBoundTranscriptRecorder`: она допускает только exact
operator/profile/project/session binding, резервирует каждую операцию в
`ContextLeaseCoordinator` и вызывает `beginIo()` до delegate. Stale/closed lease
и несовпадающий request session отклоняются до transcript I/O. Операция, которая
уже вошла в I/O, корректно дренируется, пока quiesce ждёт закрытия lease.
Unit-тесты покрывают start, history, record, binding/request mismatch,
stale-before-I/O и in-flight drain; restart
integration использует эту обёртку с реальным Node store.

### F-13 — Telegram transport не передавал стабильную turn authority

Интерактивный Telegram handler теперь выводит content-independent `turnId` из
chat id и точного упорядоченного списка `update_id`, а `turnTs` — из самого
раннего `message.date`. Coalesced и steering batches сохраняют transport
metadata до вызова runner. Retry того же exact batch даёт ту же authority;
другой состав или порядок получает другой id. Пустые, отрицательные и
нецелочисленные значения, а также повтор `update_id` внутри batch отклоняются до
runner.

### F-14 — Production composition существовала только внутри тестового fixture

Добавлена app-фабрика `makeNodeLeaseBoundSessionTranscriptRecorder`, которая
собирает реальный Node store, core transcript, history projection, recorder и
lease wrapper. Delegate создаётся лениво внутри уже зарезервированной lease
operation. Поэтому mismatched binding отклоняется при сборке без создания
каталогов; binding/budget захватываются до lazy I/O и не меняются при мутации
caller object. Простое наличие фабрики не включает v2 writes. Restart
integration теперь использует именно production-фабрику.

## Restart и rollback

- WAL recovery проверен на crash после WAL, row и manifest;
- quarantine и права `0700`/`0600` переживают restart;
- legacy log не меняется и остаётся rollback source до cutover;
- live recorder не установлен, поэтому текущий production runtime не начал v2
  writes и не требует удаления новых данных для отката;
- uncertain commit нельзя автоматически повторять с новым turn id: сначала
  требуется recovery, затем exact retry.

## Остаточные ограничения

- Session-start seam готов, но production Telegram/background composition ещё
  не устанавливает готовую Node-фабрику и не передаёт binding/lease; background
  также не имеет transport-owned turn authority. Поэтому live v2 writes
  остаются выключенными.
- Core сериализует writers внутри процесса, но Node store не содержит
  межпроцессного lock. До activation supervisor обязан доказать singleton либо
  должен появиться durable writer lease.
- Нормализованный tool span ограничен 8000 символами. Сырой output/evidence
  требует отдельного content-addressed evidence store, если нужен для аудита.
- Offline Context Engine projection и recorder связаны с
  `TurnContextLease`/generation через проверенную обёртку, но production
  Telegram/background transport пока не создаёт и не передаёт эту композицию.
  Поэтому stale-context race в live path остаётся закрыт feature gate до
  отдельной проводки и transport E2E.
- Partial-turn replay не завершён: после crash между provider/tool событиями
  runtime пока не умеет отделить уже записанные события текущего `turnId` от
  истории предыдущих завершённых turns. Повторный dispatch запрещено включать
  live до отдельного deterministic recovery contract.
- Telegram authority стабильна для точного batch, но сам debounce batch ещё не
  журналируется до provider. После process crash повторная доставка тех же
  updates может получить другую группировку; live transcript gate нельзя
  открывать до durable ingress/coalescing contract.
- Background goal/trigger dispatch пока не имеет заранее сохранённых
  `turnId/turnTs`. Генерация из wall clock при запуске была отвергнута как ложная
  идемпотентность; нужен durable dispatch record до provider I/O.
- Frozen prefix фиксирует Skills-menu, но lazy Skill body следующего turn пока
  берётся из catalog нового процесса. Перед live resume catalog revision/hash
  нужно связать с session либо применить явную совместимую revision policy.
- Текущая модель spans не сохраняет provider-native tool-call ids. Если live
  adapters начнут зависеть от native ids, потребуется новая schema/codec, а не
  молчаливое расширение v1.
- Нет retention/rotation, шифрования at rest, export/recovery UI и безопасного
  лимитного rollover общего JSONL.
- SHA-256 chain обнаруживает изменение, но не защищает от процесса с теми же
  OS-правами; локальная граница доверия остаётся account permissions.
- Legacy registration и migration boundary ещё не подключены к migration
  coordinator; `V2_WRITES_ENABLED` остаётся закрыт.

## Доказательства инкремента

- 13 core transcript tests;
- 5 recorder adapter tests;
- 8 Agent Loop/AgentRunner transcript contract tests внутри расширенных наборов;
- 8 Node WAL/restart tests;
- 1 AgentRunner→recorder→Node store restart integration test, включая изменённый
  memory/Skills candidate и фактическую prior history во втором model request;
- 3 Context Engine history projection tests;
- 5 lease-bound transcript recorder tests;
- 4 Telegram turn-authority/runner tests;
- 1 steering metadata alignment test;
- 3 production Node composition/mutation/restart tests;
- полный regression: build/typecheck зелёные; 1179 core + 102 Telegram +
  189 app = 1470 TypeScript tests;
- Python sidecar: 29 passed, 1 platform-specific skip; Ruff и
  `git diff --check` зелёные;
- локальный приватный эталон подтверждён как ignored; tracked/staged файлов из
  него нет, имя и путь не публикуются;
- GitHub repository `veeskelad/aisy-agent` проверен через API: visibility
  `PRIVATE`.

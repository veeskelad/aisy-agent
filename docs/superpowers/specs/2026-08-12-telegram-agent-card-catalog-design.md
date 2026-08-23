# Telegram-каталог и полный lifecycle Agent Cards

**Дата:** 2026-08-12  
**Статус:** реализован в production composition; registry cutover остаётся за
отдельным exact opt-in gate и на целевом хосте не включался
**Связанные решения:** ADR-0069, спецификация компонента 20

## 1. Задача

Durable registry Agent Cards уже подключён к `aisy run`, но Telegram управляет
только картой, имя которой процесс получил из `AISY_MAIN_AGENT_CARD`. В результате
non-builtin subagent может запускаться из registry, но оператор не может с
телефона найти произвольную Workspace/current Project карту, опубликовать её
новую ревизию, архивировать, восстановить или явно импортировать legacy-файл.

Нужен полный Telegram selector/CRUD поверх существующей authority без второго
реестра, silent import и вывода DNA в transport.

## 2. Цели и не-цели

### Цели

- показывать bounded redacted-каталог всех имён, которые уже имеют историю в
  exact Workspace или текущем Project binding;
- позволять выбрать exact `{binding, name}` как объект управления;
- создавать новую карту из полного Markdown draft;
- публиковать новую ревизию выбранной карты;
- архивировать active revision и восстанавливать/откатывать только новой
  forward revision;
- явно импортировать `.aisy/agents/<exact-name>.md` как revision 1;
- сохранять Tier-3 Gateway proof, exact Project isolation, durable atomic save,
  redacted UI/audit и opt-in production cutover без изменений.

### Не-цели

- selector не меняет `AISY_MAIN_AGENT_CARD`, process environment или активную
  main-карту текущего процесса; он выбирает только объект управления;
- UI не включает `AISY_AGENT_CARD_REGISTRY=1` и не активирует monitoring;
- builtin `general` не публикуется и не импортируется;
- content/identity существующих revision не редактируются и не удаляются;
  lifecycle status меняется только по forward state machine раздела 4.1;
- DNA/body не показывается в каталоге, detail screen, callback или audit;
- массовые операции, наследование Workspace→Project и слияние capability matrix
  не вводятся;
- Session-scope не вводится.

## 3. Рассмотренные варианты

### A. Полный Telegram selector/CRUD — выбран

Registry выдаёт redacted exact-каталог, Telegram выбирает карту коротким
code-minted token и все mutations выполняет существующий lifecycle controller.
Это закрывает управление main и subagent картами одним authority path.

### B. Ввод имени перед каждой операцией

Меньше UI-кода, но оператор легко ошибается в scope/name, не видит archived-only
историю и не может отличить одноимённые Workspace/Project карты. Ошибка имени
обнаруживается поздно, уже после ввода draft. Вариант отклонён.

### C. Произвольные карты только через CLI

Минимальный код, но управление с телефона остаётся неполным, а production
subagent registry получает authority без равноценной операторской поверхности.
Вариант отклонён.

## 4. Инварианты authority

1. Единственный durable источник — `AgentCardRegistryStateV2`; Telegram не
   хранит карточки или выбранное имя как authority.
2. Target каждой mutation — exact `{scope:'workspace'}` либо
   `{scope:'project', projectId}` плюс строгое `name`.
3. Project target допустим, только если `projectId` равен текущему code-owned
   WorkBinding непосредственно перед созданием approval action и перед mutation.
4. Каталог Project не наследует Workspace. Одноимённые записи показываются
   отдельно; отсутствие Project history не превращает Workspace entry в Project.
5. Неизменяемы identity и содержимое revision: binding, name, revision, card и
   hash. Lifecycle status — отдельная forward-only metadata с разрешёнными
   переходами `active → superseded` при следующей публикации и
   `active → archived` при archive. Обратного перехода status нет.
6. `create`, `publish`, `rollback`, `import-legacy` и `archive` используют разные
   domain-separated action hashes. Rollback создаёт новую revision с exact
   snapshot выбранной source revision; archive revision не добавляет.
7. После Gateway confirmation registry заново проверяет полный exact action
   envelope и expected head. Concurrent mutation превращает proof в mismatch,
   а не применяет его к новому состоянию.
8. Persistence выполняется до изменения in-memory authority и consumption
   approval. Ошибка save не потребляет proof; тот же exact envelope/proof можно
   повторить. После успешного save старый proof не проходит из-за нового head,
   даже после restart.
9. Cutover flags не изменяются. Снятие `AISY_AGENT_CARD_REGISTRY=1` остаётся
   операционным rollback на legacy read-only loader.

### 4.1 Канонический lifecycle state machine

Для exact binding/name registry хранит упорядоченную историю revisions и не
более одного active head.

- `create`: precondition — истории нет; append revision 1 `active`.
- `publish`: precondition — история есть и exact expected head совпадает;
  прежний active, если он есть, становится `superseded`; append next revision
  `active`.
- `import-legacy`: precondition — истории нет; append revision 1 `active` с
  registry provenance `legacy-import`.
- `archive`: precondition — exact expected head `active`; та же revision получает
  status `archived`. Card/hash/revision не меняются, новая revision не создаётся.
- `rollback`: precondition — source revision и expected head совпадают; прежний
  active, если он есть, становится `superseded`; append next revision `active`
  с byte-equivalent card snapshot и hash source revision.

Любое другое изменение status или identity отклоняется при load/mutation.

### 4.2 Exact action envelope и proof lifecycle

Каждое подтверждаемое действие строит immutable envelope:

```ts
interface AgentCardLifecycleEnvelope {
  operation: 'create' | 'publish' | 'rollback' | 'import-legacy' | 'archive'
  target: AgentCardTarget
  expectedHead: null | {
    revision: number
    status: 'active' | 'superseded' | 'archived'
    hash: string
  }
  sourceRevision: number | null
  result: {
    revision: number
    status: 'active' | 'archived'
    hash: string
  }
}
```

`actionId/actionHash` domain-separated связывают все поля envelope, включая
operation, exact binding/projectId, name, expected head/status/hash, source и
result revision/status/hash. Поля, неприменимые к операции, обязаны быть `null`,
а не опускаются. Gateway proof связывается с exact actionId/actionHash и
`stepUpVerified=true`.

Registry проверяет envelope до save и повторно непосредственно перед построением
next state. Approval identity потребляется только после успешного atomic save и
in-memory swap. Save failure оставляет head и proof unused; успешный retry того
же envelope детерминирован. После commit повторный proof не совпадает с новым
expected head/status.

## 5. Компоненты и интерфейсы

### 5.1 Core: redacted enumeration

`AgentCardRegistry` получает read-only метод перечисления exact binding. Он
возвращает immutable записи без `card`:

```ts
interface AgentCardCatalogEntry {
  binding: AgentCardBinding
  name: string
  activeRevision: number | null
  activeHashPrefix: string | null
  latestRevision: number
  latestHashPrefix: string
  latestStatus: 'active' | 'superseded' | 'archived'
  revisionCount: number
}

catalog(binding: AgentCardBinding): readonly AgentCardCatalogEntry[]
```

Имена сортируются byte-stable. Archived-only история остаётся в каталоге, чтобы
её можно было восстановить. Метод не делает Project→Workspace fallback и не
возвращает builtin/file-only карты.

`resolveExact` и `history` остаются внутренним lifecycle источником полного
snapshot; transport их не получает.

### 5.2 App: target-oriented lifecycle controller

Текущий controller перестаёт быть привязанным только к `configuredName` и
получает операции с явным target:

```ts
type AgentCardTarget = Readonly<{
  binding: AgentCardBinding
  name: string
}>

catalog(): AgentCardCatalogView
detail(target: AgentCardTarget): AgentCardLifecycleView
createDraft({ markdown, binding, approve }): Promise<AgentCardRevision>
publishDraft({ target, markdown, approve }): Promise<AgentCardRevision>
archive({ target, approve }): Promise<AgentCardRevision>
rollback({ target, approve }): Promise<AgentCardRevision>
importLegacy({ target, approve }): Promise<AgentCardRevision>
```

`createDraft` берёт name из строгого parser и требует отсутствия истории в exact
binding. `publishDraft` требует `parsed.name === target.name` и существующую
историю. Таким образом update не может незаметно стать create/rename.

`archive` принимает только текущую active revision exact target. Источник
`rollback` выбирается строго:

- при active head source — revision с максимальным номером, меньшим head;
- без active head source — revision с максимальным номером во всей history;
- одна active revision не имеет rollback source;
- одна archived revision восстанавливается копированием самой себя в revision 2;
- repeated rollback каждый раз берёт непосредственную предыдущую по номеру
  revision, включая ранее созданные rollback revisions; content equality не
  дедуплицируется.

Envelope всегда называет source revision. Если source/head изменились, mutation
не начинается либо stale proof отклоняется.

### 5.3 App: exact legacy import port

Controller получает узкий порт:

```ts
interface AgentCardLegacyImportPort {
  readExact(name: string): Promise<string>
}
```

Node adapter закреплён на `.aisy/agents`, принимает только имя по card-name
regex и открывает ровно `<name>.md`. Race-safe алгоритм обязателен:

1. при construction canonical root проходит `realpath/lstat`; каждый компонент
   внутри installation root не является symlink, а `(dev, ino)` root сохраняются;
2. на каждый import root открывается как directory descriptor с
   `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`; его `fstat` обязан быть
   directory и совпасть с сохранёнными `(dev, ino)`;
3. exact basename `<name>.md` открывается только относительно этого уже
   проверенного descriptor через `openat(rootFd, basename,
   O_RDONLY | O_NOFOLLOW | O_CLOEXEC)` или семантически эквивалентный primitive,
   который не выполняет новый path traversal; если платформа такого primitive
   не предоставляет, adapter fail-closed и legacy import недоступен;
4. `fstat` file descriptor требует regular file и size ≤64 KiB; чтение идёт
   только из descriptor с cap `64 KiB + 1`, не повторным path read;
5. `fstat` до и после read сохраняет те же `(dev, ino)`, regular type,
   size/mtime/ctime и допустимый bound;
6. post-read `lstat` root обязан всё ещё совпасть с directory descriptor, а
   `fstatat(rootFd, basename, AT_SYMLINK_NOFOLLOW)` — с file descriptor; любое
   расхождение закрывает import, но даже подмена path во время операции не может
   направить чтение за пределы уже открытого verified root;
7. UTF-8 декодируется fatal decoder, затем выполняется строгий parser и exact
   filename/name match.

Adapter отклоняет traversal, symlink/non-regular file, replacement во время
open/read, filename/name mismatch, oversized/invalid UTF-8 и исчезновение файла.
Import допустим только при пустой exact history и создаёт revision 1 с registry
provenance `legacy-import`. Исходный файл не изменяется и не удаляется.

UI спрашивает exact legacy name и scope; он не сканирует и не показывает
содержимое каталога файлов.

### 5.4 Bot: ephemeral target-token registry

Raw name/projectId не кодируются в callback. На каждый render каталога bot
создаёт новое поколение случайных bounded tokens и отображение
`token → exact AgentCardTarget`. Token криптографически непредсказуем, а в тестах
random source инъецируется.

Mapping key включает exact `{chatId, telegramUserId, settingsMessageId,
generation, token}`. Разрешение token — атомарный one-time claim до любого await,
чтения draft/legacy content или approval. Только один из concurrent taps может
claim; остальные получают «Экран устарел» и zero approval/mutation.

Новый render, переход с экрана, mutation, смена current Project или restart
инвалидирует все старые tokens. Unknown, duplicate, wrong-chat/user/message или
stale token даёт короткое уведомление и zero approval/mutation. Token никогда не
становится durable authority.

После выбора detail screen получает новое поколение tokens для exact target.
Pending draft/import form сохраняет `formId`, exact chat/user principal,
разрешённый immutable target/scope, binding snapshot, expected operation,
createdAt и TTL, а не callback token. На один chat/user допускается одна active
form: новая форма атомарно отменяет предыдущую. Первое следующее сообщение того
же principal atomically claims form до await; concurrent delivery не может
создать второй approval. Сообщение другого principal игнорируется и form не
потребляет.

Forms живут только в памяти. Restart инвалидирует их без восстановления. Перед
чтением legacy content, удалением/parse Markdown и созданием approval controller
повторно проверяет principal, TTL и current WorkBinding; Project drift даёт zero
content read/approval/mutation.

Все callback payload остаются ≤64 bytes. Codec принимает только фиксированные
verbs и bounded token alphabet; extra segments отклоняются.

### 5.5 Telegram screens

Каталог показывает две независимые секции: `Workspace` и `Текущий Project`.
Каждая строка содержит только `name`, active/latest revision, 12-symbol hash
prefix и status. Page size — 8 entries; pagination не несёт authority и всё
равно требует актуального generation.

Действия каталога:

- `Создать в Workspace`;
- `Создать в текущем Project` — только при Project WorkBinding;
- `Импорт legacy в Workspace/Project`;
- открыть exact existing entry.

Detail screen показывает redacted metadata и историю последних 8 revisions.
Действия:

- `Опубликовать новую ревизию`;
- `Архивировать` — только при active;
- `Откатить новой ревизией` либо `Восстановить новой ревизией`;
- назад к каталогу.

Markdown draft удаляется best-effort до parse/approval. Ответы содержат только
name/revision/hash prefix/status. При невозможности удаления публикация не
ослабляется, но UI заранее предупреждает, что Telegram message может остаться у
провайдера.

## 6. Потоки

### Создание

1. Operator выбирает exact scope.
2. Bot atomically создаёт principal-bound pending create form с TTL, отменяя
   прежнюю form того же principal.
3. Следующее Markdown message atomically claims form, удаляется best-effort и
   строго парсится.
4. Controller проверяет principal, пустую history и неизменный current Project
   binding.
5. Gateway показывает Tier-3 action с exact binding/name/revision/hash.
6. Genuine proof передаётся registry; durable save предшествует success reply.
7. Каталог рендерится заново, старые callbacks становятся stale.

### Новая ревизия / archive / rollback

1. Callback token atomically claims exact target текущего
   chat/user/message/generation.
2. Controller перечитывает exact history/active state.
3. Для publish дополнительно требует имя draft, совпадающее с target.
4. Gateway proof связывается с вычисленным lifecycle action.
5. Registry повторно проверяет state и атомарно сохраняет mutation.
6. Bot возвращает redacted result и новый screen generation.

### Legacy import

1. Operator выбирает scope и вводит exact name через principal-bound form.
2. Form atomically claims сообщение; current binding проверяется до file I/O.
3. Adapter descriptor-safe читает только `<name>.md` из fixed root.
4. Parser проверяет name/content; exact history должна быть пустой.
5. Tier-3 `import-legacy` proof подтверждает полный exact envelope.
6. Registry сохраняет snapshot, исходный файл остаётся неизменным.

## 7. Ошибки и конкуренция

- malformed/oversized draft, wrong name и reserved builtin: отказ до approval;
- stale token/message/generation/project/principal: отказ до чтения DNA и
  approval; one-time claim делает concurrent/replayed tap безопасным;
- target исчез/изменился между screen и tap: controller строит действие только
  по текущему state либо отказывает;
- concurrent publish после показа confirmation: registry отклоняет stale
  revision/hash proof;
- archive без active, rollback без source revision, import при существующей
  history: стабильные refusal codes;
- legacy path/symlink/replacement/size/UTF-8/parser mismatch: zero registry
  mutation;
- rejected/expired/non-step-up Gateway decision: zero persistence;
- durable save failure: прежняя authority остаётся active, тот же exact proof
  допускает безопасный повтор по существующему контракту;
- audit failure остаётся non-load-bearing и не меняет результат durable commit.

## 8. Privacy и observability

Каталог, callbacks, pending form metadata и Telegram-visible errors могут
содержать только scope, projectId, name, revision, status, 12-symbol hash prefix,
operation и timestamp. Callback не содержит даже prefix. Errors — только stable
codes без raw input.

Полный content hash разрешён только внутри registry state, in-memory exact
action envelope, Gateway proof validation и локального trusted audit. Gateway
summary показывает только prefix; transport не получает full hash. Markdown
body, instructions, full card object и legacy file content не журналируются и
не включаются в errors. Draft живёт только до parse/mutation в памяти процесса и
в исходном Telegram message, который удаляется best-effort.

Audit events различают `created`, `published`, `archived`, `rolled_back` и
`legacy_imported`, но каждый остаётся redacted.

## 9. Проверки и критерии приёмки

### Core

- каталог детерминирован, exact-binding only и не содержит `card`/DNA;
- одинаковые имена Workspace/Project независимы;
- archived-only entry видна, builtin/file-only отсутствуют;
- malformed durable state не расширяет каталог.

### App lifecycle и restart

- create/update не подменяют друг друга; update не переименовывает target;
- publish/archive/rollback/import требуют exact genuine proof;
- Project A target/proof не принимается в Project B;
- archive/rollback и legacy import переживают restart без resurrection;
- persistence failure не меняет active state и не сжигает proof;
- safe legacy adapter отклоняет traversal, symlink, wrong name, oversized и
  malformed file без mutation;
- замена root/file между lstat/open/read/post-check даёт deterministic refusal;
- concurrent mutation между confirmation и commit отклоняет stale envelope;
- save failure допускает retry того же exact proof, а success/restart replay —
  нет;
- одна active revision не откатывается, одна archived восстанавливается в
  revision 2, repeated rollback следует каноническому source algorithm.

### Telegram

- Workspace/current Project entries различимы и пагинация bounded;
- callback ≤64 bytes, raw name/projectId/DNA в нём отсутствуют;
- forged, duplicate, old-generation, wrong-message и post-restart token дают
  zero approval/mutation;
- два concurrent taps дают ровно один atomic claim и не более одного approval;
- wrong-user/wrong-chat message не claims pending form; две concurrent deliveries
  создают не более одного parse/approval;
- restart или Project switch с pending create/import form даёт zero file read,
  parse, approval и mutation;
- Project create/import скрыты в Workspace context;
- draft удаляется best-effort и никогда не эхоится;
- полный button walk достигает каждого нового действия;
- UI/audit corpus не содержит marker из DNA fixture.

### Production composition

- один durable registry обслуживает main и non-builtin subagent selection,
  catalog и mutations;
- legacy adapter закреплён на текущем `.aisy/agents` root;
- `AISY_MAIN_AGENT_CARD` и `AISY_AGENT_CARD_REGISTRY` не изменяются UI;
- при cutover off file loader остаётся прежней runtime authority;
- при cutover on missing/archived exact card fail-closed до provider I/O.

## 10. Документация, rollout и rollback

После реализации обновляются существующие ADR-0069, component spec 20 и
production readiness matrix; новый ADR не создаётся.

Rollout состоит из двух независимых шагов: сначала UI/registry можно использовать
для подготовки revisions при выключенном cutover, затем после целевого
restart/rollback E2E оператор отдельно включает `AISY_AGENT_CARD_REGISTRY=1`.
Rollback authority — снять flag и перезапустить runtime. UI можно оставить
доступным: он не активирует опубликованные revisions сам по себе.

Снятие flag меняет только runtime read authority. Registry mutations, сделанные
при cutover off, остаются durable и снова становятся эффективными, если flag
позднее включить; UI обязан сообщать это, но не удаляет подготовленные revisions.

## 11. Definition of done

Срез готов, когда все критерии раздела 9 имеют детерминированные тесты,
targeted/affected/full regression, workspace typecheck/build и `git diff --check`
зелёные; security/privacy review не находит path/callback/cross-project/DNA
leak; изменения ADR/spec/readiness согласованы; рабочий commit не содержит
секретов, runtime state, private reference materials или несвязанных файлов.

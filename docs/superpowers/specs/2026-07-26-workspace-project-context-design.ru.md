# Контекст рабочего пространства и проектов — дизайн

**Статус:** готово к согласованию пользователем; проведено пять независимых циклов ревью, финальные замечания перепроверены автором  
**Дата:** 2026-07-26  
**Связано с:** ADR-0060, ADR-0063, Component 17  
**Назначение:** первый полный вертикальный срез для переключения Workspace/Project, сессий, сборки контекста, детерминированного размещения памяти и файлов, а также управления проектами через Telegram и естественный язык.

> Это русская нормативная версия для пользовательского ревью и последующей
> реализации. Английская редакция сохранена только как предыдущий источник для
> сравнения. Идентификаторы, интерфейсы, инварианты и критерии `WP-01…WP-41` в
> обеих версиях совпадают по смыслу.

## 1. Краткое решение

У Aisy есть одно постоянное личное рабочее пространство и любое количество изолированных проектов:

- `~/workspace/` — особый контекст **Workspace**. В нём хранятся характер Aisy, профиль оператора, цели, предпочтения, долговременная личная память, выученные рабочие паттерны, глобальный журнал и глобальные знания.
- `~/projects/<slug>/` — контекст **Project**. В нём находятся репозиторий и файлы проекта, рабочие заметки, знания, задачи, навыки и текущая задача.
- Каждый диалог принадлежит одной возобновляемой сессии и ровно одному контексту.
- Переключение контекста меняет активный корень, проектную память, текущую задачу, инструменты и сессию. Характер Aisy и глобальная память не меняются.
- Действия меню Telegram, структурированные инструменты и команды вроде «работаем над X», «создай проект X» и «склонируй <URL>» вызывают один и тот же прикладной сервис и не ведут параллельное состояние.

Workspace виден в списке контекстов, но не является обычным проектом. Это единственный неархивируемый объект с `kind: "workspace"`. Обычные проекты имеют `kind: "project"` и живут под настроенным корнем проектов.

## 2. Основания и текущий разрыв

Приватный референсный материал задаёт целевое поведение: общее личное рабочее пространство, изолированные корни проектов и возобновляемые сессии. Для Aisy это решение зафиксировано ADR-0063.

Сейчас в live-коде готов только фундамент реестра:

- `ProjectRegistryState.version` равен `1`.
- В `ProjectRecord` есть `isDefault`, но нет явного типа Workspace/Project.
- `aisy run` один раз вызывает `ensureDefault()`, один раз вычисляет `activeWorkspaceRoot` и передаёт в runtime неизменяемые root и session id.
- Память хранится в одном `~/.aisy/memory`; recall не ограничен проектом.
- В боте нет рабочего сервиса создания, списка и переключения проектов.
- Ограничение файловых путей лексическое и привязано к стартовому root; канонической защиты от symlink-выхода пока нет.
- Context engine корректно уплотняет append-only сессию, но pinned prefix пока не собирает глобальную DNA и слои выбранного проекта.

Поэтому одной строки в реестре недостаточно. Вертикальный срез завершён только тогда, когда выбор контекста, идентичность сессии, memory retrieval, файловые инструменты и Telegram UX переключаются атомарно.

Этот документ — детальный нормативный дизайн Component 17. Component 17 сопоставляет свои AC-17 с проверками `WP-01…WP-41` и больше не допускает старую трактовку «один default project».

## 3. Цели и не-цели

### Цели

1. Сделать Workspace полноценным выбираемым контекстом с настраиваемым корнем; по умолчанию для новой установки — `~/workspace`.
2. Создавать и клонировать проекты под настраиваемым корнем; по умолчанию — `~/projects`.
3. Делать глобальную DNA и личную долговременную память доступными во всех контекстах, не возвращая локальные данные чужого проекта.
4. Давать каждому ходу неизменяемую, разрешённую кодом идентичность `operator + profile + context + session`.
5. Детерминированно направлять память, заметки, исследования, задачи, навыки и созданные файлы с сохранением provenance.
6. Поддержать жизненный цикл проектов и сессий через кнопки Telegram, естественный язык и структурированные инструменты агента.
7. Сохранить существующие установки без разрушительных переносов и оставить путь отката.
8. Доказать поведение unit-, migration-, integration- и Telegram E2E-тестами, включая негативные проверки изоляции.

### Не входит в этот срез

- Совместная работа нескольких пользователей внутри одного проекта.
- Облачная синхронизация или удалённая проектная файловая система.
- Общая удалённая векторная БД или только семантический поиск. Локальные semantic/hybrid режимы из ADR-0065 входят в срез, а FTS5/BM25 всегда остаётся деградированным baseline.
- Физическое удаление проектов, сессий, transcript или импортированных файлов.
- Автоматическое продвижение фактов между проектами.
- Выбор моделью произвольных физических путей.
- Универсальный IDE-интерфейс. Общий сервис проектируется для будущего IDE, но в этом срезе интерфейсом является Telegram.

## 4. Модель файловой системы и состояния

Логические значения по умолчанию для новой установки; пользовательские корни настраиваются без изменения правил владения:

```text
~/workspace/                         # особый глобальный Workspace
├── constitution.md                  # совместимый/security prefix
├── SOUL.md
├── USER.md
├── MEMORY.md                        # жёсткий предел 10 KiB; предупреждение при 8 KiB
├── MISSION.md
├── GOALS.md
├── PROJECTS.md                      # генерируемое представление реестра
├── PREFERENCES.md
├── LEARNED.md
├── CLAUDE.md
├── SERVICES.md
├── memory/YYYY-MM-DD.md             # межпроектный ежедневный журнал
├── memory/facts/<fact-id>.md         # читаемое каноническое содержание фактов
└── knowledge/
    ├── INDEX.md
    └── ...

~/projects/<slug>/                   # один изолированный Project
├── <репозиторий и файлы оператора>
├── memory/YYYY-MM-DD.md             # рабочие заметки проекта
├── memory/facts/<fact-id>.md         # канонические факты проекта
├── knowledge/INDEX.md
├── tasks/
├── skills/
└── .current-task.md

~/.aisy/                             # внутреннее состояние control plane
├── projects.json                    # реестр v2, атомарная публикация
├── sessions/<session-id>/manifest.json
├── session-log.jsonl                # сохранённый legacy audit/event log
├── transcript-v2.jsonl              # полный transcript с hash chain
├── memory-ledgers/global.db          # защищённый ledger фактов/forget/security
├── memory-ledgers/projects/<project-id>.db
├── indexes/global.db                 # перестраиваемая FTS/vector/cache-проекция
├── indexes/projects/<project-id>.db
├── migrations/
├── inbox/
└── ... существующие vault, grants, provider и journal state
```

Читаемое каноническое содержание фактов находится в `~/workspace` или активном проекте. `MEMORY.md` — детерминированно генерируемый ограниченный prefix/index живых фактов, а не место для ручной записи фактов.

SQLite разделяется физически:

- перестраиваемые БД retrieval хранят FTS/vector/cache-проекции;
- защищённые ledger-БД хранят tombstone, связи contradiction/supersedure и hash-chained `do_not_remember`.

При повреждении retrieval проверяется защищённый ledger, после чего индекс перестраивается из канонических файлов и снова применяет forget-фильтры. При отсутствии или повреждении ledger система закрывается безопасно и требует проверенного backup restore либо вмешательства оператора. Нельзя восстанавливать ledger из видимых файлов или обслуживать неотфильтрованный индекс.

Старый `~/.aisy/session-log.jsonl` сохраняется как audit/event log, но не выдаётся за полный transcript: в нём нет полного user/assistant/tool-содержания, устойчивого порядка после рестартов и hash chain. V2 пишет полные envelopes в защищённый `transcript-v2.jsonl`. Manifest сессии закрепляет один контекст, frozen-prefix snapshot/hash, устойчивую последовательность и возможность resume. Приватный диалог не попадает в checkout репозитория.

`PROJECTS.md` — генерируемый каталог для человека. Авторитетными для id и выбора остаются данные реестра. Ручное изменение `PROJECTS.md` не создаёт проект, не переключает его и не расширяет доступ.

## 5. Реестр v2

Для совместимости сохраняется имя `ProjectRecord`, но добавляется явная семантика, а `isDefault` устаревает:

```ts
type WorkContextKind = 'workspace' | 'project'

interface ProjectRecord {
  id: ProjectId
  operatorId: string
  profileId: string
  kind: WorkContextKind
  origin: 'workspace' | 'created' | 'cloned' | 'registered' | 'legacy'
  name: string
  slug?: string
  root: string
  createdAt: string
  archivedAt?: string
}

interface ProjectSelection {
  operatorId: string
  profileId: string
  projectId: ProjectId
  sessionId: ProjectSessionId
  generation: number
}

interface ProjectRegistryStateV2 {
  version: 2
  projects: ProjectRecord[]
  sessions: ProjectSessionRecord[]
  selections: ProjectSelection[]
}
```

В API и UI слово «context» используется, когда возможны оба вида; «project» — только для `kind=project`.

Инварианты реестра:

- На пару operator/profile существует ровно один активный Workspace.
- Workspace нельзя архивировать, клонировать, вкладывать или переименовывать в проект.
- Созданные/клонированные Aisy корни — прямые потомки `projectsRoot`. `registered` и `legacy` могут находиться снаружи только после тех же protected-root, overlap, canonical-path и explicit-approval проверок.
- Workspace и активные project roots не пересекаются друг с другом.
- Контекст не может совпадать с `~/.aisy`, vault, inbox, sessions, indexes, migrations, staging, содержать их или находиться внутри них. Домашний каталог целиком не может быть контекстом.
- Slug нормализуется кодом, стабилен, проверяется на коллизии и не используется как непроверенный фрагмент пути.
- Сессия принадлежит контексту по `projectId`, включая Workspace-сессии.
- Дубли id, небезопасные roots, несовпадение владельца, висячие ссылки, несколько Workspace или неверный kind приводят к `CORRUPT_STATE` и fail closed.

Поверхность сервиса:

```ts
interface SwitchAuthorityReceipt {
  receiptId: string
  operatorId: string
  profileId: string
  targetProjectId: string
  targetSessionId?: string
  expectedGeneration: number
  sourceMessageHash: string
  expiresAt: string
  mac: string
}

interface ProjectService {
  ensureWorkspace(owner, configuredRoot, legacySessionId?): ProjectSelection
  listContexts(owner): ProjectRecord[]
  createProject(owner, { name, slug? }): Promise<ProjectSelection>
  cloneProject(owner, { remoteUrl, name?, slug? }): Promise<ProjectSelection>
  registerExistingProject(owner, { root, name }): Promise<ProjectSelection>
  archiveProject(owner, { projectId }, authority): ProjectRecord
  restoreProject(owner, { projectId }): ProjectRecord
  switchContext(owner, { projectId, sessionId? }, receipt: SwitchAuthorityReceipt): ProjectSelection
  createSession(owner, { projectId, name? }): ProjectSessionRecord
  renameSession(...): ProjectSessionRecord
  archiveSession(...): ProjectSessionRecord
  restoreSession(...): ProjectSessionRecord
  searchSessions(...): ProjectSessionRecord[]
  acquireTurnContext(owner): TurnContextLease
}
```

Core registry владеет валидированными переходами состояния. App service отвечает за файловую инициализацию, git, миграции, генерируемые каталоги и пользовательские ошибки.

`SwitchAuthorityReceipt` одноразовый, короткоживущий, привязан к owner/target/session/generation и защищён MAC. Выпустить его может только аутентифицированный pre-router или проверенный Telegram callback adapter. Модель может передать непрозрачный handle, но не создать receipt. Missing, replayed, wrong-target, expired и stale receipts отклоняются атомарно вместе с попыткой изменения selection.

Архивация активного проекта — авторизованный switch barrier: старый lease закрывается, Workspace и его активная/новая сессия выбираются, generation увеличивается и проект архивируется одной публикацией состояния. При архивации выбранной сессии атомарно выбирается последняя другая активная сессия либо создаётся новая. Restore заново проверяет root и ничего не выбирает автоматически.

## 6. Неизменяемый контекст хода

Фиксированные startup-переменные в `aisy.ts` заменяются context resolver. В начале каждого хода приложение получает один неизменяемый lease:

```ts
interface TurnContextLease {
  operatorId: string
  profileId: string
  projectId: string
  projectKind: 'workspace' | 'project'
  sessionId: string
  root: string
  generation: number
  leaseId: string
}
```

Lease передаётся в context assembly, memory recall, tools, delegation, approvals, task state и observability. После начала хода ни один компонент не читает process-global «current root». `generation` хранится в selection, начинается с 1 и атомарно увеличивается при любом выборе контекста или сессии. Callback Telegram привязан к владельцу, target и generation, на которой был показан.

`ContextLeaseCoordinator` различает `active`, `cancelling` и `closed`. Переключение:

1. блокирует новые tool operations на старом интерактивном lease;
2. отменяет model/tool signal;
3. ждёт commit/rollback уже начатой атомарной filesystem-операции;
4. закрывает lease;
5. публикует selection с увеличенной generation.

Tool обязан повторно проверить lease перед входом в операцию. После barrier старый lease получает `STALE_CONTEXT` до I/O. Durable background jobs имеют собственные project-bound leases и не перенаправляются выбором интерактивного контекста.

Авторизованное переключение выполняется так:

1. Receipt создаётся только из исходного аутентифицированного сообщения оператора либо callback, привязанного к owner/generation.
2. Target и target session разрешаются; старый lease quiesce/close.
3. Selection с `generation + 1` сохраняется атомарно.
4. Создаётся новый lease. Resume загружает сохранённый frozen prefix; новый prefix создаётся только для новой сессии.
5. Оператор получает подтверждение активного контекста и сессии.

В составном запросе «переключись на X и проверь README» pre-turn router анализирует только исходное сообщение оператора, переключает контекст до project recall/I/O и выполняет задачу ровно один раз под новым lease. `project.switch` от модели принимается только при связи с явным намерением оператора и до project-local I/O; иначе нужно новое подтверждение. При restart остаются только исходный operator span, сгенерированный кодом transition receipt и новый контекст. Старые retrieval/model/tool/untrusted spans отбрасываются. Разрешён один переход на запрос, чтобы исключить switch-loop.

## 7. Сборка контекста

`LayeredContextAssembler` собирает четыре слоя, не смешивая их хранилища:

1. **Frozen global prefix** — протокол агента и DNA-файлы Workspace, включая `constitution.md`. Снимок создаётся один раз при создании сессии, хранится как content-addressed snapshot с ограниченными правами и следует ADR-0007.
2. **Lazy global material** — безопасные межпроектные записи сегодняшнего глобального журнала, каталог знаний и релевантные явно глобальные выдержки. Проектные ссылки раскрываются только внутри owning project.
3. **Active-context material** — для Project: `.current-task.md`, каталоги памяти/знаний и retrieved excerpts; для Workspace проектный слой не выдумывается.
4. **Session view and turn tail** — проекция append-only transcript существующим context engine, затем текущий input и tool observations.

Автоматический assembler принимает `TurnContextLease` и никогда не запрашивает все проекты. Поиск выполняет два явных запроса — global и active project — и возвращает typed hits:

```ts
interface ScopedMemoryHit extends RankedHit {
  scope: 'global' | 'project'
  scopeId: string
  projectId?: string
  sourcePath: string
  provenanceRef: string
}
```

Global и active-project hits можно ранжировать вместе только после отдельных tombstone/forget-фильтров. Другие проекты не опрашиваются. Недоступный project index даёт global-only recall с явным предупреждением, но никогда не подставляет другой проект.

В Workspace доступна отдельная read-only операция `search_all_projects`. Это не автономный model tool: pre-router выпускает одноразовый `CrossProjectSearchReceipt`, привязанный к owner, Workspace session, generation, нормализованному hash запроса, mode и archive flag. Сервис опрашивает отдельные индексы допустимых проектов, берёт ограниченный top-k на проект и детерминированно объединяет подписанные hits с `projectId`, именем, path и provenance.

Каждый hit содержит короткоживущий одноразовый `ExcerptReadCapability`, привязанный к точному project/path/chunk/content hash. `open_search_hit` не принимает произвольный путь. Missing/replayed/wrong-query/stale receipt, модельный или prompt-injected вызов и nested call закрываются безопасно. Общего all-project index нет. Архивные проекты исключены, если оператор явно не запросил иное. Просмотр excerpt read-only; изменение найденного файла требует switch в проект.

```ts
interface WorkspaceProjectSearch {
  searchAllProjects(
    workspaceLease: TurnContextLease,
    receipt: CrossProjectSearchReceipt,
    query: string,
    opts: { mode: 'keyword' | 'semantic' | 'hybrid'; limitPerProject: number },
  ): Promise<ProjectSearchHit[]>
  openSearchHit(
    workspaceLease: TurnContextLease,
    capability: ExcerptReadCapability,
  ): Promise<string>
}
```

Создание сессии сохраняет точные bytes frozen prefix, hash и source manifest. Resume проверяет и загружает те же bytes даже после изменения DNA. Отсутствующий/неверный snapshot вызывает fail closed с выбором doctor/new session и не перестраивается молча. Новую DNA видит только новая сессия. Записи внутри сессии сразу доступны lazy search, но не меняют frozen prefix.

### 7.1 Keyword, semantic и hybrid retrieval

Aisy реализует три режима из ADR-0065:

- `keyword` — scoped FTS5/BM25, всегда локальный и доступный;
- `semantic` — query embedding через настроенный `EmbeddingProvider` и cosine similarity в локальном sqlite-vec индексе scope;
- `hybrid` — default при здоровых embeddings: не более 20 кандидатов на leg и scope, объединение RRF с `k=60`, сохранение scope/path/provenance. Tie-break: fused score по убыванию, лучший component rank по возрастанию, затем `scopeId`, `sourcePath`, `chunkId` по возрастанию.

Первый embedding adapter — OpenRouter, подключаемый в Telegram Settings. До opt-in UI сообщает, что query и выбранные memory/knowledge chunks покидают сервер. Disconnect/revoke атомарно блокирует новые calls, удаляет query cache и ставит на удаление provider-scoped document cache/vector rows до повторного включения semantic mode. Без рабочего ключа `semantic` возвращает `SEMANTIC_UNAVAILABLE`, а `hybrid` явно деградирует до keyword.

Chunking детерминирован по Markdown heading и ограниченному token window. Строка хранит scope/project id, source path, provenance, content hash, provider, model id/revision, dimensions, normalization version и chunker version. Кэш document/query embeddings:

```text
SHA-256(provider || model-id || model-revision || dimensions ||
        normalization-version || chunker-version || normalized-content-hash)
```

Неизменённый контент не вызывает API. Изменение любого элемента ключа инвалидирует только затронутый scope. Global, каждый Project и monitoring имеют разные vector tables/files. Forget/live filter применяется до ranking и при lazy load, поэтому vector не может воскресить забытый факт.

По умолчанию индексируются только canonical memory и knowledge. Исходники проекта требуют отдельного project opt-in и code-owned excludes. Перед внешним embedding request детерминированный secret scanner проверяет path policy, известные credential formats и high-entropy tokens. Подозрительный chunk полностью пропускается и аудируется. Подозрительный query не покидает host: `semantic` возвращает `SENSITIVE_INPUT_LOCAL_ONLY`, `hybrid` использует keyword. Vault, `.env`, credentials, control-plane state, inbox и ignored/protected paths никогда не отправляются провайдеру. В `search_all_projects` query embedding вычисляется один раз на полную версию cache key и используется с изолированными индексами; per-project caps не дают большому репозиторию вытеснить остальные.

Глобальный журнал содержит только явно межпроектные факты/summary и непрозрачные event references (`projectId`, note hash, timestamp). Подробный текст пишется только в project journal. Вне owning project непрозрачная ссылка не участвует в semantic recall, а target text не загружается.

## 8. Детерминированная маршрутизация памяти и файлов

Модель выбирает semantic intent; код выбирает и проверяет physical destination. Все write API принимают lease, typed category, content и provenance. Непроверенный absolute path не принимается.

| Семантика | Каноническое назначение |
|---|---|
| Конституция оператора | Только Workspace `constitution.md`, отдельная аутентифицированная операция с явным подтверждением |
| Характер/инструкции агента | Workspace `SOUL.md` или `CLAUDE.md` через typed reviewed profile tools |
| Факт/контакт/предпочтение оператора | Workspace `USER.md`, `PREFERENCES.md`, `memory/facts/<id>.md`; `MEMORY.md` регенерируется |
| Миссия или долговременная цель | Workspace `MISSION.md` / `GOALS.md` |
| Показанный переиспользуемый паттерн | Workspace `LEARNED.md` с evidence и promotion state ADR-0061 |
| Явное межпроектное событие дня | Workspace `memory/YYYY-MM-DD.md` |
| Решение/рабочая заметка проекта | Active project `memory/YYYY-MM-DD.md` плюс opaque global event reference |
| Активная многошаговая работа | Active project `.current-task.md`; Workspace-аналог только при активном Workspace |
| Research/template/configuration | Active project `knowledge/<code-owned-name>.md` |
| Явно межпроектное знание | Workspace `knowledge/<code-owned-name>.md` |
| Долговременная project task | Active project `tasks/` |
| Созданный файл или source code | Relative path внутри active context после ownership checks |

Основные правила:

- Project-local writes разрешены только при `projectKind=project`; в Workspace нет fallback на «последний проект».
- Межпроектное promotion — отдельная typed operation с provenance.
- `MEMORY.md` генерируется из живых фактов, предупреждает при 8 KiB и не публикует prefix больше 10 KiB до consolidation, но не теряет canonical fact files.
- Memory commit использует scope-exclusive WAL: `PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`. Видимы только `published=1` rows с существующим ожидаемым файлом. Recovery завершается до чтения scope. Tombstone и `do_not_remember` применяются к enumeration, snapshot, FTS, rebuild и lazy load.
- Duplicate candidates определяются до append.
- Context root может быть обычным потомком home, но не самим home/ancestor и не пересекаться с control-plane/vault/inbox/session/index/migration/staging.
- `ConfinementPort` сначала валидирует registry path, затем выполняет descriptor-relative no-follow walk. На Linux — `openat2` с `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`; на других системах — эквивалент с `O_NOFOLLOW`, иначе write fail closed.
- `bash` доступен только в sandbox, где смонтирован один leased root, synthetic empty home и нет secrets. Без sandbox bash выключен, но confined file tools и диалог работают.
- Subagent получает immutable child lease родительского проекта, не получает `project.switch` и не перенаправляется последующим выбором родителя.

## 9. Создание, клонирование и инициализация проекта

Все пути создания используют staged transaction под exclusive reservation lock `projectsRoot`:

1. Нормализовать имя, получить collision-free slug, атомарно зарезервировать slug и final root. Конкурентные операции дают одного победителя и `PROJECT_ROOT_RESERVED` второй операции.
2. Создать случайный staging directory рядом с final destination без registry row.
3. Для нового проекта инициализировать layout; для clone — вызвать restricted adapter через approvals и action contract.
4. Записать metadata и пустые обязательные каталоги в staging.
5. Проверить дерево через `ConfinementPort`; до публикации отклонить escaping symlinks, special files и nested mounts. Submodules и hooks не запускать.
6. Атомарно переименовать staging в final root, создать registry row и initial session, опубликовать selection, обновить Workspace `PROJECTS.md`.
7. Снять reservation только после publication или durable quarantine.

Первый срез принимает только нормализованные публичные HTTPS URL вида `https://<public-dns-host>/<non-empty-path>` после WHATWG parsing. Отклоняются userinfo/credentials, fragments, query strings, control chars, `file`, `ext`, scp syntax, компоненты с `-`, private/loopback/link-local DNS и redirects. SSH/private repositories остаются отдельному authenticated adapter.

Git запускается argv-массивом с option termination:

```text
git -c protocol.file.allow=never -c protocol.ext.allow=never
    -c http.followRedirects=false clone --no-recurse-submodules -- <url> <staging>
```

Clone идёт в отдельном sandbox. Resolver и kernel egress policy блокируют private/loopback/link-local/metadata/reserved адреса во время connect, закрывая DNS rebinding. Redirects выключены. Staging ограничен bytes/inodes; cgroups ограничивают memory/CPU/pids/time; transfer по возможности shallow/no-checkout/blob-filtered; post-transfer scan ограничивает количество файлов, глубину, размер отдельного файла и общий expanded size.

Environment минимален: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` выключен, `GIT_LFS_SKIP_SMUDGE=1`; stdout/stderr ограничены и URL редактируется; timeout завершает всю process group. Нарушение quota/egress не публикует проект.

Ошибка до registry publication не создаёт selectable project. Staging остаётся в quarantine с recovery id либо очищается явной doctor operation. Если filesystem rename прошёл, а registry publication нет, doctor предлагает `register` или `quarantine` и ничего не удаляет сам.

`registerExistingProject` отдельно принимает существующие файлы, выполняет canonical/protected-root, overlap, repository detection и race-safe tree scan; root вне `projectsRoot` требует preview/confirmation.

## 10. Inbox вложений и импорт

Telegram/local attachments сначала попадают в `~/.aisy/inbox/<operator>/<upload-id>` вне контекстов с ограниченными правами. Это untrusted session input; сам факт получения не копирует файл в Workspace/Project и не индексирует его.

```ts
interface ProjectFileManifest {
  fileId: string
  operatorId: string
  projectId: string
  sessionId: string
  source: 'telegram' | 'local' | 'generated' | 'import'
  originalName: string
  relativePath: string
  sha256: string
  provenanceRef: string
  createdAt: string
  importedFromFileId?: string
}
```

`importAttachment(lease, fileId, semanticDestination)` выбирает code-owned relative destination, делает staged copy, проверяет hash/confinement и выполняет project-exclusive WAL: `PREPARED → MANIFEST_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`. Manifest имеет `published` и idempotent audit outbox. Project file tools видят destination только когда manifest опубликован и hash совпадает. Recovery запускается до обслуживания проекта. Collision предлагает выбор, overwrite требует отдельного approval. Inbox object сохраняется при прерывании. Foreign owner/session и archived target отклоняются до I/O.

## 11. Долговременные задачи, разрешения и scoped autonomy

Каждая сохранённая цель, trigger, monitor, digest, subagent delegation, approval grant и current-task имеет non-null binding:

```ts
interface WorkBinding {
  operatorId: string
  profileId: string
  projectId: string
  sessionId?: string
  scope: 'workspace' | 'project' | 'session'
}
```

Binding фиксируется из active lease при регистрации. Последующее переключение не перенаправляет запись. Scheduler при запуске/restart разрешает сохранённый binding и получает background lease именно этого контекста; interactive selection не используется. Session job ставится на паузу при archive session. Project/Workspace job использует отдельную append-only system session. Archive project ставит его jobs на паузу и запрещает runtime-use grants; running job отменяется на tool boundary.

Legacy records с legacy session id привязываются к migrated legacy project. Unscoped goals/triggers/digests карантинируются paused; grants выключены до назначения Workspace/Project. Global nightly integrity maintenance привязан к Workspace, но обрабатывает проект только через явный per-project maintenance lease. Миграция не расширяет grant молча.

## 12. Telegram и естественный язык

Обычная reply keyboard скрыта при наборе и отправке свободного текста. Project controls открываются явно из compact menu или команд.

Экран проектов:

- `🏠 Workspace` с отметкой текущего выбора;
- пагинированная кнопка каждого active project;
- `➕ Новый проект`;
- `📥 Клонировать репозиторий`;
- `📂 Подключить существующий`;
- `🗂 Сессии` выбранного контекста;
- `◀️ Назад`.

После выбора Aisy кратко подтверждает context name, session name и сокращённый через home root, затем удаляет inline picker. Free-text продолжается без reply keyboard.

Natural-language routing поддерживает русский и английский и не сводится к хрупкому списку фраз:

- детерминированный parser обрабатывает однозначные частые команды и точные registry names;
- модель имеет structured tools `project.list/create/clone/switch` и `session.*` для вариативных и составных формулировок;
- все маршруты вызывают `ProjectService` с одинаковыми authorization, approval, validation, persistence и events;
- неоднозначное имя даёт choice card; low-confidence intent задаёт один вопрос и не создаёт directory.

## 13. Ошибки и восстановление

| Сбой | Требуемое поведение |
|---|---|
| Registry отсутствует | Идемпотентно создать один Workspace и импортированную session |
| Registry v1 | Выполнить явную миграцию v1→v2 |
| Registry corrupt | Fail closed; `aisy doctor` показывает id и варианты recovery |
| Workspace root недоступен | Сохранить internal state; заблокировать context turns с понятным recovery |
| Project root недоступен | Разрешить list/switch metadata, запретить file/project-memory; не подставлять Workspace |
| Project index недоступен | Global-only recall с warning; перестроить derived index проекта |
| Global memory недоступна | Не запускать agent turn без identity prefix; оставить diagnostics/menu |
| Имя соответствует нескольким проектам | Показать disambiguation; состояние не менять |
| Clone/auth/network failure | Registry не публиковать; сохранить redacted diagnostic и recovery id |
| Disk full/atomic rename failure | Старое состояние авторитетно; нет partial JSON/manifest |
| Switch во время хода | Quiesce/abort old lease; после barrier `STALE_CONTEXT` до I/O |
| Sandbox недоступен | Отключить bash; оставить confined file tools и diagnostics |
| Запрошен protected/control root | Отклонить до registry publication и filesystem access |
| Stale callback | Отклонить по owner/generation и перерисовать текущее состояние |

Errors/events содержат id, нормализованные codes и безопасную path metadata, но не file content, provider/clone credentials и private names в широких логах.

## 14. Миграция и откат

Миграция — exclusive crash-resumable cutover. `aisy run` входит в maintenance mode, ставит schedulers на паузу, отклоняет state-changing callbacks/turns и захватывает `~/.aisy/migrations/workspace-v2.lock`. Защищённый manifest фиксирует source checksums, backups, created artifacts и фазы `PREPARED`, `COPIED`, `VERIFIED`, `COMMITTED`, `V2_WRITES_ENABLED`.

Идемпотентная процедура:

1. Полностью проверить v1, legacy memory DB/files, session log, jobs и grants без изменений. При закрытых writers создать SQLite online backup и checksummed backup `projects.json`, generated/identity files и `PROJECTS.md`.
2. Каждую v1 row, включая `isDefault=true`, считать `kind: "project"`, `origin: "legacy"`. V1 брал root из `AISY_WORKSPACE ?? process.cwd()`, поэтому это может быть обычный repo. Сохранить id/root/sessions/selection, вывести safe slug и выполнить все root checks; небезопасный конфликт останавливает migration для doctor.
3. Создать отдельный Workspace с новым id в v2 global root (default `~/workspace`, setting `AISY_GLOBAL_WORKSPACE`). V1 не имеет надёжного marker, поэтому legacy repo не становится глобальным автоматически. Overlap требует явного relocate/designate выбора. Создать Workspace session, не меняя сохранённый legacy selection.
4. Скопировать legacy prefix files, включая `constitution.md`, `SOUL.md`, `USER.md`, inputs `MEMORY.md` и остальные DNA ADR-0063, через staging только при отсутствии destination. Content conflict останавливает publication и показывает оба hash.
5. Lossless перенести authoritative ledger: ids, live/invalid/tombstoned rows, supersedure/contradiction edges, provenance и полный hash-chained `do_not_remember`. Экспортировать в `memory/facts/<id>.md` только live non-forgotten content. FTS восстановить в отдельную disposable DB, vector state — только по ADR-0065. Проверить integrity, counts, id sets, forget-chain head, search equivalence и frozen prefix. Forgotten text не экспортируется; untouched backup остаётся rollback source.
6. Сохранить legacy event log byte-for-byte и закрепить checksum. Legacy sessions пометить `resumeCapability: "metadata-only"`; недостающий диалог не выдумывать. Продолжение создаёт новую v2 session с migration-boundary event. V2 envelopes содержат `eventId`, owner/context/session ids, `sessionSeq`, role, provenance, full content/tool observation, timestamp, `prevSessionHash`, `rowHash`. Appends сериализуются/fsync, manifest counter двигается атомарно и идемпотентно. Это уточняет ADR-0044…ADR-0064.
7. Применить §11 к legacy goals/triggers/digests/grants: session-linked work привязать к legacy project; unscoped — paused/quarantine, grants disabled до review.
8. В staging собрать v2 JSON с selection generation `1`, manifests, indexes и catalogues; проверить все invariants и cross-scope negative probes.
9. Атомарно опубликовать registry/manifests и только перечисленные в manifest Workspace files, регенерировать `PROJECTS.md`, записать `COMMITTED` при закрытых gates. После финальной проверки fsync `V2_WRITES_ENABLED` выполняется до снятия gate/lock. После этой фазы automatic downgrade запрещён.

Recovery определяется фазой manifest. До `COMMITTED` удаляются только manifest-created artifacts с совпадающими hash, восстанавливаются backups и повторяется v1/migration. Между `COMMITTED` и `V2_WRITES_ENABLED` doctor может выполнить тот же автоматический rollback. Pre-existing roots, append-only log и legacy memory не меняются; staging/quarantine не удаляется по догадке. После `V2_WRITES_ENABLED` automatic downgrade запрещён: doctor ставит execution на паузу и экспортирует checksummed recovery bundle и forward-repair plan. Crash tests вокруг terminal fsync/gate release и callback/job races доказывают, что авторитетна ровно одна версия и writes не попадают в обе.

## 15. Наблюдаемость и приватность

Добавляются identifier-only events:

- `context.workspace_migration_phase`, `context.workspace_migrated`;
- `project.created`, `project.clone_started`, `project.clone_completed`, `project.selected`;
- `session.created`, `session.selected`, `session.archived`, `session.restored`;
- `context.lease_acquired`, `context.assembled`;
- `memory.route_selected`, `memory.scope_degraded`;
- `attachment.received`, `attachment.imported`;
- `job.binding_resolved`, `job.paused_context_archived`;
- `project.root_unavailable`, `project.index_rebuild_requested`.

Turn-start event содержит `projectId`, `sessionId`, lease generation и hashes global prefix/active catalogue. Tool events содержат те же lease ids. Это позволяет доказать cross-project access без логирования content.

Metrics: switch success/failure, create/clone latency, context assembly latency, scoped recall hit counts, index degradation, path denials. Private high-cardinality project/session names не используются как metric labels.

## 16. Модель безопасности

- Telegram owner id и profile проверяются перед каждым context lookup.
- Callback привязан к nonce/generation и не выбирает foreign owner либо stale state.
- Switch authority исходит только из authenticated operator span или bound callback; repo/web/attachment text не может разрешить switch.
- Модель не получает и не выбирает непроверенный absolute path.
- Разрешены обычные roots ниже home; home/ancestors и пересечение с control-plane запрещены; descriptor confinement закрывает symlink/mount escapes.
- Clone URL редактируется в логах; credentials, local protocols, redirects и private destinations запрещены.
- Repository/web/attachments остаются untrusted provenance. Switch не повышает их trust.
- Global profile mutation — typed memory/profile tools. Project file tool не пишет в Workspace через `../`, symlink, mount или cwd trick.
- Bash работает только в root-only sandbox с empty home и secret-free env.
- Autonomy grants, triggers, agents и digests scoped по `projectId`; global grant — отдельное действие оператора.
- Archive обратим и не удаляет files/transcripts. Hard delete в срез не входит.

## 17. Матрица тестов и приёмки

### Реестр и миграция

1. **WP-01** Fresh state создаёт ровно один selectable Workspace и одну session в `~/workspace` или configured root.
2. **WP-02** V1 migration сохраняет все old id/root/session и active selection, классифицируя old default как legacy Project и создавая отдельный Workspace; repo не auto-promote в global.
3. **WP-03** Memory migration сохраняет ids/counts facts, tombstones, relations, forget-chain head, integrity и live search; forgotten text не экспортируется, `constitution.md` остаётся в prefix.
4. **WP-04** Legacy event log byte-identical, его sessions честно `metadata-only`; новые v2 envelopes сохраняют full content, durable ordering и валидный per-session hash chain без duplicates после retry/restart.
5. **WP-05** Crash injection на каждой cutover phase, включая границы fsync `V2_WRITES_ENABLED` и gate release, оставляет ровно одну authoritative schema; после v2 writes rollback запрещён.
6. **WP-06** Multiple Workspace, root overlap, invalid kinds/slugs, protected/home/control roots, dangling sessions и foreign selections fail closed.
7. **WP-07** Workspace нельзя архивировать; archive active project атомарно выбирает Workspace и увеличивает generation; archive active session выбирает/создаёт replacement; restore проверяет root и не выбирает автоматически.

### Контекст и изоляция

8. **WP-08** Одинаковый global DNA fact доступен в Workspace, Project A и Project B.
9. **WP-09** Marker памяти/файла A отсутствует в automatic Workspace/B recall после restart, compaction и rebuild.
10. **WP-10** Project journal marker остаётся в A; другие видят максимум opaque event reference без semantic content.
11. **WP-11** Switch A→B выбирает/создаёт B session и не переносит transcript, retrieval spans, tool results или current task A.
12. **WP-12** New session получает новый frozen prefix; resume old session после DNA change загружает исходные byte-identical prefix/hash.
13. **WP-13** Session writes сразу searchable без изменения frozen prefix; compaction не меняет transcript bytes.
14. **WP-14** Concurrent switch/tool quiesce old operations, generation монотонна после restart, closed leases/callbacks получают `STALE_CONTEXT` до I/O.
15. **WP-15** Untrusted repo/web/attachment не переключает context. Неверные receipts fail в `ProjectService`; compound operator request переключает до retrieval без old spans.

### Файлы, создание, clone и attachments

16. **WP-16** Каждый live read/write/list/bash/import несёт validated lease и разрешается внутри leased root до I/O.
17. **WP-17** Absolute/traversal, nested/protected roots, cross-project session ids, symlink swaps, magic links и cross-mount escape fail до target I/O.
18. **WP-18** Без root-only sandbox bash недоступен и не видит home/vault/control/secrets; confined file tools работают.
19. **WP-19** New project и valid public-HTTPS clone создают layout, один registry row/session и обновляют `PROJECTS.md`.
20. **WP-20** Clone отклоняет option injection, userinfo, redirects, private/loopback, local/ext/file/scp transports, DNS rebinding, escaping symlinks, disk/inode bombs и resource violations без публикации.
21. **WP-21** Два concurrent запроса одного slug/root дают один published project и один deterministic reservation failure.
22. **WP-22** Clone/disk-full/rename failures не публикуют selectable project и возвращают только redacted recoverable diagnostic.
23. **WP-23** Attachment import проверяет owner/session/hash, confined code-owned destination, атомарно публикует file+manifest и сохраняет untrusted provenance.
24. **WP-24** Crash на любом attachment WAL boundary, collision, foreign owner/session и archived target не показывают destination отдельно от manifest; retry idempotent, inbox остаётся.

### Маршрутизация памяти

25. **WP-25** Каждая semantic category попадает ровно в задокументированный scope/path с provenance.
26. **WP-26** Project-local write отклоняется в Workspace; cross-project promotion требует explicit typed operation.
27. **WP-27** Crash на любом memory WAL boundary не показывает searchable fact отдельно от readable object/audit; retry idempotent; `MEMORY.md` ≤10 KiB без потери фактов; rebuild сохраняет tombstone/forget invariants.
28. **WP-28** Ошибка project index даёт global-only и никогда hit другого project index.
29. **WP-29** `keyword`, `semantic`, `hybrid` возвращают scoped labelled results; hybrid: cap 20, RRF `k=60`, зафиксированный tie-break для BM25+cosine.
30. **WP-30** Неизменённый chunk/query с полным provider/model/revision/dimensions/normalization/chunker/content cache key вызывает 0 новых embeddings; изменение поля перестраивает только affected scope.
31. **WP-31** Tombstoned/forgotten facts, protected paths и deterministic secret fixtures отсутствуют во внешних requests, vector build/search/lazy load. Sensitive query остаётся локально; revoke блокирует calls и удаляет provider-scoped cache/index.
32. **WP-32** Missing/failed OpenRouter явно даёт `SEMANTIC_UNAVAILABLE`; keyword работает, hybrid деградирует до keyword без cross-project fallback.
33. **WP-33** Явный Workspace all-project search с валидным одноразовым owner/query/generation receipt опрашивает изолированные active indexes, подписывает hits, ограничивает per-project и открывает только exact excerpt по one-use capability. Неверные receipts, model/prompt/nested calls и arbitrary paths fail closed; обычный Workspace recall остаётся без project markers, write требует switch.

### Telegram и естественный язык

34. **WP-34** Menu selection и Russian/English NL selection вызывают один сервис и создают одинаковые persisted selection/lease.
35. **WP-35** Ambiguous names показывают owner-bound choices и не меняют state.
36. **WP-36** Reply keyboard отсутствует в обычных free-text replies; controls появляются только в explicit inline flow.
37. **WP-37** Stale/replayed/foreign callbacks не создают/используют switch receipt и не меняют context.

### Durable runtime и audit

38. **WP-38** Main agent, goal loop, trigger, monitor, digest, nightly task и subagent получают explicit binding/lease; live path не использует startup cwd/chat id/current interactive selection как fallback.
39. **WP-39** Delayed job Project A работает только в A после switch в B; archive A ставит job на паузу. Legacy unscoped jobs/grants quarantine/disabled, а не global.
40. **WP-40** Restart восстанавливает exact context/session/generation. V2 session восстанавливает полный append-only view и original prefix; legacy sessions только metadata и не выдумывают dialogue.
41. **WP-41** Lifecycle/tool/migration/job events доказывают binding project/session/generation без content, names, secrets, clone credentials или attachment bytes.

Release требует все 41 проверки, существующие core/app/Telegram suites, typecheck и builds. Также обязательны adversarial path/clone suite, crash fixtures для каждой migration phase и Telegram E2E с двумя проектами: switch, resume, file import и negative recall isolation. Одних узких unit tests недостаточно.

## 18. Порядок поставки

1. Registry v2 types, persisted generation, lifecycle validation, migration lock/manifest state machine и crash harness.
2. Lossless memory ledger/file export, session manifest, job/grant migration и pre-cutover equivalence verifiers без публикации v2.
3. `ProjectService`, root/layout adapters, archive/restore, create/register/restricted-clone transaction, reservations и doctor recovery.
4. `ContextLeaseCoordinator` и per-turn runtime factory; удалить startup root/session/chat-id fallbacks из live paths.
5. Layered global/project memory, safe global journal, frozen session snapshots, routing/context assembly, OpenRouter embeddings, scoped sqlite-vec, cache, RRF и explicit all-project search.
6. Descriptor-relative confinement, protected roots, root-only bash sandbox и attachment inbox/import.
7. Durable bindings для goals, triggers, monitoring, digests, nightly, grants и subagents.
8. Telegram project/session UI, authenticated NL pre-router, structured tools и context-change barrier.
9. Exclusive v2 cutover, restart/rollback validation, adversarial suites, two-project Telegram E2E и evidence matrix.

Каждый этап принимается тестами и сохраняет старый live path, пока замена не доказана. Во время cutover обычные writes закрыты. V2 публикуется только после equivalence checks реестра, памяти, transcript, jobs, confinement и leases. Rollback следует manifest §14 и никогда не удаляет незарегистрированный или pre-existing root.

## 19. Ссылки

- `docs/decisions/2026-07-26-project-scoped-sessions-file-ownership.md`
- `docs/decisions/2026-07-26-layered-workspace-project-memory.md`
- `docs/decisions/2026-07-26-full-fidelity-session-transcript.md`
- `docs/decisions/2026-07-26-hybrid-vector-keyword-retrieval.md`
- `docs/specs/17-projects-sessions-context-files.md`
- `docs/specs/15-context-engine.md`
- `docs/reviews/2026-07-26-reference-screen-contract-matrix.md`
- `docs/reviews/2026-07-26-reference-assistants-live-gap-audit.md`

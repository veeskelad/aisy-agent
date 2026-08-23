# Aisy: план полной production-композиции

> **Статус 2026-08-23:** это исторический implementation plan. Текущие
> LIVE/dormant/target gates ведутся в
> [production-матрице](../../reviews/2026-08-23-production-readiness-matrix.md).

> Статус архитектуры: согласована оператором 2026-07-26.
>
> Нормативные источники: принятые ADR-0057…ADR-0065, компонентные
> спецификации `docs/specs/01…23`, русская детальная спецификация Workspace /
> Project / Session / Files / Memory и матрица экранных контрактов референса.
>
> Локальный приватный эталон поведения не является артефактом Aisy: его файлы,
> тексты, путь и история не входят в Git и публичные документы.

## 1. Результат

Aisy должна стать единственным безопасным управляющим ядром персонального
агента. Пользователь подключает Claude/Codex по подписке или поддерживаемого
API-провайдера, проходит Telegram-onboarding и получает живой агентный runtime:

- полная DNA и слоистая память;
- структурированные Tools, Skills и MCP;
- Workspace, проекты, сессии и файлы с изоляцией;
- агенты и субагенты с явными бюджетами;
- доказуемая автономность, мониторинг и дайджесты;
- текст, вложения, голос и потоковые статусы;
- детерминированные safety boundaries, audit и восстановление.

Результат считается достигнутым не по наличию классов или unit-тестов, а когда
функции подключены в `aisy run`, доступны через Telegram и подтверждены
сквозными сценариями, негативными security-тестами и restart/rollback-проверками.

## 2. Ограничения и не-цели

- Документация и ADR пишутся на русском; идентификаторы кода остаются на
  английском.
- Секреты хранятся вне репозитория и никогда не попадают в логи, события,
  fixtures или сообщения об ошибках.
- Необратимые запреты, confinement, authority receipts, бюджеты и scopes
  реализуются кодом, а не промптами.
- Текущий live path сохраняется до доказанной замены; миграции идемпотентны.
- Hard delete контекстов, private Git clone и полноценная IDE/server-панель не
  входят в первый production release. Они не блокируют Telegram-first продукт.
- Решения о новой технологии, runtime, лицензии или крупной зависимости требуют
  отдельного подтверждённого ADR.

## 3. Базовая линия

Перед изменениями подтверждена следующая исходная точка:

- typecheck проходит во всех workspace-пакетах;
- после сборки зависимых `@aisy/core` и `@aisy/telegram-gw` проходят 1130 тестов;
- live runtime использует один startup workspace/session и глобальную память;
- Skills/MCP, brain bootstrap и большая часть Project UI существуют в core или
  тестах, но не включены в production-композицию;
- keyword memory не поддерживает кириллицу, а semantic/vector backend не
  подключён;
- Telegram обрабатывает только текст; onboarding не завершает реальную
  установку/авторизацию brain driver;
- Claude CLI reply-only; Codex runtime отсутствует; API adapters поддерживают
  structured tool calling;
- агенты/субагенты имеют рабочее ядро, но нет полного управления, DNA scopes и
  Telegram-представления;
- монитор сейчас показывает расходы, но не выполняет evidence-linked monitoring
  и digest pipeline.

Перед каждым этапом зависимости пересобираются, чтобы vitest не использовал
устаревший `dist` вместо изменённого workspace source.

## 4. Порядок реализации

### Этап 1 — Registry v2 и безопасная миграция

**Зависимости:** ADR-0060, русская спецификация §4–6, §13–18.

**Изменения:**

- [x] Ввести `WorkContextKind`, `ProjectOrigin`, registry state v2 и persisted
  `generation` без удаления API совместимости раньше cutover.
- [x] Валидировать единственный Workspace на owner/profile, владельца каждой
  selection, kind/origin/slug, dangling ids и пересечение roots.
- [x] Построить и независимо проверить v1→v2 candidate: legacy Project,
  отдельный Workspace, сохранённые
  старые ids, root, sessions и selection.
- [ ] Реализовать migration manifest, lock и фазы `PREPARED → COPIED → VERIFIED →
  COMMITTED → V2_WRITES_ENABLED`. Reducer и durable manifest store готовы;
  exclusive fail-closed lock и resumable preparation до `VERIFIED` готовы;
  `COMMITTED` и activation остаются отдельным согласуемым cutover.
- [ ] Добавить полный fault injection на границах публикации и recovery, не удаляющий
  pre-existing roots.
- [x] Реализовать безопасные атомарные archive/restore transitions и монотонную
  generation в v2 core registry.

**Приёмка:** WP-01…WP-07; v1 fixtures; corrupt-state corpus; restart на каждой
фазе; доказательство, что одновременно авторитетна ровно одна schema.

### Этап 2 — ProjectService и жизненный цикл контекста

**Изменения:**

- [ ] Ввести `ProjectService` как единственную поверхность create/register/
  clone/archive/restore/switch/session operations.
  - [x] Поднять purpose-bound archive/restore Project/Session в core service:
    generation CAS, active replacement, exact interactive/background lease
    drain, root revalidation, identifier-only events и restart evidence.
  - [x] Закрыть acquisition race общей transition barrier: новый turn/job не
    получает lease между snapshot/drain и archive/switch/create publication.
  - [x] Реализовать durable production-preview `ProjectLifecycleAuthority`:
    отдельные purpose/HMAC-domain/store, exact intent binding, TTL, one-use,
    consumed tombstone и restart/replay evidence; live-команды не включать.
  - [x] Реализовать отдельный preview Telegram/NL confirmation adapter для
    archive Project/Session: exact auth, двухшаговый confirm, общий one-use
    update domain, TTL, target identity/generation и request+confirm provenance;
    cancel/replay/drift/failure не выпускают authority и не раскрывают детали.
  - [x] Добавить неактивированный транспортный seam Bot для lifecycle и Session controls:
    Gateway-authenticated text идёт lifecycle → Session → Project до получения
    turn runtime, callback использует отдельный exact namespace и chat/update
    provenance, а terminal edit имеет fallback тем же reply. Обработанный маршрут
    имеет нулевые runtime/model I/O, отсутствие зависимости сохраняет legacy;
    `aisy.ts` не подключён.
  - [x] Подключить lifecycle archive/restore controls в live Telegram
    composition после отдельного согласования активации. Активировано:
    `bin/aisy.ts` передаёт боту `projectLifecycleControls`
    (`makeTelegramProjectLifecycleControls` поверх `projectRuntime` и
    `lifecycleRuntime.authority`). С 2026-08-17 архивация проекта или сессии
    дополнительно запускает каскад забывания выученной автономии (спека 24
    AC-24-10).
  - [x] Добавить единый preview-adapter session create/rename/search через
    `ProjectService`: exact Telegram owner, RU/EN deterministic pre-router,
    generation CAS, stale no-write и отсутствие неявного session switch.
  - [x] Добавить preview `register-existing` через `ProjectService`: absolute
    canonical non-symlink root, device/inode stability вокруг confinement scan,
    duplicate recheck, no source-tree writes, recovery-required после поздней
    ошибки и реальный Node filesystem test.
  - [x] Подключить session create/rename/search controls в live Telegram
    composition по отдельному согласованию live activation. Активировано:
    `bin/aisy.ts` передаёт боту `sessionControls` (`makeTelegramSessionControls`
    поверх того же `projectRuntime`), рядом с `projectControls`.
- [ ] Сделать slug reservation, staging, atomic publication, quarantine и
  doctor recovery.
- [x] Реализовать core `SwitchAuthorityReceipt`: owner/target/session/generation,
  TTL, one-use, MAC и защита от replay.
- [x] Подключить preview Telegram Project picker и authenticated RU/EN
  pre-router к одному `ProjectService`: opaque one-use callback,
  exact chat/update/text/target/generation binding, ambiguous no-mutation,
  stale/replay/foreign deny и двухпроектный restart E2E. `aisy run` не
  переключён; live activation не выполнялась.
- [ ] Реализовать restricted public-HTTPS clone без credentials, redirects,
  local/private networks, option injection и escaping symlinks.
  - [x] Добавить чистую URL/DNS-политику: HTTPS-only, без credentials/query/
    fragment/custom port, непустой безопасный путь, весь A/AAAA-набор должен
    быть публичным, а результат фиксирует exact IP set и TLS hostname.
  - [x] Подключить disabled-by-default clone orchestration к общим reservation,
    staging, confinement scan, atomic registry publish и quarantine путям.
  - [x] Согласовать [ADR-0066](../../decisions/2026-07-27-one-shot-sandbox-for-public-clone.md)
    и реализовать code-verifiable transport-контракт: digest-pinned one-shot
    sandbox, exact reviewed IP:443 через isolated egress-gateway, TLS hostname,
    отсутствие credentials/direct route/host network/Docker socket, лимиты
    CPU/RAM/PID/time/disk и строгая policy attestation до scan/publication.
  - [x] Реализовать доверенный Node supervisor, exact-IP CONNECT gateway и
    credential-free Git worker: internal `ipvlan`, dual-network gateway,
    quota-tmpfs export без host mount, фактический Docker inspect, OOM/timeout/
    cancel outcomes, minimum Docker Engine 29.5.2 и обязательный cleanup до
    attestation.
  - [x] Добавить read-only `aisy doctor` gate: disabled=`warn`, enabled требует
    Docker ≥29.5.2, две digest-qualified ссылки и exact локальные RepoDigest;
    тот же version/digest predicate использует supervisor, а post-upgrade
    включает sandbox compatibility.
  - [x] Подтвердить на реальном локальном Docker 27.4.0 read-only fail-closed:
    opt-in smoke разрешает только `docker version`, получает
    `CLONE_DOCKER_RUNTIME_INCOMPATIBLE` и не запрашивает создание сети или
    контейнера.
  - [ ] Доказать профиль реальным Docker E2E с restart/quota/escape/rollback
    fixtures и только затем скомпоновать clone в live runtime по отдельному
    activation approval.
- [x] Генерировать человекочитаемый `PROJECTS.md` только из registry.

**Приёмка:** WP-19…WP-22, WP-34…WP-37; concurrent-create fixtures; SSRF/DNS
rebinding corpus; disk-full и atomic-rename failures.

### Этап 3 — Lease и per-turn runtime

**Изменения:**

- [x] Ввести `TurnContextLease` и `ContextLeaseCoordinator` со статусами active,
  cancelling и closed.
- [ ] Передавать lease в context assembly, memory, tools, approvals, delegation,
  tasks и observability.
- [ ] Удалить startup root/session/chat-id fallback из live request paths.
- [x] Реализовать core switch barrier: запрет новых операций, cancel, завершение
  атомарной I/O, закрытие старого lease, публикация generation+1.
- [ ] Закрепить durable background job за собственным project-bound lease.

**Приёмка:** WP-11, WP-14…WP-16, WP-38…WP-41; race tests switch/tool/callback/
restart; `STALE_CONTEXT` до I/O.

### Этап 4 — Sessions, transcript и файлы

**Изменения:**

- [ ] Ввести session manifest, frozen-prefix snapshot/hash и полный
  `transcript-v2.jsonl` с устойчивым `sessionSeq` и hash chain.
  - [x] Core exact-schema/hash-chain, code-owned load-bearing classifier,
    Node WAL/fsync/restart/quarantine, offline recorder Agent Loop/AgentRunner и
    authoritative session-start: новый manifest получает фактический model
    prefix, restart возвращает stored prefix вместо изменившегося candidate;
    проверенная prior history проходит read-only Context Engine projection и
    входит в следующий model request без повторного append.
  - [x] Добавить offline lease-bound transcript wrapper: exact binding/request
    session, `STALE_CONTEXT` до delegate I/O и drain уже начатой операции при
    quiesce; restart integration использует wrapper с реальным Node store.
  - [x] Передать в интерактивный Telegram runner content-independent authority
    exact coalesced/steering batch из `update_id` и исходного `message.date`.
  - [x] Вынести production Node transcript composition в ленивую фабрику:
    mismatch не касается filesystem, разрешённый вызов собирает полный
    lease-bound restart path.
  - [ ] Добавить durable ingress/coalescing journal, background dispatch
    identity, передать lease/binding из live composition, реализовать
    partial-turn recovery и singleton writer.
    - [x] Telegram forwarded-message batching подключён к `aisy run`: текущий
      `forward_origin`/legacy metadata, растущий `📨 ... (N)` counter, quiet
      window от последнего item, exact binding/order/update identity, private
      checksum/CAS store, restart collecting и no-replay quarantine для
      `dispatching`. Forwarded text/caption входят в один turn как `untrusted`,
      последующий typed text — как bound operator instruction; общий порядок
      типов сохраняется. Completed archive дедуплицирует каждый update по точным
      байтам, quarantine остаётся повторно отправляемым, а межпроцессный lock
      блокирует competing writer. Forwarded media/voice не запускают второй
      ingress path. Это не закрывает общий SessionActivityJournal/singleton
      writer ниже.
    - [x] Реализовать offline `SessionActivityJournal` v1: exact Telegram
      ingress и ordered seal, стабильные trigger/goal/nightly occurrence,
      FSM/revision/operation-sequence CAS, transcript evidence,
      pending/recorded outcome-uncertain и terminal replay; private atomic Node
      store использует full-binding hash, observed-byte CAS и quarantine.
      Preview не имеет singleton writer и не импортируется live composition.
    - [x] Историческое сравнение singleton-вариантов и первоначальная
      рекомендация process-lifetime directory lease оформлены в
      `docs/reviews/2026-07-27-transcript-singleton-writer-options.md`.
    - [x] Принят [ADR-0068](../../decisions/2026-07-29-session-journal-singleton-writer.md)
      и уточнён: steady-state authority — kernel-released local-FS SQLite
      `BEGIN IMMEDIATE`, exact DB identity + immutable anchor, crash-safe
      initialized-temp/hardlink/fsync bootstrap и permanent regular
      `.transcript-writer.lock` compatibility barrier для старых binary.
      Legacy directory/residue требует отдельного ручного proven-quiescence
      cutover; PID, `mtime`, stale unlink и time takeover запрещены.
    - [x] Реализовать уточнённый SQLite writer lease и production gate. Exact
      layout: `${journalRoot}/.transcript-writer-lease/` mode `0700`, DB
      `transcript-writer-lease.sqlite3` и anchor
      `transcript-writer-lease.sqlite3.identity.json` mode `0600`, anchor exact
      `{version:1,role:'transcript-writer',databaseId,dev,ino}`; permanent
      `.transcript-writer.lock` — regular file mode `0600` exact
      `{version:1,kind:'transcript-writer-sqlite-v1',databaseId,dev,ino}`. При
      enabled journal любой busy/corrupt/unsafe/legacy/identity отказ обязан
      остановить весь runtime до provider/tool/Telegram I/O. Exact
      `AISY_SESSION_JOURNAL=0` остаётся current-binary rollback без mutation
      DB/anchor/barrier/transcript. Автоматически завершается только exact
      barrier crash boundary: `nlink=2` + ровно один same-inode private
      `..transcript-writer.lock.compat.<32-lowercase-hex>.tmp`; любой иной
      hardlink/residue остаётся fail-closed. Evidence: transcript-тесты на
      реальных процессах — 12/12; объединённая process-матрица — 31/31; полный
      App gate — 132 файла тестов успешно / 1 пропущен, 1031 тест пройден /
      1 пропущен; typecheck App и upstream-сборка зелёные.
    - [x] Обновить `aisy doctor` как строго read-only inspector нового DB/anchor/
      barrier состояния. Ни обычный запуск, ни `--fix` не выполняют recovery.
    - [ ] Выполнить репетицию ручного legacy cutover и process self-test на
      целевой FS Linux/macOS: contention, real `SIGKILL` release и
      reacquire того же DB inode; NFS/SMB должны блокировать LIVE.
- [ ] Сохранить legacy event log byte-identical и обозначить старые сессии как
  `metadata-only` без выдуманного диалога.
  - [x] Core metadata-only registration и явная v2 migration-boundary row.
  - [ ] Подключить registration/boundary к migration coordinator только при
    согласованном cutover.
- [ ] Подключить lease-aware read/write/list и root-only bash; закрыть absolute,
  traversal, symlink, magic-link и mount escapes до target I/O.
  - [x] Реализовать lease-bound `edit_file` как single-operation
    descriptor-relative exact replacement: unique-match по умолчанию,
    explicit replace-all, stale/path-change/symlink/hardlink/mount deny,
    atomic publication и real Node→Python evidence. Provider catalog и live
    v2 routing остаются за activation gate.
    Gate после инкремента: Python 46 passed / 1 platform skip, Core 1577 passed /
    1 opt-in skip, Telegram 123 passed, App 392 passed / 1 opt-in Docker skip;
    workspace typecheck/build, Ruff и `git diff --check` зелёные.
  - [x] Реализовать production-preview root-only `bash`: exact lease root,
    digest-pinned one-shot gVisor container, daemon userns/rootless proof,
    no-network/non-root/seccomp/cap-drop, RAM/CPU/PID/time/output limits,
    inspect-before-start, раздельные `start`/`wait`/final inspect/`logs`,
    final-state attestation, abort-on-switch и обязательный
    cleanup. Исправлен старый split-brain probe/config и невалидный
    `docker run --userns-remap`. Live wiring и реальный Docker E2E остаются за
    activation approval; Project disk quota — deployment prerequisite.
  - [x] Связать root-only bash, manifest-aware attachments и file confinement в
    одной production-preview Project tools factory на exact runtime lease.
    Composition не делает Docker I/O; fake-CLI integration доказывает полный
    `info/create/inspect/start/wait/inspect/logs/rm`, общий lease для read/import
    и `STALE_CONTEXT` без нового Docker I/O после release. Provider catalog,
    `aisy run` и live v2 routing не переключены. App gate: 393 passed и 1
    opt-in Docker skip; workspace typecheck/build зелёные.
- [ ] Реализовать inbox и атомарный attachment import с manifest, provenance,
  hash, WAL и идемпотентным recovery.
  - [x] Реализовать offline core state machine: exact owner/profile/session/hash,
    code-owned destination, untrusted provenance, project serialization,
    обязательный size cap и recovery на всех WAL boundaries.
    Доказательство: 10 core tests, включая 11 crash boundaries, concurrent retry,
    foreign/archived/stale/Workspace deny, collision, size/hash gates и forged
    `AUDITED` WAL.
  - [x] Добавить permission-restricted Node WAL/manifest/audit persistence,
    binary descriptor-safe staging/install и manifest-aware file visibility.
    Доказательство: real Node→Python restart, восемь durable crash points,
    binary/no-overwrite, symlink/hardlink/path и unpublished/tamper fixtures.
  - [x] Добавить Telegram ingress exact inbox writer и optional transport
    handler без live activation. Доказательство: generic media parser,
    fixed-origin Bot API streaming port, immutable binding/metadata authority,
    object-before-record publication, три crash boundaries, restart без
    повторного download, authz/limit/collision/symlink/path fixtures.
  - [x] Подключить importer к lease-bound `InteractiveTurnRuntime` через
    отдельный attachment-aware preview factory: только code-owned destination,
    безопасный metadata result, manifest-aware read/list и restart-idempotence.
    `aisy run` не переключён.
  - [ ] Добавить collision-choice UI, singleton writer и live wiring после
    согласования activation.

**Приёмка:** WP-04, WP-12…WP-13, WP-16…WP-18, WP-23…WP-24, WP-40;
adversarial filesystem suite и crash fixtures.

**Доказательства transcript-инкремента:** 13 core contract + 5 recorder +
8 Node WAL/restart + 5 lease-bound recorder tests; Agent Loop/Runner проверяют
stable turn authority, fail-closed до следующего I/O, exact effective tool span,
code-owned recovery и legacy-off совместимость. Русская спецификация — компонент
23, security review —
`docs/reviews/2026-07-27-session-transcript-security-review.md`. Live activation
намеренно не выполнена. Полный regression: 1505 TypeScript tests и 34 Python
tests зелёные, 1 platform-specific skip; build/typecheck/Ruff проходят.

Дополнение session-start: core recorder test доказывает stored-prefix resume, а
app integration через новый AgentRunner и реальный Node store продолжает
sequence/hash head после restart даже при изменившихся memory и Skills candidate,
а также доказывает prior history в следующем model request. Context Engine
projector сохраняет verbatim roles/provenance, непривилегированную user-role,
строгий summary provenance и load-bearing rows, не изменяя durable trace.

### Этап 5 — DNA и scoped hybrid memory

**Изменения:**

- [ ] Подключить полные слои DNA: constitution, SOUL, USER, MISSION, GOALS,
  PROJECTS, PREFERENCES, LEARNED и scoped project/session layers.
  - [x] Подключить полный global prefix: code-owned порядок из 11 ADR-0063
    файлов, fresh source snapshot для новой Session, freeze внутри текущей и
    persisted exact prefix/hash при restart. Реальный filesystem
    `MemoryStore → MemoryPort → AgentRunner → provider` integration доказывает
    mid-session неизменность и new-session refresh.
    Gate после инкремента: core 1540/1540 с 1 opt-in skip, Telegram 104/104,
    app 317/317 с 1 opt-in restricted-clone skip; workspace build и typecheck
    зелёные.
  - [ ] Докомпозировать active-project/session lazy layers через live lease,
    не включая их в глобальный frozen prefix.
    - [x] Реализовать lease-bound `LayeredContextAssembler` и обязательное
      preview-оборачивание runner: global → exact active Project,
      authenticated-operator query, untrusted spans, deterministic order,
      explicit project-only degradation и stale-switch deny до model call.
      Gate: 5 assembler tests, app wrapper test, 6 source-adapter tests и
      реальный Node→Python→AgentRunner integration; полный regression — core
      1545/1545 с 1 opt-in skip, app 325/325 с 1 opt-in restricted-clone skip,
      Telegram 104/104; workspace build/typecheck зелёные. App gate выполнен
      последовательно, чтобы тяжёлые Python integration не конкурировали за
      локальный 5-second per-test timeout.
    - [x] Подключить production source adapters для global journal/catalogue
      через exact Workspace binding и project `.current-task.md`, daily note,
      catalogues/retrieval через current lease; protected hits обязаны нести
      canonical path/provenance. Node→Python confinement integration доводит
      оба root через `AgentRunner` до model request.
    - [ ] Подключить layered source к live composition после
      migration/activation gate.
- [x] Исправить Unicode tokenization и FTS-запросы для русского/английского,
  сохранив fail-closed совместимость со старыми forget keys.
- [x] Реализовать offline lossless ledger/file migration preparation с
  tombstones, relations, forget-chain и provenance: byte-verified legacy
  backup, отдельный ledger без FTS, live-only canonical files, private staging,
  `PREPARED → COPIED → VERIFIED`, restart/tamper/source-drift evidence. Install
  и cutover API намеренно отсутствуют до согласования.
- [x] Реализовать offline core fact-publication WAL
  `PREPARED → DB_PENDING → FILE_INSTALLED → PUBLISHED → AUDITED`: exact scope,
  deterministic fact identity, pending ledger+outbox, hashed canonical file,
  idempotent ledger+keyword publication, audit-once, mandatory
  scope-exclusive barrier/read recovery gate и 19 crash/restart tests.
- [x] Реализовать permission-restricted Node ledger/WAL/file/FTS adapters:
  private modes, owner/profile/scope binding, физически отдельный FTS,
  exact-schema/hash/forget-chain проверки, immutable hard-link publication,
  межпроцессный SQLite barrier и реальный restart на 12 durable boundaries.
- [x] Реализовать offline delete/forget/update WAL: tombstone + append-only
  forget-chain, FTS/vector/cache/file purge, atomic old→new ledger swap,
  idempotent audit outbox, reopen validation, completed-retry resurrection
  checks и реальные restart matrices. Legacy `Memory.commit()` пока не
  переключать. Migration candidate остаётся owner-unbound и не может быть
  открыт live-store до отдельно согласованного binding/cutover.
- [x] Реализовать unified protected-memory recovery/read gate: атомарно
  проверять publication/deletion/update WAL + final integrity под exact
  scope-lock, восстанавливать только один допустимый family и fail-closed
  отклонять несколько одновременных family как corrupt recovery state.
- [x] Реализовать core global/project fail-closed routing: Workspace читает
  только global, Project — global+exact leased project; автоматического
  cross-project fallback нет. Live v2 factory остаётся выключенной.
- [x] Подключить protected ledger/WAL/file stores к lease-bound
  `ScopedMemoryRouter` в Node preview: обязательный recovery перед I/O,
  canonical-file verification, controlled Project keyword degradation,
  fail-closed ledger/scope/recovery и code-owned authorization boundary для
  human-confirmed delete/forget. `off` возвращает `null`; `aisy run` и legacy
  `Memory` не переключены.
- [x] Реализовать ADR-0029 для permanent forget: exact target/file verification
  до карточки, Tier-3 hash pin по lease/scope/operation/key/path/content/reason,
  обязательный Gateway step-up proof, HMAC receipt, private durable
  consume+tombstone и audit tap→fact. Replay, restart, stale/mismatch/tamper и
  audit failure доказаны fail-closed; live memory binding остаётся выключенным.
- [x] Реализовать offline production runtime OpenRouter embeddings и физически
  изолированные sqlite-vec indexes: exact pin `0.1.9`, scope/descriptor identity,
  restart integrity, content-addressed query/document cache и persisted revoke.
  Semantic store теперь опционален: `provider=none` не создаёт sqlite-vec, а
  недопустимый OpenRouter descriptor отклоняется до создания любых memory
  artifacts. Live provider key/consent/activation не подключены.
- [x] Реализовать keyword/semantic/hybrid, RRF `k=60`, cap 20 и явный
  receipt-based all-project search.
  - [x] Protected per-scope router вызывает нормативный `makeHybridRetrieval`:
    independent legs, deterministic RRF, bytewise tie-break, semantic-only hit
    вне keyword top-20, visible degradation и cross-scope/stale-content hard
    failure. Результат обязательно несёт `requestedMode`, `effectiveMode`,
    `status` и `componentRanks`.
  - [x] Global+exact-project automatic composition без cross-project fallback и
    без project-first shortcut; partial semantic availability сохраняет
    verified hits здорового scope.
  - [x] После fusion каждый hit повторно materialize/verify через protected
    ledger, forget/tombstone filter, exact scope/path/canonical content hash и
    canonical file. Exact canonical hash не подменяется нормализованным
    embedding-cache hash.
  - [x] Отдельный offline receipt-based all-project fan-out: Workspace-only,
    owner/query/generation/mode/archive/limit HMAC receipt, no common index,
    exact-scope validation, deterministic merge, one-use excerpt capability и
    durable nonce consumption across restart. Live pre-router wiring выключен.
- [x] Исключить secrets, protected paths и forgotten content до внешнего
  embedding request и из derived indexes: deterministic scanner, mandatory
  `verifyLive` на upsert/search, cache-after-publication, forget purge и
  abort-before-revoke.
- [x] Добавить positive-only semantic reconciler, готовый для startup и
  post-commit composition: recovery/scope validation до provider I/O,
  stable live snapshot, unavailable/revoked zero embed, redacted per-item
  failures, stale retry на следующем request, single-flight/coalescing и
  idempotent close. DELETE/UPDATE WAL остаётся единственным владельцем purge.
- [x] Принять ADR-0087 для opaque secret broker/backend/proxy без plaintext
  fallback и ADR-0088 для durable exact-bound semantic-egress consent. Это
  contract checkpoint, а не live activation.
- [x] Реализовать offline foundation ADR-0088: code-owned exact disclosure,
  обязательный boot recovery, durable `AWAITING_CONSENT`, атомарные
  record+nonce+outbox transitions, singleton SQLite writer, restart invalidation,
  строгие outbox anchors/ack и real SQLite cross-layer E2E. Provider I/O не
  подключён.
- [x] Реализовать atomic use/revoke barrier: специализированный exact-ACTIVE
  use-start, authority-owned lease/AbortSignal, взаимное исключение publish и
  revoke, фактический drain до purge и real SQLite race-test.
- [x] Реализовать outbox delivery recovery worker и restart/fault matrix:
  insertion-order HOL, exact duplicate sink, atomic head-only ack, bounded
  timeout/stop, cross-instance single-flight и real SQLite redelivery.
- [ ] Реализовать расширенную process-kill fault matrix при live composition и
  ADR-0087 platform backend/proxy, затем
  подключить OpenRouter provider, semantic
  runtime и reconciler к startup/post-commit lifecycle в `bin/aisy.ts`.
  До этого semantic/hybrid не считать LIVE и пользовательские memory
  query/chunks во внешний embedding provider не отправлять.

Evidence текущего ADR-0065 foundation slice: полный workspace regression —
3234 теста прошли, 2 пропущены (Core 2039/1, Telegram 146/0, App 1049/1);
workspace typecheck и build зелёные.

Memory checkpoint: полный regression после hybrid, migration, all-project и
publication-WAL/Node-adapter инкрементов — 1606 TypeScript tests (1275 core, 102 Telegram
gateway, 229 app), 34 Python passed и 1 platform-specific skip. Live activation
и migration cutover не выполнялись.

Global DNA checkpoint: legacy live `MemoryPort` теперь включает все 11 файлов
ADR-0063 вместо четырёх и больше не кэширует source bytes на lifetime процесса;
session freeze остаётся в Agent Loop, restart authority — в durable transcript.
Новые тесты покрывают exact order, real filesystem, два turn одной Session,
новую Session после правки DNA и existing real Node transcript restart.

**Приёмка:** WP-03, WP-08…WP-10, WP-25…WP-33; русские fixtures; negative recall
между двумя проектами после restart/compaction/rebuild; provider revoke tests.

### Этап 6 — Brain connections и Telegram onboarding

**Изменения:**

- [ ] Подключить state machine onboarding к реальным драйверам и production
  credential path ADR-0087.
- [x] Реализовать Claude subscription driver и Codex subscription driver с
  capability negotiation; подключить API keys для Anthropic/OpenAI-compatible
  providers. Оба драйвера собраны в живом `makeBrainBootstrapCoordinator`
  (`bin/aisy.ts`) вместе с установщиком runtime; ключи провайдеров идут через
  vault и экран «🔑 Ключи сервисов». Доступность подписочного мозга зависит от
  установленного на машине CLI: на fr1 ни `claude`, ни `codex` не установлены,
  и координатор честно показывает это в онбординге.
- [ ] Не объявлять brain готовым до install/auth/capability/health validation.
  - [x] Усилить offline/read-only Codex run-readiness и pinned event FSM:
    exact Project/Session/root, `codex-cli 0.144.5`, повторная auth validation,
    exact thread/turn lifecycle, retryable/non-retryable error и обязательный
    bounded EOF/cleanup после terminal. Evidence:
    `runtime/codex-app-server-driver.spec.ts` и
    `runtime/brain-provider-adapter.spec.ts`.
  - [x] Добавить dormant Claude read-only protocol/process boundary с exact
    terminal schema и fail-closed isolation: caller attestation удалена, без
    code-owned managed-policy/container runtime запуск останавливается до
    `spawn`/`exec`. Concrete Node supervisor завершает только exact process
    group, ждёт `ESRCH`, а неподтверждённая остановка сохраняет stage и
    карантинирует turn. Evidence: 47 targeted tests и независимый security
    re-review PASS. Это не Claude activation: public exports, `aisy.ts`, OAuth и
    provider routing не подключены; API secret backend также остаётся открытым.
- [ ] Показывать пользователю режимы tool calling, ограничения reply-only,
  активную модель, thinking level и recovery без раскрытия credential metadata.
- [ ] Добавить управление подключениями и отзыв токенов из Telegram.

**Приёмка:** onboarding E2E для каждого класса подключения; expired/revoked/
cancelled auth; restart; отсутствие секретов в логах и repository scan.

### Этап 7 — Tools, Skills, MCP и agent DNA

**Изменения:**

- [ ] Включить production Skills и MCP через существующие core registries,
  allowlists, approvals, budgets и audit.
  - [x] Production Skills read path: version/hash/trace gate, durable quarantine,
    frozen menu, body-on-trigger, main/goal runtime и AgentCard-filtered child.
    Evidence: 123 targeted core + 3 restart persistence tests; полный regression
    1383 TypeScript tests и 29 Python tests зелёные (1 platform skip).
  - [x] Live read-only Skills-каталог: frozen active metadata,
    main-AgentCard intersection, отсутствие body в UI и bounded Telegram
    renderer. Evidence: 3 renderer + 2 projection + 2 bot-теста;
    полный gate: core 1570/1570 и 1 opt-in Codex skip, Telegram 121/121,
    App 374/374 и 1 opt-in Docker skip, workspace typecheck/build зелёные.
  - [ ] Promotion/doctor/telemetry path Skills и production MCP connect gauntlet.
    - [x] Добавить только offline configured-name projection/doctor: frozen
      safe names, readiness=false, active=0, transport=false и redacted
      code+counts event; без connect/spawn/invoke/quarantine и без live wiring.
    - [x] Validated transport policy и restart semantics реализованы по
      [ADR-0067](../../decisions/2026-07-29-mcp-dual-era-protocol-policy.md):
      отказ до spawn и сетевого контакта, эра только из human-owned манифеста,
      одноразовый замороженный план, verdict не переживает restart. Skills
      promotion/doctor/telemetry реализованы отдельным инкрементом.
    - [ ] Подключить реальный transport (stdio/Streamable HTTP) к этому
      gauntlet после фиксации SDK dependency; live activation отдельно.
  - [x] MCP offline gate: strict durable allowlist, approved descriptor hash,
    human-owned risk/tier/outbound, restart quarantine, frozen startup catalog и
    повторная pin/hash-проверка на том же handle перед каждым invocation.
    Evidence: 55 targeted core/capability + 3 Node restart tests; полный
    regression 1410 TypeScript tests и 29 Python tests зелёные (1 platform skip).
  - [x] Pre-live MCP capability gate: exact menu ownership/rw/tier, AgentCard
    intersection, InputGuard-classified byte-stable prompt menu, concrete
    policy resolution до HookGate, pending→authorized только после финального
    allow, one-use approval binding, policy/args TOCTOU check и bounded
    defanged/quarantined result ingestion. Generic `call_mcp`
    больше не скрывает Tier/outbound и не получает общий grant. Evidence:
    158 targeted MCP/catalog/HookGate/Safety tests и core typecheck зелёные.
  - [x] Live read-only MCP-каталог: startup валидирует durable allowlist,
    затем фиксирует безопасную policy-проекцию для Telegram.
    Меню чётко разделяет configured/active и не удерживает
    endpoint/pin/hash/token/raw descriptor. Evidence: 3 renderer + 2 projection +
    2 bot-теста. Полный gate: core 1570/1570 и 1 opt-in Codex
    skip; Telegram 118/118; App 370/370 и 1 opt-in Docker skip; workspace
    typecheck/build зелёные. Connect/spawn/invocation не активированы.
  - [x] Принять era policy и подключить validated transport policy к connect
    gauntlet: [ADR-0067](../../decisions/2026-07-29-mcp-dual-era-protocol-policy.md)
    фиксирует modern-first dual-era, а `mcp/transport-policy.ts` отказывает до
    spawn и до сетевого контакта при несоответствии transport полям, traversal
    или управляющих символах в argv, схеме кроме `https`, credentials,
    query/fragment, невалидном URL и host вне egress allowlist. Эра берётся
    только из own-поля `legacyProtocol` plain-объекта, поэтому загрязнение
    прототипа не даёт `dual-era`; argv валидируется тем же снимком, который
    уходит в spawn; план заморожен и выводится заново в `connect` и каждом
    `call`, поэтому verdict не переживает restart. Durable manifest принимает
    `legacyProtocol` и карантинирует некорректное одобрение отдельной причиной
    `invalid-era-approval`. Evidence: 28 тестов `mcp/transport-policy.spec.ts`,
    2 теста allowlist и отказ-до-spawn в `mcp/mcp.spec.ts`; полный модульный
    срез MCP 96/96. `transportActive` остаётся `false`.
  - [ ] Принять transport dependency ADR, подключить stdio/Streamable HTTP,
    финальный MCP SDK/schema, `call_mcp`/prompt menu в main runtime и live
    activation. До проверки релиза 2026-07-28 transport остаётся выключенным.
- [ ] Сделать capability matrix источником доступных model tools, а не
  декоративного UI.
  - [x] Единый live narrow-waist каталог для текущих 10 инструментов:
    provider schemas, executor allowlist, минимальные tiers, effect/outbound
    metadata и exact runtime validation производятся из одного immutable
    literal tuple. Старый compat registry больше не расширяет waist и также
    производится из этого каталога. Main/goal проходят единый Pre/PostToolUse;
    child получает только реально исполнимое scoped подмножество до model I/O.
    Повреждённый или нечитаемый существующий vault/`.env` делает redaction
    недоступной и удерживает весь tool result; отсутствующий источник считается
    доступным пустым слоем. Evidence: независимый re-review PASS; полный gate
    Core 1815/1815, Telegram 124/124, App 652/652, два opt-in skip;
    workspace typecheck/build и `git diff --check` зелёные.
  - [x] Для subagent provider: строгий AgentCard parser, обязательная Markdown
    DNA, exact tool schemas, fail-closed Skills/MCP references и community
    narrowing.
  - [x] Подключить тот же matrix к main/goal agent за opt-in gate
    `AISY_MAIN_AGENT_CARD`: exact provider schemas, независимо ограниченный
    executor, filtered Skills, immutable DNA/provenance и card iteration cap.
    Неизвестная/невалидная карта блокирует startup до model I/O; без настройки
    legacy path сохраняется до согласования live activation. Evidence: 4 app
    tests + app typecheck/build.
  - [ ] Подключить production MCP registry и динамическую per-turn provider
    composition; выполнить согласованный live-default cutover main AgentCard.
- [ ] Ввести создание/редактирование/архивацию Agent Cards с полной DNA,
  разрешёнными tools/skills/MCP, model policy, budget и context binding.
  - [x] Принят [ADR-0069](../../decisions/2026-07-29-agent-card-lifecycle.md):
    scopes Workspace/Project без слияния, forward-only ревизии `name@revision`,
    запущенная делегация не меняется задним числом, publish/archive под
    одноразовым step-up approval, явная миграция legacy `.md`.
  - [x] Реализовано core-ядро registry по ADR-0069: forward-only ревизии
    `name@revision` с byte-stable canonical hash, publish/archive только по
    одноразовому step-up approval, привязанному к exact scope/имени/ревизии и
    hash; архивная ревизия не запускается, но остаётся доступной для аудита;
    Project-карта полностью затеняет Workspace-карту без слияния matrix;
    legacy-импорт допустим только как ревизия 1 с provenance `legacy-import`;
    опубликованная ревизия неизменяема при мутации исходного объекта. Evidence:
    11 тестов `runtime/agent-card-registry.spec.ts`.
  - [x] Добавить durable persistence реестра: приватный атомарный JSON,
    восстановление ревизий и архивов после restart, отбрасывание ревизии с
    расходящимся hash, пустой реестр при повреждённом/oversized/отсутствующем
    состоянии. Evidence: 5 тестов `app/agent-card-registry-store.spec.ts`.
  - [ ] Подключить CLI/Telegram-поверхности и live cutover loader'а на registry;
    до этого loader остаётся read-only.
- [ ] Довести subagent delegation: immutable scope, depth/concurrency/budget,
  cancellation, verified result и Telegram status cards.
  - [x] Durable checkpoint/resume: exact binding/card/task/capabilities,
    hash-chain, inherited run budget, archive gate и recoverable quarantine.
  - [x] Добавить disabled-by-default production-preview runtime: явная startup
    recovery policy, terminal replay, cancellation, verifier-owned result и
    budget validation без live-активации.
  - [x] Усилить delegation boundaries: итеративный shard preflight 128-depth/
    1 MiB, exact DAG limits 256/2048/64 с known/acyclic/exact edges, terminal
    recovery parity и zero-respawn при missing snapshot, cumulative cost floor
    включая подтверждённую cancellation.
  - [x] Добавить core-only immutable delegation authority и bounded scheduler:
    exact binding/DNA/capabilities/scope/budget hashes, first-shard seal до
    provider construction, concurrency ceiling, write-scope serialization,
    cancellation, manager-owned terminal replay и честный interrupted при
    uncertain persistence. Evidence: `runtime/agent-capabilities.spec.ts`,
    `runtime/sub-agent-runner.spec.ts`, `runtime/delegation-driver.spec.ts`.
    Live app wiring не выполнен.
  - [ ] Подключить store/runtime в live binary, определить run-id scan/cutover,
    связать реальные child/provider adapters с cancellation и добавить Telegram
    status cards.

**Приёмка:** live structured tool calls через API и subscription drivers;
MCP/Skill denial tests; agent/subagent E2E; no capability escalation.

### Этап 8 — Обучаемая автономность, мониторинг и дайджесты

**Изменения:**

- [x] Записывать демонстрации с evidence и предлагать promotion по лестнице
  autonomy; никакого silent grant widening. Живая композиция создаёт журнал
доказательств и реестр грантов (ADR-0103), наблюдает ответы оператора портом
  `observeApproval`, предлагает дозревший процесс карточкой тира 3, гасит
  автономию нормативным демоушеном и каскадом забывания на архивации проекта
или сессии. Второй фактор на карточке опционален (ADR-0104): подтверждает её
  тап оператора. Evidence: `app/autonomy-live-wiring.spec.ts`,
  `core/autonomy-promotion.spec.ts`, `core/autonomy-evidence.spec.ts`,
  `core/safety/autonomy-workflow-step.spec.ts`, спека 24 AC-24-10/14…17.
- [x] Привязать goals/triggers/nightly к `WorkBinding`; legacy unscoped
  goals/triggers карантинировать paused/disabled.
- [x] Перевести grants на persisted binding: `session` действует только в exact
  session, `always` — только в исходном Workspace/Project/Session; legacy
  unscoped grants сохранять выключенными до явного назначения.
- [x] Перевести локальный monitoring/digest core на persisted binding/resolver;
  live egress adapter, scheduler wiring и Telegram delivery оставить закрытыми
  до отдельного activation шага.
- [x] Реализовать source collection, deduplication, evidence ranking, digest
  store и delivery window; добавить code-owned delivery coordinator с повторной
  проверкой binding перед каждым I/O, bounded batch, idempotency key и
  receipt-only переходом в `delivered`.
- [x] Добавить неактивированный Telegram digest renderer/adapter: русский
  evidence-linked HTML, лимит 4096, экранирование untrusted полей/URL attributes,
  exact operator/chat route, exact-payload egress guard и receipt из message id.
- [x] Добавить optional `tickMonitoring` в единый app scheduler; callback
  отсутствует по умолчанию, ошибки изолированы от triggers/goals/nightly.
- [x] Пассивно подключить local monitoring store и Telegram status:
  exact binding до read, aggregate counts без locator/content, deny-all HTTP,
  collection/delivery/scheduler выключены.
- [ ] Реализовать verified action follow-ups и подключить scheduler/egress/
  Telegram delivery callback в production composition только отдельным
  activation-шагом.
- [ ] Заменить статический nightly input живым day log; LEARNED и skill drafts
  проходят review/promotion.
  - [x] Убрать boot-time facts/validators: каждый `run()` под `night.lock`
    получает один свежий согласованный snapshot; source failure закрывает run
    до generator/judge и освобождает lock. Evidence: 36 core tests, 1 real
    MemoryStore integration и 1 loader test. Живой day log и skill drafts ещё
    не подключены.
  - [x] Подготовить exact-Session transcript→day-log projection и lease-bound
    Node source: hash chain/binding/sequence recheck, UTC date, provenance,
    system/DNA/Skill exclusion, bounded no-truncation, restart и two-Project
    isolation. `tool-call`/`decision-journal` из текста не угадываются.
    Evidence: 7 core + 4 app tests; полный gate: Core 1619/1619 + 1 opt-in
    Codex skip, App 472/472 + 1 opt-in Docker skip, typecheck/build зелёные.
  - [x] Добавить explicit per-Project maintenance orchestration: durable strict
    binding snapshot, targeted barrier/drain, отдельные Project A/B snapshots,
    restart и обязательный removal-only forget-filter без fabrication/reorder.
    Evidence: 2 core ProjectService tests и 15 app targeted tests; focused
    build/typecheck зелёные.
  - [x] Подключить concrete protected-memory forget authority к offline
    coordinator: общий deterministic fact-key normalizer и default preparer,
    verdict-only global+exact-Project store API, recovery/scope barriers,
    exact/residual removal, restart и redacted fail-closed telemetry. Evidence:
    2 normalizer tests, 1 новый real SQLite deletion/verdict test, 3 app
    global+Project integration tests и общий coordinator fixture. Live wiring
    всё ещё ждёт versioned structured activity source и отдельный activation
    approval. Полный gate: Core 1624/1624 + 1 opt-in skip; App 485 passed,
    один известный contention-timeout тяжёлого attachment integration, его
    немедленный isolated повтор прошёл 13/13. Workspace typecheck/build и
    `git diff --check` зелёные.

**Приёмка:** ADR-0061/0062 scenarios; deterministic budgets; delayed Project A
job остаётся в A после switch в B; archive/revoke/pause/restart tests.

### Этап 9 — Media, streaming и финальная Telegram UX

**Изменения:**

- [x] Поддержать voice/photo/video/document/album intake через inbox и
  provenance pipeline.
  Transport теперь всегда даёт явную redacted деградацию без download, если
  inbox не активирован; optional handler E2E сохраняет document и batched photo
  album под одним exact binding, выдаёт одну summary-card и ограничивает группу
  десятью downloads. **Активировано:** `bin/aisy.ts` создаёт
  `makeSingletonTelegramAttachmentInbox` и передаёт боту `attachmentInbox` и
  `voiceIngress`; альбомы собираются штатным окном тишины. С 2026-08-17
  оборванный writer lock (директория без владельца после убитого процесса)
  убирается при запуске сам — прежде он выключал приём вложений и голоса до
  ручного вмешательства (AC-02-47).
  - [x] Добавить durable Telegram activity/reply/media preview с единым exact
    operator/profile/Project/Session/chat binding: ordered ingress seal,
    owner/revision reply checkpoint, content-independent media/album identity,
    terminal/ack restart и zero-I/O для неоднозначной доставки. Evidence:
    `app/bot-streaming-activity-coordinator.spec.ts`,
    `app/bot-streaming-restart.integration.spec.ts`,
    `app/telegram-reply-stream-checkpoint.spec.ts`,
    `app/bot-media-ingress-journal.spec.ts`,
    `app/bot-media-restart.integration.spec.ts`. `bot.ts`/`aisy.ts` live
    activation не подключена.
- [ ] Подключить Whisper sidecar как optional capability с явной деградацией.
  - [x] Production-preview worker/adapter: descriptor-relative Python worker,
    local-model-only backend, строгий JSON protocol и one-shot Docker supervisor
    с exact image digest, `network=none`, read-only/non-root/cap-drop/seccomp,
    PID/RAM/CPU/time bounds, inspect-before-stdin, ambiguous-create recovery и
    mandatory cleanup. Transcript всегда bounded `untrusted/voice`; live image,
    inbox/Gateway wiring и degrade default не активированы.
    Evidence: 10 app isolation/recovery tests, 6 Python worker/process tests;
    Python 52/52 и 1 platform skip, Ruff зелёный.
  - [x] Offline private-inbox → Whisper coordinator: exact captured binding,
    durable object/hash/size authority, bounded `untrusted/voice` outcome,
    explicit `text-only|reject`, integrity hard-refusal, cancellation boundaries,
    restart without Telegram redownload и single-flight container quota.
  - [x] Выключенный bot composition seam: один captured binding для coordinator
    и exact background runtime, substituted outcome refusal, общий `/stop`
    AbortSignal, buffered-turn single-flight guard, restart без redownload и
    rollback через отсутствие опции. Composition в `aisy.ts`, image supply и
    live degrade policy не активированы.
    Evidence: targeted media/voice/inbox/Whisper 46/46; полный App gate в serial
    режиме 432/432 и 1 Docker opt-in skip; typecheck/build зелёные. Parallel
    suite отдельно выявил только host-contention timeouts, все 14 упавших
    filesystem/process integration checks прошли изолированно.
  - [x] Offline singleton media-inbox writer: atomic private lock directory,
    exact owner token, guard до network I/O, clean restart без redownload,
    fail-closed abandoned/foreign lock и запрет завершения владения при active
    ingest. Автоматический takeover по сроку/PID намеренно отсутствует; doctor
    recovery и live composition не активированы.
    Evidence: inbox 19/19; общий targeted media/voice/inbox/Whisper 50/50;
    typecheck зелёный.
    Последний serial full App gate: 436/436 passed и 1 opt-in skip; build зелёный.
    После review owner-init recovery: inbox 20/20, общий targeted gate 51/51.
  - [x] Read-only media writer finding подключён к настоящему `aisy doctor`:
    held/corrupt high-fail, absent pass, archived recovery count bounded,
    `--fix` всегда zero-write. Отдельный offline recovery adapter требует exact
    fingerprint-bound approval и exclusive quiescence lease, атомарно архивирует
    owner evidence без удаления, fences старый runtime и восстанавливает exact
    lock только при отсутствии нового writer. Mutating CLI path и live voice не
    активированы.
    Evidence: recovery 9/9, inbox 20/20, onboarding 72/72; final serial App
    446/446 + 1 opt-in skip, serial Core 1601/1601 + 1 opt-in skip; App/Core
    typecheck и build зелёные.
  - [x] Согласовать supply chain образа Whisper:
    [ADR-0072](../../decisions/2026-07-29-reproducible-whisper-image.md)
    фиксирует CPU/int8 multilingual `small` внутри образа, exact model
    revision с file manifest, Python 3.12 locked wheels без source builds,
    digest-pinned базу, двухфазный networkless build, multi-arch, SBOM и
    provenance, baseline 3 GiB. Сборка Dockerfile, dependency lock и publish —
    отдельный шаг: они требуют сети и целевого Linux-хоста для benchmark.
  - [ ] Собрать образ по ADR-0072 и провести обязательные проверки до publish;
    live composition остаётся выключенной.
- [x] Добавить безопасный базовый event/token stream и `/stop`: code-owned
  lockout verdict выходит из agent loop до provider, read-only Brain adapter
  передаёт structured deltas, Telegram редактирует одно guarded сообщение;
  locked/cancel/finalization покрыты transport-тестами.
- [x] Добавить code-owned tool/subagent lifecycle и отдельную Telegram execution
  card: pending/running/completed/denied/failed, elapsed time, terminal status,
  coalesced edits, locked redaction и cancel; args/results/raw errors не выводятся.
  Полный gate: core 1569 passed + 1 opt-in skip, Telegram 111/111, app 356
  passed + 1 Docker opt-in skip; workspace typecheck/build зелёные.
- [ ] Добавить расширенные action cards, live usage/status events и полное
  recovery-поведение для потокового runtime.
  Накопительный code-owned `turn-usage` уже подключён к execution-card; прямое
  provider `usage` UI игнорирует. Code-owned action kind, единственная recovery-
  попытка и authoritative verified/unverified также отображаются с locked
  redaction. Реализован optional offline durable checkpoint: strict redacted
  schema, hashed chat/session/turn binding, checksum, private atomic Node store,
  `prepared/bound/terminal` + `pending/delivered`, owner/revision fencing,
  exact-message restart edit и честная replacement-card для неоднозначного окна
  первого `sendMessage`. Bot seam создаёт checkpoint до provider work, но по
  умолчанию отсутствует. Live startup recovery требует service-manager
  quiescence composition и остаётся выключен до activation.
  Read-only finding подключён к настоящему `aisy doctor`: absent/clean pass,
  pending/corrupt high-fail, `--fix` всегда zero-write и не раскрывает
  binding/owner/path. Recovery через doctor не выполняется.
  Offline startup coordinator теперь требует единый внешний service-manager
  lease с exact opaque binding и quiescence, повторно проверяет lease перед
  Telegram I/O и всегда освобождает его. Bot захватывает opaque binding до
  checkpoint/provider work; private capture/release errors не выходят наружу.
  Kill/restart matrix с отдельным Node child и fresh store покрывает
  prepared-pending, bound-delivered, terminal-pending и clean terminal-delivered.
  Конкретный вид этого service manager закреплён
  [ADR-0071](../../decisions/2026-07-29-execution-recovery-parent-supervisor.md):
  parent supervisor с protocol-v2 IPC, отдельными manager и child-liveness
  SQLite lease и не более чем одним runtime child. Lease используют
  `BEGIN IMMEDIATE`. Manager lease автоматически
  освобождается ядром при hard-crash; новый parent получает runtime fence до
  любого state read/repair, удерживает через crash preparation, освобождает
  только перед exact spawn, а child захватывает его первым эффектом до hello и
  держит до OS exit. Direct `aisy run` сначала получает тот же fence, затем
  nonblocking probes manager DB: busy-manager даёт release и zero-I/O exit.
  IPC recovery authority у direct отсутствует. PID, `mtime`, stale unlink и
  time-based takeover запрещены.
  NFS/SMB не поддерживаются, process-level self-test на целевой FS обязателен.
  Уточнённый Node-runtime lease-протокол реализован и доказан: real manager
  `SIGKILL` с живым child и автоматическим reacquire, duplicate manager zero-child,
  direct-vs-supervised no-overlap, pre-hello/late-orphan zero-I/O, exact private
  DB identity, `lease_meta.database_id` 64 lowercase hex, immutable private
  `<lease-db>.identity.json` exact `{version:1,role,databaseId,dev,ino}`, exact
  `{version,path,dev,ino}` child descriptor, initialized-temp → atomic-hardlink
  bootstrap, безопасное завершение `nlink=2`, crash-window-only восстановление
  missing anchor и fail-closed anchor+missing/empty/mismatch/corrupt DB без
  reinit, безопасный recovery private rollback `-journal`, отказ при
  WAL/SHM/unsafe companions, unsupported-FS refusal и protocol-v2 conformance.
  Evidence: targeted unit 79/79, real-process parent 10/10, Telegram recovery
  9/9; полный workspace gate — Core 2019 passed / 1 skipped, Telegram 146,
  App 1013 passed / 1 skipped; Python sidecars 52 passed / 1 skipped, Ruff
  зелёный, fixture process leak — ноль. LIVE-активация, quiescence произвольных
  process groups/sidecars и transcript-writer recovery этим не заявляются; real
  Telegram sandbox E2E всей композиции ещё открыт.
- [ ] Завершить Project/Session/Brain/Agent/Memory/Monitor экраны без постоянной
  reply keyboard в free-text диалоге.

**Приёмка:** Telegram E2E для текста, media, cancellation и recovery; UX
контрактная матрица без `CORE-ONLY` или ложного `LIVE`.

### Этап 11 — Паритет с приватным эталоном

Эталон разделяет память по скорости доступа к контексту, даёт три режима поиска
и держит набор конкретных порогов, выведенных практикой. У Aisy сильнее
фундамент (защищённый ledger, bi-temporal факты, forget-цепочка,
scoped-полномочия, approvals), но ряд рабочих механик и почти все числовые
пороги у нас не воспроизведены. Реализуем независимо, ничего не копируя.

**11.1 Память — пороги и самодиагностика**

- [x] Явные режимы `keyword`/`semantic`/`hybrid` в `searchAutomatic` используют
  независимые legs и нормативный RRF `k=60`; semantic-only не зависит от
  keyword top-20. Каждый hit после ranking снова проверяется по protected
  ledger/forget/file, а `requestedMode`/`effectiveMode`/`status`/
  `componentRanks` делают keyword fallback наблюдаемым. `provider=none` остаётся
  безопасным keyword-only deployment без sqlite-vec и внешнего I/O.
- [x] Порог консолидации проекции `MEMORY.md`
  ([ADR-0078](../../decisions/2026-07-29-memory-thresholds-and-self-check.md)):
  предупреждение при 8 КБ, жёсткий предел 10 КБ, ориентир ≈200 строк. Предел
  режет проекцию по границе строки с явной пометкой, а не запись — ledger
  принимает факты как обычно, поэтому переполнение не теряет данные. Обрезка
  детерминирована, KV-кэш префикса цел. Evidence: 7 тестов
  `core-ts/runtime/memory-health.spec.ts` + 4 теста `app/frozen-prefix-source.spec.ts`.
- [x] Дедупликация при добавлении факта по нормализованному префиксу: повтор
  возвращает идентификатор существующего факта и не создаёт вторую запись.
  Тексты короче 20 символов не сливаются. Срабатывает только для `ADD`, до
  guard и forget-цепочки. Evidence: 6 тестов `memory-health.spec.ts` + 3 теста
  `app/scoped-memory-live-adapter.spec.ts`.
- [x] Самодиагностика памяти как code-owned проверки каждого turn: превышение
  порога проекции, длина сессии от 32 сообщений, незаполненный профиль
  оператора. Заметки идут оператору в журнал, не модели в контекст; повтор
  одного состояния не сообщается. Живёт в точке `pre-provider`. Evidence:
  6 тестов `app/memory-self-check-runtime.spec.ts`.
- [x] Сброс хода сессии в дневник при росте контекста
  ([ADR-0079](../../decisions/2026-07-29-daily-journal-as-late-context.md)):
  пишет рантайм при каждом переходе порога, а не модель — на длинном разговоре
  она и есть тот участник, который вспомнит последним. Evidence: 3 теста
  `app/memory-self-check-runtime.spec.ts`.
- [x] Дневник: сегодняшний подставляется каждый turn как поздний контекст (не во
  frozen prefix — файл меняется в течение дня), предыдущие три дня доступны
  примитивом `read_journal`. Записи модели недоступны: дневник не должен стать
  вторым хранилищем фактов в обход guard. Дата — данные, а не путь. Evidence:
  8 тестов `app/daily-journal.spec.ts` + 3 теста `core-ts/runtime/execute-tool.spec.ts`.

**11.2 Зона знаний**

- [x] Зона знаний с ленивым каталогом
  ([ADR-0075](../../decisions/2026-07-29-knowledge-zone-lazy-index.md)): статьи —
  файлы, не факты; в контекст идёт только детерминированный `_index.md`;
  чтение проверяет границы зоны и не следует symlink наружу.
- [x] Каталог подключён к сборке контекста; чтение и сохранение статьи —
  два примитива узкого каталога
  ([ADR-0080](../../decisions/2026-07-29-knowledge-zone-primitives.md)).
  Перечисление отдельным инструментом не нужно: каталог и так в контексте.
  Путь статьи — ограниченный язык, в котором обход каталогов невыразим;
  `_index.md` записать нельзя, symlink на месте статьи отвергается. Evidence:
  5 тестов `app/knowledge-zone.spec.ts` + 3 теста `core-ts/runtime/execute-tool.spec.ts`.
- [x] Проектная зона знаний отдельно от Workspace-зоны: зона следует scope
  сессии, как и память.

**11.3 Проактивность и задачи**

- [x] Таймеры покрыты движком триггеров (ADR-0038): durable расписание, тик раз
  в минуту, `remind` выключается после срабатывания, дедупликация по слоту.
  Добавлено недостающее: `@weekly` по ISO-неделе, предел 128 живых триггеров и
  обрезка истории слотов — иначе `@minutely` растил бы запись в минуту вечно.
  Пропущенные срабатывания не накапливаются: слот один на период, а не на тик.
  Evidence: 4 теста `core-ts/triggers/triggers.spec.ts`.
- [x] Персистентный трекер задач
  ([ADR-0081](../../decisions/2026-07-29-persistent-task-tracker.md)):
  устойчивые идентификаторы без переиспользования, переживает рестарт,
  повреждённый список уходит в карантин вместо отказа старта, пределы 200 живых
  задач и 500 символов. Открытые задачи идут в контекст каждый turn, закрытые
  нет. Один примитив `track_task` на все действия. Evidence: 9 тестов
  `app/task-tracker.spec.ts` + 3 теста `core-ts/runtime/execute-tool.spec.ts`.
- [ ] Проверить восстановление активной многошаговой задачи после рестарта
  через уже существующий `.current-task.md` слоя контекста.

**11.4 Режимы работы и бюджет**

- [x] Три режима исполнения
  ([ADR-0083](../../decisions/2026-07-29-execution-modes.md)): `auto` без спроса,
  `confirm` поднимает каждый действующий инструмент до карточки и игнорирует
  гранты, `plan` отклоняет действия с внятной причиной и оставляет чтение.
  Режим может только ужесточить: он не понижает tier, не отключает PreToolUse и
  не открывает tier 3. Durable, переключается командой `/mode`. Evidence:
  9 тестов `app/execution-mode.spec.ts` + 3 теста `app/bot-execution-mode.spec.ts`.
- [x] Пороги дневного бюджета
  ([ADR-0082](../../decisions/2026-07-29-daily-budget-thresholds.md)):
  однократное предупреждение при 80 % и приостановка новых turn'ов при 100 % до
  смены даты. Счёт ведётся отдельно от ledger'а, потому что тот агрегирует по
  модели и агенту, а не по дням; ledger остаётся источником истины для отчётов.
  Пропущенные дни не накапливаются, отсутствие потолка означает отсутствие
  ограничения. Evidence: 9 тестов `app/daily-budget.spec.ts` + 1 тест
  `app/bot-forward-batching.spec.ts`.

**11.5 Мониторинг и дайджест — параметры ранжирования**

- [x] Скоринг материала с ограниченным входом (заголовок 300 символов, тело
  8 000) и собственным дедлайном на материал: длинная статья не становится
  оценимее от объёма, а один медленный материал не держит весь проход сбора.
  Обрезка видима, а не молчалива. Категории от критичного до шума, шум в
  дайджест не попадает. Evidence: 3 теста `core-ts/monitoring/scorer.spec.ts`.
- [x] Ранжирование тремя факторами
  ([ADR-0084](../../decisions/2026-07-29-monitoring-ranking-and-retention.md)):
  вес категории, затухание по возрасту с окном на тип источника, ограничение
  числа материалов от одного автора и источника. Критичный материал вчерашнего
  вечера обгоняет полезный сегодняшний; лента релизов не обесценивается со
  скоростью чата. Evidence: 4 теста `core-ts/monitoring/monitoring.spec.ts`.
- [x] Retention по времени и по объёму с ночной автоочисткой: сначала возраст,
  затем объём; материал, на который ссылается живой дайджест, не удаляется —
  доставленный дайджест с мёртвыми ссылками хуже чуть большей базы. Индекс
  поиска чистится вместе с материалом. Очистка идёт ночным проходом, под уже
  существующей блокировкой. Evidence: 6 тестов `core-ts/monitoring/monitoring.spec.ts`.
- [ ] Гибридный поиск по хранилищу мониторинга с RRF и порогом косинусной
  близости — после семантического слоя памяти.
- [x] Глобальный файл критериев дайджеста (`monitoring-criteria.md`) плюс
  per-source: критерии источника сужают общие, а не заменяют их — «интересно
  вообще» и «интересно из этой ленты» разные вопросы. Нечитаемый общий файл не
  срывает скоринг. Evidence: 3 теста `core-ts/monitoring/monitoring.spec.ts`.
- [x] HTML-дайджест без единого скрипта: страница строится целиком из
  недоверенного материала, поэтому скрипта нет вовсе, а CSP запрещает загрузку
  чего угодно. Стили оператора проходят фильтр (`@import`, `url(`,
  `expression(`, разметка, размер) и при отказе отбрасываются целиком, а не
  вычищаются по кускам. Ссылка не по http(s) теряет ссылку, но не текст.
  Evidence: 7 тестов `telegram-gw/monitoring-digest-html.spec.ts`.

**11.6 UX-числа диалога и медиа**

- [x] Числа диалога собраны в `telegram-gw/ux-limits.ts` и покрыты тестами:
  период обновления статуса, период стриминга, окно сбора альбома, порог
  разбиения длинного ответа по границе абзаца, превью расшифровки голоса.
  Разбиение падает на абзацы, потом на строки, потом на жёсткий разрез — ни один
  символ не теряется; больше трёх частей уходит файлом. Retry ограничен и
  никогда не повторяет 429: повтор ровно и превращает лимит в бан. Evidence:
  15 тестов `telegram-gw/ux-limits.spec.ts`.
- [x] Документы: список допустимых расширений, предел размера, явная пометка при
  обрезке расшифровки. Расширение внутри имени (`notes.md.exe`) не считается
  допустимым.
- [ ] Число ключевых кадров для видео и кружочков — вместе с медиа-конвейером
  (11.9).

**11.7 Мультибот** ([ADR-0076](../../decisions/2026-07-29-multi-bot-single-installation.md))

- [x] Идентичность бота в durable-привязке и реестр ботов установки: маршрутизация
  по токену, запрет двух живых ботов на одном чате или токене, стабильный
  первый бот между рестартами, архивирование без удаления памяти. Реестр хранит
  только имя переменной с токеном, не значение. Evidence: 8 тестов
  `app/bot-registry-store.spec.ts`.
- [x] Раздельные корни состояния по боту: защищённая память, DNA и дневник,
  журнал и зона знаний. Первый бот сохраняет исторический путь, поэтому
  существующая установка не требует миграции; идентификатор бота не выбирает
  путь в файловой системе. Evidence: 6 тестов `app/bot-paths.spec.ts`.
- [x] Композиция определяет своего бота по переменной с токеном и подставляет
  его корни; `botId` входит в durable-привязку работы.
- [ ] Привязки фоновых задач и дайджеста учитывают, какому боту принадлежит
  работа; запуск нескольких ботов одним процессом.
- [x] Управление списком ботов из интерфейса (`/bots`): перечисление с пометкой,
  какого бота обслуживает этот процесс, добавление по имени переменной с токеном
  (сам токен реестр не хранит) и архивирование без удаления памяти. Пустой
  реестр объясняет себя, а не показывает пустой список. Evidence: 5 тестов
  `app/bot-execution-mode.spec.ts`.
- [ ] Переключение между ботами внутри одного процесса — вместе с запуском
  нескольких ботов одним процессом.

**11.7a Нативные хуки** ([ADR-0077](../../decisions/2026-07-29-native-extension-hooks.md))

- [x] Загрузчик хуков: детерминированный порядок, файлы со служебным префиксом
  пропускаются, упавший хук не мешает остальным и освобождает занятые имена
  инструментов, регистрация после возврата `install` отвергается, повторные
  падения выключают механизм целиком.
- [x] Регистрация инструмента с обязательными эффектом и tier; дубликат имени
  между хуками отвергается. Инструмент попадает в общий каталог и виден модели
  только через карту агента, поэтому не занимает контекст постоянно.
- [x] Точки подгрузки контекста `pre-prompt`/`post-tool`/`pre-provider`:
  фрагмент ограничен по размеру, живёт только в этом turn, упавший или
  превысивший лимит поставщик пропускается, а не срывает turn. Любой фрагмент
  помечается `untrusted`. Evidence: 11 тестов `app/extension-hooks.spec.ts`.
- [x] Подключить хуки к живой композиции: загрузка `.mjs` из каталога установки
  в порядке имён, инструменты уходят в executor и разрешаются только после
  `unknown-tool` каталога (встроенный примитив всегда выигрывает), провайдеры
  `pre-prompt` добавляют ограниченный `untrusted`-фрагмент в spans текущего
  turn. Сломанный хук сообщается и пропускается, рантайм не падает.
- [x] Точка `pre-provider` в цикле агента: контекст подтягивается непосредственно
  перед обращением к провайдеру, попадает только в этот вызов и не входит во
  frozen prefix — KV-кэш остаётся целым. Evidence: 2 теста
  `agent-loop/agent-loop.spec.ts`.

**11.8 Транскрипция как подключаемый инструмент**

- [x] Провайдер расшифровки выбирается оператором
  ([ADR-0085](../../decisions/2026-07-29-transcription-providers.md)): каждый
  обязан объявить, покидает ли аудио хост, и провайдер, отправляющий запись
  наружу, никогда не выбирается сам — ни автоподстановкой, ни как единственный.
  Список и выбор — команда `/voice`, выбор durable, облачный выбор пишется в
  журнал. Evidence: 9 тестов `app/transcription-registry.spec.ts` + 3 теста
  `app/bot-execution-mode.spec.ts`.
- [x] Единый контракт провайдера: локальный контейнер по
  [ADR-0072](../../decisions/2026-07-29-reproducible-whisper-image.md) и внешние
  сервисы реализуют один интерфейс, поэтому добавление нового не трогает
  конвейер.
- [ ] Довести файловый конвейер голоса до `aisy run`: media inbox сейчас
  доступен только доктору, поэтому `transcribeVoice` отказывает явно вместо
  выдуманной расшифровки.

**11.9 Доступ к серверу из интерфейса**

- [x] Состояние сервера: аптайм процесса и хоста, память, диск, версия сборки —
  команда `/server`. Неизмеримая файловая система остаётся `null`, а не нулём:
  выдуманный ноль читался бы как «диск полон» и вызвал бы ровно неверную
  реакцию. Evidence: 5 тестов `app/server-status.spec.ts`.
- [x] Перезапуск рантайма из интерфейса (`/restart`): отказ, если процесс никто
  не поднимет обратно — это была бы остановка, а не перезапуск, и сказать об
  этом было бы уже нечем. Отказ, пока идёт turn. Намерение пишется на диск до
  выхода, permit подтверждается authenticated parent IPC, а `exit(75)` без
  одноразового session/deadline-bound permit считается аварийным. Отказ после
  подготовки устойчиво отменяет receipt; следующий запуск сообщает о
  оставшемся intent ровно один раз. Evidence: fault-injection corpus
  `app/runtime-restart.spec.ts`, bot ACK/cancel tests и parent permit tests.
- [x] Базовый parent supervisor и OS service composition по
  [ADR-0071](../../decisions/2026-07-29-execution-recovery-parent-supervisor.md):
  `capture → prepared → checkpoint-bound` закрывает crash-window до
  provider/Telegram, replacement получает exact recovery phase, а restart storm
  ограничен code-owned backoff/budget. systemd использует `Restart=always`,
  launchd — `KeepAlive`; install/rollback/start/stop/uninstall работают только
  с exact private unit/plist. Предыдущий evidence: real child `SIGKILL` matrix
  для captured-missing, prepared, bound, terminal-pending и
  terminal-delivered, duplicate-manager process tests и service lifecycle
  corpus. Это доказательство базового среза, а не уточнённого manager-crash
  auto-recovery ниже.
- [x] Реализовать и offline/process доказать Node-runtime часть уточнённого
  ADR-0071: отдельные
  local-filesystem SQLite lease для manager и runtime-liveness,
  `BEGIN IMMEDIATE`, manager `SIGKILL` auto-reacquire, ожидание фактического
  runtime unlock до recovery/spawn и protocol-v2 hello после child acquire.
  Parent получает runtime fence до state read/repair, удерживает через crash
  preparation и отдаёт окно только exact spawn; после любого exit и перед retry
  он снова получает fence. Pre-hello failure/late orphan дают zero
  provider/tool/Telegram I/O. Прямой `aisy run` сначала держит тот же runtime
  fence, затем nonblocking probes manager DB; busy-manager означает zero-I/O
  exit. Direct остаётся rollback-путём без IPC recovery authority.
  Обязательны `lease_meta.database_id` 64 lowercase hex, immutable private
  `<lease-db>.identity.json` exact `{version:1,role,databaseId,dev,ino}`, child
  descriptor `{version,path,dev,ino}`, initialized private temp + atomic
  hardlink/fsync bootstrap и безопасное завершение `nlink=2`. Valid DB без
  anchor восстанавливает его только в bootstrap crash window;
  anchor+missing/empty/mismatch/corrupt DB отказывает без reinit. Также
  обязательны validated recovery private rollback `-journal`, refusal для
  WAL/SHM/unsafe companions, запрет PID/`mtime`/stale unlink/time proof,
  offline self-test и отказ от NFS/SMB. Evidence: targeted unit 79/79,
  real-process parent 10/10, Telegram recovery 9/9; `pnpm -r typecheck`,
  `pnpm -r build`, `pnpm -r test -- --reporter=dot` — Core 2019 passed / 1
  skipped, Telegram 146, App 1013 passed / 1 skipped; sidecars 52 passed / 1
  skipped и Ruff green; fixture process leak — ноль.
- [ ] До LIVE activation выполнить self-test на фактической целевой FS и
  доказать quiescence всей process group/каждого descendant и sidecar. Lease
  одного Node runtime не является таким доказательством. Dormant POSIX
  foundation получил unit/real-process корпус, а ADR-0089 предложил durable
  recovery внешних Docker resources. Его dormant core уже хранит exact
  `prepared/attempted/bound`, не очищает delayed create без доказательства,
  удаляет только повторно аттестованный immutable ID и запрещает replay через
  ledger-owned sequence и recovery/active epoch без растущих tombstones. Dormant
  Docker CLI semantic adapter, code-owned expected projection builders и
  operation-scoped coordinator реализованы. Schema/activation v3 теперь
  устойчиво связывает ledger с exact endpoint/daemon/API identity, v1/v2
  отказывает до RW open, а wrong/replaced endpoint не ротирует active epoch и
  проверяется до/после transport await. Добавлен dormant Engine HTTP transport
  exact `v1.54`: typed `404`, bounded deep-frozen inspect, container/network
  remove только по immutable ID. Read-only attestation теперь закрыта отдельной
  branded one-shot `DockerEnginePinnedSession`: exact descriptor snapshots,
  canonical socket anchor, минимум Engine 29.5.2, один физический socket для
  `v1.54/version → info → inspect`, bounded headers/trailers/body/JSON и zero
  reconnect/retry при abort, timeout, close, truncation или endpoint drift.
  Shared bounded normalizer теперь одинаково переводит raw Engine JSON и
  CLI-template inspect в exact ownership labels, projection hash и network
  endpoint count; CLI больше не владеет отдельной копией этих правил. CLI
  mutation path запрещён. Dormant parent-only pinned broker теперь реализует
  только atomic `removeExact`: настоящий recovery ledger + exact epoch/endpoint,
  одна `bound` row, recovery dispatch barrier и одна socket generation для
  `version → info → inspect → DELETE → post-inspect 404`. Он не меняет
  ledger и не импортируется live composition. Следующий dormant foundation
  теперь реализует code-owned semantic drafts для Whisper, lease-bound Bash и
  restricted clone: exact roster/create order, безопасные action graphs,
  per-kind commitment schemas, SHA-256 privacy narrowing и обязательные
  image/Engine/IPAM/membership/archive evidence requirements. Generic bypass
  raw-значением закрыт exact schema validation; Whisper не допускает меньше
  baseline ADR-0072 3 GiB/2000m/64 PID. Draft не содержит Docker request,
  `prepareInput`, финальный projection/policy hash, sealing или mutation.
  До parent/sidecar wiring ещё нужны pinned atomic create/use, attested
  manifests и финальные create/inspect projections, authenticated current-child
  authority, real-Docker fault corpus и platform evidence.
  Legacy child/direct bypass уже закрыт: Docker activation keys удалены из
  child-окружения и повторно санитизируются parent, а `run/supervise` с legacy
  activation отказывают до state/spawn/provider/Telegram. Live child-owned
  Bash/Whisper composition удалена; non-Docker direct run и `doctor` сохранены.
  Evidence этого gate: targeted policy/CLI/IPC/parent 69/69, App
  typecheck/build и полный App regression 1141 passed / 17 skipped зелёные;
  fixture process leak не обнаружен.
  Evidence pinned read-only среза: собственный корпус 41/41, совместный
  pinned/Engine transport 55/55, App typecheck/build и полный App regression
  1182 passed / 17 skipped; fixture process leak не обнаружен, независимый
  dormant review P0=0, P1=0.
  Evidence shared normalization: normalization/CLI/coordinator 43/43, App
  typecheck/build и полный App regression 1189 passed / 17 skipped; fixture
  process leak не обнаружен, независимый review P0=0, P1=0. Собственные лимиты:
  1 MiB cumulative UTF-8/canonical JSON, 50 000 узлов, depth 32 и 4096 network
  endpoints.
  Evidence dormant parent-only `removeExact`: broker 27/27, объединённый
  broker/pinned/normalizer/Engine/ledger/coordinator gate 131/131; App
  typecheck/build и полный App regression 1216 passed / 17 skipped зелёные;
  diff-check чистый, fixture process leak не обнаружен; независимый review
  P0=0, P1=0. Это fake Unix Engine evidence: create/use, authenticated child IPC,
  ledger cleanup, real-Docker и LIVE activation остаются открытыми.
  Evidence semantic drafts: три новых корпуса 29/29, совместный semantic +
  существующий Whisper/clone supervisor gate 49/49, App typecheck/build и
  diff-check зелёные, полный App regression 1245 passed / 17 skipped (141 test
  files passed / 5 skipped); финальный независимый review P0=0, P1=0. Это dormant
  code-contract evidence без Engine I/O, ledger publication и LIVE activation.
  Follow-up security gate перед sealing закрыл inherited `toJSON` в shared
  projection normalizer ручной scalar-only канонизацией и frozen golden hashes:
  normalizer/CLI 22/22, полный App 1246 passed / 17 skipped, независимый review
  P0=0, P1=0.
  Следующий read-only foundation добавил genuine pinned image inspect evidence:
  digest-only, один socket `version → info → image/json`, typed 404, bounded
  response и descriptor-only options до one-shot admission. Evidence 55/55,
  объединённый Docker gate 104/104, App typecheck/build и полный regression
  1260 passed / 17 skipped зелёные. Поверх него теперь реализован dormant
  image-runtime manifest: только genuine evidence, exact Config allowlist API
  v1.54, раздельные RepoDigest/image ID, platform gate, bounded manual
  canonicalization и WeakSet brand. Собственный gate 13/13, объединённый Docker
  security gate 117/117, workspace typecheck/build и полный App regression 1273
  passed / 17 skipped зелёные. Manifest не выдаёт mutation authority. Следующие
  pre-sealing review связал projection с фактически исполняемым top-level
  `Image` config ID отдельно от `Config.Image`; Engine/CLI/expected parity и
  новый golden подтверждены 132/132 Docker tests, полный App — 1274 passed / 17
  skipped, независимый review P0=0, P1=0. Follow-up design review дал NO-GO для
  предсказания полной inspect projection V1 до create: daemon/image materialize
  defaults. Добавлена отдельная dormant selected projection V2 с
  request-deterministic security fields, domain-separated expected hash и
  post-inspect parity normalizer. V1 остаётся recovery proof, ledger
  schema/prepare не переинтерпретированы; слой не делает Engine I/O и не
  подключён LIVE. Evidence: V2 8/8, объединённый Docker contract 67/67,
  workspace typecheck/build, полный App 1282 passed / 17 skipped, fixture leak
  0, независимый review P0=0/P1=0. Следующий dormant слой реализует genuine
  Whisper/Bash create-plan evidence: semantic draft + pinned image manifest +
  current canonical root evidence, exact instruction/root commitments и
  genuine endpoint-bound runtime probe. Probe требует builtin seccomp плюс
  `userns`/`rootless`, сам выводит `runsc|runc`, а Bash связывает exact isolation
  profile; caller runtime удалён. Hidden direct Engine request template и
  публичные runtime/security/domain-separated hashes не выдают capability или
  Engine I/O. Pre-seal review потребовал сначала schema/API v4: immutable
  create-projection contract/hash V2 отдельно от nullable bound projection V1,
  который записывается только вместе с object ID. Старые v1–v3 — offline-only,
  без auto/down migration. Foundation v4 выполнен: интегрированный gate 160/160,
  Docker-oriented corpus 282 passed / 1 opt-in live smoke skipped, полный App
  1301 passed / 17 skipped, fixture leak 0, независимый review P0=0/P1=0.
  Открытые зависимости: clone create-plan evidence, capability-bound sealing/ledger prepare, pinned atomic
  create/use, Engine create→inspect projection, authenticated current-child,
  real-Docker fault corpus, platform evidence и только затем LIVE activation.
  Gate этого dormant среза: pinned runtime + create-plan 63/63, объединённый
  Docker security/contract 130/130, workspace typecheck/build, полный App
  regression 1290 passed / 17 skipped и независимый review P0=0/P1=0;
  предыдущий
  workspace evidence — Core 2039 passed / 1
  skipped, Telegram 146 passed; после atomic test-marker fix полный App дважды
  прошёл без failures — 1105 passed / 1 skipped и 1104 passed / 2 skipped.
  Python 52 passed / 1 skipped, Ruff, workspace typecheck/build и diff-check
  зелёные.
  Implementation/process
  evidence уточнённого SQLite singleton writer по ADR-0068 уже получено:
  transcript 12/12, объединённая process-матрица 31/31, полный App gate —
  132 файла тестов успешно / 1 пропущен и 1031 тест пройден / 1 пропущен;
  typecheck App и upstream-сборка зелёные. Его
  собственный target-FS self-test всё ещё обязателен; этот gap не закрыт
  локальным corpus.
- [x] Управление SSH-доступом
  ([ADR-0086](../../decisions/2026-07-29-server-access-control.md)): выполняются
  только операции, заранее описанные оператором в `server-access.json`; агент не
  сочиняет команды. Запрос из недоверенного контекста отвергается до того, как
  карточка вообще выпущена. Публичный ключ проверяется как данные, приватный
  отвергается и нигде не эхом; в аудит идёт отпечаток, а не ключ. Evidence:
  10 тестов `app/server-access.spec.ts`.
- [x] Ограниченное время жизни доступа: открытый порт и туннель закрываются сами
  по TTL на тике планировщика, закрытие не требует подтверждения — это
  безопасное направление. Дверь, которая не открылась, закрывать не планируется.
- [ ] Аварийная консоль восстановления для иных случаев: corrupt durable state,
  недоказуемая execution authority, manual legacy transcript cutover и forward
  repair повреждённой writer DB/anchor. Она не нужна для stale manager или
  steady-state writer lock: их SQLite-транзакции освобождает ядро после crash.
  Консоль не должна обходить durable quarantine, удалять permanent
  compatibility barrier или выполнять time/PID-based takeover.

**Приёмка:** каждый режим поиска доказан отдельным тестом; каталог знаний
детерминирован и не содержит тел статей; проекция `MEMORY.md` отказывает
дубликату и предупреждает до предела; сброс в дневник сохраняет результат
прерванной сессии; таймеры переживают restart и не накапливают пропуски;
трекер задач переживает restart; пороги бюджета срабатывают ровно один раз;
дайджест не содержит скриптов.

### Этап 10 — Release evidence

**Изменения:**

- [ ] Собрать двухпроектный Telegram E2E: onboarding → brain → create/switch →
  files/memory → subagent → monitor → restart/resume.
- [ ] Запустить полные build/typecheck/test, adversarial security corpus,
  crash/restart/rollback и secret scan.
- [ ] Для каждого критерия записать ссылку на тест, событие или воспроизводимый
  сценарий; неподключённое ядро отмечать `CORE-ONLY`, а не `LIVE`.
- [ ] Обновить русские operator/development/recovery документы и безопасный
  handoff. Публичных артефактов референса быть не должно.

**Приёмка:** все WP-01…WP-41 и компонентные acceptance criteria зелёные;
production composition стартует из чистого state; doctor объясняет и чинит
recoverable failures; rollback соответствует migration manifest.

## 5. Общие проверки каждого этапа

Для каждого завершённого этапа обязательны:

1. Сначала failing test или воспроизводимый failing scenario.
2. Минимальная реализация без несвязанных refactor.
3. Unit + integration тесты изменённых пакетов.
4. Сборка зависимых workspace-пакетов перед runtime-тестами потребителя.
5. Typecheck, перечитывание изменённых файлов и отдельный review при 3+ файлах.
6. Проверка logs/events/errors на content и secrets.
7. Restart/retry test для durable state; fault injection для атомарной публикации.
8. Обновление русской спецификации и evidence matrix только по доказанному
   поведению.

## 6. Rollback и выпуск

- До `V2_WRITES_ENABLED` v1 остаётся rollback source; удалять можно только
  manifest-created artifacts с совпадающими hash.
- После `V2_WRITES_ENABLED` автоматический downgrade запрещён: runtime ставится
  на паузу, doctor создаёт checksummed recovery bundle и forward-repair plan.
- [x] Добавить чистый read-only readiness verdict и doctor/post-upgrade seam:
  registry + memory bundles, пять runtime-поверхностей, exclusive lock,
  backup и rollback rehearsal обязательны до approval; после writes-enable
  код возвращает только forward-repair. Шесть evaluator и три doctor tests
  доказывают phase matrix, zero-write warning/fail и redacted probe failure.
- [x] Подключить read-only Node bundle inspectors: registry сверяет durable
  manifest, exact backup/candidate и phase-dependent live bytes до
  writes-enable; после него mutable live state доказывает runtime probe. Memory заново
  доказывает source/manifest/artifact/ledger/fact equivalence. Инспекторы не
  берут lock, не пишут и возвращают только advisory evidence. Targeted gate:
  12 memory + 10 registry-preparer + 5 readiness-runtime tests.
- [x] Согласовать и реализовать единый durable binding манифестов:
  [ADR-0070](../../decisions/2026-07-29-unified-migration-cohort-binding.md)
  вводит cohort — `migrationId` миграции реестра. Манифест памяти обязан нести
  `cohort: { registryMigrationId, sourceRegistrySha256 }`, где id совпадает с его
  собственным `migrationId`, поэтому путь манифеста выводится из когорты, а не
  из directory scan или mtime. `verifyMigrationCohort` отказывает при
  отсутствующей когорте, чужом id, изменившемся source реестра и манифесте вне
  вычисленного пути; входы пути обязательны, а каждое authority-поле читается как
  own-свойство ровно один раз. Манифест отвергается как symlink до канонизации
  пути, поэтому подменённая ссылка не переносит бандл из приватного staging;
  bundle-верификация принимает уже доказанную когорту и сверяет её при повторном
  чтении с диска. `bothMigrationsTerminal` сообщает только о терминальных фазах
  обеих миграций и не заменяет activation gate. Readiness-инспектор сам выводит
  путь и валидирует registry-манифест. Evidence: 12 тестов
  `runtime/migration-cohort.spec.ts`, 14 тестов legacy-memory-миграции и 8
  тестов readiness. Cutover по-прежнему отсутствует.
- [x] Реализовать и доказать уточнённый singleton writer журнала сессий по
  [ADR-0068](../../decisions/2026-07-29-session-journal-singleton-writer.md):
  local-FS SQLite `BEGIN IMMEDIATE` process-lifetime lease, exact metadata +
  immutable `{version,role,databaseId,dev,ino}` anchor, crash-safe bootstrap,
  permanent legacy compatibility barrier, `SIGKILL` auto-reacquire и
  fail-closed full-runtime gate. Legacy directory/corrupt/unsafe/identity drift
  дают zero external I/O; exact `AISY_SESSION_JOURNAL=0` доказывает только
  current-binary rollback. Doctor остаётся read-only. Автоматически завершается
  только exact barrier-publication crash boundary `nlink=2` + один same-inode
  compat temp. Evidence: transcript-тесты на реальных процессах — 12/12;
  объединённая process-матрица — 31/31; полный App gate — 132 файла тестов
  успешно / 1 пропущен, 1031 тест пройден / 1 пропущен; typecheck App и
  upstream-сборка зелёные. LIVE, self-test на целевой FS и ручной legacy cutover
  не заявляются.
- [x] Ввести activation authority по
  [ADR-0073](../../decisions/2026-07-29-workspace-v2-activation-authority.md):
  необратимый переход `COMMITTED → V2_WRITES_ENABLED` разрешается только при
  чистом `committed-awaiting-enable`, связанной когорте с терминальными фазами
  обеих миграций, persisted-записи репетиции отката для этой же когорты и
  одноразовом approval, привязанном к `evidenceHash` текущего состояния.
  Authority ничего не публикует сама и возвращает только стабильный код отказа.
  Evidence: 10 тестов `runtime/workspace-v2-activation.spec.ts`.
- [x] Реализовать репетицию отката и её persisted-хранилище: репетиция реально
  восстанавливает оба backup в приватный scratch и пересчитывает sha256 там;
  запись появляется только при побайтовом совпадении, scratch не переживает
  проверку, повреждённый backup даёт `restore-mismatch`. Хранилище приватное и
  атомарное, возвращает последнюю репетицию своей когорты и считает
  повреждённое/невалидное состояние отсутствием репетиции. Evidence: 8 тестов
  `app/workspace-v2-rollback-rehearsal.spec.ts`.
- [x] Подключить readiness к настоящему `aisy doctor`: probe пере-планирует
  миграцию только для вывода ожидаемых артефактов, ничего не пишет, отсутствие
  манифеста показывает как `not-prepared`, а нечитаемый манифест никогда не
  выдаёт за неподготовленную миграцию; `dryRunVerified` приходит из
  persisted-репетиции этой когорты, а не от вызывающего. Evidence: 5 тестов
  `app/workspace-v2-doctor.spec.ts`.
- [x] Реализовать cutover под exclusive lock: `performWorkspaceV2Cutover`
  захватывает каталог-lock созданием, читает spent-approvals ДО решения, спрашивает
  authority ADR-0073 и только затем атомарно публикует уже проверенный candidate в
  `projects-v2.json` и переводит манифест в `V2_WRITES_ENABLED`. Публикация идёт
  раньше смены фазы, поэтому падение между шагами оставляет возобновляемое
  состояние, а не потерянный реестр; lock освобождается на любом пути, включая
  отказ. Evidence: 7 тестов `app/workspace-v2-cutover.spec.ts`.
- [x] Перевести live-композицию на v2 со старта: `aisy run` знает только
  v2-реестр, первый запуск публикует свежее состояние, миграционный gate из
  стартового пути убран, legacy `projects.json` не читается. Миграционный слой
  остаётся отдельным инструментом для установок с v1-данными.
- [ ] Опционально: выполнить подготовку, репетицию и cutover на установке, где
  нужно перенести существующие v1-данные.
- Новый live path включается capability/feature gate и становится default только
  после equivalence и restart/E2E проверок.
- Каждый этап можно выпускать отдельно, если он не заявляет неподключённую
  возможность и сохраняет старые данные без потерь.

## 7. Первый рабочий пакет

Начать с Этапа 1 в таком порядке:

1. [x] Добавить v2 types и parser/validator рядом с v1, не меняя live writes.
2. [x] Написать fixtures v1→v2 и fail-closed corpus.
3. [x] Добавить deterministic migration planner, сохраняющий legacy ids/selection и
   создающий отдельный Workspace с generation 1.
4. [x] Добавить manifest phase reducer и crash/recovery tests без реального cutover.
5. [ ] Только после эквивалентности подключить atomic target publication и live
   v2 runtime. Startup write gate уже закрывает v1 runtime при любом manifest,
   но target registry не заменяется.

Это даёт проверяемый фундамент для всех последующих подключений и не требует
раннего изменения Telegram либо provider runtime.

### Доказательства текущего инкремента (2026-07-26)

- `project-registry-v2.ts`: fresh state, fail-closed validator, v1→v2 planner,
  независимый equivalence verifier, manifest phases и recovery coordinator.
- `project-registry-v2-lifecycle.ts`: owner-bound atomic lifecycle,
  persisted generation, archive replacement и identifier-only events.
- `workspace-migration-store.ts`: temp write, file fsync, atomic rename и
  directory fsync с fault injection на каждой границе.
- `workspace-migration-lock.ts` и `workspace-registry-migration-preparer.ts`:
  атомарный exclusive lock без stale takeover, byte-exact backup, code-owned
  staging, hash verification и crash-resume только до `VERIFIED`.
- `aisy run` fail closed при незавершённом, повреждённом или уже активированном
  v2 manifest; старый v1 writer в этих состояниях не стартует.
- Полный прогон после per-turn runtime-инкремента: 1038 core + 101 Telegram +
  150 app = 1289 TypeScript-тестов; отдельно 29 Python-тестов sidecar (итого
  1318 пройденных тестов, один platform-specific `/proc` skip).
  Monorepo typecheck, build и Ruff проходят.
- Live v2 cutover намеренно ещё не включён: не подключены cutover CLI и
  координация lock/target publication, full source backups и проверки
  memory/transcript/jobs, требуемые перед `V2_WRITES_ENABLED`.

### Доказательства lease/scoped-memory инкремента (2026-07-26)

- Кириллические FTS-запросы и разные русские fact keys покрыты regression-тестами;
  dual-key guard не ослабляет старые пустые legacy forget keys.
- `context-lease.ts`: immutable binding, operation reservation, before-I/O
  recheck, abort, quiesce/drain/close и `STALE_CONTEXT` до I/O.
- `scoped-memory.ts`: Workspace=global-only, Project=global+exact project,
  owner lease обязателен, cross-project fallback отсутствует, forget-ledger
  tamper не деградирует в небезопасную выдачу.
- `legacy-memory-migration.ts`: read-only exact-schema export, verified legacy
  backup, физически отдельный protected ledger без FTS, lossless
  facts/tombstones/relations/provenance/forget-chain, live-only canonical fact
  files и reversible `PREPARED → COPIED → VERIFIED` resume. Десять тестов
  доказывают restart, source/artifact/file/chain/schema/path fail-closed;
  install/cutover API отсутствует.
- `cross-project-search.ts` + Node nonce store: explicit Workspace-only
  `search_all_projects`, operator/non-nested one-use receipt, owner/query/
  generation/mode/archive/limit binding, isolated per-project fan-out,
  deterministic rank merge и exact one-use excerpt capability. 11 core + 5
  restart persistence tests; ordinary recall не расширен, live wiring выключен.
- `protected-memory-publication.ts`: strict publication WAL, deterministic
  fact-key/content/path checks, required cross-process scope barrier,
  pending-ledger/audit-outbox and ledger+keyword/file/audit verification,
  reader recovery gate. 19 tests включают 11 durable-effect crash points.
- `protected-memory-deletion.ts` + `protected-memory-update.ts`: отдельные
  strict WAL для delete/forget и update, permanent forget promotion,
  atomic old→new ledger swap, physically separate FTS switch, vector/cache и
  canonical file purge, idempotent audit, reopen/recovery shape validation и
  completed-retry resurrection checks. Node restart matrices покрывают 9
  delete/forget и 14 update durable boundaries; live wiring ещё не реализован.
- `protected-memory-recovery-gate.ts`: единая reader/startup граница для всех
  mutation WAL, final integrity и impossible multi-family recovery conflict;
  4 core tests.
- `protected-scoped-memory.ts` + app preview factory: защищённые global и exact
  Project runtimes реализуют `ScopedMemoryRouter`; read-hit обязан совпасть с
  published ledger и canonical file hash/size. Только отсутствующий Project
  runtime/keyword index деградирует к global; ledger, scope, file и recovery
  ошибки fail closed. 16 core tests и реальный app global+project ADD→FTS
  integration проходят; `off` не создаёт router, live wiring выключен.
- `protected-memory-permanence-authority.ts` + Node nonce/runtime adapters:
  Gateway code-minted proof и обязательный step-up связываются с точными
  immutable target fields; HMAC receipt атомарно гасится и остаётся consumed
  после restart. 8 core, 9 app unit и 1 полный Gateway→Project forget→restart
  integration проверяют replay/TOCTOU, private path/schema и отсутствие recall.
- Сквозной app integration связывает durable Project registry/provisioner,
  context lease, protected scoped router и `InteractiveTurnRuntime`: project
  `remember/search_memory` переживает полный restart с тем же
  project/session/generation; receipt-bound switch во второй Project доказывает
  двустороннюю отрицательную выдачу, а Workspace не видит оба project-факта и
  пишет только в отдельную global memory.
- `switch-authority.ts` + `project-service.ts`: HMAC/TTL/one-use receipt,
  generation compare-and-swap, pre-resolve target session и fail-closed
  consume-before-effect до quiesce/registry mutation; persistence failure не
  закрывает старый lease и не меняет selection.
- `switch-authority-nonce-store.ts` + `project-service-runtime.ts`: защищённый
  JSON store с exclusive temp, file/directory fsync и atomic rename; one-use
  состояние переживает restart, а Node factory собирает authority/leases/service
  без включения v2 migration cutover. Telegram/live wiring ещё впереди.
- `project-registry-v2-store.ts`: migration-compatible validated load и durable
  atomic save; factory-from-registry после restart восстанавливает exact
  project/session/generation и выдаёт lease только для этого persisted выбора.
- `project-service.ts` публикует подготовленный Project через generation CAS,
  quiesce старых leases, одну registry publication и exact новый lease; ошибка
  до commit восстанавливает lease прежнего авторитетного выбора.
- `project-provisioner.ts`: deterministic slug, exclusive hashed reservation с
  fsync-метаданными recovery, code-owned staging/layout, final-root publication,
  durable quarantine и derived русский `PROJECTS.md`. Concurrent same-slug даёт
  одного победителя; disk/layout/rename/registry faults не создают selectable
  Project. Preview register-existing проверяет canonical non-symlink directory,
  стабильный device/inode вокруг confinement scan, duplicate root/slug и late
  durable recovery, не изменяя исходное дерево. Для clone добавлены core
  `resolveRestrictedCloneTarget` и app
  `RestrictedProjectCloneTransport`: URL/DNS проверяются до reservation,
  mixed public/private и DNS-rebinding ответы закрываются, transport получает
  immutable exact IP set/TLS hostname, а staging использует общие scan,
  quarantine и atomic publish пути. ADR-0066 фиксирует обязательный one-shot
  sandbox; `restricted-clone-sidecar.ts` формирует immutable digest-pinned
  policy без credentials/direct route, exact egress IP:443/TLS hostname,
  resource limits и Git hardening, проверяет exact attestation, destroyed-before-
  return и стабильный device/inode staging. 12 app security-тестов покрывают
  weakened policy, attestation mismatch/extra fields, quota, cancellation и
  directory replacement. `restricted-clone-docker-supervisor.ts` добавляет
  no-shell Docker command port, digest-pinned gateway/worker, exact labels/env,
  internal `ipvlan`, cgroup/tmpfs limits, inspect-before-start, supervisor-only
  export и destroyed-before-return. Python gateway принимает только exact
  hostname:443 и напрямую соединяется с проверенными IP без DNS; worker
  запускает hardened HTTPS-only Git без credentials и пишет только в quota
  tmpfs. Ещё 10 app supervisor-тестов и 8 Python-тестов покрывают weakened
  inspect, secret env, incompatible Docker, OOM, timeout/cancel, export order и
  cleanup failure.
  Read-only `aisy doctor` теперь проверяет enablement, minimum Engine 29.5.2 и
  exact локальные RepoDigest; disabled state остаётся warning и не активирует
  transport. Clone по умолчанию выключен: реальный Docker E2E и live
  composition ещё не выполнены, поэтому WP-19…WP-22 пока не объявлены
  полностью закрытыми.
- Gate после clone/MCP preview-инкремента: core 1526 passed и 1 opt-in skipped,
  app 307/307, Telegram 104/104, workspace typecheck и build зелёные. Отдельный
  clone-корпус: 52 URL/DNS-проверки, 12 sidecar policy/attestation и 23
  provisioner-теста, включая mixed DNS, confinement,
  concurrent reservation, quarantine, register inode-race/symlink deny и
  отсутствие registry publication при отказе.
- Gate после Docker supervisor-инкремента: app 317/317, core 1526/1526 и один
  opt-in skip, Telegram 104/104, Python 42/42 и один platform skip; workspace
  typecheck/build и Ruff зелёные. Clone-корпус дополнен 10 supervisor-тестами и
  8 Python exact-egress/worker-тестами. Реальный Docker E2E не запускался:
  локальный Engine 27.4.0 намеренно отклоняется minimum-version gate 29.5.2.
- Gate после compatibility-doctor-инкремента: core 1535/1535 и один opt-in
  skip, app 317/317, Telegram 104/104, Python 42/42 и один platform skip;
  workspace typecheck/build и Ruff зелёные. Shared version/digest contract,
  disabled/no-Docker, exact RepoDigest, malformed/tag/option-injection,
  post-upgrade, restart-free recomposition и rollback-to-disabled покрыты
  детерминированными тестами. Live activation не выполнялась.
- Gate после read-only Docker integration-инкремента: opt-in smoke 1/1 прошёл
  против фактического Engine 27.4.0. Guarded command port пропустил ровно
  `docker version --format={{.Server.Version}}`; supervisor вернул
  `CLONE_DOCKER_RUNTIME_INCOMPATIBLE` до `network create`/`container create`.
  Полный профиль на Engine ≥29.5.2 и live activation не выполнялись.

### Доказательства ProjectService lifecycle-инкремента (2026-07-27)

- `project-registry-v2-lifecycle.ts` принимает optional `expectedGeneration`
  для project/session archive и отклоняет stale/repeated transition до
  persistence и emit.
- `project-service.ts` использует отдельный lifecycle-authority port, exact
  Project/Session drain, Workspace/Session replacement lease, root validator и
  disabled-by-default app composition seam.
- Focused security review воспроизвёл lease-acquisition race во время drain;
  общая owner transition barrier закрыла тот же класс для publish, switch и
  archive. Regression тесты получают `CONTEXT_TRANSITION_IN_PROGRESS` во время
  barrier и archived deny после publication.
- Node restart test сохраняет archived Project, Workspace selection и
  generation, затем восстанавливает Project без auto-select. Live Telegram и
  durable lifecycle receipt store не активированы.
- Полный regression gate после lifecycle/session-control remediation: core
  1502 passed и 1 opt-in skipped, app 295/295, workspace typecheck и build
  зелёные.

### Доказательства файлового confinement-инкремента (2026-07-26)

- `packages/sidecars-py/aisy_sidecars/confinement_worker.py`: одноразовый
  JSON-worker без shell/network API. Root открывается как directory descriptor;
  каждый компонент проходит `lstat → open(O_NOFOLLOW) → fstat` с проверкой
  inode/device. Symlink, magic-link, hardlink, special-file и cross-device
  переходы закрываются стабильным code-only ответом. Write использует
  code-owned `O_EXCL` temp, file fsync, descriptor-relative rename и parent fsync.
- Worker ограничивает request/read/write, число записей, глубину, размер файла и
  общий размер дерева; отклоняет absolute/traversal, control-character names,
  duplicate JSON keys, non-finite JSON values и UTF-8-invalid reads. На платформе
  без нужных `dir_fd`/`O_NOFOLLOW` гарантий возвращается `UNSUPPORTED_PLATFORM`,
  небезопасного fallback нет.
- `runtime/confinement.ts`: `ConfinementPort` получает root только из immutable
  `TurnContextLease`, резервирует operation, повторно проверяет lease прямо перед
  process I/O и всегда завершает reservation. Malformed/mismatched/oversized
  protocol и process errors редактируются; события содержат только ids,
  generation, operation и deny code.
- `runtime/lease-bound-tool-executor.ts`: read/write/list не попадают в старый
  `FsPort` fallback; все идут через точный lease. Bash без injected root-only
  sandbox закрыт. Этот executor подготовлен для per-turn v2 composition, но ещё
  не активирован в старом `aisy.ts` до согласованного cutover.
- `confinement-sidecar.ts`: абсолютные code-owned executable/worker paths,
  `shell:false`, фиксированное минимальное окружение, bounded stdout/stderr,
  timeout/kill и только exit 0/2. Реальный Node→Python E2E доказывает UTF-8
  read/write/list и отказ symlink escape.
- `confinement-tree-scanner.ts`, `project-provisioner.ts` и
  `project-service-runtime.ts`: staging обязан пройти тот же descriptor-relative
  scan до final rename и registry publication; deny ведёт к quarantine без
  selectable Project. Node v2 factory одновременно собирает leases,
  `ConfinementPort`, scanner и provisioner, не включая migration cutover.
- WP-16…WP-18 остаются открытыми до подключения уже готового per-turn executor,
  attachment import и root-only bash непосредственно к `aisy.ts` после
  согласованного v2 cutover. Register существующего дерева также не публикуется
  до отдельного race-safe freeze/ownership протокола.

### Доказательства per-turn runtime-инкремента (2026-07-27)

- `bot.ts` поддерживает два взаимоисключающих режима. Legacy строит статический
  runner как раньше; v2 вызывает `acquireTurnRuntime` заново на каждый
  интерактивный ход и при ошибке не откатывается к chat-id/session/root legacy.
  В dynamic mode legacy runner и goal runner даже не конструируются.
- `withTelegramTurnRuntime` гарантирует release при успехе, provider/tool error и
  невалидном runtime. Exact runtime `sessionId` используется в `runner.handle`,
  approval card и cost event. Обычная недоступность recall остаётся best-effort,
  но `STALE_CONTEXT` больше не поглощается и прерывает ход до model I/O.
- `interactive-turn-runtime.ts` получает persisted selection через
  `ProjectService`, удерживает один immutable lease на весь ход и собирает
  lease-bound file tools, scoped automatic recall/search/remember, approval
  recheck и optional lease-aware bash/subagent/import ports. Базовый factory
  оставляет attachment закрытым; отдельный attachment-aware factory связывает
  durable importer и manifest-aware confinement с тем же lease. `edit_file`,
  model-driven switch и delegation без child lease закрыты, а не уходят в
  legacy fallback.
- `makeNodeInteractiveTurnRuntimeFactory` соединяет этот factory с уже собранными
  registry/service/leases/confinement Node ports. Restart+switch E2E доказывает:
  старый turn lease удерживает barrier; после начала switch старые file tools
  получают `STALE_CONTEXT` до Python process I/O; после release registry
  публикует generation+1, и следующий ход получает exact Workspace session/root.
- Исправлен общий async error boundary в `lease-bound-tool-executor.ts`:
  fallback теперь ожидается внутри `try`, поэтому Promise rejection также
  преобразуется в стабильный code-only tool result.
- Proactive и goal execution в dynamic mode теперь требуют отдельный persisted
  background binding/runtime. Telegram-команды регистрации получают binding
  через capture-port в момент команды; отсутствие capture/resolver закрывает
  регистрацию/исполнение без fallback к startup cwd, chat id или current
  interactive selection. Live ветка `v2-live` в `aisy.ts` по-прежнему не
  активирована.

### Доказательства durable background binding-инкремента (2026-07-27)

- `runtime/work-binding.ts` задаёт валидируемую стабильную идентичность
  owner/profile/project/session/scope. Selection generation намеренно не
  сохраняется как identity задачи: resolver выдаёт lease с текущей монотонной
  generation, но exact сохранёнными project/session.
- `ProjectService.captureWorkBinding` создаёт отдельную persisted system session
  для Project/Workspace job. `acquireBoundContext` не читает active selection как
  target; интерактивный switch закрывает только interactive leases и не
  перенаправляет/не отменяет background lease. Archived/missing/unresolved
  project/session отклоняются до runtime acquire с code-only reason и audit event.
- Goal и trigger records имеют `schemaVersion: 2` и non-null resolved binding.
  Старые active goals сохраняются на диске как paused quarantine; legacy triggers
  сохраняются disabled и исключаются из executable set. Новая bound запись не
  удаляет quarantined legacy record. Trigger при archived/stale binding
  детерминированно сохраняется disabled с `context-paused`.
- `makeBackgroundTurnRuntimeFactory` собирает тот же lease-bound confinement,
  scoped memory, approvals и delegation port для exact saved binding. Goal
  completion (`goal_done`) принадлежит этому runtime. Telegram goal/trigger
  seams передают binding от регистрации до execution и не строят legacy runner
  при dynamic acquisition.
- Nightly binding хранится отдельно в versioned JSON и публикуется через
  exclusive temp → fsync file → atomic rename → fsync directory с mode `0600`.
  Scheduler не запускает и не помечает слот выполненным при missing/quarantined
  binding; текущая v1-композиция дополнительно проверяет exact Workspace и
  active system session перед nightly pipeline.
- Delegation handle/checkpoint наследует immutable resolved binding; event
  содержит только project/session/scope, без content, имён, секретов и байтов.
  Restart+switch тест доказывает выполнение Project A в его system session после
  выбора Workspace, повторную выдачу exact context после пересборки registry и
  `STALE_CONTEXT` до memory I/O после archive session.
- Полный regression после инкремента: `pnpm -r build`, `pnpm -r typecheck` и
  1043 core + 101 Telegram + 161 app = 1305 TypeScript tests; Python sidecar —
  29 passed, 1 platform-specific `/proc` skip; Ruff и `git diff --check` зелёные.
- WP-38/WP-41 ещё не объявлены полностью закрытыми: persisted binding/resolver
  уже проведён через local monitoring/digests и durable subagent store, но live
  v2 composition, startup recovery, delivery и archive/cutover barriers не
  активируются без отдельного согласования.

### Доказательства scoped approval grants-инкремента (2026-07-27)

- `GrantStore` использует versioned schema v2: каждый durable grant содержит
  `tool`, `scope`, `createdAt` и non-null `WorkBinding`. Lookup без binding
  всегда возвращает false, а попытка сохранить unscoped grant отклоняется.
- `session` нормализуется до exact session. `always` сохраняет исходный
  Workspace/Project/Session scope и не повышает session до Project или Project
  до Workspace. Grant Project A не покрывает Project B; Workspace и Project
  не взаимозаменяемы.
- Старый `{ "always": ["bash"] }` не интерпретируется как global capability:
  инструменты остаются в `quarantinedLegacyTools`, отображаются как отключённые
  и ждут явного назначения. Запись нового bound grant не удаляет карантин.
- Node persistence публикует `grants.json` через exclusive temp → fsync file →
  atomic rename → fsync directory с mode `0600`. Restart-тест восстанавливает
  exact project scope и доказывает cross-project отказ.
- `SafetyPolicy`, `HookGate`, main/goal runner и subagent runner получают
  immutable binding. Подтверждение одного вызова остаётся действительным, но
  remembered grant без binding не создаётся. HARD_DENY, taint/narrowing и
  обязательный Tier-3 step-up по-прежнему проверяются раньше grants.
- `ProjectService.isBindingActive` соединяет grants с lifecycle registry:
  archive session отключает session grant, archive project отключает project
  grant до tool I/O. Interactive/background runtime factory передаёт runner
  exact grant binding, а смена active selection не перенаправляет разрешение.
- Целевые проверки: 121 core safety/runtime тест, 41 core binding/grants тест и
  30 app persistence/runtime/orchestrator тестов зелёные; полный regression
  выполняется после следующего monitoring/digest слоя.

### Доказательства monitoring/digest-инкремента (2026-07-27)

- Реализованы scoped SQLite/FTS5 registry, evidence, digest и staged feedback;
  каждая запись содержит exact `ResolvedWorkBinding`, schema version и route.
- Deterministic collectors покрывают RSS/Atom, GitHub Releases, YouTube feeds,
  web и публичный Telegram. Неизменённый уже оценённый content не вызывает
  scorer; failed provider attempt списывает глобальный call budget.
- Scorer получает `provenance: untrusted` и `outboundAllowed: false`; tool calls
  и нестрогий JSON отклоняются. Node composition не имеет ambient `fetch` и
  требует отдельный egress-authorized `MonitoringHttpPort`.
- Restart, switch и archive тесты доказывают exact routing, pause delivery и
  отсутствие cross-project чтения. App delivery coordinator повторно проверяет
  persisted binding непосредственно перед каждым transport I/O, ограничивает
  tick 100 элементами, передаёт стабильный idempotency key и меняет статус
  только после непустого receipt; ошибки транспорта остаются redacted/retryable.
  Live scheduler/egress/Telegram delivery пока намеренно не подключены.
- Целевые проверки: 24 core monitoring/security теста и 5 app composition/
  delivery теста.
- Telegram delivery seam: 4 gateway renderer-теста и 5 app adapter-тестов
  покрывают HTML injection, bounded output, invalid URL/route, empty digest,
  guard-before-send и receipt. `bot.ts` и live composition не изменялись.
- Единый scheduler получил inactive-by-default monitoring hook; 5 scheduler
  тестов покрывают periodic dispatch и изоляцию ошибки без live callback.
- Полный regression после delivery-инкремента: core 1570/1570 и один opt-in
  skip, Telegram 115/115, App 366/366 и один Docker opt-in skip; workspace
  typecheck/build зелёные. Live scheduler/egress/Telegram delivery не
  активировались.
- Passive live-status инкремент: 2 gateway view + 3 app status +
  2 bot + 1 restart integration test. Полный gate: core 1570/1570 и
  1 opt-in Codex skip, Telegram 123/123, App 380/380 и 1 opt-in Docker
  skip, workspace typecheck/build зелёные. Сеть, scorer, scheduler callback
  и delivery не активированы.

### Доказательства durable subagent checkpoint-инкремента (2026-07-27)

- `DelegationPersistencePort` сохраняет versioned snapshot с exact binding,
  task, AgentCard, capabilities, scope, hash-chained shard, checkpoint head,
  run-level budget и terminal sets.
- Checkpoint создаётся при spawn и обновляется после каждого append. Fresh
  manager после crash продолжает с `lastSeq + 1`, восстанавливая общий бюджет и
  сбрасывая только локальный Loop Guardian.
- Resume до выдачи handle проверяет lifecycle, binding, task/card/capabilities,
  seq/prevHash/content hash и checkpoint. Switch на Project B не перенаправляет
  Project A; archive A закрывает resume; legacy/unbound попадает в quarantine.
- Node store реализует layout ADR-0039. Shard/checkpoint/manifest публикуются
  атомарно с `0600`; manifest-last hashes обнаруживают torn snapshot. Исходные
  audit-файлы при карантине не удаляются.
- Целевые проверки: 39 core orchestration тестов и 3 app filesystem/restart
  теста. Полный gate: build/typecheck, 1075 core + 101 Telegram + 168 app =
  1344 TypeScript tests; Python — 29 passed, 1 platform-specific skip; Ruff и
  `git diff --check` зелёные. Live binary wiring и startup recovery policy
  остаются отдельным шагом.

### Доказательства Agent DNA/capability matrix-инкремента (2026-07-27)

- AgentCard parser теперь сохраняет обязательное Markdown-тело, строго проверяет
  name/tier/maxIterations/enums/duplicates и закрывает filename mismatch и
  duplicate logical names. Builtin `general` нельзя shadow’ить.
- `resolveAgentCapabilityMatrix` разрешает card только против code-owned tool,
  active Skills и connected MCP registry. Missing/ambiguous reference блокирует
  запуск; provider получает только exact `matrix.tools`.
- Child runtime реально добавляет card body как system DNA. Community card
  маркируется untrusted и запускает narrowing; executor по-прежнему независимо
  проверяет card/scope/Safety.
- Live `aisy.ts` больше не подменяет неизвестную named card на `general` и
  строит subagent provider из matrix. Skills/MCP пусты до реального production
  wiring, поэтому декоративная capability не исполняется.
- Русская исполняемая спецификация: `docs/specs/20-agent-dna-and-capability-matrix.md`.
  Create/edit/archive lifecycle намеренно не объявлен готовым до отдельного ADR.
- Полный gate после инкремента: build/typecheck, 1092 core + 101 Telegram +
  168 app = 1361 TypeScript tests; Python — 29 passed, 1 platform-specific
  skip; Ruff и `git diff --check` зелёные.

### Доказательства Telegram Project controls-инкремента (2026-07-27)

- `makeTelegramProjectControls` строит paginated picker из persisted registry и
  хранит только process-local opaque actions. Callback не содержит target/root/
  session; process epoch и lifetime-set закрывают restart/ABA replay, а bounded
  token space исчерпывается fail-closed. Switch получает одноразовый receipt,
  привязанный к owner, target и generation.
- После `Gateway.onUpdate` тот же адаптер распознаёт точные русские и английские
  команды выбора. Authority source связан с `chatId`, `updateId`, SHA-256 текста,
  target и generation; foreign identity блокируется до issue receipt.
- Exact ambiguous name возвращает owner-bound choices и сохраняет generation.
  Обычный текст не перехватывается, unknown target не запускает модель и не
  создаёт filesystem state.
- grammY transport показывает picker только из явного меню, отбрасывает foreign
  chat до adapter/API mutation и исправляет общий inline-keyboard serializer:
  пустая завершающая строка больше не отправляется.
- Единый E2E проходит Project A → RU switch Project B → inline switch Workspace
  → restart → EN switch Project A. Проверены exact Sessions, отрицательная
  межпроектная память, отсутствие файла A в B/Workspace, импорт через Python
  sidecar и восстановление памяти/файла A после restart.
- Целевой gate: 9 controller unit + 4 transport + 1 unified integration test,
  полный app regression — 261 test; workspace typecheck/build, app typecheck и
  `git diff --check` зелёные. Security review:
  `docs/reviews/2026-07-27-telegram-project-controls-security-review.md`.
  Live `aisy.ts`, migration cutover и activation не менялись.

### Доказательства Brain bootstrap coordinator-инкремента (2026-07-27)

- Добавлен revision-bound serial coordinator для exact setup drivers:
  selection, detect, explicit install port, auth challenge, validation, restart
  resume, non-mutating health и revoke-before-reset.
- Missing/mismatched driver, concurrent replay и stale revision закрываются до
  внешнего действия. Driver exception/detail/output не сохраняются; state
  получает только стабильный code-owned error code.
- Challenge не попадает в durable state/events. Проверяются HTTPS, bounded
  device code и safe instruction; один process не начинает второй flow на той
  же revision.
- Telegram setup cards содержат revision и умеют безопасно запускать begin/
  complete/retry через optional coordinator seam. API key в обычном Telegram
  не принимается; secure local channel остаётся обязательным.
- Codex setup adapter использует официальные version/device-login/status/logout
  команды и explicit installer port. На этом checkpoint app-server run-driver
  не объявлялся готовым: stable stdio JSONL transport и typed
  tool/approval/cancel bridge ещё отсутствовали. Experimental/unsupported у
  официального app-server остаётся WebSocket transport, а не stdio JSONL.
- Целевой gate: 10 bootstrap + 10 coordinator + 7 Codex auth + 1 Codex adapter
  core tests, 7 Telegram view и 5 app setup transport tests; typecheck всех TS
  пакетов зелёный. Review:
  `docs/reviews/2026-07-27-brain-bootstrap-coordinator-security-review.md`.
  Live composition и activation не менялись.
- Bootstrap persistence усилен exact schema/phase-status validation, private
  `0600` policy, symlink denial, owner-bound exclusive lock и CAS по revision.
  Publication проходит exclusive temp → file fsync → atomic rename → directory
  fsync; identical retry закрывает post-rename ambiguity, а stale lock никогда
  не крадётся автоматически.
- Production `makeNodeBrainBootstrapStore` подключён к setup-only ветке
  `aisy.ts` без подключения live coordinator/drivers. Доказательства: 12 unit +
  3 real-filesystem integration tests с restart, permissions, lock, symlink и
  fault boundaries. Activation не выполнялась.
- Полный regression gate после инкремента: core 1337/1337, Telegram gateway
  103/103, app 273/273, Python sidecars 34 passed/1 platform skip; workspace
  typecheck/build и `git diff --check` зелёные; приватный эталон не имеет ни
  одного tracked path.

### Доказательства API credential ingress foundation (2026-07-27)

- Native API setup driver связан только с credential broker и exact binding;
  secret bytes не входят в driver/validator interface. Публичный entry-code
  bounded и предназначен только для локальной/SSH CLI-команды.
- Ingress хранит только code hash, делает atomic one-use claim, зануляет owned
  secret buffer и проводит rotation через staged validation и atomic activation.
  Crash после stage/activate, replay, supersede, rollback failure и revoke имеют
  deterministic recovery semantics.
- Durable metadata использует real SQLite с exact schema/index validation,
  `BEGIN IMMEDIATE`, `synchronous=FULL`, `secure_delete`, private canonical path
  и cross-instance winner test.
- Telegram не принимает key; validation action появляется только при доступном
  защищённом terminal entry. Targeted gate: 4 driver + 10 ingress + 5 SQLite +
  8 view tests. Review:
  `docs/reviews/2026-07-27-api-credential-ingress-security-review.md`.
- На checkpoint ingress foundation production secret backend, CLI no-echo
  command и реальный provider broker ещё отсутствовали; последующий раздел
  фиксирует реализацию CLI и code-owned validators. Legacy plaintext vault не
  расширялся. Live wiring и activation не выполнялись.
- Полный regression gate после foundation: core 1356/1356, Telegram gateway
  104/104, app 273/273, Python sidecars 34 passed/1 platform skip; workspace
  typecheck/build и integrity checks зелёные.

### Доказательства защищённого CLI и native API credential validation (2026-07-27)

- `aisy brain credential set` принимает только публичный one-use code; secret в
  argv/unknown flags/non-TTY закрывается до ingress. Raw TTY reader не показывает
  echo, mask или length, очищает внутренние и caller-owned buffers и fail closed
  при недоказуемом восстановлении terminal mode.
- OpenAI, Anthropic и OpenRouter validators связаны с ingress через
  `ApiCredentialProviderValidator` и видят только staged/active opaque handle.
  Каждый request descriptor неизменяем и задаёт точный официальный Models API,
  собственные auth protocol и vault slot, `redirect=error`, bounded timeout и
  `status-only`. Cross-provider binding/slot закрывается до proxy I/O.
- Только HTTP 200 активирует credential. 401/403, 408/504, 429, 5xx, redirect,
  неожиданный 2xx, rich proxy response и raw exception превращаются в стабильные
  redacted codes без body/headers/provider detail.
- Targeted gate: 36 CLI + 6 raw TTY + 16 provider validator + 10 ingress + 4
  setup-driver tests. Полный gate: core 1383/1383, Telegram 104/104, app
  273/273; workspace typecheck/build и `git diff --check` зелёные.
- Архитектура Keychain/Linux/Vault backend, broker и credential-injecting proxy
  согласована в ADR-0087; platform adapters, live coordinator wiring и
  activation не выполнялись.

### Offline authority checkpoint ADR-0087/ADR-0088 (2026-07-29)

- Приняты opaque secret broker/backend/proxy без plaintext fallback и отдельная
  durable exact-bound authority для semantic egress памяти.
- Реализованы Core authority и private SQLite durable store: factory-owned boot
  identity и обязательный recovery gate, durable pending-card state, canonical
  action hash, атомарные nonce/outbox transitions, exact state matrix,
  singleton writer, persisted outbox anchors и idempotent ack.
- Cross-layer E2E на real SQLite доказывает restart boot1→boot2, запрет операций
  до recovery, invalidation старой карточки, fresh revision и восстановление
  deterministic audit events. Полный gate: 3296 TypeScript tests passed,
  2 skipped; workspace typecheck/build зелёные. Python: 52 passed, 1 skipped;
  Ruff зелёный.
- Live activation не выполнялась. После закрытого ниже atomic use/revoke среза
  следующий gate — outbox recovery worker/fault matrix и ADR-0087 platform
  adapters до любого внешнего memory embedding I/O.

### Atomic use/revoke checkpoint ADR-0088 (2026-08-01)

- Отдельная SQLite-транзакция `consumeUseIfActive` проверяет exact
  `ACTIVE + authorityId + revision + generation + bindingHash`, гасит nonce и
  сохраняет `request_started`; generic transition этот путь больше не принимает.
- Core выдаёт authority-owned use-lease с `AbortSignal`. Publish и revoke
  сериализованы одним per-slot барьером; revoke закрывает gate, abort'ит lease и
  ждёт фактический settlement до purge. Late publish после revoke не вызывает
  callback.
- Тот же fence защищает `DEGRADED`, `SUSPENDED`, `BLOCKED` и повторную boot
  recovery; неоднозначная ошибка durable revoke всё равно немедленно закрывает
  локальный gate и abort'ит уже выданные lease.
- Unit race-tests покрывают обе очередности use/revoke и publish/revoke;
  cross-layer test повторяет late-publish сценарий на реальном SQLite.
- Полный gate: 3307 TypeScript tests passed, 2 skipped; workspace typecheck и
  build зелёные. Python: 52 passed, 1 skipped; Ruff и `git diff --check`
  зелёные.
- Live activation по-прежнему не выполнялась. После закрытого ниже outbox
  recovery среза следующий gate — opaque secret backend/proxy ADR-0087.

### Outbox recovery checkpoint ADR-0088 (2026-08-01)

- Durable API больше не умеет подтверждать произвольное событие: только
  `ackOutboxHead` для первой неподтверждённой insertion-sequence записи;
  exact уже подтверждённый retry остаётся идемпотентным.
- Bounded worker доставляет события строго последовательно и продолжает очередь
  только после `accepted | duplicate-exact` и head-ack. Timeout, stop, corrupt
  envelope, unknown/not-head ack и raw sink failure fail closed без skip.
- Delivery и durable read/ack имеют отдельные code-owned timeouts: late
  delivery/read не вызывает ack, а late ack не запускает следующую доставку;
  новый pass перечитывает фактическую durable-голову.
- Private anchor остаётся внутри проверенного SQLite port и до выдачи worker
  связывает canonical payload с lifecycle/recovery/request `eventId`; sink
  получает только повторно проверенный redacted envelope.
- Real SQLite fault matrix покрывает crash после sink до ack, exact duplicate
  после restart, ack persistence, head failure, tamper, concurrent run и late
  accepted после timeout. Live dispatcher/startup wiring не включены.
- Полный gate: 3327 TypeScript tests passed, 2 skipped; workspace typecheck и
  build зелёные. Python: 52 passed, 1 skipped; Ruff и `git diff --check`
  зелёные.
- Следующий gate — opaque secret backend/proxy ADR-0087; расширенная process-kill
  матрица выполняется вместе с live composition до отдельного activation approval.

### Доказательства Codex app-server read-only supervised slice (2026-07-27)

- Официальный app-server v2 schema сгенерирован установленным
  `codex-cli 0.144.5`; driver закреплён на exact profile и stable JSONL methods
  без experimental API. Version mismatch закрывается до session open.
- Driver выполняет initialize, exact thread start/resume и turn start, связывает
  Project/Session с opaque Codex thread, проверяет thread/turn каждого события,
  ограничивает prompt/reply и стримит только bounded agent text/thinking.
- До typed Aisy bridge принудительны `sandbox=read-only` и
  `approvalPolicy=never`. Native command/file/MCP/dynamic/collaboration items и
  server requests вызывают interrupt без raw action в BrainEvent.
- Cancellation до старта не открывает runtime; mid-stream abort посылает
  `turn/interrupt` и закрывает session. Injected store contract доказывает exact
  resume и denial corrupt/cross-project binding после restart.
- Targeted gate: 15 app-server driver + 8 Codex auth tests. Полный core gate:
  100 files, 1399/1399 tests. Review:
  `docs/reviews/2026-07-27-codex-app-server-driver-security-review.md`.
- Реализован Node stdio JSONL transport: canonical owner-controlled absolute
  executable/cwd без group/world write, exact spawn command, environment
  allowlist без API secrets, method allowlist,
  byte/pending/event bounds, whole-connection fail-closed и single consumer.
- Реализован durable SQLite thread store: private canonical path, exact schema и
  rowset validation, unique thread ownership, `BEGIN IMMEDIATE`, restart и
  cross-instance winner. Real-filesystem integration доказывает first start и
  exact resume после пересборки store/transport через controlled JSONL child.
- Targeted gate transport/store/driver: 38/38 tests; core typecheck зелёный.
  Typed Aisy tool/approval bridge, live routing и activation ещё не выполнены.
- Полный gate после transport/store slice: core 103 files, 1422/1422;
  Telegram 104/104; app 273/273; workspace typecheck/build зелёные.
- Auth port закреплён на том же canonical executable и process allowlist, что и
  app-server; допускаются только четыре exact official command shape. Два Node
  auth tests проверяют path/config/command isolation.
- App-level `makeNodeCodexReadOnlyRuntime` собирает auth, transport, SQLite store
  и driver, но не вызывается live CLI до activation approval. Два app tests
  доказывают exact restart resume и отсутствие store side effect на invalid
  config.
- Opt-in account-free smoke прошёл против реального установленного
  `codex-cli 0.144.5`: version и stable stdio initialize/initialized в
  изолированном временном профиле без login или model turn.
- Полный gate после app wiring: core 1436 passed и 1 opt-in skipped, app
  276/276, Telegram 104/104; opt-in real-process smoke отдельно прошёл 1/1;
  workspace typecheck зелёный.
- Официальный `dynamicTools`/`item/tool/call` flow требует experimental API и
  не совместим с принятой stable-only границей. До отдельного архитектурного
  согласования рекомендуется Aisy-owned local MCP bridge с exact allowlist;
  native Codex/MCP capabilities остаются fail-closed.
- Реализованы transport-independent bridge, общий Safety/Approval executor и
  app-level Project-lease seam: exact binding/turn authority, code-owned
  provenance, allowlist, lifecycle check, bounded dispatch, replay idempotency,
  scoped grants, abort propagation и redacted failures; targeted gate 12/12 и
  app E2E 1/1.
- Проверка 2026-07-28: final release MCP specification и versioned final schema
  пока не опубликованы; canonical `latest` остаётся `2025-11-25`, доступны
  RC/draft. Split TypeScript SDK v2 опубликован с номером `2.0.0`: официальный
  API reference уже называет v2 stable line, но release notes всё ещё называют
  тот же выпуск первой beta. Из-за этой рассинхронизации и отсутствия final
  schema закреплённый SDK binding ещё не принят, а
  закреплённый Codex CLI 0.144.5 в реальном MCP client path продолжает legacy
  `initialize`/`initialized` и не доказывает `server/discover`.
- Реализован выключенный SDK-neutral wire adapter: exact modern-only или bounded
  dual-era, code-only negotiation evidence, без retries/prior cache, с лимитами
  pages/tools/bytes, полным descriptor hash surface, строгими `ttlMs`/
  `cacheScope` и поддержкой отдельного bounded JSON `structuredContent` при
  text-only prompt boundary.
  Evidence: 15 targeted wire-adapter tests; общий Core gate 1619/1619 + 1
  opt-in real-Codex skip, typecheck/build зелёные.
  Рекомендован dual-era до обновления Codex; concrete SDK binding и live activation
  остаются за отдельным согласованным ADR.
- Повторная проверка официальных деревьев в день релиза: в `schema/` и
  `docs/specification/` по-прежнему есть только версии до `2025-11-25` и
  `draft/`; URL финальной спецификации `2026-07-28` не опубликован. Split SDK
  `2.0.0` вышел 27 июля, но его release notes прямо называют выпуск первой
  beta. Локальный pin остаётся `codex-cli 0.144.5`; его release не содержит
  доказательства modern MCP negotiation. Выключенный dual-era adapter остаётся
  правильной временной границей.

### Доказательства durable subagent production-preview runtime (2026-07-27)

- Terminal `TaskObservation` теперь сохраняется вместе с terminal status и
  повторно выдаётся после restart без child/verifier I/O и без повторного
  списания run budget. Обычный `resume()` завершённой делегации по-прежнему
  запрещён; startup использует отдельный `recover()`.
- App-level runtime требует явную policy `resume-active-replay-terminal` и до
  spawn новых задач сначала восстанавливает persisted shards. Durable
  `runtime.verified-result` закрывает crash-окно после verification, но до
  terminal commit.
- Parent получает только verifier-owned bounded summary/result. Raw candidate и
  child exception не становятся observation/event; over-budget, malformed и
  unverified output завершаются стабильным code-only отказом.
- Child handle не содержит `complete()`/`fail()` и не может записывать
  зарезервированные `runtime.*` entries. После candidate capability отзывается;
  cancellation требует подтверждённой остановки, а стоимость child+verifier
  приходит из code-owned meter.
- Security hardening: one-shot terminal/handle epochs, strict verifier boolean,
  DAG collision/cycle validation, pre-hash payload cap, fail-closed driver,
  canonical private no-symlink state-root, exclusive per-run lock, durable active
  task IDs и fail-closed отказ при пропавшем child snapshot.
- Targeted gate: 66 core tests и 17 app persistence/runtime tests. Full gate:
  Core 1585 passed / 1 opt-in skip, App 407 passed / 1 Docker opt-in skip,
  Telegram 123 passed, Python sidecar 46 passed / 1 platform skip; workspace
  typecheck/build и Ruff зелёные. Live `aisy.ts`, run-id scan/cutover, реальные
  child/provider adapters и Telegram status cards не подключены и не
  активированы.

### Доказательства live-композиции повседневного использования (2026-08-05)

Срез отвечает на вопрос «чем уже можно пользоваться», а не «что доказано в
изоляции». Приоритет по решению оператора: функционал вперёд, безопасность
дозакрывается параллельно.

**Подписочный мозг с инструментами (ADR-0090).** `claude -p` не принимает чужие
tool-схемы, поэтому Aisy публикует свой каталог локальным MCP-сервером
(`mcp-bridge-server.ts`, loopback + bearer-токен на вызов), а встроенные
инструменты CLI снимаются целиком (`--tools ''`). Каждый вызов возвращается в
живую композицию через общий `makeCodexCapabilityExecutor`: safety policy, hook
gate, гранты, режим исполнения и карточка одобрения. Fail-closed при молча
отвалившемся мосте и при уцелевшем нативном инструменте. `--safe-mode` не
используется — он отключает MCP заодно (проверено на 2.1.220).
Evidence: `mcp-bridge-server.spec.ts` 6/6, `claude-subscription-provider.spec.ts`
9/9; живой прогон — модель вызвала `list_dir` и `read_file`, исполнила Aisy.

**bash в проде.** Порт подключён (`host-bash.ts`): рабочая зона, таймаут,
обрезка вывода, окружение без секретов, отказ в необратимых командах. Периметр —
tier-2 карточка одобрения, а не список отказов. Docker-песочница остаётся
выключенной. Evidence: `host-bash.spec.ts` 8/8; живой прогон через подписочный
мозг — команда выполнена, `sudo rm -rf /` отклонён с exit 126.

**Вложения и чистый выход.** Media inbox подключён к `aisy run` с прод-адаптером
Bot API. Единая точка выхода освобождает writer lock и journal lease на
сигналах, необработанных ошибках и падении polling — раньше `bot.start()` без
обработчика ронял процесс, а брошенный lock молча выключал вложения.

**Первый запуск памяти.** `aisy run` падал с `UNSAFE_PATH` на чистом `AISY_HOME`:
композиция не создавала свой content root. Исправлено в общей Node-композиции,
поэтому чинится и глобальный scope, и per-project. Evidence: тест первого
запуска в `protected-memory-runtime.spec.ts`.

**Ложное сужение контекста.** Дневник дня и открытые задачи помечались
`untrusted`, из-за чего `narrowed` включался на каждом ходу: `web_search` уходил
в deny, а каждый ответ ждал подтверждения. Это данные самого рантайма — теперь
`operator`.

**Подключение мозгов из Telegram.** Координатор собран в live-приложении с
драйверами Claude и Codex; раньше кнопки падали в throw и молча перерисовывали
карточку. Драйвер подписки Claude написан заново (его не было), revoke — через
официальный logout. Evidence: `claude-setup-driver.spec.ts` 5/5; живой прогон
координатора — выбор → детект → вход → проверка → `BRAIN_READY` → health ok.

**Gate:** typecheck/build зелёные; Core 2135, Telegram 146, App 1484 — всего
3765 тестов. `execution-process-group` даёт редкий флейк при параллельном
прогоне под нагрузкой (изолированно 17/17).

**Осталось до полноценной приёмки:** голос (Deepgram ждёт HTTPS-порт, spend
authority и ключ оператора), постоянный сервис на Linux, `aisy skill install`,
компакция транскрипта, семантическая память и MCP-клиент.

### Сверка плана с кодом и живой установкой (2026-08-17)

Оператор спросил, что из плана ещё не сделано. Сверка каждого открытого пункта
с кодом дала три разных ответа, и разница между ними важнее их числа.

**План отставал от кода.** Четыре пункта были закрыты давно, а чекбокс остался:
lifecycle-контролы и session-контролы переданы боту в `bin/aisy.ts`; оба
подписочных драйвера собраны в живом bootstrap-координаторе; media inbox с
голосом и альбомами активирован. Отмечено выше по фактам, не по памяти.

**Cutover Workspace v2 на этой установке не имеет предмета.** `~/.aisy` на fr1
создан 2026-08-08 сразу на registry v2: `projects-v2.json` авторитетен и
используется живой композицией, файлов v1 нет вовсе. Мигрировать нечего, и
`doctor` вводит в заблуждение фразой «v1 остаётся authoritative» — правильнее
«миграция не требуется». Машинерия миграции (манифест, lock, фазы,
cohort-привязка) остаётся нужной для установок, выросших из v1.

**Turn runtime v2 — не выключатель, и на этой установке не даёт эффекта.**
`bot.ts` умеет обе развилки (`acquireTurnRuntime` против `buildRunner`), но
переход требует переписать `buildRunner` под сигнатуру
`{lease, grantBinding, approve, executeTool}`, вынести `executeNonContextTool`,
`runBash`, `spawnSubagent`, `importAttachment` и собрать источники слоёного
контекста. Главное: слои 2/3 живут в **проекте**, а на fr1 существует ровно один
контекст — Workspace, для которого `LayeredContextAssembler` обязан отдавать
пустой проектный слой (`INVALID_EXCERPT` иначе). До появления настоящего проекта
активация меняет внутренности хода и не меняет ничего, что видит оператор.

**Порядок, в котором это имеет смысл делать:** сначала настоящий проект в
registry (не Workspace) → затем turn runtime вместе со слоёным контекстом →
затем remaining пункты этапа 3 (`acquireBackgroundRuntime`, снятие
`staticWorkBinding`). Обратный порядок даёт риск регрессий в рабочем боте при
нулевой видимой пользе.

# Матрица production-готовности Aisy

> Текущий verdict после замены package delivery находится в
> [матрице от 2026-08-23](./2026-08-23-production-readiness-matrix.md).

> **Исторический срез.** Матрица фиксирует состояние на 2026-08-21. Указанный в
> ней package delivery больше не является текущим каналом и заменён
> [ADR-0106](../decisions/2026-08-22-managed-git-distribution-without-apt.md) и
> [компонентом 28](../specs/28-managed-git-distribution-without-apt.md). До новой
> production-приёмки managed Git/SSH delivery имеет статус «к реализации», а не
> LIVE.

**Дата среза:** 2026-08-21
**База аудита:** проверенный rewritten `master@2830130` после merge PR #16 и
финального history scrub. В
общий tree входят
supervised durable runtime, Docker recovery barrier, secure voice proxy,
LIVE monitoring/MCP/AgentCard/Plan Mode, LIVE обучаемая автономность, systemd
provider broker, системная доставка с обязательной подписью и production fixes
voice bridge.

**Назначение:** отделить реально подключённые возможности от dormant-кода,
учесть уже смерженную работу Claude и не реализовывать её повторно.

**Свежий объединённый tree:** уже включает Telegram lifecycle-каталог Agent
Cards, RSS/Web monitoring, research pulse, LIVE promotion/enforcement/UI
обучаемой автономности, root-owned encrypted voice proxy и native API lifecycle
с одноразовым TTY enrollment. Принятые committed изменения не переисполняются:
матрица сверяется с фактическим import graph.

Историческая системная доставка `0.1.14-4`, найденные voice-дефекты и target
evidence зафиксированы отдельно в
[production-приёмке системных пакетов](./2026-08-21-system-package-production-acceptance.md).

## Как читать статусы

- **LIVE** — возможность создаётся в `aisy run` и доступна оператору.
- **DORMANT** — production-код и тесты существуют, но `aisy run` его не создаёт.
- **ОТСУТСТВУЕТ** — требуемого production-пути ещё нет.
- **ОТЛОЖЕНО ADR** — отсутствие принято как явное архитектурное ограничение.

Наличие unit-теста само по себе не доказывает LIVE. Для статуса LIVE требуется
production importer/composition, а для итоговой готовности — ещё и приёмка на
целевом хосте.

## Матрица

| Область | Статус | Доказательство в текущем срезе | Что ещё требуется |
|---|---|---|---|
| Telegram: текстовые ходы, streaming, вложения, пачка пересланных сообщений | **LIVE** | `makeTelegramBot`, durable media inbox, streaming checkpoint и forward batching создаются в `packages/app/src/bin/aisy.ts`; полный suite содержит `bot-streaming*`, `bot-media*`, `telegram-forward-batch*` | Серверная приёмка после подключения мозга |
| Workspace, Projects, Sessions и scoped files | **LIVE** | `makeNodeProjectServiceRuntime`, session lease, project registry v2, переключение/возврат в сессии и архивирование проектов находятся в live composition; commit `4039ea4` | Серверная приёмка после подключения мозга |
| Голос через Deepgram | **LIVE под supervisor; системный runtime принят на fr1** | `aisy run` не создаёт прямой provider/credential/HTTPS fallback. На fr1 package/helper/units `0.1.14-4` активны из exact rewritten `2830130`; broker PID/status публикуются `0644`, native FD handshake проходит, restart удержал один MainPID с `NRestarts=0`, rollback/roll-forward `-4→-2→-4` зелёный | Vendor credential не вводился. Для полного AC-25-22 нужны operator TTY enrollment, отдельный consent, Telegram voice turn, bounded vendor call и revoke |
| Память: durable facts, Project scope, keyword search, забывание и проекция `MEMORY.md` | **LIVE** | `makeNodeProtectedMemoryScopeRuntime`, scoped router и `makeScopedMemoryLiveView` являются единственным live store; legacy fallback не создаётся | Human-confirmed delete authority пока закрыта; серверная restart-приёмка обязательна |
| Семантическая память | **LIVE при явной конфигурации** | OpenRouter descriptor, sqlite-vec и durable semantic-egress consent подключены; без descriptor система честно работает keyword-only | E2E с реальным embedding provider и отзывом согласия |
| Skills: папки, активный manifest, prompt-подгрузка, Telegram-управление | **LIVE** | Active skill persistence/catalog и `skillPromptRuntime` создаются в `aisy run`; каталог перечитывается после изменения | Проверить установку/выключение на fr1 |
| Native extension hooks | **LIVE** | `.mjs` hooks загружаются при старте, их tools/context providers проходят общий executor и untrusted narrowing | Нужна эксплуатационная приёмка пользовательского hook |
| Tools narrow waist | **LIVE с принятым host-risk** | Файлы, память, knowledge, tasks, journal, web search, `fetch_url` и delegation входят в live catalog. `web_search` использует exact-host DNS/IP-pinned HTTPS port; `fetch_url` повторяет HTTPS/DNS/IP gauntlet на каждом redirect и требует Tier-2 подтверждение exact domain | `bash` исполняется на хосте; credential-bearing integrations требуют отдельной authority |
| Sandbox и recovery внешних sidecar | **LIVE только startup recovery barrier; sidecars DORMANT** | Exact opt-in `aisy docker enroll` создаёт private v4 ledger отдельно от runtime; `aisy supervise` read-only загружает exact installation/daemon/socket activation и передаёт genuine manager до первого child. Direct run, partial/missing enrollment и drift отказывают fail-closed; child не получает Docker config или active epoch. `doctor --only=sidecars` read-only проверяет config/ledger/pinned daemon | Подключить authenticated current-child authority, genuine active cleanup, multi-resource cleanup и провести real-Docker + service-manager rehearsal. Create/use Docker sidecar этим срезом не активированы |
| Safety: HookGate, approvals, execution modes, grants, budgets, outbound narrowing | **LIVE с принятым host-risk; Plan Mode LIVE** | Общий capability executor, approval cards, durable grants и режимы `auto/confirm/plan/bypass` создаются в live composition; ADR-0091 ограничивает обход точным `bash`. ADR-0092 закрепляет research→execute, ADR-0093 — code-derived правила «похожие на сессию/навсегда» без raw path/content | `bypass` даёт полный Bash в пределах OS UID; Tier-3 не наследует broad grant. Остаётся серверная Telegram-приёмка Plan Mode и approvals |
| Claude Pro/Max как мозг с инструментами Aisy | **LIVE в коде** | `makeClaudeSubscriptionProvider` поднимает per-call loopback MCP bridge; каждый tool call возвращается в общий capability executor | fr1 bootstrap сейчас не принят оператором |
| Native API-провайдеры OpenAI, Anthropic, OpenRouter, DeepSeek, Qwen, GLM и Gemini | **LIVE в коде; lifecycle runtime принят на fr1** | Fixed descriptors, streaming/admin planes, Telegram→TTY enrollment и host-encrypted A/B slots остаются fail-closed. На fr1 package/helper/units `0.1.14-4` активны из exact rewritten `2830130`; семь отсортированных provider IDs имеют `binding=ready`, а rollback/roll-forward `-4→-2→-4` прошёл без смены MainPID | Vendor material не вводился. Остаются operator TTY enrollment, bounded вызов, переключение модели, restart с реальным slot и revoke |
| Произвольный OpenAI-compatible base URL | **ОТЛОЖЕНО ADR-0099** | Компонент 26 принимает только семь code-owned origins; caller не передаёт URL, host, auth header или redirect policy | Отдельный ADR и scoped egress/identity model; текущий runtime обязан fail closed |
| ChatGPT/Codex subscription как мозг | **LIVE в коде** | `aisy.ts` выбирает `codex-subscription`; version-pinned app-server получает per-turn loopback Aisy MCP, exact thread/turn binding, отдельный private `CODEX_HOME` и capability thread profile. Сквозной offline test выполняет Aisy tool и возвращает ответ без внешней сети | Пройти device auth и Telegram tool-call на fr1; это эксплуатационная приёмка, не новый кодовый мост |
| Main Agent DNA / AgentCard capability matrix | **Lifecycle-каталог LIVE; runtime authority за двумя exact opt-in gates** | Main selector ограничивает provider schemas, Skills, MCP и executor. Один durable registry обслуживает main/non-builtin subagent selection и bounded Telegram selector/CRUD для произвольных exact Workspace/current Project targets. Все пять verbs используют Tier-3 envelope proof; explicit legacy import доступен только через verified confinement sidecar | Registry cutover на целевом хосте не включать до restart/rollback E2E; без sidecar import скрыт fail-closed |
| Субагенты и агентные команды | **LIVE; supervised durable path deployed** | `master@1274722` создаёт genuine lease-bound dispatcher с тем же `spawn_subagent`; direct `aisy run` сохраняет ephemeral rollback. Этот exact commit работает на `fr1` под `aisy supervise` | Операторский Telegram `spawn_subagent` E2E |
| Durable resume субагентов | **LIVE; deployed, target acceptance частична** | Подключены реальные provider/tool receipts, Journal V2, operation control, bounded budgets, terminal replay, registry retirement, private exact parent capture/retire, durable retry/cancel actor, bounded Telegram callback, startup exact-span replay, durable `/stop` quiescence receipt и durable final reply release. Target real-process corpus на exact release проходит child recovery 6/6 и общий envelope 9/9; controlled child `SIGKILL` восстановил единственную parent/child пару через один ожидаемый systemd restart, а direct-run rollback rehearsal вернул healthy supervisor | Операторские Telegram ambiguity, `/stop` и ordinary delegated turn E2E; затем финальная target acceptance |
| Nightly consolidation и proactivity | **LIVE** | Generator/judge, scheduler, triggers, goals, reminders и nightly maintenance создаются в `aisy run`; обучаемая автономность подключена отдельным LIVE-контуром ADR-0103 | Целевая проверка первого дозревшего предложения после нормативного семидневного окна |
| Monitoring и digest | **LIVE в коде для RSS/Web** | `aisy run` создаёт exact-bound Telegram source UI, DNS/IP-pinned GET-only port, no-tools scorer, bounded scheduler, durable daily window, at-most-once Telegram send-ledger и delivery receipt. Pause сохраняет exact-domain grant, confirmed remove отзывает; `AISY_MONITORING=0` отключает UI/tick/delivery без удаления корпуса | Целевой RSS→Telegram E2E после restart/rollback и эксплуатационный pentest egress; Telegram/YouTube/GitHub source UI и feedback остаются dormant |
| MCP внешних серверов | **LIVE** | Merge `71a91dc` запускает startup connect gauntlet до provider, публикует `call_mcp` только при непустом безопасном menu, берёт tier/outbound/approval identity из human-owned policy и возвращает результат как untrusted. Combined composition/runner regression после merge зелёный | Streamable HTTP остаётся выключен; нужен реальный stdio E2E на целевом хосте |
| Полный transcript и compaction | **LIVE** | Commit `4039ea4` уже находится в `master`: дешёвый tier суммаризирует, а отказ деградирует до честного усечения; targeted tests зелёные | Принять длинную сессию на fr1 |
| Знакомство и живые Telegram-кнопки | **LIVE** | Помимо onboarding, объединённый runtime содержит stop на карточке, access/bots/memory/goals формы и живую goal-карточку; `5908a6b` обходит каждый label меню и достижимый callback. После merge Telegram suite прошёл 175/175, App button/forms corpus входит в зелёный combined regression | Пройти пользовательскую приёмку на fr1 |
| Обновление и restart supervisor | **LIVE; package restart принят на fr1** | Parent supervisor и durable recovery остаются code-owned. После verified-bundle sync и activation voice/provider `0.1.14-4` production restart на exact rewritten `2830130` удержал MainPID `140327`, `NRestarts=0`; provider и voice rollback/roll-forward `-4→-2→-4` прошли без потери binding | Known-bad voice `0.1.14-1` больше не является previous. Docker create/use и multi-resource cleanup остаются dormant |
| Несколько Telegram-ботов | **LIVE с принятым ограничением** | Durable bot registry, add/list/archive и per-bot roots существуют | Переключение активного бота кнопкой **ОТЛОЖЕНО ADR/процессной моделью**: один процесс обслуживает один token |
| Защищённый общий выход в сеть | **ЧАСТИЧНО LIVE** | `web_search` и `fetch_url` используют DNS/IP-pinned HTTPS gauntlet. При подключённых оператором ключах Serper/Supadata/Apify доступны только через фиксированные service hosts и allowlisted credential headers; ключи не попадают в URL. LIVE RSS/Web monitoring получает read-only GET authority только на exact domain явно добавленной persisted source и отзывает её при remove | Другие credential-bearing integrations требуют отдельной scoped authority; monitoring требует целевого E2E и pentest |
| Обучаемая автономность | **LIVE** | ADR-0103: production composition создаёт private evidence/grant stores, передаёт `learnedAutonomy` и `observeApproval` в общий runner, записывает демонстрацию только после успешного хода, предлагает дозревший workflow после ответа и показывает отзыв в Telegram. Tier-3/HARD_DENY/narrowing и режимы confirm/plan не ослаблены | Нормативное окно не ускоряется: первый реальный promotion возможен только после 5 подтверждений, 3 сессий и 7 дней; нужен целевой restart/forget E2E |
| Приватность локального эталона | **Управляемая remote history очищена; GitHub PR cache gate открыт** | Atomic force-push с per-ref leases обновил `27` веток. Fresh remote mirror: `42` heads/tags, `0` совпадений точного имени в refs/paths/blobs/commits/tags, `git fsck --strict` clean; Gitleaks проверил `709` commits без findings. `master@2830130`, package/repository snapshot `0.1.14-4` и production checkout согласованы | GitHub сохраняет read-only `refs/pull/1..16/head`; для полного server-side dereference/GC/cache purge требуется GitHub Support и пересинхронизация оставшихся сторонних клонов |

## Сверка свежего `master` и оставшихся разрывов

| Срез | Состояние | Проверенное доказательство | Следующий gate |
|---|---|---|---|
| MCP invocation | Интегрирован и LIVE | `71a91dc` включает `0bc771f`; production composition + composition/runner cases прошли после merge, generic wrapper не является источником tier или approval | Реальный stdio E2E |
| Ответ оператору после narrowed turn | Интегрирован и LIVE | `71a91dc` включает `9c8398d`: narrowed/untrusted контекст не удерживает финальный ответ единственному оператору; сетевые outbound sinks всё ещё закрывает HookGate | Эксплуатационная приёмка |
| Полнота Telegram UI | Интегрирована и LIVE | `71a91dc` включает полный handler/button walk и новые формы; combined App regression и Telegram 175/175 прошли | Ручной проход на целевом боте |
| AgentCard lifecycle | Selector/CRUD LIVE; selection cutover по умолчанию legacy | ADR-0069, forward-only registry v2, exact Project binding, genuine Gateway proof, private atomic store, one-use Telegram callbacks/forms и descriptor-relative explicit legacy import подключены в `aisy run`. Publish supersede'ит прежнюю revision; archive и restart не воскрешают её; снятие gate возвращает file loader | Целевой restart/rollback E2E до включения registry selection gate; runtime selector не меняет monitoring opt-in или authority |
| Demonstration-grounded autonomy | **LIVE по ADR-0103** | Спецификация 24 и production composition создают evidence/grant stores, наблюдают точный operator approval, записывают только завершённый ход и включают HookGate enforcement лишь в режиме `auto`. Demotion/forget, TTL/revoke и Telegram UI остаются code-owned | Нужен целевой семидневный promotion/restart/forget E2E; пороги нельзя ускорять ради теста |
| Secure voice credential proxy | System package/runtime **принят на fr1**, credential E2E открыт | `0.1.14-4` из exact rewritten `2830130` активен; публичные runtime projections root-owned `0644`, общий native/Python handshake и restart стабильны. Реальный rollback/roll-forward `-4→-2→-4` сохранил MainPID и `binding=ready` | Operator TTY, consent, Telegram voice turn, bounded vendor call и revoke; known-bad `0.1.14-1` не использовать |
| Native provider lifecycle | System package/runtime и rollback **приняты на fr1** | `0.1.14-4` из exact rewritten `2830130` активирован для семи code-owned IDs; `binding=ready`. Реальный rollback/roll-forward `-4→-2→-4` сохранил MainPID. Disposable Linux corpus и локальные tests остаются зелёными | Operator TTY enrollment, bounded vendor call/model switch/restart/revoke; vendor material не вводится в тестовый corpus |
| Monitoring activation | LIVE в коде для RSS/Web | Exact-domain authority, redacted one-use Telegram UI, bounded scheduler/scorer, restart-safe digest window, at-most-once send-ledger и receipt delivery подключены в production composition; targeted LIVE corpus зелёный | Целевой RSS→Telegram E2E, restart/rollback rehearsal и egress pentest до окончательной эксплуатационной приёмки |
| Durable delegation | Supervised importer **deployed; автоматические gates зелёные** | Реальные receipt/evidence ports, registry retirement, private parent capture, actor/CAS `/stop`, startup exact-span coordinator и crash/replay corpora подключены. На объединённом `1274722`: Core 2352/2352 исполняемых, App 2498/2498 исполняемых и Telegram 255/255; exact tree работает на fr1 под supervisor | Операторские Telegram ambiguity, `/stop` и ordinary delegation E2E до статуса user-accepted LIVE |

Текущий доказанный runtime-срез `fr1` работает на локальной `ext4`, Node
22.23.1; application checkout и root provider/voice release совпадают с
rewritten `master@2830130`. Сохранены rollback-ветки раннего deploy и
`codex/rollback-fr1-pre-rewrite-20260821-f389061` на предыдущем production
commit.
Lockfile-install и workspace build прошли до рестарта; read-only
`doctor --post-upgrade` прошёл и до, и после рестарта: 6 pass / 2
contract-defined warnings / 0 fail. Новый user-service имеет новый MainPID,
`NRestarts=0`, `Result=success`; checkout чист. Warnings относятся только к
выключенным legacy Docker sandbox и restricted clone.

Root provider/voice helpers и units на fr1 установлены системными пакетами
`0.1.14-4` и активированы только explicit helpers. Provider и voice показывают
`binding=ready`; restart и оба rollback/roll-forward корпуса стабильны. Encrypted
vendor material намеренно не вводился, поэтому provider call и transcription
не выдаются за завершённый target E2E. Следующий gate — operator TTY enrollment,
отдельный consent и штатные vendor/revoke сценарии.

Controlled `SIGKILL` child завершил fail-closed supervisor; user-systemd сделал
ровно один restart и поднял единственную новую parent/child пару без дубликата.
После штатной quiescence тот же release binary восемь секунд работал через
direct `aisy run` до ожидаемого `timeout=124`, затем `aisy supervise` вернулся с
одним parent, одним child, `NRestarts=0` и повторным healthy doctor. Монолитный
App suite на 2 GB / 1 vCPU не завершился в лимит и вызвал старые 5–10-секундные
fixture timeouts; соответствующие файлы прошли изолированно (protected memory
23/23, parent supervisor 10/10, Telegram supervisor 9/9, Docker startup policy
4/4, bounded Docker coordinator 52/52). Это доказывает ресурсную конкуренцию, но
не подменяет ещё не завершённый полный sharded target corpus. Локальный полный
post-merge corpus остаётся зелёным.

Code-only snapshot production-конфигурации после deploy не выдаётся за E2E:
выбран и reachable только `claude-subscription/sonnet`, fallback/tiered provider
не настроены; Deepgram key и durable transcription consent отсутствуют; MCP
startup gauntlet честно публикует 0 servers / 0 tools; active Skills manifest
отсутствует; AgentCard registry не настроен и cutover выключен. Builtin
delegation остаётся доступной, но перечисленные external/provider lifecycle
пути требуют операторской настройки через штатные authority, а затем
Telegram-приёмки. После release в transcript не появилось нового operator turn,
поэтому ordinary text envelope также пока не считается принятым.

Документный drift component 20 после merge устранён: MCP set теперь описан как
точное множество servers, переживших startup gauntlet; пустой set остаётся
fail-closed результатом, а не постоянным состоянием composition.

## Владение работой без пересечений

### Claude

1. Фактическая выдача одобренных MCP tools и полный обход Telegram-кнопок
   завершены и вошли в merge `71a91dc`; повторная реализация запрещена.
2. Остаются пользовательская приёмка MCP, compaction/onboarding на fr1 и
   bootstrap мозга.

### Codex

1. Plan Mode, полный Bash bypass, code-derived similar grants, AgentCard
   lifecycle, monitoring и durable delegation уже находятся в общей истории;
   повторная реализация запрещена.
2. Secure voice и systemd provider lifecycle смержены; PR #8 добавил только
   фиксированные native API descriptors и не активировал custom base URL либо
   legacy plaintext fallback.
3. AC-25-21 и disposable Linux gate AC-26-15 для provider broker закрыты.
   Открыты target delivery gates: AC-25-22 для voice и AC-26-16 для native
   providers на fr1.

Codex не редактирует незакоммиченные файлы корневого worktree Claude и ведёт
каждый срез в отдельном ignored `worktrees/`.

### Интеграционная граница

- `origin/master@1274722` содержит PR #1–#12, provider-fix срез и локальную
  production-линию до `0a74f4c`. Monitoring,
  MCP/Telegram/AgentCard, durable delegation, research, autonomy promotion/UI,
  Telegram turn isolation, secure voice и provider lifecycle входят в
  фактический tree; отдельный cherry-pick или повторная реализация не нужны.
- Genuine recovery→active Docker-срез, добавление/одобрение MCP с телефона и
  stdio client уже реализованы; повторять их нельзя.
- Любое пересечение по production composition (`packages/app/src/bin/aisy.ts`)
  разрешается только при интеграции: функциональные файлы среза остаются
  независимыми, а финальный importer добавляется поверх уже принятого commit
  Claude.
- `packages/app/src/bin/aisy.ts` изменяется только в изолированном worktree;
  чистый root `master` не используется как площадка интеграции.

## Состояние durable-resume execution-среза

Полный Bash `bypass` реализован в `9a7de5f`, LIVE Plan Mode — в `e663b59`,
code-derived similar grants — в `3b9ebaa`. Текущий срез не меняет их. Он уже
подключает обычный `spawn_subagent` к durable runtime только под supervisor:
доказанные результаты продолжаются после restart, а неоднозначное внешнее
действие fail-closed не повторяется. Пользовательский retry/cancel lifecycle
подключён; durable `/stop` и общий process corpus закрывают кодовый
release-gate. Автоматическая target restart/rollback-приёмка завершена;
операторские Telegram ambiguity, `/stop` и ordinary delegation остаются
delivery-gate.

Минимальная приёмка среза:

1. LIVE recovery допускается только под parent supervisor после доказанного
   завершения прежнего runtime и одноразового recovery lease; direct `aisy run`
   durable state не восстанавливает.
2. Settled provider/tool результаты и стоимость не повторяются после restart.
3. `prepared` без `settled` не повторяется автоматически: production создаёт
   durable pause и только exact repeat-once/cancel authority.
4. Telegram handler сохраняет private exact parent continuation до provider
   I/O, а callback только записывает `resume-ready`; startup replay использует
   сохранённые spans без повторного recall/voice ingress.
5. Обычный turn, callback, actor и `/stop` делят одну global execution lease;
   `/stop` выигрывает durable actor CAS и публикует cancellation только после
   exact quiescence receipt.
6. Settled cost, held ambiguous maxima и retry reservation вместе не превышают
   исходный task slice и общие budgets.
7. Child real-process corpus закрывает пять crash points, общий Telegram +
   callback/stop + actor corpus — девять. Полный post-merge regression, review и
   целевая restart/rollback-репетиция пройдены; остаётся пользовательская
   Telegram-приёмка.

## Базовые проверки среза

- Для объединённого `origin/master@1274722`: Core — 2352 passed / 1 skipped,
  Telegram — 255 passed, App вне socket sandbox — 2498 passed / 2 skipped,
  sidecars — 145 passed / 39 platform skips; Ruff, workspace typecheck/build и
  `git diff --check` зелёные. Первый полный App-прогон отделил один
  real-process timing race; exact файл сразу прошёл 10/10, повторный полный
  corpus завершился без ошибок. ADR-0100…0104 уникальны, конфликтных маркеров
  и материалов приватного эталона в tracked tree нет.
- Для provider lifecycle: базовый code commit `845a80f`, release builder
  `b6509a2`, fixes `848192d`/`d3aafaa`/`bdba3c6`. Sidecars — 145 passed / 39
  platform skips, Ruff clean, `git diff --check` успешен. Disposable Ubuntu
  24.04/systemd 255 corpus прошёл настоящий encrypted credential delivery,
  exact runtime identity, non-root worker, streaming 3 frames / 140014 bytes,
  cancel→`ambiguous`, A/B upgrade, rollback с повторным успешным запросом,
  revoke, удаление ciphertext и `PROVIDER_UNCONFIGURED` до network attempt.
  Проверка tracked и новых файлов не нашла материалов приватного эталона. Не
  закрыт только fr1 provider smoke с операторским material.
- Для exact opt-in Docker startup recovery barrier: targeted
  ledger/adapter/policy/manager/supervisor/CLI doctor 101/101; Core
  onboarding/doctor 93/93; полный Core — 2333 passed / 1 skipped, полный App —
  2400 passed / 18
  contract-defined skipped; Core/App typecheck и build зелёные. Канонический
  Vitest pool теперь действительно использует предусмотренные 1–4 forks: два
  последовательных forks-прогона завершились без worker RPC errors, включая
  10 000-operation coordinator fixture и все real-process корпуса.
- На объединённом PR tree `47e100d`: targeted autonomy/HookGate 54/54,
  Telegram settings 29/29 и bot turn isolation 5/5; полный regression вне
  socket sandbox — Core 2327 passed / 1 skipped, Telegram 191/191, App 2405
  passed / 1 skipped; Python Ruff green и 112 passed / 35 platform skips.
  Workspace typecheck/build и `git diff --check` успешны.
- Для branch-only supervised importer: production replay, registry retirement,
  Telegram checkpoint adoption и startup handoff проходят targeted 66/66;
  отдельный real-process corpus 5/5 аварийно завершает runtime после
  `prepared`, фактического provider response, `settled`, verifier и terminal.
  В первых двух точках получается стабильная ambiguity без повторного вызова,
  в последних трёх — terminal replay; суммарно provider вызывается ровно один
  раз. Дополнительные actor/coordinator/Telegram тесты доказывают bounded
  callback, exact spans и crash-after-claim. Дополнительный общий real-process
  corpus 9/9 закрывает card delivery, callback, claim, applied resolution и
  четыре stop/cancellation окна. Полный локальный release-gate: App 2328 passed /
  18 skipped вне sandbox, Core 2276 passed / 1 skipped, Telegram 185 passed;
  workspace typecheck/build и `git diff --check` успешны на branch snapshot.
  После реального merge `d6d3982` тот же corpus повторён: App 2335 passed /
  18 skipped, Core 2293 / 1, Telegram 187; typecheck/build зелёные. Deploy всё
  ещё требует попадания commit в `master` и целевой приёмки.
- Для Telegram-каталога Agent Cards: targeted security/privacy corpus — Core
  43/43, App 62/62, Telegram 33/33, Python confinement 38 passed / 1 skipped и
  Ruff clean. Полный regression — Core 2257 passed / 1 skipped, App вне sandbox
  последовательно 2159 passed / 1 skipped, Telegram 185 passed, Python 57 passed /
  1 skipped. Workspace typecheck/build, `git diff --check` и локальный frontend
  review/release gate успешны. Registry selection gate и monitoring на целевом
  хосте не включались; restart/rollback E2E там не выполнялся.
- На merge `71a91dc`: combined App corpus 98/98, полный Core 2237 passed /
  1 skipped, Telegram 175/175, workspace `typecheck` и `build` успешны. Полный
  App corpus вне sandbox дал 2053 passed / 17 skipped и два resource-contention
  сбоя; оба exact real-process файла затем прошли изолированно 35/35 без
  изменений кода или skip.
- Для opt-in AgentCard lifecycle: targeted Core 31/31, App 53/53 и Telegram
  26/26. После merge `0811fbf` combined AgentCard+pinned-egress App gate прошёл
  173/173; полный regression: Core 2245 passed / 1 skipped, App вне sandbox и
  последовательно 2116 passed / 17 skipped, Telegram 178/178; всего 4539 passed /
  18 skipped. Workspace `typecheck`/`build`, `git diff --check`, privacy scan и
  локальные frontend review/release gate успешны; registry и monitoring gates
  на хосте не включались.
- На объединённом `659a3e8` `pnpm -r typecheck` и `pnpm -r build` — успешно.
- Совмещённый targeted gate: Core MCP 30 passed, App MCP+Docker 243 passed,
  Telegram gateway 166 passed.
- Полный объединённый TypeScript regression на `659a3e8` вне песочницы Codex:
  Core 2152 passed / 1 skipped, App 1717 passed / 1 skipped, Telegram gateway
  166 passed; всего 4035 passed / 2 skipped, ошибок нет.
- Первый sandbox-прогон полного корпуса дал только ожидаемые `EPERM` на
  loopback/Unix sockets и запрет проверки process group; повтор всего корпуса
  с системными возможностями прошёл без ошибок.
- Проверка tracked paths и содержимого не нашла материалов приватного эталона;
  неизвестные корневые каталоги остаются ignored по умолчанию.
- Для narrow `web_search` egress: targeted 55 passed, workspace typecheck/build
  успешны; полный regression вне песочницы — Core 2152 passed / 1 skipped, App
  1747 passed / 17 skipped, Telegram gateway 166 passed; всего 4065 passed /
  18 skipped, ошибок нет.
- Для live Codex subscription: targeted 86 passed, workspace typecheck/build
  успешны; полный regression вне песочницы — Core 2163 passed / 1 skipped, App
  1760 passed / 17 skipped, Telegram gateway 166 passed; всего 4089 passed /
  18 skipped, ошибок нет. Сквозной app-server→loopback MCP→Aisy tool тест не
  использует внешнюю сеть или реальный аккаунт.
- Для `bash bypass`: targeted 86 passed, workspace typecheck/build успешны;
  полный regression вне песочницы — Core 2167 passed / 1 skipped, App 1766
  passed / 18 skipped, Telegram gateway 167 passed; всего 4100 passed /
  19 skipped, ошибок нет.
- Для dormant Docker parent recovery manager: targeted manager/supervisor/
  recovery/IPC 205 passed; workspace typecheck/build успешны; повторный полный
  App regression вне песочницы — 1778 passed / 18 skipped. Первый полный прогон
  дал один timing timeout старого orphan-child fixture; isolated case, весь
  real-process файл 10/10 и повторный полный regression прошли без ошибок.
- Для dormant Plan Mode backend: targeted 19 passed; workspace typecheck/build
  успешны; финальный полный App regression с разрешёнными Unix/loopback sockets
  — 1797 passed / 18 skipped. Первый sandbox-прогон дал только ожидаемые socket
  `EPERM`; тот же corpus без sandbox-ограничения прошёл без ошибок.
- Для dormant provider-neutral Plan Mode protocol: protocol/state/Claude/Codex
  targeted 42 passed, полный Core — 2169 passed / 1 skipped, полный App — 1808
  passed / 18 skipped; workspace typecheck/build и `git diff --check` успешны.
  Sandbox-прогон subscription-тестов дал только ожидаемый запрет локального
  loopback listener; тот же exact corpus вне sandbox прошёл 42/42.
- Для LIVE composition Plan Mode: Core/App targeted 155 passed; сквозной тест
  подтверждает `research → показать план → submit_plan → approval → execute →
  verify` без ручного переключения режима. Полный regression вне песочницы:
  Core 2172 passed / 1 skipped, App 1812 passed / 17 skipped, Telegram gateway
  167 passed; всего 4151 passed / 18 skipped. Workspace typecheck/build и
  `git diff --check` успешны. Internal `submit_plan` доступен только
  интерактивным main/goal loops; compaction, nightly и sub-agent loops его не
  получают.
- Для code-derived similar grants: Core/App/Telegram targeted 228 passed;
  полный regression — Core 2182 passed / 1 skipped, App 1814 passed / 17
  skipped, Telegram gateway 169 passed; всего 4165 passed / 18 skipped.
  Workspace typecheck/build и `git diff --check` успешны. Restart,
  cross-project, changed-resource/operation, policy revision, forged scope,
  Proxy/accessor, persistence failure, complex Bash и Tier-3 negative cases
  проверены; schema-v3 state не содержит raw path/content/operands. Первый
  финальный App-прогон дал единичный timing-сбой старого orphan-child fixture;
  весь real-process файл 10/10 и повторный полный corpus прошли без ошибок.
- Ранний dormant durable-resume срез ранее доказал narrow authority propagation,
  exact group recovery и canonical USD-nanos accounting. Его старое описание
  «выключенный provider/tool adapter» больше не актуально: importer и реальные
  ports, approval actor и startup exact-span envelope подключены в текущей
  ветке; durable `/stop` и общий process corpus теперь также подключены. Это
  доказательство code-ready ветки, но не заменяет полный regression и целевую
  supervised приёмку.

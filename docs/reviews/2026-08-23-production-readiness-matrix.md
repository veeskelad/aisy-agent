# Матрица production-готовности Aisy

**Дата среза:** 2026-08-24
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

**Current verified code head:** `a74419ca917254e6468dd6f64b07f89d762c6199`

**Production runtime release из public `master`:**
`a74419ca917254e6468dd6f64b07f89d762c6199`

**Managed production current:** `a74419ca917254e6468dd6f64b07f89d762c6199`
**Managed production previous:** `df6e837289008e53c9e716669e415a88f0cb637c`

**Назначение:** отделить production composition от target acceptance и не
выдавать dormant-код или исторические тесты за пользовательский LIVE.

## Статусы

- **LIVE** — production binary создаёт путь, и он доступен оператору при
  выполнении явно названных prerequisites.
- **DORMANT** — production-код и тесты существуют, но live composition не даёт
  оператору эту возможность.
- **ОТСУТСТВУЕТ** — полного production seam нет.
- **ОТЛОЖЕНО ADR** — отсутствие принято как архитектурная граница.

Target acceptance указывается отдельно: `LIVE в коде` не означает, что внешний
provider, Telegram flow или новый distribution channel уже принят на целевом
host.

## Метод независимого gap-аудита

Локальный приватный эталон использован только как read-only источник категорий
пользовательских возможностей. В эту матрицу не перенесены его тексты, имена,
пути, схемы, код или артефакты. Каждая строка сформулирована независимо и
получает статус только по Aisy: production importer, code-owned контракт,
детерминированный тест и, где нужен внешний мир, target trace.

Аудит охватил диалог и Telegram UX, voice/media, память и забывание,
Projects/Sessions/files, tools/Skills/MCP, providers, делегирование, фоновые
задачи и мониторинг, restart/rollback, доступ к серверу и дополнительные
operator surfaces. Единственный новый разрыв, который нарушал уже принятое
требование Aisy, — потеря typed mutation receipt в общем Plan protocol. Остальные
не-LIVE строки ниже либо уже имеют явный target gate, либо являются dormant,
отсутствующим новым продуктовым срезом или отложенной ADR-границей; их нельзя
активировать попутным wiring без отдельного решения.

## Доказательная матрица

| Область | Verdict | Текущее доказательство | Оставшийся gate |
|---|---|---|---|
| Telegram text, streaming, attachments и forwarded batches | **LIVE** | `makeTelegramBot`, streaming checkpoints, durable media inbox и batching создаются в `packages/app/src/bin/aisy.ts`; restart/media/stream suites входят в App corpus | Один operator round-trip после managed cutover |
| Workspace, Projects, Sessions и files | **LIVE** | Registry v2, ProjectService, session lease, scoped files и Telegram lifecycle controls находятся в production composition | Project create/switch/resume и restart E2E на целевом host |
| Transcript v2 и compaction | **LIVE в коде** | Single-writer lease, WAL/restart, reply checkpoint, durable media inbox и compaction подключены; failure деградирует до bounded truncation | Target-FS self-test и long-session Telegram acceptance; day-log/activity pipeline DORMANT |
| Keyword/scoped memory и forgetting | **LIVE** | Protected global/Project stores и `makeScopedMemoryLiveView` — единственный live path; nightly проходит shared forget filter | Restart, recall, correction и human-confirmed forget E2E |
| Semantic memory | **LIVE при explicit descriptor + consent** | sqlite-vec/OpenRouter adapter и durable semantic-egress consent подключены; без них честный keyword-only fallback | Реальный embedding call, restart и revoke consent |
| Tools и exact-domain HTTPS | **LIVE с принятым host risk** | Shared capability executor, files/memory/knowledge/tasks/journal, `web_search` и redirect-safe `fetch_url`; Tier-3 и HARD_DENY остаются code-owned | Target approval/Plan Mode E2E; unrestricted `bash` только в explicit bypass |
| Active Skills | **LIVE для use/install/remove** | Hash-pinned catalog, prompt menu/body-on-trigger, AgentCard filtering, CLI и Telegram controls подключены | Установка, trigger и disable/reload на целевом host |
| Skill promotion runtime | **DORMANT** | Promotion/store/doctor modules и tests существуют отдельно от production composition | Verification probes и human promotion composition |
| Nightly Skill drafting | **ОТСУТСТВУЕТ** | Nightly loop не имеет реального `draftSkills` seam | Generator output, staged artifact и negative one-off-failure corpus |
| stdio MCP | **LIVE** | Startup connect gauntlet, human-owned allowlist/policy, bounded menu, `call_mcp` через HookGate и Telegram controls подключены | Один реальный target stdio connect/call/remove E2E |
| Streamable HTTP MCP | **DORMANT** | Transport policy и wire foundation существуют, но live binding выключен | Отдельное security/authority решение и acceptance |
| Native API providers | **LIVE под supervisor** | Семь fixed descriptors, root-owned broker, validator/worker sockets, host-encrypted A/B slots и rollback развёрнуты; arbitrary URL не принимается | TTY enrollment, bounded vendor call, switch, restart и revoke real slot |
| Claude/Codex subscription brains | **LIVE на target; receipt fix развёрнут** | Per-turn loopback Aisy MCP bridge, isolated homes и exact turn binding реализованы; production trace `13:09:55Z–13:10:23Z` доказал успешную delegation evidence, но прежний Plan protocol отбросил `verified:true` уже выполненного `remember`. Release `a74419c` сохраняет только literal code-owned receipt, fail-closed отклоняет truthy/extra/accessor/Proxy/symbol terminal и развёрнут через managed update | Повторный составной Telegram turn без recovery/unverified |
| Voice provider registry / Deepgram proxy | **LIVE framework; text-only по умолчанию; structural target gate принят** | Telegram voice ingress, общий `Transcriber` для local/model-native/cloud adapter, one-use media capability, root-owned Deepgram broker/worker, consent/spend boundary и A/B rollback реализованы; target Doctor подтверждает artifact/backend/proxy/outbox, stale/unsafe choice изолирован с zero egress | Optional Deepgram acceptance отдельно: TTY enrollment, consent, Telegram voice, bounded vendor call и revoke; отсутствие подключения не блокирует harness cutover |
| Subagents | **LIVE; durable supervised path deployed** | AgentCard-scoped runner, receipts, Journal v2, retry/cancel actor, startup replay, durable `/stop` и terminal delivery подключены; tool contract прямо требует реальный `spawn_subagent` и запрещает role-play результата | Повторить ordinary delegation через Telegram после `a74419c`, затем отдельно ambiguity и `/stop` |
| Monitoring и digest | **LIVE для RSS/Web** | Source UI, DNS/IP-pinned GET-only collector, no-tools scorer, durable windows и at-most-once Telegram send ledger подключены | RSS→Telegram restart/rollback E2E и egress pentest |
| Monitoring source authority | **LIVE** | Добавление source сохраняет read-only grant только на exact HTTPS domain; pause его сохраняет, confirmed remove отзывает | Target add/pause/remove audit без raw URL или content в approval state |
| Telegram/YouTube/GitHub monitoring collectors и feedback learning | **DORMANT / ОТСУТСТВУЕТ по подтипу** | Core collector/ranking pieces существуют не для всех platform flows | Отдельные normalized collectors, UI и deterministic cursor/feedback corpus |
| Onboarding, профиль и персонализация | **LIVE** | First-contact, resumable onboarding progress, operator profile projection и frozen-prefix brief создаются production composition | Завершить один target onboarding/перезапуск без потери прогресса |
| Напоминания, расписания и цели | **LIVE** | Trigger store/engine, scheduler, goal store/orchestrator, approval и restart resume подключены в `bin/aisy.ts` | Target reminder + scheduled goal + restart trace |
| Ограниченный доступ к серверу | **LIVE при explicit config + approval** | `makeServerAccess` импортирован production binary; argv выполняется без shell, restart требует held supervisor authority, временный доступ истекает scheduler-ом | Target open/expire/restart audit для operator-owned config |
| Image/video understanding и преобразования | **ОТСУТСТВУЕТ** | Durable attachment/media inbox принимает и изолирует bytes, voice имеет отдельный transcriber; production vision/video processor или transformation tool отсутствует | Новый продуктовый срез, egress/privacy ADR и детерминированный media corpus; не является скрытым release gate v0.1 |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE для managed release** | Target unit использует managed `active/current`; explicit restart и цикл `a74419c→df6e837→a74419c` завершены, оба Doctor `ok=true`, финальный service active и `NRestarts=0` | Повторять тот же gate для каждого следующего release |
| Managed Git install/update/rollback | **LIVE: target cutover принят** | fr1 current=`a74419c`, previous=`df6e837`; staged Doctor, offline rollback и roll-forward зелёные, release worktree clean | Operator-level Telegram E2E для `a74419c` и следующий release cycle |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Новый PUBLIC repository содержит только root `2de457f` и `master`: source/root tree exact, strict fsck clean, private-reference markers 0, Gitleaks 0; прежняя история переименована и подтверждена PRIVATE | После финального status commit повторить refs/tree/history scan; archive не менять на public |

## Проверки текущего среза

- Release `a74419c` на Node **22.23.2**: Core **2364 passed / 1 skipped**,
  Telegram Gateway **255 passed**, App **2542 passed / 19 platform-or-optional
  skipped**. Пять real-process timeouts общего параллельного App run повторены
  тем же corpus по одному и прошли без увеличения timeout или новых skip;
- release прошёл workspace typecheck/build; Python **3.12.9** sidecars —
  **215 passed / 39 platform-or-optional skipped**, Ruff green;
- Node 22 full corpus для `df6e837`: Core **2364 passed / 1 skipped**, App
  **2557 passed / 2 skipped**, Telegram Gateway **255 passed** на том же
  неизменённом package;
- Python sidecars: **215 passed / 39 platform-or-optional skipped**, Ruff green;
- workspace typecheck и build для Core/App/Telegram — green;
- `git diff --check`, strict fsck, Gitleaks по всей public history и release
  diff — green; tracked tree, history pickaxe и object names дают
  private-reference markers **0**;
- fr1 managed update `901dc9a→7a73bc0`, controlled source→managed cutover и
  explicit restart завершены; full Doctor `ok=true`, service active,
  `NRestarts=0`;
- fr1 offline rollback/roll-forward `7a73bc0→901dc9a→7a73bc0` сохранил
  runtime state и unit; known-old Doctor воспроизвёл прежний voice HIGH_FAIL,
  финальный current Doctor вернулся к `ok=true` без key/consent;
- fr1 managed release `df6e837` прошёл staged Doctor, explicit restart и
  offline цикл `df6e837→7a73bc0→df6e837`; оба full Doctor дали `ok=true`
  (18 pass, 7 optional warn), финальный service active, `NRestarts=0`;
- managed update `df6e837→a74419c`, explicit restart и offline цикл
  `a74419c→df6e837→a74419c` завершены; оба release дали Doctor `ok=true`
  (18 pass, 7 optional warn, 0 fail), финальный service active,
  `NRestarts=0`, current release worktree clean;
- составной Telegram ход на `df6e837` создал настоящий terminal subagent result
  и durable memory write. Обезличенный session log независимо зафиксировал
  `delegate-required + requiresMutation`, затем только `missing:mutation` и
  `actionStatus:unverified`: общий Plan protocol признал terminal
  `{ok,output,verified:true}` невалидным уже после side effect. Regression на
  public `master` воспроизвёл `PLAN_EXECUTOR_RESULT_INVALID`; release `a74419c` сохраняет
  literal receipt, а truthy/extra/accessor/Proxy/symbol варианты отклоняет;
- current public history — одна ветка `master` без тегов/старых refs;
- публичный one-line bootstrap на disposable Ubuntu: Node **22.23.2**, exact
  origin, frozen install/build, private managed layout и active generation
  `2de457f` — green;
- цикл `2de457f → 547f7b3 → 2de457f → 547f7b3` — green; fail-closed
  staged doctor сохранил A при неинициализированном state, после штатного
  fixture-init update/rollback/roll-forward завершились без duplicate cutover;
- исправление `a88919e` прошло Core **2354 passed / 1 skipped**, App
  distribution/doctor **57 passed / 1 skipped**, workspace typecheck/build;
  цикл `a88919e → 343ae2f → a88919e → 343ae2f` — green, rollback trace
  содержит zero AF_INET socket/connect.

## Несмерженные ветки и commits

- актуальная public-линия начинается с clean snapshot и имеет один development
  head `master`; release `a74419c` основан на последнем fetched public head, без
  merge-base с локальной архивной линией, поэтому cherry-pick из архива запрещён;
- локальные feature-ветки до переписывания public history проверены через
  patch-equivalence и текущие production imports/tests: их содержательные
  изменения уже присутствуют в public `master` в переписанном или усиленном
  виде; отдельного отсутствующего feature commit не найдено;
- локальная gap-audit ветка содержит только устаревший review-срез, а durable
  delegation ветка — три старых commits с эквивалентами в текущей линии;
  прямой merge/cherry-pick вернул бы закрытые промежуточные состояния;
- legacy publication head относится к отменённому APT-каналу и намеренно не
  мержится после ADR-0106. Перед публикацией `a74419c` remote `master` повторно
  fetched, подтверждён fast-forward `0/1`, а после push exact remote head
  независимо прочитан как `a74419ca917254e6468dd6f64b07f89d762c6199`.

## Release gate

Production-ready verdict требует все пункты одновременно:

1. clean public repository и raw installer доступны без credential;
2. disposable Linux проходит bootstrap A → update B → offline rollback A → B;
3. target host сохраняет старый checkout и переходит на managed binary;
4. Telegram text, Project/session, memory, Skill, stdio MCP и subagent E2E дают
   один terminal result без duplicate effect;
5. provider slots проверяются после их operator TTY enrollment; optional voice
   без key/consent остаётся text-only warning и не блокирует cutover, а его
   внешний E2E выполняется отдельно после явного подключения;
6. restart/rollback сохраняют runtime state и root-owned previous releases;
7. final public refs/tree/history проходят secret и private-reference scans.

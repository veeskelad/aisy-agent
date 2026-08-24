# Матрица production-готовности Aisy

**Дата среза:** 2026-08-24
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

**Current verified code head:** `df6e837289008e53c9e716669e415a88f0cb637c`

**Managed production current:** `df6e837289008e53c9e716669e415a88f0cb637c`
**Managed production previous:** `7a73bc0fa9751c67d2d383b2a00daa02288f8c3b`

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
| Claude/Codex subscription brains | **LIVE на target; повторный acceptance ожидается** | Per-turn loopback Aisy MCP bridge, isolated homes и exact turn binding реализованы; `df6e837` переносит валидированный terminal result во внешний ActionContract через non-serializable exact-turn evidence, не доверяя progress/prose | Повторить составной Telegram tool-call после `df6e837` и подтвердить code-owned receipts |
| Voice provider registry / Deepgram proxy | **LIVE framework; text-only по умолчанию; structural target gate принят** | Telegram voice ingress, общий `Transcriber` для local/model-native/cloud adapter, one-use media capability, root-owned Deepgram broker/worker, consent/spend boundary и A/B rollback реализованы; target Doctor подтверждает artifact/backend/proxy/outbox, stale/unsafe choice изолирован с zero egress | Optional Deepgram acceptance отдельно: TTY enrollment, consent, Telegram voice, bounded vendor call и revoke; отсутствие подключения не блокирует harness cutover |
| Subagents | **LIVE; durable supervised path deployed** | AgentCard-scoped runner, receipts, Journal v2, retry/cancel actor, startup replay, durable `/stop` и terminal delivery подключены; tool contract теперь прямо требует реальный `spawn_subagent` и запрещает role-play результата | Повторить ordinary delegation через Telegram после `df6e837`, затем отдельно ambiguity и `/stop` |
| Monitoring и digest | **LIVE для RSS/Web** | Source UI, DNS/IP-pinned GET-only collector, no-tools scorer, durable windows и at-most-once Telegram send ledger подключены | RSS→Telegram restart/rollback E2E и egress pentest |
| Monitoring source authority | **LIVE** | Добавление source сохраняет read-only grant только на exact HTTPS domain; pause его сохраняет, confirmed remove отзывает | Target add/pause/remove audit без raw URL или content в approval state |
| Telegram/YouTube/GitHub monitoring collectors и feedback learning | **DORMANT / ОТСУТСТВУЕТ по подтипу** | Core collector/ranking pieces существуют не для всех platform flows | Отдельные normalized collectors, UI и deterministic cursor/feedback corpus |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE для managed release** | Target unit использует managed `active/current`; explicit restart и цикл `df6e837→7a73bc0→df6e837` завершены, оба Doctor `ok=true`, финальный service active и `NRestarts=0` | Повторять тот же gate для каждого следующего release |
| Managed Git install/update/rollback | **LIVE: target cutover принят** | fr1 current=`df6e837`, previous=`7a73bc0`; staged Doctor, offline rollback и roll-forward зелёные, runtime state не откатывался | Operator-level Telegram E2E для `df6e837` и следующий release cycle |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Новый PUBLIC repository содержит только root `2de457f` и `master`: source/root tree exact, strict fsck clean, private-reference markers 0, Gitleaks 0; прежняя история переименована и подтверждена PRIVATE | После финального status commit повторить refs/tree/history scan; archive не менять на public |

## Проверки текущего среза

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
- исходный составной Telegram ход до исправления доказал durable memory write,
  но не создал delegation phase: модель дважды написала `323` без вызова
  `spawn_subagent`, а общий verifier правильно вернул unverified. Повтор того же
  operator E2E после `df6e837` остаётся открытым gate;
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

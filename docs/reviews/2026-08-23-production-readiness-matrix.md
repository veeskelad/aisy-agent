# Матрица production-готовности Aisy

**Дата среза:** 2026-08-23  
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

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
| Claude/Codex subscription brains | **LIVE в коде** | Per-turn loopback Aisy MCP bridge, isolated homes и exact turn binding реализованы | Установить/authenticate pinned CLI и пройти Telegram tool-call |
| Voice / Deepgram proxy | **LIVE под supervisor** | Telegram voice ingress, one-use media capability, root-owned broker/worker, consent/spend boundary и A/B rollback реализованы | TTY enrollment, consent, Telegram voice, bounded vendor call и revoke |
| Subagents | **LIVE; durable supervised path deployed** | AgentCard-scoped runner, receipts, Journal v2, retry/cancel actor, startup replay, durable `/stop` и terminal delivery подключены | Ordinary delegation, ambiguity и `/stop` через Telegram после cutover |
| Monitoring и digest | **LIVE для RSS/Web** | Source UI, DNS/IP-pinned GET-only collector, no-tools scorer, durable windows и at-most-once Telegram send ledger подключены | RSS→Telegram restart/rollback E2E и egress pentest |
| Monitoring source authority | **LIVE** | Добавление source сохраняет read-only grant только на exact HTTPS domain; pause его сохраняет, confirmed remove отзывает | Target add/pause/remove audit без raw URL или content в approval state |
| Telegram/YouTube/GitHub monitoring collectors и feedback learning | **DORMANT / ОТСУТСТВУЕТ по подтипу** | Core collector/ranking pieces существуют не для всех platform flows | Отдельные normalized collectors, UI и deterministic cursor/feedback corpus |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE для текущего source release** | Target service active на проверенном source checkout; provider/voice A/B rollback и controlled restart пройдены | Повторить после managed Git cutover |
| Managed Git install/update/rollback | **LIVE: public bootstrap принят** | Public raw bootstrap из clean root `2de457f` прошёл на disposable Ubuntu с Node 22: exact HTTPS origin, frozen install/build, private `0700` layout и active generation подтверждены | A→B→A→B и target cutover |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Новый PUBLIC repository содержит только root `2de457f` и `master`: source/root tree exact, strict fsck clean, private-reference markers 0, Gitleaks 0; прежняя история переименована и подтверждена PRIVATE | После финального status commit повторить refs/tree/history scan; archive не менять на public |

## Проверки текущего среза

- `@aisy/app` targeted LIVE/distribution/restart corpus: **125 passed, 1 skipped**;
- Python bundle/provider/voice targeted corpus: **64 passed**;
- полный pre-merge corpus component 28 выполнен на macOS и disposable Ubuntu;
- workspace typecheck/build и Python Ruff — green в release evidence PR #18;
- target service до cutover: active, stable parent PID, `NRestarts=0`, clean
  source checkout; managed install пока отсутствует;
- current tracked tree: private-reference markers **0**, legacy APT/GPG delivery
  surface **0**;
- public root: один commit и одна ветка `master`, tree exact,
  `git fsck --strict` clean, Gitleaks **0**;
- публичный one-line bootstrap на disposable Ubuntu: Node **22.23.2**, exact
  origin, frozen install/build, private managed layout и active generation
  `2de457f` — green.

## Release gate

Production-ready verdict требует все пункты одновременно:

1. clean public repository и raw installer доступны без credential;
2. disposable Linux проходит bootstrap A → update B → offline rollback A → B;
3. target host сохраняет старый checkout и переходит на managed binary;
4. Telegram text, Project/session, memory, Skill, stdio MCP и subagent E2E дают
   один terminal result без duplicate effect;
5. provider/voice проверяются только после operator TTY enrollment и consent;
6. restart/rollback сохраняют runtime state и root-owned previous releases;
7. final public refs/tree/history проходят secret и private-reference scans.

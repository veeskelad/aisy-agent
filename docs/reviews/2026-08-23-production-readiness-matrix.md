# Матрица production-готовности Aisy

**Дата среза:** 2026-08-27
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

**Current verified code head:** `1df48515b55cd2d9dff2e8046ad18179ad30573e`

**Production runtime release из public `master`:**
`1df48515b55cd2d9dff2e8046ad18179ad30573e`

**Managed production current:** `1df48515b55cd2d9dff2e8046ad18179ad30573e`
**Managed production previous:** `2a98797fffbec630f81d8897874d437f35ec0c27`

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
operator surfaces. Реальными независимыми разрывами оказались потеря typed
mutation receipt в общем Plan protocol и отсутствие LIVE-композиции уже
утверждённого typed auto-skill canary. Управляемый rollback-drill дополнительно
выявил два независимых операционных разрыва: roll-forward к retained descendant
после rollback и отсутствие code-owned выхода из restart-budget quarantine.
Они закрыты commits `bd1f635` и `558a4ce` через уточнение ADR-0071/0108,
русские acceptance criteria и fault-тесты. Release `1df4851` отдельно закрыл
независимый диалоговый разрыв: краткое «Покажи» после code-owned утреннего
уведомления больше не превращается в action verification, а служебные action
spans и промежуточные provider attempts не попадают в следующий модельный
контекст. Остальные
не-LIVE строки ниже либо уже имеют явный target gate, либо являются dormant,
отсутствующим новым продуктовым срезом или отложенной ADR-границей; их нельзя
активировать попутным wiring без отдельного решения.

## Доказательная матрица

| Область | Verdict | Текущее доказательство | Оставшийся gate |
|---|---|---|---|
| Telegram text, streaming, attachments и forwarded batches | **LIVE** | `makeTelegramBot`, streaming checkpoints, durable media inbox и batching создаются в `packages/app/src/bin/aisy.ts`. Release `1df4851` добавляет одноразовый code-owned переход из точного утреннего уведомления в staging-card: краткое «Покажи» не запускает provider/action loop, а конкретное «Покажи файл» сохраняет inspect-path | После следующего утреннего уведомления от нового процесса подтвердить живой shortcut; старое уведомление до restart доказательством не считается |
| Workspace, Projects, Sessions и files | **LIVE** | Registry v2, ProjectService, session lease, scoped files и Telegram lifecycle controls находятся в production composition | Project create/switch/resume и restart E2E на целевом host |
| Transcript v2 и compaction | **LIVE в коде** | Single-writer lease, WAL/restart, reply checkpoint, durable media inbox и compaction подключены; raw audit остаётся неизменным. Provider-facing projection удаляет code-owned recovery/action spans и промежуточные model attempts, сохраняя user ingress, значимые tool spans и terminal reply | Target-FS self-test и long-session Telegram acceptance; day-log/activity pipeline DORMANT |
| Keyword/scoped memory и forgetting | **LIVE** | Protected global/Project stores и `makeScopedMemoryLiveView` — единственный live path; nightly проходит shared forget filter. Release `2a98797` закрепляет ровно одно code-owned естественное подтверждение typed receipt и удаляет model-owned пустые/дублирующие статусы памяти | Composite receipt, restart, recall, correction и human-confirmed forget E2E |
| Semantic memory | **LIVE при explicit descriptor + consent** | sqlite-vec/OpenRouter adapter и durable semantic-egress consent подключены; без них честный keyword-only fallback | Реальный embedding call, restart и revoke consent |
| Tools и exact-domain HTTPS | **LIVE с принятым host risk** | Shared capability executor, files/memory/knowledge/tasks/journal, `web_search` и redirect-safe `fetch_url`; Tier-3 и HARD_DENY остаются code-owned | Target approval/Plan Mode E2E; unrestricted `bash` только в explicit bypass |
| Active Skills | **LIVE для use/install/remove** | Hash-pinned catalog, prompt menu/body-on-trigger, AgentCard filtering, CLI и Telegram controls подключены | Установка, trigger и disable/reload на целевом host |
| Typed auto-skills | **LIVE на target при explicit canary; behavioural acceptance не завершён** | Target `2a98797`: `AISY_AUTO_SKILLS=1`, generator `claude-subscription/sonnet`, отдельный judge `claude-subscription/opus`; Doctor загружает private v2 state и даёт `pass`, `active=0`, очереди и quarantine пусты. Два supervised delivery-confirmed terminal success разных sessions проходят typed receipt seam; exact memory recipe имеет code-owned planner; call/session/turn/global ordinal mismatch, failed provider attempt/failover и turn-wide effect-stream fail-closed; scoped overlay, canary-on/off restart recovery, source-confirmed forgetting, poisoned stale store, marker-v2 exact-temporary cleanup только при global quiescence, read-only Doctor, persistent rollback barrier и explicit v2 roll-forward resume покрыты deterministic tests | Нужны два реальных чистых `memory.remember` turn в разных выделенных Telegram sessions, activation/planner smoke и точная cleanup-проверка; составной turn намеренно не считается evidence |
| Skill promotion runtime | **DORMANT** | Promotion/store/doctor modules и tests существуют отдельно от production composition | Verification probes и human promotion composition |
| Nightly Skill drafting | **ОТСУТСТВУЕТ** | Nightly loop не имеет реального `draftSkills` seam | Generator output, staged artifact и negative one-off-failure corpus |
| stdio MCP | **LIVE** | Startup connect gauntlet, human-owned allowlist/policy, bounded menu, `call_mcp` через HookGate и Telegram controls подключены | Один реальный target stdio connect/call/remove E2E |
| Streamable HTTP MCP | **DORMANT** | Transport policy и wire foundation существуют, но live binding выключен | Отдельное security/authority решение и acceptance |
| Native API providers | **LIVE под supervisor** | Семь fixed descriptors, root-owned broker, validator/worker sockets, host-encrypted A/B slots и rollback развёрнуты; arbitrary URL не принимается | TTY enrollment, bounded vendor call, switch, restart и revoke real slot |
| Claude/Codex subscription brains | **LIVE на target; provenance/receipt fix развёрнут** | Per-turn loopback Aisy MCP bridge, isolated homes и exact turn binding реализованы. Releases `2a98797` и `1df4851` сохраняют frozen prefix, сериализуют spans как `AISY_CONTEXT_V1`, не приписывают оператору неподтверждённые ложные предупреждения и фильтруют их до streaming/history, сохраняя реальное untrusted/tool grounding и приватный raw audit | Повторить composite smoke на exact `1df4851` |
| Voice provider registry / Deepgram proxy | **LIVE framework; text-only по умолчанию; structural target gate принят** | Telegram voice ingress, общий `Transcriber` для local/model-native/cloud adapter, one-use media capability, root-owned Deepgram broker/worker, consent/spend boundary и A/B rollback реализованы; target Doctor подтверждает artifact/backend/proxy/outbox, stale/unsafe choice изолирован с zero egress | Optional Deepgram acceptance отдельно: TTY enrollment, consent, Telegram voice, bounded vendor call и revoke; отсутствие подключения не блокирует harness cutover |
| Subagents | **LIVE; durable supervised path deployed** | AgentCard-scoped runner, receipts, Journal v2, retry/cancel actor, startup replay, durable `/stop` и terminal delivery подключены; ordinary delegation через Telegram после `a74419c` вернула проверенный terminal result | Отдельные target ambiguity и `/stop` fault drills |
| Monitoring и digest | **LIVE для RSS/Web** | Source UI, DNS/IP-pinned GET-only collector, no-tools scorer, durable windows и at-most-once Telegram send ledger подключены | RSS→Telegram restart/rollback E2E и egress pentest |
| Monitoring source authority | **LIVE** | Добавление source сохраняет read-only grant только на exact HTTPS domain; pause его сохраняет, confirmed remove отзывает | Target add/pause/remove audit без raw URL или content в approval state |
| Telegram/YouTube/GitHub monitoring collectors и feedback learning | **DORMANT / ОТСУТСТВУЕТ по подтипу** | Core collector/ranking pieces существуют не для всех platform flows | Отдельные normalized collectors, UI и deterministic cursor/feedback corpus |
| Onboarding, профиль и персонализация | **LIVE** | First-contact, resumable onboarding progress, operator profile projection и frozen-prefix brief создаются production composition | Завершить один target onboarding/перезапуск без потери прогресса |
| Напоминания, расписания и цели | **LIVE** | Trigger store/engine, scheduler, goal store/orchestrator, approval и restart resume подключены в `bin/aisy.ts` | Target reminder + scheduled goal + restart trace |
| Ограниченный доступ к серверу | **LIVE при explicit config + approval** | `makeServerAccess` импортирован production binary; argv выполняется без shell, restart требует held supervisor authority, временный доступ истекает scheduler-ом | Target open/expire/restart audit для operator-owned config |
| Image/video understanding и преобразования | **ОТСУТСТВУЕТ** | Durable attachment/media inbox принимает и изолирует bytes, voice имеет отдельный transcriber; production vision/video processor или transformation tool отсутствует | Новый продуктовый срез, egress/privacy ADR и детерминированный media corpus; не является скрытым release gate v0.1 |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE для managed release; destructive drill принят с recovery** | Target unit использует managed `active/current`. Rollback сохранил auto-skill barrier и fail-closed остановил старый writer; deliberate crash loop исчерпал budget. `558a4ce` снял только exact `RESTART_BUDGET_EXHAUSTED` после manager/runtime leases, сохранил authority/receipt и вернул service в `active/running`; Doctor `ok=true`. `NRestarts=235` — исторический след drill, после recovery не растёт | В обычном release gate не требовать `NRestarts=0` после намеренного storm; фиксировать до/после и отсутствие роста |
| Managed Git install/update/rollback | **LIVE: target cutover и исправленный roll-forward приняты** | current=`1df4851`, previous=`2a98797`; managed update прошёл staged build/Doctor, explicit restart дал service `active/running`, `ExecMainStatus=0`, `NRestarts=0`, full Doctor `ok=true`; retained previous остаётся rollback-слотом | Offline rollback/roll-forward текущей пары после очистки behavioral test state |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Публичный remote содержит один ref `master=1df4851`, без tags/других heads; 32 reachable commits прошли Gitleaks с 0 findings, tree/history marker scans дали 0 совпадений. Локальные legacy refs не являются publish authority | После финального status commit повторить public refs/reachable-history/tree scans; локальные legacy refs не push'ить |

## Проверки текущего среза

- exact release `1df4851`: Core **2410 passed / 1 skipped** (139 файлов pass,
  1 штатно skipped), App **2638 passed / 2 skipped** (252 файла pass, 1
  штатно skipped); workspace typecheck/build и `git diff --check` — green.
  Targeted regressions покрывают exact bare/concrete show-intent, single-use
  staging shortcut, empty/stale staging, steering precedence, неизменный raw
  audit, provider projection и фильтрацию ложной атрибуции до streaming/history.
  Три независимых review-round завершены без P0–P2 findings;
- public fast-forward `2a98797→1df4851` опубликован; independent `ls-remote`
  показал ровно один head `master=1df4851` и ноль tags. Gitleaks по 32 reachable
  commits — 0 findings; tracked tree и reachable-history marker scans — 0
  совпадений;
- fr1 managed update `2a98797→1df4851` и explicit restart завершены:
  current=`1df4851`, previous=`2a98797`, full Doctor healthy (**19 pass / 7
  optional warn**), service `active`, `ExecMainStatus=0`, `NRestarts=0`.
  Живой shortcut «Покажи» остаётся отложенным acceptance до нового утреннего
  уведомления от уже обновлённого процесса;
- exact release `2a98797`: Core **2403 passed / 1 skipped** (139 файлов pass,
  1 штатно skipped), App **2634 passed / 2 skipped** (252 файла pass, 1
  штатно skipped); Core/App typecheck и build, `git diff --check` — green.
  Обезличенный production-аудит дефекта зафиксировал `System:` count=0 в
  текущем inbound и 0 в предыдущих 60 spans, но 1 в model reply: предупреждение
  не было ответом на операторский текст. Причиной оказался прежний CLI adapter,
  который сам изготовлял role-labelled plain text из code-owned spans.
  Targeted regressions покрывают provenance JSON-envelope, hostile JSON text,
  source mapping, неподтверждённое и подтверждённое `System:`-предупреждение,
  пустой/дублирующий memory status и сохранение соседнего результата
  делегирования. Независимый review после всех правок — findings отсутствуют;
- public fast-forward `558a4ce→2a98797` опубликован; remote имеет ровно один
  head и ноль tags. Gitleaks по 31 reachable commit — 0 findings; tracked tree,
  reachable history pickaxe и object path inventory — 0 запрещённых маркеров;
- fr1 managed update `558a4ce→2a98797`, staged build/Doctor и explicit restart
  завершены: current=`2a98797`, previous=`558a4ce`, full Doctor `ok=true`
  (**19 pass / 7 optional warn**), service `active/running`,
  `ExecMainStatus=0`, `NRestarts=0`; typed auto-skills `pass`, `active=0`, все
  очереди/quarantine пусты. Composite Telegram и offline rollback/roll-forward
  остаются текущими внешними gates;
- exact production commit `558a4ce`: полный App corpus **2633 passed / 3
  skipped**, targeted supervisor/state/recovery **67/67**, workspace
  Core/Telegram/App typecheck и build green, `git diff --check` green;
  recovery diff прошёл три независимых review-round: code-only exception,
  post-rename ambiguity, сохранение authority/release receipt, real SQLite
  leases и ложная cross-invocation идемпотентность исправлены, финал — findings
  отсутствуют;
- rollback drill начал с `d1e8e3d→f12f06e`, подтвердил fail-closed auto-skill
  barrier и выявил retained-descendant deadlock. `bd1f635` восстановил
  descendant roll-forward без второго downgrade certificate; deliberate
  старый-runtime crash storm оставил durable `RESTART_BUDGET_EXHAUSTED`, после
  чего `558a4ce` под двумя leases опубликовал recovery revision 106. Финальный
  current=`558a4ce`, previous=`bd1f635`, Doctor `ok=true`, service
  `active/running`, исторический `NRestarts=235` стабилен; session log и
  transcript до Telegram smoke сохранили исходные size/mtime;
- public fast-forward `bd1f635→558a4ce` опубликован; independent `ls-remote`
  показал единственный head `master=558a4ce`, tags/других heads нет; точный
  staged diff прошёл Gitleaks и private/personal fixture marker scans с нулём
  совпадений;
- release candidate `111b143`: Core **2399 passed / 1 skipped**; полный App
  corpus дал **2614 passed / 2 skipped** и один 5-секундный timeout под общей
  параллельной нагрузкой, тот же exact файл повторён отдельно — **24/24** без
  изменения timeout или skip; финальный marker/Doctor corpus — **36/36**,
  durable delegation adapter — **35/35**; workspace typecheck/build и
  `git diff --check` green; независимый повторный review — findings отсутствуют;
- public fast-forward `1457bc6→f12f06e` опубликован; independent `ls-remote`
  показал один head `master=f12f06e`, tags/других heads нет;
- fr1 managed update `fdfd477→f12f06e`, explicit restart, canary-on и offline
  цикл `f12f06e→fdfd477→f12f06e` завершены; previous Doctor **18 pass / 7 warn**,
  final Doctor **19 pass / 7 warn**, `ok=true`, typed auto-skills `pass`, service
  active и `NRestarts=0`; roll-forward выполнил explicit `--resume-auto-skills`;
- Telegram Bot API доставил два сообщения в exact allowlisted chat, включая
  smoke-инструкцию (`message_id=4118`), без вывода token/chat_id. Inbound
  operator checkpoint за первое окно ожидания не появился и остаётся отдельным
  честным acceptance gate;
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
- composite Telegram E2E на `a74419c` завершил реальный subagent result и
  durable memory mutation одним terminal ответом без recovery/unverified;
- UX release `fdfd477`: Core **2364 passed / 1 skipped**, App **2559 passed /
  2 skipped**, targeted remember/Project corpus **85 passed**, Core/App
  typecheck/build green; managed update и offline цикл
  `fdfd477→a74419c→fdfd477` завершены, оба Doctor `ok=true` (18 pass,
  7 optional warn, 0 fail), финальный service active и `NRestarts=0`;
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

- публичный remote на момент аудита имеет ровно один head
  `master=1df48515b55cd2d9dff2e8046ad18179ad30573e`, tags и дополнительных heads
  нет; commit опубликован fast-forward от `2a98797`;
- `git branch --no-merged 1df4851` по-прежнему показывает локальные feature- и
  legacy-ветки, потому что clean public snapshot переписал корень истории:
  отсутствие merge-base здесь не означает отсутствующий feature и запрещает
  механический merge/cherry-pick;
- независимый read-only аудит проверил все **35** локальных refs. Старый
  snapshot-tip `e78ca0f` и clean public root `2de457f` имеют exact одинаковый
  tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`: поэтому каждый предок
  `e78ca0f` уже вошёл byte-for-byte, несмотря на разорванную ancestry. Для
  остальных веток найдены tree-identical переписанные commits либо более новые
  superseding implementations с production imports и тестами; paths, которые
  присутствуют в расходящейся code-ветке и отсутствуют в snapshot, — **0**;
- Telegram receipt, typed auto-skill lifecycle, managed distribution, provider
  broker, delegation, monitoring и Docker recovery представлены в `master`
  собственными либо усиленными commits. `unique-candidate`, включая
  security-функции высокого риска, — **0**;
- локальные status/gap-audit heads содержат устаревшие review-срезы, а старые
  durable/distribution heads — промежуточные состояния, закрытые более новыми
  public commits. Их перенос вернул бы уже исправленные safety/recovery gaps;
- локальные legacy refs и unreachable objects не являются publish authority и
  не отправляются ни в какой remote. Отменённый APT publication head отдельно
  исключён ADR-0106: это orphan с устаревшими бинарными артефактами, а не
  отсутствующий source feature. Push выполнялся только как `HEAD:master` в
  публичный remote; независимый аудит не выполнял checkout, merge или
  cherry-pick и не обращался к приватному remote.

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

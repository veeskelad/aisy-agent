# Матрица production-готовности Aisy

**Дата среза:** 2026-08-28
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

**Current verified code head:** `763ed88bd0c46094e32d1ed75e57e5c5070ac677`

**Production runtime release из public `master`:**
`c5db7ae998c8241197f99488e38f8f2d31c87892`

**Managed production current:** `c5db7ae998c8241197f99488e38f8f2d31c87892`
**Managed production previous:** `97b25ef931d21afb34b4232a3070bfb2718dcee6`

**Опубликованный, но ещё не развёрнутый candidate:**
`763ed88bd0c46094e32d1ed75e57e5c5070ac677`

**Развёрнутый adaptive-agent slice:** commits `0843142..c5db7ae`;
managed update, rollback, roll-forward и recovery restart-budget выполнены на
целевом host. Остаточные внешние E2E не выданы ниже за уже принятые.

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
контекст. Срез 2026-08-28 дополнительно выявил и закрыл независимые разрывы:
неоднозначное nightly-уведомление при нулевых правках, отсутствие ежедневной
Session rotation и `/resume`, ежедневный model-backed consolidation вместо
воскресного, неестественный memory acknowledgement, повтор Tier-2 карточки
после уже данного разрешения и отсутствие typed overlay для явных поправок
стиля и grammatical gender. Первый live-ход после активации typed preference
выявил старый transcript-контракт, который отвергал turn-local provenance
`learned-procedure` до provider call. Release `c3268de` оставляет актуальный
typed overlay в provider request, но не дублирует его в dialog transcript:
старые revisions не накапливаются в history, persisted enum не расширяется и
rollback-бинарник продолжает читать журнал. Release `d9a21ab` скрыл
runtime exception/schema/timing/workspace из Telegram failure card, а `6d50eb9`
устранил выход parent supervisor во время его собственного restart
backoff. Controlled target SIGKILL создал один replacement child при
неизменном parent и `NRestarts=0`. Release `97b25ef` подключил к
code-owned nightly notices тот же typed grammatical-gender, что и к
provider overlay; при активном `masculine-russian` утренний текст
больше не говорит от женского лица. Live наблюдение явного deploy restart
выявило ещё один UX-разрыв: terminal `interrupted` показывал таймер и
«общую папку». Release `c5db7ae` оставил в ordinary Telegram только просьбу
повторить сообщение, но живой обычный ход выявил более глубокий P0: после
предыдущей ошибки оставалась non-ambiguous active parent continuation, поэтому
каждый fresh update завершал child до provider и снова запускал recovery.
Candidate `763ed88` CAS-закрывает только доказанную orphan-запись, завершает
обычный failed turn до release и сообщает «↻ Gateway перезапущен. Продолжаю.»;
он полностью проверен offline, но не выдан за production до deploy и живого
ответа. Corrupt rotation-state теперь
останавливает startup, а не маскируется
под отсутствие state. Расширенный multi-Project weekly cohort, отдельный
approval WAL, per-step plan grants и forget-safe повторная фильтрация старого
transcript честно остаются **ОТЛОЖЕНО ADR**: они не нужны для заявленного
диалогового cutover и не выданы за LIVE. Остальные
не-LIVE строки ниже либо уже имеют явный target gate, либо являются dormant,
отсутствующим новым продуктовым срезом или отложенной ADR-границей; их нельзя
активировать попутным wiring без отдельного решения.

## Доказательная матрица

| Область | Verdict | Текущее доказательство | Оставшийся gate |
|---|---|---|---|
| Telegram text, streaming, attachments и forwarded batches | **LIVE в composition; production P0, candidate проверен offline** | Production `c5db7ae` теряет обычный ответ в stale-continuation recovery-loop. Candidate `763ed88` закрывает exact non-ambiguous orphan, продолжает повторно доставленный transport update и меняет карточку на «Gateway перезапущен. Продолжаю.». Полный App/process corpus и Gateway зелёные | Managed deploy `763ed88`, один restart, обычный ответ без повторной реплики пользователя; затем nightly shortcut |
| Workspace, Projects, Sessions и files | **LIVE в composition; daily target state ещё не создан** | Registry v2, ProjectService, one-use SessionRotationAuthority, crash recovery и `/resume [prefix]` подключены. Corrupt rotation record fail-closed; старая Session и transcript не удаляются. На target `daily-session-rotation.json` ещё отсутствует: сегодняшний nightly слот завершился до активации slice | Следующая daily rotation и живой `/resume`; forget-safe transcript reprojection отложена ADR |
| Transcript v2 и compaction | **LIVE; rollback-compatible learned overlay fix развёрнут** | Single-writer lease, WAL/restart, reply checkpoint, durable media inbox и compaction подключены; raw audit остаётся неизменным. Provider-facing projection удаляет code-owned recovery/action spans и промежуточные model attempts. `learned-procedure` является актуальной turn-local проекцией typed store и не записывается как диалоговая строка; user ingress и terminal reply остаются в прежнем hash-chained schema | Повторный живой Telegram turn; target-FS self-test и long-session acceptance; day-log/activity pipeline DORMANT |
| Keyword/scoped memory и forgetting | **LIVE; новый slice развёрнут** | Protected global/Project stores и `makeScopedMemoryLiveView` остаются единственным live path. `remember` публикует факт сразу и code-owned acknowledgement нормализует bounded preference prefixes в естественное «Запомнил, что ты…»; operational facts не перефразируются. Три известные test facts удалены через deletion service, ledger/projection после restart содержат 0 test markers | Target natural remember→restart→recall без служебного текста |
| Semantic memory | **LIVE при explicit descriptor + consent** | sqlite-vec/OpenRouter adapter и durable semantic-egress consent подключены; без них честный keyword-only fallback | Реальный embedding call, restart и revoke consent |
| Tools и exact-domain HTTPS | **LIVE в composition; similar grant target ещё не принят** | Shared capability executor, files/memory/knowledge/tasks/journal, `web_search` и redirect-safe `fetch_url` подключены. В `auto` первое ordinary Tier-2 подтверждение создаёт scoped similar grant; destructive/Tier-3/HARD_DENY не обходятся. Target `grants.json` отсутствует: фактический grant ещё не создавался | Живой Tier-2 confirm-once → repeat без карточки; отдельно destructive warning/card |
| Active Skills | **LIVE runtime; на target нет активного Skill** | Hash-pinned catalog, prompt menu/body-on-trigger, AgentCard filtering, CLI и Telegram controls подключены. `skills-manifest.json` на target отсутствует | Установка, trigger и disable/reload одного реального Skill |
| Typed auto-skills | **LIVE framework; target lifecycle healthy, activation не случалась** | `AISY_AUTO_SKILLS=1` включает generator/judge/store/worker и code-owned planner; два delivery-confirmed success разных Sessions активируют только closed-registry descriptor. Doctor: lifecycle pass, active/queued/pending/quarantined/forgetting/ambiguous — 0 | Два чистых remember-turn в разных Sessions, planner smoke и удаление только их test evidence |
| Skill promotion runtime | **DORMANT** | Promotion/store/doctor modules и tests существуют отдельно от production composition | Verification probes и human promotion composition |
| Nightly Skill drafting | **ОТСУТСТВУЕТ** | Nightly loop не имеет реального `draftSkills` seam | Generator output, staged artifact и negative one-off-failure corpus |
| stdio MCP | **LIVE runtime; target не настроен** | Startup connect gauntlet, human-owned allowlist/policy, bounded menu, `call_mcp` через HookGate и Telegram controls подключены. `mcp-allowlist.json` на target отсутствует, поэтому ни один server не выдан за active | Один операторски выбранный stdio connect/call/remove E2E |
| Streamable HTTP MCP | **DORMANT** | Transport policy и wire foundation существуют, но live binding выключен | Отдельное security/authority решение и acceptance |
| Native API providers | **LIVE под supervisor** | Семь fixed descriptors, root-owned broker, validator/worker sockets, host-encrypted A/B slots и rollback развёрнуты; arbitrary URL не принимается | TTY enrollment, bounded vendor call, switch, restart и revoke real slot |
| Claude/Codex subscription brains | **LIVE на target; provenance/receipt fix развёрнут** | Per-turn loopback Aisy MCP bridge, isolated homes и exact turn binding реализованы. Releases `2a98797` и `1df4851` сохраняют frozen prefix, сериализуют spans как `AISY_CONTEXT_V1`, не приписывают оператору неподтверждённые ложные предупреждения и фильтруют их до streaming/history, сохраняя реальное untrusted/tool grounding и приватный raw audit | Повторить composite smoke на exact `1df4851` |
| Voice provider registry / Deepgram proxy | **LIVE framework; target text-only** | Telegram voice ingress, `Transcriber`, one-use media capability, root-owned broker/worker, consent/spend boundary и A/B rollback реализованы. Doctor подтверждает artifact/backend/proxy/outbox, но старый provider selection изолирован после privacy-revision change, а credential не ready. Тихо переиспользовать старое consent нельзя | Явные TTY enrollment/reselection/consent, Telegram voice, bounded call и revoke; до этого voice не выдаётся за функциональный |
| Subagents | **LIVE; durable supervised path deployed** | AgentCard-scoped runner, receipts, Journal v2, retry/cancel actor, startup replay, durable `/stop` и terminal delivery подключены; ordinary delegation через Telegram после `a74419c` вернула проверенный terminal result | Отдельные target ambiguity и `/stop` fault drills |
| Monitoring и digest | **LIVE для RSS/Web** | Source UI, DNS/IP-pinned GET-only collector, no-tools scorer, durable windows и at-most-once Telegram send ledger подключены | RSS→Telegram restart/rollback E2E и egress pentest |
| Monitoring source authority | **LIVE** | Добавление source сохраняет read-only grant только на exact HTTPS domain; pause его сохраняет, confirmed remove отзывает | Target add/pause/remove audit без raw URL или content в approval state |
| Telegram/YouTube/GitHub monitoring collectors и feedback learning | **DORMANT / ОТСУТСТВУЕТ по подтипу** | Core collector/ranking pieces существуют не для всех platform flows | Отдельные normalized collectors, UI и deterministic cursor/feedback corpus |
| Onboarding, профиль и персонализация | **LIVE; мужской grammatical gender активирован** | Typed store немедленно применяет explicit `concise`, `hide-internals`, `natural-russian`, `second-person-memory-ack`, `masculine-russian`; inferred descriptor требует две Sessions. `c3268de` сохраняет overlay turn-local; `97b25ef` подключает тот же descriptor к code-owned nightly notices. На target active family точно masculine, internal detail hidden | Живой ordinary ответ мужского рода на `c5db7ae`; rollback/forget есть в code, Telegram UI отсутствует |
| Daily Session reset / Sunday memory cadence | **LIVE в composition; target cadence ещё не отработал** | Daily runner не вызывает generator/judge; Sunday cursor даёт missed-Sunday catch-up, manual run не двигает cursor. Rotation/restart/at-most-once notice покрыты tests. Target files `daily-session-rotation.json` и `weekly-consolidation-cursor.json` ещё отсутствуют | Следующий daily slot и ближайшее Sunday/catch-up. Multi-Project cohort и late-result outbox ОТЛОЖЕНЫ ADR |
| Напоминания, расписания и цели | **LIVE** | Trigger store/engine, scheduler, goal store/orchestrator, approval и restart resume подключены в `bin/aisy.ts` | Target reminder + scheduled goal + restart trace |
| Ограниченный доступ к серверу | **LIVE при explicit config + approval** | `makeServerAccess` импортирован production binary; argv выполняется без shell, restart требует held supervisor authority, временный доступ истекает scheduler-ом | Target open/expire/restart audit для operator-owned config |
| Image/video understanding и преобразования | **ОТСУТСТВУЕТ** | Durable attachment/media inbox принимает и изолирует bytes, voice имеет отдельный transcriber; production vision/video processor или transformation tool отсутствует | Новый продуктовый срез, egress/privacy ADR и детерминированный media corpus; не является скрытым release gate v0.1 |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE parent; turn recovery candidate не развёрнут** | `6d50eb9` удерживает parent в backoff; real-process target drill доказал один replacement child и `NRestarts=0`. Production `c5db7ae` при stale parent continuation повторяет child restart. `763ed88` добавляет exact orphan/failed-turn retirement и зелёный real-process corpus без изменения persisted schema | Managed deploy, один restart и подтверждение, что unexpected-exit counter больше не растёт на обычном ходе |
| Managed Git install/update/rollback | **LIVE: target cutover, rollback и roll-forward приняты** | current=`c5db7ae`, previous=`97b25ef`; оба последних update выполнены каноническим managed binary с pinned Node 22 PATH, затем explicit service restart. Предыдущие offline rollback/roll-forward drills сохраняются; текущий Doctor exit 0 | Новый rollback drill не нужен для text-only UI diff; previous slot сохранён и готов |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Public remote после fast-forward содержит один head `master=763ed88` и ноль tags. Staged Gitleaks candidate — 0 findings; diff и tracked-path scan не содержат имён, путей, текстов, схем или артефактов локального приватного эталона. Старые локальные ветки не publish authority и не мержились | После production evidence commit повторить public refs/history/tree scans; legacy refs не push'ить |

## Проверки текущего среза

- candidate `763ed88`: root cause подтверждён как stale non-ambiguous active
  parent continuation после ordinary provider failure. Exact retirement
  привязан к continuation hash, owner и revision; ambiguity, actor, любой exact
  run, `paused|cancelling`, corrupt state и drift остаются fail-closed.
  Финальный App corpus — **2678 passed / 2 skipped** (256 test files pass,
  1 штатно skipped), Telegram Gateway — **258 passed**, targeted recovery —
  **82/82**, отдельный admission corpus — **5/5**; workspace typecheck/build и
  `git diff --check` green. Staged Gitleaks — 0 findings. Public fast-forward
  `c5db7ae→763ed88` подтверждён: один head `master`, tags нет. Production
  остаётся на `c5db7ae`: прямой SSH недоступен, Tailscale disconnected, поэтому
  deploy/restart/живой Telegram-ответ честно не приняты;

- production P0 2026-08-28: активный typed preference добавлял
  `learned-procedure` span, а ADR-0064 recorder принимал только persisted
  `operator | untrusted`; метаданные показали две успешные записи и отказ до
  `prompt.assembled`. Release `c3268de` делает overlay turn-local и сохраняет
  rollback schema. Targeted regressions — **140 Core + 4 App passed**; полный
  corpus — Core **2419 passed / 1 skipped**, App **2664 passed / 2 skipped**;
  workspace typecheck/build и `git diff --check` green. Public fast-forward
  `cae9c82→c3268de`, managed current=`c3268de`, previous=`cae9c82`, service
  `active/running`, `NRestarts=0`, Doctor **19 pass / 7 optional warn**.
  Gitleaks по 47 public commits — 0 findings; forbidden marker tree/history —
  0. @monday_aibot отправил bounded smoke request `message_id=4142`; ответный
  live turn ещё не поступил и не выдан за принятую проверку;

- public fast-forward `0178acd→b125e73` опубликован и развёрнут. Managed
  `update→rollback→roll-forward` завершён с current=`b125e73`,
  previous=`1df4851`; auto-skill rollback barrier возобновлён exact-командой,
  supervisor restart-budget подтверждён recovery revision 142. Финальный
  service `active/running`, `ExecMainStatus=0`, `NRestarts=0`; полный Doctor —
  **19 pass / 7 optional warn**, включая Telegram token/allowlist и typed
  auto-skill lifecycle. Через deletion service удалены ровно три заранее
  известные test facts; повторная проверка ledger и `MEMORY.md` дала 0 test
  markers;
- release through code head `520ab9d` и итоговый code-bearing `b125e73`: Core **2419 passed / 1 skipped**,
  Telegram Gateway **256 passed**, финальный App real-socket corpus **2659
  passed / 2 skipped** (255 файлов pass, 1 штатно skipped), Python sidecars
  **215 passed / 39 platform-or-optional skipped**, Ruff green; workspace
  typecheck/build и `git diff --check` — green. Targeted daily rotation,
  `/resume`, weekly cadence, natural memory receipt, communication preferences,
  learned grants и typed auto-skill suites — green. Независимый review нашёл и
  закрыл stale test fixture, fail-open corrupt rotation record и слишком сильный
  provenance learned overlay; повторный review отделил неактивированные
  WAL/cohort guarantees в **ОТЛОЖЕНО ADR**;
- exact release `1df4851`: Core **2410 passed / 1 skipped** (139 файлов pass,
  1 штатно skipped), App **2638 passed / 2 skipped** (252 файла pass, 1
  штатно skipped); workspace typecheck/build и `git diff --check` — green.
  Targeted regressions покрывают exact bare/concrete show-intent, single-use
  staging shortcut, empty/stale staging, steering precedence, неизменный raw
  audit, provider projection и фильтрацию ложной атрибуции до streaming/history.
  Три независимых review-round завершены без P0–P2 findings;
- public fast-forward `2a98797→1df4851` опубликован; independent `ls-remote`
  показал ровно один head `master` и ноль tags. Gitleaks по code history через
  `1df4851` и отдельному status-only diff — 0 findings; tracked tree и
  reachable-history marker scans — 0 совпадений;
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

- публичный remote на момент аудита имеет ровно один head `master`, tags и
  дополнительных heads нет; последний code-bearing commit `b125e73`
  опубликован fast-forward от `0178acd`;
- `git branch --no-merged public/master` по-прежнему показывает локальные feature- и
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
  public commits. Повторная проверка 2026-08-28 после adaptive-agent push не
  нашла коммитов поверх текущей `codex/auto-skill-learning`: `public/master`
  указывает на тот же `b125e73`. Перенос legacy heads вернул бы уже
  исправленные safety/recovery gaps;
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

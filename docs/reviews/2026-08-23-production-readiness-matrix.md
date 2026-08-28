# Матрица production-готовности Aisy

**Дата среза:** 2026-08-28
**Code baseline:** public root `2de457ff84c415e53522dd772e4622ca858cd0b8`,
audited Git tree `c65ef5bd85f0ae7cf3627fb34a9c62f4e41af95a`

**Current verified code head:** `c3268dee5b789824e8d175fa0d8fd38f5a321eca`

**Production runtime release из public `master`:**
`c3268dee5b789824e8d175fa0d8fd38f5a321eca`

**Managed production current:** `c3268dee5b789824e8d175fa0d8fd38f5a321eca`
**Managed production previous:** `cae9c826ce6d0fed27ae046d246f06d9741879da`

**Развёрнутый adaptive-agent slice:** commits `0843142..c3268de`;
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
rollback-бинарник продолжает читать журнал. Corrupt rotation-state теперь
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
| Telegram text, streaming, attachments и forwarded batches | **LIVE; transcript P0 исправлен и развёрнут** | `makeTelegramBot`, streaming checkpoints, durable media inbox и batching создаются в production composition. Typed nightly notice различает `complete-zero`, `complete-n`, `partial-failure` и session-only; bare `Покажи` одноразовый и deterministic, конкретное `Покажи файл` остаётся обычным запросом. Release `c3268de` устраняет pre-provider отказ следующего хода с активным learned overlay; Target Doctor подтверждает token/allowlist, сервис стабилен | Повторный живой `эй` после `c3268de` и следующий nightly shortcut |
| Workspace, Projects, Sessions и files | **LIVE; новый slice развёрнут** | Registry v2, ProjectService, отдельная one-use SessionRotationAuthority, deterministic create id, crash recovery и `/resume [prefix]` подключены. Corrupt rotation record fail-closed; старая Session и transcript не удаляются | Forced daily rotation/restart и `/resume` E2E на target; forget-safe transcript reprojection отдельно отложена ADR |
| Transcript v2 и compaction | **LIVE; rollback-compatible learned overlay fix развёрнут** | Single-writer lease, WAL/restart, reply checkpoint, durable media inbox и compaction подключены; raw audit остаётся неизменным. Provider-facing projection удаляет code-owned recovery/action spans и промежуточные model attempts. `learned-procedure` является актуальной turn-local проекцией typed store и не записывается как диалоговая строка; user ingress и terminal reply остаются в прежнем hash-chained schema | Повторный живой Telegram turn; target-FS self-test и long-session acceptance; day-log/activity pipeline DORMANT |
| Keyword/scoped memory и forgetting | **LIVE; новый slice развёрнут** | Protected global/Project stores и `makeScopedMemoryLiveView` остаются единственным live path. `remember` публикует факт сразу и code-owned acknowledgement нормализует bounded preference prefixes в естественное «Запомнил, что ты…»; operational facts не перефразируются. Три известные test facts удалены через deletion service, ledger/projection после restart содержат 0 test markers | Target natural remember→restart→recall без служебного текста |
| Semantic memory | **LIVE при explicit descriptor + consent** | sqlite-vec/OpenRouter adapter и durable semantic-egress consent подключены; без них честный keyword-only fallback | Реальный embedding call, restart и revoke consent |
| Tools и exact-domain HTTPS | **LIVE; новый grant slice развёрнут с принятым host risk** | Shared capability executor, files/memory/knowledge/tasks/journal, `web_search` и redirect-safe `fetch_url`; первое обычное Tier-2 подтверждение в `auto` атомарно сохраняет scoped similar grant, `/grants` отзывает его. Tier-3, HARD_DENY, narrowing и `confirm` не обходятся | Target: подтвердить одну безопасную Tier-2 операцию и повторить без второй карточки; explicit destructive по-прежнему должен спросить |
| Active Skills | **LIVE для use/install/remove** | Hash-pinned catalog, prompt menu/body-on-trigger, AgentCard filtering, CLI и Telegram controls подключены | Установка, trigger и disable/reload на целевом host |
| Typed auto-skills | **LIVE при explicit canary; registry ограничен** | `AISY_AUTO_SKILLS=1` включает generator/judge/store/worker и code-owned planner. Два delivery-confirmed terminal success разных Sessions активируют только descriptor из закрытого registry; текущий production registry содержит `memory.remember`. Target rollback-barrier/resume и Doctor `skills.typed-auto-skill-lifecycle=pass` приняты. Raw dialogue, tool authority и свободный executable Skill не публикуются | Два новых чистых remember-turn в разных Sessions, activation/planner smoke и очистка их evidence; новые procedure families требуют отдельного descriptor/code release |
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
| Onboarding, профиль и персонализация | **LIVE; мужской grammatical gender активирован** | First-contact и профиль остаются LIVE. Отдельный private typed preference store немедленно применяет явные поправки `concise`, `hide-internals`, `natural-russian`, `second-person-memory-ack`, `masculine-russian`; inferred descriptor требует две разные Sessions. В prompt попадает только fixed text с provenance `learned-procedure`, не raw dialogue; release `c3268de` доказанно пропускает этот overlay в provider и не пишет его в transcript | Живой ответ мужского рода после `c3268de`; rollback/forget доступны программно, Telegram UI для них ОТСУТСТВУЕТ |
| Daily Session reset / Sunday memory cadence | **LIVE; расширенный cohort ОТЛОЖЕН ADR** | Daily runner не вызывает generator/judge; Sunday cursor даёт missed-Sunday catch-up, manual run не двигает cursor. Rotation/restart/at-most-once startup notice детерминированы; код развёрнут на target | Target forced-date run и следующий Sunday. Multi-Project member cursors, cross-cohort artifact reuse и late-result outbox не активированы |
| Напоминания, расписания и цели | **LIVE** | Trigger store/engine, scheduler, goal store/orchestrator, approval и restart resume подключены в `bin/aisy.ts` | Target reminder + scheduled goal + restart trace |
| Ограниченный доступ к серверу | **LIVE при explicit config + approval** | `makeServerAccess` импортирован production binary; argv выполняется без shell, restart требует held supervisor authority, временный доступ истекает scheduler-ом | Target open/expire/restart audit для operator-owned config |
| Image/video understanding и преобразования | **ОТСУТСТВУЕТ** | Durable attachment/media inbox принимает и изолирует bytes, voice имеет отдельный transcriber; production vision/video processor или transformation tool отсутствует | Новый продуктовый срез, egress/privacy ADR и детерминированный media corpus; не является скрытым release gate v0.1 |
| Learned autonomy | **LIVE** | Evidence/grant stores и post-success observation подключены; enforcement действует только в `auto`, revoke/forget code-owned | Нормативный 7-day promotion/restart/forget E2E без ускорения порогов |
| Docker external sidecar create/use | **DORMANT** | Startup recovery barrier, enroll/doctor и pinned daemon checks LIVE; current-child create/use/cleanup не активированы | Authenticated child authority, real-Docker rehearsal и multi-resource cleanup |
| Supervisor restart/rollback | **LIVE для managed release; destructive drill принят с recovery** | Target unit использует managed `active/current`. Цикл `b125e73→1df4851→b125e73` сохранил previous slot. Current=`c3268de`, previous=`cae9c82`; новый fix не расширяет persisted transcript enum, поэтому retained previous остаётся совместимым. Финальный service `active/running`, `ExecMainStatus=0`, `NRestarts=0`, Doctor healthy | В обычном release gate фиксировать exact quarantine/recovery и отсутствие дальнейшего роста рестартов |
| Managed Git install/update/rollback | **LIVE: target cutover, rollback и roll-forward приняты** | current=`c3268de`, previous=`cae9c82`; managed update, официальный исторический rollback и roll-forward завершены. Неверно адресованный промежуточный launcher был byte-identical каноническому, удалён точечно; retained previous остаётся rollback-слотом. Финальный Doctor **19 pass / 7 optional warn** | Следующий update обязан запускаться только каноническим `/home/iam/aisy-managed-bin/aisy` с pinned Node 22 PATH |
| SSH provider/voice bundle delivery | **РЕАЛИЗОВАН; target transfer ещё не принят** | 64 targeted Python tests и disposable Linux install/rollback; quotas, replay tombstones и crash-convergent cleanup включены | Постоянный pinned receiver и controlled target delivery |
| Несколько Telegram-ботов | **LIVE с ограничением** | Durable registry и add/list/archive существуют | Active token switch **ОТЛОЖЕН ADR-0076**: один process обслуживает один token |
| Arbitrary OpenAI-compatible origin | **ОТЛОЖЕНО ADR-0099** | Caller не передаёт URL/host/header в native broker | Новый scoped egress/identity ADR; текущий path fail closed |
| Общая IDE/browser control plane | **ОТСУТСТВУЕТ в v0.1** | Telegram остаётся единственной полной operator surface | Отдельная gateway/auth/recovery архитектура после Telegram acceptance |
| Public history/privacy boundary | **LIVE по ADR-0107** | Публичный remote содержит один head `master` на `c3268de` и ноль tags; Gitleaks по 47 reachable commits дал 0 findings, tree/history marker scans — 0 совпадений. Локальные legacy refs не являются publish authority и повторно не содержат независимого missing-candidate по завершённому content-аудиту | После status commit повторить public refs/reachable-history/tree scans; локальные legacy refs не push'ить |

## Проверки текущего среза

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

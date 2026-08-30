# Финальная матрица production-готовности Aisy

**Дата среза:** 2026-08-30  
**Code-bearing baseline:** `905583d42290d37c6c3445103c6c299a936e8b9a`  
**Rollback-drill current:** `7557ecefccfa8f8179a8d722f5307953068164fa`  
**Rollback-drill previous:** `905583d42290d37c6c3445103c6c299a936e8b9a`

Эта матрица заменяет прежний накопительный candidate-срез. Она различает
наличие production composition и фактическую проверку на целевом хосте. Статус
`LIVE` без target evidence не означает, что внешний provider или необязательная
интеграция настроены.

## Обозначения

- **LIVE** — production composition вызывает реализацию, контракт покрыт
  детерминированными тестами.
- **dormant** — код существует, но production composition его не вызывает.
- **отсутствует** — полного production seam нет.
- **отложено ADR** — возможность сознательно не входит в текущий срез.

## Доказательная матрица

| Область | Статус | Доказательство | Оставшийся target gate |
|---|---|---|---|
| Telegram text и естественный диалог | **LIVE** | На `4e493c4` один composite turn без карточки выполнил память и делегирование, вернул `667`, `AISY-TEXT-OK` и естественное «Запомнил, что ты…». `905583d` запущен, service active, `NRestarts=0` | Один обычный ход на exact `905583d` |
| Личность и мужской род | **LIVE** | Typed communication preference входит в provider и nightly projections; русские строки покрыты corpus | Короткий обычный target-диалог на exact release |
| Protected/scoped memory | **LIVE** | Doctor: global DNA и integrity pass; remember receipt exactly-once; тестовый marker пережил новую Session и restart | Recall из новой Session, затем удалить exact test fact и доказать отсутствие после restart |
| Sessions, `/resume`, имена и удаление | **LIVE** | Daily rotation, auto-name, resume и deletion coordinator подключены. Delete физически удаляет registry row, transcript, attachments и provider-local history, сохраняя memory/Skills/grants | Показать `/resume`, удалить одну exact test Session через одну terminal-карточку и проверить filesystem/registry |
| Daily reset и воскресная consolidation | **LIVE** | Scheduler и missed-slot catch-up pass; cadence-тесты фиксируют daily Session rotation и weekly Sunday consolidation | Следующий естественный nightly/weekly slot |
| Tools и scoped approvals | **LIVE** | `remember` и `spawn_subagent` Tier-1 в natural mode; confirm mode повышает их до Tier-2. Durable grants принадлежат operator/profile + Workspace/Project, Project/path может только ужесточать | Target confirm-once/repeat и отдельная destructive warning-карточка без выполнения |
| Typed auto-skills | **LIVE** | Closed registry, two-session evidence, separate generator/judge, shadow/CAS и scoped overlay подключены; Doctor ready, active/queued/pending/quarantine=0 | Два чистых повторения в разных Sessions и последующая очистка test evidence |
| Свободные model-authored Skills | **отложено ADR** | Модель не может писать исполняемый `SKILL.md`, source Aisy, Constitution, Safety или capability catalog. Свободный Skill остаётся staged + human-reviewed | Новое ADR, если оператор решит ослабить эту границу |
| Active Skills runtime | **LIVE** | Hash-pinned active catalog, body-on-trigger, AgentCard filtering и Telegram controls подключены | На target нет установленного active Skill |
| Skill promotion | **dormant** | Store и проверочные модули существуют, но LIVE composition отсутствует | Отдельный rollout |
| stdio MCP | **LIVE** | Startup gauntlet, allowlist, bounded menu и `call_mcp` через HookGate подключены; Doctor pins pass | На target нет настроенного MCP server |
| Streamable HTTP MCP | **dormant** | Transport foundation существует без live binding | Отдельное authority/security решение |
| Subscription provider | **LIVE** | Claude subscription reachable; per-turn bridge и capability receipts подключены | Повторный composite smoke на exact release |
| Native API providers | **LIVE** | Fixed descriptors и supervisor/broker boundary подключены | Ни один необязательный real slot не заявлен готовым без enrollment/switch/revoke E2E |
| Subagents | **LIVE** | Composite target turn вернул terminal result `23 × 29 = 667`; durable runner/replay/cancel corpus зелёный | Ambiguity и `/stop` fault drill остаются отдельной эксплуатационной проверкой |
| Voice/media | **LIVE framework** | Root-owned artifact, backend sockets, proxy и outbox pass; media recovery bounded. Ingress/credential/consent gates подключены | Production остаётся text-only: provider key и consent не готовы, поэтому voice E2E не заявлен |
| Monitoring RSS/Web | **LIVE** | Exact-domain GET-only collector, durable windows и at-most-once delivery подключены | Target source add/pause/remove и delivery E2E |
| Telegram/YouTube/GitHub collectors | **dormant** | Отдельные production bindings не активированы | Отдельные provider/authority решения |
| Restart | **LIVE** | Managed deploy `905583d` после exact systemd restart: service active/running, `ExecMainStatus=0`, `NRestarts=0`; Doctor `ok=true` | Нет |
| Managed rollback | **LIVE; target drill подтверждён** | `7557ece → 905583d`: после rollback service active/running, `ExecMainStatus=0`, `NRestarts=0`, Doctor `ok=true`, memory marker сохранён, auto-skills только paused. `905583d → 7557ece`: roll-forward и explicit resume удалили barrier, service снова active, Doctor ready | Обычный Telegram turn после rollback не отправлялся без отдельного согласия оператора |
| Docker restricted clone | **dormant** | Doctor честно сообщает, что legacy sandbox/restricted clone не активированы | Отдельный rollout; это не дефект text runtime |
| Vision/video generation | **отсутствует** | Production seam не заявлен | Отдельная продуктовая спецификация |
| Изменение собственного source моделью | **отложено ADR** | Разговорная настройка ограничена typed configuration, memory, grants и закрытыми навыками; source/Safety/catalog code-owned | Не разрешать без нового архитектурного решения |

## Проверки release `905583d`

- targeted rollback corpus: **46/46**;
- workspace build и App typecheck: green;
- чистый повтор полного App gate вне sandbox: **2822 passed / 2 skipped /
  0 failed**, 266 test files passed, 1 skipped; waiver не нужен;
- `git diff --check`: green;
- independent review rollback-среза: **APPROVED**, P0–P2 нет;
- двухрелизный production drill: rollback сохранил основной runtime и память,
  roll-forward вернул exact release, explicit resume снял barrier; финальные
  `ActiveState=active`, `SubState=running`, `ExecMainStatus=0`, `NRestarts=0`,
  Doctor `ok=true`;
- Gitleaks: один новый commit, утечек нет;
- tracked-tree scan: материалов, имён и путей приватного эталона нет;
- production Doctor: `ok=true`; warnings относятся к явно неактивированным
  optional Docker/voice возможностям, а не к text runtime.

## Приватный эталон

Локальный приватный эталон использовался только для независимого сравнения
категорий возможностей. В Git Aisy не переносились и не публиковались его
материалы, тексты, имена, пути, схемы или артефакты. Каждая строка матрицы
опирается только на собственные ADR, русские спецификации, production
composition, тесты и target evidence Aisy.

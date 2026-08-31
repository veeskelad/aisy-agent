# Финальная матрица production-готовности Aisy

**Дата среза:** 2026-08-31  
**Production current:** `3de8c37675856211aed248aa421db5dad802edff`  
**Public code/test baseline:** `82a7872`  
**Production previous:** `ad004cb7af2473f482d3d1120df7a513c946ae17`

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
| Telegram text и естественный диалог | **LIVE; target подтверждён** | На `4e493c4` один composite turn без карточки выполнил память и делегирование, вернул `667`, `AISY-TEXT-OK` и естественное «Запомнил, что ты…». На current `ad004cb` оператор вручную подтвердил обычные ответы без секунд, «думаю», названий действий и внутренних проверок; service active, `NRestarts=0` | Нет для text UX |
| Личность и мужской род | **LIVE** | На target активны typed descriptors `masculine-russian`, `natural-russian`, `concise`, `hide-internals` и `second-person-memory-ack`; все пять входят в provider overlay, а `masculine-russian` отдельно задаёт грамматику deterministic nightly notice. Живой краткий русский ответ подтверждён оператором на current `ad004cb` | Короткая target-реплика с явной мужской формой |
| Protected/scoped memory | **LIVE** | Doctor: global DNA и integrity pass; remember receipt exactly-once; тестовый marker пережил новую Session и restart | Recall из новой Session, затем удалить exact test fact и доказать отсутствие после restart |
| Sessions, `/resume`, имена и удаление | **LIVE** | Daily rotation, auto-name, resume и deletion coordinator подключены. Delete физически удаляет registry row, transcript, attachments и provider-local history, сохраняя memory/Skills/grants | Показать `/resume`, удалить одну exact test Session через одну terminal-карточку и проверить filesystem/registry |
| Daily reset и воскресная consolidation | **LIVE; target подтверждён** | 2026-08-30 scheduled run завершился `delivered`, создал новый Session и сообщил об одной ожидающей правке; weekly cursor и nightly high-water опубликованы для воскресенья `2026-08-30` | Нет |
| Tools и scoped approvals | **LIVE** | `remember` и `spawn_subagent` Tier-1 в natural mode; confirm mode повышает их до Tier-2. Durable grants принадлежат operator/profile + Workspace/Project, Project/path может только ужесточать. Свежий targeted corpus approval/policy/safety: 270/270 | Target confirm-once/repeat и отдельная destructive warning-карточка без выполнения |
| Поиск и открытие страниц | **LIVE; target подтверждён** | На production обнаружен и устранён дефект Node 22 `lookup`, из-за которого HTTPS обрывался до сокета. Неустойчивый HTML fallback заменён закреплённой RSS-выдачей; без ключа поиск вернул 5 результатов по строке с `ya .ru`, а `https://ya.ru` открылся и вернул текст. Ошибки переводятся в конкретную русскую причину без выдуманного «режима без сети» | Telegram-сообщение намеренно не отправлялось: оператор сам проверяет диалог |
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
| Restart | **LIVE** | Managed deploy `3de8c37` активен после одного штатного restart: новый PID, service active/running, `ExecMainStatus=0`, `NRestarts=0`; Doctor `ok=true` | Нет |
| Managed rollback | **LIVE; target drill подтверждён** | `7557ece → 905583d`: после rollback service active/running, `ExecMainStatus=0`, `NRestarts=0`, Doctor `ok=true`, memory marker сохранён, auto-skills только paused. `905583d → 7557ece`: roll-forward и explicit resume удалили barrier, service снова active, Doctor ready | Обычный Telegram turn после rollback не отправлялся без отдельного согласия оператора |
| Docker restricted clone | **dormant** | Doctor честно сообщает, что legacy sandbox/restricted clone не активированы | Отдельный rollout; это не дефект text runtime |
| Vision/video generation | **отсутствует** | Production seam не заявлен | Отдельная продуктовая спецификация |
| Изменение собственного source моделью | **отложено ADR** | Разговорная настройка ограничена typed configuration, memory, grants и закрытыми навыками; source/Safety/catalog code-owned | Не разрешать без нового архитектурного решения |

## Проверки production current `3de8c37`

- targeted rollback corpus: **46/46**;
- свежий acceptance-корпус Session/reset/resume/delete, personality, grants,
  typed auto-skills, MCP, subscription provider, subagents и ошибки:
  **169/169** вне ограничивающего IPC sandbox;
- дополнительный approval/policy/safety corpus: **270/270**;
- workspace build и App typecheck: green;
- полный App gate на финальном коде сначала нашёл одно устаревшее ожидание
  имени поискового построителя; доводочный commit `82a7872` исправил только
  этот guard, targeted повтор **93/93** зелёный;
- следующий полный App gate подтвердил новый guard и весь сетевой corpus;
  единственный независимый real-process probe один раз получил
  `PROCESS_GROUP_PROBE_DENIED`, а точный повтор прошёл **16 passed / 1 skipped**;
  изменённые сетевые тесты не падали;
- полный Core gate: **2454 passed / 1 skipped / 0 failed**;
- production network smoke из активного release: поиск **5 результатов**,
  `ya.ru` открыт, текст непустой, remote IP совпал с заранее проверенным;
- `git diff --check`: green;
- independent review rollback-среза: **APPROVED**, P0–P2 нет;
- двухрелизный production drill: rollback сохранил основной runtime и память,
  roll-forward вернул exact release, explicit resume снял barrier; финальные
  `ActiveState=active`, `SubState=running`, `ExecMainStatus=0`, `NRestarts=0`,
  Doctor `ok=true`;
- Gitleaks: четыре commits от `ad004cb`, включая этот evidence-update,
  утечек нет;
- tracked-tree scan: материалов, имён и путей приватного эталона нет;
- production Doctor: `ok=true`; warnings относятся к явно неактивированным
  optional Docker/voice возможностям, а не к text runtime.

## Аудит веток и доставка

- public remote содержит ровно одну ветку `master`; code/test baseline —
  `82a7872`, поверх него публикуется только этот evidence-update;
- production исполняет code-bearing commit `3de8c37`; следующий `82a7872`
  меняет только защитное тестовое ожидание и runtime-дерево не затрагивает;
- commits ветки `codex/production-personal-agent`, относящиеся к этому срезу,
  распознаны через `--cherry-mark` как patch-equivalent текущему `master`;
  merge этой ветки не требуется и вернул бы старое tree-state без более новых
  rollback, confinement и media-recovery исправлений;
- локально остаются `--no-merged` refs от параллельных и исторических работ.
  Эта матрица не объявляет их содержимое принятым или отброшенным: каждый такой
  ref требует отдельного предметного аудита перед возможным MR;
- рабочее дерево current release до обновления этой матрицы было чистым;
  отдельный MR для personal-agent среза не требуется.

## Приватный эталон

Локальный приватный эталон использовался только для независимого сравнения
категорий возможностей. В Git Aisy не переносились и не публиковались его
материалы, тексты, имена, пути, схемы или артефакты. Каждая строка матрицы
опирается только на собственные ADR, русские спецификации, production
composition, тесты и target evidence Aisy.

# Компонент 20: Agent DNA и capability matrix

**Статус:** lifecycle-каталог и Telegram UI LIVE; main/non-builtin registry
authority остаётся за exact opt-in gate до target restart/rollback E2E
**Связанные ADR:** ADR-0039, ADR-0052, ADR-0013, ADR-0015, ADR-0027, ADR-0069
**Зависит от:** Skills (06), MCP (07), Orchestration (11), Projects/Sessions (17)

## 1. Назначение

AgentCard должна быть не декоративной карточкой, а единственным code-owned
источником доступных субагенту tools, Skills, MCP, бюджета итераций, context
strategy и Markdown-DNA. Provider не должен видеть tool schema, которой нет в
карте, даже если executor позднее смог бы отклонить вызов.

## 2. Формат карты

`.aisy/agents/<name>.md` содержит строгий YAML frontmatter и обязательное
Markdown-тело:

```yaml
---
name: reviewer
description: Проверяет изменение и приводит evidence
skills: [review-code]
mcp_allowlist: [tracker]
tool_tiers: { read_file: 0, search_memory: 0 }
max_iterations: 12
context_strategy: compact
provenance: user
---
Ты проверяешь изменение в выданном scope и возвращаешь только доказанный вывод.
```

Имя соответствует `^[a-z0-9][a-z0-9-]{0,63}$` и имени файла. Tier — целое
`0..3`, `max_iterations` — целое `1..200`, capability references не
дублируются, body не пуст. Неизвестные enum, duplicate logical name и
filename/name mismatch блокируют карту. Зарезервированная builtin-карта
`general` всегда побеждает пользовательский файл.

## 3. Разрешение capabilities

`resolveAgentCapabilityMatrix` пересекает карту с тремя code-owned registry:

- нейтральным tool schema catalog;
- active+trusted Skills registry;
- MCP servers, прошедшими allowlist/pin/hash/connect gauntlet.

Отсутствующий tool/Skill/MCP отклоняет всю карту до provider/model I/O. В
provider передаются только schema из `matrix.tools`; executor независимо
повторяет `permitsTool`, scope и Safety checks. Модель не может расширить matrix
своим JSON. Дублированное имя tool schema отклоняется как ambiguous.

## 4. DNA в child runtime

Markdown body карты добавляется как первый system span каждого child turn и
уже входит в immutable persisted AgentCard durable checkpoint. `builtin` и
локальная `user` DNA считаются operator-owned. `community` DNA получает
`provenance: untrusted`, поэтому child starts narrowed и outbound sinks
закрываются по ADR-0027. Capability limits остаются кодовыми независимо от
текста DNA.

## 5. Текущее production wiring

Live subagent composition в `aisy.ts` теперь:

1. отказывается подменять неизвестную/невалидную named card на `general`;
2. разрешает карту против текущих live registry sets;
3. строит child provider только с `matrix.tools`;
4. разрешает Skills только из hash-pinned, trace-verified active catalog и
   добавляет их menu/body в child prompt только после пересечения с картой;
5. использует только MCP servers, которые пережили production startup connect
   gauntlet; если ни один server не прошёл проверку, MCP set остаётся пустым и
   карта с декоративной MCP-ссылкой не запускается.

Main-agent composition также реализована, но до согласования live cutover
остаётся opt-in: оператор задаёт `AISY_MAIN_AGENT_CARD=<name>`. При выбранной
карте startup до provider/model I/O:

1. разрешает точную карту без fallback на `general`;
2. передаёт всем main/tier/fallback provider adapters только `matrix.tools`;
3. фильтрует menu, trigger matching и body loading Skills по `matrix.skills`;
4. повторно отклоняет off-card tool в executor, включая `goal_done`;
5. использует `max_iterations` как tool-call ceiling и добавляет неизменяемую
   Markdown-DNA в каждый main/goal turn; `community` DNA сохраняет untrusted
   provenance и запускает narrowing.

Без `AISY_MAIN_AGENT_CARD` сохраняется legacy composition. Lifecycle UI доступен
для подготовки ревизий, но authority loader переключается только при exact
`AISY_AGENT_CARD_REGISTRY=1`: после этого main и non-builtin subagent карты
берутся только из exact durable binding, а отсутствие/архивирование не вызывает
fallback на `.md` или Workspace-карту поверх существующей Project history.
Снятие флага возвращает прежний read-only file loader как операционный rollback;
опубликованные revisions остаются в приватном registry и не удаляются.

Production MCP process composition подключена: до
создания provider она запускает allowlist/pin/connect gauntlet и добавляет
wrapper только при непустом безопасном menu.

Новый additive путь `resolveDelegationExecutionAuthority` +
`makeBoundSubAgentRunner` делает уже разрешённую DNA/matrix неизменяемой на весь
child run: exact identity/binding, Markdown body/provenance, tool schemas,
Skills/MCP names, scope и budget входят в domain-separated hashes и первую
authority seal shard. Provider создаётся только после seal и получает frozen
schemas; session drift и изменённая/дублированная seal закрываются до I/O.
Этот путь пока не подключён в live app composition и не заменяет описанный выше
legacy/opt-in wiring.

## 6. Принятый lifecycle ADR

[ADR-0069](../decisions/2026-07-29-agent-card-lifecycle.md) фиксирует правила
create/edit/archive:

- карта живёт в scope Workspace или Project; Session-scope не вводится;
- Workspace binding не несёт `projectId`, Project binding обязательно содержит
  exact durable `projectId`; одинаковые имена в разных Project независимы;
- наследования нет: одноимённая Project-карта полностью затеняет
  Workspace-карту, слияние matrix запрещено;
- публикация создаёт неизменяемую forward-only ревизию `name@revision` с sha256
  по канонизированному содержимому; откат — публикация новой ревизии;
- новая revision атомарно делает прежнюю `superseded`; archive не возвращает
  прежнюю revision в active, поэтому rollback возможен только новой публикацией;
- запущенная делегация продолжает работать со своей запечатанной ревизией;
  edit/archive не действуют ретроактивно, архивная ревизия не запускается;
- model policy — human-owned allowlist провайдеров/моделей, budget задан явной
  схемой и не может быть превышен дочерним run;
- publish/archive требуют одноразового step-up approval, привязанного к exact
  `name@revision` и hash; registry требует code-minted Gateway `ApprovalProof`
  с exact lifecycle action hash и `stepUpVerified=true`;
- миграция legacy `.md` — только явная операция оператора с provenance
  `legacy-import`; silent-миграция запрещена.

Core-ядро registry реализовано в `runtime/agent-card-registry.ts`:
`publish`/`importLegacy`/`archive` принимают только одноразовый approval,
привязанный к exact scope, имени, номеру ревизии и canonical hash;
`resolveActive` возвращает Project-карту, полностью затеняющую Workspace-карту,
и не сливает их matrix; `resolveExact` оставляет архивную ревизию доступной для
аудита, но не для запуска; опубликованная ревизия неизменяема при мутации
исходного объекта. Durable-состояние хранится приватным атомарным JSON-файлом
(`0600`, каталог `0700`): валидация остаётся в core, адаптер только переносит
байты. При восстановлении отбрасывается ревизия, содержимое которой больше не
совпадает с её сохранённым hash, поэтому правка файла руками не становится
источником полномочий; повреждённое, слишком большое и отсутствующее состояние
дают пустой реестр. Telegram-поверхность показывает только redacted revision
metadata выбранной `AISY_MAIN_AGENT_CARD`, принимает exact одноимённый Markdown
draft следующим сообщением и удаляет его best-effort. Publish в
Workspace/current Project, archive и rollback новой revision проходят отдельный
Tier-3 step-up. DNA/body не попадает в lifecycle card или audit. CLI и
управление произвольными subagent-картами остаются отдельным удобством, не
security gate.

Object-level публикация не доверяет TypeScript-типу вызывающего кода: перед
hash она повторяет полный строгий schema gate loader'а, отклоняет unknown,
accessor, duplicate, malformed и reserved `general`/`builtin`, создаёт
отдельный deep-frozen snapshot и только его хэширует. Publish/archive сначала
успешно сохраняют следующее целое состояние и лишь затем меняют in-memory
authority и потребляют approval. Ошибка persistence оставляет прежнюю ревизию
активной и позволяет безопасно повторить тот же exact approval.

Registry state v2 сохраняет discriminated binding каждой revision. При чтении
schema v1 однозначные Workspace revisions восстанавливаются, а старые Project
revisions отбрасываются: в v1 отсутствовал `projectId`, поэтому их нельзя
безопасно привязать к текущему Project. Любая следующая успешная mutation пишет
целый state v2.

## 7. Критерии приёмки

1. **AC-20-1** — Markdown body реально присутствует в child model request.
2. **AC-20-2** — provider видит ровно tool schemas карты.
3. **AC-20-3** — неизвестный tool/Skill/MCP блокирует карту до model I/O.
4. **AC-20-4** — executor независимо отклоняет off-card tool.
5. **AC-20-5** — community DNA запускает narrowed child.
6. **AC-20-6** — malformed tier/budget/name/body/duplicate блокируется.
7. **AC-20-7** — unknown named card не заменяется builtin `general`.
8. **AC-20-8** — publish/archive требуют одноразового approval, привязанного к
   exact scope/имени/ревизии/hash; архивная ревизия не запускается, но остаётся
   доступной для аудита; ревизии переживают restart, а ревизия с расходящимся
   hash отбрасывается при восстановлении. Перевод live loader'а на registry и
   rollback через публикацию прежнего содержимого — отдельный шаг.
9. **AC-20-9** — выбранная main AgentCard ограничивает provider schemas,
   Skills, executor и iteration ceiling одним неизменяемым matrix snapshot;
   мутация исходного объекта после composition не меняет DNA/capabilities.
10. **AC-20-10** — отсутствующая или невалидная выбранная main AgentCard
    блокирует startup до model I/O; отсутствие самой opt-in настройки не
    активирует новый runtime автоматически.
11. **AC-20-11** — immutable delegation authority закрепляет exact DNA,
    capabilities, scope, binding и budget до provider construction; restart
    принимает только byte-equivalent verified seal, а route/capability drift
    блокируется до memory/provider/tool I/O.
12. **AC-20-12** — lifecycle registry отклоняет неполную/расширенную object-карту,
    accessor и reserved builtin authority до hash/persistence; опубликованный
    snapshot глубоко неизменяем, а отказ durable save не меняет in-memory
    active revision и не потребляет exact approval.
13. **AC-20-13** — Project revision и approval связаны с exact `projectId`;
    одинаковая карта другого Project не видна и не принимает чужое approval.
    Schema-v1 Project revisions не активируются, Workspace revisions мигрируют
    в state v2 при следующей успешной mutation.
14. **AC-20-14** — publish/import/archive отклоняют отсутствующий, не-step-up,
    подменённый или предназначенный другому lifecycle verb Gateway proof до
    persistence; модель и transport не могут заменить confirmer структурным
    объектом.
15. **AC-20-15** — на exact binding/name активна не более одной revision;
    publish supersede'ит предыдущую, archive оставляет ноль active, а rollback
    создаёт новую revision и не мутирует историю.
16. **AC-20-16** — exact `AISY_AGENT_CARD_REGISTRY=1` переводит main и non-builtin
    subagent loader на registry до provider I/O; отсутствие/архивирование
    fail-closed, снятие флага возвращает legacy loader без удаления registry.
17. **AC-20-17** — Telegram lifecycle UI подключён к production registry,
    публикует exact выбранный target в Workspace/current Project, архивирует и
    откатывает новой revision только через Tier-3 proof; draft удаляется
    best-effort, а UI/audit не содержат DNA.
18. **AC-20-18** — Telegram показывает bounded redacted-каталог exact Workspace
    и current Project Agent Cards и управляет произвольным target через
    principal/message/generation-bound one-use callback. Create, publish,
    archive, rollback и explicit descriptor-relative legacy import требуют
    canonical head/source/result envelope и genuine Tier-3 proof; stale,
    replay, Project drift и restart дают zero read/approval/mutation, а selector
    не изменяет настройки выбора main-карты или registry cutover.

Трассировка AC-20-8: `runtime/agent-card-registry.spec.ts` и
`app/agent-card-registry-store.spec.ts`.

Трассировка AC-20-12: `runtime/agent-cards.spec.ts` и
`runtime/agent-card-registry.spec.ts`.

Трассировка AC-20-11: `runtime/agent-capabilities.spec.ts` и
`runtime/sub-agent-runner.spec.ts`. Это core-only evidence, не доказательство
live app wiring.

Трассировка AC-20-18: `runtime/agent-card-registry.spec.ts`,
`app/agent-card-lifecycle-runtime.spec.ts`,
`telegram-gw/agent-card-catalog-view.spec.ts`,
`app/telegram-agent-card-state.spec.ts`, `app/bot-agent-card-catalog.spec.ts` и
`app/agent-card-catalog-composition.spec.ts`.

# Telegram-каталог Agent Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать оператору полный Telegram-каталог Workspace/current Project
Agent Cards с exact create, publish, archive, rollback и explicit legacy import,
не меняя runtime selection или cutover flag.

**Architecture:** Core остаётся единственной lifecycle authority: он строит и
повторно проверяет canonical mutation envelope, валидирует genuine Gateway proof
и атомарно сохраняет forward-only state. App добавляет target-oriented
controller и descriptor-relative legacy reader поверх существующего confinement
sidecar. Telegram получает только redacted projections и ephemeral one-use
tokens/forms, привязанные к principal, message, generation и current binding.

**Tech Stack:** TypeScript 5.5+, Node.js 22, pnpm 9, Vitest 2, grammY 1.30,
Python 3.12, pytest, существующий one-shot confinement worker.

## Global Constraints

- Проект во всех новых текстах и commits называется **Aisy**.
- Реализация не читает, не называет, не копирует и не публикует приватный
  reference-репозиторий.
- `AISY_MAIN_AGENT_CARD` и `AISY_AGENT_CARD_REGISTRY` не изменяются из UI.
- Selector выбирает только объект управления; runtime authority меняется лишь
  после отдельного restart/cutover оператора.
- Workspace и exact current Project не сливаются; Session scope не вводится.
- `general` и `provenance: builtin` остаются code-owned и не публикуются.
- Callback payload не превышает 64 bytes и не содержит raw name, projectId,
  content hash или DNA.
- Telegram UI, ошибки и transport logs содержат только scope, name, revision,
  status и 12-symbol hash prefix.
- Каждая Telegram-кнопка содержит смысловой текст, а не только emoji; форма
  заранее называет operation/scope, а callback немедленно снимает client spinner
  до долгого approval/I/O.
- Legacy import читает максимум 64 KiB UTF-8 только descriptor-relative; при
  отсутствии `dir_fd`/`O_NOFOLLOW` primitive операция fail-closed.
- Mutation proof потребляется только после успешного durable save и in-memory
  swap; retry после save failure разрешён, replay после commit/restart — нет.
- Исполнение ведётся в отдельном ignored worktree на ветке
  `codex/telegram-agent-card-catalog`; merge в `master` выполняется только после
  всех gates и повторной проверки актуального `master`.

---

## Карта файлов

### Core authority

- `packages/core-ts/src/runtime/agent-card-registry.ts` — canonical envelope,
  state machine, exact catalog и единственная mutation authority.
- `packages/core-ts/src/runtime/agent-card-registry.spec.ts` — adversarial,
  concurrency, retry/replay и catalog corpus.
- `packages/core-ts/src/index.ts` — публичные типы и функции lifecycle.

### App lifecycle и legacy I/O

- `packages/app/src/agent-card-lifecycle-runtime.ts` — target-oriented controller,
  redacted projections, Gateway approval и audit.
- `packages/app/src/agent-card-lifecycle-runtime.spec.ts` — create/update/import,
  rollback algorithm, binding drift и proof tests.
- `packages/app/src/agent-card-legacy-import.ts` — узкий adapter к one-shot
  confinement process port.
- `packages/app/src/agent-card-legacy-import.spec.ts` — protocol, name, size и
  redaction tests.
- `packages/app/src/agent-card-legacy-import.integration.spec.ts` — реальный
  Node→Python root-pin/replacement corpus.
- `packages/sidecars-py/aisy_sidecars/confinement_worker.py` — stable read
  rechecks descriptor/path/root после чтения.
- `packages/sidecars-py/tests/test_confinement_worker.py` — root/file replacement
  interleavings.
- `packages/app/src/agent-card-registry-store.spec.ts` и
  `packages/app/src/agent-card-live-selection.spec.ts` — адаптация существующих
  persistence/cutover доказательств к canonical envelope.

### Telegram projection и ephemeral state

- `packages/telegram-gw/src/agent-card-catalog-view.ts` — pure catalog/detail
  renderer и strict callback codec.
- `packages/telegram-gw/src/agent-card-catalog-view.spec.ts` — pagination,
  escaping, privacy и 64-byte corpus.
- `packages/telegram-gw/src/settings-tree.ts` — удаление старого single-card
  renderer/actions при сохранении entry screen.
- `packages/telegram-gw/src/settings-tree.spec.ts` — настройки больше не
  кодируют lifecycle authority напрямую.
- `packages/telegram-gw/src/index.ts` — экспорт нового pure view.
- `packages/app/src/telegram-agent-card-state.ts` — atomic one-use token registry
  и principal-bound pending forms.
- `packages/app/src/telegram-agent-card-state.spec.ts` — concurrent claim,
  wrong principal/message/generation, TTL, restart и binding drift.

### Live bot и composition

- `packages/app/src/bot.ts` — orchestration экранов, callbacks, message forms,
  best-effort deletion и redacted receipts.
- `packages/app/src/bot-agent-card-catalog.spec.ts` — реальный grammY handler
  corpus selector/CRUD, stale/replay, concurrency и DNA leak scan.
- `packages/app/src/bot-screen-forms.spec.ts` — удаление старой single-card form
  и совместимость остальных форм.
- `packages/app/src/bot-button-walk.spec.ts` — достижимость всех новых действий.
- `packages/app/src/bin/aisy.ts` — один registry для selection/catalog/mutations,
  exact `.aisy/agents` root и optional fail-closed sidecar composition.
- `packages/app/src/agent-card-live-selection.spec.ts` — source-level composition
  assertions и cutover invariants.

### Документация

- `docs/superpowers/specs/2026-08-12-telegram-agent-card-catalog-design.md` —
  итоговый статус и точные async/hash-prefix интерфейсы.
- `docs/decisions/2026-07-29-agent-card-lifecycle.md` — Telegram arbitrary-card
  lifecycle и canonical envelope clarification.
- `docs/specs/20-agent-dna-and-capability-matrix.md` — AC-20-18 и traceability.
- `docs/reviews/2026-08-08-production-readiness-matrix.md` — честный LIVE/dormant
  статус и проверенные gates.

---

### Task 1: Canonical Core lifecycle envelope и exact catalog

**Files:**

- Modify: `packages/core-ts/src/runtime/agent-card-registry.ts:10-491`
- Modify: `packages/core-ts/src/runtime/agent-card-registry.spec.ts:1-405`
- Modify: `packages/core-ts/src/index.ts:481-501`

**Interfaces:**

- Consumes: `AgentCard`, `ApprovalProof`, schema-v2 persistence port.
- Produces:

```ts
export type AgentCardLifecycleOperation =
  | 'create' | 'publish' | 'rollback' | 'import-legacy' | 'archive'

export type AgentCardTarget = Readonly<{
  binding: AgentCardBinding
  name: string
}>

export type AgentCardLifecycleHead = Readonly<{
  revision: number
  status: AgentCardStatus
  hash: string
}>

export type AgentCardLifecycleEnvelope = Readonly<{
  operation: AgentCardLifecycleOperation
  target: AgentCardTarget
  expectedHead: AgentCardLifecycleHead | null
  sourceRevision: number | null
  result: Readonly<{
    revision: number
    status: 'active' | 'archived'
    hash: string
  }>
}>

export type AgentCardLifecyclePlanInput =
  | Readonly<{ operation: 'create' | 'publish' | 'import-legacy'; target: AgentCardTarget; card: AgentCard }>
  | Readonly<{ operation: 'rollback' | 'archive'; target: AgentCardTarget }>

export interface AgentCardApproval {
  envelope: AgentCardLifecycleEnvelope
  approvedBy: string
  proof: ApprovalProof
}

export interface AgentCardCatalogEntry {
  binding: AgentCardBinding
  name: string
  activeRevision: number | null
  activeHashPrefix: string | null
  latestRevision: number
  latestHashPrefix: string
  latestStatus: AgentCardStatus
  revisionCount: number
}
```

`AgentCardRegistry` добавляет `catalog(binding)`, `planLifecycle(input)` и
`commitLifecycle({ envelope, card?, approval })`. Старые public mutation methods
`publish/importLegacy/archive/pendingApprovalTarget` удаляются после перевода
всех callers в рамках этого плана.

`AgentCardRegistryRefusal` явно добавляет `history-exists`, `history-empty`,
`not-active`, `rollback-source-missing` и `head-mismatch`; invalid/tampered
envelope/proof остаётся `approval-mismatch`.

- [ ] **Step 1: Написать failing catalog и state-machine tests**

Добавить проверки, которые сначала не компилируются из-за отсутствующих API:

```ts
it('enumerates exact bindings without card content', () => {
  const store = registry()
  commit(store, { operation: 'create', target: { binding: workspace, name: 'zeta' }, card: card({ name: 'zeta' }) })
  commit(store, { operation: 'create', target: { binding: workspace, name: 'alpha' }, card: card({ name: 'alpha' }) })
  commit(store, { operation: 'create', target: { binding: project('p1'), name: 'alpha' }, card: card({ name: 'alpha' }) })

  const view = store.catalog(workspace)
  expect(view.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
  expect(JSON.stringify(view)).not.toContain('instructions')
  expect(store.catalog(project('p2'))).toEqual([])
})

it('builds deterministic create publish archive and rollback envelopes', () => {
  const store = registry()
  const target = { binding: workspace, name: 'researcher' } as const
  const create = store.planLifecycle({ operation: 'create', target, card: card() })
  expect(create).toMatchObject({
    operation: 'create', expectedHead: null, sourceRevision: null,
    result: { revision: 1, status: 'active' },
  })
  commitPlan(store, create, card())
  expect(store.planLifecycle({ operation: 'archive', target })).toMatchObject({
    expectedHead: { revision: 1, status: 'active' },
    sourceRevision: null,
    result: { revision: 1, status: 'archived' },
  })
})
```

Test helpers строят proof через `agentCardLifecycleAction(envelope)` и всегда
передают тот же frozen envelope:

```ts
function approval(envelope: AgentCardLifecycleEnvelope): AgentCardApproval {
  const exact = agentCardLifecycleAction(envelope)
  return {
    envelope,
    approvedBy: 'operator',
    proof: {
      cardId: `card-${exact.actionHash.slice(0, 16)}`,
      ...exact,
      confirmedAt: '2026-08-12T10:00:00Z',
      stepUpVerified: true,
    },
  }
}

function commitPlan(
  store: AgentCardRegistry,
  envelope: AgentCardLifecycleEnvelope,
  value?: AgentCard,
): AgentCardRevision {
  return store.commitLifecycle({
    envelope,
    ...(value === undefined ? {} : { card: value }),
    approval: approval(envelope),
  })
}

function commit(store: AgentCardRegistry, input: AgentCardLifecyclePlanInput): AgentCardRevision {
  const planned = store.planLifecycle(input)
  return commitPlan(store, planned, 'card' in input ? input.card : undefined)
}
```

- [ ] **Step 2: Запустить Core test и подтвердить RED**

Run:

```bash
pnpm --filter @aisy/core exec vitest run src/runtime/agent-card-registry.spec.ts
```

Expected: FAIL на отсутствующих `catalog`, `planLifecycle`,
`commitLifecycle` и новых типах.

- [ ] **Step 3: Реализовать strict snapshots и domain-separated action v2**

`agentCardLifecycleAction` принимает только envelope и связывает все поля,
включая explicit null:

```ts
export function agentCardLifecycleAction(
  raw: AgentCardLifecycleEnvelope,
): Readonly<{ actionId: string; actionHash: string }> {
  const envelope = lifecycleEnvelopeSnapshot(raw)
  const actionId = `agent-card:${envelope.operation}:${envelope.target.name}:${envelope.result.revision}`
  const actionHash = createHash('sha256').update(JSON.stringify([
    'aisy.agent-card.lifecycle.v2',
    envelope.operation,
    bindingKey(envelope.target.binding),
    envelope.target.name,
    envelope.expectedHead === null ? null : [
      envelope.expectedHead.revision,
      envelope.expectedHead.status,
      envelope.expectedHead.hash,
    ],
    envelope.sourceRevision,
    envelope.result.revision,
    envelope.result.status,
    envelope.result.hash,
  ])).digest('hex')
  return Object.freeze({ actionId, actionHash })
}
```

Snapshot validators принимают только plain/null-prototype objects с exact keys,
не читают accessors и проверяют exact binding, name, safe integers, status и
64-symbol lowercase hashes.

- [ ] **Step 4: Реализовать deterministic planner**

Planner использует exact `forCard`, а не fallback-capable `resolveActive`:

```ts
const head = history.at(-1) ?? null
const expectedHead = head === null ? null : headSnapshot(head)
const lastWhere = <T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return item
  }
  return undefined
}

switch (input.operation) {
  case 'create':
  case 'import-legacy':
    if (head !== null) throw new AgentCardRegistryError('history-exists')
    return envelope(input.operation, input.target, null, null, 1, 'active', hash(input.card))
  case 'publish':
    if (head === null) throw new AgentCardRegistryError('history-empty')
    return envelope('publish', input.target, expectedHead, null,
      head.revision + 1, 'active', hash(input.card))
  case 'archive': {
    const active = lastWhere(history, item => item.status === 'active')
    if (active === undefined || active !== head) throw new AgentCardRegistryError('not-active')
    return envelope('archive', input.target, expectedHead, null,
      active.revision, 'archived', active.hash)
  }
  case 'rollback': {
    if (head === null) throw new AgentCardRegistryError('history-empty')
    const source = head.status === 'active'
      ? lastWhere(history, item => item.revision < head.revision)
      : head
    if (source === undefined) throw new AgentCardRegistryError('rollback-source-missing')
    return envelope('rollback', input.target, expectedHead, source.revision,
      head.revision + 1, 'active', source.hash)
  }
}
```

Для одной archived revision rollback копирует revision 1 в revision 2; repeated
rollback всегда берёт численно предыдущую revision, включая rollback revision.

- [ ] **Step 5: Реализовать atomic commit и exact catalog**

`commitLifecycle` выполняет последовательность:

```ts
const checkedEnvelope = lifecycleEnvelopeSnapshot(input.envelope)
const recomputed = planLifecycle(planInputFromCommit(checkedEnvelope, input.card))
assertSameEnvelope(checkedEnvelope, recomputed)
const checkedApproval = validateApproval(input.approval, checkedEnvelope)
const approvalIdentity = assertUnused(checkedApproval)
const next = buildNextState(checkedEnvelope, input.card)
persist(next)
revisions = next
usedApprovals.add(approvalIdentity)
return exactResultRevision(next, checkedEnvelope)
```

`buildNextState` меняет только lifecycle status старой active revision либо
добавляет новый deeply-frozen snapshot. `catalog` группирует exact binding/name,
сортирует `name` byte-stable и возвращает frozen metadata без `card`, full hash
или `publishedAt`.

Durable validation перед catalog/resolve группирует revisions по exact
binding/name и принимает историю только если номера contiguous от 1, latest
status — `active|archived`, ни одна более ранняя revision не active, а
`legacy-import` встречается только у revision 1. Группа с gap, duplicate active,
latest `superseded` или поздним legacy provenance отбрасывается целиком вместо
частичного каталога.

- [ ] **Step 6: Добавить adversarial/retry/restart tests**

Покрыть exact cases; основной retry/concurrency corpus выглядит так:

```ts
it('does not spend a create proof on a publish-shaped envelope', () => {
  const store = registry()
  const target = { binding: workspace, name: 'researcher' } as const
  const value = card()
  const created = store.planLifecycle({ operation: 'create', target, card: value })
  const tampered = { ...created, operation: 'publish' as const }
  expect(() => store.commitLifecycle({
    envelope: tampered, card: value, approval: approval(created),
  })).toThrowError(expect.objectContaining({ reason: 'approval-mismatch' }))
  expect(commitPlan(store, created, value).revision).toBe(1)
})

it('retries the same proof after save failure but rejects it after commit', () => {
  let fail = true
  const store = makeAgentCardRegistry({
    persistence: {
      load: () => undefined,
      save: () => { if (fail) throw new Error('disk full') },
    },
    nowIso: () => '2026-08-12T10:00:00Z',
  })
  const value = card()
  const target = { binding: workspace, name: value.name }
  const planned = store.planLifecycle({ operation: 'create', target, card: value })
  const once = approval(planned)
  expect(() => store.commitLifecycle({ envelope: planned, card: value, approval: once })).toThrow('disk full')
  fail = false
  expect(store.commitLifecycle({ envelope: planned, card: value, approval: once }).revision).toBe(1)
  expect(() => store.commitLifecycle({ envelope: planned, card: value, approval: once }))
    .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
})

it('rejects a concurrent head change after confirmation', () => {
  const store = registry()
  const target = { binding: workspace, name: 'researcher' } as const
  const a = card({ instructions: 'A' })
  const b = card({ instructions: 'B' })
  const plannedA = store.planLifecycle({ operation: 'create', target, card: a })
  const plannedB = store.planLifecycle({ operation: 'create', target, card: b })
  commitPlan(store, plannedB, b)
  expect(() => commitPlan(store, plannedA, a))
    .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
})

it('restores one archived revision as revision two and uses numeric previous rollback source', () => {
  const store = registry()
  const target = { binding: workspace, name: 'researcher' } as const
  commit(store, { operation: 'create', target, card: card() })
  commit(store, { operation: 'archive', target })
  const restore = store.planLifecycle({ operation: 'rollback', target })
  expect(restore.sourceRevision).toBe(1)
  expect(commitPlan(store, restore).revision).toBe(2)
  const repeated = store.planLifecycle({ operation: 'rollback', target })
  expect(repeated.sourceRevision).toBe(1)
  expect(commitPlan(store, repeated).revision).toBe(3)
  expect(store.planLifecycle({ operation: 'rollback', target }).sourceRevision).toBe(2)
})

it('rejects a committed proof after restart from durable state', () => {
  let durable: AgentCardRegistryStateV2 | undefined
  const persistence: AgentCardRegistryPersistencePort = {
    load: () => durable,
    save: state => { durable = structuredClone(state) },
  }
  const value = card()
  const target = { binding: workspace, name: value.name }
  const first = makeAgentCardRegistry({ persistence, nowIso: () => '2026-08-12T10:00:00Z' })
  const planned = first.planLifecycle({ operation: 'create', target, card: value })
  const once = approval(planned)
  first.commitLifecycle({ envelope: planned, card: value, approval: once })
  const restarted = makeAgentCardRegistry({ persistence, nowIso: () => '2026-08-12T10:01:00Z' })
  expect(() => restarted.commitLifecycle({ envelope: planned, card: value, approval: once }))
    .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
})
```

Тем же helper corpus проверить publish-proof→rollback, rollback-proof→archive,
import-proof→create и malformed schema-v2 catalog; после каждого refusal
оригинальный proof должен оставаться пригодным ровно для своего envelope.

- [ ] **Step 7: Запустить Core test и typecheck**

Run:

```bash
pnpm --filter @aisy/core exec vitest run src/runtime/agent-card-registry.spec.ts
pnpm --filter @aisy/core typecheck
```

Expected: PASS; typecheck exit 0.

- [ ] **Step 8: Commit Core authority**

```bash
git add packages/core-ts/src/runtime/agent-card-registry.ts packages/core-ts/src/runtime/agent-card-registry.spec.ts packages/core-ts/src/index.ts
git commit -m "feat(agent-cards): закрепить lifecycle envelope и каталог"
```

---

### Task 2: Descriptor-stable legacy reader

**Files:**

- Modify: `packages/sidecars-py/aisy_sidecars/confinement_worker.py:130-239,510-527`
- Modify: `packages/sidecars-py/tests/test_confinement_worker.py:1-320`
- Modify: `packages/core-ts/src/runtime/confinement.ts:33-50`
- Create: `packages/app/src/agent-card-legacy-import.ts`
- Create: `packages/app/src/agent-card-legacy-import.spec.ts`
- Create: `packages/app/src/agent-card-legacy-import.integration.spec.ts`

**Interfaces:**

- Consumes: `ConfinementProcessPort.run(request)` and fixed absolute
  `.aisy/agents` root.
- Produces:

```ts
export interface AgentCardLegacyImportPort {
  readExact(name: string): Promise<string>
}

export function makeAgentCardLegacyImportPort(input: {
  root: string
  process: ConfinementProcessPort
  newId: () => string
}): AgentCardLegacyImportPort
```

`ConfinementWorkerRequest` получает два optional decimal-string поля,
`expectedRootDevice` и `expectedRootInode`. Generic confinement callers их не
передают; legacy adapter обязан передавать оба.

- [ ] **Step 1: Написать failing Python interleaving tests**

```py
def test_read_refuses_in_place_change_during_descriptor_read(tmp_path, monkeypatch):
    target = tmp_path / "researcher.md"
    target.write_text("first", encoding="utf-8")
    original = worker._read_all

    def mutate(fd: int, maximum: int) -> bytes:
        payload = original(fd, maximum)
        target.write_text("second", encoding="utf-8")
        return payload

    monkeypatch.setattr(worker, "_read_all", mutate)
    assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"

def test_request_refuses_root_replacement_after_descriptor_open(tmp_path, monkeypatch):
    target = tmp_path / "researcher.md"
    target.write_text("trusted", encoding="utf-8")
    detached = tmp_path.parent / f"{tmp_path.name}-detached"
    original = worker._read

    def replace_root(root_fd, root_device, request_value):
        result = original(root_fd, root_device, request_value)
        os.rename(tmp_path, detached)
        tmp_path.mkdir()
        (tmp_path / "researcher.md").write_text("replacement", encoding="utf-8")
        return result

    monkeypatch.setattr(worker, "_read", replace_root)
    assert failure(tmp_path, "read", path="researcher.md", maxBytes=65536) == "PATH_CHANGED"
    assert (tmp_path / "researcher.md").read_text(encoding="utf-8") == "replacement"
```

Test cleanup удаляет `detached` через fixture-owned parent cleanup либо явный
`shutil.rmtree(detached)` в `finally`, чтобы corpus не оставлял residue.

Добавить ещё два deterministic interleaving cases:

| Interleaving | Injection point | Expected |
|---|---|---|
| file entry replacement | после `_lstat(parent_fd, name)`, до `os.open(..., dir_fd=parent_fd)` | `_verify_identity` возвращает `PATH_CHANGED`; replacement bytes не выдаются |
| root entry replacement | после pre-open `os.stat(root, follow_symlinks=False)`, до `os.open(root, O_DIRECTORY|O_NOFOLLOW)` | root fd identity mismatch либо `SYMLINK_DENIED`; handler не вызывается |

- [ ] **Step 2: Запустить pytest и подтвердить RED**

Run:

```bash
cd packages/sidecars-py && uv run pytest tests/test_confinement_worker.py -q
```

Expected: новый in-place/root replacement corpus FAIL, потому что post-read
identity/stability ещё не проверяется.

- [ ] **Step 3: Усилить `_read` и root post-check**

После `_read_all` и до закрытия descriptors проверять:

```py
opened_after = os.fstat(file_fd)
_verify_identity(info, opened_after)
if (
    opened_after.st_size != info.st_size
    or opened_after.st_mtime_ns != info.st_mtime_ns
    or opened_after.st_ctime_ns != info.st_ctime_ns
):
    _fail("PATH_CHANGED")
current = _lstat(parent_fd, parts[-1])
_verify_identity(info, current)
_reject_unsafe_node(current, root_device)
```

`handle_request` сохраняет `root_info = os.fstat(root_fd)` и после handler
сравнивает его с `os.stat(root, follow_symlinks=False)`; symlink, disappearance
или identity drift дают code-only refusal. Чтение всё время идёт через уже
открытые `root_fd → parent_fd → file_fd`.

Если request содержит pinned identity, `_open_root` до handler проверяет:

```py
expected_device = _required_decimal(request, "expectedRootDevice")
expected_inode = _required_decimal(request, "expectedRootInode")
opened = os.fstat(root_fd)
if opened.st_dev != expected_device or opened.st_ino != expected_inode:
    _fail("PATH_CHANGED")
```

Оба поля должны присутствовать вместе; malformed/negative/oversized decimal
возвращает `INVALID_REQUEST`.

- [ ] **Step 4: Написать failing TypeScript adapter tests**

```ts
it('sends one exact bounded read request without listing the directory', async () => {
  const requests: ConfinementWorkerRequest[] = []
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-legacy-card-')))
  const identity = statSync(root, { bigint: true })
  const port = makeAgentCardLegacyImportPort({
    root,
    newId: () => 'legacy-1',
    process: { run: async request => {
      requests.push(request)
      return { version: 1, requestId: 'legacy-1', ok: true, data: { text: CARD, bytes: Buffer.byteLength(CARD) } }
    } },
  })
  await expect(port.readExact('researcher')).resolves.toBe(CARD)
  expect(requests).toEqual([{
    version: 1, requestId: 'legacy-1', root,
    op: 'read', path: 'researcher.md', maxBytes: 65536,
    expectedRootDevice: identity.dev.toString(),
    expectedRootInode: identity.ino.toString(),
  }])
})

it('rejects unsafe names before process I/O', async () => {
  let calls = 0
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-legacy-card-')))
  const port = makeAgentCardLegacyImportPort({
    root,
    newId: () => 'legacy-2',
    process: { run: async () => {
      calls += 1
      throw new Error('must not run')
    } },
  })
  for (const name of ['../escape', 'a/b', 'general', 'UPPER', '']) {
    await expect(port.readExact(name)).rejects.toMatchObject({ code: 'INVALID_NAME' })
  }
  expect(calls).toBe(0)
})
```

Проверить mismatched requestId, malformed envelope, oversized byte count,
worker error и thrown process error как стабильный
`AgentCardLegacyImportError(code)` без root/name/content в message.

Real Node→Python integration test закрепляет pin across calls:

```ts
it('rejects root replacement after adapter construction', async () => {
  const root = join(tempRoot, 'agents')
  mkdirSync(root)
  writeFileSync(join(root, 'researcher.md'), CARD)
  const port = makeAgentCardLegacyImportPort({ root, process: realProcess, newId: () => 'legacy-real-1' })
  renameSync(root, join(tempRoot, 'agents-detached'))
  mkdirSync(root)
  writeFileSync(join(root, 'researcher.md'), REPLACEMENT_CARD)
  await expect(port.readExact('researcher')).rejects.toMatchObject({ code: 'PATH_CHANGED' })
})
```

- [ ] **Step 5: Реализовать narrow protocol adapter**

Adapter делает `realpathSync`, требует exact equality canonical input и
directory `lstat/stat` без symlink, сохраняет bigint `(dev, ino)`, затем
передаёт decimal pin worker'у на каждом вызове. Name проверяется по
`^[a-z0-9][a-z0-9-]{0,63}$`, запрещает `general`, формирует только `read`
request и строго валидирует response envelope/UTF-8 byte count. Он не вызывает
`list`, не принимает произвольный path и не логирует response body.

- [ ] **Step 6: Запустить targeted Python/App tests**

Run:

```bash
cd packages/sidecars-py && uv run pytest tests/test_confinement_worker.py -q
cd ../.. && pnpm --filter @aisy/app exec vitest run src/agent-card-legacy-import.spec.ts src/agent-card-legacy-import.integration.spec.ts src/confinement-sidecar.spec.ts
pnpm --filter @aisy/core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit stable legacy reader**

```bash
git add packages/sidecars-py/aisy_sidecars/confinement_worker.py packages/sidecars-py/tests/test_confinement_worker.py packages/core-ts/src/runtime/confinement.ts packages/app/src/agent-card-legacy-import.ts packages/app/src/agent-card-legacy-import.spec.ts packages/app/src/agent-card-legacy-import.integration.spec.ts
git commit -m "feat(agent-cards): читать legacy карту через confined fd"
```

---

### Task 3: Target-oriented App lifecycle controller

**Files:**

- Modify: `packages/app/src/agent-card-lifecycle-runtime.ts:1-221`
- Modify: `packages/app/src/agent-card-lifecycle-runtime.spec.ts:1-165`
- Modify: `packages/app/src/agent-card-registry-store.spec.ts:1-235`
- Modify: `packages/app/src/agent-card-live-selection.spec.ts:1-90`

**Interfaces:**

- Consumes: Core `catalog/planLifecycle/commitLifecycle`, legacy import port,
  `PendingAction → ApprovalDecision` confirmer.
- Produces:

```ts
export interface AgentCardCatalogView {
  configuredName: string
  cutoverActive: boolean
  currentBinding: AgentCardBinding
  projectScopeAvailable: boolean
  legacyImportAvailable: boolean
  workspace: readonly AgentCardCatalogEntry[]
  project: readonly AgentCardCatalogEntry[]
}

export interface AgentCardLifecycleView {
  target: AgentCardTarget
  active: null | { revision: number; status: 'active'; hashPrefix: string }
  history: readonly { revision: number; status: AgentCardStatus; hashPrefix: string }[]
}

export interface AgentCardLifecycleRuntime {
  catalog(): AgentCardCatalogView
  detail(target: AgentCardTarget): AgentCardLifecycleView
  createDraft(input: { markdown: string; binding: AgentCardBinding; approve: Approver }): Promise<AgentCardRevision>
  publishDraft(input: { target: AgentCardTarget; markdown: string; approve: Approver }): Promise<AgentCardRevision>
  archive(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
  rollback(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
  importLegacy(input: { target: AgentCardTarget; approve: Approver }): Promise<AgentCardRevision>
}
```

Factory принимает `currentBinding: () => AgentCardBinding`, `configuredName`,
`cutoverActive`, `approvedBy`, optional `legacy`, `emit` и `nowIso`.

- [ ] **Step 1: Переписать tests на arbitrary exact targets и получить RED**

Добавить общий `makeRuntime()` fixture и начать с двух полных cases:

```ts
it('creates two names and returns separate Workspace/current Project catalogs', async () => {
  const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
  const runtime = makeAgentCardLifecycleRuntime({
    registry,
    configuredName: 'main',
    cutoverActive: false,
    currentBinding: () => ({ scope: 'project', projectId: 'project-a' }),
    approvedBy: 'operator-a',
  })
  await runtime.createDraft({
    markdown: draft('Alpha DNA.').replace('name: researcher', 'name: alpha'),
    binding: { scope: 'workspace' },
    approve: confirmer([]),
  })
  await runtime.createDraft({
    markdown: draft('Reviewer DNA.').replace('name: researcher', 'name: reviewer'),
    binding: { scope: 'project', projectId: 'project-a' },
    approve: confirmer([]),
  })
  expect(runtime.catalog().workspace.map(entry => entry.name)).toEqual(['alpha'])
  expect(runtime.catalog().project.map(entry => entry.name)).toEqual(['reviewer'])
})

it('refuses rename and Project drift before legacy read or approval', async () => {
  let binding: AgentCardBinding = { scope: 'project', projectId: 'project-a' }
  let reads = 0
  const approvals: PendingAction[] = []
  const runtime = makeAgentCardLifecycleRuntime({
    registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
    configuredName: '',
    cutoverActive: false,
    currentBinding: () => binding,
    approvedBy: 'operator-a',
    legacy: { readExact: async () => { reads += 1; return draft('Legacy DNA.') } },
  })
  const target = { binding, name: 'researcher' } as const
  binding = { scope: 'project', projectId: 'project-b' }
  await expect(runtime.importLegacy({ target, approve: confirmer(approvals) }))
    .rejects.toMatchObject({ code: 'AGENT_CARD_BINDING_STALE' })
  expect(reads).toBe(0)
  expect(approvals).toEqual([])
})
```

Остальной exact matrix использует те же fixtures:

| Case | Setup | Assertion |
|---|---|---|
| create/publish distinction | empty history, затем existing history | publish на empty → `AGENT_CARD_HISTORY_EMPTY`; create на existing → `AGENT_CARD_HISTORY_EXISTS` |
| update rename | target `researcher`, draft `reviewer` | `AGENT_CARD_NAME_MISMATCH`, zero approval/mutation |
| drift during legacy read | legacy port меняет current binding перед resolve | second binding check → `AGENT_CARD_BINDING_STALE`, zero approval/mutation |
| rollback | one active, затем archive | active-only → `AGENT_CARD_HISTORY_EMPTY`; archived rev1 → active rev2 |
| audit privacy | все пять verbs с marker в instructions | event names distinct; serialized payload не содержит marker/full hash |

Run:

```bash
pnpm --filter @aisy/app exec vitest run src/agent-card-lifecycle-runtime.spec.ts
```

Expected: FAIL на новом controller contract.

- [ ] **Step 2: Реализовать binding/target snapshots и redacted views**

Каждый public method сначала snapshot'ит current binding и target. Project
target принимается только если он byte-equal current Project binding; Workspace
target всегда exact `{scope:'workspace'}`. `detail` читает только
`registry.history(target.binding, target.name)` и не использует Workspace
fallback.

- [ ] **Step 3: Реализовать общий approval/commit path**

```ts
const commit = async (
  planInput: AgentCardLifecyclePlanInput,
  approve: Approver,
): Promise<AgentCardRevision> => {
  const envelope = input.registry.planLifecycle(planInput)
  const exact = agentCardLifecycleAction(envelope)
  const decision = await approve({
    ...exact,
    tier: 3,
    requiresStepUp: true,
    summary: lifecycleSummary(envelope),
  })
  const proof = requireExactStepUp(decision, exact)
  const result = input.registry.commitLifecycle({
    envelope,
    ...('card' in planInput ? { card: planInput.card } : {}),
    approval: { envelope, approvedBy: input.approvedBy, proof },
  })
  try {
    emitRedacted(envelope.operation, result)
  } catch {
    // Audit is non-load-bearing after the durable commit.
  }
  return result
}
```

Summary и audit содержат hash prefix, не full hash. После `await approve` Core
повторно проверяет envelope against current state. Audit failure не меняет уже
сохранённый результат и покрывается отдельным test с throwing emitter.

- [ ] **Step 4: Реализовать create/publish/import/rollback contracts**

- `createDraft`: max 64 KiB → strict parser → name из card → exact empty history.
- `publishDraft`: max 64 KiB → strict parser → exact target name → existing history.
- `archive/rollback`: exact target → Core planner.
- `importLegacy`: validate binding/target → `await legacy.readExact(name)` →
  повторная binding check → strict parser/name match → Core plan/approval/commit.

Ни один error message не включает Markdown, path, full hash или raw worker error.

- [ ] **Step 5: Перевести persistence/live-selection tests на envelope helpers**

В двух существующих spec files заменить старые `publish/archive` helpers на:

```ts
const planned = registry.planLifecycle({ operation, target, ...cardInput })
registry.commitLifecycle({
  envelope: planned,
  ...cardInput,
  approval: approval(planned),
})
```

Сохранить прежние assertions: restart, schema-v1 fail-closed, exact Project,
private mode, cutover off/on и missing/archived refusal.

- [ ] **Step 6: Запустить targeted App suite и typecheck**

```bash
pnpm --filter @aisy/app exec vitest run src/agent-card-lifecycle-runtime.spec.ts src/agent-card-registry-store.spec.ts src/agent-card-live-selection.spec.ts
pnpm --filter @aisy/app typecheck
```

Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit target-oriented lifecycle**

```bash
git add packages/app/src/agent-card-lifecycle-runtime.ts packages/app/src/agent-card-lifecycle-runtime.spec.ts packages/app/src/agent-card-registry-store.spec.ts packages/app/src/agent-card-live-selection.spec.ts
git commit -m "feat(agent-cards): управлять exact target через lifecycle"
```

---

### Task 4: Pure Telegram catalog/detail view и callback codec

**Files:**

- Create: `packages/telegram-gw/src/agent-card-catalog-view.ts`
- Create: `packages/telegram-gw/src/agent-card-catalog-view.spec.ts`
- Modify: `packages/telegram-gw/src/settings-tree.ts:8-78,353-406`
- Modify: `packages/telegram-gw/src/settings-tree.spec.ts:3-202`
- Modify: `packages/telegram-gw/src/index.ts:8-25`

**Interfaces:**

- Consumes: уже tokenized redacted catalog/detail models.
- Produces:

```ts
export type AgentCardCallbackVerb =
  | 'select' | 'page' | 'create' | 'import' | 'publish'
  | 'archive' | 'rollback' | 'catalog'

export type AgentCardCallback = Readonly<{
  verb: AgentCardCallbackVerb
  token: string
}>

export function encodeAgentCardCallback(value: AgentCardCallback): string
export function decodeAgentCardCallback(data: string): AgentCardCallback | null
export function renderAgentCardCatalog(input: TokenizedAgentCardCatalog): SettingsView
export function renderAgentCardDetail(input: TokenizedAgentCardDetail): SettingsView
```

Callback format: `ac:v1:<verb>:<16..24 base64url token>`. Codec отвергает extra
segments, unknown verbs, invalid alphabet/length и payload >64 bytes.

- [ ] **Step 1: Написать failing codec/render tests**

```ts
it('renders independent bounded Workspace and current Project pages', () => {
  const view = renderAgentCardCatalog(fixture({ workspace: 9, project: 9 }))
  expect(view.text).toContain('Workspace · 1/2')
  expect(view.text).toContain('Текущий Project · 1/2')
  expect(view.text.match(/@/g)?.length).toBeLessThanOrEqual(16)
})

it('keeps raw identities and DNA out of callbacks and text', () => {
  const view = renderAgentCardDetail(detailFixture({ marker: 'PRIVATE-DNA-MARKER' }))
  const corpus = JSON.stringify(view)
  expect(corpus).not.toContain('project-a')
  expect(corpus).not.toContain('PRIVATE-DNA-MARKER')
  expect(view.buttons.flat().every(button => Buffer.byteLength(button.data) <= 64)).toBe(true)
})
```

- [ ] **Step 2: Запустить Telegram test и подтвердить RED**

```bash
pnpm --filter @aisy/telegram-gw exec vitest run src/agent-card-catalog-view.spec.ts
```

Expected: FAIL, module отсутствует.

- [ ] **Step 3: Реализовать strict codec и bounded renderers**

Catalog получает уже разделённые page slices максимум по 8 entries и только
token strings. Renderer выводит `name`, active/latest revision,
`latestHashPrefix`, status; detail — последние 8 revisions. Все operator-visible
strings проходят `escapeHtml`.

Текст явно говорит:

```text
Выбор здесь не меняет AISY_MAIN_AGENT_CARD и не включает registry cutover.
Опубликованные ревизии станут runtime authority только после отдельного restart/cutover.
```

Project create/import buttons передаются renderer только при Project binding.

- [ ] **Step 4: Удалить старые lifecycle callbacks из settings tree**

Удалить `agent-card-draft/archive/rollback` из `SettingsAction`, соответствующие
decoder branches и `renderAgentCardsScreen`. Оставить `agent-cards` как
`SettingsScreen`, чтобы кнопка `🧬 Agent Cards` продолжала открывать новый flow.

- [ ] **Step 5: Запустить Telegram package tests**

```bash
pnpm --filter @aisy/telegram-gw exec vitest run src/agent-card-catalog-view.spec.ts src/settings-tree.spec.ts
pnpm --filter @aisy/telegram-gw typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit pure Telegram view**

```bash
git add packages/telegram-gw/src/agent-card-catalog-view.ts packages/telegram-gw/src/agent-card-catalog-view.spec.ts packages/telegram-gw/src/settings-tree.ts packages/telegram-gw/src/settings-tree.spec.ts packages/telegram-gw/src/index.ts
git commit -m "feat(telegram): показать redacted каталог Agent Cards"
```

---

### Task 5: Ephemeral callback generations и principal-bound forms

**Files:**

- Create: `packages/app/src/telegram-agent-card-state.ts`
- Create: `packages/app/src/telegram-agent-card-state.spec.ts`

**Interfaces:**

- Consumes: exact `AgentCardTarget/Binding`, random token source, monotonic
  `nowMs`.
- Produces:

```ts
export type AgentCardPrincipal = Readonly<{ chatId: number; userId: number }>

export type AgentCardIntent =
  | Readonly<{ kind: 'catalog'; workspacePage: number; projectPage: number }>
  | Readonly<{ kind: 'select'; target: AgentCardTarget }>
  | Readonly<{ kind: 'create'; binding: AgentCardBinding }>
  | Readonly<{ kind: 'import'; binding: AgentCardBinding }>
  | Readonly<{ kind: 'publish' | 'archive' | 'rollback'; target: AgentCardTarget }>

export type AgentCardPendingForm = Readonly<{
  formId: string
  principal: AgentCardPrincipal
  operation: 'create' | 'publish' | 'import-legacy'
  binding: AgentCardBinding
  target: AgentCardTarget | null
  createdAtMs: number
  expiresAtMs: number
}>

export interface TelegramAgentCardState {
  prepare(input: { principal: AgentCardPrincipal; intents: readonly AgentCardIntent[] }): PreparedGeneration
  claimCallback(input: {
    principal: AgentCardPrincipal; messageId: number; verb: AgentCardCallbackVerb; token: string
  }): AgentCardIntent | null
  openForm(input: Omit<AgentCardPendingForm, 'formId' | 'createdAtMs' | 'expiresAtMs'>): AgentCardPendingForm
  claimForm(principal: AgentCardPrincipal):
    | Readonly<{ kind: 'claimed'; form: AgentCardPendingForm; finish(): void }>
    | Readonly<{ kind: 'busy' }>
    | Readonly<{ kind: 'foreign' }>
    | Readonly<{ kind: 'none' }>
  invalidate(principal: AgentCardPrincipal): void
}
```

`PreparedGeneration` возвращает tokenized intents, `bind(messageId)` и
`discard()`. До bind tokens не claimable.

- [ ] **Step 1: Написать complete state corpus и получить RED**

```ts
const P = { chatId: 1, userId: 1 } as const
const SELECT = {
  kind: 'select',
  target: { binding: { scope: 'workspace' }, name: 'researcher' },
} as const

let nowMs = 1_000
let tokenNumber = 0
const state = makeTelegramAgentCardState({
  nowMs: () => nowMs,
  newToken: () => `token_${String(++tokenNumber).padStart(10, '0')}`,
})

it('allows exactly one of two concurrent callback claims', () => {
  const prepared = state.prepare({ principal: P, intents: [SELECT] })
  prepared.bind(77)
  expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toEqual(SELECT)
  expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
})

it('does not retire a token for wrong principal or message', () => {
  const prepared = state.prepare({ principal: P, intents: [SELECT] })
  prepared.bind(77)
  const callback = prepared.callbacks[0]!
  expect(state.claimCallback({ principal: { chatId: 2, userId: 1 }, messageId: 77, ...callback })).toBeNull()
  expect(state.claimCallback({ principal: { chatId: 1, userId: 2 }, messageId: 77, ...callback })).toBeNull()
  expect(state.claimCallback({ principal: P, messageId: 78, ...callback })).toBeNull()
  expect(state.claimCallback({ principal: P, messageId: 77, ...callback })).toEqual(SELECT)
})

it('atomically replaces and claims one form per principal', () => {
  const first = state.openForm({
    principal: P, operation: 'create', binding: { scope: 'workspace' }, target: null,
  })
  const second = state.openForm({
    principal: P, operation: 'import-legacy', binding: { scope: 'workspace' }, target: null,
  })
  expect(second.formId).not.toBe(first.formId)
  expect(state.claimForm({ chatId: 1, userId: 2 })).toEqual({ kind: 'foreign' })
  const claimed = state.claimForm(P)
  expect(claimed).toMatchObject({ kind: 'claimed', form: second })
  expect(state.claimForm(P)).toEqual({ kind: 'busy' })
  if (claimed.kind !== 'claimed') throw new Error('claimed form expected')
  claimed.finish()
  expect(state.claimForm(P)).toEqual({ kind: 'none' })
})

it('expires tokens and forms without durable resurrection', () => {
  const prepared = state.prepare({ principal: P, intents: [SELECT] })
  prepared.bind(77)
  state.openForm({
    principal: P, operation: 'create', binding: { scope: 'workspace' }, target: null,
  })
  nowMs += 5 * 60_000 + 1
  expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
  expect(state.claimForm(P)).toEqual({ kind: 'none' })
  const restarted = makeTelegramAgentCardState({ nowMs: () => nowMs, newToken: () => 'token_0000000001' })
  expect(restarted.claimForm(P)).toEqual({ kind: 'none' })
  expect(restarted.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
})
```

Run:

```bash
pnpm --filter @aisy/app exec vitest run src/telegram-agent-card-state.spec.ts
```

Expected: FAIL, module отсутствует.

- [ ] **Step 2: Реализовать bounded token registry**

Использовать `Map<principalKey, Generation>` и global issued-token set с caps:

```ts
const TOKEN = /^[A-Za-z0-9_-]{16,24}$/
const MAX_INTENTS = 64
const TOKEN_TTL_MS = 5 * 60_000
const FORM_TTL_MS = 5 * 60_000
```

`prepare` инвалидирует прежнюю generation principal, проверяет uniqueness и
создаёт frozen records. `claimCallback` сначала проверяет principal/message,
verb/token/expiry, затем синхронно удаляет всю generation до возврата intent;
никакого `await` внутри claim нет. `MAX_ISSUED_TOKENS = 100_000` закрывает
неограниченный рост replay set; исчерпание token space fail-closed.

- [ ] **Step 3: Реализовать forms**

`openForm` отменяет прежнюю form только того же principal. `claimForm` сначала
ищет exact principal; если в том же chat есть только чужая active form,
возвращает `foreign` без удаления. Exact match проверяет TTL и синхронно удаляет
form до возврата `claimed`, одновременно ставя principal-bound in-flight
tombstone. До вызова idempotent `finish()` повторный exact delivery получает
`busy` и игнорируется. State не имеет persistence API, поэтому новый process
всегда начинает с пустых maps.

- [ ] **Step 4: Запустить state tests и typecheck**

```bash
pnpm --filter @aisy/app exec vitest run src/telegram-agent-card-state.spec.ts
pnpm --filter @aisy/app typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit ephemeral state**

```bash
git add packages/app/src/telegram-agent-card-state.ts packages/app/src/telegram-agent-card-state.spec.ts
git commit -m "feat(telegram): привязать AgentCard callbacks к экрану"
```

---

### Task 6: grammY selector/CRUD integration

**Files:**

- Modify: `packages/app/src/bot.ts:47-100,559-562,648-770,896-1014,2245-2461,2921-2957`
- Create: `packages/app/src/bot-agent-card-catalog.spec.ts`
- Modify: `packages/app/src/bot-screen-forms.spec.ts:1-260`
- Modify: `packages/app/src/bot-button-walk.spec.ts:180-500`

**Interfaces:**

- Consumes: target-oriented lifecycle runtime, pure Telegram view/codec,
  ephemeral state, `ctx.from.id`, exact `captureWorkBinding`, Gateway confirmer.
- Produces: live catalog/detail/create/publish/archive/rollback/import UX.

`TelegramBotDeps` добавляет только test seams:

```ts
newAgentCardToken?: () => string
agentCardNowMs?: () => number
```

- [ ] **Step 1: Написать handler tests и получить RED**

Harness `setupAgentCardBot()` должен seed Workspace/Project entries,
перехватывать Telegram API, expose `handle(update)`, `latestButton(prefix)` и
считать lifecycle/approval/delete calls. Критичный concurrent test:

```ts
it('spends one of two concurrent archive taps before approval', async () => {
  const h = setupAgentCardBot()
  await h.openCatalog({ chatId: 42, userId: 7 })
  await h.tap(h.latestButton('ac:v1:select:'), { chatId: 42, userId: 7 })
  const archive = h.latestButton('ac:v1:archive:')
  await Promise.all([
    h.tap(archive, { chatId: 42, userId: 7 }),
    h.tap(archive, { chatId: 42, userId: 7 }),
  ])
  expect(h.lifecycle.archiveCalls).toHaveLength(1)
  expect(h.gateway.issueCalls).toHaveLength(1)
  expect(h.callbackAnswers.some(answer => answer.text === 'Экран устарел')).toBe(true)
})
```

Остальной handler matrix содержит exact setup и assertions:

| Case | Telegram sequence | Assertions |
|---|---|---|
| arbitrary select | открыть catalog → token Project `reviewer` | detail target exact Project; configured main остаётся `main` |
| create + update | create Workspace token → Markdown `alpha`; select `reviewer` → publish token → matching Markdown | два distinct Tier-3 actions; histories изменены только у exact targets |
| archive + restore | select active → archive; заново открыть archived-only entry → rollback | status archived, затем новая active revision; старая revision не мутирует content |
| legacy import | import Workspace token → сообщение `legacy-worker` | ровно `readExact('legacy-worker')`; directory listing API отсутствует |
| stale corpus | forged token, duplicate token, old messageId, token после rerender | zero lifecycle/approval; callback answer `Экран устарел` |
| wrong user | user 8 отправляет draft формы user 7, затем user 7 отправляет draft | first message полностью игнорируется и не consumes form; second создаёт ровно одну mutation |
| concurrent messages | два update exact principal обрабатываются через `Promise.all` | ровно один delete/parse/approval/mutation; второй видит `none` и не получает DNA echo |
| Project drift | открыть Project form в A, capture binding возвращает B | zero delete/parse/read/approval/mutation, redacted stale reply |
| privacy | fixture instructions содержит `PRIVATE-DNA-MARKER` | serialized send/edit/answer/audit calls не содержат marker или 64-char content hash |

Run:

```bash
pnpm --filter @aisy/app exec vitest run src/bot-agent-card-catalog.spec.ts
```

Expected: FAIL, новый flow отсутствует.

- [ ] **Step 2: Добавить dedicated catalog/detail sender**

Sender строит lifecycle projection, page slices, exact intents и tokenized view.
Для нового сообщения:

```ts
const prepared = agentCardState.prepare({ principal, intents })
try {
  const sent = await bot.api.sendMessage(principal.chatId, view.text, options(view))
  prepared.bind(sent.message_id)
} catch (error) {
  prepared.discard()
  throw error
}
```

Для edit известный `messageId` bind'ится перед `editMessageText`; failure оставляет
старые buttons безопасно stale. Любой переход с AgentCard screen инвалидирует
generation/form principal.

`cfg:open:agent-cards` special-case вызывает dedicated sender напрямую, а не
старый `settingsScreen('agent-cards')`. Back/catalog/page и post-mutation redraw
используют тот же sender, поэтому каждый экран получает новую generation.

- [ ] **Step 3: Маршрутизировать `ac:v1` callbacks до settings codec**

Порядок callback handler:

1. получить exact `{chatId, userId, messageId}`;
2. strict decode;
3. synchronous `claimCallback` до `await`;
4. stale/forged → `deadTap('Экран устарел')`;
5. catalog/select/page → новый render generation;
6. create/import/publish → principal-bound form;
7. archive/rollback → exact lifecycle call с отдельным Gateway approval.

Success/error receipts содержат только name, revision, status и 12-char prefix.

- [ ] **Step 4: Маршрутизировать pending AgentCard forms**

В text handler существующий `pendingStepUp` branch переносится перед AgentCard
form claim: код step-up должен завершить approval уже claimed формы. AgentCard
form claim остаётся перед generic dialogue, поэтому любой другой concurrent
message получает `busy` и игнорируется:

```ts
const formClaim = agentCardState.claimForm(principal)
if (formClaim.kind === 'foreign' || formClaim.kind === 'busy') return
if (formClaim.kind === 'claimed') {
  const form = formClaim.form
  try {
    const current = await deps.captureWorkBinding?.()
    const sameBinding = current !== undefined && (
      (form.binding.scope === 'workspace' && current.scope === 'workspace') ||
      (form.binding.scope === 'project' && current.scope === 'project' &&
        form.binding.projectId === current.projectId)
    )
    if (!sameBinding || deps.agentCards === undefined) {
      await bot.api.sendMessage(deps.allowedChatId, 'Экран устарел. Открой каталог заново.')
      return
    }
    await ctx.deleteMessage().catch(() => {})
    const approve = approvalForSession(sessionId)
    let revision: AgentCardRevision
    if (form.operation === 'create') {
      revision = await deps.agentCards.createDraft({ markdown: text, binding: form.binding, approve })
    } else if (form.operation === 'publish' && form.target !== null) {
      revision = await deps.agentCards.publishDraft({ target: form.target, markdown: text, approve })
    } else if (form.operation === 'import-legacy') {
      revision = await deps.agentCards.importLegacy({
        target: { binding: form.binding, name: text.trim() },
        approve,
      })
    } else {
      await bot.api.sendMessage(deps.allowedChatId, 'Экран устарел. Открой каталог заново.')
      return
    }
    await bot.api.sendMessage(
      deps.allowedChatId,
      `✅ ${revision.name}@${revision.revision} · ${revision.status} · ${revision.hash.slice(0, 12)}`,
    )
    await sendAgentCardCatalog(principal)
    return
  } catch {
    await bot.api.sendMessage(deps.allowedChatId, '❌ Agent Card не изменена.')
    await sendAgentCardCatalog(principal)
    return
  } finally {
    formClaim.finish()
  }
}
```

Import name message удаляется best-effort после binding check и до legacy read.
Две concurrent deliveries видят form только у одного synchronous claim.

- [ ] **Step 5: Обновить старые form/button tests**

Удалить old `agent-card-draft` fixture из generic `pendingForm`. Button walk
должен открыть catalog, каждую catalog intent, detail, publish, archive,
rollback, import и back. Dynamic callback data берётся из реально отправленных
buttons, а не hardcoded raw name/projectId.

- [ ] **Step 6: Запустить focused bot corpus**

```bash
pnpm --filter @aisy/app exec vitest run src/bot-agent-card-catalog.spec.ts src/bot-screen-forms.spec.ts src/bot-button-walk.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit live Telegram flow**

```bash
git add packages/app/src/bot.ts packages/app/src/bot-agent-card-catalog.spec.ts packages/app/src/bot-screen-forms.spec.ts packages/app/src/bot-button-walk.spec.ts
git commit -m "feat(telegram): управлять каталогом Agent Cards"
```

---

### Task 7: Production composition и restart/cutover доказательства

**Files:**

- Modify: `packages/app/src/bin/aisy.ts:11-15,47-50,121-124,1333-1475`
- Modify: `packages/app/src/agent-card-live-selection.spec.ts:32-75`
- Create: `packages/app/src/agent-card-catalog-composition.spec.ts`

**Interfaces:**

- Consumes: один durable registry, source-checkout Python 3.12 confinement
  worker, target lifecycle controller.
- Produces: `agentCards` bot dependency с catalog/mutations/legacy import; main
  and non-builtin selection продолжают использовать тот же registry instance.

- [ ] **Step 1: Написать failing composition tests**

```ts
it('wires one registry to main selection subagent selection and lifecycle catalog', () => {
  const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
  expect(production.match(/makeAgentCardRegistry\(/g)).toHaveLength(1)
  expect(production).toContain('legacy: agentCardLegacyImport')
  expect(production).toContain("root: join(base, 'agents')")
})

it('does not let Telegram composition write selection or cutover environment', () => {
  expect(production).not.toMatch(/process\.env\[['\"]AISY_MAIN_AGENT_CARD['\"]\]\s*=/)
  expect(production).not.toMatch(/process\.env\[['\"]AISY_AGENT_CARD_REGISTRY['\"]\]\s*=/)
})
```

Добавить runtime test: registry mutation при cutover off сохраняется, selection
остаётся legacy; после нового registry instance и cutover on exact active
revision выбирается; archived exact Project history fail-closed без Workspace
resurrection.

- [ ] **Step 2: Запустить composition tests и подтвердить RED**

```bash
pnpm --filter @aisy/app exec vitest run src/agent-card-catalog-composition.spec.ts src/agent-card-live-selection.spec.ts
```

Expected: FAIL на legacy adapter wiring/new factory contract.

- [ ] **Step 3: Собрать fail-closed legacy adapter**

Получить source-checkout paths только из `import.meta.url`:

```ts
const sidecarsRoot = fileURLToPath(new URL('../../../sidecars-py/', import.meta.url))
const pythonExecutable = join(sidecarsRoot, '.venv', 'bin', 'python')
const confinementWorkerPath = join(sidecarsRoot, 'aisy_sidecars', 'confinement_worker.py')
const agentCardLegacyImport = existsSync(pythonExecutable) && existsSync(confinementWorkerPath)
  ? makeAgentCardLegacyImportPort({
      root: join(base, 'agents'),
      process: makeNodeConfinementProcessPort({ pythonExecutable, workerPath: confinementWorkerPath }),
      newId: () => randomUUID(),
    })
  : undefined
```

Отсутствие sidecar не включает path-based fallback: import button скрыт,
registry/catalog и остальные lifecycle verbs продолжают работать.

- [ ] **Step 4: Передать новый controller contract в bot**

```ts
const agentCardLifecycle = makeAgentCardLifecycleRuntime({
  registry: agentCardRegistry,
  configuredName: configuredMainCardName,
  cutoverActive: agentCardRegistryCutover,
  currentBinding: () => agentCardBinding,
  approvedBy: staticWorkBinding.operatorId,
  ...(agentCardLegacyImport === undefined ? {} : { legacy: agentCardLegacyImport }),
  emit: (event, payload) => { void journal.append('agent-card', event, payload) },
})
```

Registry-ready audit остаётся redacted: cutover boolean, configured boolean и
active revision; full card/hash отсутствуют.

- [ ] **Step 5: Запустить production-targeted tests и build**

```bash
pnpm --filter @aisy/app exec vitest run src/agent-card-catalog-composition.spec.ts src/agent-card-live-selection.spec.ts src/agent-card-registry-store.spec.ts
pnpm --filter @aisy/app typecheck
pnpm --filter @aisy/app build
```

Expected: PASS.

- [ ] **Step 6: Commit production composition**

```bash
git add packages/app/src/bin/aisy.ts packages/app/src/agent-card-live-selection.spec.ts packages/app/src/agent-card-catalog-composition.spec.ts
git commit -m "feat(agent-cards): подключить каталог к production composition"
```

---

### Task 8: Документация, independent review и release gates

**Files:**

- Modify: `docs/superpowers/specs/2026-08-12-telegram-agent-card-catalog-design.md`
- Modify: `docs/decisions/2026-07-29-agent-card-lifecycle.md`
- Modify: `docs/specs/20-agent-dna-and-capability-matrix.md`
- Modify: `docs/reviews/2026-08-08-production-readiness-matrix.md`

**Interfaces:**

- Consumes: фактически реализованные tests и composition.
- Produces: русская traceability matrix и честный handoff без заявления о
  включённом production flag или monitoring.

- [ ] **Step 1: Обновить ADR-0069 без нового ADR**

Уточнить в существующем решении:

- arbitrary exact target selector;
- пять lifecycle verbs и complete envelope;
- one-use Telegram tokens/forms;
- descriptor-relative explicit legacy import;
- selector не меняет selection/cutover.

Статус ADR остаётся «Принято».

- [ ] **Step 2: Добавить AC-20-18 и traceability**

Точный criterion:

```markdown
18. **AC-20-18** — Telegram показывает bounded redacted-каталог exact Workspace
    и current Project Agent Cards и управляет произвольным target через
    principal/message/generation-bound one-use callback. Create, publish,
    archive, rollback и explicit descriptor-relative legacy import требуют
    canonical head/source/result envelope и genuine Tier-3 proof; stale,
    replay, Project drift и restart дают zero read/approval/mutation, а selector
    не меняет `AISY_MAIN_AGENT_CARD` или `AISY_AGENT_CARD_REGISTRY`.
```

Traceability перечисляет четыре targeted spec files Core/App/Telegram/bot и
production composition spec.

- [ ] **Step 3: Обновить readiness только по фактам**

Строка AgentCard lifecycle становится LIVE для selector/CRUD в code
composition, но registry runtime authority остаётся за exact opt-in gate.
Explicit legacy import отмечается доступным только при verified sidecar;
отсутствие sidecar — fail-closed. Не заявлять целевой host cutover/restart E2E,
если он не выполнялся.

- [ ] **Step 4: Выполнить self-review плана реализации против spec**

Проверить каждый пункт design §9 и записать mapping в review notes текущего
turn: Core catalog, App lifecycle/restart, Telegram callback/forms/privacy,
production cutover. Любой непокрытый criterion получает deterministic test до
full regression.

- [ ] **Step 5: Запустить targeted security/privacy corpus**

```bash
pnpm --filter @aisy/core exec vitest run src/runtime/agent-card-registry.spec.ts
pnpm --filter @aisy/telegram-gw exec vitest run src/agent-card-catalog-view.spec.ts src/settings-tree.spec.ts
pnpm --filter @aisy/app exec vitest run src/agent-card-legacy-import.spec.ts src/agent-card-legacy-import.integration.spec.ts src/agent-card-lifecycle-runtime.spec.ts src/telegram-agent-card-state.spec.ts src/bot-agent-card-catalog.spec.ts src/bot-screen-forms.spec.ts src/bot-button-walk.spec.ts src/agent-card-registry-store.spec.ts src/agent-card-live-selection.spec.ts src/agent-card-catalog-composition.spec.ts
cd packages/sidecars-py && uv run pytest tests/test_confinement_worker.py -q && uv run ruff check aisy_sidecars/confinement_worker.py tests/test_confinement_worker.py
```

Expected: все tests PASS, Ruff exit 0.

- [ ] **Step 6: Запустить affected/full workspace gates**

Из корня worktree:

```bash
pnpm --filter @aisy/core test
pnpm --filter @aisy/telegram-gw test
pnpm --filter @aisy/app test
pnpm typecheck
pnpm build
git diff --check
```

Если socket/real-process corpus получает sandbox permission error, повторить тот
же exact corpus в разрешённой локальной среде; не добавлять skip.

- [ ] **Step 7: Выполнить independent review pass для 3+ files**

Проверить diff по пяти углам:

```text
1. authority/state machine и proof consumption;
2. callback/form replay, principal и Project drift;
3. descriptor/path/root TOCTOU и fail-closed packaging;
4. DNA/full-hash/path leakage в UI, error и audit;
5. cutover off/on, restart и rollback без silent fallback.
```

Исправить найденные дефекты и повторить затронутые targeted tests.

- [ ] **Step 8: Выполнить Telegram frontend checklist review/release gate**

Hosted checklist не является Telegram renderer, поэтому применимы только
resilience/security/testing rules: смысловые labels, явные form prompts,
немедленный callback acknowledgement, escaping, bounded payload и button walk.
Запустить conservative static review и release без web URL:

```bash
python3 /Users/iam/.agents/skills/frontend-checklist-global/scripts/frontend_checklist.py review packages/telegram-gw/src/agent-card-catalog-view.ts packages/app/src/bot.ts --min-priority medium --format md
python3 /Users/iam/.agents/skills/frontend-checklist-global/scripts/frontend_checklist.py release packages/telegram-gw/src/agent-card-catalog-view.ts packages/app/src/bot.ts --format md
```

Исправить подтверждённые Critical/High в scope; Medium/Low записать в handoff.
Zero static findings означает только отсутствие доказуемой проблемы, а не
полную UI-гарантию.

- [ ] **Step 9: Commit documentation and evidence**

```bash
git add docs/superpowers/specs/2026-08-12-telegram-agent-card-catalog-design.md docs/decisions/2026-07-29-agent-card-lifecycle.md docs/specs/20-agent-dna-and-capability-matrix.md docs/reviews/2026-08-08-production-readiness-matrix.md
git commit -m "docs(agent-cards): зафиксировать проверенный Telegram lifecycle"
```

- [ ] **Step 10: Rebase/merge safety check и merge в master**

```bash
git status --short
git fetch origin
git log --oneline --decorate --graph --max-count=20 master codex/telegram-agent-card-catalog
git diff --name-only master...codex/telegram-agent-card-catalog
```

Повторно сверить пересечения с актуальным `master`. При отсутствии конфликтов и
после зелёных gates выполнить fast-forward/обычный merge согласно фактической
истории, затем повторить `git diff --check` и targeted smoke на `master`. Push не
выполнять без отдельного запроса пользователя.

---

## Final acceptance checklist

- [ ] Exact Workspace/current Project catalog сортируется и не содержит DNA.
- [ ] Arbitrary target create/publish/archive/rollback/import проходит только
  canonical Core state machine и genuine Tier-3 proof.
- [ ] One active revision не откатывается; one archived восстанавливается в rev2;
  repeated rollback использует непосредственную предыдущую revision.
- [ ] Save failure не меняет authority и не потребляет proof; success/restart
  replay отклоняется.
- [ ] Legacy read descriptor-relative, bounded, UTF-8-fatal и устойчив к
  root/file replacement.
- [ ] Callback ≤64 bytes, one-use, principal/message/generation-bound; stale и
  restart дают zero mutation.
- [ ] Pending forms one-use, TTL-bound и exact-binding checked до delete/parse/
  file read/approval.
- [ ] Telegram/audit corpus не содержит DNA marker, full hash или local path.
- [ ] `AISY_MAIN_AGENT_CARD`, `AISY_AGENT_CARD_REGISTRY` и monitoring остаются
  неизменными.
- [ ] Core/App/Telegram/Python targeted и full suites, workspace typecheck/build
  и `git diff --check` зелёные.
- [ ] ADR/spec/readiness совпадают с реально включённой composition.
- [ ] Merge содержит только связанные файлы; private reference, secrets,
  runtime state и чужие изменения отсутствуют.

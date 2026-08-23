# Tier 3 — Live Sub-Agent Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built-but-dormant `DelegationManager` live — the main agent can spawn card-scoped sub-agents (each with its own model, budget, tool scope, and a fresh safety policy) via an explicit `spawn_subagent` tool, running independent ready tasks concurrently with a write-disjointness re-verification gate.

**Architecture:** Two new seams, both additive. **(1) Runner factory** `makeSubAgentRunner` builds a child `AgentRunner` per delegation: a fresh `SafetyPolicy` + a fresh empty `GrantStore` scoped to the sub-agent's `AgentCard` (no inherited grants; tier-2/3 re-prompt), the card's `toolTiers` gating which tools it may call, its own provider (from `providers.json:agents[*]`, falling back to the parent tier), its own `budgetCheck` keyed on the agent id, a scoped tool executor that confines writes to the delegation's `owns` lane, and parent narrowing inherited by seeding span provenance. **(2) Trigger** is one explicit `spawn_subagent` tool whose payload is either a single task or a goal-DAG plan (the manager already normalizes `LinearPlanLike | PlanDAG`); a `DelegationDriver` runs the schedule loop — each round it re-verifies write-disjointness across the ready set, spawns + runs the ready tasks **concurrently**, collects compact `TaskObservation`s, then `schedule()`s (cascade-skip) until the DAG drains. The agent loop and Core types are untouched; the manager, scope/tamper machinery, and budget/spend/provider data model already exist and are proven (orchestration 7/7 delegation tests).

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, Node16 ESM, `.js` import extensions), vitest, gray-matter-free hand-rolled YAML-frontmatter parse (no new dep), grammY transport (unchanged).

## Global Constraints

- **License Apache-2.0.** No GPL/AGPL deps. This plan adds **no runtime deps** (frontmatter parsed by hand or with an already-present dep — confirm before adding anything).
- **Brand always "Aisy", affirmative only.** Never "never X".
- **`research/` is gitignored — never reference it in any committed/public file.**
- **TS strict + `exactOptionalPropertyTypes`:** never pass `undefined` to an optional prop — use a conditional spread `...(x !== undefined ? { x } : {})`. `noUncheckedIndexedAccess`: guard array/Map index access. Do not widen Core types — the goal-DAG is normalized inside orchestration (`normalizePlan`), Core `Plan` stays `{ steps }`.
- **Sub-agent privilege model (ADR-0052, locked by the user):** a sub-agent starts with ONLY the tools/tiers in its `AgentCard`; it gets a **fresh `SafetyPolicy` + a fresh empty `GrantStore`** (parent grants are NOT inherited); it **inherits the parent's narrowed state**; any tier-2/tier-3 action **re-prompts for approval** (parent approvals never carry over). A scoped grant may suppress only a tier-2 `ask`, NEVER a `deny`; **tier-3 is never grantable** — this holds for sub-agents too. A sub-agent's file writes are confined to its delegation `owns` lane minus `doNotTouch`.
- **No secret in any error/log/observation detail** (redaction). Provider keys never appear in a `TaskObservation`, shard entry, or thrown message.
- **The opaque-bytes 3-tier router (`provider/types.ts`) stays untouched** — the catalog has its own id-space (ADR-0050).
- **Surgical changes:** every changed line traces to Tier-3. Match existing style (conditional spreads, ASCII-comment headers, Russian UX copy where user-facing).
- **TDD, frequent commits.** Each task ends green: `pnpm -r build` + `pnpm -r test`. Existing 671 core + 89 telegram-gw tests stay green.

## Exact existing shapes this plan builds on (reference — do not redefine)

From `packages/core-ts/src/orchestration/types.ts`:
- `DelegationScope { owns: string[]; doNotTouch: string[]; taskClass: TaskClass }`
- `BudgetSlice { iterations: number; spendUsd: number }`
- `IterationCost { iterations: number; spendUsd: number; wallMs: number }`
- `TaskObservation { delegationId; status: 'completed'|'failed'; summary: string; touched: string[]; result: unknown; cost: IterationCost }`
- `ScheduleResult { ready: string[]; cascadeSkipped: string[] }`
- `PlanDAG { nodes: DelegationTask[]; edges: Dependency[] }`, `LinearPlanLike { steps: ReadonlyArray<{ intent?: string }> }`
- `DelegationTask { taskId; intent; assignedTo: string|null; dependsOn: string[]; scope: DelegationScope; budgetSlice; outputContract; retryPolicy }`
- `AgentCard { name; description?; skills: string[]; mcpAllowlist: string[]; toolTiers: Record<string,number>; maxIterations: number; contextStrategy: 'compact'|'full'; provenance: 'builtin'|'user'|'community' }`
- `DelegationDeps { resolveCard(name): AgentCard|undefined; skillTouchedPaths(skill): string[]; mcpWritable(server): boolean; emit(event: OrchestrationEvent): void }`
- `DelegationManager { dag(); readySet(): DelegationTask[]; spawn(taskId, requested?): DelegationHandle; resume(id); schedule(): ScheduleResult; runBudgetSpent(); verifyShardChain(id) }`
- `DelegationHandle { delegationId; taskId; card: AgentCard; owns: string[]; writableMcp: string[]; permitsTool(name); permitsMcp(server); append(kind,payload): ShardEntry; shard(); guardian: LoopGuardian; complete(summary,result,cost): TaskObservation; fail(summary,cost): TaskObservation }`
- `ScopeConflictError`, `ScopeViolationError` (exported from `orchestration/index.ts`)
- `makeDelegationManager(plan: LinearPlanLike | PlanDAG, deps: DelegationDeps): DelegationManager` (exported from `orchestration/index.ts`, NOT from the `@aisy/core` barrel yet)

From `runtime/`:
- `ExecuteToolDeps { fs: FsPort; workspaceRoot: string; runBash?; searchMemory? }`; `makeToolExecutor(deps): (call: ToolCall) => Promise<ToolResult>` with an internal `confine(p): string|null` (rejects paths escaping `workspaceRoot`). (`execute-tool.ts`)
- `makeHookGate({ safety, grants, approve }): HookGate`; `ApprovalDecision = {decision:'confirmed';scope?} | {decision:'rejected'}` (`hook-gate.ts`)
- `makeSafetyPolicy({ ready?, sandboxSecurityLevel?, grants? }): SafetyPolicy` with `isNarrowed(ctx)` (`safety/index.ts`)
- `makeSpendStore({persistence?})`; `SpendStore.record({ model; agentId?; usage })` — `agentId` defaults `'main'` (`spend.ts`)
- `makeBudgetTracker({caps, spent}): { capFor; spentFor; remainingFor; over }` (`budget.ts`)
- `makeAgentRunner(deps: AgentRunnerDeps): AgentRunner` with `handle(input: TurnInput): Promise<TurnResult>` (`agent-runner.ts`)
- `TurnInput { sessionId; spans: ContextSpan[]; approvalToken?; signal? }`; `ContextSpan { role; provenance: 'operator'|'untrusted'; text }`

AgentCard file format (`.aisy/agents/<name>.md`, spec 11): YAML frontmatter keys `name`, `description?`, `skills: []`, `mcp_allowlist: []`, `tool_tiers: {}`, `max_iterations`, `context_strategy: 'compact'|'full'`, `provenance: 'builtin'|'user'|'community'`, then a Markdown body.

---

## Phase A — Export surface + sub-agent runner factory

### Task A1: Re-export the delegation surface from `@aisy/core`

**Files:**
- Modify: `packages/core-ts/src/index.ts` (barrel)
- Test: `packages/core-ts/src/index.spec.ts` (create if absent, else add a case)

**Interfaces:**
- Produces: `@aisy/core` re-exports `makeDelegationManager` and the delegation types/errors so the app + runtime can consume them.

- [ ] **Step 1: Write the failing test**

In `packages/core-ts/src/index.spec.ts` (create if it does not exist):

```ts
import { describe, it, expect } from 'vitest'
import * as core from './index.js'

describe('@aisy/core barrel — delegation surface', () => {
  it('re-exports makeDelegationManager and the scope errors', () => {
    expect(typeof core.makeDelegationManager).toBe('function')
    expect(typeof core.ScopeConflictError).toBe('function')
    expect(typeof core.ScopeViolationError).toBe('function')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aisy/core test -- index.spec`
Expected: FAIL — `makeDelegationManager` undefined on the barrel.

- [ ] **Step 3: Add the re-exports**

In `packages/core-ts/src/index.ts`, add (value export for the factory + errors, type-only export for the rest):

```ts
export { makeDelegationManager, ScopeConflictError, ScopeViolationError } from './orchestration/index.js'
export type {
  DelegationManager,
  DelegationHandle,
  DelegationDeps,
  DelegationTask,
  DelegationScope,
  PlanDAG,
  LinearPlanLike,
  AgentCard,
  CapabilityRequest,
  TaskObservation,
  ScheduleResult,
  BudgetSlice,
  IterationCost,
} from './orchestration/index.js'
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @aisy/core test -- index.spec` → PASS.

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @aisy/core build
git add packages/core-ts/src/index.ts packages/core-ts/src/index.spec.ts
git commit -F - <<'EOF'
feat(core): re-export delegation surface from @aisy/core barrel (Tier3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task A2: Scoped tool executor — confine a sub-agent to its card + owned lane

**Files:**
- Create: `packages/core-ts/src/runtime/scoped-tool-executor.ts`
- Modify: `packages/core-ts/src/orchestration/index.ts` (export the internal `globMatches` for reuse) + its barrel block
- Test: `packages/core-ts/src/runtime/scoped-tool-executor.spec.ts`

**Interfaces:**
- Consumes: a base `executeTool` (from `makeToolExecutor`), a `DelegationHandle`'s `permitsTool`/`owns`, the task's `doNotTouch`, `globMatches`.
- Produces:
  ```ts
  export interface ScopedToolExecutorDeps {
    base: (call: ToolCall) => Promise<ToolResult>
    permitsTool: (name: string) => boolean
    owns: string[]
    doNotTouch: string[]
  }
  export function makeScopedToolExecutor(deps: ScopedToolExecutorDeps): (call: ToolCall) => Promise<ToolResult>
  ```
  Behavior: refuse any tool not on the card (`permitsTool` false) → `ToolResult` error, no dispatch. For write tools (`write_file`, `edit_file`), extract the `path` arg; refuse if it is not inside the owned lane (`owns` matches AND no `doNotTouch` match). Otherwise delegate to `base`.

- [ ] **Step 1: Export `globMatches` from orchestration**

In `packages/core-ts/src/orchestration/index.ts`, find the internal `globMatches` helper and add it to the value exports; add `globMatches` to the export list. (If it is `function globMatches(...)`, add `export` to it.)

- [ ] **Step 2: Write the failing tests**

`packages/core-ts/src/runtime/scoped-tool-executor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import type { ToolCall, ToolResult } from '../tools/types.js' // confirm the export path for ToolCall/ToolResult

const okBase = async (call: ToolCall): Promise<ToolResult> => ({ ok: true, text: `ran ${call.name}` })

describe('makeScopedToolExecutor', () => {
  it('refuses a tool not permitted by the card', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: (n) => n === 'read_file', owns: ['src/**'], doNotTouch: [] })
    const r = await exec({ name: 'bash', args: { cmd: 'ls' } })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('bash')
  })

  it('refuses a write outside the owned lane', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/feature/**'], doNotTouch: [] })
    const r = await exec({ name: 'write_file', args: { path: 'src/other/x.ts', content: 'x' } })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('scope')
  })

  it('refuses a write inside doNotTouch even if inside owns', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/**'], doNotTouch: ['src/secrets/**'] })
    const r = await exec({ name: 'write_file', args: { path: 'src/secrets/k.ts', content: 'x' } })
    expect(r.ok).toBe(false)
  })

  it('allows a permitted write inside the owned lane', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: ['src/feature/**'], doNotTouch: [] })
    const r = await exec({ name: 'write_file', args: { path: 'src/feature/x.ts', content: 'x' } })
    expect(r.ok).toBe(true)
  })

  it('passes non-write permitted tools straight through', async () => {
    const exec = makeScopedToolExecutor({ base: okBase, permitsTool: () => true, owns: [], doNotTouch: [] })
    const r = await exec({ name: 'read_file', args: { path: 'anything.ts' } })
    expect(r.ok).toBe(true)
  })
})
```

(First confirm the real import path + shape of `ToolCall`/`ToolResult` — grep `export.*ToolResult` under `packages/core-ts/src`. The agent-loop `ToolCall` is `{ name; args: Record<string,unknown>; sourceSpanProvenance? }`. Match the real `ToolResult` shape — likely `{ ok: boolean; text?: string; error?: string }`; adapt the assertions to the real field names.)

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter @aisy/core test -- scoped-tool-executor.spec`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/core-ts/src/runtime/scoped-tool-executor.ts`:

```ts
// Sub-agent scope enforcement (runtime, ADR-0052).
//
// Wraps a base tool executor so a delegated sub-agent can only call tools its
// AgentCard permits, and can only WRITE inside its delegation's owned lane
// (owns minus doNotTouch). Reads/non-write tools pass through once the card
// permits the tool. The DelegationManager already enforces write-disjointness
// across delegations at spawn; this is the per-call runtime guard.

import { globMatches } from '../orchestration/index.js'
import type { ToolCall, ToolResult } from '../tools/types.js'

export interface ScopedToolExecutorDeps {
  base: (call: ToolCall) => Promise<ToolResult>
  permitsTool: (name: string) => boolean
  owns: string[]
  doNotTouch: string[]
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

function pathArg(call: ToolCall): string | undefined {
  const p = (call.args as { path?: unknown }).path
  return typeof p === 'string' ? p : undefined
}

export function makeScopedToolExecutor(deps: ScopedToolExecutorDeps): (call: ToolCall) => Promise<ToolResult> {
  const inOwnedLane = (p: string): boolean =>
    deps.owns.some((g) => globMatches(g, p)) && !deps.doNotTouch.some((g) => globMatches(g, p))

  return async (call: ToolCall): Promise<ToolResult> => {
    if (!deps.permitsTool(call.name)) {
      return { ok: false, error: `tool '${call.name}' is not on this sub-agent's card` }
    }
    if (WRITE_TOOLS.has(call.name)) {
      const p = pathArg(call)
      if (p !== undefined && !inOwnedLane(p)) {
        return { ok: false, error: `path '${p}' is outside this sub-agent's owned scope` }
      }
    }
    return deps.base(call)
  }
}
```

(Match the real `ToolResult` error field name. If `ToolResult` has no `ok`/`error`, adapt to its real discriminator — but keep the two behaviors: refuse-with-message vs delegate.)

- [ ] **Step 5: Run to verify pass + build**

Run: `pnpm --filter @aisy/core test -- scoped-tool-executor.spec` → PASS. Then `pnpm --filter @aisy/core build`.

- [ ] **Step 6: Commit**

```bash
git add packages/core-ts/src/runtime/scoped-tool-executor.ts packages/core-ts/src/runtime/scoped-tool-executor.spec.ts packages/core-ts/src/orchestration/index.ts
git commit -F - <<'EOF'
feat(runtime): scoped tool executor confines a sub-agent to card + owned lane (Tier3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task A3: `makeSubAgentRunner` — a card-scoped child runner

**Files:**
- Create: `packages/core-ts/src/runtime/sub-agent-runner.ts`
- Test: `packages/core-ts/src/runtime/sub-agent-runner.spec.ts`

**Interfaces:**
- Consumes: `DelegationHandle`, a base `executeTool`, a `ProviderAdapter` (already model-selected for this agent), an `approve` port, `MemoryPort`, `SessionLog` adapter, the agent id, an optional `budgetCheck`, the parent's `narrowed` flag.
- Produces:
  ```ts
  export interface SubAgentRunnerDeps {
    handle: DelegationHandle
    provider: ProviderAdapter
    baseExecuteTool: (call: ToolCall) => Promise<ToolResult>
    approve: (action: PendingAction) => Promise<ApprovalDecision>
    memory: MemoryPort
    sessionLog: SessionLog
    parentNarrowed: boolean
    budgetCheck?: AgentRunnerDeps['budgetCheck']
    doNotTouch: string[]   // the task's scope.doNotTouch (handle exposes owns, not doNotTouch)
  }
  export function makeSubAgentRunner(deps: SubAgentRunnerDeps): AgentRunner
  ```
  Composition: fresh `makeSafetyPolicy({ grants: freshGrantStore })` (a brand-new empty `GrantStore` — no inherited grants); `makeHookGate({ safety, grants: freshGrantStore, approve })`; a scoped executor `makeScopedToolExecutor({ base: baseExecuteTool, permitsTool: handle.permitsTool, owns: handle.owns, doNotTouch })`; `makeAgentRunner({ provider, memory, grants: freshGrantStore, executeTool: scoped, approve, guardian: handle.guardian, sessionLog, maxTotalToolCalls: card.maxIterations, ...budgetCheck })`. The returned runner's `handle(input)` seeds narrowing: if `parentNarrowed`, every span's `provenance` is forced to `'untrusted'` before the loop runs (so the loop sets `narrowed` and the motivated-call block applies).

- [ ] **Step 1: Write the failing tests**

`packages/core-ts/src/runtime/sub-agent-runner.spec.ts` — build a fake `DelegationHandle` (only the fields the runner reads: `card`, `owns`, `permitsTool`, `guardian`, `append`), a fake provider, and assert:

```ts
import { describe, it, expect } from 'vitest'
import { makeSubAgentRunner } from './sub-agent-runner.js'
import type { ProviderAdapter } from '../agent-loop/types.js'
// ... import LoopGuardian/AgentCard fakes or build minimal inline

function fakeGuardian() { return { observe: () => ({ trip: false }), note: () => {} } }
function fakeCard(overrides = {}) {
  return { name: 'general', skills: [], mcpAllowlist: [], toolTiers: { read_file: 1 }, maxIterations: 5, contextStrategy: 'compact', provenance: 'builtin', ...overrides } as const
}
function fakeHandle(overrides = {}) {
  return {
    delegationId: 'd1', taskId: 't1', card: fakeCard(), owns: ['src/**'], writableMcp: [],
    permitsTool: (n: string) => n === 'read_file', permitsMcp: () => false,
    append: () => ({}) as any, shard: () => [], guardian: fakeGuardian(),
    complete: () => ({}) as any, fail: () => ({}) as any, ...overrides,
  } as any
}
const memFake = { snapshot: async () => ({ prefixBytes: new Uint8Array(0), prefixHash: 'h', breakpoints: [], takenAt: '2026-01-01T00:00:00.000Z' }), forget: async () => {} }
const logFake = { append() {}, resume: () => null }

it('a sub-agent inherits parent narrowing (operator span is forced untrusted)', async () => {
  const provider: ProviderAdapter = { async complete() { return { reply: 'done', toolCalls: [] } } }
  const runner = makeSubAgentRunner({
    handle: fakeHandle(), provider, baseExecuteTool: async () => ({ ok: true }),
    approve: async () => ({ decision: 'rejected' }), memory: memFake, sessionLog: logFake,
    parentNarrowed: true, doNotTouch: [],
  })
  const result = await runner.handle({ sessionId: 'd1', spans: [{ role: 'user', provenance: 'operator', text: 'do it' }] })
  expect(result.narrowed).toBe(true) // narrowing inherited from the parent
})

it('a non-narrowed parent leaves the sub-agent un-narrowed', async () => {
  const provider: ProviderAdapter = { async complete() { return { reply: 'done', toolCalls: [] } } }
  const runner = makeSubAgentRunner({
    handle: fakeHandle(), provider, baseExecuteTool: async () => ({ ok: true }),
    approve: async () => ({ decision: 'rejected' }), memory: memFake, sessionLog: logFake,
    parentNarrowed: false, doNotTouch: [],
  })
  const result = await runner.handle({ sessionId: 'd1', spans: [{ role: 'user', provenance: 'operator', text: 'do it' }] })
  expect(result.narrowed).toBe(false)
})

it('caps the sub-agent at the card maxIterations (passed as maxTotalToolCalls)', async () => {
  // a provider that emits many tool calls; assert it halts cap-exceeded once > maxIterations dispatches
  const provider: ProviderAdapter = { async complete() { return { reply: 'x', toolCalls: Array.from({ length: 10 }, () => ({ name: 'read_file', args: {} })) } } }
  const runner = makeSubAgentRunner({
    handle: fakeHandle({ card: fakeCard({ maxIterations: 3 }) }), provider, baseExecuteTool: async () => ({ ok: true }),
    approve: async () => ({ decision: 'rejected' }), memory: memFake, sessionLog: logFake, parentNarrowed: false, doNotTouch: [],
  })
  const result = await runner.handle({ sessionId: 'd1', spans: [{ role: 'user', provenance: 'operator', text: 'go' }] })
  expect(result.state).toBe('halted')
  expect(result.haltReason).toBe('cap-exceeded')
})
```

(Adapt fakes to the real `LoopGuardian`/`MemoryPort`/`SessionLog` shapes. The card-scoped grant-isolation property is exercised indirectly through the fresh GrantStore — add an assertion if a public hook exists; otherwise the integration test in Task C covers it.)

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @aisy/core test -- sub-agent-runner.spec` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core-ts/src/runtime/sub-agent-runner.ts`:

```ts
// Sub-agent runner factory (runtime, ADR-0052).
//
// Builds a card-scoped child AgentRunner for one delegation: a FRESH SafetyPolicy
// over a FRESH empty GrantStore (parent grants are never inherited — tier-2/3
// re-prompt), the card's tools gated via the scoped executor, the per-delegation
// Loop Guardian, and the card's maxIterations as the tool-call cap. Parent
// narrowing is inherited by forcing the sub-agent's span provenance to untrusted.

import { makeAgentRunner, type AgentRunnerDeps } from './agent-runner.js'
import { makeGrantStore } from '../safety/index.js'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import type { AgentRunner, ProviderAdapter, MemoryPort, SessionLog, TurnInput, TurnResult, ToolCall } from '../agent-loop/types.js'
import type { ApprovalDecision } from './hook-gate.js'
import type { PendingAction } from '../gateway/index.js'
import type { DelegationHandle, ToolResult } from '@aisy/core' // or the right internal paths

export interface SubAgentRunnerDeps {
  handle: DelegationHandle
  provider: ProviderAdapter
  baseExecuteTool: (call: ToolCall) => Promise<ToolResult>
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  memory: MemoryPort
  sessionLog: SessionLog
  parentNarrowed: boolean
  doNotTouch: string[]
  budgetCheck?: AgentRunnerDeps['budgetCheck']
}

export function makeSubAgentRunner(deps: SubAgentRunnerDeps): AgentRunner {
  // Fresh, empty grant store: the sub-agent inherits NO approvals from the parent.
  const grants = makeGrantStore({ persistence: { loadAlways: () => [], saveAlways: () => {} } })

  const scopedExecute = makeScopedToolExecutor({
    base: deps.baseExecuteTool,
    permitsTool: deps.handle.permitsTool,
    owns: deps.handle.owns,
    doNotTouch: deps.doNotTouch,
  })

  const runner = makeAgentRunner({
    provider: deps.provider,
    memory: deps.memory,
    grants,
    executeTool: scopedExecute,
    approve: deps.approve,
    guardian: deps.handle.guardian,
    sessionLog: deps.sessionLog,
    maxTotalToolCalls: deps.handle.card.maxIterations,
    ...(deps.budgetCheck !== undefined ? { budgetCheck: deps.budgetCheck } : {}),
  })

  return {
    handle: (input: TurnInput): Promise<TurnResult> => {
      // Inherit parent narrowing: a narrowed parent forces the sub-agent's spans
      // to untrusted provenance so the loop narrows and the motivated-call block applies.
      const spans = deps.parentNarrowed
        ? input.spans.map((s) => ({ ...s, provenance: 'untrusted' as const }))
        : input.spans
      return runner.handle({ ...input, spans })
    },
  }
}
```

(Resolve the correct import paths for `ToolResult`/`DelegationHandle` — they may import from the internal modules rather than the package barrel to avoid a self-import cycle. Confirm `makeGrantStore`'s persistence port field names against `safety/index.ts`.)

- [ ] **Step 4: Run to verify pass + build**

Run: `pnpm --filter @aisy/core test -- sub-agent-runner.spec` → PASS. `pnpm --filter @aisy/core build`.

- [ ] **Step 5: Commit**

```bash
git add packages/core-ts/src/runtime/sub-agent-runner.ts packages/core-ts/src/runtime/sub-agent-runner.spec.ts
git commit -F - <<'EOF'
feat(runtime): makeSubAgentRunner — card-scoped child runner with fresh policy (Tier3)

Fresh empty GrantStore (no inherited approvals), scoped executor, per-delegation
guardian, card.maxIterations cap, parent narrowing inherited via span provenance.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Phase B — AgentCard loader

### Task B1: `makeCardResolver` — load `.aisy/agents/*.md` + a bundled default card

**Files:**
- Create: `packages/core-ts/src/runtime/agent-cards.ts`
- Test: `packages/core-ts/src/runtime/agent-cards.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CardResolver {
    resolve(name: string): AgentCard | undefined
    names(): string[]
  }
  export function parseAgentCard(text: string): AgentCard          // throws on missing required keys
  export const DEFAULT_GENERAL_CARD: AgentCard                      // bundled fallback
  export function makeCardResolver(deps: {
    readDir: (dir: string) => string[]                             // file names in .aisy/agents
    readFile: (path: string) => string
    dir: string
    exists: (path: string) => boolean
  }): CardResolver
  ```
  `parseAgentCard` reads YAML frontmatter (hand-rolled: split on the first two `---` lines, parse simple `key: value`, `key: [a, b]`, and `key: { a: 1 }` forms — only the AgentCard keys are needed). `makeCardResolver` loads every `*.md` in `dir` at construction, validates each, and always includes `DEFAULT_GENERAL_CARD` (a read-only general worker: tools `read_file`/`list_dir`/`search_memory` at tier 1, `maxIterations: 12`, `contextStrategy: 'compact'`, `provenance: 'builtin'`). `resolve(name)` returns the card or undefined; a malformed file is skipped with no throw at construction (parse errors only throw from `parseAgentCard` directly).

- [ ] **Step 1: Write the failing tests**

`packages/core-ts/src/runtime/agent-cards.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseAgentCard, makeCardResolver, DEFAULT_GENERAL_CARD } from './agent-cards.js'

const SAMPLE = `---
name: refactorer
description: Refactors a module in place
skills: [typescript, tests]
mcp_allowlist: []
tool_tiers: { read_file: 1, write_file: 2, edit_file: 2 }
max_iterations: 20
context_strategy: compact
provenance: user
---
You refactor one module. Keep the public API stable.`

describe('parseAgentCard', () => {
  it('parses frontmatter into an AgentCard', () => {
    const c = parseAgentCard(SAMPLE)
    expect(c.name).toBe('refactorer')
    expect(c.skills).toEqual(['typescript', 'tests'])
    expect(c.toolTiers).toEqual({ read_file: 1, write_file: 2, edit_file: 2 })
    expect(c.maxIterations).toBe(20)
    expect(c.contextStrategy).toBe('compact')
    expect(c.provenance).toBe('user')
  })
  it('throws when a required key is missing', () => {
    expect(() => parseAgentCard(`---\ndescription: no name\n---\nbody`)).toThrow()
  })
})

describe('makeCardResolver', () => {
  it('loads cards from the dir and always includes the default', () => {
    const files: Record<string, string> = { 'refactorer.md': SAMPLE }
    const r = makeCardResolver({
      dir: '/a/.aisy/agents',
      exists: () => true,
      readDir: () => Object.keys(files),
      readFile: (p) => files[p.split('/').pop()!]!,
    })
    expect(r.resolve('refactorer')?.name).toBe('refactorer')
    expect(r.resolve(DEFAULT_GENERAL_CARD.name)?.name).toBe(DEFAULT_GENERAL_CARD.name)
    expect(r.resolve('nope')).toBeUndefined()
  })
  it('returns only the default when the dir is absent', () => {
    const r = makeCardResolver({ dir: '/a/.aisy/agents', exists: () => false, readDir: () => [], readFile: () => '' })
    expect(r.names()).toEqual([DEFAULT_GENERAL_CARD.name])
  })
  it('skips a malformed card file without throwing at construction', () => {
    const r = makeCardResolver({
      dir: '/a/.aisy/agents', exists: () => true,
      readDir: () => ['broken.md'], readFile: () => 'not a card',
    })
    expect(r.names()).toContain(DEFAULT_GENERAL_CARD.name)
  })
})
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @aisy/core test -- agent-cards.spec` → FAIL.

- [ ] **Step 3: Implement** `packages/core-ts/src/runtime/agent-cards.ts`:

```ts
// AgentCard loader (runtime, ADR-0039/0052).
//
// Loads sub-agent capability cards from .aisy/agents/*.md (YAML frontmatter +
// Markdown body) and always offers a bundled read-only general card so
// delegation works out of the box. The card is the SOLE capability authority —
// the model cannot widen tools/skills/MCP beyond what its card declares.

import type { AgentCard } from '../orchestration/index.js'

export interface CardResolver {
  resolve(name: string): AgentCard | undefined
  names(): string[]
}

export const DEFAULT_GENERAL_CARD: AgentCard = {
  name: 'general',
  description: 'Read-only general worker (search, read, list).',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 1, list_dir: 1, search_memory: 1 },
  maxIterations: 12,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

function stripQuotes(s: string): string {
  const t = s.trim()
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t
}

function parseList(v: string): string[] {
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '').trim()
  if (inner.length === 0) return []
  return inner.split(',').map((x) => stripQuotes(x)).filter((x) => x.length > 0)
}

function parseRecord(v: string): Record<string, number> {
  const inner = v.trim().replace(/^\{/, '').replace(/\}$/, '').trim()
  const out: Record<string, number> = {}
  if (inner.length === 0) return out
  for (const pair of inner.split(',')) {
    const [k, val] = pair.split(':')
    if (k && val !== undefined) out[stripQuotes(k)] = Number(val.trim())
  }
  return out
}

export function parseAgentCard(text: string): AgentCard {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m || !m[1]) throw new Error('agent card: missing YAML frontmatter')
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const name = fm['name'] ? stripQuotes(fm['name']) : ''
  if (name.length === 0) throw new Error('agent card: name is required')
  const ctx = fm['context_strategy'] ? stripQuotes(fm['context_strategy']) : 'compact'
  const prov = fm['provenance'] ? stripQuotes(fm['provenance']) : 'user'
  const card: AgentCard = {
    name,
    ...(fm['description'] ? { description: stripQuotes(fm['description']) } : {}),
    skills: fm['skills'] ? parseList(fm['skills']) : [],
    mcpAllowlist: fm['mcp_allowlist'] ? parseList(fm['mcp_allowlist']) : [],
    toolTiers: fm['tool_tiers'] ? parseRecord(fm['tool_tiers']) : {},
    maxIterations: fm['max_iterations'] ? Number(fm['max_iterations']) : 12,
    contextStrategy: ctx === 'full' ? 'full' : 'compact',
    provenance: prov === 'builtin' ? 'builtin' : prov === 'community' ? 'community' : 'user',
  }
  return card
}

export function makeCardResolver(deps: {
  dir: string
  exists: (path: string) => boolean
  readDir: (dir: string) => string[]
  readFile: (path: string) => string
}): CardResolver {
  const cards = new Map<string, AgentCard>([[DEFAULT_GENERAL_CARD.name, DEFAULT_GENERAL_CARD]])
  if (deps.exists(deps.dir)) {
    for (const f of deps.readDir(deps.dir)) {
      if (!f.endsWith('.md')) continue
      try {
        const card = parseAgentCard(deps.readFile(`${deps.dir}/${f}`))
        cards.set(card.name, card)
      } catch {
        // skip malformed card; the default remains available
      }
    }
  }
  return {
    resolve: (name) => cards.get(name),
    names: () => [...cards.keys()],
  }
}
```

- [ ] **Step 4: Run to verify pass + build** — `pnpm --filter @aisy/core test -- agent-cards.spec` → PASS; `pnpm --filter @aisy/core build`.

- [ ] **Step 5: Export from barrel + commit**

Add to `packages/core-ts/src/index.ts`: `export { makeCardResolver, parseAgentCard, DEFAULT_GENERAL_CARD } from './runtime/agent-cards.js'` and `export type { CardResolver } from './runtime/agent-cards.js'`.

```bash
git add packages/core-ts/src/runtime/agent-cards.ts packages/core-ts/src/runtime/agent-cards.spec.ts packages/core-ts/src/index.ts
git commit -F - <<'EOF'
feat(runtime): AgentCard loader (.aisy/agents/*.md) + bundled default card (Tier3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Phase C — Delegation driver + `spawn_subagent` trigger

### Task C1: `makeDelegationDriver` — concurrent schedule loop with disjointness re-verify

**Files:**
- Create: `packages/core-ts/src/runtime/delegation-driver.ts`
- Test: `packages/core-ts/src/runtime/delegation-driver.spec.ts`

**Interfaces:**
- Consumes: `makeDelegationManager`, a `runSubAgent(handle, task) => Promise<TaskObservation>` callback (built by the caller from `makeSubAgentRunner` + a driver turn-loop), `globMatches`.
- Produces:
  ```ts
  export interface DelegationDriverDeps {
    manager: DelegationManager
    runTask: (handle: DelegationHandle, task: DelegationTask) => Promise<TaskObservation>
    onEvent?: (e: { kind: string; detail: unknown }) => void
  }
  export async function runDelegation(deps: DelegationDriverDeps): Promise<TaskObservation[]>
  ```
  Loop: while there are ready tasks — (1) compute the ready set (`manager.readySet()`), (2) **re-verify write-disjointness** across the ready tasks' `scope.owns` (pairwise; if any overlap, run the overlapping pair sequentially rather than concurrently — never run write-overlapping tasks at once), (3) `manager.spawn(taskId)` each ready task and run them via `runTask` **concurrently** (`Promise.all` over the disjoint batch; overlapping ones serialized), (4) collect `TaskObservation`s, (5) `manager.schedule()` to advance + record cascade-skips, (6) repeat until `readySet()` is empty and `schedule().ready` is empty. Return all observations.

- [ ] **Step 1: Write the failing tests**

`packages/core-ts/src/runtime/delegation-driver.spec.ts` — build a real `makeDelegationManager` over a small `PlanDAG` with a `resolveCard` returning the default card, and a `runTask` that records call order + returns `handle.complete(...)`. Assert:
- a linear A→B plan runs A then B (order preserved by readySet);
- two independent, write-disjoint tasks (owns `['a/**']` and `['b/**']`) run concurrently (e.g. `runTask` resolves on a shared barrier — assert both started before either finished);
- two independent but write-OVERLAPPING tasks (both own `['shared/**']`) are serialized (never both in-flight at once);
- a failed task cascade-skips its downstream (the observation list reflects the skip and the downstream `runTask` is never invoked).

(Use a deterministic concurrency probe: a counter incremented on entry / decremented on exit; assert max-concurrent==2 for disjoint, ==1 for overlapping. Provider/loop are not involved — `runTask` is the injected seam.)

- [ ] **Step 2: Run to verify fail** → FAIL (module not found).

- [ ] **Step 3: Implement** `delegation-driver.ts` per the Interfaces contract. Use `globMatches` to detect pairwise `owns` overlap; group the ready set into disjoint batches (greedy: a task joins the current batch if its `owns` is disjoint from every task already in the batch, else it waits for the next batch). Run each batch with `Promise.all(batch.map(runTask))`. Guard against an empty/stuck schedule (if `readySet()` non-empty but every task errors, surface via `onEvent` and break to avoid an infinite loop).

- [ ] **Step 4: Run to verify pass + build** → PASS; `pnpm --filter @aisy/core build`.

- [ ] **Step 5: Export from barrel + commit**

`export { runDelegation } from './runtime/delegation-driver.js'` + `export type { DelegationDriverDeps } from './runtime/delegation-driver.js'`.

```bash
git add packages/core-ts/src/runtime/delegation-driver.ts packages/core-ts/src/runtime/delegation-driver.spec.ts packages/core-ts/src/index.ts
git commit -F - <<'EOF'
feat(runtime): delegation driver — concurrent ready-set with disjointness re-verify (Tier3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task C2: `spawn_subagent` tool — schema + executor wiring

**Files:**
- Modify: `packages/core-ts/src/runtime/execute-tool.ts` (add a `spawnSubagent?` dep + a `spawn_subagent` case)
- Test: `packages/core-ts/src/runtime/execute-tool.spec.ts` (add cases)

**Interfaces:**
- Consumes: an injected `spawnSubagent?(planJson: string): Promise<TaskObservation[]>` on `ExecuteToolDeps`.
- Produces: a `spawn_subagent` tool case that parses the `plan` arg (JSON string: a single `{intent, assignedTo?, scope?}` task OR a full `PlanDAG`/`LinearPlanLike`), calls `deps.spawnSubagent`, and returns the `TaskObservation[]` as the tool result text. Absent `spawnSubagent` ⇒ the tool reports unavailable (mirrors how `runBash`/`searchMemory` degrade).

- [ ] **Step 1: Write the failing tests** in `execute-tool.spec.ts`:

```ts
it('spawn_subagent dispatches to the injected delegation runner and returns observations', async () => {
  const seen: string[] = []
  const exec = makeToolExecutor({
    fs: fsStub, workspaceRoot: '/w',
    spawnSubagent: async (planJson) => { seen.push(planJson); return [{ delegationId: 'd1', status: 'completed', summary: 'ok', touched: [], result: null, cost: { iterations: 1, spendUsd: 0, wallMs: 1 } }] },
  })
  const r = await exec({ name: 'spawn_subagent', args: { plan: '{"steps":[{"intent":"do it"}]}' } })
  expect(r.ok).toBe(true)
  expect(seen).toHaveLength(1)
  expect(String(r.text)).toContain('completed')
})

it('spawn_subagent reports unavailable when no delegation runner is wired', async () => {
  const exec = makeToolExecutor({ fs: fsStub, workspaceRoot: '/w' })
  const r = await exec({ name: 'spawn_subagent', args: { plan: '{}' } })
  expect(r.ok).toBe(false)
})
```

(Match the real `ToolResult` shape and the file's existing `fsStub` pattern.)

- [ ] **Step 2: Run to verify fail** → FAIL.

- [ ] **Step 3: Implement** — add `spawnSubagent?: (planJson: string) => Promise<TaskObservation[]>` to `ExecuteToolDeps`; add a `case 'spawn_subagent'` that, when `deps.spawnSubagent` is present, validates `args.plan` is a string, calls it, and returns `{ ok: true, text: JSON.stringify(observations) }`; absent ⇒ `{ ok: false, error: 'delegation not available' }`. Import `TaskObservation` from `../orchestration/index.js`.

- [ ] **Step 4: Run to verify pass + build** → PASS; `pnpm --filter @aisy/core build`.

- [ ] **Step 5: Commit**

```bash
git add packages/core-ts/src/runtime/execute-tool.ts packages/core-ts/src/runtime/execute-tool.spec.ts
git commit -F - <<'EOF'
feat(runtime): spawn_subagent tool case in the executor (Tier3 trigger seam)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Phase D — App wiring

### Task D1: Wire delegation into `bin/aisy.ts`

**Files:**
- Modify: `packages/app/src/bin/aisy.ts`

**Interfaces:**
- Consumes: `makeCardResolver`, `makeDelegationManager`, `runDelegation`, `makeSubAgentRunner`, the existing provider catalog + `spend`/`budget` + `approve` + `memory`.
- Produces: a `spawnSubagent(planJson)` closure passed into `makeToolExecutor`, plus the `spawn_subagent` tool added to `TOOLS`.

- [ ] **Step 1: Add the `spawn_subagent` tool to `TOOLS`** (after `search_memory`):

```ts
  { name: 'spawn_subagent', description: 'Delegate a scoped task (or a goal-DAG plan) to a sub-agent defined by an AgentCard. Arg: plan = JSON of {steps:[{intent}]} or a PlanDAG.', input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] } },
```

- [ ] **Step 2: Build the card resolver + delegation deps** near the other store construction:

```ts
const agentsDir = join(base, 'agents') // ~/.aisy/agents/*.md
const cardResolver = makeCardResolver({
  dir: agentsDir,
  exists: (p) => existsSync(p),
  readDir: (d) => (existsSync(d) ? readdirSync(d) : []),
  readFile: (p) => readFileSync(p, 'utf8'),
})

// Per-agent model selection mirrors the main agent's catalog logic; absent ⇒ the
// default selection. Sub-agent spend is attributed under its agent id.
function providerForAgent(agentId: string): ProviderAdapter {
  const sel = providersCfg.agents?.[agentId]
  if (sel?.provider && sel.model) return adapterFor({ provider: sel.provider, model: sel.model })
  return provider // fall back to the main provider/tiered adapter
}
```

- [ ] **Step 3: Build the `spawnSubagent` closure** that constructs a manager + runs the driver:

```ts
const spawnSubagent = async (planJson: string): Promise<TaskObservation[]> => {
  const plan = JSON.parse(planJson) as LinearPlanLike | PlanDAG
  const manager = makeDelegationManager(plan, {
    resolveCard: (name) => cardResolver.resolve(name) ?? cardResolver.resolve(DEFAULT_GENERAL_CARD.name),
    skillTouchedPaths: () => [],   // skills (06) not live yet — default card declares none
    mcpWritable: () => false,      // mcp (07) not live yet — default card allows none
    emit: () => {},                // observability journal wired in Tier 4
  })
  // Inherit the parent's narrowed state (Decision 1). The bin already keeps the
  // Tier-2 `outboundLocked` mirror of the last turn's `result.narrowed`; reading it
  // here makes sub-agents inherit narrowing (one-turn-stale, the same accepted
  // trade-off as #6). A precise live value would need a loop→executor seam — ADR-0052
  // follow-up.
  return runDelegation({
    manager,
    runTask: async (handle, task) => {
      const subRunner = makeSubAgentRunner({
        handle,
        provider: providerForAgent(task.assignedTo ?? handle.card.name),
        baseExecuteTool: executeTool,
        approve,                                   // same human approval port — re-prompts per sub-agent
        memory,
        sessionLog: makeShardSessionLog(handle),   // route the sub-agent log to its shard
        parentNarrowed: outboundLocked,            // Tier-2 narrowed mirror (Decision 1)
        doNotTouch: task.scope.doNotTouch,
      })
      // Drive the sub-agent to a terminal turn, then close the delegation.
      const result = await subRunner.handle({ sessionId: handle.delegationId, spans: [{ role: 'user', provenance: 'operator', text: task.intent }] })
      const cost = { iterations: 1, spendUsd: 0, wallMs: 0 }
      return result.state === 'halted'
        ? handle.fail(result.haltReason ?? 'halted', cost)
        : handle.complete(result.reply, result.reply, cost)
    },
  })
}
```

Note: `makeShardSessionLog(handle)` is a tiny inline adapter — `{ append: (e) => { handle.append(e.kind, e.payload) }, resume: () => null }`. `approve` is the bot-provided port; here in the bin the runner is built by the bot's `buildRunner`, so the `spawnSubagent` closure must be constructed where `approve` is available. **Resolution:** move the `spawnSubagent` construction into the `buildRunner` closure (it already receives `approve`), and thread `spawnSubagent` into `makeToolExecutor` there — i.e. build the executor per-runner with the delegation closure, OR add a setter. Pick the approach that keeps `executeTool` constructed once: build a mutable `let approveRef` the bin sets inside `buildRunner`, and have `spawnSubagent` read `approveRef`. Implementer: choose the cleanest of these two and note it in the report.

- [ ] **Step 4: Pass `spawnSubagent` into `makeToolExecutor`:**

```ts
const executeTool = makeToolExecutor({
  fs: fsPort,
  workspaceRoot,
  searchMemory: makeMemorySearch(memoryStore),
  ...(runBash ? { runBash } : {}),
  spawnSubagent,
})
```

(Mind the ordering/closure issue from Step 3 — `executeTool` is referenced inside `spawnSubagent.runTask` as the sub-agent's base executor AND `spawnSubagent` is passed into `executeTool`. This is a benign cycle through closures since both are only invoked at runtime; if TS/lint complains about use-before-assignment, declare `spawnSubagent` as a `const` after `executeTool` and pass it via a thunk `spawnSubagent: (p) => spawnSubagentImpl(p)`. Resolve cleanly and note it.)

- [ ] **Step 5: Attribute sub-agent spend** — confirm the sub-agent's provider usage is recorded under its agent id. The simplest correct wiring for v1: the sub-agent records via the same `spend` store the bot uses, but keyed on the agent id. Since the loop returns `usage` and the bin's bot records `{ model, usage }` for the MAIN turn only, add a `spend.record({ model, agentId, usage })` inside `runTask` after the sub-agent turn (model = the agent's selected model id; agentId = `task.assignedTo ?? handle.card.name`). Wire it.

- [ ] **Step 6: Build the workspace**

Run: `pnpm -r build` → all three packages clean.

- [ ] **Step 7: Manual smoke (documented, deferred to integration)** — with a card in `~/.aisy/agents/` (or just the default), ask the agent to delegate a read-only task; confirm a `spawn_subagent` call runs a sub-agent confined to `read_file`/`list_dir`/`search_memory` and returns an observation. Record as deferred (no live token in CI).

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/bin/aisy.ts
git commit -F - <<'EOF'
feat(app): wire live sub-agent delegation into aisy run (Tier3)

spawn_subagent tool → card resolver + delegation manager + concurrent driver +
card-scoped sub-agent runners; sub-agent spend attributed by agent id.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Phase E — ADR-0052 + roadmap

### Task E1: ADR-0052 + ADR-0039 status + INDEX + ROADMAP

**Files:**
- Create: `docs/decisions/2026-06-19-live-subagent-runner-seam-and-safety.md` (ADR-0052)
- Modify: `docs/decisions/2026-06-12-first-class-subagent-delegation.md` (ADR-0039 status `Proposed` → `Accepted`, with a note that ADR-0052 realizes the runtime)
- Modify: `docs/decisions/INDEX.md` (add ADR-0052 row above ADR-0051; update ADR-0039 status)
- Modify: `docs/ROADMAP.md` (mark Tier 3 / #8 done)

- [ ] **Step 1: Write ADR-0052** capturing the consequential decisions, MADR style (Status: Accepted, Date: 2026-06-19, Related: ADR-0039, ADR-0050, ADR-0051):
  - **Decision:** live delegation via two additive seams — `makeSubAgentRunner` (card-scoped child runner) and a `spawn_subagent` tool + `DelegationDriver`; the agent loop and Core `Plan` are untouched (goal-DAG normalized in orchestration).
  - **Sub-agent privilege model (the locked security decision):** fresh `SafetyPolicy` over a fresh empty `GrantStore` (no inherited grants); card is the sole tool/tier authority; **inherits parent narrowing** (via span provenance); tier-2/3 **re-prompt** (parent approvals never carry over); tier-3 never grantable; writes confined to the delegation `owns` lane minus `doNotTouch`.
  - **Trigger:** one explicit `spawn_subagent` tool whose payload is a single task or a goal-DAG plan (manager normalizes both). Auto-delegation from a coordinator-emitted multi-task plan is a documented future extension (the data path already supports it).
  - **Execution:** ready tasks run **concurrently** with a write-disjointness re-verify gate per batch; write-overlapping ready tasks are serialized; cascade-skip on upstream failure (all from the existing manager).
  - **Consequences:** positive (real sub-agents with own model/budget/scope; isolation by default; reuses proven scope/tamper/budget machinery; loop + Core untouched). Trade-offs (more approval prompts under card-scoped isolation; skills(06)/MCP(07) resolution are stubbed until those go live, so v1 cards declaring skills/MCP get empty touched-paths/none-writable — the bundled default declares neither; concurrent sub-agent approval cards can interleave in the Telegram UI). Follow-ups: auto-delegation; real `skillTouchedPaths`/`mcpWritable` when 06/07 are live; a precise (not one-turn-stale) parent narrowed state — v1 inherits narrowing via the Tier-2 `outboundLocked` mirror; the exact live value needs a loop→executor seam.
  - **Alternatives considered:** inherit parent grants (rejected — weaker isolation, the user chose card-scoped); read-only sub-agents only (rejected — too limited); auto-delegate from plan as the sole trigger (deferred — less discoverable/testable than an explicit tool); sequential execution (rejected — the user chose concurrent-with-reverify for speed).

- [ ] **Step 2: Bump ADR-0039 to Accepted** — change its `Status:` line to `Accepted` and add one line: "Runtime realized by ADR-0052 (2026-06-19)."

- [ ] **Step 3: Update INDEX.md** — insert above the ADR-0051 row (recent block is latest-first), matching the column order `| ID | Status | Date | Title | Tags |` and the `Accepted  ` two-space format:
```
| ADR-0052 | Accepted  | 2026-06-19 | [Live Sub-Agent Runner Seam & Safety Model](./2026-06-19-live-subagent-runner-seam-and-safety.md) | orchestration, delegation, safety, runtime |
```
Also update the ADR-0039 row's Status from `Proposed` to `Accepted`.

- [ ] **Step 4: Update ROADMAP.md** — mark Tier 3 / #8 ✅ done with the shipping commits and the plan link; note v1 scope (explicit `spawn_subagent`, concurrent-with-reverify, card-scoped isolation, default card) and the documented follow-ups (auto-delegation, skills/MCP resolution, narrowing surface). Mirror how Tier 1/2 were marked done.

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/2026-06-19-live-subagent-runner-seam-and-safety.md docs/decisions/2026-06-12-first-class-subagent-delegation.md docs/decisions/INDEX.md docs/ROADMAP.md
git commit -F - <<'EOF'
docs(adr): ADR-0052 live sub-agent runner seam + safety; mark Tier 3 done

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage (vs ROADMAP Tier 3 / #8 + the user's three decisions):**
- Wire `DelegationManager` into the runner → Phase A (export + `makeSubAgentRunner`) + Phase C (driver + trigger) + Phase D (bin). ✅
- Sub-agents with own model + budget → `providerForAgent` (D2/D3) + `budgetCheck` keyed on agent id + spend attribution (D5); data model already multi-agent. ✅
- **Decision 1 (card-scoped + inherit narrowing):** fresh empty GrantStore + scoped executor + card.toolTiers + narrowing via span provenance (A3); the bin feeds `parentNarrowed` from the Tier-2 `outboundLocked` mirror (D1) so v1 genuinely inherits narrowing (one-turn-stale); locked in ADR-0052. ✅
- **Decision 2 (explicit `spawn_subagent`, single-task or DAG):** C2 tool + D1 schema; manager normalizes both; auto-delegation documented as future. ✅
- **Decision 3 (concurrent with re-verify):** C1 driver runs disjoint batches concurrently, serializes write-overlapping, re-verifies disjointness per batch. ✅
- New ADR for the runner-seam → Phase E (ADR-0052) + ADR-0039 → Accepted. ✅

**Placeholder scan:** new modules have full code; existing types referenced by file:line + the "Exact existing shapes" section. The two genuinely-open implementer choices (the `ToolResult` field names; the `executeTool`↔`spawnSubagent` closure-ordering in the bin) are flagged explicitly with the resolution options to pick from — not silent TODOs. The bin manual smoke is a documented deferral, not a code placeholder.

**Type consistency:** `AgentCard`/`DelegationHandle`/`TaskObservation`/`DelegationTask`/`DelegationScope` are used with the exact fields quoted from `orchestration/types.ts`. `makeSubAgentRunner` reuses `AgentRunnerDeps.budgetCheck`'s exact signature. The scoped executor and the driver both use the orchestration `globMatches` (exported in A2). `spawnSubagent`'s return type `TaskObservation[]` is consistent across C2 (tool), D (bin), and the driver (C1).

**Risk control:** the agent loop, Core `Plan`, and existing safety/grant/tier logic are untouched; every new seam is additive (the executor's `spawnSubagent` is optional; the runner factory is new). Existing 671 core + 89 telegram-gw tests stay green. The highest-risk surface — sub-agent privilege — is isolated by construction (fresh empty GrantStore, card-gated tools, owned-lane writes) and captured in ADR-0052. Skills(06)/MCP(07) being stubbed is explicit and safe (the default card declares neither). Concurrency is bounded by the manager's proven write-disjointness plus the driver's per-batch re-verify.

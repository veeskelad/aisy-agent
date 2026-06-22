# ADR-0052: Live Sub-Agent Runner Seam & Safety Model

- Status: Accepted
- Date: 2026-06-19
- Related: ADR-0039 (first-class delegation design), ADR-0050 (multi-provider catalog + per-agent budget), ADR-0051 (loop control seams)

## Context

ADR-0039 defined first-class sub-agent delegation — AgentCards, goal-DAG plans,
write-disjoint scopes, checkpoint/resume, and cascade-skip — but deliberately
deferred implementation: the `DelegationManager` was built and tested as part of
the orchestration package yet remained dormant (not exported from the `@aisy/core`
barrel, not wired into the runner). ADR-0050 allocated per-agent budget slots and
multi-provider support, noting that sub-agent model/budget inheritance was
"resolved when the live multi-agent runtime exists." This ADR is that runtime.

Three user decisions had to be locked before implementation could proceed:

1. **Privilege model** — whether a sub-agent inherits the parent's approval grants
   or starts with a fresh grant store (card-scoped isolation was chosen).
2. **Trigger** — whether delegation happens via an explicit tool the model calls, or
   by auto-deriving sub-tasks from a coordinator-emitted multi-task plan (explicit
   `spawn_subagent` tool was chosen; auto-delegation is a documented future extension).
3. **Concurrency strategy** — sequential or concurrent-with-write-disjointness-reverify
   (concurrent-with-reverify was chosen).

The goal is to realize sub-agents in Aisy using two additive seams. The agent loop
(`makeAgentLoop`) and the Core `Plan` type are **untouched**; goal-DAG normalization
happens in the orchestration layer.

## Decision

Two additive seams realize the live sub-agent runtime. Neither touches the existing
agent loop nor the Core `Plan` type.

### Seam 1 — `makeSubAgentRunner` (card-scoped child runner)

Each delegation receives its own `AgentRunner` built by `makeSubAgentRunner`. The
child runner is isolated by construction:

- A **fresh `SafetyPolicy`** over a **fresh empty `GrantStore`** — the parent's
  approval grants are not inherited. Any tier-2 or tier-3 action in the sub-agent
  re-prompts for approval; the parent's prior approvals never carry over.
- The **AgentCard** is the sole tool/tier authority: `card.toolTiers` gates which
  tools are available; tools not listed are blocked entirely.
- `card.maxIterations` is the tool-call cap for the sub-agent's run.
- A **scoped tool executor** confines writes to the delegation's `owns` lane minus
  `doNotTouch`; any write attempt outside that lane throws `ScopeViolationError`.
- The sub-agent's span provenance is forced to `untrusted`, inheriting the parent's
  narrowed state: if the parent session was narrowed (e.g., untrusted content in
  context), the sub-agent starts narrowed too.

Tier-3 actions are never grantable — this invariant holds for sub-agents identically
to parent agents. The bundled `general` default card is read-only, reserved, and
frozen: a user-supplied `general.md` cannot shadow it, ensuring a safe fallback when
no card is specified.

Nested delegation is not supported in v1. Sub-agents receive a base executor that
does not include `spawn_subagent`, so the delegation graph is always depth-1 from
the parent runner.

### Seam 2 — `spawn_subagent` tool + `DelegationDriver`

The parent agent gains one new tool: `spawn_subagent`. Its payload is either a
single `DelegationTask` or a goal-DAG plan (`LinearPlanLike | PlanDAG`); the
`DelegationManager` normalizes both into a DAG before execution. A linear task list
is treated as a degenerate DAG (no dependency edges), which is backward-compatible
with existing plan structures.

`runDelegation` (the `DelegationDriver`) executes the normalized DAG:

- **Concurrent batches:** tasks whose `owns` lanes are write-disjoint run
  concurrently within the same ready batch.
- **Per-batch disjointness re-verify gate:** before each batch is dispatched,
  write-disjointness is re-checked across all tasks in the batch. If a race
  introduced an overlap (e.g., a plan that was valid at spawn time but is no longer
  disjoint due to a concurrent write), the batch is split or serialized.
- **Write-overlapping tasks are serialized:** tasks whose `owns` lanes overlap are
  never run concurrently.
- **Cascade-skip on upstream failure:** if a `runTask` call throws, its downstream
  dependents are not spawned; each skipped task emits an explicit `cascade-skip`
  journal entry (no silent drop).

The driver maps each `runTask` failure to a delegation failure rather than
propagating an unhandled exception, ensuring a throwing sub-task degrades gracefully
and does not crash the parent run.

### Sub-agent privilege model (locked security decision)

The user chose **card-scoped isolation + inherit narrowing**. The full model is:

| Property | v1 behavior |
|---|---|
| Grant store | Fresh empty — no inherited approvals |
| Tool/tier authority | AgentCard exclusively |
| Tier-2 actions | Re-prompt; parent approvals never carry over |
| Tier-3 actions | Never grantable (same invariant as parent) |
| Write scope | Delegation `owns` lane minus `doNotTouch` |
| Narrowing | Inherited via span provenance (untrusted) |
| Nesting | No nested delegation in v1 |
| Default card | `general` — read-only, reserved, frozen |

### Narrowing in v1

The binary feeds `parentNarrowed` into the sub-agent runner from the Tier-2
`outboundLocked` mirror: after each parent turn, `TurnResult.narrowed` is mirrored
into the bot's `setOutboundLocked` flag (wired in Tier 2, ADR-0051). The sub-agent
runner reads this mirror value and forces `untrusted` provenance if it is set. This
means sub-agents inherit narrowing one turn stale — safe and conservative. A precise
live value (reading the loop's current session state rather than the post-turn mirror)
would require an additional loop→executor seam and is deferred as a follow-up.

## Consequences

- **Positive:** Aisy sub-agents now run with their own model, budget, and tool scope
  as declared by their AgentCard. Isolation is enforced by construction — fresh grant
  store and scoped executor — so a sub-agent cannot silently inherit elevated
  privileges. The implementation reuses all proven machinery (scope enforcement,
  tamper-evident journal shards, budget attribution by agent-id, SafetyPolicy, tier
  gates). The agent loop and Core are untouched; all 671 core + 89 telegram-gateway
  tests remain green.
- **Neutral:** `DelegationManager` is now exported from the `@aisy/core` barrel and
  wired into the runner. The bin acquires a `spawn_subagent` tool registration. Sub-agent
  budget is attributed by agent-id (already supported by the budget store since ADR-0050)
  but is not enforced mid-sub-turn in v1 — the cap gates at sub-turn entry via the
  existing `budgetCheck` hook.
- **Trade-offs / accepted costs:**
  - Card-scoped isolation means more approval prompts under the default model: every
    tier-2 action in a sub-agent re-prompts even if the same action was approved in
    the parent session. This is intentional and the safer default.
  - Skills (spec 06) and MCP (spec 07) resolution are stubbed: v1 cards that declare
    `skills[]` or `mcp_allowlist[]` receive empty `skillTouchedPaths` and no MCP
    servers. The bundled `general` default card declares neither, so the default path
    is safe. This gap will close when specs 06 and 07 go live.
  - Concurrent sub-agent approval cards (one per active delegation) can interleave
    in the Telegram UI. The user sees multiple outstanding approval requests; the
    ordering is determined by network delivery, not task priority.
  - Narrowing is one turn stale (post-turn mirror, not the live loop value). See
    the narrowing section above.

## Alternatives considered

- **Inherit parent grants.** The sub-agent would start with the parent's approval
  history, reducing re-prompts. Rejected: weaker isolation — a compromised sub-task
  could exploit inherited approvals to perform actions the user approved only in the
  parent context. The user explicitly chose card-scoped isolation.
- **Read-only sub-agents only.** Allow sub-agents to read and report but not write.
  Rejected: too limiting for real delegation tasks (file generation, code edits, API
  calls). The `owns` lane model already provides write confinement at the right
  granularity.
- **Auto-delegation as the sole trigger.** A coordinator plan emitting multiple tasks
  would automatically spawn sub-agents without an explicit tool call. Deferred: less
  discoverable during development, harder to test in isolation, and requires the
  coordinator to produce a well-formed multi-task plan on every applicable turn. The
  explicit `spawn_subagent` tool is the testable wedge; the data path already supports
  auto-delegation as a future extension without schema changes.
- **Sequential execution.** Ready tasks are serialized regardless of write-disjointness.
  Rejected: the user chose concurrent-with-reverify for throughput. Sequential
  execution is the fallback path (for write-overlapping tasks) within the same driver.

## References

- Related ADRs: [ADR-0039](./2026-06-12-first-class-subagent-delegation.md) (delegation design), [ADR-0050](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md) (budget + providers), [ADR-0051](./2026-06-17-loop-control-abort-and-mid-turn-budget.md) (loop seams), [ADR-0021](./2026-06-11-coordinator-workers-orchestration.md) (coordinator-workers + journal), [ADR-0011](./2026-06-11-autonomy-gradient.md) (autonomy tiers), [ADR-0047](./2026-06-16-scoped-approval-grants.md) (scoped grants)
- Plan: [`docs/superpowers/plans/2026-06-19-tier3-subagent-delegation.md`](../superpowers/plans/2026-06-19-tier3-subagent-delegation.md)

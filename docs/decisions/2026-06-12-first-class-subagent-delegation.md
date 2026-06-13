# ADR-0039: First-Class Sub-Agent Delegation & Own-Scope Definition

**Status:** Proposed
**Date:** 2026-06-12
**Tags:** orchestration, delegation, architecture

## Context

Aisy's orchestration (spec 11) is coordinator-workers: a coordinator
decomposes a task into pairwise write-disjoint scopes, workers have no
peer-to-peer channel, every decision is journaled (FOR/AGAINST/because/touched,
monotonic seq, prevHash), and a `ScopeViolationError` blocks both an
out-of-scope write and its journal append. This is sound for *splitting one
agent's work*. It does **not** support delegating to a sub-agent that has its
**own** skills / MCP / tools, nor handing state between agents without loss.

A comparison of three multi-agent references (workflow wf_ab8db1e0-980,
2026-06-12) sharpened the design:

- **OpenHands** (V1 Software-Agent SDK): sub-agents are defined by an
  **AgentCard** (`.agents/*.md`, YAML+MD) with their own system prompt, tool
  list, and `mcp_config`; `TaskToolSet` persists each sub-agent conversation to
  disk and **resumes by `task_id`**; the parent receives a compact
  `TaskObservation`, not the child's full transcript.
- **OpenCode**: child receives only a prompt string and returns text — state
  handoff is lossy and unreliable (Issue #5502); reliability suffers from
  unbounded retries (24.8-day backoff, Issue #25041).
- **OMA** (`open-multi-agent`, "goal → task DAG"): a coordinator builds a
  **goal-DAG** with a topological scheduler, but sub-agent tool-scope is fixed
  at team-creation and cascade-failures are silent.

Aisy already beats all three on tamper-evident state (none have a hash-chained
journal) and on deterministic retry precedence. The gaps are: (1) **linear
`steps[]`**, not a goal-DAG with explicit dependency edges; (2) **no
sub-agent own-scope** mechanism; (3) **no per-delegation journal shard**, so a
parent that ingested a child's full transcript would bloat its context.

## Decision

Add **first-class sub-agent delegation** as an extension to spec 11 (not a new
runtime; it reuses the existing journal, scopes, and precedence). Six parts:

1. **Goal-DAG plan.** Extend the Core (01) `Plan` type to a union:
   `Plan = { steps: PlanStep[] } | PlanDAG { nodes: DelegationTask[]; edges: Dependency[] }`.
   Linear is a degenerate DAG — backward-compatible. A `DelegationTask` carries
   `taskId, intent, assignedTo, dependsOn[], scope, tools[], mcp[],
   outputContract, budgetSlice, retryPolicy, maxIterations`.
2. **AgentCard** (`.aisy/agents/*.md`, YAML frontmatter + Markdown): each
   sub-agent declares `skills[]`, `mcp_allowlist[]`, `tool_tiers[]`,
   `max_iterations`, `context_strategy`, `provenance`. The model cannot widen
   its own capabilities — the card is the authority.
3. **Delegation-scoped journal shards.** Coordinator journal at
   `.aisy/runs/<runId>/journal.jsonl`; each delegation appends to its own
   `.aisy/runs/<runId>/delegations/<delegationId>.jsonl` with its own seq. The
   parent receives a compact `TaskObservation {delegationId, status, summary,
   touched, result, cost}` — **lossless on disk, compact in context**.
4. **Checkpoint/resume per delegation** (the OpenHands `task_id` model):
   `checkpoint.json {delegationId, taskId, scope, snapshot_prefix_hash,
   last_seq}`; re-invoking with the same `delegationId` resumes from `last_seq`
   and resets only the *local* Loop Guardian, inheriting the global budget.
5. **Scope composition at delegation-time:**
   `owns[] = (task scope writes) ∪ (skill touched paths) ∩ (MCP writable servers)`;
   `spawn()` throws `ScopeConflictError` if a declared skill/tool would write
   outside `owns[]`. Pairwise write-disjointness is asserted across **all**
   delegations.
6. **Extended retry precedence + cascade-skip:** per-delegation
   (Guardian → replan → `budgetSlice`) nested inside the run-level precedence
   (coordinator Guardian → coordinator replan → global budget); a downstream
   task that is never spawned because its upstream failed emits an explicit
   `cascade-skip` journal entry (no silent drop).

Scope: **ADR + spec-11 extension + AC tests now; implementation v0.2** (it
requires the Core goal-DAG change).

## Consequences

- **Positive:** sub-agents get their own skills/MCP/tools by declaration;
  state hands off without loss (full shard on disk, compact observation in
  context); results re-integrate through the existing journal reconciliation;
  everything stays inside the existing budgets/tiers and scope enforcement;
  Aisy keeps its tamper-evidence and precedence advantages while gaining the
  DAG + delegation the references demonstrate.
- **Neutral:** a new on-disk layout (`.aisy/runs/<runId>/delegations/`), an
  AgentCard format, and a Core `Plan` union; spec 12 gains `Journal.watch` and
  cascade-skip detection; spec 11's AC-11-1 broadens to all delegations.
- **Negative:** the goal-DAG touches Core (01) — the largest cross-cutting
  change so far; deferred to v0.2; a misdesigned DAG decomposition by the
  coordinator is still a failure mode (mitigated by per-step verification and
  the coordination benchmark, not eliminated).

## Alternatives considered

- **Keep linear `steps[]` + coordinator-workers only.** Rejected: cannot
  express dependency edges or sub-agents with distinct capability scopes — the
  exact gap raised.
- **OpenCode-style prompt-only handoff.** Rejected: lossy and unreliable
  (Issue #5502); discards Aisy's auditable-journal advantage.
- **Parent ingests full child transcript.** Rejected: context bloat (the
  OpenHands un-condensed-log problem); the shard + `TaskObservation` split
  keeps the parent compact while preserving full auditability on disk.
- **OMA-style fixed team scopes.** Rejected: no delegation-time composition;
  cannot scope to the specific paths a task touches.

## References

- Spec: [11 Orchestration](../specs/11-orchestration.md) (delegation extension), [01 Core](../specs/01-core-agent-loop.md) (Plan goal-DAG), [12 Observability](../specs/12-observability-verification.md) (Journal.watch, cascade-skip)
- Related ADRs: [ADR-0021 Coordinator-workers + decision journal](./2026-06-11-coordinator-workers-orchestration.md), [ADR-0005 Own agent loop / generations](./2026-06-11-own-agent-loop.md), [ADR-0026 Plan Mode](./2026-06-11-plan-mode-clarification-verified-todo.md), [ADR-0017 Verification by traces](./2026-06-11-external-verification-by-traces.md), [ADR-0037 Eval & red-team](./2026-06-11-eval-and-red-team-harness.md)
- Reference research: `memory/orchestration-delegation.md` (OpenHands / OpenCode / OMA, workflow wf_ab8db1e0-980)

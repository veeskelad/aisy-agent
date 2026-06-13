# Component 11: Orchestration — Specification

**Status:** Draft
**Component:** 11 / 12
**Related ADRs:** ADR-0021, ADR-0020, ADR-0005
**Depends on:** Core / Agent Loop (01), Observability & Verification (12), Provider Routing (09)

> The deterministic control plane for multi-step work: it decomposes a task into
> isolated, minimally-scoped workers, reconciles their results from a durable decision
> journal, enforces the global retry/spend backstop, and starts a fresh generation when
> a run hits a dead end.

## 1. Purpose

Orchestration is what turns one ambiguous, many-file request into bounded, auditable,
parallel work without letting a fleet of ~70%-adherence models talk themselves into an
expensive corner. The model is a stateless probabilistic CPU; chaining several of them
conversationally compounds error and multiplies token cost (ADR-0021). This component is
the deterministic OS layer (100% adherence) that decides *how* work is split, *where*
each worker may write, *how* their decisions are merged, and *when* the whole run must
stop or restart.

The split is reversibility, applied to a *run* rather than a single tool call. The
**creative/reversible** parts — how to decompose the task, what each worker should
attempt, how to phrase a journal entry, when a generation has hit a dead end — defer to
the model (~70%). The **irreversible/critical** parts — worker scope enforcement, the
no-peer-to-peer rule, journal append-only integrity, the global iteration/spend budget,
the period-3 retry cap, and the decision to terminate a run — are deterministic code that
the model never votes on.

This component is the home of the **coordinator-workers** topology (ADR-0021), the
**generations** mechanism (ADR-0005), and the **Loop Guardian** retry cap (ADR-0020), and
it is where the three independent retry bounds across the harness (Loop Guardian, Plan
Mode re-plan, skill-failure threshold) are unified under one global budget backstop.

## 2. Responsibilities

This component **owns**:

- **Coordinator role** — task decomposition into worker briefs, worker spawn, journal
  reconciliation, and the final merge. The coordinator is the only agent that reads the
  whole Decision Journal and resolves contradictions (ADR-0021).
- **Worker scope contracts** — every spawned worker receives an explicit, machine-checked
  scope (`owns` paths/resources + `doNotTouch` paths/resources) and a write boundary; the
  contract is enforced deterministically, not requested in a prompt (ADR-0021).
- **The Decision Journal** — its on-disk schema, append-only write path, and the
  reconciliation algorithm that detects and resolves contradictory worker entries
  (ADR-0021).
- **The no-peer-to-peer invariant** — workers never message each other; the only channel
  between workers is the coordinator via the journal (ADR-0021).
- **Generations** — detecting a dead-end run and starting a fresh generation that carries
  forward only the constitution plus distilled lessons, dropping the failed transcript
  (ADR-0005).
- **The global iteration/spend budget cap** — the period→3 backstop that bounds total
  iterations, wall-clock, and spend across an entire run, catching the loops that the
  Loop Guardian's period-1/2/3 detector cannot see (e.g. period-4+ cycles).
- **Retry-cap precedence** — the documented, code-enforced interaction between the Loop
  Guardian cap-of-3 (ADR-0020), the Plan Mode re-plan bound (ADR-0026), and the
  skill-failure N≥3 threshold (ADR-0025), all nested under the global budget cap.

This component **does not**:

- Run the per-turn agent loop, assemble prompts, or hold the frozen memory snapshot — that
  is **Core / Agent Loop (01)**; Orchestration spawns workers that each *are* a Core loop
  instance and consumes Core's Plan Mode artifacts.
- Implement the Loop Guardian sliding-window cycle detector itself, the append-only run
  journal, or per-step verification-by-traces — those live in **Observability &
  Verification (12)**; Orchestration *consumes* the Guardian's STOP signal and writes the
  Decision Journal as a distinct orchestration artifact alongside (not inside) the
  observability journal.
- Choose which model serves a worker or apply fallback hysteresis — that is **Provider
  Routing (09)**; Orchestration declares each worker's task class and budget slice, and
  Routing maps it to a provider. The global spend cap is defined *jointly* with Routing
  (see §6).
- Create the sandbox/worktree a worker runs in or enforce its network/filesystem posture
  — that is **Safety (05)** + Tools & Hooks (04); Orchestration supplies the scope
  contract that those layers enforce.
- Author or approve skills — **Skills (06)** owns the N≥3 negative-skill threshold;
  Orchestration only treats that threshold as one input to retry-cap precedence.

## 3. Interfaces

Conceptual API surface. Signatures are illustrative, not binding, and respect the
narrow-waist principle (ADR-0014): Orchestration exposes a coordinator entry point and a
journal, not a new family of tools.

```ts
// illustrative, not binding

type RunId = string
type WorkerId = string
type GenerationId = string

interface WorkerScope {
  owns: string[]          // glob paths / resource ids this worker may write
  doNotTouch: string[]    // explicit denylist; overrides owns on conflict
  taskClass: 'reasoning' | 'critique' | 'routine'  // handed to Provider Routing (09)
  budgetSlice: BudgetSlice                          // share of the run's global cap
}

interface WorkerBrief {
  workerId: WorkerId
  intent: string          // model-written; what this worker should accomplish
  scope: WorkerScope      // code-enforced
}

// One immutable line in the Decision Journal.
interface JournalEntry {
  runId: RunId
  generationId: GenerationId
  workerId: WorkerId      // 'coordinator' for reconciliation entries
  seq: number             // monotonic per run; gaps are a tamper signal
  decidedFor: string      // the chosen option
  decidedAgainst: string  // the rejected option (may be '')
  because: string         // rationale
  touched: string[]       // paths/resources this decision wrote; checked against scope
  ts: string              // ISO-8601
}

interface Coordinator {
  // Decompose; returns briefs whose scopes are guaranteed pairwise write-disjoint.
  decompose(task: Task, gen: GenerationId): WorkerBrief[]
  // Spawn an isolated worker (Core loop + Safety sandbox). Rejects an overlapping scope.
  spawn(brief: WorkerBrief): Promise<WorkerHandle>           // throws ScopeConflictError
  // Read the whole journal for this run and merge; resolves FOR/AGAINST contradictions.
  reconcile(runId: RunId): ReconcileResult                   // { merged | conflicts[] }
}

interface DecisionJournal {
  // Append-only. Rejects any write whose `touched` set violates the worker's scope.
  append(entry: JournalEntry): void                          // throws ScopeViolationError
  read(runId: RunId): JournalEntry[]                         // coordinator-only full read
}

interface BudgetGuard {
  // The period->3 backstop. Charged on every iteration and tool dispatch across the run.
  charge(runId: RunId, cost: IterationCost): BudgetVerdict   // { ok } | { capped, reason }
  status(runId: RunId): { iterations: number; spendUsd: number; wallMs: number }
}

interface GenerationManager {
  // Called when a run is judged dead-ended. New generation carries constitution + lessons only.
  fork(runId: RunId, lessons: DistilledLesson[]): GenerationId
}
```

Events **emitted** (to Observability 12): `run.started`, `worker.spawned`,
`journal.appended`, `scope.violation`, `budget.capped`, `generation.forked`,
`run.reconciled`, `run.terminated`. Events **consumed**: `loop.guardian.stop` (from 12),
`plan.replan.exhausted` (from 01), `skill.failure.threshold` (from 06),
`provider.fallback.exhausted` (from 09).

## 4. Data structures

**Decision Journal** — append-only file per run, in git, surviving history compaction so
coordination state is never lost to context-window trimming (ADR-0021). One JSON object
per line (JSONL); the canonical record is `decided FOR / AGAINST / because`. The `seq`
field is monotonic per run with no gaps — a gap is treated as tampering or loss and fails
reconciliation closed. The journal is a *distinct* artifact from the Observability
append-only run journal (12): the latter records every event for audit, the former records
only worker *decisions* for reconciliation.

```
# .aisy/runs/<runId>/journal.jsonl
{"runId":"r-7f3","generationId":"g-1","workerId":"w-api","seq":1,"decidedFor":"zod schema in src/api/types.ts","decidedAgainst":"inline validation","because":"shared by 3 routes","touched":["src/api/types.ts"],"ts":"2026-06-11T01:12:03Z"}
{"runId":"r-7f3","generationId":"g-1","workerId":"coordinator","seq":2,"decidedFor":"keep w-api schema; w-ui adapts","decidedAgainst":"w-ui's local type","because":"single source of truth","touched":[],"ts":"2026-06-11T01:14:55Z"}
```

**Worker scope contract** — the `WorkerScope` of §3, persisted next to the journal so the
write-disjointness invariant is auditable after the fact.

```
# .aisy/runs/<runId>/scopes/<workerId>.json
{"workerId":"w-api","owns":["src/api/**"],"doNotTouch":["src/ui/**",".aisy/**"],"taskClass":"reasoning","budgetSlice":{"iterations":40,"spendUsd":0.50}}
```

**Generation manifest** — what a fresh generation inherits on a dead-end fork (ADR-0005):
the constitution (verbatim, byte-stable for KV-cache reasons, ADR-0019) plus
`distilledLessons` (short, model-written summaries of why the prior generation failed).
The failed transcript is *not* carried.

```
# .aisy/runs/<runId>/generations/<generationId>.json
{"generationId":"g-2","parent":"g-1","carries":["constitution"],"distilledLessons":["build target was wrong dir; verify path before write"],"droppedTranscriptOf":"g-1"}
```

**Retry-budget ledger** — per-run counters the global cap reads, plus a snapshot of each
nested bound's current count so precedence is auditable (see §5).

```
# .aisy/runs/<runId>/budget.json
{"runId":"r-7f3","global":{"iterationCap":250,"iterations":31,"spendCapUsd":2.00,"spendUsd":0.41,"wallCapMs":1800000,"wallMs":240000},
 "nested":{"loopGuardianTrips":0,"planReplans":1,"skillFailures":{}}}
```

## 5. Behavior & control flow

### 5.1 Coordinator-workers lifecycle (ADR-0021)

```
            ┌──────────────────────────────────────────────┐
 task ───►  │ COORDINATOR (one Core loop, model-written     │
            │   decomposition; code-enforced scopes)        │
            └──────┬───────────────────────────────────────┘
                   │ decompose()  ── code asserts scopes are pairwise write-disjoint
                   ▼
        ┌──────────┴───────────┐ ... spawn() isolated, minimal-scope, sandboxed
        ▼                      ▼
   ┌─────────┐           ┌─────────┐    NO peer-to-peer channel between workers
   │ worker A│           │ worker B│    (deterministic: workers cannot address
   │ owns X  │           │ owns Y  │     each other; only sink is the journal)
   └────┬────┘           └────┬────┘
        │ append(FOR/AGAINST/because, touched) ── code checks touched ⊆ scope.owns
        └──────────┬──────────┘
                   ▼
            ┌──────────────┐  append-only, git-tracked, survives compaction
            │ DECISION     │
            │ JOURNAL      │
            └──────┬───────┘
                   ▼ reconcile(): coordinator reads WHOLE journal,
            ┌──────────────┐  detects contradictory FOR/AGAINST pairs,
            │ RECONCILE +  │  resolves deliberately (one merger, not dialogue)
            │ MERGE        │
            └──────────────┘
```

- **Decomposition** is a model call (~70%); **scope assignment** is code. Before any spawn,
  the coordinator asserts the worker scopes are pairwise write-disjoint; an overlap throws
  `ScopeConflictError` and the run halts rather than spawning conflicting briefs.
- **Worker isolation** is structural: a worker has no handle to any peer and no message
  channel except `journal.append`. The no-peer-to-peer rule is therefore enforced by
  *absence of capability*, not by instruction.
- **Reconciliation** is deterministic: the coordinator scans for two entries whose
  `decidedFor`/`decidedAgainst` are incompatible over the same resource and either picks a
  winner (recording its own `coordinator` journal entry) or, if it cannot, surfaces the
  conflict to the human rather than silently gluing both (ADR-0021).

### 5.2 Retry-cap precedence — the period→3 backstop (Eng-12)

Four independent bounds exist across the harness; this component pins their precedence so
they never silently cancel or stack into an unbounded run:

1. **Loop Guardian cap-of-3** (ADR-0020, owned by Observability 12) — innermost, on the
   *tool-dispatch* path. Detects period 1/2/3 cycles in a sliding window; a cycle
   repeating >3 times sets a STOP. Caught *first* because it is cheapest and most local.
2. **Plan Mode re-plan bound** (ADR-0026, owned by Core 01) — mid-level, on the *step*
   path. A bounded number of step-verification failures forces a re-plan; exhausting the
   re-plan bound escalates to this component.
3. **Skill-failure N≥3** (ADR-0025, owned by Skills 06) — orthogonal, on the *strategy*
   path. N≥3 failures across distinct sessions deprioritize a strategy; it is advisory
   (never a hard veto) and feeds a worker's strategy choice, not the run halt.
4. **Global iteration/spend budget cap** (this component) — outermost backstop. Bounds
   total iterations, wall-clock, and spend per run, catching periods >3 (e.g.
   A-B-C-D-A-B-C-D) that the Loop Guardian by design cannot see (ADR-0020 §Negative).

**Precedence rule (deterministic):** the *tightest* applicable bound fires first and the
run never proceeds past the *first* cap reached. Innermost→outermost: Loop-Guardian STOP →
Plan re-plan exhausted → global budget cap. The skill-failure threshold is advisory and
participates only by lowering strategy priority, so it can never *prevent* a halt. Every
cap is recorded in `budget.json.nested` so an audit can prove which bound stopped the run.

```
on every iteration / tool dispatch:
  Observability.LoopGuardian.check()  ──► STOP?  ──► halt(run, "loop-guardian")    # cap 3, period 1/2/3
  Core.PlanMode.replanExhausted()     ──► yes?   ──► halt(run, "replan-exhausted") # ADR-0026 bound
  BudgetGuard.charge(run, cost)       ──► capped?──► halt(run, "global-budget")    # period->3 backstop
  # skill-failure N>=3 only adjusts strategy priority; does not halt here
```

The global cap's numeric values (iteration count, spend ceiling) are defined **jointly
with Provider Routing (09)**, because spend depends on which provider tier serves each
worker; Orchestration owns the *cap mechanism and precedence*, Routing owns the
*per-provider price* that the spend ceiling is denominated in.

### 5.3 Generations — dead-end fork (ADR-0005)

A run is **dead-ended** when (deterministic triggers, OR-combined): the global budget cap
is hit, the Plan re-plan bound is exhausted, or reconciliation surfaces an unresolvable
contradiction. On a dead end the model is asked to *distill lessons* (~70%, creative); the
fork itself is code:

```
dead-end detected (deterministic)
   ├─ model distills lessons  (short, why g_n failed)
   ├─ code writes generation manifest: carries = constitution + distilledLessons only
   ├─ code DROPS the failed transcript of g_n (not carried into g_{n+1})
   └─ code resets the per-generation budget counters; the run-level spend cap is NOT reset
```

The fresh generation starts clean of the failed path but never of the global spend ceiling
— forking is not a budget-reset loophole. A dead-end that recurs is itself bounded by the
same global cap, so generations cannot multiply unboundedly.

### 5.4 First-class sub-agent delegation (ADR-0039, v0.2)

§5.1 splits *one* agent's work across write-disjoint worker scopes. Delegation
extends this to sub-agents that carry their **own** skills / MCP / tools, with
state handed off without loss. It reuses the journal, scopes, precedence, and
`ScopeViolationError` already specified above; nothing here is a new runtime.

**Plan becomes a goal-DAG.** The Core (01) `Plan` type widens to a union — a
linear `steps[]` is a degenerate DAG, so existing plans are unaffected:

```ts
// illustrative
type Plan = { steps: PlanStep[] } | PlanDAG
interface PlanDAG { nodes: DelegationTask[]; edges: Dependency[] }
interface DelegationTask {
  taskId: string
  intent: string
  assignedTo: string          // AgentCard name (or null → resolved at serve-time)
  dependsOn: string[]         // explicit edges → deterministic ready-set
  scope: { owns: string[]; doNotTouch: string[]; taskClass: string }
  budgetSlice: { tokenCeiling: number; dollarCeiling: number }  // drawn from the global cap
  outputContract: string      // what the parent expects back
  retryPolicy: { maxReplans: number; maxIterations: number }
}
interface Dependency { from: string; to: string }   // from must complete before to is ready
```

**AgentCard** — `.aisy/agents/<name>.md`, YAML frontmatter + Markdown body; the
sole authority for a sub-agent's capabilities (the model cannot widen them):

```
# .aisy/agents/<name>.md
---
name: read-only-analysis
description: ...
skills: [grep-codebase, summarize]      # resolved against Skills (06)
mcp_allowlist: [tracker]                 # filtered from the MCP (07) allowlist
tool_tiers: { read_file: 0, search_memory: 0 }
max_iterations: 20
context_strategy: compact                # leaf agents compact; coordinator keeps full
provenance: builtin                      # trust-by-source (spec 06 AC-06-29)
---
<human-readable constraints / role>
```

**Delegation-scoped journal shards** (extends §4). The coordinator journal stays
at `.aisy/runs/<runId>/journal.jsonl`; each delegation appends to its own shard:

```
# .aisy/runs/<runId>/delegations/<delegationId>.jsonl  (own monotonic seq + prevHash)
# .aisy/runs/<runId>/delegations/<delegationId>/checkpoint.json
#   { delegationId, taskId, scope, snapshotPrefixHash, lastSeq }
```

The parent never ingests the child's transcript; it receives a compact,
lossless-auditable `TaskObservation { delegationId, status, summary, touched,
result, cost }`. The full shard persists on disk for post-mortem — this is how
"handoff without information loss" is satisfied without context bloat.

**Delegation lifecycle** (spawn → checkpoint → resume → reconcile):

```
[spawn] compose scope (§5.5) → write checkpoint.json → journal delegation.spawned
        spawn is ASYNC: coordinator continues planning; only synthesis blocks
[run]   sub-agent appends to its shard (lastSeq advances); own Loop Guardian +
        replan bound + budgetSlice nested inside the run-level precedence (§5.2)
[resume] re-invoke with same delegationId → reload checkpoint → continue at lastSeq
         (resets only the LOCAL Guardian; inherits the global budget)
[reconcile] coordinator reads all shards, applies the §5.1 contradiction +
         write-disjoint reconciliation across ALL delegations; a downstream task
         never spawned because its upstream failed emits an explicit
         `cascade-skip` journal entry (no silent drop)
```

### 5.5 Scope composition at delegation-time (ADR-0039)

`spawn(DelegationTask)` computes the sub-agent's writable set deterministically,
before any work:

```
owns[] = (task.scope.owns) ∪ (skill touched paths, from Skills 06)
                            ∩ (MCP servers classified writable, from MCP 07)
```

If any declared skill/tool would write outside `owns[]`, `spawn()` throws
`ScopeConflictError` and no sub-agent starts. Pairwise write-disjointness is
asserted across **all** active delegations, not just sibling workers — so two
delegations can never hold overlapping write scope.

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (01)** — each worker and the coordinator *are* Core loop instances;
    Orchestration consumes Core's Plan Mode artifacts (`PLAN.md`/`TODO.md`) and the
    re-plan-exhausted signal (ADR-0005, ADR-0026).
  - **Observability & Verification (12)** — supplies the Loop Guardian STOP signal and the
    sliding-window cycle detector (ADR-0020); records orchestration events. The Loop
    Guardian *implementation* lives there; this component only consumes its verdict.
  - **Provider Routing (09)** — maps each worker's `taskClass` to a provider and applies
    fallback hysteresis (ADR-0018); co-defines the global spend cap's dollar values.
  - **Safety (05) + Tools & Hooks (04)** — create and enforce the per-worker
    sandbox/worktree that gives the scope contract its teeth (ADR-0012).
  - **Skills (06)** — provides the N≥3 negative-skill threshold (ADR-0025) consumed as one
    input to retry-cap precedence.
- **External:** none beyond the monorepo runtime (TypeScript/Node, ADR-0004; pnpm
  workspace, ADR-0003). No third-party orchestration framework — the loop and its
  orchestration are owned, not delegated to an SDK (ADR-0005).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** (no run state on disk) | `.aisy/runs/<runId>/` absent or empty at coordinator init | **fail-closed**: refuse to spawn workers; treat as a brand-new generation `g-1` with fresh budget ledger; no orphan workers from a prior crash are resumed | Coordinator creates run dir, scopes, empty journal, budget ledger; begins decomposition |
| **Observability (12) Loop Guardian unavailable** | STOP-signal channel unreachable / no heartbeat on dispatch path | **fail-closed**: do not run unattended; the global budget cap (this component) becomes the *only* backstop and its iteration cap is tightened to a conservative floor; run is flagged degraded | Resume normal caps when Guardian heartbeat returns; degraded incident logged |
| **Provider Routing (09) unavailable** | worker spawn cannot resolve a provider / Routing returns `fallback.exhausted` | **fail-closed** for the run: do not silently pick a provider; halt and escalate; spend cap cannot be denominated, so no further charged iterations | Run resumes when Routing recovers; partial journal preserved for re-reconciliation |
| **Core (01) re-plan signal unavailable** | `plan.replan.exhausted` channel silent while Plan Mode active | **degrade**: fall back to the global budget cap as the sole iteration bound (period→3 backstop); log that the mid-level bound is missing | Restore precedence chain when Core signal returns |
| **Scope violation** (worker writes outside `owns` / into `doNotTouch`) | `journal.append` checks `touched ⊆ scope.owns ∧ touched ∩ doNotTouch = ∅`; deterministic | **fail-closed**: reject the append, mark the worker faulted, do not merge its work | Coordinator re-scopes and re-spawns, or surfaces to human; offending write never enters the merge |
| **Peer-to-peer attempt** (worker tries to reach a peer) | no peer channel exists; any such call has no target | **fail-closed by absence of capability**: the call cannot resolve; logged as `scope.violation` | None needed — the channel does not exist; entry stays journal-only |
| **Journal contradiction** (two workers' FOR/AGAINST incompatible) | reconcile() finds incompatible entries over one resource | **fail-closed on merge**: do not glue both; coordinator either picks a winner (records a `coordinator` entry) or escalates to human | Human or coordinator resolves; merge proceeds only after resolution |
| **Journal `seq` gap / tamper** | monotonic `seq` has a gap or duplicate | **fail-closed**: reconciliation aborts; run halted as untrusted | Restore journal from git or re-run the affected workers under a new generation |
| **Loop Guardian trips** (period 1/2/3 cycle >3 repeats) | Guardian STOP signal (ADR-0020) | **fail-closed**: break the loop, pause the run, escalate with a diff card; never auto-resume | Human reviews the window; resumes or re-plans |
| **Period >3 cycle** (Guardian blind spot) | global budget cap reached without a Guardian trip | **fail-closed**: halt on `global-budget`; record which cap fired | Human reviews; fresh generation if continued |
| **Dead-end run** | budget cap hit / re-plan exhausted / unresolvable contradiction | **degrade then fresh generation**: distill lessons, fork carrying constitution + lessons only, drop failed transcript; global spend cap NOT reset | New generation proceeds; recurrence bounded by the same global cap |
| **Budget cap reached mid-worker** | `BudgetGuard.charge` returns `capped` | **fail-closed**: no further charged iteration; in-flight worker output up to the cap is journaled, not discarded | Human raises cap or accepts partial result |

## 8. Security & threat model

Orchestration is security-relevant: it spawns autonomous workers and is the spend/loop
backstop for unattended runs. Threats below are mitigated by **deterministic code**;
worker *content* (what each worker reasons or proposes) stays with the model.

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **Tampering** — a worker writes outside its lane and corrupts another's files | `touched ⊆ owns ∧ touched ∩ doNotTouch = ∅` checked on every `journal.append`; violating writes never enter the merge | code (this component) + sandbox/worktree (Safety 05, ADR-0012) |
| **Elevation of privilege** — worker A influences worker B via side channel | No peer-to-peer channel exists; workers can only append to the journal, read by the coordinator alone. Influence is impossible by absence of capability (ADR-0021) | code |
| **Denial of service / unbounded spend** — runaway loop burns tokens overnight (the OpenClaw A-B-A-B incident, ADR-0020) | Loop Guardian period-1/2/3 cap-of-3 catches short cycles; the global iteration/spend budget cap (period→3 backstop) bounds worst-case spend for periods >3; precedence is fixed so the tightest bound fires first | code (Guardian in Obs 12; budget cap here) |
| **Repudiation** — no audit trail of who decided what | Append-only, git-tracked Decision Journal with monotonic `seq`; `FOR/AGAINST/because` per decision; gaps fail closed. Survives history compaction so the audit cannot be erased by context trimming (ADR-0021) | code |
| **Spoofing / learned helplessness** — a single transient failure fossilizes into a permanent "never do X" that silently routes every worker away from a capability | Skill-failure threshold is N≥3 across distinct sessions and **advisory only** (lowers strategy priority, never a hard veto in precedence); it can never prevent a run from proceeding or halting (ADR-0025) | code (threshold in Skills 06; advisory-only use here) |
| **Information disclosure across generations** — failed transcript leaks into a fresh start, re-injecting a poisoned path | A generation fork carries *only* the constitution (byte-stable, ADR-0019) + distilled lessons; the failed transcript is dropped, not carried (ADR-0005) | code |
| **Budget-reset evasion** — forking a generation to escape the spend ceiling | Per-generation counters reset on fork; the **run-level spend cap is not reset**, so generations cannot be used to evade the global budget | code |

What is enforced by **code**: scope contracts, the no-peer-to-peer invariant, journal
append-only integrity and `seq` monotonicity, the global budget cap and the
innermost→outermost precedence, the transcript-drop on generation fork, and the
no-budget-reset-on-fork rule. What defers to the **model** (~70%): task decomposition,
worker intent, journal entry wording, lesson distillation. None of the model's outputs can
relax a code-enforced bound.

## 9. Acceptance criteria (mandatory)

Each criterion is a single objectively verifiable assertion for a Phase-3 test.

1. **AC-11-1** — Given a multi-file task, `decompose()` returns ≥2 worker briefs whose
   `scope.owns` glob sets are **pairwise write-disjoint**; a fixture with overlapping
   `owns` causes `spawn()` to throw `ScopeConflictError` and **zero** workers are spawned.
   *(Happy path + ADR-0021 scope contract.)*
2. **AC-11-2** — A worker whose `journal.append` carries a `touched` path **outside** its
   `scope.owns` (or inside `doNotTouch`) is rejected with `ScopeViolationError`, the entry
   does **not** appear in `journal.jsonl`, and that worker's output is **absent** from the
   `reconcile()` merge. *(Finding 2; §7 scope violation; §8 tampering.)*
3. **AC-11-3** — There is **no API by which one worker can address or message another**:
   a test that attempts a worker-to-worker call finds no such handle/method, the attempt
   resolves to no target, and a `scope.violation` event is emitted. The only inter-worker
   write observed in the run is via `journal.append`. *(Finding 2; §8 elevation of privilege.)*
4. **AC-11-4** — Given two journal entries with incompatible `decidedFor`/`decidedAgainst`
   over the same resource, `reconcile()` does **not** emit a merge containing both; it
   either writes a `coordinator` resolution entry (one winner) **or** returns a non-empty
   `conflicts[]` escalation. *(Finding 2; §7 journal contradiction.)*
5. **AC-11-5** — A `journal.jsonl` with a missing or duplicate `seq` value causes
   `reconcile()` to abort and the run to be marked halted/untrusted; no merge is produced.
   *(§7 seq gap/tamper; §8 repudiation.)*
6. **AC-11-6** — The Decision Journal is **append-only**: a test that mutates or deletes an
   existing line is detected (by `seq` check and/or git diff) and reconciliation fails
   closed. After a simulated history-compaction event, all prior journal entries remain
   readable from disk. *(Finding 2; ADR-0021 durability; §8 repudiation.)*
7. **AC-11-7** — When the Loop Guardian emits STOP for a period-1, period-2 (A-B-A-B), or
   period-3 (A-B-C) cycle that repeats **more than 3** times, the run **halts** with reason
   `loop-guardian`, no further tool dispatch occurs, and a review card is surfaced; the run
   does **not** auto-resume. *(Finding 4; ADR-0020; §7 Loop Guardian trips.)*
8. **AC-11-8** — A cycle of **period 4** (A-B-C-D-A-B-C-D) does **not** trip the Loop
   Guardian but **does** halt the run via the global budget cap with reason
   `global-budget`; `budget.json.nested` records that the global cap (not the Guardian)
   fired. *(Finding 1 + 4; §7 period >3; §8 DoS/unbounded spend.)*
9. **AC-11-9** — With all four bounds armed, when more than one cap would apply on the same
   iteration, the run halts on the **tightest/innermost** bound that fired first
   (Loop-Guardian STOP before re-plan-exhausted before global-budget), and `budget.json`
   records exactly which bound stopped the run. *(Finding 1; §5.2 precedence.)*
10. **AC-11-10** — The skill-failure threshold (N≥3) **never halts** a run on its own: a
    fixture with ≥3 skill failures lowers the affected strategy's priority in a worker's
    choice but produces **no** run-level halt attributable to the skill threshold. *(Finding 1;
    ADR-0025 advisory-only; §8 learned helplessness.)*
11. **AC-11-11** — The global iteration/spend budget cap's spend ceiling is denominated
    using Provider Routing (09) per-provider prices: a test changing a worker's `taskClass`
    (and thus its provider) changes the computed spend charged per iteration; with Routing
    unavailable, no further **charged** iteration proceeds and the run fails closed.
    *(Finding 1 coordination with Routing; §7 Routing unavailable.)*
12. **AC-11-12** — On a dead-end (budget cap hit / re-plan exhausted / unresolvable
    contradiction), `fork()` produces a new `generationId` whose manifest `carries` lists
    **only** `constitution` + `distilledLessons`, the prior generation's transcript is
    **not** present in the new generation's context, and per-generation counters reset.
    *(Finding 3; ADR-0005; §7 dead-end run.)*
13. **AC-11-13** — A generation fork does **not** reset the run-level spend cap: after a
    fork, `budget.json.global.spendUsd` retains its pre-fork value (within tolerance) and a
    run that dead-ends repeatedly is still halted by the same global ceiling. *(Finding 3 + 1;
    §8 budget-reset evasion.)*
14. **AC-11-14** — Cold start with an empty/absent `.aisy/runs/<runId>/` causes the
    coordinator to fail closed (spawn **zero** workers), create a fresh `g-1` run dir +
    empty journal + budget ledger, and resume **no** orphaned workers from a prior crash.
    *(§7 cold start.)*
15. **AC-11-15** — With Observability (12) Loop Guardian unavailable, the run does not
    execute unattended at normal caps: the global iteration cap is tightened to its
    conservative floor and the run is flagged degraded; the degraded state is recorded.
    *(§7 Loop Guardian unavailable; §8 DoS backstop.)*

### Delegation (ADR-0039, v0.2)

16. **AC-11-16** — A linear `steps[]` plan is accepted as a degenerate goal-DAG: an
    existing plan runs unchanged, and a `PlanDAG` with explicit `dependsOn` edges yields a
    deterministic ready-set (a task becomes ready only when all its `dependsOn` complete).
    *(§5.4 goal-DAG.)*
17. **AC-11-17** — A sub-agent spawned from an AgentCard is restricted to that card's
    `skills` / `mcp_allowlist` / `tool_tiers`; a tool or MCP server not on the card is
    refused, and a model-emitted attempt to widen the card is ignored. *(§5.4 AgentCard.)*
18. **AC-11-18** — `spawn()` composes `owns[] = task.scope.owns ∪ skill-touched ∩
    MCP-writable`; a declared skill/tool that would write outside `owns[]` throws
    `ScopeConflictError` and **no** sub-agent starts; pairwise write-disjointness holds
    across all active delegations. *(§5.5 scope composition.)*
19. **AC-11-19** — The parent receives a compact `TaskObservation {delegationId, status,
    summary, touched, result, cost}`, never the child's full transcript; the child's full
    shard persists at `.aisy/runs/<runId>/delegations/<delegationId>.jsonl` with its own
    monotonic seq + prevHash chain. *(§5.4 shards — handoff without loss.)*
20. **AC-11-20** — Re-invoking a failed delegation with the same `delegationId` resumes
    from `checkpoint.json.lastSeq` (resetting only the local Loop Guardian, inheriting the
    global budget); a downstream task whose upstream failed is never spawned and emits an
    explicit `cascade-skip` journal entry. *(§5.4 resume + cascade-skip.)*

## 10. Open questions

- **Numeric global cap values** (iteration count, spend ceiling, wall-clock) are defined
  jointly with Provider Routing (09) and depend on June-2026 provider pricing; the exact
  defaults are deferred to the Routing spec and ADR-0018, with this component owning only
  the cap *mechanism* and precedence.
- **Lesson-distillation quality** on a dead-end fork is a model output (~70%); whether a
  deterministic linter on `distilledLessons` (analogous to the Plan Mode trace linter,
  ADR-0026) is warranted is deferred to a later milestone.
- **Coordinator-as-single-merger** is intentional (ADR-0021) and not a bottleneck for
  reversible work; whether very large fan-outs need a two-level coordinator is out of scope
  for v1.

## 11. References

- ADRs:
  - [ADR-0021 — Coordinator-Workers Orchestration + Decision Journal](../decisions/2026-06-11-coordinator-workers-orchestration.md)
  - [ADR-0039 — First-Class Sub-Agent Delegation & Own-Scope Definition](../decisions/2026-06-12-first-class-subagent-delegation.md)
  - [ADR-0020 — Loop Guardian (period 1/2/3 detection)](../decisions/2026-06-11-loop-guardian.md)
  - [ADR-0005 — Own Agent Loop / Generations](../decisions/2026-06-11-own-agent-loop.md)
  - [ADR-0026 — Plan Mode (re-plan bound)](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md)
  - [ADR-0025 — Transient-vs-Permanent Skill Failure (N≥3)](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md)
  - [ADR-0018 — Model Router with Hysteresis Fallback (spend cap denomination)](../decisions/2026-06-11-model-router-hysteresis-fallback.md)
  - [ADR-0011 — Autonomy Gradient (tiers feeding worker scope)](../decisions/2026-06-11-autonomy-gradient.md)
  - [ADR-0012 — Docker Sandbox Default (worker isolation)](../decisions/2026-06-11-docker-sandbox-default.md)
  - [ADR-0019 — Stable-Prefix KV-Cache (byte-stable constitution carry)](../decisions/2026-06-11-stable-prefix-kv-cache.md)
- Concept docs:
  - [Nightly Consolidation](../concepts/nightly-consolidation.md) (the unattended runs this component backstops)
  - [Safety Layer](../concepts/safety-layer.md) (worker sandbox posture)

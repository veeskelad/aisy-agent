# Component 01: Core / Agent Loop — Specification

**Status:** Draft
**Component:** 01 / 12
**Related ADRs:** ADR-0005, ADR-0007, ADR-0008, ADR-0019, ADR-0026, ADR-0027
**Depends on:** Memory (03), Provider Routing (09), Tools & Hooks (04), Observability & Verification (12)

> The stateless turn loop that assembles a byte-stable prompt, drives the model
> through Plan Mode, dispatches tool calls through deterministic hooks, and persists
> every step to a durable session log so a crash never loses work.

## 1. Purpose

The Agent Loop is the kernel of the OS-around-the-model. The model is a stateless
probabilistic CPU at ~70% instruction adherence; the loop is the deterministic process
manager at 100% adherence that schedules each model call, owns the bytes of the prompt,
and disposes of what the model proposes.

The split is explicit and load-bearing:

- **Deterministic code (100%)** owns: prompt assembly and the byte-stable prefix
  ([ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md)); the per-session frozen
  memory snapshot ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)); the
  loop state machine and Plan Mode gates ([ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md));
  provenance tagging and capability narrowing ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md));
  the append-only durable session log; and the retry/loop/skill-failure caps.
- **The model (~70%)** owns: task decomposition, the *content* of a plan, tool
  selection, and the prose/code it emits. The loop never trusts a self-report; a step
  closes only on a real verification trace, never on the model's narration.

Owning the loop rather than adopting a turnkey SDK is a deliberate decision
([ADR-0005](../decisions/2026-06-11-own-agent-loop.md)): the three surfaces an SDK would
hide — deterministic hooks, byte-stable KV-cache prefix, and task-based routing — are
exactly Aisy's core value.

## 2. Responsibilities

What the Agent Loop **owns**:

- The turn state machine: `assemble → plan? → call-model → hook-gate → dispatch → verify → persist → repeat`.
- **Prompt assembly** into a byte-stable, append-only structure with cache breakpoints
  at the boundaries defined in [ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md).
- **Deterministic L1 serialization** of the always-loaded prefix so two sessions over
  unchanged files produce byte-identical bytes (sorted keys, no volatile timestamps).
- Requesting and **freezing the per-session memory snapshot** at session start
  ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)).
- **Plan Mode** as a loop state: the planning trigger score, the plan-lint gate, the
  plan→execute hard stop, per-step verified execution, the clarification gate, and the
  re-plan path ([ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md)).
- **Provenance tagging** of every assembled span and entry into narrowed capability
  mode when an `untrusted` span is present ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)).
- The **durable session log**: append-only on-disk STATE that survives any crash and is
  the resume point.
- **Cap precedence**: arbitrating between Plan-Mode re-plan, the Loop Guardian cycle cap,
  and the skill-failure threshold so they compose deterministically.
- The **within-session forget protocol**: deciding what `forget this` does given a frozen
  prefix plus a live FTS5 index.

What it explicitly **does not** do (and who owns it):

- It does not store or index memory facts, nor execute the soft-delete/forget-list
  mutation — **Memory (03)** owns the bi-temporal store, FTS5 reindex, and `do_not_remember`
  table. The loop *invokes* those and freezes their snapshot.
- It does not decide allow/deny/ask for a tool call, run HARD_DENY regex, or enforce the
  outbound lockout matcher — **Tools & Hooks (04)** and **Safety (05)** own the
  Pre/PostToolUse hooks. The loop passes provenance and the narrowed-mode flag *into* them
  and obeys their verdict.
- It does not classify a span as trusted/untrusted — **Safety (05)** / the Input
  Classifier owns the tagging logic; the loop carries the resulting label and never lets
  the model set its own provenance.
- It does not choose a provider or run the hysteresis counter — **Provider Routing (09)**
  owns that; the loop hands it a typed request and consumes the chosen adapter.
- It does not run the cycle-detection algorithm or write the journal — **Observability &
  Verification (12)** owns the Loop Guardian and the append-only journal; the loop consults
  the Guardian's verdict and emits journal events.

## 3. Interfaces

Conceptual API surface (TypeScript-shaped, illustrative, not binding). The loop keeps a
narrow waist ([ADR-0014](../decisions/2026-06-11-narrow-waist-tool-set.md)): a single
`runTurn` entry point, everything else injected.

```ts
// illustrative, not binding

export type Provenance = "operator" | "untrusted"

export interface ContextSpan {
  role: "system" | "user" | "assistant" | "tool"
  provenance: Provenance      // set by code at ingestion, never by the model
  text: string
}

export interface FrozenSnapshot {
  prefixBytes: Uint8Array      // byte-stable L1 serialization, sorted keys, no timestamps
  prefixHash: string           // sha256 of prefixBytes; identity for KV-cache + tests
  breakpoints: number[]        // up to 4 cache-breakpoint offsets (ADR-0019)
  takenAt: string              // from injected Clock, recorded in log, NOT in prefixBytes
}

export interface Plan {
  steps: PlanStep[]
}
export interface PlanStep {
  intent: string
  tools: string[]
  irreversible: boolean
  trace: VerificationTrace     // mandatory; linter rejects a step without one
}

// Enumerated probe set — a trace MUST be exactly one of these (ADR-0026, ADR-0017).
export type VerificationTrace =
  | { kind: "file"; path: string; existsExpected: true; sha256?: string }
  | { kind: "sql"; query: string; expectRows: number | { op: "=" | ">" | ">="; n: number } }
  | { kind: "http"; method: string; url: string; expectStatus: number }
  | { kind: "exit"; argv: string[]; expectCode: number }

export interface TurnInput {
  sessionId: string
  spans: ContextSpan[]         // already provenance-tagged by Safety/Classifier
}

export interface TurnResult {
  reply: string
  state: "ok" | "awaiting-clarification" | "awaiting-approval" | "halted"
  haltReason?: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded"
}

export interface AgentLoop {
  runTurn(input: TurnInput): Promise<TurnResult>
}

// Injected collaborators — all are seams (ADR test-seam requirement, see §9).
export interface Clock { now(): string }                       // injectable, deterministic in tests
export interface ProviderAdapter {                              // owned by Provider Routing (09)
  complete(req: ModelRequest): Promise<ModelResponse>          // throws ProviderError on 429/5xx/timeout
}
export interface HookGate {                                     // owned by Tools & Hooks (04) / Safety (05)
  pre(call: ToolCall, ctx: HookCtx): Promise<"allow" | "deny" | "ask" | { modify: ToolCall }>
  post(call: ToolCall, result: unknown): Promise<void>
}
export interface MemoryPort {                                   // owned by Memory (03)
  snapshot(): Promise<FrozenSnapshot>                           // L1 read-once-and-freeze
  forget(factRef: string, humanConfirmed: boolean): Promise<void>
}
export interface LoopGuardian {                                 // owned by Observability (12)
  observe(call: ToolCall): { trip: boolean; period?: 1 | 2 | 3 }
  note(event: "replan"): void                                  // re-plan boundary reset (Eng-12)
}
export interface SessionLog {                                   // durable, append-only, on disk
  append(entry: LogEntry): void                                // fsync before the side-effecting act
  resume(sessionId: string): TurnState | null
}
```

**Events emitted** (to Observability 12): `turn.start`, `prompt.assembled`,
`snapshot.frozen`, `plan.linted`, `plan.gate`, `clarification.raised`, `step.verified`,
`step.failed`, `replan.entered`, `guardian.tripped`, `provider.exhausted`, `forget.requested`,
`turn.end`. **Events consumed:** the HookGate verdict, the Provider adapter result, the
Loop Guardian verdict.

## 4. Data structures

### 4.1 The byte-stable prefix (ADR-0019)

The prefix is the cacheable head of every request, ordered most-stable-first so a change
never poisons a more-stable segment. Up to 4 cache breakpoints, each ≥ ~1024–2048 tokens:

1. System prompt + `constitution.md`
2. `SOUL.md` + `USER.md`
3. `MEMORY.md` index (frozen snapshot for the session)
4. Reserved boundary before append-only conversation history

The conversation tail after breakpoint 4 is **append-only**: a turn appends spans, never
rewrites earlier ones, so no cached byte is mutated.

### 4.2 Deterministic L1 serialization (Eng-10, ADR-0019)

`FrozenSnapshot.prefixBytes` MUST be a pure function of the L1 file contents. The
serializer:

- emits object keys in a fixed lexicographic sort order;
- contains **no** wall-clock timestamps, PIDs, run ids, random nonces, or map-iteration
  order;
- normalizes line endings to `\n` and trailing whitespace;
- records `takenAt` (from the injected `Clock`) only in the **session log**, never inside
  `prefixBytes`.

Invariant: two sessions started over identical L1 files produce identical `prefixHash`.
This is what keeps the KV-cache valid across a fallback rebuild and what the test seam in
§9 asserts.

### 4.3 Plan / TODO artifact (ADR-0026)

`PLAN.md` / `TODO.md` follow the anima_sdk file-state pattern: an ordered list of
`PlanStep`. Each step carries `intent`, `tools`, an `irreversible` flag, and exactly one
`VerificationTrace` from the enumerated probe set (§3). The artifact is written by the
model and lives on disk; the loop reads it through the linter.

### 4.4 Plan linter rules (Eng-5, ADR-0026)

The deterministic linter rejects a plan if **any** of:

- **R1 — missing trace.** A step has no `trace` field.
- **R2 — unflagged irreversible.** A step uses a tool classified irreversible (Tier ≥ 2,
  per [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md)) but `irreversible !== true`.
- **R3 — vacuous trace.** The trace asserts nothing about the world: an `exit` trace whose
  `argv` is a no-op (`echo`, `true`, `:`, `printf`), an `http` trace against `localhost`/a
  loopback with no side-effecting method, or a `file`/`sql` trace whose target is not
  produced by any step in the plan and already exists before execution.
- **R4 — self-referential trace.** The trace reads back the model's own assertion rather
  than an external effect: e.g. a `file` trace pointing at `PLAN.md`/`TODO.md` itself, or a
  trace whose only "evidence" is a string the same step wrote as prose.
- **R5 — out-of-enum.** The `kind` is anything other than `file | sql | http | exit`.

A plan that fails any rule does not pass the gate; the loop forces a re-plan, it never
downgrades the gate.

### 4.5 Ambiguity score (Eng-5, ADR-0026) — honest labeling

The planning trigger combines three inputs. Each is labeled by its nature:

| Input | Nature | Source |
|---|---|---|
| irreversibility tier | **deterministic-heuristic** | tool/tier table (ADR-0011), code |
| estimated step count | **deterministic-heuristic** | parse of request structure, code |
| ambiguity score | **model-advisory** (optional) + deterministic floor | small-model pass *plus* a deterministic lexical floor |

The ambiguity score is **not** presented as deterministic. Its deterministic floor (e.g.
presence of multiple imperative verbs, unresolved pronouns, or the model surfacing >1
interpretation) can *force* the clarification gate on its own; the model-advisory portion
can only *raise* the score, never lower the deterministic floor. The clarification gate
itself is deterministic: if the score is above threshold **or** the model emitted more than
one interpretation, code halts and forces a question.

### 4.6 Durable session log entry

```
LogEntry = { seq, ts, kind, payloadHash, payload }
```

Append-only, fsync'd before any side-effecting tool dispatch and before each model call's
recorded intent, so the on-disk STATE always reflects at least up to the last attempted
act. `resume(sessionId)` replays the log to reconstruct `TurnState`.

## 5. Behavior & control flow

```
        ┌──────────────┐
        │ turn.start   │
        └──────┬───────┘
               v
   [CODE] freeze L1 snapshot (once/session) ── ADR-0007/0019
               v
   [CODE] tag provenance on all spans ──────── ADR-0027
               v
   [CODE] if any span == untrusted:
            enter NARROWED mode (outbound off,
            Tier2/3 → ask-only) ───────────── ADR-0027
               v
   [CODE] compute planning score
          (irrev tier + step est + ambiguity) ─ ADR-0026
               │
   trivial ────┼──── above threshold / "/plan" / >1 interpretation
   reversible  │                       │
        v       │                       v
   [MODEL] act  │            [CODE] clarification gate:
   directly     │                if ambiguous → HALT, force question
        │       │                       │
        │       │                       v
        │       │            [MODEL] write PLAN.md (steps + traces)
        │       │                       v
        │       │            [CODE] lint plan (R1..R5) ── fail → re-plan
        │       │                       v
        │       │            [CODE] Tier3 → show plan, await approval
        │       │                       v
        │       └───────────► [LOOP over steps]
        v                              │
   ┌────────────────────────── per step ──────────────────────────┐
   │ [MODEL] propose tool call                                     │
   │ [CODE] Loop Guardian.observe(call) → trip? HALT ── ADR-0020   │
   │ [CODE] HookGate.pre(call, {provenance, narrowed}) ── ADR-0009 │
   │        deny → fail step | ask → human | modify → use modified │
   │ [CODE] log.append(intent) + fsync   ◄─ durable before act     │
   │ [CODE] dispatch via ProviderRouting / sandbox                 │
   │ [CODE] run step.trace probe (file/sql/http/exit) ── ADR-0017  │
   │        pass → mark done | fail → mark failed, ++stepFailures  │
   │ [CODE] log.append(result) + fsync                             │
   └──────────────────────────────────────────────────────────────┘
               │
   [CODE] cap precedence (see §5.3) → re-plan? guardian-halt? cap-halt?
               v
        ┌──────────────┐
        │  turn.end    │  (or awaiting-clarification / approval / halted)
        └──────────────┘
```

Steps marked `[CODE]` are deterministic and run regardless of the model; `[MODEL]` steps
are the ~70% surface and are always wrapped by a code gate.

### 5.1 Within-session delete protocol (Eng-3) — chosen guarantee

The request is: the user says **"forget this"** mid-session, while the prefix is a frozen
byte-stable snapshot ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md)) and
FTS5 is live.

**Decision: defer-the-prefix, quarantine-now, with an offer to force-restart.** Concretely,
on a forget request the loop performs three deterministic acts, in order:

1. **Durable negation now (code).** Call `MemoryPort.forget(ref, humanConfirmed)` so
   Memory (03) sets `invalid_at = now()` and appends to `do_not_remember`
   ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)). FTS5 is
   reindexed so the fact is gone from *this session's* explicit search immediately.
2. **Session-local quarantine flag (code).** The forgotten `ref` is added to a per-session
   quarantine set. Even though the frozen prefix still physically contains the fact's bytes,
   the loop refuses to surface, quote, or pass that span into any tool argument for the rest
   of the session.
3. **Offer force-restart (code).** Because the prefix cannot be mutated without dropping the
   KV-cache, the loop surfaces a card offering an immediate session restart that rebuilds the
   prefix from the fresh snapshot (and therefore physically removes the fact). Accepting
   deliberately drops one cache; declining keeps the quarantine-only guarantee for this
   session.

**The exact guarantee the user gets:** from the moment "forget this" is acknowledged, the
fact will not be re-surfaced, re-quoted, retrieved by FTS5, or laundered into a tool call
this session, and it is durably tombstoned so it is absent from the prefix of every future
session — even though, absent an accepted restart, its original bytes still sit in the
current frozen prefix. A human-confirmed forget is permanent and no automated path may
resurrect it.

### 5.2 All-providers-down behavior (Eng-7)

Provider Routing (09) escalates on 2 consecutive errors and may exhaust the chain
([ADR-0018](../decisions/2026-06-11-model-router-hysteresis-fallback.md)). When the adapter
raises "all providers exhausted," the loop:

1. has **already** fsync'd the last attempted intent and every completed step's result to
   the session log (writes precede the act);
2. transitions the turn to `state: "halted", haltReason: "all-providers-down"` **without
   discarding any completed work** — no rollback, no truncation of the log;
3. emits a human alert card and stops calling the model;
4. on the next boot or provider recovery, `SessionLog.resume(sessionId)` replays the log,
   reconstructs `TurnState`, and continues from the first step not yet verified-done.

No work is lost because durability is at write time, not at session end, and the stateless
core can crash and resume against the durable log (the architecture's three-part split).

### 5.3 Cap precedence (Eng-12)

Three caps can fire on the same run; they compose in a fixed order so that a re-plan never
falsely trips the loop detector and a degenerate loop cannot hide under all three:

1. **Loop Guardian (structural, highest priority).** Evaluated on **every** tool dispatch
   *before* the call runs ([ADR-0020](../decisions/2026-06-11-loop-guardian.md)). A cycle of
   period 1/2/3 repeating >3× halts immediately, independent of plan or skill state.
2. **Re-plan boundary resets the Guardian window.** When Plan Mode forces a re-plan
   (§5, ADR-0026), the loop calls `LoopGuardian.note("replan")`, which **clears the
   sliding window**. Rationale: a re-plan is intentional, structurally-new work, so the
   tool calls after it must not be compared against the pre-re-plan window — that is what
   would otherwise make a legitimate re-plan look like an A-B-A-B cycle. Re-plans are
   themselves capped (`maxReplans`, default 2): exceeding it halts with `cap-exceeded`.
3. **Skill-failure threshold (advisory priority).** A skill that fails verification is
   counted per [ADR-0025](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md)
   (transient vs permanent); it only **deprioritizes** a strategy and never halts the loop
   on its own. It can trigger a re-plan but cannot, by itself, mark the loop degenerate.

The **anti-evasion rule** closes the gap where a loop could sit under all three caps: a
re-plan resets the Guardian window but does **not** reset a separate monotonic
`totalToolCalls` and `totalReplans` budget. If `totalReplans > maxReplans`, or
`totalToolCalls` exceeds the global iteration budget, the loop halts with
`cap-exceeded` regardless of period or window — so an attacker/degenerate cannot re-plan
forever to keep the Guardian window perpetually fresh.

## 6. Dependencies

- **Internal:**
  - **Memory (03)** — `MemoryPort.snapshot()` (frozen L1 read-once,
    [ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md),
    [ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md)) and
    `MemoryPort.forget()` ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)).
  - **Provider Routing (09)** — the `ProviderAdapter` and hysteresis/fallback chain
    ([ADR-0018](../decisions/2026-06-11-model-router-hysteresis-fallback.md)).
  - **Tools & Hooks (04)** / **Safety (05)** — `HookGate.pre/post`, HARD_DENY, the outbound
    lockout in narrowed mode ([ADR-0009](../decisions/2026-06-11-deterministic-tool-hooks.md),
    [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)).
  - **Observability & Verification (12)** — `LoopGuardian`
    ([ADR-0020](../decisions/2026-06-11-loop-guardian.md)), the per-step trace verifier
    ([ADR-0017](../decisions/2026-06-11-external-verification-by-traces.md)), and the
    append-only journal.
- **External:**
  - Node.js / TypeScript runtime — the loop is owned harness code, not an SDK
    ([ADR-0005](../decisions/2026-06-11-own-agent-loop.md),
    [ADR-0004](../decisions/2026-06-11-typescript-for-core.md)).
  - Vendor streaming completion APIs and the MCP spec, consumed through Provider Routing /
    MCP (07) — never an SDK that owns the loop.

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start — no constitution/SOUL/USER/MEMORY present** (Eng-7) | Code checks L1 file existence at session start | **Fail-closed to a safe minimal prefix.** Loop boots with a built-in default `constitution.md` (deny-by-default safety posture, Tier-0 capabilities only), empty SOUL/USER/MEMORY placeholders, and serializes that deterministically. No model call is gated by missing files; HARD_DENY and hooks still active. | First operator turn can populate files; next session reads the real snapshot. Emits a `cold-start` card noting which files were defaulted. |
| **Memory snapshot unavailable** (Memory 03 down) | `MemoryPort.snapshot()` throws / times out | **Degrade.** Boot with the cold-start minimal prefix; explicit FTS5 retrieval is disabled this session; loop runs read-only Tier-0/1. | Retry snapshot at next session; alert card. |
| **All providers down** (Eng-7) | `ProviderAdapter` raises "all exhausted" after hysteresis chain (ADR-0018) | **Persist + halt, no loss.** All completed steps + last intent already fsync'd; turn → `halted/all-providers-down`; no rollback. | `SessionLog.resume()` replays on boot/recovery, continues from first un-verified step (§5.2). |
| **Provider fallback (single)** | 2 consecutive 429/5xx/timeout (ADR-0018) | **Degrade.** Session survives; only the failed provider's KV-cache is lost; prefix re-billed once on the new provider. | Automatic; `note` in log. |
| **Plan lint fails** (R1–R5, Eng-5) | Linter over `PLAN.md` | **Fail-closed at the gate.** Mutating tools stay blocked; loop forces a re-plan; never downgrades the gate. | Model revises plan; counts against `maxReplans`. |
| **Step verification trace fails** (ADR-0017) | Probe (file/sql/http/exit) does not match | **Step marked failed (not done).** `stepFailures++`; model cannot self-mark done. | Re-plan after bounded failures; cap precedence §5.3. |
| **Clarification needed** (ambiguity ≥ threshold or >1 interpretation, Eng-5) | Deterministic floor + model-advisory score | **Halt and force a question.** No proceed-on-guess. | Resumes on operator answer. |
| **Untrusted span in context** (Eng-27 / ADR-0027) | Provenance tagger flags `untrusted` | **Narrow capabilities (fail-safe).** Outbound tools off; Tier 2/3 → ask-only; tool calls with args derived from untrusted span blocked at PreToolUse. | Clears only on a subsequent `operator` turn that itself carries no untrusted content. |
| **Loop Guardian trip** (period 1/2/3 >3×, ADR-0020) | Structural signature over sliding window | **Halt + escalate** with a diff card; never deletes work or resumes itself. | Human reviews; re-plan resets window but not monotonic budgets (§5.3). |
| **Degenerate loop under all caps** (Eng-12) | Monotonic `totalReplans`/`totalToolCalls` budget | **Halt with `cap-exceeded`** regardless of period — closes the re-plan-forever evasion. | Human review. |
| **Within-session forget request** (Eng-3) | Operator turn matches forget intent | **Quarantine now + durable tombstone + offer restart** (§5.1). Fact not re-surfaced this session; absent from all future prefixes. | Optional forced restart drops one KV-cache to physically purge the prefix. |
| **Crash mid-turn (process kill, OOM)** | Process restart finds an open session log | **Resume from durable log.** Append-only fsync'd STATE; stateless core resumes with no loss. | `SessionLog.resume()` replays to last fsync'd entry. |

## 8. Security & threat model

This component is security-relevant: it assembles the context, sets provenance, and gates
the loop into narrowed mode. Threats below use STRIDE / OWASP-LLM; each mitigation is
deterministic code, and what is enforced by code vs left to the model is stated explicitly.

| Threat (STRIDE / OWASP-LLM) | Vector | Deterministic mitigation (enforcing ADR) | Code vs model |
|---|---|---|---|
| **Indirect prompt injection → exfiltration** (OWASP-LLM01, Tampering/Info-disclosure) | An `untrusted` span (fetched page, MCP result, forwarded post, transcript) tells the model to read private memory and send it out | On any `untrusted` span the loop enters **narrowed mode**: outbound tools disabled, Tier 2/3 → ask-only, and any tool call whose args derive from an untrusted span is blocked at PreToolUse ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)). Breaks the outbound leg of the lethal trifecta in code. | **Code** enforces lockout in hooks; the model may reason over the span freely but cannot reach a sink. |
| **Provenance spoofing** (Spoofing / Elevation) | Model claims a span is `operator` to escape narrowing | Provenance is set by code at ingestion and is immutable to the model; the loop never reads provenance from model output ([ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)). | **Code** owns the label; model cannot set it. |
| **"Said done, didn't do"** (OWASP-LLM09 overreliance) | Model narrates success for a mutating step it never ran | A step closes **only** on a passing external trace from the enumerated probe set; self-report is ignored ([ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md), [ADR-0017](../decisions/2026-06-11-external-verification-by-traces.md)). | **Code** runs the probe; model's "done." is not evidence. |
| **Vacuous/self-referential verification trace** (Tampering, Eng-5) | Model writes `echo ok` or points the trace at `PLAN.md` to auto-pass | Linter rules R3/R4 reject vacuous and self-referential traces; only external-effect probes pass ([ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md)). | **Code** lints; model writes content. |
| **Irreversible action without a plan** (Tampering) | Model jumps to a mutating tool on first guess | Plan→execute hard stop: no mutating tool until a lint-passing plan exists; Tier-3 also needs human approval ([ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md), [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md)). | **Code** gate; model proposes the plan. |
| **Runaway / DoS via degenerate loop** (DoS, OWASP-LLM10 unbounded consumption) | A-B-A-B cycle or re-plan-forever to drain budget | Loop Guardian period 1/2/3 cap + monotonic `totalToolCalls`/`totalReplans` budget that a re-plan cannot reset ([ADR-0020](../decisions/2026-06-11-loop-guardian.md), §5.3). | **Code** caps; model cannot opt out. |
| **Forgotten fact resurfaces / leaks mid-session** (Info-disclosure, Eng-3) | After "forget this," the frozen prefix still contains the bytes | Session-local quarantine refuses to surface/quote/pass the ref; durable tombstone removes it from FTS5 now and from all future prefixes; force-restart offered to purge the prefix bytes ([ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md), [ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)). | **Code** enforces quarantine + tombstone; not a prompt request. |
| **Repudiation / lost audit on crash** (Repudiation) | Process killed mid-act, no record of what was attempted | Append-only session log fsync'd **before** each side-effecting dispatch; resume replays it (§4.6, §5.2). | **Code** persists; independent of the model. |

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion for a Phase-3 test.

1. **AC-01-1** — Calling `runTurn` twice in two fresh sessions over byte-identical L1 files
   yields the same `FrozenSnapshot.prefixHash` (Eng-10: deterministic L1 serialization).
2. **AC-01-2** — `FrozenSnapshot.prefixBytes` contains no substring matching the injected
   `Clock`'s value, no PID, and no run-id; mutating only `takenAt` in the log does not change
   `prefixHash` (Eng-10).
3. **AC-01-3** — Serializing an L1 object whose keys are supplied in reverse order produces
   byte-identical `prefixBytes` to the sorted-order input (sorted-keys invariant, Eng-10).
4. **AC-01-4** — After `snapshot()` is frozen, a within-session memory write does not change
   `prefixHash` for the rest of the session (frozen snapshot, ADR-0007/0019).
5. **AC-01-5** — The assembled prefix exposes ≤ 4 cache breakpoints and they sit at the
   four ADR-0019 segment boundaries, most-stable first (ADR-0019).
6. **AC-01-6** — On cold start with all four L1 files absent, `runTurn` boots a default
   minimal prefix, the HookGate is still consulted on the first tool call, and no unhandled
   exception is thrown (Eng-7 cold start).
7. **AC-01-7** — In cold-start mode, a Tier-2 tool call is gated to ask/deny (capabilities
   restricted to Tier-0/1) (Eng-7).
8. **AC-01-8** — When the `ProviderAdapter` fake raises "all providers exhausted" after a
   completed step, the turn returns `state:"halted", haltReason:"all-providers-down"`, and the
   session log on disk contains the completed step's verified result entry (Eng-7 all-down,
   no loss).
9. **AC-01-9** — After an "all-providers-down" halt, `SessionLog.resume(sessionId)` returns a
   `TurnState` whose next step is the first step **not** marked verified-done; no completed
   step re-executes (Eng-7 resume).
10. **AC-01-10** — Killing the process between a step's intent-append and its result-append
    leaves the intent entry on disk (fsync ordering), and resume re-dispatches that step rather
    than skipping it (crash durability).
11. **AC-01-11** — The session log entry for a side-effecting dispatch is fsync'd **before**
    the dispatch call is made (assert append happens-before dispatch via the injected seams).
12. **AC-01-12** — A `PLAN.md` with a step lacking a `trace` field is rejected by the linter
    (rule R1) and no mutating tool is dispatched (Eng-5).
13. **AC-01-13** — A plan step whose trace is `{kind:"exit", argv:["echo","ok"]}` is rejected
    as vacuous (rule R3) (Eng-5).
14. **AC-01-14** — A plan step whose `file` trace path equals `PLAN.md`/`TODO.md` is rejected
    as self-referential (rule R4) (Eng-5).
15. **AC-01-15** — A trace with `kind:"shell"` (or any value outside `file|sql|http|exit`) is
    rejected as out-of-enum (rule R5) (Eng-5).
16. **AC-01-16** — A step is marked `done` **only** after its declared probe returns the
    expected result; when the probe fake returns a non-matching result, the step is marked
    `failed` even though the model's response asserted success (ADR-0017 / Eng-5).
17. **AC-01-17** — A Tier-3 plan does not dispatch any mutating tool until an approval token is
    supplied; absent approval the turn is `state:"awaiting-approval"` (ADR-0026).
18. **AC-01-18** — When the deterministic ambiguity floor fires (e.g. >1 interpretation
    emitted), `runTurn` returns `state:"awaiting-clarification"` and dispatches **zero** tool
    calls (Eng-5 clarification gate).
19. **AC-01-19** — Raising the model-advisory ambiguity component cannot lower the result below
    the deterministic floor: a request that trips the floor still halts even when the advisory
    score is forced to 0 (Eng-5 honest labeling).
20. **AC-01-20** — When a span carries `provenance:"untrusted"`, a PreToolUse attempt to call
    an outbound tool (e.g. Telegram `send`, outbound HTTP, `git push`) is blocked by code
    (Eng-27 / ADR-0027 outbound lockout).
21. **AC-01-21** — With an `untrusted` span present, a tool call whose arguments derive from
    that span is blocked at PreToolUse even when the tool itself is otherwise allowed
    (motivated-call blocking, ADR-0027).
22. **AC-01-22** — A model attempt to set a span's `provenance` to `"operator"` is ignored; the
    code-assigned label is used and narrowed mode stays active (provenance non-spoofable,
    ADR-0027).
23. **AC-01-23** — Narrowed mode clears only after a subsequent `operator` turn that carries no
    untrusted span; an `operator` turn that itself includes untrusted content keeps narrowing on
    (ADR-0027).
24. **AC-01-24** — After a "forget this" request, an FTS5 query for the forgotten fact returns
    zero rows in the same session, and the loop refuses to include the fact's span in any tool
    argument for the rest of the session (Eng-3 quarantine + tombstone).
25. **AC-01-25** — After a "forget this" request, `MemoryPort.forget` was invoked with the fact
    ref and the fact appears in `do_not_remember`; the next session's `prefixBytes` does not
    contain the fact (Eng-3 durable across sessions).
26. **AC-01-26** — A human-confirmed forget cannot be resurfaced by any automated path in a
    later session test (Eng-3 permanence, ADR-0023).
27. **AC-01-27** — A Loop Guardian period-2 (A-B-A-B) cycle repeating >3× halts the loop with
    `haltReason:"loop-guardian"` and writes the window to the log (ADR-0020).
28. **AC-01-28** — A forced re-plan calls `LoopGuardian.note("replan")` and the tool calls
    issued immediately after the re-plan do **not** trip the Guardian against the pre-re-plan
    window (Eng-12: re-plan does not falsely trip the detector).
29. **AC-01-29** — A run that alternates plan→re-plan to keep the Guardian window fresh still
    halts with `haltReason:"cap-exceeded"` once `totalReplans > maxReplans` (Eng-12:
    degenerate loop cannot sit under all caps).
30. **AC-01-30** — A skill-failure threshold breach deprioritizes the strategy / triggers a
    re-plan but, on its own, never sets `haltReason:"loop-guardian"` (Eng-12 precedence,
    ADR-0025).
31. **AC-01-31** — The loop accepts an injected `Clock`, and a test that supplies a fixed clock
    produces deterministic log `ts` values and an unchanged `prefixHash` (Eng-11 test seam:
    injectable clock).
32. **AC-01-32** — The loop accepts an injected `ProviderAdapter` fake; a test drives a full
    turn (including the all-providers-down path of AC-01-8) with no real network call (Eng-11
    test seam: provider-adapter fake).

## 10. Open questions

- **Approval-token integrity for Tier-3 plans.** This spec treats the approval token as
  opaque; binding it to the exact plan hash so a swapped plan cannot reuse an approval is
  deferred to [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
  and the Safety (05) spec.
- **Trace-quality rules beyond R1–R5.** ADR-0026 flags that the linter's trace-quality rules
  "are themselves worth review"; additional anti-vacuity heuristics are deferred to a later
  milestone.
- **Streaming and partial-step durability.** How much of a streamed model response to fsync
  before a tool call (token-level vs intent-level) is left to the Gateway (02) / Observability
  (12) specs; this spec fsyncs at intent granularity.

## 11. References

- ADRs: [ADR-0005](../decisions/2026-06-11-own-agent-loop.md),
  [ADR-0007](../decisions/2026-06-11-frozen-memory-snapshot.md),
  [ADR-0008](../decisions/2026-06-11-three-step-lazy-memory-loading.md),
  [ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md),
  [ADR-0026](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md),
  [ADR-0027](../decisions/2026-06-11-capability-narrowing-untrusted-context.md).
  Supporting: [ADR-0011](../decisions/2026-06-11-autonomy-gradient.md),
  [ADR-0017](../decisions/2026-06-11-external-verification-by-traces.md),
  [ADR-0018](../decisions/2026-06-11-model-router-hysteresis-fallback.md),
  [ADR-0020](../decisions/2026-06-11-loop-guardian.md),
  [ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md),
  [ADR-0025](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md),
  [ADR-0009](../decisions/2026-06-11-deterministic-tool-hooks.md),
  [ADR-0014](../decisions/2026-06-11-narrow-waist-tool-set.md),
  [ADR-0004](../decisions/2026-06-11-typescript-for-core.md).
- Concept docs: [`memory-system.md`](../concepts/memory-system.md),
  [`safety-layer.md`](../concepts/safety-layer.md).

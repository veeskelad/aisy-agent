# Component 12: Observability & Verification — Specification

**Status:** Draft
**Component:** 12 / 12
**Related ADRs:** ADR-0017, ADR-0020, ADR-0026
**Depends on:** Core / Agent Loop (01), Tools & Hooks (04); every component emits into this one.

> The deterministic spine that records what the harness actually did, detects degenerate
> tool loops, and closes a step only on a real-world trace — so "done" is proven by the
> world, never by the model's narration.

## 1. Purpose

Observability & Verification is the harness's evidence layer. The model is a stateless
probabilistic CPU at roughly 70% instruction adherence, and the single most damaging
consequence of that number is the silent false report: the model says it wrote the file,
deleted the row, or ran the command, while nothing happened (ADR-0017). A self-report is
just another probabilistic token stream from the same unreliable unit, so acceptance of a
result cannot live inside the model's own story. It must be grounded in the world.

This component is the deterministic (100%) side of that split. It owns three things that
together form the observability spine:

1. **Verification by traces** — a step or a result closes only when a concrete probe
   (file stat/hash, SQL row predicate, HTTP status, process exit code) confirms the
   claimed effect against reality (ADR-0017, ADR-0026).
2. **Loop detection** — the Loop Guardian inspects a sliding window of recent tool calls
   and trips on a period-1/2/3 cycle that repeats too often, halting an unattended runaway
   before it drains the budget (ADR-0020).
3. **The append-only journal** — every component appends an immutable, secret-redacted
   record of what it decided and what was observed, so the run is auditable and survives
   history compaction.

The model is never trusted to mark its own work done, to declare a loop benign, or to
write an unredacted journal entry. Those are code, at 100%. The model is trusted to
*propose* the work, *write* the plan and its declared traces, and *narrate* — none of
which this component accepts as evidence.

## 2. Responsibilities

This component **owns**:

- **The trace verifier** — the deterministic engine that runs a `VerificationTrace` probe
  (`file | sql | http | exit`) and returns pass/fail by comparing the probe result to the
  step's declared success criterion (ADR-0017, ADR-0026). The probe schema is **shared
  with Core (01)**; this component owns the *execution and matching*, Core owns the loop
  state that consumes the verdict.
- **The trace linter** — the deterministic rules (R1–R5, §4.4 of Core 01) that reject a
  vacuous, self-referential, missing, or out-of-enum trace *before* a plan passes the gate,
  so a trace cannot be authored to auto-pass.
- **The fake-effect test mode** — an injectable seam that lets a test run the same verifier
  against an *absent* effect and assert the trace FAILS, proving the probe asserts the real
  effect and not a proxy (Eng-11).
- **The Loop Guardian** — the period-1/2/3 cycle detector over a bounded sliding window of
  tool-call signatures, the >3-repeat trip, the STOP-signal write, and the re-plan window
  reset that prevents false positives on a legitimate Plan-Mode re-plan (ADR-0020, Eng-12).
- **The append-only journal** — the immutable, ordered, fsync'd record every component
  appends to; its schema, its monotonic sequence, and its tamper-evidence chaining.
- **Secret redaction at the journal sink** — the deterministic redactor that strips known
  vault secret values from every entry *before* it is persisted (CSO-M3).
- **The query/read surface** over the journal for the morning card, post-mortems, and the
  resume path.

This component **does not**:

- Run the agent loop state machine, write `PLAN.md`/`TODO.md`, or compute the planning
  score — **Core / Agent Loop (01)** owns the loop and calls this component's verifier,
  linter, and Guardian. Core emits the journal events; this component records them.
- Dispatch or execute tools — **Tools & Hooks (04)** runs `PreToolUse`/`PostToolUse`; this
  component observes each dispatch (the Guardian is consulted on the tool path) and records
  the outcome.
- Author the Decision Journal (`decided FOR / AGAINST / because`) — **Orchestration (11)**
  owns that worker-coordination artifact. This component owns the *observability* journal
  (events + verdicts) and ingests Orchestration's decisions as journal entries; the two are
  distinct artifacts.
- Define the vault or the master secret list — **Safety (05)** owns the vault; this
  component receives the known secret value set from it and applies redaction at its own
  sink (CSO-M3). Safety redacts at *its* sinks; component 12 redacts at the journal sink.
- Decide tier, autonomy, or HARD_DENY — **Safety (05)** owns policy; a Guardian trip
  escalates to the human but never overrides a Safety verdict.

## 3. Interfaces

Conceptual API surface; signatures are illustrative, not binding, and respect the
narrow-waist principle (ADR-0014) — this component exposes verdicts and a record sink, not
new agent-facing tools. The `VerificationTrace`, `ToolCall`, and journal event names are
the **same types Core (01) defines**; reproduced here for the shared contract.

```ts
// illustrative, not binding

// ---- shared with Core (01) §3; this component executes and matches it ----
export type VerificationTrace =
  | { kind: "file"; path: string; existsExpected: true; sha256?: string }
  | { kind: "sql"; query: string; expectRows: number | { op: "=" | ">" | ">="; n: number } }
  | { kind: "http"; method: string; url: string; expectStatus: number }
  | { kind: "exit"; argv: string[]; expectCode: number }

export interface TraceResult {
  pass: boolean
  kind: VerificationTrace["kind"]
  observed: unknown            // the real value seen (hash, row count, status, code) — redacted at journal sink
  reason?: string              // why it failed, for the card
}

// The deterministic effect side. In production it touches the real world;
// in tests an EffectProbe fake returns a scripted observation (Eng-11 seam).
export interface EffectProbe {
  file(path: string): { exists: boolean; sha256?: string }
  sql(query: string): { rows: number }
  http(method: string, url: string): { status: number }
  exit(argv: string[]): { code: number }
}

export interface TraceVerifier {
  // Runs the probe via the injected EffectProbe and matches against the declared trace.
  verify(trace: VerificationTrace, probe: EffectProbe): TraceResult
}

// ---- trace linter (rejects vacuous/self-referential traces up front) ----
export interface TraceLinter {
  // Returns the failing rule id (R1..R5) or null if the plan's traces are all sound.
  lint(plan: { steps: { trace: VerificationTrace; irreversible: boolean; tools: string[]; producesPath?: string }[] }):
    { ok: true } | { ok: false; rule: "R1" | "R2" | "R3" | "R4" | "R5"; stepIndex: number }
}

// ---- Loop Guardian (owned here; Core 01 holds the reference) ----
export interface LoopGuardian {
  observe(call: ToolCall): { trip: boolean; period?: 1 | 2 | 3 }   // consulted on EVERY tool dispatch
  note(event: "replan"): void                                      // re-plan boundary reset (Eng-12)
}

// ---- append-only journal ----
export interface JournalEntry {
  seq: number                  // monotonic, gap-free per session
  ts: string                   // from injected Clock; not on any cached prefix
  source: string               // component id: "01".."11"
  kind: string                 // e.g. "step.verified" | "guardian.tripped" | "decision"
  prevHash: string             // hash chain over the previous entry (tamper-evidence)
  payloadHash: string
  payload: unknown             // ALREADY redacted before it reaches append()
}

export interface Journal {
  append(source: string, kind: string, payload: unknown): JournalEntry   // redacts, chains, fsyncs
  read(filter: { sessionId?: string; kind?: string; since?: number }): JournalEntry[]
}

export interface SecretRedactor {
  // Strips every known vault secret VALUE (provided by Safety 05) from arbitrary structures.
  redact<T>(value: T): T
  loadVaultValues(values: ReadonlySet<string>): void
}
```

**Events consumed** (emitted by every component into the journal): from Core (01)
`turn.start`, `prompt.assembled`, `snapshot.frozen`, `plan.linted`, `plan.gate`,
`clarification.raised`, `step.verified`, `step.failed`, `replan.entered`,
`guardian.tripped`, `provider.exhausted`, `forget.requested`, `turn.end`; from Tools &
Hooks (04) `tool.dispatched`, `tool.result`; from Safety (05) `safety.denied`,
`safety.approval.bound`; from Orchestration (11) the `decision` (FOR/AGAINST/because)
reconciliation events; analogous events from Memory, MCP, Skills, Routing, Nightly.

**Events emitted**: `verify.pass`, `verify.fail`, `loop.tripped` (carries the offending
window), `journal.appended`.

## 4. Data structures

- **`VerificationTrace`** — the enumerated probe set (above), byte-identical to Core's
  (01) definition. A trace is exactly one of `file | sql | http | exit`; any other `kind`
  is rejected by linter rule R5 and never reaches the verifier. This is the single contract
  shared between the loop (which declares and stores traces in `PLAN.md`) and this component
  (which executes them).

- **Trace match semantics** (deterministic, no model in the path):
  - `file`: probe stats the path; pass iff `exists === existsExpected` **and**, when
    `sha256` is declared, the file's content hash equals it. A hash mismatch fails even if
    the file exists — content, not mere presence, is the effect.
  - `sql`: probe runs the read-only `query`; pass iff the returned row count satisfies the
    predicate (`= n`, `> n`, `>= n`).
  - `http`: probe re-issues `method url`; pass iff the response status equals `expectStatus`.
  - `exit`: probe runs `argv` in the sandbox; pass iff the process exit code equals
    `expectCode`.

- **Trace linter rules (R1–R5)** — owned here, applied to every plan before the gate
  (definitions are the canonical Core §4.4 set, ADR-0026, Eng-5):
  - **R1 missing** — a step has no `trace`.
  - **R2 unflagged-irreversible** — a step uses a Tier ≥ 2 tool (ADR-0011) but
    `irreversible !== true`.
  - **R3 vacuous** — the trace asserts nothing about the world: an `exit` trace whose
    `argv` is a no-op (`echo`, `true`, `:`, `printf`); an `http` trace against
    `localhost`/loopback with no side-effecting method; a `file`/`sql` trace whose target
    is not produced by any step in the plan and already exists before execution.
  - **R4 self-referential** — the trace reads back the model's own assertion: a `file`
    trace pointing at `PLAN.md`/`TODO.md` itself, or a trace whose only evidence is a
    string the same step wrote as prose.
  - **R5 out-of-enum** — `kind` is anything other than `file | sql | http | exit`.

- **Tool-call signature** (Loop Guardian) — `sig(call) = hash(toolName + normalizedArgs)`
  where `normalizedArgs` is an **order-insensitive, canonicalized** rendering of arguments
  (canonical paths, decoded values, sorted keys). The signature is deterministic and adds
  no model cost; it is what the sliding window compares (ADR-0020).

- **Guardian window** — a bounded ring buffer of the last *N* signatures (configurable,
  default ≈ 12) plus a **re-plan epoch counter**. The window and the counter together let
  the Guardian distinguish a degenerate loop from a deliberate re-plan (§5.2).

- **`JournalEntry`** — append-only, monotonic `seq` (gap-free per session), `prevHash`
  chain for tamper-evidence, and a `payload` that is **already secret-redacted before
  `append()` returns it**. The journal is on disk, in the durable session log lineage
  (ADR-0021's "control outside the conversation"); compaction of the model's context never
  touches it.

- **Known-secret value set** — the set of literal secret *values* loaded from the vault via
  Safety (05). Redaction is by exact value match (and value-derived encodings), not by
  pattern guessing — the journal must never persist a value that is in this set (CSO-M3).

None of these structures sits on the KV-cache stable prefix (ADR-0019); journal `ts`,
`seq`, and `prevHash` are explicitly excluded from any cached byte, and the trace
`observed` values are recorded only in the journal, never in the model prompt.

## 5. Behavior & control flow

Three deterministic paths: **verify a step**, **detect a loop**, and **append a record**.
All three are code; the model touches none of them except by having written the plan and
its traces earlier.

### 5.1 Per-step verification (ADR-0017, ADR-0026)

```
STEP CLOSE (deterministic, 100%)
  Core executes a plan step (model + tools)
    -> Core asks Observability: verify(step.trace, EffectProbe)
         [CODE] run the probe against the REAL world (not the transcript):
             file -> stat + hash | sql -> row count | http -> status | exit -> code
         [CODE] match observed vs declared criterion
    -> pass  : Core may mark the step `done`        (verify.pass journaled)
    -> fail  : Core marks the step `failed`, not done; stepFailures++
               (verify.fail journaled; model's "Done." is ignored)
  The model CANNOT mark a step done. Only a passing trace closes it.
```

The linter runs earlier, at plan time: when Core lints a `PLAN.md`, it calls
`TraceLinter.lint`. A plan that trips any of R1–R5 does not pass the gate; Core forces a
re-plan. The linter is the guard that stops a model from writing a self-passing trace in
the first place; the verifier is the guard that stops a self-reported close at execution.

**Fake-effect test mode (Eng-11).** `EffectProbe` is an injected seam. The verification
harness ships a fake probe that can report an effect as **absent** (file missing, 0 rows,
404, non-zero exit). The required test asserts that, with the effect absent, `verify()`
returns `pass: false` for each of the four kinds. This proves the probe asserts the actual
effect, not a proxy — a verifier that passed on an absent effect would silently re-open the
"said done, didn't do" hole, so this is a first-class acceptance criterion (§9), not a unit
detail.

### 5.2 Loop detection + Plan-Mode interaction (ADR-0020, Eng-12)

The Guardian is consulted on **every** tool dispatch, before the call runs:

```
LOOP GUARDIAN (deterministic, 100%, no model, ~constant cost)
  on each tool dispatch:
    sig = hash(toolName + normalizedArgs)            // order-insensitive
    push sig into bounded window (default N≈12), tagged with current replan-epoch
    detect cycle of period 1, 2, or 3 in the window:
        period 1: A A A ...
        period 2: A B A B ...
        period 3: A B C A B C ...
    if any such cycle repeats > 3 times WITHIN the current replan-epoch:
        trip -> write STOP signal
             -> journal `guardian.tripped` with the offending window
             -> escalate to human with a diff card
             -> NEVER delete work, NEVER resume on its own
    else: allow the dispatch to proceed
```

**Interaction with a legitimate Plan-Mode re-plan (Eng-12).** A Plan-Mode re-plan is a
deliberate, code-forced revision of `PLAN.md` after bounded step failures (ADR-0026 §6) —
it is *not* a degenerate loop, even though it may re-issue similar tool calls. The contract
that prevents a false positive:

- When Core enters a re-plan, it calls `LoopGuardian.note("replan")`. This **advances the
  re-plan epoch and reduces the live window** so signatures from the prior plan attempt do
  not count toward a cycle in the new attempt. Period 1/2/3 detection is evaluated only
  within the current epoch.
- The Guardian therefore does **not** trip merely because attempt N+1 repeats a call from
  attempt N. It trips only when a cycle repeats > 3 times *inside one epoch* — i.e. the
  model is genuinely spinning, not re-planning.
- The re-plan reset is **not** a budget reset. The monotonic totals (`totalToolCalls`,
  `totalReplans`) that Core owns are never reset by `note("replan")`; a model that
  re-plans forever to dodge the Guardian still hits Core's monotonic cap (cap precedence,
  Core §5.3). The Guardian closes the structural hole; the budget closes the periods-> 3
  and re-plan-forever holes. The two are complementary, by design.

This split is what keeps the Guardian both sensitive (catches A-B-A-B that OpenClaw's
period-1-only guard missed) and livable (a real re-plan is not punished as a loop).

### 5.3 Append-only journal + redaction (ADR-0021, CSO-M3)

```
JOURNAL APPEND (deterministic, 100%)
  any component calls Journal.append(source, kind, payload)
    -> [CODE] payload = SecretRedactor.redact(payload)   // BEFORE persistence
         strip every known vault secret VALUE (and value-derived encodings)
    -> [CODE] seq = lastSeq + 1                           // monotonic, gap-free
    -> [CODE] prevHash = hash(previous entry)             // tamper-evidence chain
    -> [CODE] fsync the entry to disk                     // survives crash + compaction
    -> emit journal.appended
```

Redaction runs **before** the entry is written, never after — an unredacted value must
never touch disk. The known-secret value set is loaded from Safety's vault (05) at start
and refreshed when the vault changes. Because the journal is the post-mortem and morning-card
source, an un-redacted secret here would leak to a human-facing sink; CSO-M3 makes this a
hard, code-enforced invariant with its own acceptance criterion (§9).

The journal is the spine the other two paths write into: a verification verdict
(`verify.pass`/`verify.fail`) and a Guardian trip (`guardian.tripped`) are both journal
entries, so the full evidence of a run — what was attempted, what was proven, where it
looped — is one ordered, redacted, tamper-evident record.

The journal also ingests `provider.cost.charged` events from Provider Routing (09),
subject to the same secret-redaction sink as every other entry
([ADR-0036](../decisions/2026-06-11-cost-transparency-surfacing.md)). These cost entries
are queryable and aggregatable on the read surface, summing the per-call charges into a
per-task and per-period cost.

## 6. Dependencies

- **Internal:**
  - **Core / Agent Loop (01)** — declares `VerificationTrace`s in `PLAN.md`, holds the
    `LoopGuardian` reference, calls `verify()` per step and `lint()` per plan, and emits the
    bulk of journal events (ADR-0017, ADR-0020, ADR-0026). Core owns the loop state; this
    component owns the verdicts.
  - **Tools & Hooks (04)** — every tool dispatch flows through the hook path; the Guardian
    is consulted there and the dispatch/result are journaled (ADR-0009, ADR-0014).
  - **Safety (05)** — supplies the known-secret value set from the vault for redaction
    (CSO-M3); a Guardian trip escalates via Safety's confirmation/card path and never
    overrides a Safety verdict.
  - **Orchestration (11)** — its Decision Journal (`FOR/AGAINST/because`) decisions are
    ingested as `decision` journal entries; the two journals are distinct artifacts
    (ADR-0021).
  - **Gateway (02)** — renders the Guardian trip diff card and the morning post-mortem
    drawn from the journal.
  - All other components (Memory 03, Skills 06, MCP 07, Personality 08, Routing 09, Nightly
    10) append their own events into the journal.
- **External:**
  - **SQLite** — for `sql` probes and for the indexed journal read surface (ADR-0006).
  - **The sandbox runtime** (Docker/gVisor) — `exit` probes and `http` probes run through
    the same egress posture as any tool (ADR-0012); the verifier has no privileged path to
    the world.

## 7. Failure & degraded modes (mandatory)

"Code" behaviors below are 100%; the model is never on the recovery path.

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** — journal/verifier/Guardian not yet initialized, no known-secret set loaded | First `append`/`verify`/`observe` before init self-check passes | **Fail-closed**: `verify()` returns `pass: false` (no step may close), the Guardian treats the window as tripped-on-doubt and pauses unattended runs, and `append()` refuses to persist any payload until the vault secret set is loaded (so nothing unredacted is written) | Auto-resume once the journal opens with a valid `prevHash` tail, the verifier's `EffectProbe` is bound, and the secret set is loaded and self-checked |
| **Effect probe (filesystem/DB/network) unavailable** for a `verify()` call | Probe raises/times out within budget | **Fail-closed on the step**: the trace is treated as **failed**, the step is marked `failed` not done; never "pass on error" | Core re-plans after bounded failures; verifier retried when the probe path is restored |
| **`sql` probe DB unreachable** (ADR-0006 dependency) | SQLite open/connection error | **Fail-closed**: `sql` traces fail; step not closed | Restore DB; re-verify the un-closed step |
| **`http` probe endpoint down / egress proxy unavailable** | Connection refused/timeout | **Fail-closed**: `http` trace fails (status != expected); step not closed | Restore endpoint/proxy; re-verify |
| **Vacuous or self-referential trace authored by the model** (Eng-5) | `TraceLinter.lint` rule R3/R4 | **Reject the plan** at the gate; Core forces a re-plan; the gate is never downgraded | Model revises `PLAN.md` with a real-effect trace |
| **Out-of-enum / missing trace** | Linter R1/R5 | **Reject the plan**; no mutating tool runs until a lint-passing plan exists | Model supplies a valid enumerated trace |
| **Verifier passes on an absent effect** (Eng-11 — must be impossible) | Fake-effect test seam asserts FAIL on absent effect | **Test gate**: this is forbidden by construction; the seam fails CI if it ever happens | Fix the probe so the trace asserts the real effect, not a proxy |
| **Degenerate tool loop** — period 1/2/3 repeats > 3× in one epoch (ADR-0020) | Guardian sliding-window signature match | **Halt + escalate** via diff card; write STOP signal; journal the offending window; never delete work or resume itself | Human reviews; Core may re-plan (`note("replan")` resets the epoch window, not the budget) |
| **Period > 3 loop** (e.g. A-B-C-D-A-B-C-D) — out of Guardian range | Not caught structurally (ADR-0020 known gap) | **Caught by Core's monotonic budget cap**, not the Guardian | Budget cap halts; documented as the complementary backstop |
| **Legitimate re-plan misread as a loop** (Eng-12 — false positive) | Re-plan epoch tagging | **Suppressed by design**: signatures from a prior plan attempt do not count in the new epoch, so a deliberate re-plan does not trip | n/a — prevented, not recovered |
| **Vault/known-secret set unavailable** when an entry must be journaled (CSO-M3) | Redactor has no value set loaded | **Fail-closed**: `append()` refuses to persist (no unredacted write); the event is buffered in memory and dropped on crash rather than written in the clear | Load the secret set from Safety (05); buffered entries persist once redaction is available |
| **Journal write / fsync fails (disk full, IO error)** | `append` IO error | **Fail-closed for the act it gated**: a tool dispatch whose journal record cannot be persisted is not allowed to proceed (the STATE-before-act invariant from ADR-0021/Core §4.6) | Free disk / restore IO; replay resumes from the last good `seq` |
| **Journal tamper detected** — `prevHash` chain breaks on read | Hash-chain verification on `read`/resume | **Flag + fail-closed read**: the run is marked unverifiable from the break point; no silent acceptance | Human review of the break; restore last-known-good tail |
| **Guardian state lost on crash mid-run** | No window on resume | **Fail-safe**: rebuild the window from the journal's `tool.dispatched` tail before resuming dispatch; if it cannot be rebuilt, pause unattended runs | Window reconstructed from journal; manual resume otherwise |

## 8. Security & threat model

Threats mapped to deterministic mitigations. "Code" is enforced 100% in this component;
"Model" is advisory and never load-bearing.

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **"Said done, didn't do" — overreliance on a false self-report** (OWASP LLM09; ADR-0017) | A step/result closes **only** on a passing external trace from the enumerated probe set; the model's narration is not evidence and cannot mark a step done (ADR-0017, ADR-0026) | Code |
| **Trace tampering — model writes a self-passing trace** (Tampering; Eng-5) | Linter rules R3 (vacuous) and R4 (self-referential) reject no-op/loopback/own-artifact traces before the gate; R1/R5 reject missing/out-of-enum; a failing plan re-plans, the gate never downgrades | Code |
| **Proxy verification — probe asserts a stand-in, not the effect** (Tampering; Eng-11) | Fake-effect seam forces `verify()` to FAIL when the effect is absent, proving the probe binds to the real effect; a verifier that passed on absence fails CI | Code (test gate) |
| **Unbounded consumption via a degenerate loop** (DoS; OWASP LLM10; ADR-0020) | Loop Guardian period-1/2/3 cap (> 3 repeats trips) + STOP signal + escalation; complemented by Core's monotonic budget for periods > 3 and re-plan-forever | Code |
| **Loop guard evaded by re-planning to reset the window** (DoS; Eng-12) | `note("replan")` resets the epoch window but **not** the monotonic budget; re-plan-forever still hits Core's cap | Code |
| **Secret leakage into a human-facing sink via the journal** (Info disclosure; CSO-M3) | `SecretRedactor` strips every known vault secret value **before** persistence; an entry is never written in the clear; redaction failure fails the write closed | Code |
| **Repudiation — journal altered to hide what happened** (Repudiation) | Append-only with a `prevHash` tamper-evidence chain and gap-free monotonic `seq`; a broken chain flags the run unverifiable rather than accepting it | Code |
| **False-positive loop trip aborting legitimate work** (Availability; Eng-12) | Re-plan epoch tagging suppresses cross-attempt false positives; the Guardian escalates rather than deleting work, so a trip is never destructive | Code |

What the model is trusted with: writing the plan and its declared traces, narrating, and
proposing tool calls. What it is **never** trusted with: marking a step done, declaring a
loop benign, downgrading the trace gate, or writing an unredacted journal entry. Those are
code, at 100%.

## 9. Acceptance criteria (mandatory)

Each criterion is a single objectively verifiable assertion for a Phase-3 test.

1. **AC-12-1** — Given a `file` trace `{ existsExpected: true }`, `verify()` returns
   `pass: true` only when the file exists; with the file absent (fake-effect mode) it
   returns `pass: false`. (ADR-0017, Eng-11)
2. **AC-12-2** — Given a `file` trace with `sha256`, `verify()` returns `pass: false` when
   the file exists but its content hash differs from the declared `sha256` (presence is not
   the effect; content is). (ADR-0017)
3. **AC-12-3** — Given a `sql` trace `expectRows: {op:">=", n:1}`, `verify()` returns
   `pass: true` for ≥ 1 returned rows and `pass: false` for 0 rows (fake-effect mode).
   (ADR-0017, Eng-11)
4. **AC-12-4** — Given an `http` trace `expectStatus: 200`, `verify()` returns `pass: true`
   on a 200 and `pass: false` on a 404 (fake-effect mode). (ADR-0017, Eng-11)
5. **AC-12-5** — Given an `exit` trace `expectCode: 0`, `verify()` returns `pass: true` on
   exit 0 and `pass: false` on a non-zero exit (fake-effect mode). (ADR-0017, Eng-11)
6. **AC-12-6** — A step is marked `done` **only** after its declared probe returns
   `pass: true`; when the model narrates success but the probe returns `pass: false`, the
   step is marked `failed`, not done, and `verify.fail` is journaled. (ADR-0017, ADR-0026)
7. **AC-12-7** — For **each** of the four trace kinds, the fake-effect seam returns the
   effect as absent and `verify()` returns `pass: false`; a verifier that returns `pass:
   true` on any absent effect fails the test. (Eng-11)
8. **AC-12-8** — A plan step whose trace is `{kind:"exit", argv:["echo","ok"]}` (or `true`,
   `:`, `printf`) is rejected by the linter with rule **R3**, and the plan does not pass
   the gate. (ADR-0026, Eng-5)
9. **AC-12-9** — A plan step whose `file` trace path equals `PLAN.md`/`TODO.md`, or whose
   only evidence is a string the same step wrote, is rejected by the linter with rule
   **R4**. (ADR-0026, Eng-5)
10. **AC-12-10** — A plan step with no `trace` field is rejected with **R1**; a step whose
    `kind` is outside `file | sql | http | exit` is rejected with **R5**. (ADR-0026, Eng-5)
11. **AC-12-11** — A step using a Tier ≥ 2 tool with `irreversible !== true` is rejected
    with **R2**. (ADR-0026, ADR-0011)
12. **AC-12-12** — A linter rejection forces a re-plan (the plan does not pass the gate) and
    no mutating tool is dispatched until a lint-passing plan exists; the gate is never
    downgraded. (ADR-0026)
13. **AC-12-13** — The Loop Guardian trips on a **period-1** cycle (A repeated > 3×):
    `observe()` returns `{ trip: true, period: 1 }`, a STOP signal is written, and
    `guardian.tripped` carrying the offending window is journaled. (ADR-0020)
14. **AC-12-14** — The Guardian trips on a **period-2** A-B-A-B cycle repeating > 3× and on
    a **period-3** A-B-C-A-B-C cycle repeating > 3×, returning the matching `period`.
    (ADR-0020)
15. **AC-12-15** — The Guardian does **not** trip on a cycle that repeats ≤ 3 times (a
    normal short retry is allowed). (ADR-0020)
16. **AC-12-16** — Tool-call signatures are order-insensitive: two calls with the same tool
    and the same arguments in a different order produce the same signature, so an oscillation
    that reorders args is still detected. (ADR-0020)
17. **AC-12-17** — On a Guardian trip the run halts and escalates with a diff card and
    **no work is deleted and the run is not auto-resumed** by the Guardian. (ADR-0020)
18. **AC-12-18** — A legitimate Plan-Mode re-plan does **not** trip the Guardian: after
    `note("replan")`, tool calls repeated from the prior plan attempt do not count toward a
    cycle in the new epoch, and no trip occurs unless a cycle repeats > 3× within the new
    epoch. (Eng-12, ADR-0020, ADR-0026)
19. **AC-12-19** — `note("replan")` does **not** reset Core's monotonic budget: a run that
    re-plans repeatedly to evade the Guardian still halts on the monotonic cap. (Eng-12,
    ADR-0020)
20. **AC-12-20** — A known vault secret value injected into a journal payload is absent from
    the persisted entry on disk: `redact()` runs **before** `append()` writes, and reading
    the entry back yields no occurrence of the secret value. (CSO-M3)
21. **AC-12-21** — When the known-secret value set is not loaded, `append()` refuses to
    persist any payload (fail-closed) rather than writing it in the clear. (CSO-M3, §7)
22. **AC-12-22** — Journal entries have gap-free monotonic `seq` and a valid `prevHash`
    chain; altering or removing an entry breaks the chain on `read`, and the run is flagged
    unverifiable from the break point rather than silently accepted. (Repudiation, §7)
23. **AC-12-23** — Cold start: before the verifier's probe is bound and the secret set is
    loaded, `verify()` returns `pass: false` (no step closes) and `append()` refuses to
    persist; normal operation resumes only after the init self-check passes. (§7 cold start)
24. **AC-12-24** — When an effect probe (filesystem/DB/HTTP) raises or times out, the trace
    is treated as **failed** (step not closed); the verifier never returns `pass: true` on a
    probe error. (§7 dependency-unavailable)
25. **AC-12-25** — When the `sql` probe's DB is unreachable, `sql` traces fail and the step
    is not closed; when the `http` endpoint/egress proxy is unavailable, `http` traces fail
    and the step is not closed. (§7, ADR-0006, ADR-0012)
26. **AC-12-26** — A tool dispatch whose journal record cannot be persisted (fsync/IO
    failure) is not allowed to proceed; STATE-before-act holds. (§7, ADR-0021)
27. **AC-12-27** — After a crash mid-run, the Guardian window is rebuilt from the journal's
    `tool.dispatched` tail before dispatch resumes; if it cannot be rebuilt, unattended runs
    are paused rather than resumed without loop protection. (§7)
28. **AC-12-28** — `provider.cost.charged` events are appended to the journal and aggregate
    to a per-task `dollarsSpent` that equals the sum of per-call charges. *(ADR-0036)*

## 10. Open questions

- **Trace-quality rules beyond R1–R5.** ADR-0026 flags that the linter's trace-quality
  rules are themselves worth review; a more sophisticated "does this probe truly assert the
  effect" analysis (beyond the no-op/loopback/own-artifact heuristics) is deferred to a
  later milestone.
- **Guardian window/cap tuning per workload.** ADR-0020 keeps window ≈ 12 and cap = 3 as
  defaults; per-workload tuning (e.g. long legitimate polling loops) is an open calibration
  item, complemented by the monotonic budget for periods > 3.
- **Cryptographic journal signing vs hash-chain.** The `prevHash` chain gives
  tamper-evidence; signing each entry with a user key for stronger non-repudiation is a
  future hardening option, not day one.

## 11. References

- ADRs:
  - [ADR-0017 — External verification by real traces](../decisions/2026-06-11-external-verification-by-traces.md)
  - [ADR-0020 — Loop Guardian (period 1/2/3 detection)](../decisions/2026-06-11-loop-guardian.md)
  - [ADR-0026 — Plan Mode: planning phase, clarification gate, verified TODO](../decisions/2026-06-11-plan-mode-clarification-verified-todo.md)
  - [ADR-0021 — Coordinator-workers orchestration + decision journal](../decisions/2026-06-11-coordinator-workers-orchestration.md) (control outside the conversation)
  - [ADR-0011 — Autonomy gradient (tiers 0–3)](../decisions/2026-06-11-autonomy-gradient.md) (feeds linter R2)
  - [ADR-0036 — Cost-transparency surfacing](../decisions/2026-06-11-cost-transparency-surfacing.md) (cost events ingested into the journal)
- Concept docs:
  - [Nightly consolidation](../concepts/nightly-consolidation.md)
  - [Safety layer](../concepts/safety-layer.md)

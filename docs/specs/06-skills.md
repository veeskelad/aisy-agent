# Component 06: Skills — Specification

**Status:** Draft
**Component:** 06 / 12
**Related ADRs:** ADR-0015, ADR-0025, ADR-0017, ADR-0029
**Depends on:** Memory (03), Nightly Consolidation (10), Observability & Verification (12)

> Skills is Aisy's procedural-memory layer: it owns the `SKILL.md` format, the
> menu-in-prompt / body-on-trigger loading split, and the deterministic staging gate that
> keeps an agent-authored recipe out of prod until a human approves verified traces.

## 1. Purpose

Skills are reusable "how to" recipes the agent loads on demand. Where Memory (03) answers
*"what do I know?"*, Skills answers *"how do I do this?"*. The component exists so the
harness can accumulate procedural know-how without paying for it on every turn and without
letting a ~70%-adherent model promote its own behavior into durable storage.

The OS-around-the-model split runs straight through this component:

- **Model (~70%, reversible/creative):** drafting a new skill body from the day's traces,
  proposing an edit, matching a request against trigger phrases, narrating that a recipe ran.
- **Deterministic code (100%, irreversible/critical):** parsing and validating the frontmatter
  contract, enforcing `description ≤ 60 chars` and the mandatory `verification` section,
  running the body in a sandbox dry-run, checking real traces before a skill is trusted
  (ADR-0017), classifying a failure as transient vs permanent and counting the evidence
  threshold (ADR-0025), and binding a human tap to a specific hash-pinned staged artifact
  before anything is committed to prod git (ADR-0029).

A skill is *drafted* by the model; it is *promoted* by code plus a human. The component never
lets those two roles blur.

## 2. Responsibilities

**Owns:**

- The `SKILL.md` on-disk format: YAML frontmatter contract (`name`, `description`, `version`,
  `provenance`, `triggers`) plus a free-form Markdown body with one mandatory `verification`
  section ([ADR-0015](../decisions/2026-06-11-skill-format-staged-creation.md)).
- The **skill menu**: the resident `name + description` lines (one per active skill) that the
  Agent Loop injects into the always-loaded prefix.
- **Lazy body loading**: trigger-matching a request against the menu and loading exactly the
  matched body into working context, never into the cached prefix.
- The **deterministic validators** (`refs_exist`, `no_constitution_conflict`, `dry_run_ok`,
  `has_verification_section`) that gate every candidate before the judge sees it.
- The **staging area** and the promotion handler that commits an approved skill to prod git
  with a `version` bump, binding the commit to a specific human approval
  ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- The **trace-based trust gate**: a skill is not "trusted" (eligible to appear in the active
  menu) until its `verification` section has passed against real traces, never a self-report
  ([ADR-0017](../decisions/2026-06-11-external-verification-by-traces.md)).
- The **trust-by-source grade** on each skill record — `builtin > trusted-repo > community >
  user` — and the invariant that the model cannot raise its own skill's trust level; the
  grade is set by the source of the skill, not by model output.
- The **negative-skill / failure-classification model**: transient vs permanent tagging, the
  N≥3-across-sessions evidence threshold, advisory (non-veto) priority lowering, and the
  bi-temporal `valid_at` / `invalid_at` record for negative skills
  ([ADR-0025](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md)).
- The reviewer surface payload for a staged skill: full text, the diff, and the triggering
  context that produced it.

**Does not do (boundaries):**

- **The nightly generator and the separate judge** — drafting candidates from traces and the
  independent-model judge pass are owned by **Nightly Consolidation (10)**
  ([ADR-0016](../decisions/2026-06-11-generator-judge-self-learning.md)). Skills supplies the
  validators and the staging contract; Consolidation drives the generate→judge loop.
- **Rendering and delivering the approval card / collecting the human tap, nonce, and step-up
  factor** — owned by **Safety (05)** / Personality (08) approval handler. Skills defines what
  must be bound (hash, action id) and consumes the handler's verdict; it does not own the
  Telegram surface ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- **Running the dry-run sandbox itself** — the network-none, read-only, one-shot Docker
  sandbox is owned by **Safety (05)** ([ADR-0012](../decisions/2026-06-11-docker-sandbox-default.md)).
  Skills calls into it for `dry_run_ok`.
- **Storing usage telemetry rows and the trace journal** — the append-only journal and the
  telemetry sidecar store are owned by **Observability & Verification (12)**. Skills defines
  the schema it needs and reads/writes through that component.
- **General fact memory and bi-temporal fact storage** — owned by **Memory (03)**
  ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)); the negative-skill
  record reuses Memory's bi-temporal columns rather than defining its own.

## 3. Interfaces

Conceptual surface (TypeScript-shaped, illustrative, not binding). Keep the narrow waist in
mind ([ADR-0014](../decisions/2026-06-11-narrow-waist-tool-set.md)): the Agent Loop sees one
small surface — `menu()` and `loadBody()` — and everything else is internal to the component.

```ts
// illustrative, not binding

export type Provenance = 'human' | 'agent-authored' | 'imported'

export interface SkillFrontmatter {
  name: string                 // stable id, telemetry join key, /^[a-z0-9][a-z0-9-]*$/
  description: string          // <= 60 chars, the single menu line
  version: number              // bumped on every approved edit; matches git history
  provenance: Provenance
  triggers: string[]           // phrases/intents matched at runtime
}

export interface MenuEntry { name: string; description: string }   // what enters the prefix

export interface Skills {
  // ---- resident path (cheap, called every prompt assembly) ----
  menu(): MenuEntry[]                                   // active + trusted skills only
  matchTriggers(request: string): string[]             // names whose triggers fire
  loadBody(name: string): Promise<SkillBody>           // into working context, NOT the prefix

  // ---- authoring path (called by Nightly Consolidation 10) ----
  parse(raw: string): ParseResult                      // frontmatter + body, or ParseError[]
  validate(candidate: ParsedSkill): ValidationReport   // §6 deterministic validators
  stage(candidate: ParsedSkill, ctx: TriggerContext): StagedSkill   // hash-pin at stage time
  reviewPayload(stageId: string): ReviewCard           // full text + diff + triggering context

  // ---- promotion path (consumes Safety/Personality approval verdict) ----
  promote(stageId: string, approval: ApprovalVerdict): Promise<PromoteResult>

  // ---- failure / negative-skill path (ADR-0025) ----
  recordFailure(name: string | null, f: FailureSignal): void   // tags transient|permanent
  probe(): Promise<ProbeReport>                        // nightly un-fossilize re-test
}

export interface ValidationReport {
  refs_exist: boolean
  no_constitution_conflict: boolean
  dry_run_ok: boolean
  has_verification_section: boolean
  ok: boolean                  // AND of all four; a false drops the candidate pre-judge
}

export interface ApprovalVerdict {
  stageId: string
  artifactHash: string         // must equal the judge-accept hash (ADR-0029 TOCTOU close)
  nonce: string                // single-use, bound to this exact pending action
  stepUpSatisfied: boolean     // required for permanence/irreversible items
  humanTapAuditId: string      // binding: which tap -> which action -> when
}

export type PromoteResult =
  | { ok: true; commit: string; version: number }
  | { ok: false; reason: 'hash_mismatch' | 'replayed_nonce' | 'stepup_missing'
                        | 'not_trace_verified' | 'no_pending_action' }
```

**Errors returned (not thrown across the waist):** `ParseError` (malformed frontmatter,
unknown field, `description` over 60 chars), `ValidationFailed` (any §6 validator false),
`NotTraceVerified` (no passing `verification` trace on record, ADR-0017), and the
`PromoteResult` failure reasons above (ADR-0029).

**Events emitted (to Observability 12):** `skill.loaded`, `skill.verification_passed`,
`skill.verification_failed`, `skill.staged`, `skill.promoted`, `skill.failure_recorded`
(with `class: transient|permanent`), `skill.negative_created`, `skill.unfossilized`.

**Events consumed:** `tool.failed` / `tool.timeout` (from Tools & Hooks 04, feeds
`recordFailure`), `nightly.tick` (from Nightly Consolidation 10, drives `probe()` and the
hygiene pass), `approval.verdict` (from Safety/Personality, drives `promote`).

## 4. Data structures

### 4.1 `SKILL.md` (on-disk, byte-stable for the menu lines)

```yaml
---
name: deploy-preview              # stable id; telemetry join key; immutable once promoted
description: Ship a Vercel preview and post the URL   # <= 60 chars — the menu line
version: 3                        # bumped on each approved edit; mirrors git commit chain
provenance: agent-authored        # human | agent-authored | imported
triggers:
  - deploy preview
  - vercel preview
  - ship a branch
---

## steps
1. ...

## verification        # MANDATORY — absence is rejected at save time
- `vercel ls` shows the new deployment as `Ready`.
- The preview URL returns HTTP 200 within 30s.
- The posted message contains a `*.vercel.app` URL, not a localhost link.
```

The frontmatter is the machine-readable contract. The `name + description` pair is the only
part that enters the always-loaded prefix, so it must be **byte-stable**: telemetry never
writes into `SKILL.md`, and an edit that does not change the menu line must not perturb the
cached prefix ([ADR-0019](../decisions/2026-06-11-stable-prefix-kv-cache.md)). The `version`
and body may change in git; the menu line changes only on an approved `description` edit.

### 4.2 Staged-skill record (in `staging/`, not yet prod)

| Field | Purpose |
|---|---|
| `stage_id` | Opaque id for the pending review. |
| `artifact_hash` | SHA-256 of the exact bytes the judge accepted; re-checked at promote (ADR-0029 #3). |
| `diff` | Unified diff vs current prod skill (or empty vs nothing for a new skill). |
| `trigger_context` | The request / trace excerpt that caused the draft — shown on the review card (ADR-0015). |
| `trace_verified` | Boolean: did `verification` pass against **real traces** before staging (ADR-0017)? |
| `provenance` | Carried from frontmatter; drives review strictness and step-up eligibility. |

### 4.3 Telemetry sidecar row (owned by Observability 12, joined by `name`)

| Metric | Used for |
|---|---|
| `hit_count` | Hygiene: "never useful" vs "load-bearing". |
| `last_used_at` | 30 / 90-day hygiene clocks. |
| `failure_rate` | Quality signal; feeds the transient-vs-permanent logic. |
| `last_outcome` | Whether the most recent run passed its own `verification` (ADR-0017). |

Telemetry is observational. It informs hygiene and self-learning; it never mutates a
`SKILL.md` or makes a promotion decision on its own.

### 4.4 Negative-skill record (bi-temporal, reuses Memory 03 columns)

| Field | Purpose |
|---|---|
| `target` | The tool/strategy the negative skill deprioritizes. |
| `failure_count` | Distinct-session permanent-class failures; a negative skill needs `≥ 3` (ADR-0025). |
| `session_ids` | The distinct sessions the failures came from (so one session cannot mint 3). |
| `valid_at` / `invalid_at` | Bi-temporal validity; a probe success sets `invalid_at`, never a hard delete. |
| `advisory` | Always `true`: priority-lowering only, never a HARD_DENY (ADR-0025). |

### 4.5 Transient note (below threshold — *not* a skill)

A single or sub-threshold failure is recorded as a lightweight transient note in the
Observability journal, tagged `class: transient|permanent` and `session_id`. It is never
written to `SKILL.md` and never enters the menu. It exists only so the threshold counter can
accumulate distinct-session evidence.

## 5. Behavior & control flow

### 5.1 Resident path — menu and trigger (every turn, deterministic)

```
prompt assembly (Agent Loop 01)
   -> Skills.menu()                 # active + TRUSTED skills only; one line each
   -> inject menu into prefix       # byte-stable region; never the body
request arrives
   -> Skills.matchTriggers(request) # deterministic phrase/intent match
        no match -> base prompt only
        match    -> Skills.loadBody(name)  # into working context, NOT the prefix
   -> agent executes body steps     # model + tools
   -> run `verification` section    # traces, not self-report (ADR-0017)
   -> emit skill.verification_{passed|failed} to Observability 12
```

Menu assembly and trigger matching are deterministic code. Only the body steps are a model
call. A skill that has never passed trace verification is **not trusted** and is excluded
from `menu()` (ADR-0017), so the model cannot rely on an unverified recipe.

### 5.2 Authoring path — draft → validate → judge → stage (deterministic gate)

The generator (Nightly Consolidation 10) drafts a candidate. Skills then runs, in order:

```
candidate SKILL.md
  -> parse()                        # frontmatter contract; description<=60; required fields
       fail -> ParseError, dropped (judge never sees it)
  -> validate()  (§6, all deterministic, 100%):
       refs_exist
       no_constitution_conflict
       dry_run_ok                   # body runs in Safety's network-none sandbox (ADR-0012)
       has_verification_section
       any false -> dropped pre-judge
  -> [Nightly Consolidation 10: separate judge, different model, sees artifact + diff only]
  -> trace verification (ADR-0017)  # verification section run for real; trace_verified=true
       no passing trace -> NOT staged as trusted
  -> stage(candidate, trigger_context)
       hash-pin artifact_hash at this point (ADR-0029 #3)
  -> reviewPayload(): full text + diff + trigger_context  -> review card (Safety/Personality)
```

Validators run **before** the judge so the judge spends tokens only on plausible artifacts.
The judge is a *different* model than the generator and sees only the artifact and its diff,
never the generator's reasoning ([ADR-0016](../decisions/2026-06-11-generator-judge-self-learning.md)).

### 5.3 Promotion path — bind a human tap to a hash-pinned artifact (ADR-0029)

```
human approves a specific card (Safety/Personality handler)
  -> ApprovalVerdict { stageId, artifactHash, nonce, stepUpSatisfied, humanTapAuditId }
  -> Skills.promote():
       re-hash staged bytes; require == verdict.artifactHash   # TOCTOU close (ADR-0029 #3)
         mismatch -> abort -> route to human review
       require nonce single-use & bound to this pending action # replay/stale guard (#4)
         replay  -> abort
       require trace_verified == true                          # ADR-0017
         else    -> abort (not_trace_verified)
       if provenance/category is irreversible/permanence-touching:
         require stepUpSatisfied == true                       # step-up (ADR-0029 #5)
       -> git commit (version++), record tap->commit audit binding
```

No model-set trust: any trust/permanence field in generator or judge output is stripped and
ignored before staging (ADR-0029 #1). The flag that makes a skill "approved" is set only by
this handler, in code, bound to a real human action.

### 5.4 Failure path — transient vs permanent (ADR-0025)

```
tool/strategy fails -> Skills.recordFailure(target, signal)
  classify(signal):
    transient  := timeout | connection-reset | HTTP 5xx | missing-dependency
    permanent  := auth-denied | capability-absent | HARD_DENY
  if transient OR distinct-session permanent count < 3:
       write transient note (NOT a skill); increment counter keyed by (target, session_id)
  if permanent AND distinct-session count >= 3:
       draft NEGATIVE skill -> §5.2 authoring path -> staging -> human approval
       on promote: advisory only (lowers priority; never HARD_DENY; capability not deleted)

nightly probe():
  for each negative skill: re-test the failed strategy on the cheap routine model
    first success -> set invalid_at (NOT hard delete) -> emit diff card -> un-fossilize
    still failing -> keep advisory; hysteresis on threshold so a flaky tool does not oscillate
```

This is the direct fix for the Hermes #6051 fossilization: a one-off outage can never become
a permanent "I can't do this" recipe, because (a) one failure is below threshold, (b) only
permanent-class repeats across distinct sessions qualify, (c) the result is advisory not a
veto, and (d) the nightly probe re-tests and un-fossilizes on first success. The LLM may
*hint* at transient-vs-permanent; the deterministic threshold + probe *decide* (ADR-0025).

### 5.5 Hygiene (nightly, soft)

| Age since `last_used_at` | Action |
|---|---|
| ≤ 30 days | Active. No action. |
| > 30 days, unused | Flag **dormant**; surface on morning card. Stays loadable. |
| > 90 days, unused | Propose **archival** to `staging/`; human approves the soft move. Recoverable from git. |

Hygiene proposes; the human disposes. Nothing is hard-deleted.

A self-learning / nightly Curator pass never overwrites a user-modified skill: when it would
regenerate or edit such a skill, it archives a *new candidate* through the staging path
instead of clobbering the user's version, so the user's bytes are never deleted by the pass.

## 6. Dependencies

**Internal:**

- **Core / Agent Loop (01)** — calls `menu()` and `loadBody()`; owns the prefix the menu sits in.
- **Memory (03)** — bi-temporal `valid_at` / `invalid_at` columns the negative-skill record reuses
  ([ADR-0023](../decisions/2026-06-11-durable-forgetting-tombstones.md)).
- **Tools & Hooks (04)** — source of `tool.failed` / `tool.timeout` signals that feed `recordFailure`.
- **Safety (05)** — owns the dry-run sandbox used by `dry_run_ok`
  ([ADR-0012](../decisions/2026-06-11-docker-sandbox-default.md)); hosts the approval handler,
  nonce, and step-up factor ([ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md)).
- **Nightly Consolidation (10)** — owns the generator and the separate judge; drives `probe()`
  and the hygiene pass on each `nightly.tick`
  ([ADR-0016](../decisions/2026-06-11-generator-judge-self-learning.md)).
- **Observability & Verification (12)** — owns the append-only journal, the telemetry sidecar,
  and the trace-verification probes that produce `trace_verified`
  ([ADR-0017](../decisions/2026-06-11-external-verification-by-traces.md)).

**External:**

- **git** — every approved save is a commit; archival and edits are revertible from history
  ([ADR-0015](../decisions/2026-06-11-skill-format-staged-creation.md)).
- **A YAML parser** (frontmatter) and **SHA-256** (artifact hash-pinning), part of the
  TypeScript core ([ADR-0004](../decisions/2026-06-11-typescript-for-core.md)).
- **Docker sandbox** (via Safety) for `dry_run_ok`
  ([ADR-0012](../decisions/2026-06-11-docker-sandbox-default.md)).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** (no skill library / empty `staging/`) | `menu()` returns empty on boot | Fail-open for the agent: base prompt only, no menu line; no error to user | Skills appear as soon as the first is promoted; nothing to recover |
| **Malformed `SKILL.md`** (bad YAML, missing field, `description` > 60 chars) | `parse()` returns `ParseError` | Fail-closed: candidate dropped pre-judge; existing prod skills unaffected; a malformed *prod* file is excluded from `menu()` and logged | Generator re-drafts; human edits the file in git |
| **No `verification` section** | `has_verification_section` false | Fail-closed: candidate dropped at save time (ADR-0015); never staged | Generator adds a verification section and re-submits |
| **`dry_run_ok` sandbox unavailable** (Safety/Docker down) | Sandbox call errors/times out | Fail-closed: validator returns false; candidate not staged (cannot prove it runs) | Retry on next nightly tick once sandbox is back; no partial promotion |
| **Trace verification unavailable** (Observability 12 down) | `trace_verified` cannot be set true | Fail-closed: skill stays untrusted, excluded from `menu()`; not promoted (ADR-0017) | Re-verify when Observability returns; trust granted only on a real passing trace |
| **Judge unavailable** (Nightly Consolidation 10 / judge model down) | Judge call errors | Fail-closed: candidate held in pre-judge queue; not auto-promoted | Judge runs on next nightly tick; no skill bypasses the judge |
| **Approval handler / Telegram unavailable** (Safety/Personality down) | No `ApprovalVerdict` arrives | Fail-closed: skill remains in `staging/`; nothing reaches prod | Promote when the handler returns; staged artifact and its hash persist |
| **Staging-area swap between judge-accept and promote** (TOCTOU) | `promote()` re-hash ≠ `artifactHash` | Fail-closed: abort, route to human review (ADR-0029 #3) | Human re-reviews the actual current bytes |
| **Replayed / stale approval tap** | Nonce already used or not bound to this pending action | Fail-closed: reject (`replayed_nonce` / `no_pending_action`) (ADR-0029 #4) | Re-issue a fresh card with a new nonce |
| **Missing step-up on a permanence/irreversible approval** | `stepUpSatisfied == false` on a flagged item | Fail-closed: promotion rejected (`stepup_missing`) (ADR-0029 #5) | Re-approve with the second factor |
| **Single transient failure of a tool** | `classify()` tags it `transient` or count < 3 distinct sessions | Degrade, not fossilize: log a transient note only; no negative skill (ADR-0025) | Strategy stays fully available; counter resets per hysteresis window |
| **Fossilized negative skill, tool recovered** | Nightly probe re-test succeeds | Auto un-fossilize: set `invalid_at`, emit diff card; capability restored (ADR-0025) | Human confirms the removal card; git retains the history |
| **Telemetry sidecar unavailable** | Sidecar read/write errors | Fail-open for serving: skills still load and run; hygiene/failure-rate pass is skipped this tick | Hygiene resumes next tick; serving never blocked on telemetry |

## 8. Security & threat model

Skills is security-relevant: it ingests agent-authored content (untrusted, generator runs over
day-log content), and it writes to durable, behavior-shaping storage. Threats and their
**deterministic** mitigations:

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **Tampering / Elevation — model mints "approved" trust.** Generator/judge output carries a trust/permanence flag, self-promoting a skill. | Strip and ignore any trust/permanence field in model output; the approved flag is set only by the deterministic promote handler bound to a human tap. | Code (ADR-0029 #1, #2) |
| **Tampering (TOCTOU) — staging swap.** Bytes are changed between judge-accept and human approval. | Hash-pin the artifact at judge-accept; re-hash at promote; mismatch aborts to human review. | Code (ADR-0029 #3) |
| **Spoofing / Replay — stale or replayed tap.** A captured approval is replayed against a different pending action. | Single-use per-action nonce bound to the exact pending action; replays/stale taps rejected. | Code (ADR-0029 #4) |
| **Repudiation / click-fatigue on permanence.** A one-tap "approve all" promotes an irreversible/permanence-touching skill. | Step-up second factor required for irreversible / permanence items; plain tap insufficient; tap→commit audit binding recorded. | Code (ADR-0029 #5) |
| **OWASP-LLM01 Prompt Injection — malicious recipe.** Untrusted day-log content drives the generator to draft a harmful body. | `dry_run_ok` in a network-none, read-only, one-shot sandbox; `no_constitution_conflict`; `refs_exist`; separate independent judge; human approval. No agent-authored skill reaches prod without all four plus a human. | Code + human (ADR-0015, ADR-0016, ADR-0012) |
| **OWASP-LLM05 Improper Output Handling — unverifiable recipe.** A skill claims success it cannot prove. | `has_verification_section` mandatory at save; trust granted only on a *real passing trace*, never a self-report. | Code (ADR-0015, ADR-0017) |
| **Denial-of-capability via fossilization (learned helplessness, #6051).** A transient outage permanently disables a tool. | Failure classifier; N≥3 permanent-class failures across distinct sessions before any negative skill; negative skills advisory (never HARD_DENY); nightly probe un-fossilizes on first success. | Code (ADR-0025) |

**Enforced by code vs by the model:** the model may draft a body, propose an edit, and *hint*
whether a failure looks transient. Everything that makes a skill durable, trusted, or
deprioritizing — the four validators, trace verification, hash-pinning, nonce, step-up, and
the failure threshold/probe — is deterministic code. At least one non-LLM enforcement layer
governs every irreversible step, per NIST.

## 9. Acceptance criteria (mandatory)

Each is a single objectively verifiable assertion for a Phase-3 test.

**Format contract (ADR-0015, finding 3)**

1. **AC-06-1** — Parsing a `SKILL.md` whose `description` is 61+ characters returns a
   `ParseError` and the candidate is **not** written to `staging/`.
2. **AC-06-2** — A `SKILL.md` missing any required frontmatter field (`name`, `description`,
   `version`, `provenance`, or `triggers`) is rejected by `parse()` and never reaches the judge.
3. **AC-06-3** — A candidate with no `## verification` section fails `has_verification_section`
   and is dropped at save time; no file appears in `staging/` for it.
4. **AC-06-4** — `menu()` output contains exactly one line per active+trusted skill, each line
   = `name` + `description`, and contains **no** skill body text (assert no body line is present).

**Lazy loading / KV-cache stability (ADR-0015, ADR-0019)**

5. **AC-06-5** — On a request with no trigger match, `loadBody()` is not called and the working
   context contains no skill body.
6. **AC-06-6** — On a trigger match, the matched body is present in working context and the
   always-loaded prefix bytes are unchanged (byte-equal before and after `loadBody()`).
7. **AC-06-7** — Writing a telemetry update (hit_count/last_used_at) leaves the corresponding
   `SKILL.md` file bytes unchanged (the sidecar, not the file, was modified).

**Deterministic validators (ADR-0015, ADR-0016)**

8. **AC-06-8** — A candidate referencing a non-existent file/skill/tool fails `refs_exist` and
   the judge is never invoked for it (assert no judge call logged).
9. **AC-06-9** — When the dry-run sandbox is unavailable, `dry_run_ok` returns false and the
   candidate is not staged (fail-closed).
10. **AC-06-10** — A candidate that conflicts with `constitution.md` fails
    `no_constitution_conflict` and is dropped before staging.

**Trace-based trust (ADR-0017, finding 3)**

11. **AC-06-11** — A skill whose `verification` section has not passed against real traces has
    `trace_verified == false` and is **excluded** from `menu()`.
12. **AC-06-12** — `promote()` called on a skill with `trace_verified == false` returns
    `{ ok: false, reason: 'not_trace_verified' }` and creates no git commit.
13. **AC-06-13** — A self-reported "verification passed" with no corresponding trace in the
    Observability journal does **not** set `trace_verified` to true.

**Staging governance & approval integrity (ADR-0015, ADR-0029, finding 1)**

14. **AC-06-14** — Every agent-authored (`provenance: agent-authored`) skill that reaches prod
    has a git commit, and that commit's parent state had the skill in `staging/` (no
    agent-authored skill appears in prod without a prior staged artifact).
15. **AC-06-15** — The review payload for a staged skill contains all three of: full skill text,
    the diff vs prod, and the triggering context.
16. **AC-06-16** — Any trust/permanence field present in generator or judge output is absent
    from the staged artifact (it was stripped); `promote()` sets the approved flag only from
    the deterministic handler.
17. **AC-06-17** — `promote()` aborts with `{ ok: false, reason: 'hash_mismatch' }` when the
    staged bytes differ from `approval.artifactHash`, and no commit is created.
18. **AC-06-18** — `promote()` rejects a replayed/stale nonce with
    `reason: 'replayed_nonce'` (or `no_pending_action`) and creates no commit.
19. **AC-06-19** — `promote()` of a permanence/irreversible-flagged skill with
    `stepUpSatisfied == false` returns `reason: 'stepup_missing'` and creates no commit.
20. **AC-06-20** — A successful `promote()` writes a tap→commit audit binding linking the
    `humanTapAuditId` to the resulting commit hash and version.

**Transient-vs-permanent failure (ADR-0025, finding 2)**

21. **AC-06-21** — A single tool failure (or a `transient`-classified failure) produces a
    transient note in the journal and **no** negative `SKILL.md` is created.
22. **AC-06-22** — Three permanent-class failures all within the **same** session do not cross
    the threshold; no negative skill is drafted (distinct-session requirement enforced).
23. **AC-06-23** — Three permanent-class failures across three **distinct** sessions draft a
    negative skill candidate that enters the staging path.
24. **AC-06-24** — An approved negative skill lowers the target strategy's priority but never
    emits a HARD_DENY (assert the capability remains callable; advisory == true).
25. **AC-06-25** — When the nightly `probe()` re-test of a negative skill's target succeeds, the
    record's `invalid_at` is set (not a hard delete) and an un-fossilize diff card is emitted.

**Failure/degraded modes (§7)**

26. **AC-06-26** — On cold start with an empty library, `menu()` returns an empty list and prompt
    assembly proceeds with the base prompt (no error surfaced to the user).
27. **AC-06-27** — When the telemetry sidecar is unavailable, `loadBody()` still returns the body
    and the skill runs (serving is not blocked on telemetry).

**Trust source & user-modified protection (§2, §5.5)**

28. **AC-06-28** — a skill marked user-modified is never overwritten by a generator/Curator pass;
    the pass archives a new candidate rather than clobbering the user's version.
29. **AC-06-29** — skill trust is graded by source (builtin > trusted-repo > community > user) and
    the model cannot raise its own skill's trust level.

## 10. Open questions

- **Trust gradient for low-risk categories.** Auto-commit for categories with a clean approval
  track record is deferred to [ADR-0016](../decisions/2026-06-11-generator-judge-self-learning.md);
  irreversible/safety-touching categories never auto-commit. Resolution lives in the nightly-loop
  milestone, not this component.
- **Hysteresis constants** for the negative-skill threshold and the probe cadence are left to
  implementation tuning under [ADR-0025](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md);
  the invariant (N≥3 distinct sessions, advisory, probe un-fossilizes) is fixed here.
- **Out-of-band recovery** if the step-up second factor is lost (a human-confirmed permanence
  action cannot otherwise be made) is documented at the operator level in SECURITY per
  [ADR-0029](../decisions/2026-06-11-human-confirmation-provenance-binding.md); not in scope here.

## 11. References

- ADRs:
  - [ADR-0015 — Skill Format + Staged Creation](../decisions/2026-06-11-skill-format-staged-creation.md)
  - [ADR-0025 — Transient-vs-Permanent Failure for Skills](../decisions/2026-06-11-transient-vs-permanent-skill-failure.md)
  - [ADR-0017 — External Verification by Real Traces](../decisions/2026-06-11-external-verification-by-traces.md)
  - [ADR-0029 — Human-Confirmation Provenance and Approval Integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
  - [ADR-0016 — Generator + Separate Judge for Self-Learning](../decisions/2026-06-11-generator-judge-self-learning.md)
  - [ADR-0012 — Docker Sandbox by Default](../decisions/2026-06-11-docker-sandbox-default.md)
  - [ADR-0019 — Stable-Prefix KV-Cache](../decisions/2026-06-11-stable-prefix-kv-cache.md)
  - [ADR-0023 — Durable Forgetting with Tombstones](../decisions/2026-06-11-durable-forgetting-tombstones.md)
  - [ADR-0014 — Narrow-Waist Tool Set](../decisions/2026-06-11-narrow-waist-tool-set.md)
  - [ADR-0004 — TypeScript for Core](../decisions/2026-06-11-typescript-for-core.md)
- Concept docs:
  - [`docs/concepts/skill-lifecycle.md`](../concepts/skill-lifecycle.md)
  - [`docs/concepts/nightly-consolidation.md`](../concepts/nightly-consolidation.md)

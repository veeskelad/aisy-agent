# Component 10: Nightly Consolidation — Specification

**Status:** Accepted (wired live, ADR-0053)
**Component:** 10 / 12
**Related ADRs:** ADR-0016, ADR-0017, ADR-0023, ADR-0029, ADR-0030
**Depends on:** Memory (03), Provider Routing (09), Safety (05), Observability & Verification (12)

> The deterministic batch job that runs once a night to archive the day, distill memory,
> prune skills, reclaim disk, and back up — proposing every agent-authored change into
> staging behind a single human approval, and never letting a forgotten fact crawl back.

## 1. Purpose

Nightly Consolidation is the part of the harness that owns the night. During the day the
model *proposes* (memory writes, skill drafts) and those writes are deliberately deferred
so the frozen snapshot and KV-cache stay byte-stable (ADR-0007). At 03:30 local a
cron-driven, code-driven pipeline *disposes*: it applies the deferred work once, atomically,
while nothing is reading.

This is almost entirely OS work, not CPU work. The model is a stateless probabilistic unit
at ~70% adherence; the night is where the deterministic 100% layer earns its keep. The model
appears in exactly two bounded, separated roles — a cheap **generator** that drafts candidate
memory ops and skill drafts, and a **separate, blind judge** that grades them
([ADR-0016](../decisions/2026-06-11-generator-judge-self-learning.md)). Neither ever decides
to actually delete, drop, prune, or push. Every irreversible step is gated by code,
preconditioned, and reversible by snapshot.

The split is reversibility. Drafting candidate facts and grading a diff are reversible,
creative, model work. Committing a deletion, dropping a skill, running `VACUUM`, pruning
Docker, and pushing the backup are irreversible and belong to deterministic code that the
model never gets a vote on. The component's central guarantee is the one the owner's founding
bug demanded: a fact the human asked to forget never comes back — closed at ingestion, at the
guard, at the index, and at the human gate.

## 2. Responsibilities

This component **owns**:

- The **nightly job lifecycle**: cron trigger at 03:30 local, the exclusive run lock, the
  least-privilege execution context, and the sequential, idempotent five-stage pipeline
  (archival → memory consolidation → skill hygiene → DB/disk hygiene → git-push backup).
- **Session archival**: content-addressed freezing of transcripts, rolling the daily file,
  and minting the *normalized day log* that is the only input the generator reads — with the
  forget-list filter applied **at ingestion** (ADR-0023, ADR-0030).
- **The generator/judge orchestration**: invoking the cheap generator to propose
  `ADD/UPDATE/DELETE/NOOP` ops and skill drafts, running the deterministic validators, then
  invoking the separate judge on survivors (ADR-0016, ADR-0017).
- **The deterministic validator set**: `refs_exist`, `no_conflicts`
  (`no_constitution_conflict`), `dry_run_ok`, `has_check_section`
  (`has_verification_section`), run **before** the LLM judge (ADR-0016).
- The **resurrection-guard invocation at consolidation commit time**, and the requirement
  that it re-run on every reindex/promotion (the guard *logic* is owned by Memory (03) per
  ADR-0030; this component enforces that no commit or reindex path bypasses it).
- **Staging discipline**: stages 2 and 3 write only to `staging/`; nothing is promoted to
  live memory tables or `skills/` except by the human tapping Approve.
- The **morning approval card**: the single artifact carrying memory edits, blocked
  resurrections, skill changes, hygiene report, backup status, and cost; with each staged
  patch hashed at judge-accept and re-verified at promotion (ADR-0029).
- **Crash-recovery ordering** for the commit step: the defined order between
  (flip `invalid_at` + reindex, atomic) and (git commit/push), and how a crash between them
  recovers (Eng-7).
- **Trace-based self-verification** of its own effects (archived, deleted, vacuumed,
  pushed) — reporting what it *proved*, not what it *claimed* (ADR-0017).

This component **does not**:

- Set `is_human_confirmed` or any trust/permanence flag — **Safety (05)** owns the approval
  handler that is the sole writer of that flag (ADR-0029). This component strips it from
  generator/judge output and routes the human tap to that handler.
- Own the resurrection-guard *algorithm*, the bi-temporal schema, the forget-list, or the
  FTS5 indexer — **Memory (03)** owns those (ADR-0023, ADR-0030). This component calls them
  on the commit/reindex path and fails closed if they are unavailable.
- Choose the generator/judge models or apply batch tariffs — **Provider Routing (09)**
  resolves the two models and the batch endpoint (ADR-0018).
- Define `HARD_DENY`, the sandbox contract, or the Tier-3 carve-out policy — **Safety (05)**
  owns those; this component's hygiene ops run *under* them and within the carve-out allowlist.
- Render the Telegram card or capture the tap — **Gateway (02)** renders; **Safety (05)**'s
  approval handler validates the tap. This component supplies the card contents and the
  pending-action set.
- Run the day's live agent loop or live within-session memory writes — those are **Core (01)**
  and **Memory (03)**; the night only applies deferred writes.

## 3. Interfaces

Conceptual API surface; signatures are illustrative, not binding, and stay inside the
narrow-waist tool philosophy (ADR-0014) — the night exposes an orchestrated job, not new
agent tools.

```ts
// illustrative, not binding

interface NightlyJob {
  // Entry point invoked by cron at 03:30 local. Returns only after the morning card is staged.
  run(now: Date): Promise<NightResult>
}

type Stage = 'archival' | 'consolidation' | 'skill-hygiene' | 'disk-hygiene' | 'backup'

interface RunLock {
  // PID-reuse-safe: token = {pid, boot-id/start-time, random nonce}, not bare PID liveness.
  acquire(): { ok: true; token: LockToken } | { ok: false; heldBy: LockToken; heldForMs: number }
  release(token: LockToken): void
}

type MemOp =
  | { kind: 'ADD'; factKey: FactKey; text: string }
  | { kind: 'UPDATE'; factId: string; factKey: FactKey; text: string }
  | { kind: 'DELETE'; factId: string; reason: string }   // never carries is_human_confirmed
  | { kind: 'NOOP'; factId: string }

interface Generator {
  // Reads the NORMALIZED, forget-filtered day log + live facts only (invalid_at IS NULL).
  proposeMemoryOps(log: NormalizedDayLog, liveFacts: Fact[]): Promise<{ ops: MemOp[]; diff: Diff }>
  draftSkills(log: NormalizedDayLog): Promise<SkillDraft[]>
}

type ValidatorId = 'refs_exist' | 'no_conflicts' | 'dry_run_ok' | 'has_check_section'

interface Validators {
  // Deterministic, 100%. Run BEFORE the judge. A failing candidate is dropped (or, for
  // resurrection, routed to human review) and is invisible to the judge.
  check(candidate: MemOp | SkillDraft): { ok: boolean; failed?: ValidatorId[] }
}

interface Judge {
  // Different model/provider. Sees ONLY the final artifact + diff, never the generator CoT.
  // Reads the diff AFTER it has passed the input classifier/quarantine (CSO-M5).
  grade(quarantinedDiff: QuarantinedDiff): Promise<'accept' | 'reject' | 'edit'>
}

interface StagedPatch {
  id: string
  body: string
  hashAtAccept: string   // computed at judge-accept (ADR-0029); re-verified at promotion
  // NOTE: never contains is_human_confirmed; stripped before staging.
}
```

Events emitted: `night.started`, `night.lock.contended`, `night.lock.held_too_long`,
`night.stage.completed`, `night.resurrection.blocked`, `night.judge.accepted`,
`night.commit.applied`, `night.backup.pushed`, `night.backup.failed`, `night.card.staged`,
`night.verify.miss`. Events consumed: `memory.snapshot.ready` (from 03),
`router.batch.ready` (from 09), `safety.approval.bound` (from 05),
`observability.trace.ready` (from 12).

## 4. Data structures

- **`night.lock`** — `{ pid, bootId, startTime, nonce, acquiredAt }`. The liveness token is
  PID-reuse-safe: a stale lock is only reclaimed if the recorded `{pid, bootId, startTime}`
  triple does not resolve to a live process *of this job* — a recycled PID belonging to an
  unrelated process never satisfies the triple, so it is never mistaken for the prior run
  (CSO-H6). A lock held past a configured `maxHeldMs` raises `night.lock.held_too_long`.

- **Normalized day log** — the de-duplicated, timestamp-ordered stream of
  `(utterance, tool-call, tool-result, decision-journal entry)` records, with every record
  matching a `do_not_remember` entry already dropped (ADR-0023 §3, ADR-0030). This, not the
  raw transcript, is the generator's only input.

- **Candidate memory op (`MemOp`)** — the mem0-style `ADD/UPDATE/DELETE/NOOP` vocabulary
  (ADR-0023). A `DELETE`/`UPDATE` op **never** carries `is_human_confirmed`; any such field
  on generator/judge output is stripped before staging (ADR-0029).

- **`FactKey`** — the `(entity, relation, object)` equivalence-class key used by the
  resurrection-guard so paraphrases are caught, not surface text (ADR-0030). Owned by Memory;
  consumed here.

- **Staged patch** — `staging/memory/*.patch` and `staging/skills/*`, each with a
  `hashAtAccept` computed at judge-accept and re-verified at promotion (ADR-0029). The artifact
  the human approves must be byte-identical to the one the judge accepted.

- **Quarantined diff** — the generator's diff after passing through the input
  classifier/quarantine (Safety 05, ADR-0028); the judge reads only this, never raw day-log
  text (CSO-M5).

- **Commit journal entry** — `{ runDate, stage, op, factIds, snapshotRef, reindexDone,
  gitCommitHash?, state: 'pending' | 'reindexed' | 'committed' }`. The crash-recovery anchor
  (Eng-7): on restart the job reads this to resume idempotently.

- **Morning card** — bounded sections `{ memoryEdits, triedToResurrect, skillChanges,
  hygieneReport, backupStatus, cost }`, each pending item carrying its `hashAtAccept`, a
  single-use nonce, and an action-hash for the approval handler (ADR-0029).

Nothing here is part of the KV-cache stable prefix; promoted changes only enter the *next*
session's snapshot, never mid-session (ADR-0007, ADR-0019 unaffected).

## 5. Behavior & control flow

Five sequential, idempotent stages under one exclusive lock. Re-running a partially-completed
night converges to the same end state (archival is content-addressed, consolidation works off
a snapshot, hygiene ops are no-ops when clean).

```
NIGHTLY PIPELINE (deterministic orchestration, 100%)
  cron 03:30 local
    -> RunLock.acquire()                                          [PID-reuse-safe; CSO-H6]
         held by live prior run         -> ABORT + alert
         held past maxHeldMs            -> alert (held_too_long), do not blind-steal
         clean                          -> proceed
    -> assert least-privilege context: no prod creds in env; egress allowlist = backup remote only  [CSO-H6]

  STAGE 1  Session archival                                       [deterministic]
    -> freeze transcripts to archive/sessions/<date>/<id>.md (content-addressed)
    -> roll daily file; open fresh daily
    -> mint NORMALIZED day log; DROP any record matching do_not_remember  [ADR-0023/0030]

  STAGE 2  Memory consolidation                                  [generator + validators + guard + judge]
    -> Generator.proposeMemoryOps(normalizedLog, liveFacts)      [model; batch tariff, ADR-0018]
    -> STRIP is_human_confirmed from every op                    [code; CSO-C3, ADR-0029]
    -> Validators.check(): refs_exist, no_conflicts              [code, 100%, BEFORE judge]
         fail -> drop candidate (judge never sees it)
    -> resurrection-guard (Memory 03) on every ADD/UPDATE        [code, 100%; ADR-0023/0030]
         match tombstone / forget-list / human-confirmed delete -> BLOCK -> human-review section
         clean -> continue
    -> quarantine the diff through input classifier              [Safety 05; CSO-M5, ADR-0028]
    -> Judge.grade(quarantinedDiff)  (different provider, no CoT) [model; ADR-0016]
         accept -> write staging/memory/*.patch; hash at accept  [code; ADR-0029]
         reject/edit -> drop / re-queue
    -> NOTE: judge "accept" never bypasses validators or guard   [code; CSO-M5]

  STAGE 2b Lint pass                                              [generator-assisted; graceful degradation]
    -> scan working/*.md cross-link references                   [code]
    -> query SQLite fact_key neighbor index                      [code]
    -> scan annotation timestamps for staleness                  [code]
    -> Generator proposes remediation for each finding:
         orphan pages/facts (no inbound cross-links)            -> staging/lint/orphans.*
         stale annotations (no update past threshold)           -> staging/lint/stale.*
         missing neighbor edges (unresolvable supersedes/       -> staging/lint/broken-edges.*
           contradicts/extends fact_key references)
    -> proposals written to staging/ alongside Stage 2 output; NOT auto-promoted
    -> if generator unavailable: SKIP Stage 2b entirely; morning card notes "lint pass skipped" + reason

  STAGE 3  Skill hygiene                                          [same generator->validators->judge discipline]
    -> validators add dry_run_ok + has_check_section             [code, 100%, BEFORE judge]
    -> fossilization (transient-origin) + stale/dup -> FLAG only  [ADR-0025]
    -> survivors -> staging/skills/*  (never edit skills/ in place)

  STAGE 4  DB / disk hygiene                                     [deterministic; under Safety carve-out]
    -> pre-VACUUM DB snapshot FIRST, then VACUUM / FTS5 optimize / WAL checkpoint / log rotate
       / scoped docker prune / merged-worktree prune             [ADR-0012; no --force, no skip-perms]

  STAGE 5  Git-push backup                                       [deterministic]
    -> commit promoted-on-approval changes; push fast-forward ONLY (never --force)
    -> failure: retry, then report on card (non-fatal, never silent)

  -> assemble MORNING CARD (staging only; nothing live changed)  [code]
  -> RunLock.release()
```

**Stage 2b — Lint pass**

After Stage 2 synthesis, a lint pass scans the working memory for structural health:

- **Inputs:** cross-link references in `working/*.md` files, the fact_key neighbor index in SQLite, and annotation timestamps.
- **Outputs:** orphan report (pages/facts with no inbound cross-links), stale annotation list (annotations with no update past the configured threshold), missing neighbor list (fact_keys referenced via `supersedes`/`contradicts`/`extends` edges that cannot be resolved).
- **Behavior:** The generator proposes remediation for each finding (e.g., delete orphan, refresh stale annotation, flag unresolvable edge). Proposals are staged in `staging/` alongside Stage 2 output and promoted only on human approval — the same gate as all other consolidation output.
- **Graceful degradation:** If the generator is unavailable, Stage 2b is skipped entirely. The morning card reports "lint pass skipped" with a reason. No error is raised; the nightly run completes normally.
- **Cost budget:** Stage 2b adds approximately 10–30% more LLM tokens to the nightly batch compared to Stage 2 alone. The morning card includes a cost line for Stage 2b separately.

Promotion happens later, on the human tap, not during the night run:

```
PROMOTION (on human Approve tap, via Safety 05 approval handler)
  for each approved staged patch:
    re-verify hashAtPromote == hashAtAccept                       [TOCTOU; ADR-0029]
       mismatch -> abort this item -> human review
    re-run resurrection-guard at commit AND before reindex        [code; ADR-0023/0030]
       block -> route to human review, do not commit
    COMMIT ORDER (Eng-7):
      (1) atomic txn: flip invalid_at / insert rows + FTS5 reindex  [single SQLite txn]
      (2) git commit + push                                          [after txn durably committed]
    is_human_confirmed set ONLY by approval handler on a real tap   [Safety 05; ADR-0029]
  rebuild frozen snapshot for NEXT session                          [ADR-0007]
```

**Crash-recovery ordering (Eng-7).** The atomic memory transaction (step 1) is the source of
truth and commits *before* the git commit/push (step 2), with the commit-journal entry written
inside the same SQLite transaction:

- **Crash after (1), before (2):** the SQLite txn is durably committed and the journal entry
  reads `reindexed`; on restart the job finds no matching git commit and *resumes at step 2*
  (re-runs git add/commit/push). Git commit is idempotent on identical content; no double-apply.
- **Crash during (1):** SQLite atomicity rolls the txn back entirely (`invalid_at` not flipped,
  index unchanged, journal stays `pending`); on restart the item is re-attempted from the start,
  re-passing the resurrection-guard.
- **Crash during (2):** SQLite already durable; git push is re-attempted (fast-forward,
  idempotent). A push that half-succeeded advances the remote ref; re-push is a no-op.

The ordering guarantees the live memory state and its index are never out of sync with each
other (they move in one txn), and that git can lag but never lead the database — a backup never
contains a commit the live DB has not durably applied.

**Backup read-back, restore, and manual trigger.** After the Stage-5 git-push backup, a
read-back verification fetches the remote and confirms the pushed ref equals local `HEAD`;
a mismatch or failure is reported on the morning card and never silently ignored. The
documented restore path reconstructs the SQLite memory index from the backup remote and
re-applies the full forget invariant on the way in, so a previously forgotten fact does not
reappear post-restore (ADR-0030). A manual `/consolidate` trigger (from
[spec 13](13-onboarding-and-operations.md)) runs the same generator→judge→staging pipeline
and lands its output in the same staging gate as the nightly run — never auto-promoted.

**GROOM-derived patterns (consumption-as-trigger, fact-level canaries).** Two patterns
borrowed from gated background KB maintenance harden the consolidation pass:

- **Consumption-as-trigger (optional).** Beyond the 03:30 clock, consolidation/maintenance
  for a memory region may also fire *in proportion to how often that region is read*, so
  heavily-used memory stays fresh without manual tending. This is an additive trigger, not a
  replacement: the deterministic staging gate, validators, resurrection-guard, and human
  approval are unchanged regardless of what fired the run.
- **Fact-level canaries.** A consolidation edit must preserve load-bearing ("canary") facts.
  The deterministic validator set rejects any edit (`UPDATE`/`DELETE` op or a synthesized
  rewrite) that would drop a canary fact, *before* the judge sees it — running alongside the
  existing resurrection-guard, which closes the opposite failure (a forgotten fact crawling
  back). Together they bound consolidation from both sides: nothing load-bearing is lost, and
  nothing tombstoned returns.

Where the model is and is not: the model is the **generator** (drafts) and the **judge**
(grades a quarantined diff). Everything else — lock, archival, validators, resurrection-guard,
canary check, quarantine, commit ordering, reindex, hygiene, push, verification — is
deterministic code.

## 6. Dependencies

- **Internal:**
  - **Memory (03)** — owns the bi-temporal schema, `do_not_remember`, the FTS5 indexer, the
    resurrection-guard algorithm, and the equivalence-class `FactKey`. This component calls the
    guard on the commit/reindex path and the indexer for atomic reindex (ADR-0023, ADR-0030).
  - **Provider Routing (09)** — resolves the cheap generator model and the separate judge model
    (different provider) and the batch endpoint/tariff (ADR-0016, ADR-0018).
  - **Safety (05)** — owns the approval handler (sole writer of `is_human_confirmed`,
    hash/nonce/step-up), the input classifier/quarantine the diff passes through, `HARD_DENY`,
    and the nightly Tier-3 carve-out the hygiene ops run within (ADR-0029, ADR-0028, ADR-0012).
  - **Observability & Verification (12)** — provides the append-only journal and the trace
    probes the night uses to self-verify its claimed effects (ADR-0017).
  - **Gateway (02)** — renders the morning card and routes the human tap back to Safety's handler.
- **External:**
  - **SQLite (FTS5/BM25)** — the memory substrate; transactions, `VACUUM`, `optimize`,
    `wal_checkpoint` (ADR-0006).
  - **git + remote backup** — fast-forward push only (ADR-0006).
  - **cron** — the 03:30 local trigger; runs in a least-privilege context with no prod creds
    and egress restricted to the backup remote (CSO-H6).
  - **Docker** — scoped prune of dead one-shot sandbox containers (ADR-0012, via Safety carve-out).

## 7. Failure & degraded modes (mandatory)

| Failure | Detection | Behavior | Recovery |
|---|---|---|---|
| **Cold start** — first run, no prior lock / no snapshot / empty staging | Lock absent; `memory.snapshot.ready` consumed | **Proceed clean**: acquire lock, archive, consolidate off the current snapshot; empty staging produces an informational-only card | Normal run; next night has prior state |
| **Prior run still alive** (overlap) | `RunLock.acquire` finds live `{pid,bootId,startTime}` triple | **Abort + alert**; never run two nights concurrently | Next cron tick; or operator clears after investigating |
| **Stale lock from a crashed run / PID reuse** (CSO-H6) | Recorded triple does not resolve to a live job process | **Reclaim safely**: only the PID-reuse-safe triple mismatch reclaims; a recycled unrelated PID never satisfies the triple, so the lock is not blindly stolen | Lock reacquired; run proceeds |
| **Lock held too long** (CSO-H6) | Held past `maxHeldMs` | **Alert (`held_too_long`)**, do not auto-steal | Operator inspects the hung run before any manual reset |
| **Least-privilege context violated** — prod creds present or egress beyond backup remote (CSO-H6) | Startup assertion on env + egress allowlist | **Fail-closed**: abort the run before any stage | Fix the cron/job context to least-privilege; rerun |
| **Memory / resurrection-guard unavailable** (03 down) | Guard/indexer call errors | **Fail-closed**: no commit, no reindex; consolidation candidates held in staging only | Retry next night; live brain unchanged |
| **Provider Routing / generator unavailable** (09 down) | Batch endpoint error/timeout | **Degrade**: skip stages 2–3 (no drafts); stages 1, 4, 5 still run; card notes consolidation skipped | Next night when provider returns |
| **Judge model unavailable** (different provider down) | Judge call error/timeout | **Degrade, fail-safe**: candidates that passed validators+guard are **held unjudged** in staging, never auto-accepted | Judge returns next night; nothing promoted unjudged |
| **Input classifier / quarantine unavailable** (CSO-M5) | Classifier call errors before judge read | **Fail-closed for the judge step**: judge is not invoked on un-quarantined diff; candidates held | Classifier returns; judge runs next night |
| **Generator emits `is_human_confirmed`** (CSO-C3) | Pre-staging strip pass | **Strip + log**: field removed; op kept as a plain proposal | None needed; flag can only be set by a human tap |
| **Resurrection attempt at consolidation commit** (ADR-0023/0030) | Guard match (tombstone / forget-list / human-confirmed delete) on ADD/UPDATE | **Block**: op routed to "Tried to resurrect — review" card section, never silently passed to judge or committed | Human re-adds by hand if truly intended |
| **Resurrection attempt at reindex/promotion** (ADR-0030) | Guard re-run before reindex on the promotion path | **Block this item**: no commit, no reindex; routed to human review | Human review; rest of batch proceeds |
| **Staging swap between judge-accept and promotion (TOCTOU)** (CSO-H6, ADR-0029) | `hashAtPromote != hashAtAccept` | **Abort the item**: no promotion, route to human review | Re-stage, re-judge, re-approve |
| **Crash after memory txn, before git push** (Eng-7) | Commit journal reads `reindexed`, no matching git commit | **Resume at git step**: re-run git add/commit/push (idempotent) | Automatic on restart |
| **Crash during memory txn** (Eng-7) | SQLite rollback; journal stays `pending` | **Re-attempt item from start**: re-pass guard, re-do atomic txn | Automatic on restart |
| **DB integrity check fails before VACUUM** | `PRAGMA integrity_check != ok` | **Fail-closed**: skip VACUUM/optimize; snapshot retained; report on card | Operator inspects DB from snapshot |
| **Git push fails** (network / non-fast-forward) | Push returns error / rejected | **Non-fatal**: retry, then **always report** on card; never `--force` | Operator resolves; backup retried next night |
| **Human never opens the card** | No approval tap by next run | **Hold (safe default)**: no memory edit, no skill change applied; agent keeps yesterday's brain | Card persists; approve later |
| **Verification miss** — claimed effect has no trace (ADR-0017) | Trace probe fails (file/row/size/ref) | **Report as a card line item**, do not paper over | Operator inspects; effect re-attempted next night |

## 8. Security & threat model

Threats mapped to deterministic mitigations. "Code" means enforced 100% here or by the
component it delegates to; "Model" means advisory and never load-bearing.

| Threat (STRIDE / OWASP-LLM) | Deterministic mitigation | Enforced by |
|---|---|---|
| **Nightly cron over-privileged; egress beyond backup; lock TOCTOU / PID-reuse** (CSO-H6) | Run least-privilege: no prod creds in env, egress allowlist = backup remote only, asserted at startup. PID-reuse-safe lock token `{pid, bootId, startTime, nonce}` replaces bare PID-liveness; lock held past `maxHeldMs` alerts instead of blind-stealing | Code |
| **Staging swap between judge-accept and human-approve (TOCTOU)** (Tampering; CSO-H6, ADR-0029) | Each staged patch hashed at judge-accept; promotion re-verifies `hashAtPromote == hashAtAccept` before applying; mismatch aborts to human review — the approved artifact is byte-identical to the judged one | Code |
| **Untrusted input mints/permanently-deletes a human-confirmed fact via `is_human_confirmed`** (Spoofing/Tampering; OWASP LLM03; CSO-C3, ADR-0029) | Any `is_human_confirmed` (or trust/permanence) field on generator/judge output is stripped before staging; the flag is set **only** by Safety's approval handler on a real human tap on a hash-pinned diff with nonce + step-up | Code |
| **Forgotten/tombstoned fact crawls back at commit** (Memory poisoning; OWASP LLM03; ADR-0023) | Resurrection-guard runs at consolidation commit on every ADD/UPDATE; a tombstone / forget-list / human-confirmed-delete match is **blocked to human review**, never passed to the judge or committed | Code |
| **Forgotten fact re-enters at reindex / promotion / rebuild** (Memory poisoning; ADR-0030) | The guard re-runs on every reindex and on the promotion path, not only at consolidation commit; no write/reindex path promotes a searchable fact while bypassing it | Code |
| **Judge reads untrusted day-log diff and is steered by an injection** (OWASP LLM01; CSO-M5, ADR-0028) | The diff passes the input classifier/quarantine **before** the judge reads it; the judge sees only the quarantined artifact + diff, never raw day-log text and never the generator CoT | Code (quarantine) + Model (advisory) |
| **Judge "accept" used to bypass deterministic checks** (CSO-M5) | Validators (`refs_exist`, `no_conflicts`, `dry_run_ok`, `has_check_section`) and the resurrection-guard run **before** and **independently of** the judge; a judge `accept` cannot un-fail a validator or un-block the guard | Code |
| **Closed evaluation loop — generator grades its own work** (ADR-0016) | Separate judge, different model/provider, sees only the final artifact + diff (no CoT); deterministic validators gate first so the judge never sees malformed candidates | Code (validators) + Model (independent judge) |
| **Model claims an effect it did not perform** (Repudiation; ADR-0017) | Trace-based self-verification: archived ⇒ file at content-addressed hash; deleted ⇒ row `invalid_at != NULL` **and** absent from FTS5; vacuumed ⇒ size delta + `integrity_check = ok`; pushed ⇒ remote ref advanced. A claim with no trace is a card line item | Code |
| **Unattended maintenance destroys data irreversibly** (Destruction; ADR-0012) | Pre-VACUUM DB snapshot taken first; ops restricted to Safety's carve-out allowlist; `--force` push forbidden; `HARD_DENY` active at night; no skip-permissions | Code (Safety 05) |

What the model is trusted with at night: drafting candidate facts/skills and grading a
quarantined diff. What it is **never** trusted with: setting a trust/permanence flag, deciding
to commit/delete/prune/push, un-failing a validator, or overriding the resurrection-guard.

## 9. Acceptance criteria (mandatory)

Each criterion is a single objectively verifiable assertion for a Phase-3 test.

1. **AC-10-1** — A completed session transcript is written to
   `archive/sessions/<date>/<session-id>.md` at its content-addressed path; re-running the
   night does not double-write (the file hash and path are unchanged). (§3 archival, ADR-0017)
2. **AC-10-2** — A normalized day-log record whose content matches a `do_not_remember` entry is
   absent from the log handed to the generator (filtered at ingestion, before the generator runs).
   (ADR-0023, ADR-0030)
3. **AC-10-3** — The generator runs against the batch endpoint resolved by Provider Routing and
   reads only live facts (`invalid_at IS NULL`); a tombstoned fact is not in its input fact set.
   (ADR-0016, ADR-0018)
4. **AC-10-4** — A candidate that fails any deterministic validator (`refs_exist`, `no_conflicts`,
   `dry_run_ok`, `has_check_section`) is dropped and is never passed to the judge (the judge call
   for that candidate is not made). (CSO-M5, ADR-0016)
5. **AC-10-5** — The validators and the resurrection-guard execute **before** the judge in the
   pipeline; a judge `accept` returned for a candidate that failed a validator or was blocked by
   the guard does not result in a staged patch. (CSO-M5, ADR-0016)
6. **AC-10-6** — The judge runs on a different model/provider than the generator and receives only
   the final artifact + diff; the generator's chain-of-thought is absent from the judge input.
   (ADR-0016)
7. **AC-10-7** — The diff handed to the judge has passed the input classifier/quarantine; an
   injection payload embedded in the day-log diff is quarantined/flagged before the judge reads it,
   and the judge is not invoked on un-quarantined diff text. (CSO-M5, ADR-0028)
8. **AC-10-8** — A generator/judge output carrying `is_human_confirmed` (or any trust/permanence
   field) has that field stripped before staging; the staged artifact does not contain it. (CSO-C3,
   ADR-0029)
9. **AC-10-9** — `is_human_confirmed` on a promoted fact is set only by Safety's approval handler in
   response to a real human tap; no nightly code path (generator, judge, validator, promotion) sets
   it. (CSO-C3, ADR-0029)
10. **AC-10-10** — An `ADD`/`UPDATE` candidate whose `FactKey` matches a tombstone, a
    `do_not_remember` entry, or a human-confirmed deletion is blocked by the resurrection-guard at
    consolidation commit, surfaced under "Tried to resurrect — review", and is not passed to the
    judge or staged. (ADR-0023, ADR-0030)
11. **AC-10-11** — The resurrection-guard re-runs on the promotion/reindex path: an approved patch
    that would re-introduce a tombstoned/forget-listed fact is blocked before reindex, routed to
    human review, and not committed. (ADR-0030)
12. **AC-10-12** — A paraphrased re-wording of a forgotten fact (same `(entity, relation, object)`
    equivalence class, different surface text) is caught by the guard and blocked, not committed.
    (ADR-0030)
13. **AC-10-13** — Each staged patch carries a `hashAtAccept` computed at judge-accept; at promotion,
    a patch whose `hashAtPromote` differs from `hashAtAccept` aborts that item and routes it to human
    review with no commit (TOCTOU swap blocked). (CSO-H6, ADR-0029)
14. **AC-10-14** — Stages 2 and 3 write only under `staging/`; after a night run with no human
    approval, the live memory tables, live FTS5 index, `constitution.md`, and `skills/` directory are
    byte-unchanged from before the run. (ADR-0016, §8 hold-default)
15. **AC-10-15** — On the promotion path the memory transaction is atomic: the `invalid_at` flip /
    row insert and the FTS5 reindex commit in a single SQLite transaction, and the git commit/push
    runs only after that transaction is durably committed. (Eng-7)
16. **AC-10-16** — Crash injected after the memory transaction commits but before the git push: on
    restart the job finds the commit journal at `reindexed` with no matching git commit and resumes at
    the git step; the final state has the row flipped, the index reindexed, and exactly one git commit
    (no double-apply). (Eng-7)
17. **AC-10-17** — Crash injected during the memory transaction: on restart the row is not flipped, the
    FTS5 index is unchanged, the journal reads `pending`, and the item is re-attempted from the start,
    re-passing the resurrection-guard. (Eng-7)
18. **AC-10-18** — The nightly job's runtime context has no production credentials in its environment
    and its egress allowlist permits only the backup remote; a startup assertion fails closed (run
    aborts before stage 1) if either is violated. (CSO-H6)
19. **AC-10-19** — The run lock uses a PID-reuse-safe token `{pid, bootId, startTime, nonce}`: a
    recycled PID belonging to an unrelated process does not satisfy the triple and the prior lock is
    not stolen; a second concurrent night aborts with an alert. (CSO-H6)
20. **AC-10-20** — A lock held past `maxHeldMs` raises `night.lock.held_too_long` and is not
    auto-stolen; the run does not proceed to steal it without operator action. (CSO-H6)
21. **AC-10-21** — When the judge model is unavailable, candidates that passed the validators and the
    resurrection-guard are held unjudged in staging and are never auto-accepted or promoted. (§7,
    ADR-0016)
22. **AC-10-22** — When Memory/resurrection-guard is unavailable, no commit or reindex occurs and no
    staged patch is promoted (fail-closed). (§7, ADR-0030)
23. **AC-10-23** — A skill drafted from a single transient failure (transient provenance) is flagged
    for retirement on the card and is not auto-promoted; a skill draft missing its verification section
    fails `has_check_section` and is dropped before the judge. (ADR-0016)
24. **AC-10-24** — DB/disk hygiene takes the pre-VACUUM DB snapshot before `VACUUM`/`optimize`/prune
    runs; a `--force` git push is denied; these ops run only within Safety's carve-out allowlist. (§6,
    ADR-0012)
25. **AC-10-25** — A failed git push is non-fatal to the run, is retried, and is reported on the morning
    card's backup-status section; it is never silently swallowed and is never resolved with `--force`. (§7)
26. **AC-10-26** — Trace-based verification produces a card line item when a claimed effect has no trace:
    archived ⇒ file present at content-addressed hash; deleted ⇒ row `invalid_at != NULL` and absent from
    an FTS5 query; vacuumed ⇒ size delta and `PRAGMA integrity_check = ok`; pushed ⇒ remote ref advanced
    to the new commit hash. A claim with no matching trace is reported, not accepted. (ADR-0017)
27. **AC-10-27** — Cold start (first ever run): the job acquires a fresh lock, completes all stages, and
    produces an informational-only morning card when staging is empty, without error. (§7 cold start)
28. **AC-10-28** — When the human never approves, the next session's frozen snapshot is identical to the
    prior one for every held item (no memory edit and no skill change applied on silence). (§8
    hold-default, ADR-0007)
29. **AC-10-29** — When Stage 2b runs and finds an orphaned `working/*.md` page, a remediation proposal
    appears in `staging/` and is not auto-promoted to live memory. (§5 Stage 2b)
30. **AC-10-30** — When Stage 2b finds a broken typed relationship edge (`supersedes`/`contradicts`/`extends`
    referencing a missing `fact_key`), the morning card lists it and no silent data loss occurs. (§5 Stage 2b)
31. **AC-10-31** — When the generator is unavailable during Stage 2b, the nightly run completes and the
    morning card contains the text "lint pass skipped". (§5 Stage 2b)
32. **AC-10-32** — after a backup push, a read-back verification confirms the pushed ref equals local
    HEAD; a mismatch/failure is reported on the morning card and never silently ignored.
33. **AC-10-33** — a restore from the backup remote reconstructs the SQLite index and re-applies the
    forget-list invariant, so a previously forgotten fact does not reappear post-restore. *(ADR-0030)*
34. **AC-10-34** — a manual `/consolidate` trigger runs the same generator→judge→staging pipeline and
    lands output in the staging gate, never auto-promoted. *(spec 13)*
35. **AC-10-35** — a consolidation edit that would drop a load-bearing ("canary") fact is rejected by
    the deterministic validator before the judge sees it (the judge call for that candidate is not made),
    alongside the existing resurrection-guard; an edit that preserves all canary facts proceeds normally.

## 10. Open questions

- **Trust gradient / auto-commit for low-risk categories.** ADR-0016 defers a trust gradient where
  low-risk categories (formatting, annotation tweaks) may auto-commit after a clean track record;
  irreversible/safety-touching categories never do. Deferred to a later milestone.
- **Tombstone archival bound.** ADR-0023 notes soft-deleted, long-invalid, non-human-confirmed rows
  accumulate and are bounded by periodic archival; the exact archival cadence/threshold is owned by
  Memory (03), not this spec.
- **Vector-plugin forget contract at night.** ADR-0030 requires every derived index (including the
  optional vector plugin) to enforce the `invalid_at`/`do_not_remember` exclusion; the v0.2 hardening
  of that contract during nightly reindex is deferred (ADR-0030 §v0.1 scope).

## 11. References

- ADRs:
  - [ADR-0016 — Generator + separate judge for self-learning](../decisions/2026-06-11-generator-judge-self-learning.md)
  - [ADR-0017 — External verification by real traces](../decisions/2026-06-11-external-verification-by-traces.md)
  - [ADR-0023 — Durable forgetting: tombstones + forget-list + bi-temporal](../decisions/2026-06-11-durable-forgetting-tombstones.md)
  - [ADR-0029 — Human-confirmation provenance and approval integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
  - [ADR-0030 — Forgetting invariant holds on every index and write path](../decisions/2026-06-11-forgetting-invariant-all-index-paths.md)
- Concept docs:
  - [Nightly consolidation](../concepts/nightly-consolidation.md)
  - [Memory system](../concepts/memory-system.md)
  - [Safety layer](../concepts/safety-layer.md)

# ADR-0053: Proactivity — In-Process Scheduler & Nightly Generator/Judge

**Status:** Accepted
**Date:** 2026-06-22
**Tags:** proactivity, nightly, triggers, scheduler
**Related:** [ADR-0038](./2026-06-12-triggers-and-proactivity.md), [ADR-0033](./2026-06-11-llmwiki-pattern-borrow.md), [ADR-0030](./2026-06-11-forgetting-invariant-all-index-paths.md), [ADR-0050](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md)

## Context

ADR-0038 designed the triggers and proactivity component and ADR-0050 deferred wiring
it live until "when the real multi-agent runtime exists." After Tier-3 (ADR-0052), that
condition is met. The nightly consolidation runner (`ConsolidationRunner`) and trigger
engine (`TriggerEngine`) were fully built and tested — 34 nightly tests and 14 trigger
tests — but dormant: not exported from the `@aisy/core` barrel, not wired into the live
`aisy run` binary, and lacking a scheduler to call them.

Two gaps remained beyond wiring: (1) no scheduler to tick the trigger engine or fire the
nightly at the right time, and (2) the `NightlyGenerator` and `NightlyJudge` were typed
stubs — the LLM adapter layer that proposes and grades `MemOp`s had to be implemented
for nightly consolidation to do real work.

The agent loop and `@aisy/core` type contracts were intentionally left untouched. The
only additive Core change is `Memory.listLive()`, which enumerates current facts for the
generator's input.

## Decision

Wire Aisy's proactivity live in four coordinated parts.

### 1. In-process scheduler with missed-slot catch-up

A `setInterval` loop inside `aisy run` ticks `TriggerEngine.tick()` every minute and
evaluates whether the nightly consolidation slot is due. "Due" means: the configured
local-time window has passed today and no `~/.aisy/nightly-last.json` marker for today
exists. When due, the consolidation runs immediately; on completion the marker is
written.

A process that starts *after* the configured slot also runs the nightly on startup
(missed-slot catch-up), so a brief downtime does not silently skip a day's
consolidation. A process that is *always* down never consolidates — this is acceptable
for a single-user phone harness where persistent downtime is visible to the operator.

No external `crontab` or system scheduler is used. The scheduler lives entirely inside
the process.

### 2. Bot proactive seam

`makeTelegramBot` now returns `{ bot, runProactiveTurn, sendProactive }`. The scheduler
and trigger engine call these handles to inject a proactive turn or push a message
without the bot waiting for an inbound operator message.

A proactive turn reuses the full agent runner and all existing safety gates unchanged.
Content woken by a `watch` trigger enters the turn stamped `untrusted` (capability
narrowing from ADR-0027 applies); the woken turn's tool set is correspondingly
narrowed.

### 3. Nightly Generator/Judge as LLM adapters with defensive parsing

The `NightlyGenerator` (routed to the routine tier) proposes a list of `MemOp`s as
strict JSON from two inputs: the day's session log and the current live fact set
returned by `Memory.listLive()`. The `NightlyJudge` (routed to a *different* tier;
sees only the generator artifact, not the raw log) grades each proposed op.

Both adapters parse defensively:

- Generator: extract-first-JSON-array, validate each element, drop malformed items,
  cap total count, wrap bare strings as structured `FactKey`, retry once on parse
  failure.
- Judge: unparseable judge response → reject the entire batch (fail safe). Unparseable
  generator response → stage nothing.

`draftSkills` returns `[]` in v1; skill drafting is a follow-up.

### 4. Staging discipline preserved

The nightly run only *stages* operations to disk. The morning card is informational.
Promotion to live memory happens exclusively when the operator taps Approve on a
morning-card item → `approveStagedItem`, which re-runs the TOCTOU check and the
resurrection guard before writing. A DELETE is recorded as human-confirmed at that
moment (the Approve tap is the confirmation). Only items that passed the judge receive
an Approve button. Promotion applies the approved op to live memory through a
`commitOp` port on `ConsolidationDeps` (the app wires it to `memoryStore.commit`/`forget`
via `memOpToMemoryOp`, then reindexes the resulting fact id); `commitOp` is reachable
ONLY from `approveStagedItem`, after the judge-gate + TOCTOU + resurrection-guard.
The runner is a single bin-scope instance so its in-memory staging persists across
stage → /staging → Approve.

## Consequences

- **Positive:** Aisy becomes proactive — reminders, schedules, watches, and nightly
  memory consolidation all operate live. The operator needs no crontab; everything is
  self-contained in the process. Missed slots self-heal on next boot. The staging gate
  and safety properties from ADR-0029/ADR-0038 are preserved by construction.
- **Positive:** The journal sink (`append(source, kind, payload)` → `~/.aisy/journal.jsonl`)
  replaces the memory `emitEvent` no-op and gives nightly and triggers a durable event
  feed. Payloads carry ids, counts, and event names only — no secrets.
- **Neutral:** A new marker file (`~/.aisy/nightly-last.json`) and journal file
  (`~/.aisy/journal.jsonl`) are added to the home state. The `@aisy/core` barrel gains
  `Memory.listLive()` (additive; all existing tests stay green).
- **Negative:** A process that is always down never consolidates. The per-trigger and
  global background budgets require operator tuning to avoid runaway costs on
  high-frequency watches. The judge==generator single-provider fallback is not yet
  implemented (follow-up).

## Follow-ups

The following are explicitly deferred and do not block this decision:

- Real `draftSkills` (currently returns `[]`).
- Live fact freshness — the nightly's facts + validators are captured at process boot
  (a long-running process consolidates only facts known at boot until restart); a
  facts-thunk for per-run freshness is a follow-up.
- Full hash-chained, redacting AuditLog (Component 12) — the JSONL journal is
  an interim observability layer.
- SQL watch probes (phase-1 probe set: file/http/exit shipped; sql deferred).
- An agent `propose_trigger` tool — the confirmation path exists but no tool
  emits it in v1.
- Nightly git/hygiene/archive effect seams — omitted in v1; the consolidation
  runner uses safe defaults.
- Judge==generator single-provider fallback (when only one provider is configured).
- The `/watch http:https://…` double-scheme UX rough edge.

## Alternatives considered

**External system cron (crontab / systemd timer).** Rejected. Crontab requires a
separate ops step during setup, introduces a separate process path that diverges from
in-process error handling, and breaks the self-contained single-process model chosen
for a phone harness. The operator chose in-process + missed-slot catch-up.

**Deferring the nightly LLM generator to a later tier.** Rejected. Without a real
generator/judge, nightly consolidation stages nothing useful. The operator chose to
implement the full Tier-4 arc now.

**Sequential trigger evaluation.** Not applicable — concurrent probe evaluation with
per-trigger budget caps is already in the trigger engine design from ADR-0038.

## References

- Spec: [10 Nightly Consolidation](../specs/10-nightly-consolidation.md)
- Spec: [14 Triggers & Proactivity](../specs/14-triggers-and-proactivity.md)
- Supersedes (wires live): [ADR-0038](./2026-06-12-triggers-and-proactivity.md)
- [ADR-0033](./2026-06-11-llmwiki-pattern-borrow.md) — nightly lint pass pattern
- [ADR-0030](./2026-06-11-forgetting-invariant-all-index-paths.md) — forget-filter on every write path
- [ADR-0050](./2026-06-16-multi-provider-catalog-and-per-agent-budget.md) — per-agent budget and provider catalog
- [ADR-0052](./2026-06-19-live-subagent-runner-seam-and-safety.md) — live multi-agent runtime (prerequisite)
- Plan: [`docs/superpowers/plans/2026-06-22-tier4-proactivity.md`](../superpowers/plans/2026-06-22-tier4-proactivity.md)

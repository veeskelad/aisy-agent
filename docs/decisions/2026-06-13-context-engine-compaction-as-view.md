# ADR-0040: Context Engine — Compaction as a View, Not a Destructive Write

**Status:** Proposed
**Date:** 2026-06-13
**Tags:** context, memory, observability, architecture

## Context

Aisy has a durable, cross-session substrate — file-based memory (03), a frozen
per-session Level-1 snapshot (ADR-0007), and an append-only hash-chained journal
(12). What it lacked was **within-session context-window management**: when a
single session/task runs long, nothing in the spec curates the live token window
or recovers it as it fills. A long session would hit context rot (attention
degradation, budget overflow) with no specified response.

The "98% Problem: Harness Engineering Survey" (BeConfident, 2026-06-12) names
this the field's most under-built subsystem ("Context Engine") and states its
sharpest rule:

> "Append-only state, projection at read time — compaction is a view, not a
> write." … "Compaction-as-truncation: chopping history destroys architectural
> decisions and unresolved bugs." … "Tune for recall, then trim."

The naive fix — truncating or destructively summarizing the transcript — is
exactly what the survey (and Aisy's own audit of competitors) flags as a top
failure: it erases unresolved bugs and design decisions, and it would also break
Aisy's audit guarantee (the journal must be the complete, immutable trace).

## Decision

Add **component 15 (Context Engine)** that manages the live window by
**projection over an append-only transcript** — compaction produces a *view*,
never a destructive write:

- The transcript of record is the Observability (12) journal (monotonic seq,
  prevHash). The Context Engine never UPDATEs or DELETEs it.
- `assemble(session)` returns a view: `[pinned Level-1 prefix] + [compacted
  middle (summary segments)] + [recent verbatim tail]`, choosing the **cheapest**
  of five escalating tiers that fits the budget: `none → snip → micro → collapse
  → auto`.
- Trimming is **recall-first**: entries flagged load-bearing (unresolved bug,
  open decision, pending TODO, current task) survive while non-load-bearing noise
  remains to shed.
- The model only **drafts** a summary's prose (like the nightly generator); it
  never decides what to drop, never deletes the trace, never relabels provenance.
  A summary inherits the strictest provenance of its sources — compaction cannot
  launder `untrusted` content into trusted context (ADR-0027).
- The pinned Level-1 prefix is never compacted; the ≤4 KV-cache breakpoints
  (ADR-0019) are re-established after each projection.

Scope: **spec + ADR + AC tests now; implementation v0.2.** This is a *complement*
to Memory (03), not a replacement — Memory is durable cross-session facts; the
Context Engine is the short-horizon live window.

## Consequences

- **Positive:** long sessions stay inside budget without losing the thread; the
  full trace remains in the journal for debug/audit/compliance (compaction can
  never erase an incriminating action); Aisy gains the one Survey subsystem it
  was missing while keeping its append-only and provenance guarantees.
- **Neutral:** a fifteenth component; `assemble` adds a summarizer model call on
  compaction (billed/capped via Provider 09); the journal becomes the explicit
  transcript-of-record for the live window, not only the audit log.
- **Negative:** summary *prose* is model output (~70%) — recall-first selection
  mitigates but a bad summary can still under-serve a turn (bounded by keeping
  load-bearing entries and the recent tail verbatim); compaction adds latency at
  the budget threshold.

## Alternatives considered

- **Destructive truncation / summarize-in-place.** Rejected: the survey's named
  anti-pattern; destroys unresolved bugs and decisions, and breaks Aisy's
  immutable-trace/audit guarantee.
- **Rely on Memory (03) only.** Rejected: Memory is durable cross-session facts,
  not the running transcript; it cannot keep an in-progress task's working
  context coherent and does not address window budget within a session.
- **No within-session management (status quo).** Rejected: leaves context rot
  unhandled — the exact gap the audit surfaced.

## References

- Spec: [15 Context Engine](../specs/15-context-engine.md)
- Related ADRs: [ADR-0019 Stable-prefix KV-cache](./2026-06-11-stable-prefix-kv-cache.md), [ADR-0007 Frozen memory snapshot](./2026-06-11-frozen-memory-snapshot.md), [ADR-0023 Durable forgetting](./2026-06-11-durable-forgetting-tombstones.md), [ADR-0027 Capability narrowing](./2026-06-11-capability-narrowing-untrusted-context.md), [ADR-0039 Sub-agent delegation](./2026-06-12-first-class-subagent-delegation.md)
- Prior art: "The 98% Problem: Harness Engineering Survey" (BeConfident, 2026-06-12); `memory/harness-survey-mapping.md`

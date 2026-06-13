# Component 15: Context Engine — Specification

**Status:** Draft (implementation scheduled for v0.2)
**Component:** 15 / 15
**Related ADRs:** ADR-0040, ADR-0019, ADR-0007, ADR-0017, ADR-0027
**Depends on:** Core / Agent Loop (01), Memory (03), Observability & Verification (12)

> The Context Engine is the deterministic curator of the *within-session* token
> window: it assembles the smallest high-signal context for each turn and, when
> the running transcript outgrows the budget, **projects** it down to a compacted
> view — never destroying the underlying trace. Compaction is a read-time view,
> not a write.

## 1. Purpose

Memory (03) is durable, cross-session, and file-based. The Context Engine is its
short-horizon complement: it governs what occupies the live context window
*during one session/task* and how a long-running transcript is kept inside the
budget without losing the thread. The competitive Harness Survey names this the
field's most under-built subsystem and its sharpest design rule:

> "Append-only state, projection at read time — compaction is a view, not a
> write." … "Compaction-as-truncation: chopping history destroys architectural
> decisions and unresolved bugs." … "Tune for recall, then trim."

Aisy already had the durable substrate (append-only journal, frozen snapshot,
four-level memory) but **no within-session compaction pipeline** — a long session
would hit context rot with no specified recovery. This component closes that gap
([ADR-0040](../decisions/2026-06-13-context-engine-compaction-as-view.md)).

The code/model split is sharp:

- **Deterministic code (100%):** the append-only transcript, the budget
  thresholds and tier escalation, the *projection* (which segments are pinned,
  summarized, or kept verbatim), the invariant that the full trace is never
  mutated, provenance preservation across compaction, and re-establishing the
  ≤4 KV-cache breakpoints (ADR-0019) after a projection.
- **The model (~70%):** drafts the *prose* of a summary segment during a
  compaction pass (exactly as the nightly generator drafts, never commits). It
  never decides what to drop, never deletes a transcript entry, and never
  relabels provenance.

## 2. Responsibilities

What the Context Engine **owns**:

- The **append-only session transcript** — every turn (spans, tool calls,
  observations) appended, never edited or truncated. The transcript of record is
  the Observability (12) journal; the Context Engine holds the working index
  into it and writes through to it.
- **Layered compaction** (escalating, cheapest first), the Aisy analog of the
  survey's five tiers: (1) **budget check** — do nothing while under threshold;
  (2) **snip** — drop redundant/echoed tool output; (3) **micro-compact** —
  summarize the oldest individual tool result that is no longer load-bearing;
  (4) **collapse** — summarize a contiguous block of resolved turns into one
  summary segment; (5) **auto-compact** — project the whole middle into a
  recall-first summary, keeping the pinned prefix and the most-recent turns
  verbatim.
- **Projection-at-read** — `assemble(turn)` returns a *view*: `[pinned prefix] +
  [compacted middle (summary segments)] + [recent verbatim tail]`. The view is a
  pure function of `(transcript, tier)`; the transcript itself is untouched.
- **Recall-first trimming** — what survives compaction is chosen to preserve
  unresolved bugs, open decisions, pending TODOs, and the current task framing
  ("a summary that drops an unresolved bug costs you the task"); pure formatting
  noise is shed first.
- **Pinned segments** — the frozen Level-1 prefix (ADR-0007/0019) is *never*
  compacted; the Context Engine re-establishes the ≤4 cache breakpoints after
  any projection so the KV-cache contract holds.
- **Provenance preservation** — a compacted/ summarized segment that contained an
  `untrusted` span stays `untrusted`; compaction can never launder untrusted
  content into trusted context (ADR-0027).

What it **does not** do (boundary → owner):

- It does **not** own durable facts or cross-session retrieval — that is
  **Memory (03)**. The Context Engine summarizes the *running transcript*, not
  the fact store; a durable fact is promoted by Nightly (10), not by compaction.
- It does **not** own the audit log — the full, immutable trace lives in the
  **Observability (12)** journal; the Context Engine reads/writes through it and
  relies on it for the "view, not a write" guarantee.
- It does **not** assemble the immutable Level-1 prefix bytes or place cache
  breakpoints from scratch — that is **Core (01)** (ADR-0019); the Context
  Engine consumes the frozen prefix and only re-pins breakpoints post-projection.
- It does **not** gate tools or compute provenance — Tools (04) / Safety (05).

## 3. Interfaces

```ts
// illustrative, not binding

type SegmentKind = 'pinned' | 'verbatim' | 'summary'
type Provenance = 'operator' | 'untrusted'

interface TranscriptEntry {
  seq: number                 // monotonic, matches the Observability journal seq
  role: 'system' | 'user' | 'assistant' | 'tool'
  provenance: Provenance
  text: string
  loadBearing?: boolean       // unresolved bug / open decision / pending TODO — recall-first
}

interface ContextSegment {
  kind: SegmentKind
  provenance: Provenance       // a summary inherits the strictest provenance of its sources
  text: string
  coversSeq: [number, number]  // the transcript range this segment projects
}

interface CompactionView {
  segments: ContextSegment[]   // [pinned] + [summary…] + [verbatim tail]
  breakpoints: number[]        // ≤4, re-established post-projection (ADR-0019)
  tier: CompactionTier
  tokensEstimated: number
}

type CompactionTier = 'none' | 'snip' | 'micro' | 'collapse' | 'auto'

interface ContextEngineDeps {
  /** Append-only transcript of record (Observability 12). */
  journalAppend(entry: TranscriptEntry): void
  journalRead(sessionId: string): TranscriptEntry[]
  /** The frozen Level-1 prefix from Core/Memory — pinned, never compacted. */
  pinnedPrefix(): { text: string; breakpoints: number[] }
  /** Token budget for the live window. */
  budget: { windowTokens: number; compactAtFraction: number /* e.g. 0.8 */ }
  /** Drafts a recall-first summary of a transcript range; never mutates the trace. */
  summarize(entries: TranscriptEntry[]): Promise<string>
  estimateTokens(text: string): number
}

interface ContextEngine {
  /** Append a turn to the transcript of record (write-through). */
  record(entry: Omit<TranscriptEntry, 'seq'>): void
  /** Project the transcript to the smallest recall-first view under budget. */
  assemble(sessionId: string): Promise<CompactionView>
  /** Current tier without re-projecting (introspection / `/context`). */
  currentTier(sessionId: string): CompactionTier
}
```

Events emitted (12): `context.assembled`, `context.compacted` (with tier +
`coversSeq` ranges), `context.budget_exceeded`. Consumed: the frozen prefix from
Core (01), the journal from Observability (12).

## 4. Data structures

**Append-only transcript** (§3) — the entries are the Observability journal rows
(same monotonic `seq`, same prevHash chain). The Context Engine never issues an
UPDATE or DELETE against them; a compaction produces *new* `ContextSegment`
objects that reference ranges, leaving the rows intact. This is the load-bearing
invariant: the full trace is always reconstructable for debug/audit even after
the live window has been compacted many times.

**Compaction tiers** (escalating; the engine applies the cheapest that fits):

| Tier | Action | Reversible? (trace intact) |
|---|---|---|
| `none` | under budget — verbatim | n/a |
| `snip` | drop echoed/duplicate tool output from the view | yes |
| `micro` | summarize one stale, non-load-bearing tool result | yes |
| `collapse` | summarize a contiguous block of resolved turns | yes |
| `auto` | project whole middle to a recall-first summary; pinned prefix + recent tail verbatim | yes |

Every tier is a **view** — `journalRead` always returns the full trace.

**Recall-first selection** — `loadBearing` entries (unresolved bug, open
decision, pending TODO, current task statement) are preserved verbatim or
summarized last; the engine trims formatting/echo noise first. A summary segment
inherits the **strictest** provenance of the entries it covers (any `untrusted`
source → the summary is `untrusted`).

## 5. Behavior & control flow

```
record(turn)  -> journalAppend(seq++)            -- append-only, write-through

assemble(sessionId)
  entries = journalRead(sessionId)
  est = estimateTokens(pinnedPrefix + entries)
  if est <= budget.windowTokens * compactAtFraction:
      tier = 'none'  -> view = pinned + all verbatim
  else escalate cheapest-first until est fits:
      snip -> micro -> collapse -> auto
      (each higher tier summarizes more of the OLD middle via summarize(),
       always keeping pinned prefix + most-recent tail verbatim,
       always preserving loadBearing entries and provenance)
  re-establish <=4 cache breakpoints over the projected view   -- ADR-0019
  emit context.compacted{tier, coversSeq[]}
  return view   -- a projection; the transcript is unchanged
```

Invariants, all in code:

- **No destructive write.** `assemble` and every tier only read the transcript
  and emit segments; a post-compaction `journalRead` returns the identical full
  trace (AC-15-2).
- **Determinism.** Given the same `(transcript, tier)` the projected segment
  boundaries are identical (the summary *prose* may vary with the model, but the
  *structure* — what is pinned/collapsed/kept — is deterministic).
- **Recall-first.** A `loadBearing` entry is never dropped while non-load-bearing
  content remains to trim (AC-15-4).
- **Provenance survives.** An `untrusted` source forces an `untrusted` summary;
  narrowing (ADR-0027) computed over the *view* matches narrowing over the full
  transcript (AC-15-6).
- **Pinned prefix is sacrosanct** and breakpoints are re-pinned post-projection
  so the KV-cache contract (ADR-0019) holds across a compaction (AC-15-7).

## 6. Dependencies

Internal: Core (01) — frozen prefix + the turn loop that calls `assemble`;
Memory (03) — durable facts (separate concern; compaction never promotes a
fact); Observability (12) — the append-only journal that IS the transcript of
record and the audit surface.

External: the configured provider (via Provider Routing 09) for the
`summarize()` draft call — billed and capped like any model call.

## 7. Failure & degraded modes (mandatory)

| Failure | Trigger | Detection | Behavior | Recovery |
|---|---|---|---|---|
| Summarizer (model) unavailable | `summarize()` errors/timeouts | call wrapper | **Degrade to cheaper tier** (snip/micro) using deterministic trimming only; if still over budget, keep pinned + most-recent verbatim and drop oldest *non-load-bearing* verbatim from the VIEW (trace intact); never block the turn | summarizer recovers; next assemble re-projects |
| Over budget even after `auto` | transcript huge | post-projection estimate | Keep pinned prefix + load-bearing + newest tail; surface a `context.budget_exceeded` and let the loop decide (e.g. spawn a sub-agent, ADR-0039) | sub-agent / new generation |
| Journal unavailable | Observability down | write/read error | **Fail-closed**: cannot guarantee the trace is preserved → do not compact (run verbatim if it fits, else refuse the turn) — never compact without a durable trace | journal recovers |
| Breakpoints lost after projection | re-pin step | count != ≤4 / mid-segment | recompute; if impossible, fall back to 0 breakpoints (correctness over cache hit) | next assemble |

## 8. Security & threat model

| Threat | Vector | Deterministic mitigation (code) | ADR |
|---|---|---|---|
| **Compaction launders untrusted content** | a summary of an untrusted page is treated as operator context | summary inherits the strictest source provenance; an `untrusted` source → `untrusted` summary; narrowing over the view == narrowing over the trace | ADR-0027 |
| **Audit erasure via compaction** | "compact away" an incriminating action | compaction is a VIEW; the full trace stays in the hash-chained journal — `journalRead` is unchanged | ADR-0040, spec 12 |
| **Recall-loss attack / scope shrink** | drop the unresolved bug so the task looks done | recall-first: `loadBearing` entries survive while any non-load-bearing content remains; append-only, no entry deleted | ADR-0040 |
| **Summary injection** | untrusted text steers the summarizer to emit a fake "approved" line | the summary is content, not a command; it enters as the source's (untrusted) provenance and cannot set trust flags or confirm actions (those are code paths, ADR-0029) | ADR-0027/0029 |

## 9. Acceptance criteria (mandatory)

1. **AC-15-1** — Under budget, `assemble` returns tier `none` and every transcript entry verbatim in order.
2. **AC-15-2** — After any compaction (`snip`…`auto`), `journalRead(sessionId)` returns the byte-identical full transcript — compaction never mutated the trace.
3. **AC-15-3** — When the transcript exceeds `windowTokens * compactAtFraction`, `assemble` escalates to the cheapest tier whose projection fits the budget (snip before micro before collapse before auto).
4. **AC-15-4** — A `loadBearing` entry (unresolved bug / open decision) is preserved (verbatim or in a summary) while any non-load-bearing entry remains untrimmed.
5. **AC-15-5** — The pinned Level-1 prefix is present and verbatim in every view, at every tier (never compacted).
6. **AC-15-6** — A view whose summary covers an `untrusted` source carries `untrusted` provenance on that segment; `isNarrowed(view) === isNarrowed(fullTranscript)`.
7. **AC-15-7** — After projection the view exposes ≤4 cache breakpoints (ADR-0019); a count >4 or mid-segment breakpoint is rejected/recomputed.
8. **AC-15-8** — The projection structure (which ranges are pinned/collapsed/verbatim) is deterministic for a fixed `(transcript, tier)` across two runs.
9. **AC-15-9** — When `summarize()` throws, `assemble` degrades to deterministic trimming (snip/micro), still returns a usable view, and never throws into the turn loop.
10. **AC-15-10** — When the Observability journal is unavailable, `assemble` does **not** compact (fail-closed: no compaction without a durable trace).
11. **AC-15-11** — `context.compacted` is emitted with the tier and the `coversSeq` ranges each summary segment projects, so an auditor can map a summary back to its source rows.

## 10. Open questions

- **Budget defaults** (`windowTokens`, `compactAtFraction`) are model-dependent
  and co-defined with Provider Routing (09); the spec fixes the *mechanism*, not
  the numbers.
- **`loadBearing` detection** — how an entry is flagged (heuristic vs a light
  model pass vs explicit tool annotation) is deferred; the invariant (recall-first
  survival) is fixed regardless of how the flag is set.
- **Sub-agent hand-off interaction** — whether `auto`-tier overflow should
  automatically propose a delegation (ADR-0039) or only surface
  `budget_exceeded` is left to Orchestration (11).

## 11. References

- ADRs: [ADR-0040 Context Engine / compaction-as-view](../decisions/2026-06-13-context-engine-compaction-as-view.md), [ADR-0019 Stable-prefix KV-cache](../decisions/2026-06-11-stable-prefix-kv-cache.md), [ADR-0007 Frozen memory snapshot](../decisions/2026-06-11-frozen-memory-snapshot.md), [ADR-0017 Verification by traces](../decisions/2026-06-11-external-verification-by-traces.md), [ADR-0027 Capability narrowing](../decisions/2026-06-11-capability-narrowing-untrusted-context.md)
- Specs: [01 Core](./01-core-agent-loop.md), [03 Memory](./03-memory.md), [12 Observability](./12-observability-verification.md)
- Prior art: "The 98% Problem: Harness Engineering Survey" (BeConfident, 2026-06-12) — Context Engine subsystem; `memory/harness-survey-mapping.md`

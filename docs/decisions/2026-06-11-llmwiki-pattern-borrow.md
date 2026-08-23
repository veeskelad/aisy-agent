# ADR-0033: LLMwiki Pattern Borrow — Three-Layer Structure, Typed Edges, Nightly Lint Pass

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory, architecture, contributors

## Context

Andrej Karpathy described a "LLMwiki" pattern for LLM-driven personal knowledge
bases: an immutable raw sources layer feeds a synthesized wiki layer, and a
nightly lint pass prevents wiki degradation (orphaned pages, stale claims). The
`nashsu/llm_wiki` repo implements this pattern. Several community critiques
(rohitg00, gnusupport) and the Zep/Graphiti bi-temporal literature informed this
evaluation.

Aisy's memory architecture already implements this pattern in all safety-relevant
dimensions — and exceeds it:

- **Mandatory human approval gate** — nashsu's oversight model is voluntary.
- **Durable forgetting** with bi-temporal schema, hash-chained forget-list, and
  resurrection-guard (ADR-0023).
- **Fixed contradiction priority** (human-confirmed > recency > source-authority >
  confidence) instead of floating confidence scores (ADR-0024).

The question is: what, if anything, should Aisy borrow from the pattern or the
library?

## Decision

Adopt the **structural pattern** into spec-03 (memory) and spec-10 (nightly
consolidation). Never adopt `nashsu/llm_wiki` as a dependency.

Three concrete changes made to the specs:

**1. Named three-layer structure** — Aisy's storage tiers are explicitly named in
spec-03 and GLOSSARY.md:

| Layer | Contents | Write authority |
|---|---|---|
| Raw/Immutable Input | daily logs + archive | generator read-only input |
| Wiki/Synthesized | `working/*.md` + `MEMORY.md` | generator via staging gate |
| Schema/Config | `AGENTS.md` + `constitution.md` | human only |

"Immutable" means the generator treats these files as read-only input, not that
logs are retained forever — they rotate and archive normally.

**2. Typed relationship edges** — `supersedes`, `contradicts`, and `extends` are
added as explicit YAML frontmatter fields to `working/*.md` fact records. Currently
these relationships are implicit only in the bi-temporal `invalid_at` SQLite link
(ADR-0024). Explicit frontmatter improves human-readable audit trails and
strengthens contradiction chains with zero runtime cost change.

**3. Named nightly lint pass (Stage 2b)** — Karpathy's lint step is already implied
in spec-10 Stage 2 but unnamed and without acceptance criteria. It is now explicit
as Stage 2b: checks for orphaned cross-links, missing `fact_key` neighbors, and
stale annotations. LLM-generated proposals go through the same staging gate as all
consolidation output. Degrades gracefully: if the generator is unavailable, Stage
2b is skipped and reported on the morning card.

**What is explicitly NOT borrowed:**

- **Auto-commit to live memory** (nashsu's default): violates Aisy's founding HITL
  guarantee. Every agent-authored change must pass through `staging/` and receive a
  human tap on a hash-pinned artifact before reaching live memory. This is
  architectural, not configurable.
- **Ebbinghaus time-decay forgetting**: introduces non-determinism into retention
  and can override human-confirmed permanence. Aisy's forgetting model is explicit
  and human-driven (ADR-0023).
- **Floating confidence scores** as the primary resolution mechanism: the community
  critique ("confidence is never defined") applies. ADR-0024's fixed priority order
  is cleaner and more auditable.

**Future contributor guard:** This ADR documents that Aisy's human approval gate is
**mandatory**, not optional. Contributors familiar with the upstream
llmwiki/Karpathy pattern must not assume Aisy "follows the pattern" in the
oversight model. The three-layer structure and lint pass are borrowed; the oversight
model is not.

## Consequences

- **Positive:** Named layers reduce contributor confusion about which files belong to
  which tier. Typed edges make contradiction and supersession chains readable in
  plain git diff, at zero runtime cost. Explicit Stage 2b acceptance criteria close
  the gap between spec intent and implementation — the lint pass will not be silently
  omitted.
- **Neutral:** Typed edges require a one-time migration for existing `working/*.md`
  files. The migration script must route through the indexer choke point (ADR-0030)
  to respect the forgetting invariant. Stage 2b is a new named phase; no existing
  code path is removed or changed.
- **Negative:** Stage 2b adds ~10–30% more LLM tokens to the nightly batch; this
  must be budgeted on the morning card and must degrade gracefully when the generator
  is unavailable. Explicit documentation of the pattern borrow increases surface area
  for contributors to import llmwiki auto-commit conventions — this ADR is the
  mitigation: the mandatory-gate divergence is named and resistible here.

## Alternatives considered

**Adopt `nashsu/llm_wiki` as a dependency.** Hard-blocked by GPL-3.0 license
(incompatible with Aisy's Apache-2.0). Secondary blockers: Electron desktop runtime
(incompatible with headless VPS), auto-commit model (would require disabling the
mandatory staging gate), no bi-temporal schema, no hash-chained forget-list, no
resurrection-guard.

**Keep the implicit layer structure.** The tiers already exist in practice; naming
them is a documentation cost with no runtime change. Rejected because unnamed
conventions erode under contributor turnover — the "Raw/Immutable" and
"Wiki/Synthesized" separation is load-bearing for the forgetting invariant and
deserves an explicit canonical name.

**Adopt Ebbinghaus time-decay forgetting from the pattern.** Rejected: introduces
non-determinism that cannot be audited by the same deterministic resurrection-guard.
A human-confirmed permanent fact must never be quietly expired by a decay function.

## References

- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) — durable forgetting: tombstones, forget-list, resurrection-guard
- [ADR-0024](./2026-06-11-memory-contradiction-resolution.md) — memory contradiction resolution policy
- Karpathy LLMwiki pattern — https://x.com/karpathy (public posts, 2024–2025)
- `nashsu/llm_wiki` — https://github.com/nashsu/llm_wiki (GPL-3.0)
- Zep/Graphiti bi-temporal knowledge graph — https://github.com/getzep/graphiti

# ADR-0006: File-Based Memory with SQLite FTS5/BM25

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory

## Context
Aisy needs durable, long-lived memory for a single-user personal agent that survives
across sessions, providers, and engine swaps. The memory must be human-readable and
human-editable (the owner directly inspects and corrects it), portable across LLMs,
and diffable so changes are auditable.

Markdown files in git satisfy all of these: readable by a human and any model, editable
by hand or by the agent, portable, and version-controlled with full history. Retrieval
over those files needs to be cheap and deterministic — no per-query embedding calls, no
extra running service, no network round-trip. SQLite ships FTS5 with BM25 ranking via the
`bm25()` function, giving full-text search in ~20ms with zero LLM calls, in-process,
against an index that lives next to the files.

The alternative — vectors as the basis of memory — has been losing ground. ByteDance's
OpenViking abandoned vector-as-memory-basis in 2026 and moved to a file paradigm.
Embeddings add inference cost, a separate service to run and keep alive, 200ms+ latency
per query, and produce opaque float blobs that are neither human-readable nor git-friendly.

## Decision
Memory is markdown files in git, indexed by SQLite FTS5 with BM25 ranking (~20ms, zero
LLM calls) as the single source of truth and the core retrieval path.

A vector index is an optional, flag-gated plugin — used only for large, fuzzy-semantic
corpora where keyword recall genuinely falls short — and is never the core memory store.
Files remain canonical; any vector index is a derived, disposable artifact rebuilt from
the files.

## Consequences
- **Positive:** Human-readable and hand-editable memory; portable across LLMs and
  engines; full git history and diffs; ~20ms retrieval with no embedding cost, no extra
  service, and no network dependency; FTS5 queries can carry deterministic filters
  (e.g. `WHERE invalid_at IS NULL`) needed for durable forgetting.
- **Neutral:** FTS5 index is a derived artifact that must be rebuilt/reindexed on change;
  the files, not the index, are authoritative.
- **Negative:** BM25 is lexical, so purely semantic/synonym queries can miss matches; the
  optional vector plugin exists to cover that narrow case at the cost of extra moving parts.

## Alternatives considered
**Vector DB as the memory basis.** Rejected: per-query embedding inference cost, a
separate service to operate, 200ms+ latency, and storage that is neither git-friendly nor
human-readable. OpenViking's 2026 retreat from this pattern to files reinforced the call.

**Redis as the store.** Rejected: not git-friendly and not durable as a source of truth.
An in-memory store with optional persistence is the wrong substrate for canonical,
auditable, hand-editable memory.

## References
- Related: [ADR-0008 lazy three-step memory loading](./2026-06-11-three-step-lazy-memory-loading.md)
- Related: [ADR-0023 durable forgetting](./2026-06-11-durable-forgetting-tombstones.md)
- SQLite FTS5 BM25 ranking: https://www.sqlite.org/fts5.html

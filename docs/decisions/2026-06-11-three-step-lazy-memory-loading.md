# ADR-0008: Three-Step Lazy Memory Loading

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory, performance

## Context
A million-token context window is per-turn input capacity, not storage. Filling it
is not free: long context degrades through known failure modes — context poisoning
(a bad fact contaminates later reasoning), inertia (the model anchors on stale
loaded text), and distraction (signal drowns in irrelevant volume). So loading an
entire working-memory document just to answer one question is wrong on two axes:
it costs tokens and it lowers answer quality.

Aisy's memory is file-based markdown indexed by SQLite FTS5 (BM25, ~20ms, no LLM
call). The constitution.md / SOUL.md / USER.md / MEMORY.md stable prefix is always
loaded (~9-10k tokens). Everything below that — working/ and archive/ documents —
should not enter the prompt by default. We need a retrieval protocol that brings in
only as much of a document as the current step actually requires.

## Decision
Load working-memory documents in three escalating steps — **annotation** (~50
tokens) → **overview** (~500 tokens) → **full document** — and stop as soon as the
step in hand has enough. FTS5/BM25 ranking decides which documents are candidates;
the model decides whether to deepen.

Each indexed document carries a one-line annotation (what it is, when it was last
valid) and a short overview (key facts, structure). A query first sees only the
annotations of ranked hits. If an annotation looks relevant, the overview is pulled.
Only when the overview is insufficient does the full body load. Averaged over real
traffic this lands near ~550 tokens per resolved query versus ~10k to load a whole
file — roughly **95% saved**. This is economy by *architecture*, not by compression:
no lossy summarization of what we load, just refusal to load what we don't need.

## Consequences
- **Positive:** ~95% fewer tokens spent on memory retrieval; less poisoning/inertia/
  distraction because irrelevant text never enters the window; deterministic,
  cheap ranking (no embedding calls); annotations/overviews double as a human-readable
  index of the memory bank.
- **Neutral:** Each document needs an annotation and overview kept in sync with its
  body (generated on write/consolidation, not hand-maintained). Adds a metadata layer
  to the FTS5 schema.
- **Negative:** Up to three retrieval hops adds latency and a few extra model turns
  for deep queries; a stale or wrong annotation can hide a relevant document
  (false negative) — annotations must be regenerated whenever the body changes, and
  bi-temporal `invalid_at` filtering must apply at every step.

## Alternatives considered
**Load whole files on any hit.** Simplest, but blows the token budget (~10k per file)
and actively harms quality by stuffing the window with irrelevant text — the exact
poisoning/distraction failure mode a 1M window does not cure. Rejected.

**Naive RAG chunking.** Split documents into fixed-size chunks, embed, retrieve top-k
by vector similarity. It shreds document structure (headings, ordering, the
narrative a daily log depends on), gives fuzzy recall with no clean provenance, and
needs an embedding pipeline. Consistent with our stance that vectors are an optional
flag-gated plugin for large fuzzy corpora — not the memory basis. Rejected as the
default.

## References
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — file-based memory + FTS5/BM25 substrate this protocol reads from.
- Drew Breunig, "How Long Contexts Fail" (poisoning / inertia / distraction), 2025.

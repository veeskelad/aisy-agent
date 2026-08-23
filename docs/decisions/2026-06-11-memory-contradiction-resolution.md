# ADR-0024: Memory Contradiction Resolution Policy

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory

## Context
Aisy's memory is append-only markdown in git plus an SQLite FTS5 index. Append-only
stores keep both "X" and "not X" with equal weight: when the user corrects a fact,
the old assertion is never removed, so the index holds two contradictory rows. BM25
ranks on lexical relevance, not truth — a stale, keyword-dense entry can outrank the
correction and surface as the answer.

This is the consolidation problem behind the deletion bug the owner hit: the nightly
loop re-derives "deleted" facts from un-cleaned daily logs, and the retriever has no
notion of which of two conflicting facts is current. ADR-0023 already gives us
bi-temporal facts (valid_at / invalid_at, is_human_confirmed), soft-delete, a
do_not_remember forget-list, and a resurrection-guard. What is still missing is the
deterministic rule that decides *which* fact wins when two disagree.

## Decision
When two facts conflict, resolve by a fixed priority order:
**human-confirmed > recency > source-authority > confidence.** A correction
*supersedes* — the old fact gets invalid_at set and the new fact is written with
is_human_confirmed, rather than both versions living side by side in the index.

- The retriever already filters `WHERE invalid_at IS NULL AND id NOT IN do_not_remember`,
  so superseded facts drop out of BM25 ranking entirely.
- Resolution runs at write/consolidation time, not at query time — it is a code
  decision (100% deterministic), not an LLM judgment, satisfying the NIST
  "one non-LLM enforcement layer" requirement.
- Every resolution is appended to an audit log (winning id, losing id, rule that
  fired, timestamp) for later review and to debug bad merges.
- A human-confirmed fact can only be overturned by another human-confirmed fact;
  recency does not beat it. This is consistent with ADR-0023, where human-confirmed
  deletions are permanent.

## Consequences
- **Positive:** BM25 can no longer surface a stale fact over its correction; the
  index converges to a single current truth per fact. Borrows proven semantics from
  Zep/Graphiti bi-temporal invalidation and mem0's ADD/UPDATE/DELETE/NOOP without
  importing their code.
- **Positive:** Deterministic, auditable, and cheap — no LLM call on the hot read path.
- **Neutral:** Requires a conflict-detection step in consolidation to pair an incoming
  fact with the existing one it contradicts; reuses the resurrection-guard's matching.
- **Negative:** A wrong auto-correction silently invalidates a good fact until someone
  reads the audit log; mitigated by soft-delete (nothing is hard-deleted) so any
  superseded fact remains recoverable.
- **Negative:** Source-authority and confidence scores must be populated at ingest, or
  the lower two tiers degrade to "recency only."

## Alternatives considered
**Newest-wins (recency only).** Simplest rule, but it ignores authority: a casual,
recent aside would overwrite a deliberate human-confirmed fact. Rejected because it
breaks the permanence guarantee from ADR-0023 and would let untrusted recent input
flip established truths.

**Keep both versions, let the retriever decide.** Stores every assertion and ranks at
query time. Rejected because this is exactly the failure mode we are fixing: BM25 has
no truth signal and routinely surfaces the stale entry, reproducing the consolidation
bug.

## References
- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) — bi-temporal facts, soft-delete, forget-list, resurrection-guard
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — file-based memory + FTS5 retrieval
- Zep/Graphiti bi-temporal knowledge graph — https://github.com/getzep/graphiti
- mem0 memory operations (ADD/UPDATE/DELETE/NOOP) — https://github.com/mem0ai/mem0

# ADR-0023: Durable Forgetting — Tombstones + Forget-List + Bi-temporal

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory

## Context
The owner hit a concrete failure: "I asked Aisy to delete a memory, and it came back." A
deleted fact resurfaced because the harness had no durable negation primitive. Root causes,
all present at once:

- **Append-only logs re-derived.** Nightly consolidation re-extracted the deleted fact from
  un-cleaned daily logs, silently resurrecting it.
- **Stale FTS5 index.** The BM25 search index was not reindexed on delete, so the fact stayed
  queryable even after the markdown was edited.
- **Frozen snapshot / KV-cache.** The within-session memory snapshot (kept byte-identical for
  ~90% KV-cache savings) held the stale prefix; the "deletion" only existed in volatile state.
- **No tombstone, no forget-list.** Nothing recorded the *intent to forget* in a form that
  survives a rewrite or a consolidation pass.

Public precedent confirms the class of bug: per-memory delete missing (only nuke-the-whole-bank),
removal not forwarded to the external index, and KV-cache invalidation gaps. The established fix
pattern is bi-temporal facts (Zep/Graphiti `valid_at`/`invalid_at`), an ADD/UPDATE/DELETE/NOOP
operation model (mem0), and explicit memory-tool deletes (Anthropic). NIST guidance requires at
least one deterministic enforcement layer not judged by an LLM — forgetting must be code, not a
prompt instruction at ~70% adherence.

## Decision
Deletions and corrections are **durable**: every memory fact is bi-temporal and soft-deleted, an
explicit forget-list survives all rewrites, and a deterministic resurrection-guard blocks any
consolidation commit that would re-introduce a forgotten fact.

- **Bi-temporal facts.** Each fact carries `valid_at`, `invalid_at`, and `is_human_confirmed`.
  A fact is live iff `invalid_at IS NULL`.
- **Soft-delete, not erasure.** Deletion sets `invalid_at = now()`; the row is retained (audit,
  contradiction history) but excluded from all reads. No hard `DELETE`.
- **Forget-list (`do_not_remember`).** An explicit table of `(id, reason, timestamp)` that
  survives any log rewrite, consolidation, or snapshot rebuild. This is the negation primitive.
- **FTS5 invariant.** Every search query filters
  `WHERE invalid_at IS NULL AND id NOT IN (SELECT id FROM do_not_remember)`, and the index is
  reindexed on every change (no stale BM25 rows).
- **Resurrection-guard validator.** A deterministic check runs before any nightly-consolidation
  commit; if a candidate fact matches a tombstone (`invalid_at` set) or a forget-list entry, the
  commit is **blocked** and routed to human review — it never lands silently.
- **Human-confirmed deletions are permanent.** When `is_human_confirmed` is set on a deletion,
  no automated path (recency, source-authority, confidence) may ever resurrect it.

## Consequences
- **Positive:** "Delete" actually sticks across sessions, consolidation, KV-cache rebuilds, and
  index refreshes. Audit trail preserved (soft-delete). Deterministic enforcement satisfies the
  NIST "at least one non-LLM layer" requirement. Forget-list is human-readable and git-diffable.
- **Neutral:** Adds two columns and one table to the memory schema; consolidation gains a
  pre-commit gate. Contradiction resolution follows a fixed priority:
  human-confirmed > recency > source-authority > confidence.
- **Negative:** Tombstoned rows accumulate (bounded by periodic archival of long-invalid,
  non-human-confirmed rows). The resurrection-guard can produce human-review queue items on
  legitimate re-learning; reason strings on the forget-list mitigate this.

## Alternatives considered
**Hard-delete the row.** Rejected: removing the markdown/row does not stop nightly consolidation
from re-deriving the fact out of un-cleaned daily logs, nor does it guarantee the FTS5 index or
the frozen snapshot were updated — exactly the path that produced the original resurrection. Hard
delete also destroys the audit trail needed for contradiction resolution.

**Append-only without a negation primitive.** Rejected: append-only logs have no way to express
"forget X." Every consolidation pass treats the old assertion as still valid, so the fact is
structurally un-forgettable. The forget-list exists precisely to add the missing negation.

## References
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — file-based memory + FTS5 substrate this builds on
- [ADR-0016](./2026-06-11-generator-judge-self-learning.md) — nightly consolidation loop the guard gates
- [ADR-0024](./2026-06-11-memory-contradiction-resolution.md) — memory contradiction resolution policy
- Zep/Graphiti bi-temporal model; mem0 ADD/UPDATE/DELETE/NOOP; Anthropic memory tool (public).

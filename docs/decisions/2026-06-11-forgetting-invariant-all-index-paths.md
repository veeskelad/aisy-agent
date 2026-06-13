# ADR-0030: Forgetting Invariant Holds on Every Index and Write Path

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** security, memory

## Context
[ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) makes deletion durable through
four controls, but they were specified on the *nightly consolidation commit* path. Review
found the guarantee leaks everywhere else:

- **Within-session writes** hit disk and FTS5 live and are searchable that whole session,
  but the resurrection-guard and contradiction resolution only run at night — a day-long
  hole where a forgotten or contradicting fact can be written and queried unchecked.
- **Direct file/DB edits** (a sandbox mount, an MCP filesystem server, the owner's editor,
  a future rebuild-from-files) re-introduce a tombstoned fact without passing the guard;
  the FTS5 index is rebuilt *from* the files, so a poisoned file becomes a live fact on
  next reindex.
- **Paraphrase** evades the normalize+hash match (a re-worded equivalent re-enters).
- **The optional vector plugin** ([ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md))
  has no forget-list filter attached, so a semantically-equivalent forgotten fact could be
  surfaced through a derived index.
- **`do_not_remember`** is itself a plain table an attacker with file/DB write access can
  edit.

The fix is to stop treating forgetting as a consolidation-time step and make it an
invariant of the storage layer itself.

## Decision
**The forgetting filter is a property of the indexer and write path, enforced on every
ingestion, reindex, and import — not only at nightly commit.**

1. **One choke point for all writes.** Every path that adds or re-derives a fact —
   within-session write, nightly promotion, rebuild-from-files, MCP/import — passes
   through the same indexer that applies `WHERE invalid_at IS NULL AND id NOT IN
   do_not_remember` and runs the resurrection-guard. No path writes a searchable fact
   while bypassing it.
2. **Live within-session check.** Within-session writes get the read-path filter plus a
   lightweight resurrection check at write time, closing the day-long hole. A write that
   matches a tombstone/forget entry is rejected and surfaced, not silently stored.
3. **Equivalence-class fact keys.** Tombstoning keys on an extracted
   `(entity, relation, object)` equivalence class, not surface text, so common paraphrases
   are caught. Residual re-wordings the key cannot catch route to human review (fail-safe),
   never to a silent commit.
4. **Forget invariant on every derived index.** Any derived index, including the vector
   plugin, must enforce the same `invalid_at` / `do_not_remember` exclusion as a contract;
   the indexer owns it. A test asserts no derived index — FTS5 or vector — can return a
   forgotten fact.
5. **`do_not_remember` integrity.** The forget-list is append-only and integrity-protected
   (hash-chained or held outside agent-writable scope). The agent edits memory only through
   the op-model + guard, never via raw file writes; no MCP or sandbox mount has write access
   to the canonical memory tree.
6. **Corruption detection.** The indexer runs an integrity check and rebuilds from files
   on detected corruption; a corrupt index must fail loud, not return wrong/empty results
   that would silently break the forget filter.

## Consequences
- **Positive:** "Forget this" holds across *every* path — mid-session, direct edit,
  rebuild, vector plugin — not just the nightly happy path. Closes the five leak paths the
  review found around the project's founding bug. The integrity-protected forget-list and
  no-raw-write rule remove the easy tamper routes.
- **Neutral:** Centralizing all writes through one indexer is a Component 3 (Memory)
  architectural requirement; the guard becomes a hot-path concern, so it must stay cheap
  (hash/set lookups, no model call).
- **Negative:** The live within-session check adds a small per-write cost. Equivalence-class
  extraction is itself a mechanism that can mis-key; mis-keys route to human review
  (fail-safe) but add review volume. Forbidding sandbox/MCP write access to the memory tree
  removes a convenience (the agent can't just edit its own files) in exchange for the
  guarantee.

## Consequences for v0.1
The **minimum** of this ADR — the forget-list, the ingestion/read-path
`invalid_at`/`do_not_remember` filter, and the indexer choke point — ships in v0.1
alongside nightly consolidation, so v0.1 does not reintroduce the founding bug. The full
bi-temporal machinery, equivalence-class keying, and vector-index contract harden in v0.2.

## Alternatives considered
**Keep the guard only at nightly commit (original).** Leaves the five leak paths above;
the within-session and direct-edit holes alone reproduce the founding bug. Rejected.

**Make memory append-only, never delete.** Avoids resurrection by never forgetting — but
the entire point is reliable deletion. Rejected.

**Embedding-based semantic guard on the hot path.** Would catch all paraphrases but adds a
model/embedding call to every write and contradicts the no-LLM-in-retrieval rule
([ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md)). Equivalence-class keys plus
human-review fallback get most of the benefit deterministically.

## References
- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) — the controls this generalizes
- [ADR-0024](./2026-06-11-memory-contradiction-resolution.md) — recency vs forget-list boundary
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — the indexer and the vector plugin
- [ADR-0029](./2026-06-11-human-confirmation-provenance-binding.md) — who may confirm a delete
- OWASP LLM03 (Memory Poisoning); STRIDE Tampering

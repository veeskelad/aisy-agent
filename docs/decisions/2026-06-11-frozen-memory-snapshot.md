# ADR-0007: Frozen Memory Snapshot per Session

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** memory, performance

## Context
Aisy keeps an always-loaded stable memory prefix (constitution.md, SOUL.md,
USER.md, MEMORY.md, ~9-10k tokens) at the head of every request. KV-cache reuse
gives up to ~90% input savings, but only while the prefix is byte-identical for
the whole session: a single mutation invalidates the cache from the changed
position onward, and the provider re-bills the entire prefix at full input rate.

The agent writes to memory during a session (daily/YYYY-MM-DD.md, working/, FTS5
updates). If those writes flowed back into the live prefix mid-session, every
write would bust the cache and inflate cost, while also making the prompt a
moving target within a single reasoning run. We need durable writes without
sacrificing prefix stability. Anthropic supports up to 4 cache breakpoints with a
~1024-2048 token minimum, so the prefix must stay frozen to land on a breakpoint.

## Decision
Read the always-loaded memory layer once at session start and freeze that
snapshot for the session's entire prefix. Within-session writes go to disk
immediately (durable), but are not re-read into the live context; they take
effect in the next session, which reads a fresh snapshot.

The frozen snapshot is the cacheable prefix. New facts written during the session
land on disk and in the on-demand FTS5 layer, so they are retrievable by explicit
search this session even though they are absent from the frozen always-loaded
prefix. Only the stable prefix is frozen; daily/working content can still be
pulled in on demand via the three-step lazy loader.

## Consequences
- **Positive:** Byte-stable prefix preserves KV-cache (~90% input savings),
  satisfies the breakpoint minimum, and keeps the prompt deterministic within a
  run.
- **Positive:** Writes are durable the moment they hit disk — no end-of-session
  flush to lose on a crash.
- **Neutral:** The snapshot is a per-session read; cost is one extra read at
  startup, amortized across the whole session.
- **Negative:** A fact written now is not visible in the always-loaded prefix
  until the next session. Accepted and documented; the FTS5 layer still surfaces
  it on explicit search this session, so it is not truly invisible.

## Alternatives considered
**Hot-reload of memory mid-session.** Re-reading the prefix whenever memory
changes keeps the agent maximally current, but every write invalidates the
KV-cache and re-bills the full ~10k-token prefix, defeating the entire savings
rationale. Rejected on cost and determinism.

**End-of-session batch update.** Buffer all writes in memory and flush once at
session end. This keeps the prefix stable but holds writes only in volatile state
until the flush — a crash, kill, or fallback event loses them, violating the
durability requirement. Rejected; we want disk durability at write time.

## References
- [ADR-0019](./2026-06-11-stable-prefix-kv-cache.md) — byte-stable prefix
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — always-loaded layer, three-step lazy loading
- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md) — soft-delete and resurrection guard
- Anthropic prompt caching docs: cache breakpoints and minimum cacheable length.

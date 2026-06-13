# ADR-0019: Stable-Prefix KV-Cache

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** performance

## Context
The Aisy harness sends a large always-loaded stable prefix every turn: the
system prompt plus the level-1 memory (constitution.md, SOUL.md, USER.md,
MEMORY.md), totalling ~9-10k tokens before any conversation. Re-billing this
prefix on every request across a long session is the dominant input cost.

KV-cache reuse can save up to ~90% of input cost, but only under strict
conditions: the cached prefix must be **byte-identical** for the whole session,
conversation history must be **append-only**, and any byte change at or before a
cache breakpoint invalidates the cache from that point onward. The conflict is
that the agent writes to memory *during* a session (daily logs, working notes).
If those writes mutated the live prefix mid-session, every write would drop the
cache and force a full re-bill of the prefix — the exact failure mode behind
Hermes issue #13631 (KV-cache invalidation). Anthropic supports up to 4 cache
breakpoints with a minimum segment of ~1024-2048 tokens.

## Decision
Keep the system-prompt prefix byte-identical for the entire session, keep
conversation history append-only, and serve memory from a **frozen snapshot**
taken at session start so within-session writes never mutate the live prefix —
they become visible only in the next session. Place Anthropic cache breakpoints
(up to 4, each ≥ ~1024-2048 tokens) at stable segment boundaries.

Breakpoint layout (each segment ordered most-stable first so a change never
poisons a more-stable segment):
1. System prompt + constitution.md (rarely changes)
2. SOUL.md + USER.md (per-user, stable within a session)
3. MEMORY.md index (frozen snapshot for the session)
4. Reserved boundary before append-only conversation history

Within-session memory writes go to the daily/working files and the FTS5 index
(per ADR-0007); they are picked up at the *next* session's snapshot, never
patched into the running prefix.

## Consequences
- **Positive:** Up to ~90% input-token savings on a long session; lower latency
  and cost on the workhorse/critic providers; deterministic, reproducible prefix
  aids debugging and replay.
- **Neutral:** Memory written this session appears next session, not instantly —
  acceptable and already the model's expected behavior; cache is lost on provider
  fallback (only KV-cache, the session survives — see ADR-0018).
- **Negative:** A frozen snapshot can serve slightly stale memory mid-session;
  emergencies needing an immediate prefix change (e.g. a forced forget) require
  an explicit session restart, deliberately accepting one cache drop.

## Alternatives considered
**Mutable prefix (live memory in the prefix):** simplest mental model, but every
memory write rewrites the prefix and breaks the cache, re-billing ~10k tokens per
write — the opposite of the goal.

**No caching:** zero complexity, but pays full input cost every turn; on a long
session this is the single largest avoidable expense.

**Mid-session compaction of the prefix:** rewriting/summarizing the prefix to
shrink it mutates cached bytes (cache break) and loses byte-level reproducibility,
undermining replay and debugging; compaction belongs to the conversation tail, not
the stable prefix.

## References
- [ADR-0006](./2026-06-11-file-based-memory-fts5-bm25.md) — file-based memory + FTS5 index this snapshot is derived from
- [ADR-0018](./2026-06-11-model-router-hysteresis-fallback.md) — provider fallback; KV-cache is lost on fallback while the session survives
- [Anthropic prompt caching documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — 4 breakpoints, ~1024-2048 token minimum

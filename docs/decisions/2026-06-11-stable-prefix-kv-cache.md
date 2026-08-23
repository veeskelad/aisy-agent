# ADR-0019: Stable-Prefix KV-Cache

**Status:** Accepted
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

---

## Live implementation (Tier 8, 2026-06-24)

### Breakpoint design: 2 breakpoints, not 4

The live implementation emits **2 cache breakpoints** per request, not the 4-segment
layout described in the original Decision above:

- **bp1 (stable prefix):** `cache_control: { type: 'ephemeral' }` on the last system
  block — covers the entire stable prefix (system prompt + memory + tool definitions).
- **bp2 (conversation tail):** `cache_control: { type: 'ephemeral' }` on the last
  message — covers the growing conversation history.

**Rationale for not using the 4-segment split:**
Within a session the prefix is FROZEN (byte-identical per this ADR), so placing
multiple breakpoints inside it buys nothing within-session — each segment still
hashes identically to the single bp1 block. Anthropic's 5-minute (ephemeral) and
1-hour cache TTLs also make cross-session segment reuse moot for the typical
session lifecycle; the marginal benefit of sub-segment granularity does not
justify the implementation and maintenance cost. The tail breakpoint (bp2) is
where the agentic-loop win lives: conversation history grows across inner
tool-calls and turns (append-only per this ADR), so bp2 is re-read from cache on
every subsequent turn after the first.

The 4-segment split remains a documented future option if cross-session reuse
patterns justify it.

### Per-provider cache matrix

| Provider | Strategy | Request change |
|----------|----------|----------------|
| anthropic | Explicit `cache_control: ephemeral` on last system block (bp1) + last message (bp2) | Yes — system becomes `[{ type, text, cache_control }]`; last message becomes block array |
| openai / deepseek / gemini / glm / qwen | Transparent automatic prefix caching | None — the provider caches transparently; no `cache_control` emitted; dollar accounting conservatively over-estimates (uses `prompt_tokens` inclusive of cached), which is safe for the budget cap |
| openrouter | `cache_control` passthrough (`cache: 'breakpoints'` mode) | Same block-wrapping as Anthropic — OpenRouter forwards the hint to the backing model |
| claude-cli | None | None |

### Cost accounting (Anthropic)

When Anthropic caching is active, `usage.input_tokens` in the response reports only the
**uncached remainder** of the prompt. The remaining prompt tokens arrive in two
separate fields:

- `cache_creation_input_tokens` — tokens written to cache this turn (billed at 1.25×
  base input price).
- `cache_read_input_tokens` — tokens read from cache (billed at 0.1× base input price).

`parseResponse` now reads all three fields and computes:

```
inputTokens  = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
dollars      = (input_tokens / 1e6) × inPerMtok
             + (cache_creation_input_tokens / 1e6) × inPerMtok × 1.25
             + (cache_read_input_tokens / 1e6) × inPerMtok × 0.1
             + (output_tokens / 1e6) × outPerMtok
```

This is required so the budget cap (a safety mechanism) does not under-bill when
caching is active. `TurnUsage` was deliberately **not** widened — cache savings are
an internal optimization and are surfaced only via the falling `$` figure in the
Monitor, not as new public fields.

Prompt caching is GA on the Anthropic API; no `anthropic-beta` header is required
(only `anthropic-version: 2023-06-01`).

### Kill-switch

`AISY_PREFIX_CACHE` — anything other than `'0'` enables prefix caching (default on).
The minimum cacheable prefix is model-dependent (e.g., 4096 tokens on Opus-tier
models). When the prefix is below the model's minimum, Anthropic silently skips
caching — no error is returned and no incorrect answers are produced.

### Implementation reference

- Plan: [`docs/superpowers/plans/2026-06-24-tier8-prefix-cache.md`](../superpowers/plans/2026-06-24-tier8-prefix-cache.md)
- ADR-0055: Content-Addressed Exact-Response Cache — the companion exact-cache for
  deterministic, non-stateful paths (eval-replay, nightly re-run).

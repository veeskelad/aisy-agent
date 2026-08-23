# ADR-0055: Content-Addressed Exact-Response Cache (#20)

- **Status:** Accepted
- **Date:** 2026-06-24
- **Related:** ADR-0019 (stable-prefix KV-cache), ADR-0031 (semantic vector plugin — the separate deferred #21 cache), ADR-0053 (nightly generator/judge)

## Context

Deterministic, non-stateful paths — eval-replay and nightly generator/judge re-runs
— re-issue identical `(model, prompt)` pairs across process runs. Replaying the same
request to the provider re-bills the API and adds latency with no benefit: for a given
`(namespace, prefixBytes, spans)` triple the response is fully determined by the inputs.

The live agent loop cannot benefit from a response cache: turns are stateful (capability
narrowing, frozen snapshot, resurrection-guard), the conversation grows with every turn
(append-only history), and a content-hash hit on a live turn would be near-zero AND
risk bypassing safety invariants if the session context has changed. This ADR addresses
only the deterministic off-loop paths.

## Decision

A `ProviderAdapter` decorator `makeExactCache(inner, store, namespace)` wraps a provider
for deterministic, non-stateful call sites. The cache key is:

```
sha256(namespace + '\0' + prefixBytes + '\0' + JSON.stringify(spans))
```

`sessionId` is deliberately **excluded** — the cache is content-addressed and must
produce the same key across separate runs/sessions for the same logical prompt.

The default store is in-memory (`makeMemoryExactCacheStore`), scoped to a single
process run with no eviction (acceptable for the bounded per-run scope of eval-replay
and nightly re-runs).

Opt-in for nightly paths via `AISY_NIGHTLY_EXACT_CACHE=1` (default **OFF**, preserving
nightly sample freshness by default). When enabled, nightly generator and judge adapters
are each wrapped with a distinct namespace so their entries remain isolated.

### INVARIANTS (load-bearing)

1. **NEVER wraps the live agent loop.** Live turns are stateful: capability narrowing
   is in effect, the frozen memory snapshot is session-scoped, and resurrection-guards
   may block a turn. A content-hash hit on a live turn would be near-zero AND risk
   bypassing these safety invariants. Key-collision risk (two sessions with different
   context but identical `prefixBytes + spans`) is also non-trivial on the live path.

2. **NEVER wraps an in-flight retry-for-a-fresh-sample.** When a parse failure triggers
   a retry specifically to obtain a *new* sample (e.g., malformed JSON from the model),
   a cache hit would re-serve the same failed response. The decorator must only be
   applied at the adapter-construction site, before the call-site that needs a fresh
   sample.

The intended hit pattern is: a re-run of the same nightly batch after a process crash
(crash recovery), or an eval-replay of a previously recorded trace, where returning the
identical response IS the correct behavior.

## Consequences

- **Positive:** Zero-cost deterministic replay for eval and nightly crash-recovery;
  reduces API spend on repeated identical runs.
- **Neutral:** The in-memory store is per-process with no TTL or eviction. For the
  bounded scope of a single nightly run or eval session this is acceptable. A
  max-entries cap and optional disk-backed store are documented follow-ups.
- **Negative:** Opt-in only (`AISY_NIGHTLY_EXACT_CACHE=1`); nightly runs remain fresh
  by default. The invariants above mean this cache cannot be broadened to live paths
  without a new ADR and explicit safety analysis.

## Alternatives considered

**Semantic cache on the live loop** — rejected. This is the anti-pattern described in
the Tier-8 research note: stateful turns produce near-zero hit rates, and a semantic
hit could silently bypass safety invariants (narrowing, resurrection-guard). The
deferred semantic-response cache (#21, ADR-0031) targets read-only semantic-similarity
paths only, never the live loop.

**No cache (status quo)** — wasteful on deterministic replay. Eval-replay and nightly
re-runs are the canonical high-frequency deterministic paths where caching is both safe
and high-value.

**Disk-backed or Redis-backed store** — deferred. The in-memory store covers the
per-run scope with zero infrastructure dependency; a persistent store is a follow-up
when cross-run caching (e.g., incremental eval) is needed.

## References

- ADR-0019: Stable-Prefix KV-Cache — provider-level prefix caching (the complementary
  live-loop optimization)
- ADR-0031: Optional Semantic Vector Plugin — the separate deferred semantic-response
  cache (#21), scoped to read-only paths, never the live loop
- ADR-0053: Proactivity — In-Process Scheduler & Nightly Generator/Judge — the nightly
  paths this cache wraps
- Plan: [`docs/superpowers/plans/2026-06-24-tier8-prefix-cache.md`](../superpowers/plans/2026-06-24-tier8-prefix-cache.md)

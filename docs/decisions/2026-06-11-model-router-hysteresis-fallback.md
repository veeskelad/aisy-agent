# ADR-0018: 3-Tier Model Router with Hysteresis Fallback

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** routing

## Context
Aisy spans tasks with very different cost/quality profiles: nightly self-improvement
and monitoring run constantly, the workhorse handles most reasoning, and critique/review
gates need the strongest model. Sending everything to one provider either overpays
(a $5/$25 critic model doing routine log triage) or underperforms (a $0.14/$0.28
flash model judging a deploy plan). June 2026 per-1M pricing makes the spread concrete:
Claude Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, GPT-5.5 $5/$30, DeepSeek V4-Pro $1.74/$3.48,
V4-Flash $0.14/$0.28.

Provider outages and rate limits are routine, not exceptional. But switching providers on
the *first* timeout thrashes: a single transient 429 flips the route, the next call flips
it back, and every flip discards the current provider's KV-cache (up to ~90% input savings
when the prefix stays byte-identical all session). That turns a blip into a sustained cost
and latency spike. The router must be deterministic harness code (the OS, 100% adherence),
not a model deciding its own routing.

## Decision
A cheap classifier routes each task by type — reasoning → DeepSeek V4-Pro, critique/review →
Claude Opus 4.8, routine/monitoring/nightly → V4-Flash — and falls back only after **2
consecutive** provider errors (429/5xx/timeout) on the active provider, escalating
GPT-5.5 → Sonnet 4.6 → human alert. The session survives a fallback; only the failed
provider's KV-cache is lost.

The hysteresis counter is per-provider and resets to zero on any successful response, so
isolated transient errors never trigger a switch. The classifier is a small, fast call
(or rule table) whose own cost is negligible against the routing savings. Routing is a
deterministic code path with a fixed escalation order, never an LLM choosing where to send
itself.

## Consequences
- **Positive:** Each task hits the cheapest model that fits — flash for nightly/monitoring,
  V4-Pro for bulk reasoning, Opus only for gates. Hysteresis preserves KV-cache through
  transient blips and absorbs real outages without dropping the session.
- **Neutral:** Adds a classifier step and a per-provider error counter to the request path;
  the escalation order (GPT-5.5 → Sonnet 4.6 → alert) is a fixed policy that may need tuning
  as prices and providers shift.
- **Negative:** A genuine hard outage costs one extra failed call before fallback fires
  (the cost of the "2 consecutive" rule). A misclassification can route a hard task to a
  weak tier; review gates must stay pinned to Opus regardless of classifier output.

## Alternatives considered
**Static route (one provider per task type, no fallback).** Simple, but a provider outage
stalls every task of that type with no recovery path; rejected because outages are routine.

**Round-robin across providers.** Spreads load and survives single-provider failures, but
ignores task fit entirely — it would send a deploy-plan critique to V4-Flash and routine
monitoring to Opus, inverting the cost/quality logic. Rejected.

**Switch provider on every error (no hysteresis).** Reacts fastest to real outages but
thrashes on transient 429/timeout spikes, flipping routes and discarding KV-cache on each
flip — exactly the expensive churn this ADR exists to prevent. Rejected.

## References
- Related: [ADR-0019](./2026-06-11-stable-prefix-kv-cache.md)
- DeepSeek pricing and model tiers, June 2026 provider sheet
- Anthropic prompt-caching: up to 4 cache breakpoints, ~1024-2048 token minimum

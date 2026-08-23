# ADR-0038: Triggers & Proactivity (Two-Phase, Budget-Capped)

**Status:** Accepted
**Runtime realized by ADR-0053 (2026-06-22).**
**Date:** 2026-06-12
**Tags:** proactivity, architecture, cost

## Context

Aisy is purely reactive: it acts on an operator message plus one fixed nightly
consolidation. "Remind me tomorrow", "morning digest", "watch this CI job"
are impossible — there is no scheduler, reminder, or watch primitive. The
competitive audit showed proactivity is among the most-wanted personal-agent
behaviors (Khoj automations, OpenClaw heartbeat — "turns a reactive chatbot
into a background worker") and among the most dangerous to build naively:
OpenClaw's heartbeat reloaded full context every 30 idle minutes, burning
2–3M tokens/day doing nothing, a top driver of its $150–3 600/mo bills.

Aisy already owns the pieces a safe version needs: an enumerated
deterministic probe set (`VerificationTrace`, ADR-0017), code-enforced budgets
(ADR-0018/Eng-12), untrusted-provenance narrowing (ADR-0027), and the
approval-card path (ADR-0029).

## Decision

Add component **14 Triggers & Proactivity**
(`docs/specs/14-triggers-and-proactivity.md`): three trigger kinds —
`remind` (one-shot), `schedule` (cron), `watch` (condition) — fired through a
**two-phase pipeline**:

1. **Phase 1 — deterministic check, zero model tokens.** Due-time/cron
   evaluation in code; watches run a `VerificationTrace` probe (file/sql/
   http/exit — the ADR-0017 machinery reused as a predicate). No change → no
   cost.
2. **Phase 2 — one budget-capped agent turn.** Only on due/condition-met; the
   woken turn carries minimal context, runs under a per-trigger token/$
   ceiling plus a global background budget, and any watch observation enters
   as `untrusted` (narrowing applies).

Agent-created triggers pend until an operator confirmation card; `confirmed`
is writable only by the approval path. **Schedule:** spec + ADR + typed
skeleton and skip-marked tests in v0.1 (now); implementation in v0.2.

## Consequences

- **Positive:** reminders/digests/watches become possible; a quiet trigger
  costs ~0 tokens; a noisy one is capped twice (per-trigger + global); the
  injection and self-scheduling attack paths are closed by existing
  mechanisms (narrowing + cards) rather than new ones.
- **Neutral:** a fourteenth component; Gateway/Onboarding add `/remind`,
  `/schedule`, `/watch` commands when implemented; the nightly consolidation
  cron stays separate and unchanged.
- **Negative:** a persistent trigger store and tick loop to maintain;
  schedules skip missed slots (no catch-up) — digest users may notice gaps
  after downtime; implementation deferred to v0.2 means v0.1 ships reactive.

## Alternatives considered

- **OpenClaw-style heartbeat (periodic full-context wake).** Rejected: the
  audit documents 2–3M tokens/day idle burn; cost scales with wall-clock, not
  with events.
- **Cron-only (no watch).** Rejected: covers reminders/digests but not the
  most-demanded "tell me when X changes"; and a cron-fired LLM "check X" turn
  is exactly the expensive pattern phase-1 probes avoid.
- **LLM-evaluated watch conditions.** Rejected: puts a model call in phase 1,
  reintroducing per-tick cost and an injection surface; the enumerated probe
  set is deterministic and already audited (ADR-0017).
- **Defer entirely to v0.2 (no design now).** Rejected by the operator: the
  gap is structural (canonical harness element "event triggers"); designing
  now keeps Onboarding (13) and Gateway (02) interfaces honest.

## References

- Spec: [14 Triggers & Proactivity](../specs/14-triggers-and-proactivity.md)
- Related ADRs: [ADR-0017](./2026-06-11-external-verification-by-traces.md), [ADR-0018](./2026-06-11-model-router-hysteresis-fallback.md), [ADR-0027](./2026-06-11-capability-narrowing-untrusted-context.md), [ADR-0029](./2026-06-11-human-confirmation-provenance-binding.md), [ADR-0034](./2026-06-11-onboarding-operations-layer.md)
- Competitive evidence: `memory/competitive-landscape.md` (OpenClaw heartbeat burn; Khoj automations demand)

# ADR-0036: Cost-Transparency Surfacing

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** cost, observability, devex

## Context

Aisy already enforces hard spend caps: per-task token and dollar ceilings, code-enforced before dispatch (ADR-0018, spec 09). But cost *visibility* — per-turn and per-session accounting the operator can see — was scoped to v0.2. Caps prevent disaster; they do not build trust or let the operator reason about spend.

The competitive audit (2026-06-11) made this the single most consistent user complaint across the field. OpenClaw users report $150–3 600/mo bills and built third-party dashboards (ClawWatcher) to compensate for missing native visibility; a silent Anthropic cache-TTL change tripled bills overnight with no signal. Hermes users report $131/day on Opus and 15–20K tokens per Telegram exchange. Open Interpreter and AutoGPT have documented "unexpected cost" issues. The projects that surface cost in-session (`/status`, `/usage`, `/context` in OpenClaw; a spend dashboard in AutoGPT) materially reduce this pain. Aisy has the caps but, until now, not the visibility.

## Decision

Promote provider-cost telemetry from v0.2 into v0.1. The router (spec 09) emits a `provider.cost.charged` event (task, request, tier, tokens, dollars) into the Observability journal (spec 12) on every successful call. The Onboarding & Operations layer (spec 13) surfaces it in-session:

- **`/status`** — current per-tier model routing, context fill, last-turn and session cost.
- **`/usage`** — cost breakdown by tier/period, aggregated from the journal events.
- **`/context`** — what is injected (files, tools, skills) and its size.

Per-step financials are also recorded in the decision journal (spec 11) so a run's cost is auditable after the fact. Caps remain code-enforced and unchanged — this ADR adds visibility, it does not soften enforcement.

## Consequences

- **Positive:** the operator sees spend in real time and after the fact, in Telegram, without a third-party tool; cost-shock — the field's #1 complaint — is structurally addressed; cap breaches become explicable.
- **Neutral:** the journal carries a cost event per call; `/usage` is a read-only aggregation over it.
- **Negative:** a small per-call accounting and event-emission overhead; the aggregation must stay correct as routing/fallback changes the resolved provider.

## Alternatives considered

- **Keep caps-only, defer visibility to v0.2.** Rejected: caps prevent the worst outcome but leave the operator blind; the audit shows users of a caps-without-visibility tool resort to building their own dashboards.
- **External cost dashboard.** Rejected: forces the operator out of Telegram and adds a service to host; in-session commands fit the single-user, chat-first model.

## References

- Related ADRs: [ADR-0018 3-tier router + hysteresis](./2026-06-11-model-router-hysteresis-fallback.md), [ADR-0034 Onboarding & operations](./2026-06-11-onboarding-operations-layer.md)
- Specs: [09 Provider Routing](../specs/09-provider-routing.md), [11 Orchestration](../specs/11-orchestration.md), [12 Observability](../specs/12-observability-verification.md), [13 Onboarding & Operations](../specs/13-onboarding-and-operations.md)
- Competitive audit: `memory/competitive-landscape.md`

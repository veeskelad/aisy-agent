# ADR-0037: Eval & Red-Team Harness

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** verification, security, testing

## Context

Aisy's testing today is per-component deterministic acceptance criteria (Phase-3 unit/integration tests) plus the trace-based step verification that is the runtime eval primitive (ADR-0017). That covers correctness of units. It does not cover **adversarial, cross-component** failure: prompt injection that survives across sessions, a degenerate loop that slips under the caps, an exfiltration path that re-assembles a secret across steps, a resurrection-guard bypass via paraphrase, an approval-card replay.

The competitive audit (2026-06-11) showed why this matters. OpenClaw shipped nine CVEs in a five-week window despite having tests — the failures lived *above* the unit level (auth defaults, supply chain, RCE via crafted URL). Goose (Block) ran a public red-team exercise ("Operation Pale Fire"), found a full-laptop-compromise chain via a poisoned recipe + invisible-Unicode injection, shipped fixes, and **published the findings** — which the audit notes earned it trust. Unit tests alone did not prevent either project's architectural failures; an adversarial suite and public disclosure are what separate the credible from the merely tested.

## Decision

Add an adversarial **eval & red-team harness** beyond the per-component unit tests, and commit to **publishing a red-team report before any public release.**

The suite exercises the high-value attack classes against the assembled system: indirect prompt injection (via voice/forward/file/MCP), capability-narrowing bypass, degenerate loops under the cap precedence (period 1/2/3/4+), data exfiltration across steps, resurrection-guard paraphrase bypass, approval-card replay/TOCTOU, and output-channel injection (ANSI/control characters). It runs against the real safety, memory, gateway, and observability components (not mocks of them) and asserts the deterministic guardrails hold.

Two named practices anchor the regression discipline:

- **Golden-trajectory replay.** Save full traces (the append-only journal from Observability 12) for a curated set of representative sessions, replay the identical prompts after every harness change, and diff the resulting trajectories. A diff in the trajectory — a changed tool selection, an altered verdict, a new step — is a regression gate, not just an output-level check.
- **pass^k metric.** Report `pass^k` (all of `k` attempts must succeed — the complement of `pass@k`) rather than relying on `pass@1`. `pass@1` averages over attempts and hides an agent that always fails a fixed slice of cases; `pass^k` surfaces that slice because a single consistent failure drops the score to zero.

Publication: a red-team report is a release gate, following the Goose disclosure practice — finding and openly documenting failures is a trust signal, not an admission.

## Consequences

- **Positive:** catches architectural failures that unit tests structurally cannot; the high-value guardrails (HARD_DENY, resurrection-guard, loop guardian, capability narrowing, approval integrity) get adversarial coverage; public disclosure differentiates Aisy on trust. Golden-trajectory replay makes any behavioral drift from a harness change visible as a trace diff, and `pass^k` keeps a consistently-failing slice from hiding behind a healthy `pass@1` average.
- **Neutral:** a new test harness alongside vitest/pytest; the suite reuses the existing test seams (effect-verifier, provider-fake, sandbox-stub).
- **Negative:** ongoing maintenance as attack classes evolve; the discipline (and exposure) of publishing findings on a schedule.

## Alternatives considered

- **Rely on per-component unit tests only.** Rejected: OpenClaw had tests and still shipped nine CVEs; the residual risk is cross-component and architectural, which unit tests do not reach.
- **Private-only audit.** Rejected: a private audit improves the code but forgoes the trust signal; the audit found public disclosure (Goose) to be the credibility differentiator over silent fixing (OpenClaw's pre-crisis posture).

## References

- Related ADRs: [ADR-0017 External verification by traces](./2026-06-11-external-verification-by-traces.md), [ADR-0020 Loop Guardian](./2026-06-11-loop-guardian.md), [ADR-0027 Capability narrowing](./2026-06-11-capability-narrowing-untrusted-context.md), [ADR-0029 Approval integrity](./2026-06-11-human-confirmation-provenance-binding.md), [ADR-0034 Onboarding & operations](./2026-06-11-onboarding-operations-layer.md)
- Specs: [05 Safety](../specs/05-safety.md), [12 Observability](../specs/12-observability-verification.md), [13 Onboarding & Operations](../specs/13-onboarding-and-operations.md)
- Competitive audit: `memory/competitive-landscape.md`

# ADR-0059: Action Contracts and Verified Completion

**Status:** Accepted
**Date:** 2026-07-26
**Tags:** agent-loop, tools, verification

## Context

The operating prompt asks the model to be resourceful, but provider tool choice
is optional. The model can therefore answer a workspace inspection or mutation
request with prose and no observation. Existing tool-result synthesis only helps
after the first tool call. Plan Mode and trace verification cover plans and
claimed effects, but no code-owned contract currently says that a particular
turn requires observation or mutation evidence.

## Decision

Every turn receives a code-owned `ActionContract` with one of four kinds:
`answer-only`, `inspect-required`, `mutate-required`, or `delegate-required`.
The contract declares allowed tool families, required observations,
postconditions, and approval/autonomy constraints.

- Answer-only turns may finish without tools.
- Inspect-required turns cannot complete with zero relevant observations.
- Mutate-required turns cannot claim success until a postcondition probe passes.
- Delegate-required turns must expose the selected agent, scope, budget, and
  validated result contract.

If a required-action model response contains no suitable tool call, Aisy runs at
most one constrained recovery turn using provider-native tool selection where
available. Failure then becomes a structured blocked result, never fabricated
success. Deterministic hooks, tiers, approvals, budgets, and Plan Mode retain
precedence over the contract.

## Consequences

- **Positive:** dry action responses and false completion become measurable,
  testable failures rather than prompt-quality problems.
- **Positive:** pure conversation stays natural because tools are not forced on
  answer-only turns.
- **Neutral:** intent classification may use deterministic rules plus a bounded
  structured classifier, but the completion invariant is code-owned.
- **Negative:** false-positive action classification adds latency or an
  unnecessary observation; behavioural evals must tune the boundary.
- **Negative:** each mutation family needs a meaningful postcondition probe.

## Alternatives considered

**Strengthen only the system prompt.** Rejected: it remains probabilistic and is
the current failure mode.

**Force a tool on every turn.** Rejected: it harms conversation and encourages
meaningless calls that provide no evidence.

**Trust the final model statement.** Rejected by ADR-0017; self-report is not an
external trace.

## References

- [ADR-0005 — Own Agent Loop](./2026-06-11-own-agent-loop.md)
- [ADR-0017 — External Verification](./2026-06-11-external-verification-by-traces.md)
- [ADR-0026 — Plan Mode](./2026-06-11-plan-mode-clarification-verified-todo.md)
- [ADR-0102 — Tool-Result Synthesis](./2026-07-11-agent-loop-tool-result-synthesis-round.md)

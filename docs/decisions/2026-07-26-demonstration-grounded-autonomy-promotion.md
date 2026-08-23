# ADR-0061: Demonstration-Grounded Scoped Autonomy Promotion

**Status:** Accepted
**Date:** 2026-07-26
**Tags:** autonomy, learning, memory

## Context

ADR-0011 defines useful deterministic risk tiers but exposes one global autonomy
level. The operator's goal is stronger and more personal: Aisy should learn from
their texts, demonstrated actions, approvals, corrections, and result ratings,
then become autonomous for workflows it has repeatedly performed correctly.

A global switch cannot represent “autonomous for this verified publishing flow
in this project, but ask for an unfamiliar deployment.” Prompt-only learning can
also widen permissions without evidence, while unconstrained self-authored skills
can fossilize a transient error.

## Decision

Preserve ADR-0011's deterministic tool tiers and non-bypassable hard gates, but
replace its single global autonomy knob as the only control with versioned,
inspectable **scoped autonomy grants** grounded in operator evidence.

The lifecycle is:

`observe → induce candidate → shadow → operator confirm → assisted runs →
promotion offer → scoped autonomous execution → correct/demote/revoke`.

Demonstrations store references to relevant context, actions, observations,
result, and operator feedback. Candidate facts, preferences, style rules,
procedures, and skills carry provenance, confidence, distinct-session evidence,
project/tool/resource scope, side-effect tier, expiry, version history, and a
rollback pointer.

Promotion requires deterministic validators, successful postconditions across a
configured number of distinct sessions, and operator confirmation. The model may
propose promotion but cannot create or widen a grant. A failed verification or
operator correction records evidence and may automatically demote the workflow.
Tier-3/hard-deny rules remain governed by deterministic policy regardless of
learned confidence.

Operator texts teach style and evaluation criteria through retrieval and
structured preferences. Fine-tuning is deferred until a separately consented,
curated corpus exists.

## Consequences

- **Positive:** autonomy grows where Aisy has demonstrated competence instead
  of forcing a choice between confirm-everything and trust-everything.
- **Positive:** every learned behaviour is explainable, revocable, and
  project/resource scoped.
- **Neutral:** ADR-0011 remains authoritative for risk tiers but is partially
  superseded for autonomy configuration.
- **Negative:** evidence, shadow evaluation, promotion, demotion, and versioned
  rollback add durable state and UI complexity.
- **Negative:** conservative thresholds delay autonomy; permissive thresholds
  increase false promotion risk and require behavioural evaluation.

## Alternatives considered

**One global autonomy level.** Rejected as the sole mechanism because it ignores
task/project competence and cannot learn from operator-specific evidence.

**Let the model promote itself.** Rejected: confidence is not authority and can
be manipulated by untrusted context.

**Automatically fine-tune on all conversations.** Rejected: weak provenance,
privacy risk, difficult forgetting, and no deterministic rollback.

## References

- [ADR-0011 — Autonomy Gradient](./2026-06-11-autonomy-gradient.md) (partially superseded)
- [ADR-0015 — Staged Skills](./2026-06-11-skill-format-staged-creation.md)
- [ADR-0016 — Generator + Separate Judge](./2026-06-11-generator-judge-self-learning.md)
- [ADR-0017 — External Verification](./2026-06-11-external-verification-by-traces.md)
- [ADR-0029 — Human Confirmation Provenance](./2026-06-11-human-confirmation-provenance-binding.md)
- [ADR-0047 — Scoped Approval Grants](./2026-06-16-scoped-approval-grants.md)


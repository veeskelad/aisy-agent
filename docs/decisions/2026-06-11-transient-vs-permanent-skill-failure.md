# ADR-0025: Transient-vs-Permanent Failure for Skills

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** skills

## Context
Aisy can author its own skills (SKILL.md with YAML frontmatter, gated through staging
and human approval). A skill can encode a *negative* lesson — "tool X is unreliable,
avoid it." That is dangerous when the evidence is a single failure.

Public evidence (Hermes #6051): after a transient Playwright outage, an agent wrote a
skill asserting "browser tools non-functional" and kept routing around the browser even
after the tool came back online. The skill fossilized a momentary fault into a permanent
constraint — classic learned helplessness. The agent never re-tested the premise, so a
recoverable hiccup became a permanent capability loss.

This is the skill-layer twin of the memory-deletion failure (ADR-0016): both come from a
write that is never revisited or contradicted. A negative skill born from one data point
is an un-validated, un-expiring fact about the world.

Constraints: the auto-creation path is the same staging-plus-approval flow as any skill
(ADR-0015); we will not add an LLM judge as the sole gate (NIST requires one deterministic
enforcement layer not judged by a model). We also cannot simply forbid recording failures —
an agent with no failure memory repeats the same dead ends every session.

## Decision
Skill auto-creation MUST distinguish transient failures (one-off missing dependency, timeout,
outage) from permanent constraints, and MUST NOT fossilize a negative skill from a single
failure; previously "failed" strategies are periodically retried/sampled before being treated
as unavailable.

Concretely:
- **Evidence threshold.** A negative skill ("avoid tool X") requires N≥3 failures across
  distinct sessions, not one. Below threshold the failure is logged as a *transient note*,
  never a skill.
- **Failure classification.** Each failure is tagged transient (timeout, connection reset,
  HTTP 5xx, missing-dependency) vs permanent (auth denied, capability genuinely absent,
  HARD_DENY). Only repeated permanent-class signals justify a negative skill.
- **No permanent veto.** Even an approved negative skill is advisory, not a HARD_DENY. It
  lowers a strategy's priority; it never deletes the capability.
- **Retry/sample probe.** A background probe periodically (e.g. nightly loop) re-tests
  strategies marked "failed." First success clears the negative skill to staging for removal
  and emits a diff card. This is the un-fossilize valve #6051 lacked.
- **Bi-temporal record.** Negative skills carry valid_at/invalid_at like memory facts
  (ADR-0016); a probe success sets invalid_at instead of hard-deleting.

## Consequences
- **Positive:** No single outage permanently disables a tool; learned helplessness is
  bounded by a deterministic retry loop, not the model's mood. Failures are still recorded,
  so genuinely broken strategies get deprioritized.
- **Neutral:** Adds a failure-classifier and a nightly probe to the self-improvement loop;
  negative skills gain valid_at/invalid_at columns. Probe runs on the cheap routine model
  (V4-Flash $0.14/$0.28).
- **Negative:** A truly dead tool is retried periodically (wasted calls until N permanent
  failures accrue). A flaky tool can oscillate between active and deprioritized; hysteresis
  on the threshold mitigates this, mirroring provider-fallback hysteresis.

## Alternatives considered
**Treat any failure as a permanent constraint.** Simplest to implement and never wastes a
retry — but this *is* the #6051 bug: one Playwright outage permanently blinds the agent.
Rejected as institutionalized learned helplessness.

**Never record failures at all.** Avoids fossilization by keeping no negative memory, but the
agent then re-walks the same dead ends every session, wasting tokens and time on strategies
it already knows fail. Rejected: discards useful signal.

**LLM judge decides transient vs permanent per failure.** Flexible, but at ~70% adherence it
is exactly the unreliable layer NIST says must not be the sole gate, and it would re-introduce
non-determinism into the un-fossilize decision. Used only as an optional hint atop the
deterministic threshold/probe, never as the gate.

## References
- ADR-0015 — [Agent-authored skills: staging and approval](./2026-06-11-skill-format-staged-creation.md)
- ADR-0023 — [Bi-temporal memory and resurrection guard](./2026-06-11-durable-forgetting-tombstones.md)
- Hermes issue #6051 — skill fossilized from a transient failure (learned helplessness)
- mem0 ADD/UPDATE/DELETE/NOOP operations; Zep/Graphiti bi-temporal model

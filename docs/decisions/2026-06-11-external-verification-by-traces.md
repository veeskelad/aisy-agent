# ADR-0017: External Verification by Real Traces

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** verification

## Context
The LLM is a stateless probabilistic CPU with ~70% instruction adherence. A well-known
failure mode follows from that number: the model reports success even when it failed —
it claims a file was written, a row was deleted, or a command ran, while nothing
actually happened. Self-reports are not evidence; they are another probabilistic
token stream from the same unreliable unit.

Verifying AI work is also cognitively harder than producing it: a plausible-looking
diff or a confident "Done." invites a rubber-stamp. So the check cannot live inside the
model's own narration. It must be objective and external — grounded in the world, not
in the transcript.

This is the same category boundary the harness draws everywhere (ADR-0016): irreversible
and critical outcomes are governed by deterministic code, not by the model's judgment.
Acceptance of a result, and especially consolidation of a self-created skill into staging,
are exactly such moments. SKILL.md already mandates a "verification" section; this ADR
defines what makes that section trustworthy.

## Decision
Never trust the model's "done." A separate, deterministic verification layer checks the
claimed effect against real traces — the file exists with expected content, the DB row
actually changed, the API returned the expected status, the process exited 0 — before any
result is accepted or any skill is consolidated.

The verifier runs outside the model's reasoning: it executes concrete probes (stat/read
the file, query the row, re-request the endpoint, inspect exit codes) and compares against
the success criteria declared up front. A claim with no corresponding trace fails, no
matter how confident the narration. Skill consolidation into staging requires passing
traces, never a self-attested pass; staging still waits for human approval.

## Consequences
- **Positive:** Eliminates the silent-failure class where the agent "did" something it
  did not do. Gives a deterministic 100% gate on top of the 70% model. Makes
  consolidation evidence-based, complementing the resurrection-guard validator that
  blocks re-introduction of tombstoned facts.
- **Neutral:** Each action type needs a declared, probeable success criterion; tasks
  with no observable trace (pure prose) fall outside this gate and rely on other review.
- **Negative:** Adds an extra probe step per verified action (latency, a little code per
  trace type); a poorly chosen criterion can give false confidence, so probes must assert
  the actual effect, not a proxy.

## Alternatives considered
**Trust self-reports.** Accept the model's "Done." as the signal. Rejected: this is the
root cause, not a solution — ~70% adherence means a predictable fraction of confident
reports are false, and the failures are silent.

**Have an LLM re-ask itself (or another LLM) "did you really do it?"** A reflection or
judge pass over the same transcript. Rejected: it inspects the narration, not the world,
and inherits the same probabilistic ceiling — a hallucinated success can be re-affirmed
just as confidently. NIST requires at least one deterministic enforcement layer not judged
by an LLM; an LLM checking an LLM does not satisfy it.

## References
- [ADR-0009](./2026-06-11-deterministic-tool-hooks.md) — irreversible actions enforced by deterministic code hooks
- NIST AI RMF — deterministic enforcement layers not judged by an LLM

# ADR-0016: Generator + Separate Judge for Self-Learning

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** skills, memory

## Context
Aisy runs a nightly self-improvement loop that drafts new rules and skills from the
day's traces. The danger is a closed evaluation loop: in Hermes, consolidation runs
with no external judge, so the model that wrote a change is also the one that grades
it — the judge is the defendant. This self-evaluation bias compounds because the loop
learns mainly from "successes" and rarely from corrected failures, so weak or wrong
rules get blessed and fossilized (cf. Hermes #6051, a skill frozen from a transient
failure = learned helplessness). Agent-created skills must never ship straight to
prod (per the skills policy: staging + human approval). We also want cost discipline:
drafting is high-volume routine work suited to a cheap model, while validation must be
independent and a bit sharper. Finally, generated artifacts can silently break the
constitution, reference files that do not exist, or omit the mandatory verification
section — failures that a deterministic check catches with 100% reliability, unlike a
~70%-adherent prompt.

## Decision
The nightly loop separates three roles: a cheap **generator** (DeepSeek V4-Flash)
drafts candidate rules/skills; **deterministic validators** run first and gate
anything malformed; then a **separate judge** (a different model, e.g. Sonnet 4.6)
that does not see the generator's reasoning validates what survives. Output goes to
**staging** and ships to prod only after human approval in the morning card.

- **Deterministic validators (run before the judge, 100% enforcement):**
  `refs_exist` (every referenced file/skill resolves), `no_constitution_conflict`
  (no rule contradicts constitution.md), `dry_run_ok` (skill body executes in the
  network-none, read-only, one-shot sandbox), `has_verification_section` (mandatory
  per skills policy). A failure here drops the candidate; the judge never sees it.
- **Separate judge:** receives only the final artifact and its diff — never the
  generator's chain-of-thought — so it cannot be primed or talked into a pass. A
  different provider/model avoids shared blind spots and collusion.
- **Human gate:** survivors land in `staging/` and surface in the morning card;
  the owner approves, edits, or rejects. Nothing reaches prod unattended.
- **Trust gradient (later):** once a category accumulates a track record of clean
  approvals, low-risk categories (e.g. formatting rules, annotation tweaks) may
  auto-commit; irreversible or safety-touching categories never do.

## Consequences
- **Positive:** Breaks the self-evaluation loop; the grader is independent of the
  author. Cheap drafting (V4-Flash $0.14/$0.28 per 1M) plus selective judging
  (Sonnet 4.6) keeps nightly cost low. Deterministic gates pre-filter, so the judge
  spends tokens only on plausible candidates. Constitution conflicts and dangling
  refs are caught with code, not vibes.
- **Neutral:** Two-model pipeline adds orchestration. Trust gradient is deferred,
  not built now. Judge model choice is configurable via the provider router.
- **Negative:** Higher per-run latency and a second provider dependency. Daily human
  approval is friction until the trust gradient earns auto-commit for safe categories.

## Alternatives considered
**Self-evaluation (one model drafts and grades).** Cheapest and simplest, but it is
exactly the Hermes failure: the judge is the defendant, bias is structural, and errors
fossilize. Rejected.

**Single-stage judge with no deterministic pre-check.** An LLM-only gate can be talked
past, and NIST guidance requires at least one deterministic enforcement layer not
judged by a model. Constitution conflicts and missing files would slip through on the
model's ~70% adherence. Rejected.

**Generate straight to prod, no review.** Maximum speed, zero safety. Contradicts the
no-skip-permissions stance on consequential changes and invites chaos in the live
prompt/skill set. Rejected.

## References
- [ADR-0015](./2026-06-11-skill-format-staged-creation.md)
- [ADR-0023](./2026-06-11-durable-forgetting-tombstones.md)
- Hermes issues #6051 (fossilized skill / learned helplessness), #23023, #25526
- NIST guidance on a deterministic enforcement layer not judged by an LLM

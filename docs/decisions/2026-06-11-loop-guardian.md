# ADR-0020: Loop Guardian (Period 1/2/3 Detection)

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** safety, observability

## Context
Autonomous runs (nightly self-improvement loop, multi-step task execution) call
tools repeatedly with no human in the loop. A stateless LLM (~70% instruction
adherence) can fall into a degenerate cycle: retry the same failing tool, or
oscillate between two or three tools without making progress. Each iteration
spends tokens and, on cheap routine providers like DeepSeek V4-Flash
($0.14/$0.28 per 1M), still adds up over an unattended night.

OpenClaw shipped a loop guard, but it only matched period-1 repeats (the same
call back-to-back). An A-B-A-B oscillation slipped straight through and burned
hundreds of dollars overnight before anyone noticed. The constitution requires at
least one deterministic enforcement layer not judged by the LLM (NIST); a loop
backstop belongs in code (100% adherence), not in a prompt rule (~70%).

Constraints: detection must be cheap (no LLM calls, runs on every tool dispatch),
must not mistake legitimate repetition (e.g. paginating, polling a job) for a
cycle, and must escalate to a human rather than silently abort mid-task.

## Decision
Add a **Loop Guardian** code hook that inspects a sliding window of recent tool
calls (name + normalized arguments) and detects cycles of **period 1, 2, and 3**.
A cycle that repeats more than **3 times** trips the guard: the loop breaks, the
run pauses, and the incident escalates to the human with a diff card.

Detection runs on the structural signature of each call (tool name plus a hashed,
order-insensitive normalization of arguments), so it is deterministic and adds no
model cost. The window is bounded (configurable, default ~12 calls) so memory and
comparison cost stay constant. Period-1 catches retry storms; period-2 catches
A-B-A-B oscillation (OpenClaw's gap); period-3 catches A-B-C-A-B-C. The cap of 3
allows a normal short retry but stops a runaway. On trip, the Guardian writes the
last window to the daily log, sets the STOP signal, and surfaces a review card —
it never deletes work or resumes on its own.

## Consequences
- **Positive:** Closes OpenClaw's A-B-A-B hole; bounds worst-case spend on
  unattended runs; deterministic (no LLM, ~constant cost per dispatch); produces
  an auditable window for post-mortem (observability).
- **Neutral:** Adds a per-dispatch hook on the tool path; cap (3) and window size
  (~12) are tunable and may need tuning per workload.
- **Negative:** Periods >3 (e.g. A-B-C-D-A-B-C-D) are not detected by this
  guard and rely on the separate spend/iteration budget cap; argument
  normalization can in rare cases collapse two genuinely different calls or, if
  too strict, miss a near-identical loop.

## Alternatives considered
**Period-1 only (OpenClaw's design).** Cheapest, but it is exactly what failed:
an A-B-A-B loop is invisible to it and cost real money overnight. Rejected as
demonstrably insufficient.

**Timeout / spend-cap only.** A wall-clock or token budget eventually halts a
runaway, but only after the loop has already run long and spent the budget — it
reacts late and gives no structural signal of *why* it looped. Kept as a
complementary backstop for periods >3, but inadequate as the primary guard.

**No loop control (rely on the LLM to notice).** Worst option: depends on ~70%
adherence to self-correct, the very failure mode being guarded. Rejected.

## References
- Related: [ADR-0009](./2026-06-11-deterministic-tool-hooks.md) (deterministic safety hooks)
- OpenClaw loop-guard limitation (period-1 only); Simon Willison on autonomous-agent runaway loops.

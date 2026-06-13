# ADR-0026: Plan Mode — Planning Phase, Clarification Gate, and Verified TODO Execution

**Status:** Proposed
**Date:** 2026-06-11
**Tags:** architecture, verification, safety

## Context
Two failure modes show up repeatedly with personal agents, and they get worse the
weaker the underlying model is:

1. **"Said done, didn't do."** The model reports a task complete when it never ran
   the action, ran it partially, or ran it and the action silently failed. The
   harness believes the self-report and moves on. On lower-reasoning providers this
   is common, not rare.
2. **Acts before it reasons.** Faced with a multi-step or ambiguous request, the
   model jumps to a tool call on its first plausible interpretation instead of
   decomposing the work, and instead of asking when the request has more than one
   reading. The result is confidently-wrong work that has to be undone.

Both are instances of the project's core split (reversible/creative → model at ~70%
adherence; irreversible/critical → deterministic code at 100%). "Plan before acting"
and "verify before claiming done" cannot live as prompt instructions, because the
prompt is exactly the 70% surface that fails under load. [ADR-0017](./2026-06-11-external-verification-by-traces.md)
already establishes verification by real traces, but only as an end-of-task check.
[ADR-0011](./2026-06-11-autonomy-gradient.md) classifies irreversibility, and
[ADR-0021](./2026-06-11-coordinator-workers-orchestration.md) gives workers a
decision journal — but there is no first-class **planning phase**, no **per-step**
verification, and no **clarification gate**. This ADR adds them.

## Decision
Introduce **Plan Mode**: a loop state that forces an explicit, code-gated planning
phase before mutating actions, executes a verified TODO, and halts on ambiguity. The
*content* of the plan stays with the model; the *enforcement* is deterministic code.

**1. Trigger (deterministic).** Before acting, code computes a planning score from:
the highest [autonomy tier](./2026-06-11-autonomy-gradient.md) the request is likely
to reach (irreversibility), an estimated step count, and an ambiguity score. Plan
Mode is entered when that score crosses a threshold **or** when the user explicitly
asks for it (phrases like "продумай" / "спланируй", a `/plan` command, or a
multi-step request). Trivial, single-step, reversible tasks bypass it and run
directly — the gate is calibrated to be livable, like the tiering in ADR-0011.

**2. Plan artifact (model writes, code lints).** The model emits a structured plan
(`PLAN.md` / `TODO.md`, following the anima_sdk file-state pattern): an ordered list
of steps, each carrying `intent`, the `tool(s)` it will use, and an explicit
**verification trace** — the observable evidence that will prove the step done (a
file exists, a DB row changed, an exit code is 0, an API returned 2xx). A
deterministic linter rejects a plan in which any step lacks a verification trace, or
in which an irreversible step is unflagged.

**3. Plan→execute gate (deterministic).** The loop cannot call a mutating tool until
a lint-passing plan exists. For requests that reach Tier 3, the plan is also shown to
the user for approval before execution. This is a hard stop in code, not a request.

**4. Verified per-step execution (deterministic).** After each step, the harness runs
that step's declared verification trace **before** the step may be marked done. **The
model cannot self-mark a step complete** — only a passing trace closes it. A step
whose trace fails is marked failed, not done; this is what kills "said done, didn't
do" at the step level, generalising ADR-0017 from the final result to every TODO item.

**5. Clarification gate (deterministic, mandatory on ambiguity).** If the ambiguity
score is above threshold, or the model surfaces more than one plausible
interpretation, code **halts the loop and forces a question to the user**. The agent
may not proceed on a guess. The model writes the question; the code enforces that one
is asked.

**6. Re-plan, don't bulldoze.** If a bounded number of steps fail verification, or
reality diverges from the plan, code forces a re-plan (model revises `PLAN.md`)
instead of letting execution continue blindly.

## Consequences
- **Positive:** "Said done, didn't do" is caught by code, not trust — a step closes
  only on a real trace. Irreversible work is reasoned about before it runs. The
  clarification gate stops wrong-guess work at the source. Weak providers get
  deterministic scaffolding (forced decomposition + forced verification) that
  compensates for low native reasoning — the harness makes a mediocre model behave
  carefully. The plan is a human-readable artifact the user can inspect and correct.
- **Neutral:** Requires a `PLAN.md`/`TODO.md` schema and an ambiguity scorer (a cheap
  heuristic plus an optional small-model pass). Plan Mode is a loop state in
  [ADR-0005](./2026-06-11-own-agent-loop.md) and an artifact for the coordinator in
  [ADR-0021](./2026-06-11-coordinator-workers-orchestration.md); it reuses, not
  replaces, the verification machinery of ADR-0017.
- **Negative:** Planning adds latency and tokens. Over-triggering on simple tasks is
  the main risk — mitigated by the trivial-task bypass and a tunable threshold. A
  too-sensitive clarification gate becomes nagging — the threshold is tunable, and
  the gate is mandatory only above it. The verification-trace declaration is only as
  good as the trace the model writes; a vacuous trace (e.g. "echo ok") that the linter
  doesn't catch can still pass — the linter's trace-quality rules are themselves
  worth review.

## Alternatives considered
**Prompt-only "please plan first / verify before saying done."** This is the 70%
surface that already fails — it is the exact origin of both failure modes. Rejected
as the primary mechanism; the deterministic gate is the point.

**Trust the model's self-report of step completion.** This *is* the bug. Self-report
is precisely what lets "said done, didn't do" through. Rejected.

**Always-on planning for every request.** Maximally safe but unlivable: it taxes
trivial, reversible tasks with latency and tokens and trains the user to ignore plans.
Rejected in favour of a risk/complexity threshold plus explicit opt-in.

**ReAct-style reason-then-act without a verification gate.** Adds reasoning but still
lets the model self-close steps, so "said done, didn't do" survives. Reasoning without
a trace gate is insufficient.

**Vector/embedding-based intent disambiguation instead of asking.** Guessing harder is
still guessing; for an ambiguous *instruction* the correct action is to ask the human,
not to retrieve a more confident wrong answer.

## References
- [ADR-0017](./2026-06-11-external-verification-by-traces.md) — verification by real traces (generalised here to per-step)
- [ADR-0011](./2026-06-11-autonomy-gradient.md) — irreversibility tiers feed the planning trigger
- [ADR-0021](./2026-06-11-coordinator-workers-orchestration.md) — the plan/TODO as coordinator artifact
- [ADR-0005](./2026-06-11-own-agent-loop.md) — Plan Mode is a state in the owned loop
- anima_sdk `STATE.md` / `TODO.md` file-state pattern between turns

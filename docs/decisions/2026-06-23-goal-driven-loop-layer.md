# ADR-0054: Goal-Driven Loop Layer (`/goal`)

- **Status:** Accepted
- **Date:** 2026-06-23
- **Related:** ADR-0039 (goal-DAG / per-spawn delegation — distinct), ADR-0019 (stable-prefix KV-cache), ADR-0027 (capability narrowing), ADR-0047 (scoped approval grants)

## Context

The operator wants a **persistent session objective** and a **verify-until-done loop** running on top of the existing turn-based agent. The reference models are Claude Code's `/goal` command and the ANIMA persistent-agent pattern.

This is distinct from the orchestration goal-DAG (ADR-0039), which decomposes a per-spawn task into a directed graph of delegated sub-agent calls. The goal-driven loop is a *top-level session objective*: a single goal, held across turns, with the agent iterating until it proves the goal is met.

The existing primitives already cover most of the plumbing:

- `makeAgentLoop` + `runTurn` — the turn-based loop (Core; must stay untouched)
- `VerificationTrace` + the Tier-4 probe infrastructure — deterministic external verification
- `Halt('budget-capped')` + `AbortSignal` — cost ceiling and hard-stop (Tier-2/3 seams)
- In-process scheduler (Tier-4) — periodic firing
- Bot proactive-turn seam — channel for orchestrator-initiated turns
- Scoped approval grants (ADR-0047) — pre-authorisation of a tool scope

## Decision

**An app-level goal orchestrator is layered on top of the turn-based loop. Core (`makeAgentLoop`) is not modified.**

### Architecture

A new `makeGoalOrchestrator` function lives in `@aisy/app`. It coordinates exclusively through the bot's public seam (the same proactive-turn channel used by the Tier-4 trigger engine). The bot retains sole ownership of `currentAbort`, `agentState`, and approval-cards; the orchestrator never reaches into those directly.

Core gains two additive, non-breaking pieces:

- `goals/` types module — `GoalSpec`, `GoalState`, `GoalResult`
- `goal_done` — a **Tier-0 tool** (never gated, no side effect) the model calls to claim completion

### Three modes

| Mode | Behaviour |
|------|-----------|
| `until` | Loop until the goal is verified done (or the backstop fires) |
| `every:<interval>` | Fire one turn per scheduler tick (relative interval; cron/HH:MM deferred) |
| `budget:<n>` | Loop until a token or dollar ceiling is reached |

### Completion — `until` mode

1. The model calls `goal_done`; the orchestrator's per-turn executor wrapper sets a `claimedDone` flag (the agent loop does not surface tool calls to the orchestrator).
2. A deterministic `VerificationTrace` probe then runs.
3. Completion is confirmed **only** if the probe passes.
4. On probe failure: the failure is fed back as context and the loop continues.
5. When no probe is configured: `goal_done` alone is sufficient (still bounded by the backstop below).

`goal_done` is Tier-0: it never triggers an approval card and has no side effect.

### Always-on backstop (non-negotiable anti-runaway)

Every goal carries a hard `maxIterations` + token ceiling + dollar ceiling, checked **before** each turn. Defaults are env-configurable:

- `AISY_GOAL_MAX_ITERATIONS`
- `AISY_GOAL_TOKEN_CEILING`
- `AISY_GOAL_DOLLAR_CEILING`

`/stop` (and `/goal stop`) halt the goal at any time via a goal-scoped `AbortController`.

State is persisted every iteration to `~/.aisy/goal.json` → crash-resumable; counters cannot reset.

### Pre-grant scope at start

When a goal is created, the operator pre-authorises a tool scope recorded as tier-2 grants (ADR-0047). The **default scope is read-only** (`read_file`, `list_dir`, `search_memory`) unless `AISY_GOAL_SCOPE` overrides.

Locked invariants:

- A grant suppresses only a tier-2 `ask`; it **never** overrides a `deny`.
- **Tier-3 is never grantable.** A tier-3 step mid-goal pauses the orchestrator and waits for an explicit operator tap; the orchestrator resumes once with `approvalToken: planHash`.

## Consequences

### Positive

- Autonomous multi-turn goal pursuit with layered safety: always-on backstop, `/stop` kill-switch, read-only-default scope, tier-3 still gated regardless of grants.
- Core (`makeAgentLoop`) and the turn-based loop are untouched — no regression surface.
- Reuses the Tier-4 scheduler and `VerificationTrace` probe infrastructure (no new primitives).
- Reuses the bot proactive-turn seam (no new bot API).
- `~/.aisy/goal.json` persistence enables crash-resume without replaying turns.

### Trade-offs and follow-ups

- `every` mode supports relative intervals only in v1; cron/HH:MM scheduling is deferred.
- `goal.json` is loaded on each scheduler tick (negligible cost; caching deferred).
- A sub-agent that calls `goal_done` hits Core's tool sentinel, not the goal orchestrator's wrapper — the `claimedDone` flag is not set in that edge case (documented, not blocked).
- v1 supports a **single active goal**; parallel goals are deferred.
- Nightly-style boot-time startup of goals is not in scope.

## Alternatives considered

| Alternative | Reason rejected |
|-------------|-----------------|
| `makeGoalRunner` inside Core | Core cannot reach `currentAbort`, `agentState`, or approval-cards — the bot owns those; a Core runner would either need a new injection surface or would silently skip safety invariants. |
| Semantic completion only (no probe) | The operator explicitly required *tests verify after claim*; claim-only completion cannot distinguish "model believes done" from "actually done". |
| No backstop | Non-negotiable. Unbounded loops are an anti-pattern; the backstop is a hard requirement, not optional hardening. |

## References

- ADR-0039: First-Class Sub-Agent Delegation (goal-DAG, per-spawn — distinct from this ADR)
- ADR-0019: Stable-Prefix KV-Cache
- ADR-0027: Capability Narrowing When Untrusted Content Is in Context
- ADR-0047: Scoped Approval Grants — once / session / always
- ADR-0051: Loop Control Seams — Turn Abort & Mid-Turn Budget
- ADR-0053: Proactivity — In-Process Scheduler & Nightly Generator/Judge
- Plan: [`docs/superpowers/plans/2026-06-23-tier7-goal-driven-loop.md`](../superpowers/plans/2026-06-23-tier7-goal-driven-loop.md)

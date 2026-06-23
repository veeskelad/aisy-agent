# Tier 7 — Goal-Driven Loop (`/goal`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps are phased (A–F); each phase is one task with embedded TDD.

## Context

The operator wants a persistent **session objective** with a **verify-until-done loop** layered on the existing turn-based agent (à la Claude Code `/goal` + `/loop`; ANIMA persistent-agent model). Today `aisy` is turn-based: one message → one `runTurn` → reply. `/goal` lets the agent work toward an objective across many turns autonomously, with three operator-chosen loop modes: **until** (loop until achieved), **every:<interval>** (re-run on a schedule), **budget:<n>** (loop until a token/$ ceiling).

Consequential loop-driving change (turn-based → goal-driven) → **ADR-0054**. Distinct from the orchestration goal-DAG (ADR-0039, per-spawn delegation). Locked decisions:
1. **Completion (until):** the model claims done via a new `goal_done` tool; THEN a deterministic verification probe confirms — complete ONLY if the probe passes; probe-fail → continue with the failure fed back; no probe → fall back to the claim alone (bounded by the backstop).
2. **Always-on backstop:** every goal carries a hard `maxIterations` + token/$ ceiling (configurable) and `/stop` halts anytime. Non-negotiable anti-runaway.
3. **Pre-grant at start:** the operator pre-authorizes a tool scope (tier-2 grants) so the autonomous loop runs without pausing for tier-2 asks. **Tier-3 is never grantable** → a tier-3 step mid-goal still pauses for an explicit tap.

**Key constraint:** the goal-loop lives **app-level** (a new orchestrator coordinated with the bot) — only the bot owns `currentAbort`, `agentState`, the approval pending-cards, and `runTurn`. Core's `makeAgentLoop` stays **untouched**; the only Core additions are additive (a `goal_done` tool + a `goals/` types module).

## Global Constraints
- License Apache-2.0; brand "Aisy", affirmative only; `research/` never referenced.
- TS strict + `exactOptionalPropertyTypes` (conditional spreads, never pass `undefined`) + `noUncheckedIndexedAccess` + Node16 ESM (`.js` extensions); vitest.
- Single active goal (v1, single-user), persisted + resumable. Staging/safety invariants: pre-grant suppresses ONLY tier-2 `ask`, NEVER a `deny`; tier-3 never grantable.
- Reuse: `makeTriggerProbeRunner` (trigger-probe.ts), Tier-4 `makeScheduler`, the bot proactive seam, `GrantStore.record`, `parseProbe`/`parseWhen` (aisy.ts), `spend`/`budget`. Don't rebuild.
- TDD, frequent commits; each phase ends green (`pnpm -r build` + `pnpm -r test`); existing 742 core + 89 gw + 9 app stay green.

## Phase A — GoalSpec + goal store
- New `packages/core-ts/src/goals/types.ts`: `GoalMode = {kind:'until';probe?:VerificationTrace} | {kind:'every';cron?;intervalMs?} | {kind:'budget';tokenCeiling?;dollarCeiling?}`; `GoalBackstop {maxIterations;tokenCeiling;dollarCeiling}`; `GoalUsage {inputTokens;outputTokens;dollars}`; `GoalSpec {id;objective;mode;backstop;grantedScope:string[];status:'active'|'completed'|'halted'|'stopped';iterationsSpent;usageSpent;lastFeedback?;haltReason?;createdAt;updatedAt}`; `GoalStore {load():Promise<GoalSpec|null>;save(spec):Promise<void>;clear():Promise<void>}`.
- New `packages/core-ts/src/goals/index.ts`: re-export + `makeGoalSpec(input):GoalSpec`. Barrel-export from `index.ts`.
- New `packages/app/src/goal-store.ts`: JSON single-object store (near-copy of trigger-store.ts); load→null when absent/non-active; save mode 0o600; clear unlinks.
- Tests: `goal-store.spec.ts` (round-trip; null absent/non-active; clear; mode-variant serialization).

## Phase B — `goal_done` tool + detection seam
- `packages/core-ts/src/tools/types.ts`: add `'goal_done'` to `BaseToolName` (Tier-0; never gated; no side effect).
- `packages/core-ts/src/runtime/execute-tool.ts`: `case 'goal_done':` → sentinel `{ok:true,output:'__goal_done__'}`.
- App detection: the orchestrator's per-turn executor wrapper sets `claimedDone=true` on `goal_done`, else delegates; resets per iteration.
- Add `goal_done` to the `TOOLS` array in `aisy.ts`.
- Tests: extend `execute-tool.spec.ts` (goal_done → sentinel, no side effect).

## Phase C — Goal-orchestrator loop (`packages/app/src/goal-orchestrator.ts`) — the core
Pure, fully injected. Deps: `store`, `runGoalTurn`, `probeRunner`, `recordGrant`, `sendProgress`, `clock`, `sleep?`, `emit?`. `runGoalTurn(input:{objective;feedback?;approvalToken?;signal}) → {state;haltReason?;planHash?;usage?;claimedDone;reply}`.
- `iterate(spec,signal)`→'done'|'continue'|'halted'|'stopped': abort check → backstop pre-check (iterations≥max; usage≥backstop ceiling; budget-mode ceiling) → runGoalTurn → iterationsSpent++/usageSpent+=/save-every-iteration → branch on state (awaiting-approval→progress+re-call once with approvalToken:planHash; halted→stopped/halted; awaiting-clarification→feedback+continue) → completion (claimedDone → probe? pass=done/fail=continue+feedback : no-probe=done; not-claimed→feedback+continue).
- `start()` (until/budget): recordGrant once → loop until non-continue. `tick()` (every): one iterate/tick. `resume()` (boot): re-grant + re-enter (until/budget) or leave for scheduler (every); persisted counters continue (crash-loop can't reset backstop). Same abort signal as `/stop`.
- Tests (merge gate): `goal-orchestrator.spec.ts` — until claim+probe-pass→completed; claim+probe-fail→continue+feedback; no-probe claim→completed; backstop iterations halt; backstop usage halt; abort→stopped; budget ceiling; every=one turn/tick; awaiting-approval pause+resume (tier-3 not auto-granted); save() every iteration.

## Phase D — Bot: `runGoalTurn` seam + commands (`packages/app/src/bot.ts`)
- New returned-object seam `runGoalTurn(input)`: wait-for-idle, run ONE turn through a goal-scoped runner (executeTool = goal wrapper), seed objective+feedback spans (operator provenance), thread signal+approvalToken, reuse approve/currentAbort/spend/setOutboundLocked; return the full shape (not void).
- `TelegramBotDeps.onGoalCommand?` (decoupled): `{kind:'start';objective;mode:string}|{kind:'status'}|{kind:'stop'}` → `{ok:true;message}|{ok:false;error}`.
- Commands: `/goal <objective> [until[:probe]|every:<10m|@daily|HH:MM>|budget:<0.50|50000>]`, `/goal status`, `/goal stop` (status=stopped+clear; `/stop` stays hard-kill). Progress via sendProactive. Build-verified (no bot harness).

## Phase E — Bin wiring (`packages/app/src/bin/aisy.ts`)
- goalStore (`~/.aisy/goal.json`); `parseGoalMode(raw)` (reuse parseProbe + parseWhen-regex/cron); backstop env defaults (`AISY_GOAL_MAX_ITERATIONS`~25, `AISY_GOAL_TOKEN_CEILING`~500k, `AISY_GOAL_DOLLAR_CEILING`~5); `recordGrant:(t)=>grants.record(t,'session')`; reuse triggerProbe; `makeGoalOrchestrator`; `onGoalCommand` wires start/status/stop; scheduler optional `tickGoal`; `await orchestrator.resume(signal)` before bot.start(); goal-scoped AbortController aborted by `/stop` + `/goal stop`. Tests: `parseGoalMode` spec.

## Phase F — ADR-0054 + INDEX + ROADMAP
- New `docs/decisions/2026-06-23-goal-driven-loop-layer.md` (ADR-0054, Accepted): goal-driven layer on turn-based loop; 3 modes; model-claims→probe-verifies; always-backstop+/stop; pre-grant tier-2-only; app-level orchestrator (Core untouched); goal_done Tier-0 tool + executor-sentinel; distinct from goal-DAG.
- INDEX.md: ADR-0054 row above ADR-0053.
- ROADMAP.md: mark Tier 7 done + **add Tier 8 — caching** (per this session's semantic-cache research): (1) finish PREFIX caching ADR-0019 (`cache_control: ephemeral` in adapters — safe high-ROI, zero wrong-answer risk); (2) optional narrow exact-cache on eval-replay + nightly retries; (3) semantic-response cache ONLY behind ADR-0031 embeddings, read-only paths, invariants (no cross-session; invalidate on narrowed/forget; key includes prefixHash) — never the live loop.

## Verification
- `pnpm -r build` clean (3 packages) + `pnpm -r test` green; new orchestrator/store/parse + goal_done tests pass.
- Orchestrator unit tests = merge gate (3 modes + completion + backstop + abort + approval-pause).
- Manual smoke (deferred, no live token): `/goal "<obj>" budget:0.10` loops+progress+halts at ceiling; `until:file:/tmp/x` completes on claim+probe-pass; `every:1m` one turn/min; `/stop` halts; restart resumes.
- subagent-driven: implementer → spec+quality review per phase → final whole-branch review on the strongest model (scrutinize orchestrator mode/approval/abort branches + goal_done detection — this gate caught real cross-seam bugs in Tier 2/3/4).

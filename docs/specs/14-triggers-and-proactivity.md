# Component 14: Triggers & Proactivity — Specification

**Status:** Draft (implementation scheduled for v0.2)
**Component:** 14 / 14
**Related ADRs:** ADR-0038, ADR-0017, ADR-0011, ADR-0027, ADR-0029, ADR-0018
**Depends on:** Core / Agent Loop (01), Provider Routing (09), Safety (05), Gateway (02), Observability (12)

> Triggers & Proactivity is the deterministic scheduler that lets Aisy act
> without being messaged: one-shot reminders, recurring schedules, and
> condition watches — each fired through a two-phase, budget-capped pipeline
> whose first phase costs **zero model tokens**, so a quiet trigger costs
> nothing and a noisy one can never run the bill.

## 1. Purpose

Without this component the harness is purely reactive: it acts when the
operator messages it, plus one fixed nightly consolidation. "Remind me
tomorrow", "send a morning digest", "watch this CI job and tell me when it
goes red" are impossible. The competitive audit showed proactivity is one of
the most-wanted personal-agent behaviors (Khoj automations, OpenClaw
heartbeat) — and also one of the most dangerous to build naively: OpenClaw's
heartbeat loaded the full context every 30 idle minutes, burning 2–3M
tokens/day doing nothing.

The split between deterministic code and the model is sharp:

- **Deterministic code (100%):** the trigger store, the tick loop, due-time
  and cron evaluation, the phase-1 probe (reusing the `VerificationTrace`
  machinery of ADR-0017 — file/sql/http/exit, no LLM anywhere in it),
  per-trigger and global background budgets, the operator-confirmation gate
  for agent-created triggers, expiry, and cancellation.
- **The model (~70%):** only the *content* of the turn a firing wakes — what
  the agent says or does once woken. It never decides whether a trigger
  fires, never creates an active trigger without an operator card, and never
  sees the probe mechanics.

**The two-phase firing rule (anti-OpenClaw):**

```
tick → [phase 1: deterministic check — 0 model tokens]
         remind:   fireAt <= now ?
         schedule: cron matches now ?
         watch:    probeRunner(trace) — file/sql/http/exit probe
       → no  → sleep (cost: ~0)
       → yes → [phase 2: wake ONE agent turn with minimal context + the
                trigger's own budget]
```

## 2. Responsibilities

What this component **owns**:

- The **trigger store**: persistent `TriggerSpec` records (remind / schedule /
  watch), created by an operator turn or — for agent-proposed triggers — only
  after a Gateway (02) confirmation card (ADR-0029).
- The **tick loop**: a deterministic scan driven by the injected Clock; due
  reminders fire once and self-disable, schedules fire and stay enabled,
  watches run their phase-1 probe.
- **Phase-1 probes**: reuse of the enumerated `VerificationTrace` probe set
  (ADR-0017). A watch is *defined* by a trace — there is no free-form "check
  this" prompt in phase 1.
- **Budgets**: a per-trigger token/dollar ceiling and a global background
  budget, both enforced in code before a phase-2 turn starts (same mechanism
  as Provider 09 / Eng-12). A trigger that exhausts its budget is paused and
  reported, never silently retried.
- **Provenance**: anything a watch observed (page body, file content, query
  rows) enters the woken turn as `untrusted` spans — capability narrowing
  (ADR-0027) applies automatically.
- Trigger lifecycle: list, cancel, expiry, pause-on-budget, and the
  `trigger.*` journal events (Observability 12).

What this component **does not** do (boundary → owner):

- It does **not** run the woken turn — that is **Core / Agent Loop (01)**;
  the engine only calls `startTurn` with the trigger's prompt and budget.
- It does **not** decide what the agent may do once awake — tiers, HARD_DENY,
  narrowing are **Safety (05)** as in any turn.
- It does **not** render `/remind`, `/watch`, `/schedule` commands or the
  confirmation cards — that is **Gateway (02)** / **Onboarding (13)**.
- It does **not** replace the nightly consolidation cron — Nightly (10) keeps
  its own fixed schedule; this component is for *operator-defined* proactivity.

## 3. Interfaces

```ts
// illustrative, not binding

type TriggerKind = 'remind' | 'schedule' | 'watch'

interface TriggerBudget {
  tokenCeiling: number
  dollarCeiling: number
  tokensSpent: number
  dollarsSpent: number
}

interface TriggerSpec {
  id: string
  kind: TriggerKind
  createdBy: 'operator' | 'agent'   // agent-created requires a card confirm before it can fire
  confirmed: boolean                 // set ONLY via the approval path (ADR-0029)
  prompt: string                     // what the woken turn is asked to do
  fireAt?: string                    // remind: ISO-8601 one-shot
  cron?: string                      // schedule: cron expression
  probe?: VerificationTrace          // watch: phase-1 predicate (ADR-0017 probe set)
  intervalMs?: number                // watch: how often phase 1 runs
  budget: TriggerBudget              // per-trigger ceiling
  expiresAt?: string
  enabled: boolean
}

interface TriggerFiring {
  triggerId: string
  firedAt: string                    // injected Clock
  phase1: 'due' | 'condition-met' | 'no-change' | 'budget-paused' | 'skipped'
  turnStarted: boolean               // true only when phase 2 actually woke the agent
}

interface TriggerEngineDeps {
  clock: Clock                                            // injectable; tick never reads Date.now()
  probeRunner(trace: VerificationTrace): Promise<boolean> // shared with agent-loop (ADR-0017)
  startTurn(input: { triggerId: string; prompt: string; spans: ContextSpan[]; budget: TriggerBudget }): Promise<void>
  store: TriggerStore                                     // persistence seam
  emitEvent(event: string, payload: unknown): void        // Observability 12
  globalBackgroundBudget: TriggerBudget                   // shared cap across ALL triggers
  /** Watch observations entering the woken turn — stamped untrusted by code. */
  observe?(trace: VerificationTrace): Promise<string>
}

interface TriggerEngine {
  /** Operator-created triggers register active; agent-created register
   *  pending until a card confirm (the engine never self-confirms). */
  register(spec: Omit<TriggerSpec, 'confirmed' | 'enabled'>): Promise<TriggerSpec>
  confirm(triggerId: string): Promise<void>   // called by the approval path only
  cancel(triggerId: string): Promise<void>
  list(): Promise<TriggerSpec[]>
  /** One deterministic scan; returns what fired and why. */
  tick(): Promise<TriggerFiring[]>
}
```

Events emitted (12): `trigger.registered`, `trigger.pending_confirmation`,
`trigger.confirmed`, `trigger.fired`, `trigger.no_change`,
`trigger.budget_paused`, `trigger.expired`, `trigger.cancelled`.

## 4. Data structures

**`TriggerSpec`** (see §3) — at rest in the trigger store (SQLite table or
JSONL; same durability rules as the session log). `confirmed` is the
load-bearing field for agent-created triggers: written only by the approval
path, never by the model, never by `register()` for `createdBy: 'agent'`.

**Budget composition** — two ceilings, both code-enforced *before* phase 2:

| Cap | Scope | On breach |
|---|---|---|
| `TriggerSpec.budget` | one trigger | trigger paused + reported (`budget-paused`), never silent retry |
| `globalBackgroundBudget` | all triggers | no trigger fires until the window resets / operator raises it |

**Phase-1 probe** — exactly one `VerificationTrace` (`file | sql | http |
exit`). The same R3/R4-style sanity applies: a vacuous probe (`echo`) is
rejected at registration.

## 5. Behavior & control flow

```
tick(now)                                       -- deterministic, injected Clock
  for each enabled, confirmed, unexpired trigger:
    [budget gate] trigger budget left AND global budget left?   no → budget-paused (report once)
    [phase 1 — 0 model tokens]
      remind:   fireAt <= now            → due (then enabled=false: one-shot)
      schedule: cron matches now         → due (stays enabled)
      watch:    intervalMs elapsed?      → probeRunner(probe)
                 false → no-change (sleep)
                 true  → condition-met
    [phase 2 — only on due/condition-met]
      spans = watch ? [{provenance:'untrusted', text: observe(probe)}] : []
      startTurn({triggerId, prompt, spans, budget})
      journal trigger.fired
```

Invariants, all in code:

- A `no-change` tick performs **zero** model calls and starts **zero** turns.
- An agent-created trigger with `confirmed === false` never fires, regardless
  of due time.
- Watch observations are `untrusted` — the woken turn starts narrowed
  (ADR-0027): the agent can read and tell the operator, but outbound stays
  locked until a clean operator turn.
- The woken turn runs under the trigger's own budget; its spend debits both
  the trigger budget and the global background budget.
- `tick()` reads time only from the injected Clock — fully deterministic in
  tests, no `Date.now()` anywhere.

## 6. Dependencies

Internal: Core (01) `startTurn` + `VerificationTrace` probe set (ADR-0017);
Provider (09) budget mechanics; Safety (05) narrowing on woken turns; Gateway
(02) `/remind` `/schedule` `/watch` commands + confirmation cards; Onboarding
(13) surfaces trigger list in `/status`; Observability (12) journal.

External: none beyond the host clock source the injected Clock wraps.

## 7. Failure & degraded modes (mandatory)

| Failure | Trigger | Detection | Behavior | Operator sees | Recovery |
|---|---|---|---|---|---|
| Probe errors (network down, file gone) | phase-1 probe throws | try/catch around probeRunner | **Count as `no-change`** + journal `trigger.probe_error`; N consecutive errors (default 5) → pause + report | nothing until pause; then a report card | operator re-enables / fixes target |
| Trigger budget exhausted | phase-2 spend reaches ceiling | budget gate | **Pause trigger**, report once, never silent retry | "watch X paused: budget spent" | operator raises budget / re-enables |
| Global background budget exhausted | sum of background spend at cap | budget gate | **No trigger fires**; one summary report | "background paused until window reset" | window resets / cap raised |
| Engine down (crash) | process restart | store is durable | Missed reminders fire on next tick if still unexpired; schedules skip missed slots (no catch-up storm) | possibly late reminder | restart; tick resumes |
| Clock skew / DST | injected Clock jumps | monotonic guard on tick | never fire the same trigger twice for one due-time (idempotency key = trigger id + due slot) | no double pings | n/a |
| Agent-created trigger spam | model proposes many triggers | confirmation gate | each pends a card; unconfirmed never fire; pending count capped | cards to approve or ignore | reject / expire |

## 8. Security & threat model

| Threat | Vector | Deterministic mitigation (code) | ADR |
|---|---|---|---|
| **Token-drain heartbeat** (financial DoS) | naive periodic full-context wake (OpenClaw class) | two-phase firing: phase 1 is 0-token probe; phase 2 budget-gated per trigger + globally | ADR-0038, ADR-0018 |
| **Injection via watched content** (OWASP-LLM01) | watched page/file carries instructions | observation enters as `untrusted` → narrowing locks outbound in the woken turn | ADR-0027 |
| **Model self-scheduling** (Excessive Agency) | agent registers a trigger that exfiltrates nightly | agent-created triggers pend until an operator card confirm; `confirmed` writable only by the approval path | ADR-0029 |
| **Trigger as persistence backdoor** | injected content asks agent to "create a watch" that re-injects later | same card gate + watch observations always untrusted — the loop cannot be laundered into trusted context | ADR-0027/0029 |
| **Probe as side channel** | a crafted `http` probe exfiltrates via URL | probes go through the same egress allowlist as any outbound (Safety 05); registration rejects probes against non-allowlisted hosts | ADR-0010 |

## 9. Acceptance criteria (mandatory)

1. **AC-14-1** — A `remind` whose `fireAt <= now` fires exactly once: `tick()` reports `due`, `startTurn` is called once with the trigger's prompt, and the trigger is disabled afterwards (one-shot).
2. **AC-14-2** — A `remind` whose `fireAt > now` does not fire: no `startTurn`, firing reported as `no-change`/absent.
3. **AC-14-3** — A `schedule` fires on a matching cron tick and remains enabled for the next match.
4. **AC-14-4** — A `watch` whose phase-1 probe returns false starts **zero** turns and performs **zero** model calls (`startTurn` never invoked).
5. **AC-14-5** — A `watch` whose probe returns true wakes exactly one turn whose spans carry the observation with `provenance === 'untrusted'`.
6. **AC-14-6** — A trigger whose per-trigger budget is exhausted is paused: `tick()` reports `budget-paused`, `startTurn` is not called, and a pause report is journaled exactly once.
7. **AC-14-7** — When the global background budget is exhausted, no trigger fires regardless of individual budgets.
8. **AC-14-8** — An agent-created trigger (`createdBy: 'agent'`) with `confirmed === false` never fires even when due; `register()` reports it as pending confirmation.
9. **AC-14-9** — `confirm()` is the only path that activates an agent-created trigger; after it, the same due tick fires.
10. **AC-14-10** — An expired trigger never fires; `cancel()` removes a trigger so a subsequent due tick does nothing.
11. **AC-14-11** — `tick()` reads time only from the injected Clock: two engines over identical stores and clocks produce identical `TriggerFiring[]`.
12. **AC-14-12** — Every firing and pause appends a `trigger.*` journal event (fired / no_change suppressed to one per state change / budget_paused).
13. **AC-14-13** — Registration rejects a watch probe that is vacuous (`exit` argv `echo`-class) or self-referential, reusing the plan-linter R3/R4 checks.
14. **AC-14-14** — The same due slot never fires twice across a crash/restart (idempotency by trigger id + due slot).

## 10. Open questions

- **Cron dialect** — full 5-field cron vs a constrained subset (`@daily`,
  `@hourly`, fixed HH:MM) for v0.2; constrained subset favored to keep parsing
  deterministic and reviewable.
- **Watch interval floor** — minimum `intervalMs` (rate-limit on probes
  against external hosts) to be set with Safety; likely ≥60s.
- **Missed-schedule policy** — current spec says skip missed slots (no
  catch-up storm); revisit if digest use-cases need catch-up.

## 11. References

- ADRs: [ADR-0038 Triggers & proactivity](../decisions/2026-06-12-triggers-and-proactivity.md), [ADR-0017 Verification by traces](../decisions/2026-06-11-external-verification-by-traces.md), [ADR-0011 Autonomy gradient](../decisions/2026-06-11-autonomy-gradient.md), [ADR-0027 Capability narrowing](../decisions/2026-06-11-capability-narrowing-untrusted-context.md), [ADR-0029 Approval integrity](../decisions/2026-06-11-human-confirmation-provenance-binding.md)
- Specs: [01 Core](./01-core-agent-loop.md), [09 Provider Routing](./09-provider-routing.md), [13 Onboarding & Operations](./13-onboarding-and-operations.md)
- Competitive evidence: OpenClaw heartbeat token-drain; Khoj automations demand (memory/competitive-landscape.md)

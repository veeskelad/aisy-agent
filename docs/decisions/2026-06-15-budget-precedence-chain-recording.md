# ADR-0041: Budget-Precedence Chain Recording (AC-11-9)

**Status:** Proposed
**Date:** 2026-06-15
**Tags:** orchestration, observability, cost

## Context

`makeDelegationManager.charge()` (AC-11-8/9) correctly halts execution when any
budget bound is reached and emits a `budget.capped` event carrying `reason:
verdict.reason`. The `BudgetGuard.charge()` call may be tripped by a *dollar
ceiling*, a *token ceiling*, or a *global-run cap*. Currently the `budget.capped`
event payload is whatever the guard returns in `verdict.reason` — a freeform
string — without a machine-readable record of *which specific bound* was tripped
and the values at trip time (`dollarsSpent`, `tokenCount`, `limit`).

AC-11-9 asks that the precedence chain be fully auditable: if multiple bounds
could fire in the same call, the one that fires *first* is the authoritative
reason, and the audit log must prove which bound was authoritative and at what
value.

The question is whether to (a) enrich the `budget.capped` event payload in-place,
or (b) require `BudgetGuard` to return a structured `BudgetVerdict` with
discriminated-union detail, or (c) emit a companion `budget.bound_detail` event.

## Decision

**Enrich `budget.capped` with a structured `bound` sub-object in the event
payload** (option a). `BudgetGuard.charge()` already returns a `verdict` object;
the event emit will destructure it into a stable schema:

```typescript
emit('budget.capped', {
  reason: verdict.reason,           // 'dollar' | 'token' | 'global-budget'
  bound: {
    kind: verdict.reason,
    spent: verdict.spent,           // numeric value at trip time
    limit: verdict.limit,           // the ceiling that was breached
  },
})
```

`BudgetGuard` must guarantee that when it returns `{ capped: true }` it also
returns `spent` and `limit` so the orchestration layer can relay them verbatim.
No new event kind is added; no schema migration is needed on existing consumers
that only read `reason`.

Precedence is determined by `BudgetGuard` internally (dollar checked before
token, global checked first if halted); the orchestration layer does not
re-evaluate precedence, it trusts the guard.

## Consequences

- **Positive:** `budget.capped` becomes fully auditable — the exact breach
  values are in the journal entry; no second event needed.
- **Positive:** Downstream tooling (cost-transparency dashboard, ADR-0036) can
  display "dollar cap hit at $4.82 / $5.00" without re-reading the guard state.
- **Neutral:** `BudgetGuard` interface gains two new fields (`spent`, `limit`)
  on its capped-verdict branch. Existing tests that mock it must be updated.
- **Negative:** If a future guard wants to report multiple simultaneous breaches
  (dollar AND token hit on the same charge call), this schema only records the
  primary one. Considered acceptable; the primary bound is the actionable signal.

## Alternatives considered

**Separate `budget.bound_detail` companion event:** Adds event-log noise; a
consumer must correlate two events by `runId` and `seq`. Rejected.

**Leave the payload as-is (freeform string):** AC-11-9 requires machine-readable
evidence of which bound fired. A freeform string is not auditable. Rejected.

## References

- AC-11-9 (spec §5.2, budget-precedence chain)
- [ADR-0036 Cost-Transparency Surfacing](./2026-06-11-cost-transparency-surfacing.md)
- [ADR-0039 First-Class Sub-Agent Delegation](./2026-06-12-first-class-subagent-delegation.md)
- `packages/core-ts/src/orchestration/index.ts` — `charge()` implementation

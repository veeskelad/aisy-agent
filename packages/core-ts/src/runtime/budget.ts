// Per-agent budget tracker (runtime, ADR-0050 Phase 3).
//
// Caps come from config (providers.json agents[*].budgetUsd + the main agent);
// `spent` is read live from the spend ledger (byAgent), so the tracker holds no
// state of its own. The transport gates a turn when `budgetEnabled` is set and
// the agent is over its cap (emitting budget.capped). Mid-turn enforcement and
// sub-agent inheritance arrive with the delegation runtime (ADR-0039); the
// tracker already keys on arbitrary agent ids so it is ready for both.

export interface BudgetTracker {
  /** Configured cap in USD; 0 (or absent) means unlimited. */
  capFor(agentId: string): number
  /** Live spend for the agent (from the ledger). */
  spentFor(agentId: string): number
  /** Remaining USD; Infinity when uncapped, clamped to 0 at/over the cap. */
  remainingFor(agentId: string): number
  /** True iff a cap is set and spend has reached it. */
  over(agentId: string): boolean
}

export function makeBudgetTracker(deps: {
  caps: Record<string, number>
  spent: (agentId: string) => number
}): BudgetTracker {
  const capFor = (agentId: string): number => deps.caps[agentId] ?? 0
  return {
    capFor,
    spentFor: (agentId) => deps.spent(agentId),
    remainingFor: (agentId) => {
      const cap = capFor(agentId)
      return cap > 0 ? Math.max(0, cap - deps.spent(agentId)) : Infinity
    },
    over: (agentId) => {
      const cap = capFor(agentId)
      return cap > 0 && deps.spent(agentId) >= cap
    },
  }
}

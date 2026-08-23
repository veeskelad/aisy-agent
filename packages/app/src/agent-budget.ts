export interface AgentBudgetCheckDeps {
  agentId: string
  isEnabled(): boolean
  capFor(agentId: string): number
  spentFor(agentId: string): number
}

export function makeAgentBudgetCheck(deps: AgentBudgetCheckDeps): (usage: { dollars: number }) => boolean {
  return (usage) => {
    if (!deps.isEnabled()) return false
    const cap = deps.capFor(deps.agentId)
    if (cap <= 0) return false
    return deps.spentFor(deps.agentId) + usage.dollars >= cap
  }
}

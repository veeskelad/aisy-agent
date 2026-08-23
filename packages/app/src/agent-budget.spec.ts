import { describe, expect, it } from 'vitest'
import { makeAgentBudgetCheck } from './agent-budget.js'

describe('makeAgentBudgetCheck', () => {
  it('checks the selected child agent cap rather than the main cap', () => {
    const check = makeAgentBudgetCheck({
      agentId: 'researcher',
      isEnabled: () => true,
      capFor: (agentId) => agentId === 'researcher' ? 0.5 : 100,
      spentFor: (agentId) => agentId === 'researcher' ? 0.4 : 0,
    })

    expect(check({ dollars: 0.1 })).toBe(true)
  })

  it('does not enforce caps while budget enforcement is disabled', () => {
    const check = makeAgentBudgetCheck({
      agentId: 'researcher',
      isEnabled: () => false,
      capFor: () => 0.5,
      spentFor: () => 0.49,
    })

    expect(check({ dollars: 0.1 })).toBe(false)
  })

  it('treats a missing or zero cap as unlimited', () => {
    const check = makeAgentBudgetCheck({
      agentId: 'researcher',
      isEnabled: () => true,
      capFor: () => 0,
      spentFor: () => 10,
    })

    expect(check({ dollars: 1 })).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { makeBudgetTracker } from './budget.js'

describe('makeBudgetTracker', () => {
  it('an absent or zero cap means unlimited', () => {
    const t = makeBudgetTracker({ caps: { main: 0 }, spent: () => 999 })
    expect(t.capFor('main')).toBe(0)
    expect(t.over('main')).toBe(false)
    expect(t.remainingFor('main')).toBe(Infinity)
    expect(t.capFor('unknown')).toBe(0)
    expect(t.over('unknown')).toBe(false)
  })

  it('under the cap: not over, remaining is the gap', () => {
    const t = makeBudgetTracker({ caps: { main: 1 }, spent: () => 0.4 })
    expect(t.over('main')).toBe(false)
    expect(t.remainingFor('main')).toBeCloseTo(0.6)
    expect(t.spentFor('main')).toBe(0.4)
  })

  it('at or over the cap: over, remaining clamps to 0', () => {
    const t = makeBudgetTracker({ caps: { main: 1 }, spent: () => 1 })
    expect(t.over('main')).toBe(true)
    expect(t.remainingFor('main')).toBe(0)

    const t2 = makeBudgetTracker({ caps: { main: 1 }, spent: () => 1.5 })
    expect(t2.over('main')).toBe(true)
    expect(t2.remainingFor('main')).toBe(0)
  })

  it('tracks per-agent caps independently', () => {
    const spent: Record<string, number> = { main: 0.2, researcher: 5 }
    const t = makeBudgetTracker({ caps: { main: 1, researcher: 2 }, spent: (id) => spent[id] ?? 0 })
    expect(t.over('main')).toBe(false)
    expect(t.over('researcher')).toBe(true)
  })
})

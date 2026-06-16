import { describe, it, expect } from 'vitest'
import { makeSpendStore } from './spend.js'
import type { SpendEntry } from './spend.js'

describe('makeSpendStore', () => {
  it('aggregates repeated charges for the same model', () => {
    const s = makeSpendStore({})
    s.record({ model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 20, dollars: 0.01 } })
    s.record({ model: 'deepseek-chat', usage: { inputTokens: 50, outputTokens: 10, dollars: 0.005 } })
    expect(s.byModel()).toEqual([{ model: 'deepseek-chat', inputTokens: 150, outputTokens: 30, dollars: 0.015 }])
  })

  it('groups by model and by agent independently', () => {
    const s = makeSpendStore({})
    s.record({ model: 'opus', agentId: 'main', usage: { inputTokens: 10, outputTokens: 5, dollars: 0.1 } })
    s.record({ model: 'haiku', agentId: 'researcher', usage: { inputTokens: 20, outputTokens: 8, dollars: 0.02 } })
    s.record({ model: 'opus', agentId: 'researcher', usage: { inputTokens: 4, outputTokens: 2, dollars: 0.04 } })

    expect(s.byModel()).toEqual([
      { model: 'haiku', inputTokens: 20, outputTokens: 8, dollars: 0.02 },
      { model: 'opus', inputTokens: 14, outputTokens: 7, dollars: 0.14 },
    ])
    expect(s.byAgent()).toEqual([
      { agentId: 'main', inputTokens: 10, outputTokens: 5, dollars: 0.1 },
      { agentId: 'researcher', inputTokens: 24, outputTokens: 10, dollars: 0.06 },
    ])
  })

  it('defaults a missing agentId to "main"', () => {
    const s = makeSpendStore({})
    s.record({ model: 'm', usage: { inputTokens: 1, outputTokens: 1, dollars: 1 } })
    expect(s.byAgent()).toEqual([{ agentId: 'main', inputTokens: 1, outputTokens: 1, dollars: 1 }])
  })

  it('total sums all charges', () => {
    const s = makeSpendStore({})
    s.record({ model: 'a', usage: { inputTokens: 3, outputTokens: 1, dollars: 0.2 } })
    s.record({ model: 'b', usage: { inputTokens: 7, outputTokens: 2, dollars: 0.3 } })
    expect(s.total()).toEqual({ inputTokens: 10, outputTokens: 3, dollars: 0.5 })
  })

  it('loads prior state and persists on every record', () => {
    const saved: SpendEntry[][] = []
    let store: SpendEntry[] = [{ model: 'm', agentId: 'main', usage: { inputTokens: 5, outputTokens: 1, dollars: 0.5 } }]
    const s = makeSpendStore({
      persistence: {
        load: () => store,
        save: (e) => {
          store = e
          saved.push(e)
        },
      },
    })
    // prior state is visible
    expect(s.total().dollars).toBe(0.5)
    s.record({ model: 'm', usage: { inputTokens: 5, outputTokens: 1, dollars: 0.5 } })
    expect(s.total().dollars).toBe(1)
    // a save happened, persisting the aggregate (re-loadable)
    expect(saved.length).toBe(1)
    const reloaded = makeSpendStore({ persistence: { load: () => store, save: () => {} } })
    expect(reloaded.total()).toEqual({ inputTokens: 10, outputTokens: 2, dollars: 1 })
  })
})

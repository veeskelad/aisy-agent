import { describe, it, expect } from 'vitest'
import { makeTriggerStore } from './trigger-store.js'
import type { TriggerSpec } from '@aisy/core'

function makeMemoryDeps(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('/test/triggers.json', initial)
  return {
    path: '/test/triggers.json',
    readFile: (p: string) => {
      const v = store.get(p)
      if (v === undefined) throw new Error(`not found: ${p}`)
      return v
    },
    writeFile: (p: string, c: string) => { store.set(p, c) },
    exists: (p: string) => store.has(p),
  }
}

function makeSpec(id: string, extra?: Partial<TriggerSpec>): TriggerSpec {
  return {
    id,
    kind: 'remind',
    createdBy: 'operator',
    confirmed: true,
    prompt: `Do thing ${id}`,
    fireAt: '2026-01-01T00:00:00.000Z',
    budget: { tokenCeiling: 1000, dollarCeiling: 1, tokensSpent: 0, dollarsSpent: 0 },
    enabled: true,
    ...extra,
  }
}

describe('makeTriggerStore', () => {
  it('saves two specs and load returns both', async () => {
    const deps = makeMemoryDeps()
    const store = makeTriggerStore(deps)
    await store.save(makeSpec('a'))
    await store.save(makeSpec('b'))
    const all = await store.load()
    expect(all).toHaveLength(2)
    expect(all.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('upserts on save with same id — still 2 entries, updated prompt', async () => {
    const deps = makeMemoryDeps()
    const store = makeTriggerStore(deps)
    await store.save(makeSpec('a', { prompt: 'original' }))
    await store.save(makeSpec('b'))
    await store.save(makeSpec('a', { prompt: 'updated' }))
    const all = await store.load()
    expect(all).toHaveLength(2)
    const aSpec = all.find((s) => s.id === 'a')
    expect(aSpec?.prompt).toBe('updated')
  })

  it('removes one spec — load returns 1', async () => {
    const deps = makeMemoryDeps()
    const store = makeTriggerStore(deps)
    await store.save(makeSpec('a'))
    await store.save(makeSpec('b'))
    await store.remove('a')
    const all = await store.load()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe('b')
  })

  it('returns [] when file is absent', async () => {
    const deps = makeMemoryDeps() // no initial content → file does not exist
    const store = makeTriggerStore(deps)
    const all = await store.load()
    expect(all).toEqual([])
  })
})

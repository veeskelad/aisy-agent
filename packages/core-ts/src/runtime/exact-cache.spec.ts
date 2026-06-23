import { describe, it, expect } from 'vitest'
import { makeExactCache, makeMemoryExactCacheStore } from './exact-cache.js'
import type { ProviderAdapter, ModelRequest, ModelResponse } from '../agent-loop/types.js'

function fakeAdapter(response: ModelResponse, calls: { count: number }): ProviderAdapter {
  return {
    async complete(_req, _signal) {
      calls.count++
      return response
    },
  }
}

function makeReq(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    sessionId: 'session-1',
    prefixBytes: new Uint8Array([1, 2, 3]),
    spans: [{ role: 'user', provenance: 'operator', text: 'hello' }],
    ...overrides,
  }
}

const fixedResponse: ModelResponse = { reply: 'cached reply' }

describe('makeExactCache', () => {
  it('hit/miss: same request twice → inner called once, both results deep-equal', async () => {
    const calls = { count: 0 }
    const inner = fakeAdapter(fixedResponse, calls)
    const store = makeMemoryExactCacheStore()
    const cached = makeExactCache(inner, store, 'ns')
    const req = makeReq()

    const r1 = await cached.complete(req)
    const r2 = await cached.complete(req)

    expect(calls.count).toBe(1)
    expect(r1).toEqual(fixedResponse)
    expect(r2).toEqual(fixedResponse)
  })

  it('different spans → inner called twice (distinct cache keys)', async () => {
    const calls = { count: 0 }
    const inner = fakeAdapter(fixedResponse, calls)
    const store = makeMemoryExactCacheStore()
    const cached = makeExactCache(inner, store, 'ns')

    const req1 = makeReq({ spans: [{ role: 'user', provenance: 'operator', text: 'hello' }] })
    const req2 = makeReq({ spans: [{ role: 'user', provenance: 'operator', text: 'world' }] })

    await cached.complete(req1)
    await cached.complete(req2)

    expect(calls.count).toBe(2)
  })

  it('different namespace, same request → inner called twice (namespace isolates)', async () => {
    const calls = { count: 0 }
    const inner = fakeAdapter(fixedResponse, calls)
    const store = makeMemoryExactCacheStore()
    const cachedA = makeExactCache(inner, store, 'gen:model-a')
    const cachedB = makeExactCache(inner, store, 'judge:model-a')
    const req = makeReq()

    await cachedA.complete(req)
    await cachedB.complete(req)

    expect(calls.count).toBe(2)
  })

  it('pre-seeded store returns cached ModelResponse without calling inner', async () => {
    const calls = { count: 0 }
    const inner = fakeAdapter({ reply: 'fresh' }, calls)
    const store = makeMemoryExactCacheStore()
    const seeded: ModelResponse = { reply: 'seeded' }
    const cached = makeExactCache(inner, store, 'ns')
    const req = makeReq()

    // Seed by making one call (or we can import keyOf — but it's private; use a call to seed)
    // We seed via a first call so the store is populated, then verify a second call returns it
    // without hitting inner again after changing the inner response.
    const seededCache = makeExactCache(
      { async complete() { return seeded } },
      store,
      'ns',
    )
    await seededCache.complete(req)

    // Now our inner-tracking adapter uses the same store — should be a hit
    const result = await cached.complete(req)
    expect(calls.count).toBe(0)
    expect(result).toEqual(seeded)
  })
})

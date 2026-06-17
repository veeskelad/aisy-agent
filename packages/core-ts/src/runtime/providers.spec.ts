import { describe, it, expect } from 'vitest'
import { PROVIDER_CATALOG, findProvider, buildProvider, makeTieredProvider } from './providers.js'
import type { ProviderAdapter, ModelRequest, ModelResponse } from '../agent-loop/types.js'

const req: ModelRequest = { sessionId: 's', prefixBytes: new Uint8Array(), spans: [] }

describe('PROVIDER_CATALOG', () => {
  it('includes the full provider set', () => {
    const ids = PROVIDER_CATALOG.map((p) => p.id)
    for (const id of ['anthropic', 'openai', 'deepseek', 'openrouter', 'qwen', 'glm', 'gemini', 'openai-compat', 'claude-cli']) {
      expect(ids).toContain(id)
    }
  })

  it('CLI providers carry no key env, HTTP providers do', () => {
    expect(findProvider('claude-cli')?.keyEnv).toBeUndefined()
    expect(findProvider('deepseek')?.keyEnv).toBe('AISY_PROVIDER_DEEPSEEK_KEY')
  })
})

describe('buildProvider', () => {
  it('builds each kind without throwing', () => {
    expect(typeof buildProvider({ provider: 'anthropic', model: 'm', apiKey: 'k' }).complete).toBe('function')
    expect(typeof buildProvider({ provider: 'deepseek', model: 'm', apiKey: 'k' }).complete).toBe('function')
    expect(typeof buildProvider({ provider: 'claude-cli', model: 'm' }).complete).toBe('function')
  })

  it('requires a baseUrl for the custom openai-compat entry', () => {
    expect(() => buildProvider({ provider: 'openai-compat', model: 'm', apiKey: 'k' })).toThrow(/baseUrl/)
    expect(typeof buildProvider({ provider: 'openai-compat', model: 'm', apiKey: 'k', baseUrl: 'https://x/v1' }).complete).toBe('function')
  })

  it('throws on an unknown provider', () => {
    expect(() => buildProvider({ provider: 'nope', model: 'm' })).toThrow(/unknown provider/)
  })
})

describe('makeTieredProvider', () => {
  function stub(tag: string): ProviderAdapter {
    return { complete: async (): Promise<ModelResponse> => ({ reply: tag }) }
  }

  it('single-model mode: all tiers resolve to the same adapter', async () => {
    const one = stub('one')
    const tp = makeTieredProvider({ reasoning: one, critique: one, routine: one })
    expect((await tp.complete(req)).reply).toBe('one')
  })

  it('classify routes to the matching tier adapter', async () => {
    const tp = makeTieredProvider(
      { reasoning: stub('R'), critique: stub('C'), routine: stub('T') },
      () => 'routine',
    )
    expect((await tp.complete(req)).reply).toBe('T')
  })

  it('defaults to the reasoning tier without a classifier', async () => {
    const tp = makeTieredProvider({ reasoning: stub('R'), critique: stub('C'), routine: stub('T') })
    expect((await tp.complete(req)).reply).toBe('R')
  })

  it('makeTieredProvider forwards the abort signal to the delegated tier adapter', async () => {
    let seen: AbortSignal | undefined
    const adapter: ProviderAdapter = { async complete(_req, signal) { seen = signal; return { reply: 'ok' } } }
    const tiered = makeTieredProvider({ reasoning: adapter, critique: adapter, routine: adapter })
    const controller = new AbortController()
    await tiered.complete({ sessionId: 's', prefixBytes: new Uint8Array(0), spans: [] }, controller.signal)
    expect(seen).toBe(controller.signal)
  })
})

import { describe, it, expect } from 'vitest'
import { PROVIDER_CATALOG, findProvider, buildProvider, makeTieredProvider } from './providers.js'
import type { ProviderAdapter, ModelRequest, ModelResponse, ContextSpan } from '../agent-loop/types.js'

const req: ModelRequest = { sessionId: 's', prefixBytes: new Uint8Array(), spans: [] }

function span(role: ContextSpan['role'], text: string): ContextSpan {
  return { role, text, provenance: 'operator' }
}

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return { status, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

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

describe('buildProvider prefixCache wiring', () => {
  const okBody = { choices: [{ message: { content: 'ok' } }] }
  const anthropicOkBody = { content: [{ type: 'text', text: 'ok' }] }
  const spans = [span('system', 'sys'), span('user', 'ping')]
  const turnReq: ModelRequest = { sessionId: 's', prefixBytes: new Uint8Array(), spans }

  it('openrouter + prefixCache:true => cache_control blocks on system and last message', async () => {
    const { impl, calls } = fakeFetch(200, okBody)
    const adapter = buildProvider({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-6',
      apiKey: 'K',
      prefixCache: true,
      fetchImpl: impl,
    })
    await adapter.complete(turnReq)
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    })
    expect(sent.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }],
    })
  })

  it('deepseek + prefixCache:true => plain string content (auto cache)', async () => {
    const { impl, calls } = fakeFetch(200, okBody)
    const adapter = buildProvider({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'K',
      prefixCache: true,
      fetchImpl: impl,
    })
    await adapter.complete(turnReq)
    const sent = JSON.parse(calls[0]!.init.body as string)
    // system message: plain string (auto cache)
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' })
    // user message: plain string
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'ping' })
  })

  it('anthropic + prefixCache:false => plain string system and messages', async () => {
    const { impl, calls } = fakeFetch(200, anthropicOkBody)
    const adapter = buildProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'K',
      prefixCache: false,
      fetchImpl: impl,
    })
    await adapter.complete(turnReq)
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent.system).toBe('sys')
    expect(sent.messages).toEqual([{ role: 'user', content: 'ping' }])
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

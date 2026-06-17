import { describe, it, expect } from 'vitest'
import {
  makeAnthropicProvider,
  spansToMessages,
  parseResponse,
  type AnthropicTool,
} from './provider-anthropic.js'
import type { ContextSpan, ModelRequest, ProviderError } from '../agent-loop/types.js'

function span(role: ContextSpan['role'], text: string): ContextSpan {
  return { role, text, provenance: 'operator' }
}

function req(spans: ContextSpan[], prefix = ''): ModelRequest {
  return {
    sessionId: 's1',
    prefixBytes: new TextEncoder().encode(prefix),
    spans,
  }
}

/** A fetch double returning a fixed status + JSON body, capturing the request. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return {
      status,
      json: async () => body,
    } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('spansToMessages', () => {
  it('routes system spans to the system string', () => {
    const { system, messages } = spansToMessages([span('system', 'be terse'), span('user', 'hi')])
    expect(system).toBe('be terse')
    expect(messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('prepends the frozen prefix to system', () => {
    const { system } = spansToMessages([span('user', 'hi')], 'PREFIX')
    expect(system).toBe('PREFIX')
  })

  it('collapses consecutive same-role spans', () => {
    const { messages } = spansToMessages([span('user', 'a'), span('user', 'b')])
    expect(messages).toEqual([{ role: 'user', content: 'a\n\nb' }])
  })

  it('labels tool spans and treats them as user turns', () => {
    const { messages } = spansToMessages([span('user', 'q'), span('assistant', 'x'), span('tool', 'result-text')])
    expect(messages).toContainEqual({ role: 'user', content: '[tool result] result-text' })
  })

  it('ensures the first message is user', () => {
    const { messages } = spansToMessages([span('assistant', 'hello')])
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hello' })
  })
})

describe('parseResponse', () => {
  it('joins text blocks into reply', () => {
    const r = parseResponse({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] })
    expect(r.reply).toBe('hello world')
    expect(r.toolCalls).toBeUndefined()
  })

  it('extracts tool_use blocks into toolCalls', () => {
    const r = parseResponse({
      content: [
        { type: 'text', text: 'running' },
        { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } },
      ],
    })
    expect(r.reply).toBe('running')
    expect(r.toolCalls).toEqual([{ name: 'bash', args: { cmd: 'ls' } }])
  })

  it('defaults tool args to {} when absent', () => {
    const r = parseResponse({ content: [{ type: 'tool_use', name: 'list_dir' }] })
    expect(r.toolCalls).toEqual([{ name: 'list_dir', args: {} }])
  })

  it('handles an empty/garbage body', () => {
    expect(parseResponse({}).reply).toBe('')
    expect(parseResponse(null).reply).toBe('')
  })

  it('extracts usage and costs it against the price sheet', () => {
    const r = parseResponse(
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
      { inPerMtok: 3, outPerMtok: 15 },
    )
    expect(r.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, dollars: 18 })
  })

  it('reports usage with zero dollars when no price is given', () => {
    const r = parseResponse({ content: [], usage: { input_tokens: 10, output_tokens: 5 } })
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, dollars: 0 })
  })

  it('omits usage when the body has none', () => {
    expect(parseResponse({ content: [] }).usage).toBeUndefined()
  })
})

describe('makeAnthropicProvider.complete', () => {
  const tools: AnthropicTool[] = [
    { name: 'bash', description: 'run', input_schema: { type: 'object' } },
  ]

  it('sends a well-formed request and parses the reply', async () => {
    const { impl, calls } = fakeFetch(200, { content: [{ type: 'text', text: 'pong' }] })
    const provider = makeAnthropicProvider({ apiKey: 'KEY', model: 'claude-sonnet-4-6', tools, fetchImpl: impl })
    const res = await provider.complete(req([span('system', 'sys'), span('user', 'ping')], 'PFX'))

    expect(res.reply).toBe('pong')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('KEY')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent.model).toBe('claude-sonnet-4-6')
    expect(sent.system).toBe('PFX\n\nsys')
    expect(sent.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(sent.tools).toEqual(tools)
  })

  it('omits system and tools when empty', async () => {
    const { impl, calls } = fakeFetch(200, { content: [] })
    const provider = makeAnthropicProvider({ apiKey: 'K', model: 'm', fetchImpl: impl })
    await provider.complete(req([span('user', 'hi')]))
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect('system' in sent).toBe(false)
    expect('tools' in sent).toBe(false)
  })

  it('maps 429 to a rate-limit ProviderError', async () => {
    const { impl } = fakeFetch(429, {})
    const provider = makeAnthropicProvider({ apiKey: 'K', model: 'm', fetchImpl: impl })
    await expect(provider.complete(req([span('user', 'x')]))).rejects.toMatchObject({
      kind: 'rate-limit',
    } satisfies Partial<ProviderError>)
  })

  it('maps 5xx to a server-error ProviderError', async () => {
    const { impl } = fakeFetch(503, {})
    const provider = makeAnthropicProvider({ apiKey: 'K', model: 'm', fetchImpl: impl })
    await expect(provider.complete(req([span('user', 'x')]))).rejects.toMatchObject({
      kind: 'server-error',
    })
  })

  it('maps a thrown TimeoutError to a timeout ProviderError', async () => {
    const impl = (async () => {
      const e = new Error('timed out')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    const provider = makeAnthropicProvider({ apiKey: 'K', model: 'm', fetchImpl: impl })
    await expect(provider.complete(req([span('user', 'x')]))).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('threads an external abort signal into the fetch (composite with timeout)', async () => {
    let seen: AbortSignal | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const controller = new AbortController()
    const p = makeAnthropicProvider({ apiKey: 'k', model: 'claude-sonnet-4-6', fetchImpl })
    await p.complete(
      { sessionId: 's', prefixBytes: new Uint8Array(0), spans: [{ role: 'user', provenance: 'operator', text: 'hi' }] },
      controller.signal,
    )
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })
})

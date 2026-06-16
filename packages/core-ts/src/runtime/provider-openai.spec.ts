import { describe, it, expect } from 'vitest'
import { makeOpenAICompatProvider, parseOpenAIResponse } from './provider-openai.js'
import type { AnthropicTool } from './provider-anthropic.js'
import type { ContextSpan, ModelRequest, ProviderError } from '../agent-loop/types.js'

function span(role: ContextSpan['role'], text: string): ContextSpan {
  return { role, text, provenance: 'operator' }
}
function req(spans: ContextSpan[]): ModelRequest {
  return { sessionId: 's', prefixBytes: new Uint8Array(), spans }
}
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return { status, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('parseOpenAIResponse', () => {
  it('extracts the assistant message content', () => {
    const r = parseOpenAIResponse({ choices: [{ message: { content: 'hi there' } }] })
    expect(r.reply).toBe('hi there')
    expect(r.toolCalls).toBeUndefined()
  })

  it('parses tool_calls with JSON arguments', () => {
    const r = parseOpenAIResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
          },
        },
      ],
    })
    expect(r.reply).toBe('')
    expect(r.toolCalls).toEqual([{ name: 'bash', args: { cmd: 'ls' } }])
  })

  it('tolerates malformed tool arguments', () => {
    const r = parseOpenAIResponse({
      choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: 'not-json' } }] } }],
    })
    expect(r.toolCalls).toEqual([{ name: 'x', args: {} }])
  })

  it('costs usage against a price', () => {
    const r = parseOpenAIResponse(
      { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } },
      { inPerMtok: 1, outPerMtok: 2 },
    )
    expect(r.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, dollars: 3 })
  })

  it('handles an empty/garbage body', () => {
    expect(parseOpenAIResponse({}).reply).toBe('')
    expect(parseOpenAIResponse(null).reply).toBe('')
  })
})

describe('makeOpenAICompatProvider.complete', () => {
  const tools: AnthropicTool[] = [{ name: 'bash', description: 'run', input_schema: { type: 'object' } }]

  it('posts to {baseUrl}/chat/completions with a bearer key and parses the reply', async () => {
    const { impl, calls } = fakeFetch(200, { choices: [{ message: { content: 'pong' } }] })
    const provider = makeOpenAICompatProvider({
      apiKey: 'K',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      tools,
      fetchImpl: impl,
    })
    const res = await provider.complete(req([span('system', 'sys'), span('user', 'ping')]))
    expect(res.reply).toBe('pong')
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer K')
    const sent = JSON.parse(calls[0]!.init.body as string)
    expect(sent.model).toBe('deepseek-chat')
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'ping' })
    expect(sent.tools[0]).toEqual({
      type: 'function',
      function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
    })
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { impl, calls } = fakeFetch(200, { choices: [] })
    const provider = makeOpenAICompatProvider({ apiKey: 'K', model: 'm', baseUrl: 'https://x.ai/v1/', fetchImpl: impl })
    await provider.complete(req([span('user', 'hi')]))
    expect(calls[0]!.url).toBe('https://x.ai/v1/chat/completions')
  })

  it('maps 429 / 5xx / timeout to ProviderError kinds', async () => {
    const mk = (status: number) =>
      makeOpenAICompatProvider({ apiKey: 'K', model: 'm', baseUrl: 'https://x/v1', fetchImpl: fakeFetch(status, {}).impl })
    await expect(mk(429).complete(req([span('user', 'x')]))).rejects.toMatchObject({
      kind: 'rate-limit',
    } satisfies Partial<ProviderError>)
    await expect(mk(500).complete(req([span('user', 'x')]))).rejects.toMatchObject({ kind: 'server-error' })

    const timeoutImpl = (async () => {
      const e = new Error('t')
      e.name = 'TimeoutError'
      throw e
    }) as unknown as typeof fetch
    const p = makeOpenAICompatProvider({ apiKey: 'K', model: 'm', baseUrl: 'https://x/v1', fetchImpl: timeoutImpl })
    await expect(p.complete(req([span('user', 'x')]))).rejects.toMatchObject({ kind: 'timeout' })
  })
})

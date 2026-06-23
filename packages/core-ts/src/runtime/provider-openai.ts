// Generic OpenAI-compatible provider adapter (runtime).
//
// Covers OpenAI, DeepSeek, OpenRouter, Qwen, GLM/Zhipu, Gemini (openai-compat),
// and any custom baseURL that speaks the OpenAI chat-completions API. Implements
// the agent-loop's ProviderAdapter.complete: spans -> messages, tools -> function
// tools, choices[0].message -> {reply, toolCalls}, usage -> tokens + dollars.

import type {
  ProviderAdapter,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ProviderError,
} from '../agent-loop/types.js'
import { spansToMessages, type AnthropicTool } from './provider-anthropic.js'

export interface ModelPrice {
  inPerMtok: number
  outPerMtok: number
}

export interface OpenAIProviderDeps {
  apiKey: string
  model: string
  /** Base URL incl. scheme, no trailing slash, e.g. https://api.deepseek.com/v1 */
  baseUrl: string
  tools?: AnthropicTool[]
  /** Optional per-model price for cost accounting; absent ⇒ zero dollars. */
  price?: ModelPrice
  maxTokens?: number
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /**
   * Cache strategy:
   * - 'auto' (default): plain string content — OpenAI/DeepSeek/Gemini/GLM/Qwen
   *   auto-cache transparently, no request change needed.
   * - 'breakpoints': wraps system + last message content in cache_control blocks
   *   for OpenRouter passthrough to Anthropic.
   */
  cache?: 'auto' | 'breakpoints'
}

class OpenAIError extends Error implements ProviderError {
  constructor(public readonly kind: ProviderError['kind'], message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

interface OpenAIToolCall {
  function?: { name?: string; arguments?: string }
}

/** Parse an OpenAI chat-completions body into a ModelResponse. */
export function parseOpenAIResponse(body: unknown, price?: ModelPrice): ModelResponse {
  const b = (body && typeof body === 'object' ? body : {}) as {
    choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const message = b.choices?.[0]?.message
  const reply = typeof message?.content === 'string' ? message.content : ''

  const toolCalls: ToolCall[] = []
  for (const tc of message?.tool_calls ?? []) {
    const name = tc.function?.name
    if (typeof name !== 'string') continue
    let args: Record<string, unknown> = {}
    try {
      args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
    } catch {
      args = {}
    }
    toolCalls.push({ name, args })
  }

  let usage: ModelResponse['usage']
  if (b.usage) {
    const inputTokens = b.usage.prompt_tokens ?? 0
    const outputTokens = b.usage.completion_tokens ?? 0
    const dollars = price ? (inputTokens / 1e6) * price.inPerMtok + (outputTokens / 1e6) * price.outPerMtok : 0
    usage = { inputTokens, outputTokens, dollars }
  }

  return {
    reply,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** Convert the neutral tool schema to the OpenAI function-tool shape. */
function toOpenAITools(tools: AnthropicTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

export function makeOpenAICompatProvider(deps: OpenAIProviderDeps): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch
  const maxTokens = deps.maxTokens ?? 4096
  const timeoutMs = deps.timeoutMs ?? 60_000
  const url = `${deps.baseUrl.replace(/\/$/, '')}/chat/completions`

  return {
    async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const prefix = req.prefixBytes.byteLength > 0 ? Buffer.from(req.prefixBytes).toString('utf8') : ''
      const { system, messages } = spansToMessages(req.spans, prefix)
      const cache = deps.cache ?? 'auto'
      const oaMessages: { role: string; content: unknown }[] = []
      if (system.length > 0) {
        oaMessages.push(
          cache === 'breakpoints'
            ? { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
            : { role: 'system', content: system },
        )
      }
      if (cache === 'breakpoints' && messages.length > 0) {
        messages.forEach((m, i) =>
          oaMessages.push(
            i === messages.length - 1
              ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
              : { role: m.role, content: m.content },
          ),
        )
      } else {
        for (const m of messages) oaMessages.push({ role: m.role, content: m.content })
      }

      const payload: Record<string, unknown> = {
        model: deps.model,
        max_tokens: maxTokens,
        messages: oaMessages,
      }
      if (deps.tools && deps.tools.length > 0) payload['tools'] = toOpenAITools(deps.tools)

      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        const kind = (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'server-error'
        throw new OpenAIError(kind, `OpenAI-compat request failed: ${(err as Error)?.message ?? 'unknown'}`)
      }

      if (res.status === 429) throw new OpenAIError('rate-limit', 'OpenAI-compat 429')
      if (res.status >= 500) throw new OpenAIError('server-error', `OpenAI-compat ${res.status}`)
      if (res.status >= 400) throw new OpenAIError('server-error', `OpenAI-compat client error ${res.status}`)

      const body = (await res.json()) as unknown
      return parseOpenAIResponse(body, deps.price)
    },
  }
}

// Real Anthropic provider adapter (runtime).
//
// Implements the agent-loop's high-level ProviderAdapter.complete seam: it maps
// structured ContextSpans to the Anthropic Messages API, calls it, and parses
// the response into { reply, toolCalls }. The 3-tier ModelRouter (opaque-bytes
// dispatch) is a separate concern the agent loop does not require — this is the
// single adapter the loop calls directly.

import type {
  ProviderAdapter,
  ModelRequest,
  ModelResponse,
  ContextSpan,
  ToolCall,
  ProviderError,
} from '../agent-loop/types.js'

/** Tool advertised to the model (Anthropic tool schema shape). */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface AnthropicProviderDeps {
  apiKey: string
  /** e.g. "claude-sonnet-4-6", "claude-opus-4-8". */
  model: string
  maxTokens?: number
  /** Tools the model may call this session. */
  tools?: AnthropicTool[]
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  apiBase?: string
}

class AnthropicError extends Error implements ProviderError {
  constructor(public readonly kind: ProviderError['kind'], message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Map agent-loop spans → Anthropic system string + alternating messages. */
export function spansToMessages(
  spans: ContextSpan[],
  prefix?: string,
): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  if (prefix && prefix.length > 0) systemParts.push(prefix)

  const raw: AnthropicMessage[] = []
  for (const span of spans) {
    if (span.role === 'system') {
      systemParts.push(span.text)
      continue
    }
    // Tool results are fed back as a labelled user turn (MVP: no tool_use id
    // round-trip yet — the loop re-sends the tool output as context).
    const role: 'user' | 'assistant' = span.role === 'assistant' ? 'assistant' : 'user'
    const content = span.role === 'tool' ? `[tool result] ${span.text}` : span.text
    raw.push({ role, content })
  }

  // Anthropic requires alternating roles starting with user. Collapse runs of
  // the same role into one message so any span ordering is accepted.
  const messages: AnthropicMessage[] = []
  for (const m of raw) {
    const last = messages[messages.length - 1]
    if (last && last.role === m.role) last.content += `\n\n${m.content}`
    else messages.push({ ...m })
  }
  if (messages.length > 0 && messages[0]!.role === 'assistant') {
    messages.unshift({ role: 'user', content: '(continue)' })
  }

  return { system: systemParts.join('\n\n'), messages }
}

interface AnthropicContentBlock {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

/** Parse an Anthropic Messages response body into a ModelResponse. */
export function parseResponse(body: unknown): ModelResponse {
  const b = (body && typeof body === 'object' ? body : {}) as { content?: AnthropicContentBlock[] }
  const blocks = Array.isArray(b.content) ? b.content : []
  const replyParts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      replyParts.push(block.text)
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({ name: block.name, args: block.input ?? {} })
    }
  }
  const reply = replyParts.join('')
  return toolCalls.length > 0 ? { reply, toolCalls } : { reply }
}

export function makeAnthropicProvider(deps: AnthropicProviderDeps): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch
  const apiBase = deps.apiBase ?? 'https://api.anthropic.com'
  const maxTokens = deps.maxTokens ?? 4096
  const timeoutMs = deps.timeoutMs ?? 60_000

  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const prefix = req.prefixBytes.byteLength > 0 ? Buffer.from(req.prefixBytes).toString('utf8') : ''
      const { system, messages } = spansToMessages(req.spans, prefix)

      const payload: Record<string, unknown> = {
        model: deps.model,
        max_tokens: maxTokens,
        messages,
      }
      if (system.length > 0) payload['system'] = system
      if (deps.tools && deps.tools.length > 0) payload['tools'] = deps.tools

      let res: Response
      try {
        res = await fetchImpl(`${apiBase}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': deps.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        const kind = (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'server-error'
        throw new AnthropicError(kind, `Anthropic request failed: ${(err as Error)?.message ?? 'unknown'}`)
      }

      if (res.status === 429) throw new AnthropicError('rate-limit', 'Anthropic 429')
      if (res.status >= 500) throw new AnthropicError('server-error', `Anthropic ${res.status}`)
      if (res.status >= 400) throw new AnthropicError('server-error', `Anthropic client error ${res.status}`)

      const body = (await res.json()) as unknown
      return parseResponse(body)
    },
  }
}

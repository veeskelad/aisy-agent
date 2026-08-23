import type {
  EmbeddingDescriptor,
  EmbeddingInput,
  EmbeddingProvider,
} from './hybrid-retrieval.js'

const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings'
const MAX_BATCH_ITEMS = 128
const MAX_INPUT_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export class OpenRouterEmbeddingError extends Error {
  constructor(public readonly code:
    | 'UNAVAILABLE'
    | 'REVOKED'
    | 'INVALID_REQUEST'
    | 'INVALID_RESPONSE',
  ) {
    super(code)
    this.name = 'OpenRouterEmbeddingError'
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
  }
  if (!response.body) throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    length += part.value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
  }
}

/** Official OpenRouter /api/v1/embeddings adapter with a fixed egress origin. */
export function makeOpenRouterEmbeddingProvider(input: {
  apiKey: string
  descriptor: EmbeddingDescriptor
  fetchImpl?: typeof fetch
  timeoutMs?: number
  connected?: () => boolean
}): EmbeddingProvider {
  if (input.descriptor.provider !== 'openrouter' || input.apiKey.length === 0) {
    throw new OpenRouterEmbeddingError('INVALID_REQUEST')
  }
  const descriptor = Object.freeze({ ...input.descriptor })
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new OpenRouterEmbeddingError('INVALID_REQUEST')
  }
  let apiKey = input.apiKey
  let revoked = false
  const connected = (): boolean => {
    try {
      return input.connected?.() ?? true
    } catch {
      return false
    }
  }

  return Object.freeze({
    descriptor,
    async health() {
      if (revoked) return 'revoked'
      return apiKey.length > 0 && connected() ? 'healthy' : 'unavailable'
    },
    async embed(
      kind: 'query' | 'document',
      source: readonly EmbeddingInput[],
      signal?: AbortSignal,
    ) {
      if (revoked || apiKey.length === 0) throw new OpenRouterEmbeddingError('REVOKED')
      if (!connected()) throw new OpenRouterEmbeddingError('UNAVAILABLE')
      const inputs: EmbeddingInput[] = source.map((item) => ({ ...item }))
      const totalBytes = inputs.reduce((total, item) => total + Buffer.byteLength(item.content, 'utf8'), 0)
      if (inputs.length < 1 || inputs.length > MAX_BATCH_ITEMS || totalBytes > MAX_INPUT_BYTES) {
        throw new OpenRouterEmbeddingError('INVALID_REQUEST')
      }
      const timeout = AbortSignal.timeout(timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let response: Response
      try {
        response = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: descriptor.modelId,
            input: inputs.map((item) => item.content),
            dimensions: descriptor.dimensions,
            encoding_format: 'float',
            provider: { data_collection: 'deny' },
          }),
        })
      } catch {
        if (revoked || signal?.aborted) throw new OpenRouterEmbeddingError('REVOKED')
        throw new OpenRouterEmbeddingError('UNAVAILABLE')
      }
      if (!response.ok) {
        void response.body?.cancel()
        throw new OpenRouterEmbeddingError('UNAVAILABLE')
      }
      let body: unknown
      try {
        body = await readBoundedJson(response)
      } catch (error) {
        if (error instanceof OpenRouterEmbeddingError) throw error
        throw new OpenRouterEmbeddingError('UNAVAILABLE')
      }
      const parsed = body && typeof body === 'object' ? body as {
        model?: unknown
        data?: unknown
      } : {}
      if (parsed.model !== descriptor.modelId || !Array.isArray(parsed.data) ||
        parsed.data.length !== inputs.length) {
        throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
      }
      const vectors: Array<readonly number[] | undefined> = new Array(inputs.length)
      for (const item of parsed.data) {
        if (!item || typeof item !== 'object') throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
        const value = item as { index?: unknown; embedding?: unknown }
        if (!Number.isInteger(value.index) || typeof value.index !== 'number' ||
          value.index < 0 || value.index >= inputs.length || vectors[value.index] !== undefined ||
          !Array.isArray(value.embedding) || value.embedding.length !== descriptor.dimensions ||
          value.embedding.some((number) => typeof number !== 'number' || !Number.isFinite(number))) {
          throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
        }
        vectors[value.index] = Object.freeze([...value.embedding as number[]])
      }
      if (vectors.some((vector) => vector === undefined)) {
        throw new OpenRouterEmbeddingError('INVALID_RESPONSE')
      }
      return vectors as readonly (readonly number[])[]
    },
    revoke() {
      revoked = true
      apiKey = ''
    },
  })
}

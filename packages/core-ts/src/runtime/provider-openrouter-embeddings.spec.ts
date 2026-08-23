import { describe, expect, it, vi } from 'vitest'
import type { EmbeddingDescriptor } from './hybrid-retrieval.js'
import {
  makeOpenRouterEmbeddingProvider,
  OpenRouterEmbeddingError,
} from './provider-openrouter-embeddings.js'

const descriptor: EmbeddingDescriptor = {
  provider: 'openrouter',
  modelId: 'openai/text-embedding-3-small',
  modelRevision: '2026-07-01',
  dimensions: 3,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'markdown-v1',
}

describe('makeOpenRouterEmbeddingProvider', () => {
  it('uses the fixed official endpoint and restores response index order', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toMatchObject({ authorization: 'Bearer test-key' })
      expect(JSON.parse(String(init?.body))).toEqual({
        model: descriptor.modelId,
        input: ['one', 'two'],
        dimensions: 3,
        encoding_format: 'float',
        provider: { data_collection: 'deny' },
      })
      return new Response(JSON.stringify({
        model: descriptor.modelId,
        data: [
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ],
      }), { status: 200 })
    })
    const provider = makeOpenRouterEmbeddingProvider({
      apiKey: 'test-key', descriptor, fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(provider.embed('document', [
      { content: 'one', contentHash: 'h1' },
      { content: 'two', contentHash: 'h2' },
    ])).resolves.toEqual([[1, 0, 0], [0, 1, 0]])
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/embeddings')
  })

  it('returns redacted typed failures without response or key material', async () => {
    const provider = makeOpenRouterEmbeddingProvider({
      apiKey: 'never-print-this',
      descriptor,
      fetchImpl: async () => new Response('upstream-secret-body', { status: 401 }),
    })
    let error: unknown
    try {
      await provider.embed('query', [{ content: 'query', contentHash: 'h' }])
    } catch (caught) {
      error = caught
    }
    expect(error).toEqual(expect.objectContaining<Partial<OpenRouterEmbeddingError>>({
      code: 'UNAVAILABLE',
    }))
    expect(String(error)).not.toContain('never-print-this')
    expect(String(error)).not.toContain('upstream-secret-body')
  })

  it('rejects malformed dimensions and duplicate response indexes', async () => {
    const provider = makeOpenRouterEmbeddingProvider({
      apiKey: 'key',
      descriptor,
      fetchImpl: async () => new Response(JSON.stringify({
        model: descriptor.modelId,
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 0, embedding: [0, 1, 0] },
        ],
      }), { status: 200 }),
    })
    await expect(provider.embed('query', [
      { content: 'a', contentHash: 'a' },
      { content: 'b', contentHash: 'b' },
    ])).rejects.toThrow(expect.objectContaining<Partial<OpenRouterEmbeddingError>>({
      code: 'INVALID_RESPONSE',
    }))
  })

  it('revocation clears health and blocks later network calls', async () => {
    const fetchImpl = vi.fn()
    const provider = makeOpenRouterEmbeddingProvider({
      apiKey: 'key', descriptor, fetchImpl: fetchImpl as typeof fetch,
    })
    provider.revoke?.()

    await expect(provider.health()).resolves.toBe('revoked')
    await expect(provider.embed('query', [{ content: 'q', contentHash: 'h' }]))
      .rejects.toThrow(expect.objectContaining<Partial<OpenRouterEmbeddingError>>({ code: 'REVOKED' }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

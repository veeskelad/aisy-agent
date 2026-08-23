import { describe, expect, it, vi } from 'vitest'
import {
  HYBRID_LEG_CAP,
  HYBRID_RRF_K,
  HybridRetrievalIntegrityError,
  SensitiveEmbeddingInputError,
  embeddingCacheKey,
  makeHybridRetrieval,
  makeSensitiveEmbeddingProvider,
  reciprocalRankFusion,
  scanEmbeddingInput,
  type EmbeddingDescriptor,
  type EmbeddingProvider,
  type RetrievalScope,
  type ScopedRetrievalCandidate,
} from './hybrid-retrieval.js'

const projectScope: RetrievalScope = {
  kind: 'project',
  scopeId: 'project:alpha',
  projectId: 'alpha',
}

function hit(
  chunkId: string,
  score: number,
  overrides: Partial<ScopedRetrievalCandidate> = {},
): ScopedRetrievalCandidate {
  return {
    hitId: `hit-${chunkId}`,
    scope: 'project',
    scopeId: 'project:alpha',
    projectId: 'alpha',
    sourcePath: 'memory/facts.md',
    chunkId,
    contentHash: `sha256-${chunkId}`,
    provenance: 'operator',
    score,
    ...overrides,
  }
}

describe('reciprocalRankFusion', () => {
  it('uses k=60, rewards overlap and exposes component ranks', () => {
    const result = reciprocalRankFusion(
      [hit('a', -2), hit('b', -1)],
      [hit('b', 0.9), hit('c', 0.8)],
    )

    expect(HYBRID_RRF_K).toBe(60)
    expect(HYBRID_LEG_CAP).toBe(20)
    expect(result.map((item) => item.chunkId)).toEqual(['b', 'a', 'c'])
    expect(result[0]?.score).toBeCloseTo(1 / 62 + 1 / 61)
    expect(result[0]?.componentRanks).toEqual({ keyword: 2, semantic: 1 })
  })

  it('uses bytewise scope/path/chunk tie-breaks and rejects oversized legs', () => {
    const result = reciprocalRankFusion(
      [hit('z', 1), hit('a', 1)],
      [hit('a', 1), hit('z', 1)],
    )
    expect(result.map((item) => item.chunkId)).toEqual(['a', 'z'])
    expect(() => reciprocalRankFusion(
      Array.from({ length: 21 }, (_, index) => hit(String(index), index)),
      [],
    )).toThrow(RangeError)
  })

  it('fails closed when the two legs disagree about immutable metadata', () => {
    expect(() => reciprocalRankFusion(
      [hit('a', 1)],
      [hit('a', 1, { provenance: 'unknown' })],
    )).toThrow(expect.objectContaining<Partial<HybridRetrievalIntegrityError>>({
      code: 'CONFLICTING_HIT',
    }))
    expect(() => reciprocalRankFusion(
      [hit('a', 1)],
      [hit('a', 1, { contentHash: 'stale-content' })],
    )).toThrow(expect.objectContaining<Partial<HybridRetrievalIntegrityError>>({
      code: 'CONFLICTING_HIT',
    }))
  })
})

describe('makeHybridRetrieval', () => {
  it('runs both capped legs and returns a deterministic hybrid result', async () => {
    const keyword = vi.fn(async () => [hit('a', -1), hit('b', -0.5)])
    const semantic = vi.fn(async () => [hit('b', 0.9), hit('c', 0.7)])
    const search = makeHybridRetrieval({
      keyword: { search: keyword },
      semantic: { availability: async () => 'healthy', search: semantic },
    })

    const result = await search.search(projectScope, 'запрос', { mode: 'hybrid', limit: 3 })

    expect(result).toMatchObject({ requestedMode: 'hybrid', effectiveMode: 'hybrid', status: 'OK' })
    expect(result.hits.map((item) => item.chunkId)).toEqual(['b', 'a', 'c'])
    expect(keyword).toHaveBeenCalledWith(projectScope, 'запрос', { limit: 20 })
    expect(semantic).toHaveBeenCalledWith(projectScope, 'запрос', { limit: 20 })
  })

  it('visibly degrades hybrid to keyword when semantic is unavailable', async () => {
    const events: unknown[] = []
    const semanticSearch = vi.fn()
    const search = makeHybridRetrieval({
      keyword: { search: async () => [hit('a', -1)] },
      semantic: { availability: async () => 'revoked', search: semanticSearch },
      emit: (event) => events.push(event),
    })

    await expect(search.search(projectScope, 'query')).resolves.toMatchObject({
      requestedMode: 'hybrid',
      effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE',
      hits: [expect.objectContaining({ chunkId: 'a' })],
    })
    expect(semanticSearch).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ scopeId: 'project:alpha' })])
  })

  it('degrades on provider health/search failure but propagates keyword failure', async () => {
    const healthFailure = makeHybridRetrieval({
      keyword: { search: async () => [hit('a', -1)] },
      semantic: {
        availability: async () => { throw new Error('provider offline') },
        search: async () => [],
      },
    })
    await expect(healthFailure.search(projectScope, 'query')).resolves.toMatchObject({
      effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE',
    })

    const searchFailure = makeHybridRetrieval({
      keyword: { search: async () => [hit('a', -1)] },
      semantic: {
        availability: async () => 'healthy',
        search: async () => { throw new Error('timeout') },
      },
    })
    await expect(searchFailure.search(projectScope, 'query')).resolves.toMatchObject({
      effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE',
    })

    const keywordFailure = makeHybridRetrieval({
      keyword: { search: async () => { throw new Error('fts corrupt') } },
      semantic: { availability: async () => 'healthy', search: async () => [] },
    })
    await expect(keywordFailure.search(projectScope, 'query')).rejects.toThrow('fts corrupt')
  })

  it('reports semantic unavailable without querying keyword in semantic mode', async () => {
    const keyword = vi.fn()
    const search = makeHybridRetrieval({ keyword: { search: keyword } })

    await expect(search.search(projectScope, 'query', { mode: 'semantic' })).resolves.toEqual({
      requestedMode: 'semantic',
      effectiveMode: 'none',
      status: 'SEMANTIC_UNAVAILABLE',
      hits: [],
    })
    expect(keyword).not.toHaveBeenCalled()
  })

  it('keeps a sensitive query local and uses only keyword for hybrid', async () => {
    const semantic = vi.fn()
    const search = makeHybridRetrieval({
      keyword: { search: async () => [hit('a', -1)] },
      semantic: { availability: async () => 'healthy', search: semantic },
    })

    const result = await search.search(projectScope, 'api_key=secret-value', { mode: 'hybrid' })

    expect(result.status).toBe('SENSITIVE_INPUT_LOCAL_ONLY')
    expect(result.effectiveMode).toBe('keyword')
    expect(semantic).not.toHaveBeenCalled()
  })

  it('rejects cross-project candidates instead of degrading or merging them', async () => {
    const search = makeHybridRetrieval({
      keyword: { search: async () => [hit('other', -1, {
        scopeId: 'project:beta',
        projectId: 'beta',
      })] },
    })

    await expect(search.search(projectScope, 'query', { mode: 'keyword' })).rejects.toThrow(
      expect.objectContaining<Partial<HybridRetrievalIntegrityError>>({ code: 'CROSS_SCOPE_HIT' }),
    )
  })

  it('rejects a leg that violates the 20-candidate contract', async () => {
    const search = makeHybridRetrieval({
      keyword: {
        search: async () => Array.from({ length: 21 }, (_, index) => hit(String(index), index)),
      },
    })
    await expect(search.search(projectScope, 'query', { mode: 'keyword' })).rejects.toThrow(
      expect.objectContaining<Partial<HybridRetrievalIntegrityError>>({ code: 'INVALID_HIT' }),
    )
  })

  it('does not hide a semantic scope violation behind keyword fallback', async () => {
    const search = makeHybridRetrieval({
      keyword: { search: async () => [hit('a', -1)] },
      semantic: {
        availability: async () => 'healthy',
        search: async () => [hit('leak', 0.9, { scopeId: 'project:beta', projectId: 'beta' })],
      },
    })

    await expect(search.search(projectScope, 'query')).rejects.toThrow(
      expect.objectContaining<Partial<HybridRetrievalIntegrityError>>({ code: 'CROSS_SCOPE_HIT' }),
    )
  })
})

describe('embedding boundary', () => {
  const descriptor: EmbeddingDescriptor = {
    provider: 'openrouter',
    modelId: 'vendor/model',
    modelRevision: '2026-07-01',
    dimensions: 3,
    normalizationVersion: 'nfkc-v1',
    chunkerVersion: 'markdown-v1',
  }

  it('detects protected paths, credentials and high-entropy tokens deterministically', () => {
    expect(scanEmbeddingInput({ content: 'обычный публичный текст' })).toEqual({ safe: true, reasons: [] })
    expect(scanEmbeddingInput({ content: 'text', sourcePath: '.ssh/id_ed25519' })).toMatchObject({
      safe: false,
      reasons: ['PROTECTED_PATH'],
    })
    expect(scanEmbeddingInput({ content: 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' }).safe).toBe(false)
    expect(scanEmbeddingInput({ content: 'pQ7/xY9_A2+bC4-dE6=fG8hJ0kLmN' }).reasons)
      .toContain('HIGH_ENTROPY_TOKEN')
  })

  it('blocks a batch before provider I/O and never includes secret bytes in the error', async () => {
    const embed = vi.fn()
    const provider: EmbeddingProvider = {
      descriptor,
      health: async () => 'healthy',
      embed,
    }
    const safe = makeSensitiveEmbeddingProvider({ provider })
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'

    const promise = safe.embed('document', [{ content: secret, contentHash: 'hash' }])
    await expect(promise).rejects.toThrow(SensitiveEmbeddingInputError)
    await expect(promise).rejects.not.toThrow(secret)
    expect(embed).not.toHaveBeenCalled()
  })

  it('validates dimensions and finite values returned by a provider', async () => {
    const safe = makeSensitiveEmbeddingProvider({
      provider: {
        descriptor,
        health: async () => 'healthy',
        embed: async () => [[1, 2]],
      },
    })
    await expect(safe.embed('query', [{ content: 'safe query', contentHash: 'h' }]))
      .rejects.toThrow('invalid embedding response')
  })

  it('snapshots inputs before the sensitivity/provider boundary', async () => {
    let received = ''
    const safe = makeSensitiveEmbeddingProvider({
      provider: {
        descriptor,
        health: async () => 'healthy',
        embed: async (_kind, inputs) => {
          received = inputs[0]?.content ?? ''
          return [[1, 0, 0]]
        },
      },
    })
    const value = { content: 'safe original', contentHash: 'hash' }
    const pending = safe.embed('document', [value])
    value.content = 'api_key=secret-after-call'

    await pending
    expect(received).toBe('safe original')
  })

  it('builds a stable cache key and changes it for every normative descriptor field', () => {
    const base = embeddingCacheKey(descriptor, 'content-hash')
    expect(embeddingCacheKey({ ...descriptor }, 'content-hash')).toBe(base)
    const variants: EmbeddingDescriptor[] = [
      { ...descriptor, provider: 'other' },
      { ...descriptor, modelId: 'other/model' },
      { ...descriptor, modelRevision: '2026-07-02' },
      { ...descriptor, dimensions: 4 },
      { ...descriptor, normalizationVersion: 'nfkc-v2' },
      { ...descriptor, chunkerVersion: 'markdown-v2' },
    ]
    expect(variants.map((value) => embeddingCacheKey(value, 'content-hash')))
      .not.toContain(base)
    expect(embeddingCacheKey(descriptor, 'other-content')).not.toBe(base)
  })
})

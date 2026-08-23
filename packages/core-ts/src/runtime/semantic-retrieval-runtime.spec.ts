import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  EmbeddingDescriptor,
  EmbeddingProvider,
  RetrievalScope,
  ScopedRetrievalCandidate,
} from './hybrid-retrieval.js'
import { embeddingCacheKey } from './hybrid-retrieval.js'
import {
  makeSemanticRetrievalRuntime,
  normalizedEmbeddingContentHash,
} from './semantic-retrieval-runtime.js'
import { makeSqliteVecSemanticStore } from './sqlite-vec-semantic-store.js'

const descriptor: EmbeddingDescriptor = {
  provider: 'openrouter',
  modelId: 'vendor/model',
  modelRevision: 'rev-1',
  dimensions: 3,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'markdown-v1',
}
const scope: RetrievalScope = {
  kind: 'project', scopeId: 'project:alpha', projectId: 'alpha',
}

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'aisy-semantic-')), 'semantic.db')
}

function canonicalContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function candidate(
  content: string,
  identity: { hitId: string; sourcePath: string; chunkId: string } = {
    hitId: 'hit-1', sourcePath: 'memory/facts.md', chunkId: 'chunk-1',
  },
): ScopedRetrievalCandidate {
  return {
    hitId: identity.hitId,
    scope: 'project',
    scopeId: 'project:alpha',
    projectId: 'alpha',
    sourcePath: identity.sourcePath,
    chunkId: identity.chunkId,
    contentHash: canonicalContentHash(content),
    provenance: 'operator',
    score: 0,
  }
}

function provider(embed: EmbeddingProvider['embed']): EmbeddingProvider {
  return { descriptor, health: async () => 'healthy', embed }
}

describe('makeSemanticRetrievalRuntime', () => {
  it('keeps the canonical CRLF/NFKC hash for live verification and embeds the normalized hash', async () => {
    const content = 'Cafe\u0301\r\nСтатус проекта.'
    const canonicalHash = canonicalContentHash(content)
    const normalizedHash = normalizedEmbeddingContentHash(content)
    expect(canonicalHash).not.toBe(normalizedHash)
    const verifyLive = vi.fn(async (record) =>
      record.candidate.contentHash === canonicalHash)
    const embed = vi.fn(async (_kind, inputs) => {
      expect(inputs).toEqual([expect.objectContaining({
        content,
        contentHash: normalizedHash,
      })])
      return [[1, 0, 0]]
    })
    const store = makeSqliteVecSemanticStore({
      dbPath: dbPath(), scope, descriptor, verifyLive,
    })
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: provider(embed), store })

    await expect(runtime.indexDocument({
      candidate: candidate(content), factKey: 'fact-1', content,
    })).resolves.toBe('INDEXED')
    await expect(store.search([1, 0, 0], 20)).resolves.toEqual([
      expect.objectContaining({ contentHash: canonicalHash }),
    ])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(verifyLive).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({ contentHash: canonicalHash }),
      cacheKey: embeddingCacheKey(descriptor, normalizedHash),
    }))
    store.close()
  })

  it('shares normalized document cache while retaining separate canonical live identities', async () => {
    const decomposed = 'Cafe\u0301\r\nline'
    const composed = 'Café\nline'
    const normalizedHash = normalizedEmbeddingContentHash(decomposed)
    expect(normalizedEmbeddingContentHash(composed)).toBe(normalizedHash)
    expect(canonicalContentHash(decomposed)).not.toBe(canonicalContentHash(composed))
    const verifiedHashes: string[] = []
    const embed = vi.fn(async () => [[1, 0, 0]])
    const store = makeSqliteVecSemanticStore({
      dbPath: dbPath(), scope, descriptor,
      verifyLive: async (record) => {
        verifiedHashes.push(record.candidate.contentHash)
        return true
      },
    })
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: provider(embed), store })

    await expect(runtime.indexDocument({
      candidate: candidate(decomposed, {
        hitId: 'hit-a', sourcePath: 'memory/a.md', chunkId: 'chunk-a',
      }),
      factKey: 'fact-a',
      content: decomposed,
    })).resolves.toBe('INDEXED')
    await expect(runtime.indexDocument({
      candidate: candidate(composed, {
        hitId: 'hit-b', sourcePath: 'memory/b.md', chunkId: 'chunk-b',
      }),
      factKey: 'fact-b',
      content: composed,
    })).resolves.toBe('CACHED')

    expect(embed).toHaveBeenCalledTimes(1)
    expect(store.getCached(embeddingCacheKey(descriptor, normalizedHash))).toEqual([1, 0, 0])
    await expect(store.search([1, 0, 0], 20)).resolves.toHaveLength(2)
    expect(new Set(verifiedHashes)).toEqual(new Set([
      canonicalContentHash(decomposed),
      canonicalContentHash(composed),
    ]))
    store.close()
  })

  it('indexes, searches and reuses document/query cache across restart', async () => {
    const path = dbPath()
    const firstEmbed = vi.fn(async (kind: 'query' | 'document') =>
      kind === 'document' ? [[1, 0, 0]] : [[0.9, 0.1, 0]])
    const firstStore = makeSqliteVecSemanticStore({
      dbPath: path, scope, descriptor, verifyLive: async () => true,
    })
    const first = makeSemanticRetrievalRuntime({
      scope, provider: provider(firstEmbed), store: firstStore,
    })
    const content = 'Проект использует TypeScript.'
    await expect(first.indexDocument({ candidate: candidate(content), factKey: 'fact-1', content }))
      .resolves.toBe('INDEXED')
    await expect(first.search(scope, 'TypeScript', { limit: 20 })).resolves.toEqual([
      expect.objectContaining({ hitId: 'hit-1' }),
    ])
    expect(firstEmbed).toHaveBeenCalledTimes(2)
    firstStore.close()

    const secondEmbed = vi.fn()
    const secondStore = makeSqliteVecSemanticStore({
      dbPath: path, scope, descriptor, verifyLive: async () => true,
    })
    const second = makeSemanticRetrievalRuntime({
      scope, provider: provider(secondEmbed), store: secondStore,
    })
    await expect(second.indexDocument({ candidate: candidate(content), factKey: 'fact-1', content }))
      .resolves.toBe('CACHED')
    await expect(second.search(scope, 'TypeScript', { limit: 20 })).resolves.toHaveLength(1)
    expect(secondEmbed).not.toHaveBeenCalled()
    secondStore.close()
  })

  it('skips sensitive documents before provider I/O and removes an old vector', async () => {
    const embed = vi.fn(async () => [[1, 0, 0]])
    const store = makeSqliteVecSemanticStore({
      dbPath: dbPath(), scope, descriptor, verifyLive: async () => true,
    })
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: provider(embed), store })
    const safe = 'safe document'
    await runtime.indexDocument({ candidate: candidate(safe), factKey: 'fact-1', content: safe })
    const sensitive = 'api_key=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'

    await expect(runtime.indexDocument({
      candidate: candidate(sensitive), factKey: 'fact-1', content: sensitive,
    })).resolves.toBe('SKIPPED_SENSITIVE')
    expect(embed).toHaveBeenCalledTimes(1)
    await expect(store.search([1, 0, 0], 20)).resolves.toEqual([])
    store.close()
  })

  it('does not retain document cache when the protected live filter rejects publication', async () => {
    const embed = vi.fn(async () => [[1, 0, 0]])
    const store = makeSqliteVecSemanticStore({
      dbPath: dbPath(), scope, descriptor, verifyLive: async () => false,
    })
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: provider(embed), store })
    const content = 'safe but no longer live'
    const value = candidate(content)

    await expect(runtime.indexDocument({ candidate: value, factKey: 'fact-1', content }))
      .rejects.toThrow(expect.objectContaining({ code: 'DERIVED_FILTER_VIOLATION' }))
    expect(store.getCached(
      embeddingCacheKey(descriptor, normalizedEmbeddingContentHash(content)),
    )).toBeNull()
    await expect(store.search([1, 0, 0], 20)).resolves.toEqual([])
    store.close()
  })

  it('aborts in-flight embedding before revocation purge can be repopulated', async () => {
    let observedSignal: AbortSignal | undefined
    const embed = vi.fn((_kind, _inputs, signal?: AbortSignal) => new Promise<readonly (readonly number[])[]>((resolve, reject) => {
      observedSignal = signal
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      void resolve
    }))
    const path = dbPath()
    const store = makeSqliteVecSemanticStore({
      dbPath: path, scope, descriptor, verifyLive: async () => true,
    })
    const raw = provider(embed)
    raw.revoke = vi.fn()
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: raw, store })
    const content = 'safe document'
    const pending = runtime.indexDocument({ candidate: candidate(content), factKey: 'fact-1', content })
    await Promise.resolve()

    runtime.revokeAndPurge()

    await expect(pending).rejects.toThrow()
    expect(observedSignal?.aborted).toBe(true)
    expect(store.state()).toBe('revoked')
    expect(store.integrityCheck()).toEqual({ ok: true })
    store.close()
  })

  it('rejects wrong scope and mismatched content hash before provider I/O', async () => {
    const embed = vi.fn(async () => [[1, 0, 0]])
    const store = makeSqliteVecSemanticStore({
      dbPath: dbPath(), scope, descriptor, verifyLive: async () => true,
    })
    const runtime = makeSemanticRetrievalRuntime({ scope, provider: provider(embed), store })
    await expect(runtime.search(
      { kind: 'project', scopeId: 'project:beta', projectId: 'beta' },
      'query',
      { limit: 20 },
    )).rejects.toThrow(expect.objectContaining({ code: 'CROSS_SCOPE_HIT' }))
    const value = candidate('one')
    await expect(runtime.indexDocument({ candidate: value, factKey: 'fact-1', content: 'two' }))
      .rejects.toThrow(expect.objectContaining({ code: 'INVALID_RECORD' }))
    expect(embed).not.toHaveBeenCalled()
    store.close()
  })
})

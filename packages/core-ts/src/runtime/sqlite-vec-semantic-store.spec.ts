import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddingCacheKey, type EmbeddingDescriptor, type RetrievalScope } from './hybrid-retrieval.js'
import {
  makeSqliteVecSemanticStore,
  SemanticVectorStoreError,
  type SemanticIndexRecord,
} from './sqlite-vec-semantic-store.js'

const descriptor: EmbeddingDescriptor = {
  provider: 'openrouter',
  modelId: 'vendor/model',
  modelRevision: 'rev-1',
  dimensions: 3,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'markdown-v1',
}
const alpha: RetrievalScope = {
  kind: 'project',
  scopeId: 'project:alpha',
  projectId: 'alpha',
}

function record(chunkId: string, factKey = `fact-${chunkId}`): SemanticIndexRecord {
  const contentHash = `content-${chunkId}`
  return {
    candidate: {
      hitId: `hit-${chunkId}`,
      scope: 'project',
      scopeId: 'project:alpha',
      projectId: 'alpha',
      sourcePath: 'memory/facts.md',
      chunkId,
      contentHash,
      provenance: 'operator',
      score: 0,
    },
    factKey,
    cacheKey: embeddingCacheKey(descriptor, contentHash),
  }
}

function path(name = 'semantic.db'): string {
  return join(mkdtempSync(join(tmpdir(), 'aisy-vec-')), name)
}

describe('makeSqliteVecSemanticStore', () => {
  it('persists cache/vectors and returns cosine-ranked scoped candidates after restart', async () => {
    const dbPath = path()
    const first = makeSqliteVecSemanticStore({
      dbPath,
      scope: alpha,
      descriptor,
      verifyLive: async () => true,
    })
    const a = record('a')
    const b = record('b')
    first.putCached('document', a.cacheKey, [1, 0, 0])
    await first.upsert(a, [1, 0, 0])
    await first.upsert(b, [0, 1, 0])
    first.close()

    const second = makeSqliteVecSemanticStore({
      dbPath,
      scope: alpha,
      descriptor,
      verifyLive: async () => true,
    })
    expect(second.getCached(a.cacheKey)).toEqual([1, 0, 0])
    await expect(second.search([0.9, 0.1, 0], 2)).resolves.toEqual([
      expect.objectContaining({ chunkId: 'a', scopeId: 'project:alpha' }),
      expect.objectContaining({ chunkId: 'b', scopeId: 'project:alpha' }),
    ])
    expect(second.integrityCheck()).toEqual({ ok: true })
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
    second.close()
  })

  it('rejects a wrong-scope record before writing a vector', async () => {
    const store = makeSqliteVecSemanticStore({
      dbPath: path(),
      scope: alpha,
      descriptor,
      verifyLive: async () => true,
    })
    const wrong = record('wrong')
    wrong.candidate.scopeId = 'project:beta'
    wrong.candidate.projectId = 'beta'

    await expect(store.upsert(wrong, [1, 0, 0])).rejects.toThrow(
      expect.objectContaining<Partial<SemanticVectorStoreError>>({ code: 'INVALID_RECORD' }),
    )
    await expect(store.search([1, 0, 0], 20)).resolves.toEqual([])
    store.close()
  })

  it('disables semantic durably if a derived hit fails the live/forget filter', async () => {
    const dbPath = path()
    let live = true
    const first = makeSqliteVecSemanticStore({
      dbPath,
      scope: alpha,
      descriptor,
      verifyLive: async () => live,
    })
    await first.upsert(record('forgotten'), [1, 0, 0])
    live = false
    await expect(first.search([1, 0, 0], 20)).rejects.toThrow(
      expect.objectContaining<Partial<SemanticVectorStoreError>>({ code: 'FILTER_VIOLATION' }),
    )
    expect(first.state()).toBe('disabled')
    first.close()

    const second = makeSqliteVecSemanticStore({
      dbPath,
      scope: alpha,
      descriptor,
      verifyLive: async () => true,
    })
    expect(second.state()).toBe('disabled')
    await expect(second.search([1, 0, 0], 20)).rejects.toThrow(
      expect.objectContaining<Partial<SemanticVectorStoreError>>({ code: 'DISABLED' }),
    )
    second.close()
  })

  it('removes a forgotten fact from vectors and its document cache', async () => {
    const store = makeSqliteVecSemanticStore({
      dbPath: path(), scope: alpha, descriptor, verifyLive: async () => true,
    })
    const value = record('gone')
    store.putCached('document', value.cacheKey, [1, 0, 0])
    await store.upsert(value, [1, 0, 0])

    store.removeFact(value.factKey)

    expect(store.getCached(value.cacheKey)).toBeNull()
    await expect(store.search([1, 0, 0], 20)).resolves.toEqual([])
    store.close()
  })

  it('persists revocation before purge and requires an empty store to re-enable', async () => {
    const dbPath = path()
    const first = makeSqliteVecSemanticStore({
      dbPath, scope: alpha, descriptor, verifyLive: async () => true,
    })
    const value = record('a')
    first.putCached('document', value.cacheKey, [1, 0, 0])
    await first.upsert(value, [1, 0, 0])
    first.revokeAndPurge()
    expect(first.state()).toBe('revoked')
    expect(() => first.getCached(value.cacheKey)).toThrow(
      expect.objectContaining<Partial<SemanticVectorStoreError>>({ code: 'REVOKED' }),
    )
    first.close()

    const second = makeSqliteVecSemanticStore({
      dbPath, scope: alpha, descriptor, verifyLive: async () => true,
    })
    expect(second.state()).toBe('revoked')
    second.enableAfterReconnect()
    expect(second.state()).toBe('healthy')
    expect(second.getCached(value.cacheKey)).toBeNull()
    second.close()
  })

  it('rejects descriptor or scope reuse of an existing database', () => {
    const dbPath = path()
    makeSqliteVecSemanticStore({
      dbPath, scope: alpha, descriptor, verifyLive: async () => true,
    }).close()
    expect(() => makeSqliteVecSemanticStore({
      dbPath,
      scope: alpha,
      descriptor: { ...descriptor, modelRevision: 'rev-2' },
      verifyLive: async () => true,
    })).toThrow(expect.objectContaining<Partial<SemanticVectorStoreError>>({
      code: 'DESCRIPTOR_MISMATCH',
    }))
    expect(() => makeSqliteVecSemanticStore({
      dbPath,
      scope: { kind: 'project', scopeId: 'project:beta', projectId: 'beta' },
      descriptor,
      verifyLive: async () => true,
    })).toThrow(expect.objectContaining<Partial<SemanticVectorStoreError>>({
      code: 'SCOPE_MISMATCH',
    }))
  })

  it('refuses a symlink or an unidentified pre-existing database file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-vec-path-'))
    const target = join(root, 'target.db')
    const link = join(root, 'link.db')
    writeFileSync(target, 'not a semantic database')
    symlinkSync(target, link)

    expect(() => makeSqliteVecSemanticStore({
      dbPath: link, scope: alpha, descriptor, verifyLive: async () => true,
    })).toThrow(expect.objectContaining<Partial<SemanticVectorStoreError>>({
      code: 'CORRUPT_INDEX',
    }))
    expect(() => makeSqliteVecSemanticStore({
      dbPath: target, scope: alpha, descriptor, verifyLive: async () => true,
    })).toThrow()
  })

  it('stores no canonical text or secret bytes in the disposable database', async () => {
    const dbPath = path()
    const store = makeSqliteVecSemanticStore({
      dbPath, scope: alpha, descriptor, verifyLive: async () => true,
    })
    const value = record('safe')
    await store.upsert(value, [1, 0, 0])
    store.close()

    const bytes = readFileSync(dbPath)
    expect(bytes.includes(Buffer.from('canonical secret body', 'utf8'))).toBe(false)
  })
})

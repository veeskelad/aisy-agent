import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { embeddingCacheKey, type EmbeddingDescriptor } from './hybrid-retrieval.js'
import { makeContextLeaseCoordinator } from './context-lease.js'
import { makeProtectedMemoryDeletionService } from './protected-memory-deletion.js'
import { makeProtectedMemoryFileStore } from './protected-memory-file-store.js'
import { makeProtectedMemoryPublicationService } from './protected-memory-publication.js'
import { makeProtectedMemoryScopeBarrier } from './protected-memory-scope-barrier.js'
import { makeProtectedMemorySemanticDeletionPort } from './protected-memory-semantic-deletion.js'
import { makeProtectedMemorySqliteStore } from './protected-memory-sqlite-store.js'
import {
  makeSemanticRetrievalRuntime,
  normalizedEmbeddingContentHash,
} from './semantic-retrieval-runtime.js'
import { makeSqliteVecSemanticStore, type SemanticIndexRecord } from './sqlite-vec-semantic-store.js'

const roots: string[] = []
const scope = {
  kind: 'project' as const,
  scopeId: 'project:project-a' as const,
  projectId: 'project-a',
}
const descriptor: EmbeddingDescriptor = {
  provider: 'openrouter',
  modelId: 'vendor/model',
  modelRevision: 'rev-1',
  dimensions: 3,
  normalizationVersion: 'nfkc-v1',
  chunkerVersion: 'fact-v1',
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected semantic fact identity', () => {
  it('resolves semantic hitId only as an exact live fact id', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-semantic-identity-')))
    roots.push(root)
    const contentRoot = join(root, 'content')
    mkdirSync(contentRoot, { recursive: true, mode: 0o700 })
    const leases = makeContextLeaseCoordinator({ newId: (() => {
      let next = 0
      return () => `semantic-identity-${++next}`
    })() })
    const lease = leases.acquire({
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'session-a',
      root: contentRoot,
      generation: 1,
    })
    const store = makeProtectedMemorySqliteStore({
      ledgerPath: join(root, 'db', 'ledger.sqlite'),
      keywordPath: join(root, 'db', 'keyword.sqlite'),
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      startedAt: '2026-07-29T12:00:00.000Z',
      deliverAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })
    const files = makeProtectedMemoryFileStore({
      contentRoot,
      stagingRoot: join(root, 'staging'),
    })
    const barrier = makeProtectedMemoryScopeBarrier({
      lockPath: join(root, 'db', 'barrier.sqlite'),
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      nowIso: () => '2026-07-29T12:00:01.000Z',
    })
    const withScopeExclusive = <T>(
      boundLease: typeof lease,
      boundScope: typeof scope,
      run: () => Promise<T>,
    ) => barrier.withScopeExclusive(boundLease, boundScope, run)
    const factKey = sha256('operator|language|russian')
    const publication = makeProtectedMemoryPublicationService({
      leases,
      persistence: () => store,
      files: () => files,
      prepareFact: async () => ({
        factKey,
        keyTokens: ['operator', 'language', 'russian'],
        validAt: '2026-07-29T12:00:02.000Z',
        isHumanConfirmed: true,
        sourceAuthority: 100,
        confidence: 1,
      }),
      withScopeExclusive,
      nowIso: () => '2026-07-29T12:00:03.000Z',
    })
    const semanticStore = makeSqliteVecSemanticStore({
      dbPath: join(root, 'db', 'semantic.sqlite'),
      scope,
      descriptor,
      verifyLive: record => store.verifySemanticRecord(record),
    })
    const semantic = makeSemanticRetrievalRuntime({
      scope,
      provider: {
        descriptor,
        health: async () => 'healthy',
        embed: async () => [[1, 0, 0]],
      },
      store: semanticStore,
    })
    const derived = makeProtectedMemorySemanticDeletionPort({ scope, store: semanticStore })
    const deletion = makeProtectedMemoryDeletionService({
      leases,
      persistence: () => store,
      files: () => files,
      derived: () => derived,
      withScopeExclusive,
      nowIso: () => '2026-07-29T12:00:04.000Z',
    })

    const fact = await publication.publishFact(lease, {
      factId: 'operator-language',
      text: 'Оператор предпочитает ответы на русском языке.',
      provenance: 'session:session-a:turn:1',
      scope,
    })
    expect(fact.operationId).not.toBe(fact.id)
    const candidate = {
      hitId: fact.id,
      scope: 'project' as const,
      scopeId: scope.scopeId,
      projectId: scope.projectId,
      sourcePath: fact.sourcePath,
      chunkId: fact.id,
      contentHash: fact.contentHash,
      provenance: fact.provenance,
      score: 0,
    }
    const record: SemanticIndexRecord = {
      candidate,
      factKey: fact.factKey,
      cacheKey: embeddingCacheKey(descriptor, normalizedEmbeddingContentHash(fact.text)),
    }

    await expect(store.verifySemanticRecord(record)).resolves.toBe(true)
    await expect(semantic.indexDocument({ candidate, factKey: fact.factKey, content: fact.text }))
      .resolves.toBe('INDEXED')
    expect(semanticStore.hasFact(fact.factKey)).toBe(true)

    const wrongHash = sha256('wrong')
    const invalid: SemanticIndexRecord[] = [
      { ...record, candidate: { ...candidate, hitId: 'another-fact' } },
      { ...record, candidate: { ...candidate, hitId: fact.operationId } },
      { ...record, candidate: { ...candidate, chunkId: 'another-fact' } },
      { ...record, candidate: {
        ...candidate, scopeId: 'project:project-b', projectId: 'project-b',
      } },
      { ...record, candidate: { ...candidate, contentHash: wrongHash } },
      { ...record, candidate: { ...candidate, sourcePath: 'memory/facts/wrong.md' } },
      { ...record, candidate: { ...candidate, provenance: 'session:other' } },
      { ...record, factKey: wrongHash },
    ]
    for (const value of invalid) {
      await expect(store.verifySemanticRecord(value)).resolves.toBe(false)
    }

    await expect(deletion.deleteFact(lease, {
      factId: fact.id,
      reason: 'Подтверждённое забывание',
      humanConfirmed: true,
      scope,
    })).resolves.toMatchObject({ status: 'DELETED', humanConfirmed: true })
    await expect(store.verifySemanticRecord(record)).resolves.toBe(false)
    expect(semanticStore.hasFact(fact.factKey)).toBe(false)

    semanticStore.close()
    store.close()
    await leases.quiesceAndClose(lease)
  })
})

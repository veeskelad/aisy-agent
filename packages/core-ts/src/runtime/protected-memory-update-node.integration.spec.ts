import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import { makeProtectedMemoryFileStore, type ProtectedMemoryFileFault } from './protected-memory-file-store.js'
import { makeProtectedMemoryPublicationService, type ProtectedMemoryScope } from './protected-memory-publication.js'
import { makeProtectedMemoryScopeBarrier } from './protected-memory-scope-barrier.js'
import { makeProtectedMemorySemanticDeletionPort } from './protected-memory-semantic-deletion.js'
import {
  makeProtectedMemorySqliteStore,
  type ProtectedMemorySqliteFault,
  type ProtectedMemorySqliteStore,
} from './protected-memory-sqlite-store.js'
import {
  makeProtectedMemoryUpdateService,
  type ProtectedMemoryUpdateAuditEvent,
} from './protected-memory-update.js'
import { makeSqliteVecSemanticStore, type SemanticVectorStore } from './sqlite-vec-semantic-store.js'

type Fault = ProtectedMemorySqliteFault | ProtectedMemoryFileFault | 'after-derived-purge'

const roots: string[] = []
const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const oldText = 'Статус проекта: планирование.'
const oldTokens = ['project', 'status', 'planning']
const oldFactKey = createHash('sha256').update(oldTokens.join('|')).digest('hex')
const newText = 'Статус проекта: в работе.'
const newTokens = ['project', 'status', 'in-progress']
const newFactKey = createHash('sha256').update(newTokens.join('|')).digest('hex')
const publishRequest = {
  factId: 'project-status-planning',
  text: oldText,
  provenance: 'session:session-a:turn:9',
  scope,
}
const updateRequest = {
  targetFactId: publishRequest.factId,
  text: newText,
  provenance: 'session:session-a:turn:10',
  scope,
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-update-')))
  roots.push(root)
  const contentRoot = join(root, 'content')
  mkdirSync(contentRoot, { mode: 0o700 })
  const ledgerPath = join(root, 'db', 'ledger.sqlite')
  const keywordPath = join(root, 'db', 'keyword.sqlite')
  const semanticPath = join(root, 'db', 'semantic.sqlite')
  const stagingRoot = join(root, 'staging')
  const publicationAudit = new Map<string, unknown>()
  const updateAudit = new Map<string, ProtectedMemoryUpdateAuditEvent>()
  let updateAuditAttempts = 0
  let armed: Fault | undefined
  const crash = (point: Fault): void => {
    if (point !== armed) return
    armed = undefined
    throw new Error(`crash:${point}`)
  }
  const open = (): {
    files: ReturnType<typeof makeProtectedMemoryFileStore>
    lease: ReturnType<ReturnType<typeof makeContextLeaseCoordinator>['acquire']>
    publication: ReturnType<typeof makeProtectedMemoryPublicationService>
    semantic: SemanticVectorStore
    store: ProtectedMemorySqliteStore
    update: ReturnType<typeof makeProtectedMemoryUpdateService>
  } => {
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-update-${++id}-${Math.random()}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-a', root: contentRoot, generation: 7,
    })
    const store = makeProtectedMemorySqliteStore({
      ledgerPath,
      keywordPath,
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      startedAt: '2026-07-27T07:00:00.000Z',
      deliverAuditOnce: async (event) => { publicationAudit.set(event.eventId, event) },
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async (event) => {
        updateAuditAttempts += 1
        const existing = updateAudit.get(event.eventId)
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error('update audit conflict')
        }
        updateAudit.set(event.eventId, structuredClone(event))
      },
      faultAt: (point) => crash(point),
    })
    const files = makeProtectedMemoryFileStore({
      contentRoot,
      stagingRoot,
      faultAt: (point) => crash(point),
    })
    const barrier = makeProtectedMemoryScopeBarrier({
      lockPath: join(root, 'db', 'scope-barrier.sqlite'),
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      nowIso: () => '2026-07-27T07:00:30.000Z',
    })
    const semantic = makeSqliteVecSemanticStore({
      dbPath: semanticPath,
      scope,
      descriptor: {
        provider: 'test', modelId: 'test-2d', modelRevision: '1', dimensions: 2,
        normalizationVersion: 'nfkc-v1', chunkerVersion: 'fact-v1',
      },
      verifyLive: async () => true,
    })
    const derived = makeProtectedMemorySemanticDeletionPort({ scope, store: semantic })
    const withScopeExclusive = <T>(boundLease: typeof lease, boundScope: ProtectedMemoryScope,
      run: () => Promise<T>): Promise<T> => barrier.withScopeExclusive(boundLease, boundScope, run)
    const publication = makeProtectedMemoryPublicationService({
      leases,
      persistence: () => store,
      files: () => files,
      prepareFact: async () => ({
        factKey: oldFactKey, keyTokens: oldTokens, validAt: '2026-07-27T07:01:00.000Z',
        isHumanConfirmed: false, sourceAuthority: 50, confidence: 0.9,
      }),
      withScopeExclusive,
      nowIso: () => '2026-07-27T07:02:00.000Z',
    })
    const update = makeProtectedMemoryUpdateService({
      leases,
      persistence: () => store,
      files: () => files,
      derived: () => ({
        async purge(input) {
          await derived.purge(input)
          crash('after-derived-purge')
        },
        verifyPurged: (input) => derived.verifyPurged(input),
      }),
      prepareFact: async () => ({
        factKey: newFactKey, keyTokens: newTokens, validAt: '2026-07-27T07:03:00.000Z',
        isHumanConfirmed: false, sourceAuthority: 50, confidence: 0.95,
      }),
      newFactId: () => 'project-status-in-progress',
      withScopeExclusive,
      nowIso: () => '2026-07-27T07:04:00.000Z',
    })
    return { files, lease, publication, semantic, store, update }
  }
  return {
    arm: (fault: Fault) => { armed = fault },
    contentRoot,
    keywordPath,
    ledgerPath,
    open,
    root,
    updateAudit,
    updateAuditAttempts: () => updateAuditAttempts,
  }
}

async function seed(runtime: ReturnType<ReturnType<typeof fixture>['open']>) {
  const fact = await runtime.publication.publishFact(runtime.lease, publishRequest)
  const cacheKey = createHash('sha256').update(`cache:${fact.contentHash}`).digest('hex')
  runtime.semantic.putCached('document', cacheKey, [0.25, 0.75])
  await runtime.semantic.upsert({
    candidate: {
      hitId: fact.operationId, scope: 'project', scopeId: scope.scopeId, projectId: 'project-a',
      sourcePath: fact.sourcePath, chunkId: fact.id, contentHash: fact.contentHash,
      provenance: fact.provenance, score: 1,
    },
    factKey: fact.factKey,
    cacheKey,
  }, [0.25, 0.75])
  return { cacheKey, fact }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected memory update Node composition', () => {
  it('recovers UPDATE across every real durable adapter boundary', async () => {
    const faults: Fault[] = [
      'after-create-update-wal', 'after-stage-link', 'after-stage', 'after-pending-update',
      'after-advance-update-wal', 'after-link', 'after-unlink-stage',
      'after-update-ledger-swap', 'after-update-keyword-swap', 'after-derived-purge',
      'after-remove-target', 'after-update-audit-delivery', 'after-update-audit-mark',
      'after-delete-update-wal',
    ]
    for (const fault of faults) {
      const h = fixture()
      const first = h.open()
      const seeded = await seed(first)
      h.arm(fault)
      await expect(first.update.updateFact(first.lease, updateRequest)).rejects.toThrow(`crash:${fault}`)
      first.store.close()
      first.semantic.close()

      const restarted = h.open()
      const recovered = await restarted.update.recoverScope(restarted.lease, scope)
      const result = recovered[0] ?? await restarted.update.updateFact(restarted.lease, updateRequest)
      expect(result.status).toBe('SUPERSEDED')
      if (result.status !== 'SUPERSEDED') throw new Error('expected superseded result')
      expect(result.fact).toMatchObject({
        id: 'project-status-in-progress', text: newText, factKey: newFactKey,
        supersedes: oldFactKey, published: true,
      })
      expect(restarted.store.integrityCheck()).toEqual({ ok: true })
      await expect(restarted.store.loadFactByOperation(seeded.fact.operationId)).resolves.toBeNull()
      await expect(restarted.store.loadUpdatedFactByOperation(result.fact.operationId))
        .resolves.toEqual(result.fact)
      await expect(restarted.files.verifyAbsent({ sourcePath: seeded.fact.sourcePath })).resolves.toBe(true)
      await expect(restarted.files.verifyInstalled({
        sourcePath: result.fact.sourcePath,
        contentHash: result.fact.contentHash,
        sizeBytes: Buffer.byteLength(result.fact.text, 'utf8'),
      })).resolves.toBe(true)
      expect(restarted.semantic.hasFact(oldFactKey)).toBe(false)
      expect(restarted.semantic.getCached(seeded.cacheKey)).toBeNull()
      expect(h.updateAudit.size).toBe(1)
      expect(h.updateAuditAttempts()).toBe(fault === 'after-update-audit-delivery' ? 2 : 1)
      const ledger = new Database(h.ledgerPath, { readonly: true })
      const keyword = new Database(h.keywordPath, { readonly: true })
      try {
        expect((ledger.prepare('SELECT count(*) AS count FROM memory_update_wal').get() as
          { count: number }).count).toBe(0)
        expect((ledger.prepare('SELECT count(*) AS count FROM do_not_remember').get() as
          { count: number }).count).toBe(0)
        const rows = keyword.prepare(
          'SELECT operation_id, fact_id, fact_key FROM keyword_metadata',
        ).all() as Array<{ operation_id: string; fact_id: string; fact_key: string }>
        expect(rows).toEqual([{
          operation_id: result.fact.operationId,
          fact_id: result.fact.id,
          fact_key: newFactKey,
        }])
      } finally {
        ledger.close()
        keyword.close()
      }
      restarted.store.close()
      restarted.semantic.close()
    }
  })

  it('returns completed UPDATE idempotently and rejects a second update of its tombstoned target', async () => {
    const h = fixture()
    const runtime = h.open()
    const seeded = await seed(runtime)
    const first = await runtime.update.updateFact(runtime.lease, updateRequest)
    await expect(runtime.update.updateFact(runtime.lease, updateRequest)).resolves.toEqual(first)
    await expect(runtime.update.updateFact(runtime.lease, {
      ...updateRequest,
      text: 'Ещё одна версия.',
      provenance: 'session:session-a:turn:11',
    })).resolves.toEqual({ status: 'NOT_FOUND', factId: publishRequest.factId })
    expect(h.updateAuditAttempts()).toBe(1)

    const resurfaceOperationId = createHash('sha256').update('resurface-old-file').digest('hex')
    await runtime.files.stage({
      operationId: resurfaceOperationId,
      sourcePath: seeded.fact.sourcePath,
      content: Buffer.from(seeded.fact.text, 'utf8'),
      contentHash: seeded.fact.contentHash,
    })
    await runtime.files.install({
      operationId: resurfaceOperationId,
      sourcePath: seeded.fact.sourcePath,
      contentHash: seeded.fact.contentHash,
      sizeBytes: Buffer.byteLength(seeded.fact.text, 'utf8'),
    })
    runtime.semantic.putCached('document', seeded.cacheKey, [0.25, 0.75])
    await runtime.semantic.upsert({
      candidate: {
        hitId: seeded.fact.operationId, scope: 'project', scopeId: scope.scopeId,
        projectId: 'project-a', sourcePath: seeded.fact.sourcePath,
        chunkId: seeded.fact.id, contentHash: seeded.fact.contentHash,
        provenance: seeded.fact.provenance, score: 1,
      },
      factKey: seeded.fact.factKey,
      cacheKey: seeded.cacheKey,
    }, [0.25, 0.75])
    await expect(runtime.update.updateFact(runtime.lease, updateRequest))
      .rejects.toMatchObject({ code: 'TARGET_CONFLICT' })
    runtime.store.close()
    runtime.semantic.close()
  })

  it('blocks readers until update recovery and rejects a foreign project before storage effects', async () => {
    const h = fixture()
    const runtime = h.open()
    await seed(runtime)
    await expect(runtime.update.updateFact(runtime.lease, {
      ...updateRequest,
      scope: { kind: 'project', scopeId: 'project:project-b', projectId: 'project-b' },
    })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })

    h.arm('after-create-update-wal')
    await expect(runtime.update.updateFact(runtime.lease, updateRequest))
      .rejects.toThrow('crash:after-create-update-wal')
    await expect(runtime.update.assertScopeRecovered(runtime.lease, scope))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    await runtime.update.recoverScope(runtime.lease, scope)
    await expect(runtime.update.assertScopeRecovered(runtime.lease, scope)).resolves.toBeUndefined()
    runtime.store.close()
    runtime.semantic.close()
  })

  it('fails closed when a completed update outbox is made pending without its recovery WAL', async () => {
    const h = fixture()
    const runtime = h.open()
    await seed(runtime)
    await runtime.update.updateFact(runtime.lease, updateRequest)
    runtime.store.close()
    runtime.semantic.close()

    const ledger = new Database(h.ledgerPath)
    try {
      ledger.prepare('UPDATE memory_update_audit_outbox SET delivered = 0').run()
    } finally {
      ledger.close()
    }
    expect(() => h.open()).toThrowError(expect.objectContaining({ code: 'CORRUPT_LEDGER' }))
  })
})

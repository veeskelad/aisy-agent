import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeProtectedMemoryDeletionService,
  type ProtectedMemoryDeletionAuditEvent,
  type ProtectedMemoryDeletionDerivedPort,
} from './protected-memory-deletion.js'
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
  makeSqliteVecSemanticStore,
  type SemanticVectorStore,
} from './sqlite-vec-semantic-store.js'

type Fault = ProtectedMemorySqliteFault | ProtectedMemoryFileFault | 'after-derived-purge'

const roots: string[] = []
const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const text = 'Оператор предпочитает получать ответы на русском языке.'
const keyTokens = ['operator', 'language', 'russian']
const factKey = createHash('sha256').update(keyTokens.join('|')).digest('hex')
const request = {
  factId: 'operator-language',
  text,
  provenance: 'session:session-a:turn:9',
  scope,
}
const forgetRequest = {
  factId: request.factId,
  reason: 'Подтверждённый запрос оператора на забывание',
  humanConfirmed: true,
  scope,
}

function fixture(fault?: Fault) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-delete-')))
  roots.push(root)
  const contentRoot = join(root, 'content')
  mkdirSync(contentRoot, { mode: 0o700 })
  const ledgerPath = join(root, 'db', 'ledger.sqlite')
  const keywordPath = join(root, 'db', 'keyword.sqlite')
  const semanticPath = join(root, 'db', 'semantic.sqlite')
  const stagingRoot = join(root, 'staging')
  const publicationAudit = new Map<string, unknown>()
  const deletionAudit = new Map<string, ProtectedMemoryDeletionAuditEvent>()
  let deletionAuditAttempts = 0
  let deletionNow = '2026-07-27T06:33:00.000Z'
  let armed = fault
  const crash = (point: Fault): void => {
    if (point !== armed) return
    armed = undefined
    throw new Error(`crash:${point}`)
  }
  const open = (): {
    deletion: ReturnType<typeof makeProtectedMemoryDeletionService>
    files: ReturnType<typeof makeProtectedMemoryFileStore>
    lease: ReturnType<ReturnType<typeof makeContextLeaseCoordinator>['acquire']>
    publication: ReturnType<typeof makeProtectedMemoryPublicationService>
    semantic: SemanticVectorStore
    store: ProtectedMemorySqliteStore
  } => {
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-op-${++id}-${Math.random()}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'session-a',
      root: contentRoot,
      generation: 7,
    })
    const store = makeProtectedMemorySqliteStore({
      ledgerPath,
      keywordPath,
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      scope,
      startedAt: '2026-07-27T06:30:00.000Z',
      deliverAuditOnce: async (event) => { publicationAudit.set(event.eventId, event) },
      deliverDeletionAuditOnce: async (event) => {
        deletionAuditAttempts += 1
        const existing = deletionAudit.get(event.eventId)
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error('deletion audit conflict')
        }
        deletionAudit.set(event.eventId, structuredClone(event))
      },
      deliverUpdateAuditOnce: async () => undefined,
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
      nowIso: () => '2026-07-27T06:30:30.000Z',
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
    const baseDerived = makeProtectedMemorySemanticDeletionPort({ scope, store: semantic })
    const derived: ProtectedMemoryDeletionDerivedPort = {
      async purge(input) {
        await baseDerived.purge(input)
        crash('after-derived-purge')
      },
      verifyPurged: (input) => baseDerived.verifyPurged(input),
    }
    const withScopeExclusive = <T>(boundLease: typeof lease, boundScope: ProtectedMemoryScope,
      run: () => Promise<T>): Promise<T> => barrier.withScopeExclusive(boundLease, boundScope, run)
    const publication = makeProtectedMemoryPublicationService({
      leases,
      persistence: () => store,
      files: () => files,
      prepareFact: async () => ({
        factKey,
        keyTokens,
        validAt: '2026-07-27T06:31:00.000Z',
        isHumanConfirmed: true,
        sourceAuthority: 100,
        confidence: 1,
      }),
      withScopeExclusive,
      nowIso: () => '2026-07-27T06:32:00.000Z',
    })
    const deletion = makeProtectedMemoryDeletionService({
      leases,
      persistence: () => store,
      files: () => files,
      derived: () => derived,
      withScopeExclusive,
      nowIso: () => deletionNow,
    })
    return { deletion, files, lease, publication, semantic, store }
  }
  return {
    deletionAudit,
    deletionAuditAttempts: () => deletionAuditAttempts,
    keywordPath,
    ledgerPath,
    open,
    publicationAudit,
    root,
    setDeletionNow: (value: string) => { deletionNow = value },
  }
}

async function seed(runtime: ReturnType<ReturnType<typeof fixture>['open']>) {
  const fact = await runtime.publication.publishFact(runtime.lease, request)
  const cacheKey = createHash('sha256').update(`cache:${fact.contentHash}`).digest('hex')
  runtime.semantic.putCached('document', cacheKey, [0.25, 0.75])
  await runtime.semantic.upsert({
    candidate: {
      hitId: fact.operationId,
      scope: 'project',
      scopeId: scope.scopeId,
      projectId: 'project-a',
      sourcePath: fact.sourcePath,
      chunkId: fact.id,
      contentHash: fact.contentHash,
      provenance: fact.provenance,
      score: 1,
    },
    factKey: fact.factKey,
    cacheKey,
  }, [0.25, 0.75])
  return { cacheKey, fact }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected memory deletion Node composition', () => {
  it('recovers forget across every real durable adapter boundary', async () => {
    const faults: Fault[] = [
      'after-create-deletion-wal',
      'after-tombstone',
      'after-advance-deletion-wal',
      'after-keyword-purge',
      'after-derived-purge',
      'after-remove-target',
      'after-deletion-audit-delivery',
      'after-deletion-audit-mark',
      'after-delete-deletion-wal',
    ]
    for (const fault of faults) {
      const h = fixture(fault)
      const first = h.open()
      const seeded = await seed(first)
      await expect(first.deletion.deleteFact(first.lease, forgetRequest))
        .rejects.toThrow(`crash:${fault}`)
      first.store.close()
      first.semantic.close()

      const restarted = h.open()
      const recovered = await restarted.deletion.recoverScope(restarted.lease, scope)
      const result = recovered[0] ?? await restarted.deletion.deleteFact(
        restarted.lease,
        forgetRequest,
      )
      expect(result).toMatchObject({ status: 'DELETED', humanConfirmed: true })
      expect(restarted.store.integrityCheck()).toEqual({ ok: true })
      await expect(restarted.store.loadFactByOperation(seeded.fact.operationId)).resolves.toBeNull()
      await expect(restarted.files.verifyAbsent({ sourcePath: seeded.fact.sourcePath })).resolves.toBe(true)
      expect(restarted.semantic.hasFact(factKey)).toBe(false)
      expect(restarted.semantic.getCached(seeded.cacheKey)).toBeNull()
      expect(h.deletionAudit.size).toBe(1)
      expect(h.deletionAuditAttempts()).toBe(
        fault === 'after-deletion-audit-delivery' ? 2 : 1,
      )
      const ledger = new Database(h.ledgerPath, { readonly: true })
      const keyword = new Database(h.keywordPath, { readonly: true })
      try {
        expect((ledger.prepare(
          'SELECT count(*) AS count FROM memory_deletion_wal',
        ).get() as { count: number }).count).toBe(0)
        expect((ledger.prepare(
          'SELECT count(*) AS count FROM do_not_remember',
        ).get() as { count: number }).count).toBe(1)
        expect((keyword.prepare(
          'SELECT count(*) AS count FROM keyword_metadata',
        ).get() as { count: number }).count).toBe(0)
      } finally {
        ledger.close()
        keyword.close()
      }
      restarted.store.close()
      restarted.semantic.close()
    }
  })

  it('creates only a tombstone for non-human delete', async () => {
    const h = fixture()
    const runtime = h.open()
    const seeded = await seed(runtime)
    const result = await runtime.deletion.deleteFact(runtime.lease, {
      ...forgetRequest,
      humanConfirmed: false,
      reason: 'Факт устарел',
    })
    expect(result).toMatchObject({ status: 'DELETED', humanConfirmed: false })
    const ledger = new Database(h.ledgerPath, { readonly: true })
    try {
      expect((ledger.prepare(
        'SELECT count(*) AS count FROM do_not_remember',
      ).get() as { count: number }).count).toBe(0)
      expect((ledger.prepare(
        'SELECT invalid_at FROM facts WHERE id = ?',
      ).get(seeded.fact.id) as { invalid_at: string }).invalid_at).toBe(
        '2026-07-27T06:33:00.000Z',
      )
    } finally {
      ledger.close()
    }
    runtime.store.close()
    runtime.semantic.close()
  })

  it('classifies exact and residual forget candidates without exposing forget-list rows', async () => {
    const h = fixture()
    const runtime = h.open()
    await seed(runtime)
    expect(runtime.store.classifyForgetCandidates([{ factKey, keyTokens }])).toBe('PASS')

    await runtime.deletion.deleteFact(runtime.lease, forgetRequest)
    const residualTokens = ['different', 'language']
    const unrelatedTokens = ['unrelated', 'weather']
    expect(runtime.store.classifyForgetCandidates([{ factKey, keyTokens }])).toBe('FORGOTTEN')
    expect(runtime.store.classifyForgetCandidates([{
      factKey: createHash('sha256').update(residualTokens.join('|')).digest('hex'),
      keyTokens: residualTokens,
    }])).toBe('REVIEW')
    expect(runtime.store.classifyForgetCandidates([{
      factKey: createHash('sha256').update(unrelatedTokens.join('|')).digest('hex'),
      keyTokens: unrelatedTokens,
    }])).toBe('PASS')
    expect(() => runtime.store.classifyForgetCandidates([{
      factKey,
      keyTokens: ['forged'],
    }])).toThrowError(expect.objectContaining({ code: 'STATE_CONFLICT' }))
    expect(() => runtime.store.classifyForgetCandidates([
      { factKey, keyTokens },
      { factKey, keyTokens: ['forged'] },
    ])).toThrowError(expect.objectContaining({ code: 'STATE_CONFLICT' }))
    runtime.store.close()
    runtime.semantic.close()
  })

  it('promotes a prior tombstone to durable human-confirmed forget without rewriting history', async () => {
    const h = fixture()
    const runtime = h.open()
    const seeded = await seed(runtime)
    await runtime.deletion.deleteFact(runtime.lease, {
      ...forgetRequest,
      humanConfirmed: false,
      reason: 'Факт устарел',
    })
    h.setDeletionNow('2026-07-27T06:34:00.000Z')

    await expect(runtime.deletion.deleteFact(runtime.lease, forgetRequest)).resolves.toMatchObject({
      status: 'DELETED', humanConfirmed: true,
    })
    const event = [...h.deletionAudit.values()].find((candidate) => candidate.humanConfirmed)
    const ledger = new Database(h.ledgerPath, { readonly: true })
    try {
      expect((ledger.prepare(
        'SELECT invalid_at FROM facts WHERE id = ?',
      ).get(seeded.fact.id) as { invalid_at: string }).invalid_at).toBe(
        '2026-07-27T06:33:00.000Z',
      )
      expect((ledger.prepare(
        'SELECT count(*) AS count FROM do_not_remember',
      ).get() as { count: number }).count).toBe(1)
      expect(event).toMatchObject({
        invalidatedAt: '2026-07-27T06:33:00.000Z',
        ts: '2026-07-27T06:34:00.000Z',
      })
      expect(runtime.store.integrityCheck()).toEqual({ ok: true })
    } finally {
      ledger.close()
      runtime.store.close()
      runtime.semantic.close()
    }
  })

  it('fails closed when a completed deletion outbox is made pending without recovery WAL', async () => {
    const h = fixture()
    const runtime = h.open()
    await seed(runtime)
    await runtime.deletion.deleteFact(runtime.lease, forgetRequest)
    runtime.store.close()
    runtime.semantic.close()

    const ledger = new Database(h.ledgerPath)
    try {
      ledger.prepare('UPDATE memory_deletion_audit_outbox SET delivered = 0').run()
    } finally {
      ledger.close()
    }
    expect(() => h.open()).toThrowError(expect.objectContaining({ code: 'CORRUPT_LEDGER' }))
  })
})

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator, type TurnContextLease } from './context-lease.js'
import {
  makeProtectedMemoryPublicationService,
  ProtectedMemoryPublicationError,
  type ProtectedMemoryAuditEvent,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryPublicationFilePort,
  type ProtectedMemoryPublicationPersistencePort,
  type ProtectedMemoryPublicationWalV1,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'

const GLOBAL: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
const PROJECT: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function setup(shared?: ReturnType<typeof state>) {
  const durable = shared ?? state()
  let leaseId = durable.nextLeaseId
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
  durable.nextLeaseId = leaseId
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: '/Users/operator/projects/a',
    generation: 3,
  })
  durable.nextLeaseId = leaseId + 1
  const persistence: ProtectedMemoryPublicationPersistencePort = {
    loadWal: async (id) => structuredClone(durable.wals.get(id) ?? null),
    listWals: async (scope) => [...durable.wals.values()]
      .filter((wal) => wal.scope.scopeId === scope.scopeId)
      .map((wal) => structuredClone(wal)),
    createWal: async (wal) => {
      const existing = durable.wals.get(wal.operationId)
      if (existing && !same(existing, wal)) throw new Error('wal conflict')
      durable.wals.set(wal.operationId, structuredClone(wal))
      durable.effect('create-wal')
    },
    advanceWal: async ({ operationId, expectedPhase, next }) => {
      const current = durable.wals.get(operationId)
      if (!current || current.phase !== expectedPhase) throw new Error('phase conflict')
      durable.wals.set(operationId, structuredClone(next))
      durable.effect(`advance-${next.phase}`)
    },
    loadFactByOperation: async (id) => structuredClone(durable.facts.get(id) ?? null),
    createPendingFactAndOutbox: async ({ fact, audit }) => {
      const current = durable.facts.get(fact.operationId)
      if (current && !same(current, fact)) throw new Error('fact conflict')
      durable.facts.set(fact.operationId, structuredClone(fact))
      const outbox = durable.outbox.get(audit.eventId)
      if (outbox && !same(outbox, audit)) throw new Error('outbox conflict')
      durable.outbox.set(audit.eventId, structuredClone(audit))
      durable.effect('db-pending')
    },
    publishFactAndKeywordProjection: async (fact) => {
      const current = durable.facts.get(fact.operationId)
      if (!current || !same({ ...current, published: false }, fact)) {
        throw new Error('missing pending fact')
      }
      durable.facts.set(fact.operationId, { ...structuredClone(fact), published: true })
      durable.keyword.add(fact.operationId)
      durable.effect('publish')
    },
    verifyPublished: async (fact) => {
      const current = durable.facts.get(fact.operationId)
      return current?.published === true && durable.keyword.has(fact.operationId) &&
        current.contentHash === fact.contentHash && current.sourcePath === fact.sourcePath
    },
    deliverAuditOnce: async (event) => {
      const outbox = durable.outbox.get(event.eventId)
      if (!outbox || !same(outbox, event)) throw new Error('missing outbox')
      if (!durable.delivered.has(event.eventId)) {
        durable.delivered.add(event.eventId)
        durable.auditDeliveries++
      }
      durable.effect('audit')
    },
    auditDelivered: async (id) => durable.delivered.has(id),
    deleteWal: async (id) => {
      durable.wals.delete(id)
      durable.effect('delete-wal')
    },
  }
  const files: ProtectedMemoryPublicationFilePort = {
    stage: async (input) => {
      const existing = durable.staged.get(input.operationId)
      if (existing && !existing.equals(input.content)) throw new Error('stage conflict')
      durable.staged.set(input.operationId, Buffer.from(input.content))
      durable.effect('stage')
    },
    install: async (input) => {
      if (durable.collision) return 'collision'
      const existing = durable.installed.get(input.sourcePath)
      if (existing) return hash(existing) === input.contentHash ? 'already-installed' : 'collision'
      const staged = durable.staged.get(input.operationId)
      if (!staged) throw new Error('missing stage')
      durable.installed.set(input.sourcePath, Buffer.from(staged))
      durable.effect('install')
      return 'installed'
    },
    verifyInstalled: async (input) => {
      const bytes = durable.installed.get(input.sourcePath)
      return bytes !== undefined && bytes.byteLength === input.sizeBytes &&
        hash(bytes) === input.contentHash
    },
  }
  const service = makeProtectedMemoryPublicationService({
    leases,
    persistence: (scope) => {
      durable.resolvedScopes.push(`db:${scope.scopeId}`)
      return persistence
    },
    files: (scope) => {
      durable.resolvedScopes.push(`files:${scope.scopeId}`)
      return files
    },
    prepareFact: async () => {
      durable.prepareCalls++
      const keyTokens = ['operator', 'preference']
      return {
        factKey: hash(keyTokens.join('|')),
        keyTokens,
        validAt: '2026-07-27T12:00:00.000Z',
        isHumanConfirmed: true,
        sourceAuthority: 10,
        confidence: 0.9,
        supersedes: 'b'.repeat(64),
      }
    },
    withScopeExclusive: async (_lease, scope, run) => {
      durable.usableScopes.push(scope.scopeId)
      return run()
    },
    nowIso: () => '2026-07-27T12:00:00.000Z',
  })
  return { durable, lease, leases, service }
}

function state() {
  return {
    wals: new Map<string, ProtectedMemoryPublicationWalV1>(),
    facts: new Map<string, ProtectedMemoryFactRecordV2>(),
    outbox: new Map<string, ProtectedMemoryAuditEvent>(),
    staged: new Map<string, Buffer>(),
    installed: new Map<string, Buffer>(),
    keyword: new Set<string>(),
    delivered: new Set<string>(),
    resolvedScopes: [] as string[],
    usableScopes: [] as string[],
    prepareCalls: 0,
    auditDeliveries: 0,
    nextLeaseId: 0,
    collision: false,
    failAfter: null as string | null,
    effect(label: string) {
      if (this.failAfter === label) {
        this.failAfter = null
        throw new Error(`crash:${label}`)
      }
    },
    visibleFacts(): ProtectedMemoryFactRecordV2[] {
      if (this.wals.size > 0) return []
      return [...this.facts.values()].filter((fact) =>
        fact.published && this.keyword.has(fact.operationId) &&
        this.delivered.has(fact.operationId) && this.installed.has(fact.sourcePath),
      )
    },
  }
}

function request(scope: ProtectedMemoryScope = PROJECT) {
  return {
    factId: 'fact-1',
    text: 'Проверяемый факт',
    provenance: 'session:session-a:turn-1',
    scope,
  }
}

describe('ProtectedMemoryPublicationService', () => {
  it('publishes ledger, canonical file, keyword projection and audit through the exact WAL phases', async () => {
    const value = setup()

    const fact = await value.service.publishFact(value.lease, request())

    expect(fact).toMatchObject({
      id: 'fact-1',
      published: true,
      scope: PROJECT,
      supersedes: 'b'.repeat(64),
      sourcePath: `memory/facts/${hash('fact-1')}.md`,
    })
    expect(value.durable.visibleFacts()).toHaveLength(1)
    expect(value.durable.wals.size).toBe(0)
    expect(value.durable.auditDeliveries).toBe(1)
    expect(value.durable.prepareCalls).toBe(1)
  })

  it.each([
    'create-wal', 'stage', 'db-pending', 'advance-DB_PENDING', 'install',
    'advance-FILE_INSTALLED', 'publish', 'advance-PUBLISHED', 'audit',
    'advance-AUDITED', 'delete-wal',
  ])('recovers idempotently after a crash following %s without premature visibility', async (boundary) => {
    const first = setup()
    first.durable.failAfter = boundary
    await expect(first.service.publishFact(first.lease, request())).rejects.toThrow(`crash:${boundary}`)
    expect(first.durable.visibleFacts()).toHaveLength(boundary === 'delete-wal' ? 1 : 0)
    if (boundary === 'delete-wal') {
      await expect(first.service.assertScopeRecovered(first.lease, PROJECT)).resolves.toBeUndefined()
    } else {
      await expect(first.service.assertScopeRecovered(first.lease, PROJECT)).rejects.toThrowError(
        expect.objectContaining({ code: 'RECOVERY_REQUIRED' }),
      )
    }

    const restarted = setup(first.durable)
    const recovered = await restarted.service.recoverScope(restarted.lease, PROJECT)
    if (boundary === 'delete-wal') {
      expect(recovered).toEqual([])
      await expect(restarted.service.publishFact(restarted.lease, request())).resolves
        .toMatchObject({ published: true })
    } else {
      expect(recovered).toHaveLength(1)
    }
    expect(first.durable.visibleFacts()).toHaveLength(1)
    expect(first.durable.auditDeliveries).toBe(1)
    expect(first.durable.facts.size).toBe(1)
    expect(first.durable.installed.size).toBe(1)
    await expect(restarted.service.assertScopeRecovered(restarted.lease, PROJECT))
      .resolves.toBeUndefined()
  })

  it('returns an already completed operation without re-running fact preparation', async () => {
    const first = setup()
    const completed = await first.service.publishFact(first.lease, request())
    const prepareCalls = first.durable.prepareCalls
    const restarted = setup(first.durable)

    await expect(restarted.service.publishFact(restarted.lease, request())).resolves.toEqual(completed)
    expect(first.durable.prepareCalls).toBe(prepareCalls)
    expect(first.durable.auditDeliveries).toBe(1)
  })

  it('allows an exact project lease to publish global memory but resolves only the global ports', async () => {
    const value = setup()

    const fact = await value.service.publishFact(value.lease, request(GLOBAL))

    expect(fact.scope).toEqual(GLOBAL)
    expect(value.durable.resolvedScopes.every((scope) => scope.endsWith(':global'))).toBe(true)
    expect(value.durable.usableScopes).toEqual(['global'])
  })

  it('rejects a write to another project before resolving storage or preparing a fact', async () => {
    const value = setup()
    const foreign: ProtectedMemoryScope = {
      kind: 'project', scopeId: 'project:project-b', projectId: 'project-b',
    }

    await expect(value.service.publishFact(value.lease, request(foreign))).rejects.toThrowError(
      expect.objectContaining({ code: 'SCOPE_MISMATCH' }),
    )
    expect(value.durable.resolvedScopes).toEqual([])
    expect(value.durable.prepareCalls).toBe(0)
  })

  it('fails closed on a destination collision and leaves the pending fact unpublished', async () => {
    const value = setup()
    value.durable.collision = true

    await expect(value.service.publishFact(value.lease, request())).rejects.toThrowError(
      expect.objectContaining({ code: 'FILE_COLLISION' }),
    )
    expect([...value.durable.facts.values()][0]).toMatchObject({ published: false })
    expect(value.durable.visibleFacts()).toEqual([])
  })

  it('detects canonical file tampering before audit delivery', async () => {
    const first = setup()
    first.durable.failAfter = 'advance-PUBLISHED'
    await expect(first.service.publishFact(first.lease, request())).rejects.toThrow()
    const installedPath = [...first.durable.installed.keys()][0]!
    first.durable.installed.set(installedPath, Buffer.from('tampered'))
    const restarted = setup(first.durable)

    await expect(restarted.service.recoverScope(restarted.lease, PROJECT)).rejects.toThrowError(
      expect.objectContaining({ code: 'PUBLICATION_VERIFICATION_FAILED' }),
    )
    expect(first.durable.delivered.size).toBe(0)
    expect(first.durable.visibleFacts()).toEqual([])
  })

  it('rejects malformed or foreign-scope WAL rows during recovery', async () => {
    const value = setup()
    value.durable.wals.set('bad', {
      scope: PROJECT,
      phase: 'UNKNOWN',
    } as unknown as ProtectedMemoryPublicationWalV1)

    await expect(value.service.recoverScope(value.lease, PROJECT)).rejects.toThrowError(
      expect.objectContaining({ code: 'WAL_CONFLICT' }),
    )
  })

  it('rejects invalid deterministic metadata before creating a WAL', async () => {
    const value = setup()
    const invalid = makeProtectedMemoryPublicationService({
      leases: value.leases,
      persistence: () => ({
        loadWal: async () => null,
        loadFactByOperation: async () => null,
      }) as unknown as ProtectedMemoryPublicationPersistencePort,
      files: () => ({}) as ProtectedMemoryPublicationFilePort,
      prepareFact: async () => ({
        factKey: 'not-a-hash', keyTokens: [], validAt: 'never',
        isHumanConfirmed: false, sourceAuthority: null, confidence: null,
      }),
      withScopeExclusive: async (_lease, _scope, run) => run(),
      nowIso: () => '2026-07-27T12:00:00.000Z',
    })

    await expect(invalid.publishFact(value.lease, request())).rejects.toThrow(
      ProtectedMemoryPublicationError,
    )
  })
})

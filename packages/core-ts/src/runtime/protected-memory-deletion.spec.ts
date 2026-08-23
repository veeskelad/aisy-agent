import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeProtectedMemoryDeletionService,
  parseProtectedMemoryDeletionAuditEvent,
  parseProtectedMemoryDeletionWal,
  type ProtectedMemoryDeletionAuditEvent,
  type ProtectedMemoryDeletionPersistencePort,
  type ProtectedMemoryDeletionWalV1,
} from './protected-memory-deletion.js'
import type { ProtectedMemoryFactRecordV2, ProtectedMemoryScope } from './protected-memory-publication.js'

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const text = 'Оператор живёт в Берлине.'
const target: ProtectedMemoryFactRecordV2 = {
  schemaVersion: 2,
  operationId: sha256('publication-operation'),
  id: 'home-city',
  operatorId: 'telegram:42',
  profileId: 'default',
  scope,
  text,
  factKey: sha256('home|city|berlin'),
  keyTokens: ['home', 'city', 'berlin'],
  validAt: '2026-07-27T06:00:00.000Z',
  invalidAt: null,
  isHumanConfirmed: true,
  sourceAuthority: 100,
  confidence: 1,
  provenance: 'session:session-a:turn:3',
  sourcePath: `memory/facts/${sha256('home-city')}.md`,
  contentHash: sha256(text),
  published: true,
}

type Fault =
  | 'after-create-wal'
  | 'after-tombstone'
  | 'after-TOMBSTONED'
  | 'after-keyword'
  | 'after-KEYWORD_PURGED'
  | 'after-derived'
  | 'after-DERIVED_PURGED'
  | 'after-file'
  | 'after-FILE_REMOVED'
  | 'after-audit-delivery'
  | 'after-audit-mark'
  | 'after-AUDITED'
  | 'after-delete-wal'

function harness(options: {
  fault?: Fault
  nowIso?: () => string
  targetMissing?: boolean
} = {}) {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-operation-${++id}` })
  const lease = leases.acquire({
    operatorId: target.operatorId,
    profileId: target.profileId,
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: '/Users/operator/project-a',
    generation: 7,
  })
  let wal: ProtectedMemoryDeletionWalV1 | null = null
  let invalidatedAt: string | null = null
  let keywordPresent = true
  let derivedPresent = true
  let filePresent = true
  let forgetPresent = false
  const outboxes = new Map<string, ProtectedMemoryDeletionAuditEvent>()
  const deliveredAudits = new Set<string>()
  let auditAttempts = 0
  const externalAudit = new Map<string, ProtectedMemoryDeletionAuditEvent>()
  let armed = options.fault
  const crash = (point: Fault): void => {
    if (armed !== point) return
    armed = undefined
    throw new Error(`crash:${point}`)
  }
  const persistence: ProtectedMemoryDeletionPersistencePort = {
    async loadTargetById(factId) {
      if (options.targetMissing || factId !== target.id) return null
      return { fact: structuredClone(target), invalidatedAt }
    },
    async loadDeletionWal() { return structuredClone(wal) },
    async listDeletionWals() { return wal ? [structuredClone(wal)] : [] },
    async createDeletionWal(value) {
      if (wal && JSON.stringify(wal) !== JSON.stringify(value)) throw new Error('wal conflict')
      wal = structuredClone(value)
      crash('after-create-wal')
    },
    async advanceDeletionWal({ expectedPhase, next }) {
      if (!wal || wal.phase !== expectedPhase) throw new Error('phase conflict')
      wal = structuredClone(next)
      crash(`after-${next.phase}` as Fault)
    },
    async tombstoneAndCreateDeletionOutbox(input) {
      if (invalidatedAt !== null && invalidatedAt !== input.wal.invalidatedAt) {
        throw new Error('target conflict')
      }
      invalidatedAt = input.wal.invalidatedAt
      forgetPresent ||= input.wal.humanConfirmed
      const existing = outboxes.get(input.audit.eventId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(input.audit)) {
        throw new Error('audit conflict')
      }
      outboxes.set(input.audit.eventId, structuredClone(input.audit))
      crash('after-tombstone')
    },
    async purgeKeywordProjection() {
      keywordPresent = false
      crash('after-keyword')
    },
    async verifyDeletionState(value) {
      return invalidatedAt === value.invalidatedAt && !keywordPresent &&
        (!value.humanConfirmed || forgetPresent)
    },
    async loadDeletionAudit(operationId) {
      return structuredClone(outboxes.get(operationId) ?? null)
    },
    async deliverDeletionAuditOnce(event) {
      const outbox = outboxes.get(event.eventId)
      if (!outbox || JSON.stringify(outbox) !== JSON.stringify(event)) throw new Error('audit missing')
      if (deliveredAudits.has(event.eventId)) return
      auditAttempts += 1
      const existing = externalAudit.get(event.eventId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('audit conflict')
      externalAudit.set(event.eventId, structuredClone(event))
      crash('after-audit-delivery')
      deliveredAudits.add(event.eventId)
      crash('after-audit-mark')
    },
    async deletionAuditDelivered(eventId) { return deliveredAudits.has(eventId) },
    async deleteDeletionWal() {
      wal = null
      crash('after-delete-wal')
    },
  }
  const files = {
    async removeInstalled() { filePresent = false; crash('after-file') },
    async verifyAbsent() { return !filePresent },
  }
  const derived = {
    async purge() { derivedPresent = false; crash('after-derived') },
    async verifyPurged() { return !derivedPresent },
  }
  const service = makeProtectedMemoryDeletionService({
    leases,
    persistence: () => persistence,
    files: () => files,
    derived: () => derived,
    withScopeExclusive: async (_lease, _scope, run) => run(),
    nowIso: options.nowIso ?? (() => '2026-07-27T06:05:00.000Z'),
  })
  return {
    auditAttempts: () => auditAttempts,
    auditDelivered: () => deliveredAudits.size > 0,
    derivedPresent: () => derivedPresent,
    externalAudit,
    filePresent: () => filePresent,
    forgetPresent: () => forgetPresent,
    invalidatedAt: () => invalidatedAt,
    keywordPresent: () => keywordPresent,
    lease,
    resurfaceDerived: () => { derivedPresent = true },
    resurfaceFile: () => { filePresent = true },
    service,
    wal: () => wal,
  }
}

const forgetRequest = {
  factId: target.id,
  reason: 'Запрос оператора на удаление персональных данных',
  humanConfirmed: true,
  scope,
}

describe('protected memory deletion state machine', () => {
  it('strictly parses exact WAL and audit schemas', async () => {
    const h = harness({ fault: 'after-create-wal' })
    await expect(h.service.deleteFact(h.lease, forgetRequest)).rejects.toThrow('crash:after-create-wal')
    const wal = h.wal()
    expect(parseProtectedMemoryDeletionWal(wal)).toEqual(wal)
    expect(parseProtectedMemoryDeletionWal({ ...wal, trusted: true })).toBeNull()
    expect(parseProtectedMemoryDeletionWal({ ...wal, phase: 'DONE' })).toBeNull()
    await h.service.recoverScope(h.lease, scope)
    const event = [...h.externalAudit.values()][0]
    expect(parseProtectedMemoryDeletionAuditEvent(event)).toEqual(event)
    expect(parseProtectedMemoryDeletionAuditEvent({ ...event, mutation: 'delete' })).toBeNull()
  })

  it('human-confirmed forget tombstones and removes every live surface', async () => {
    const h = harness()
    const result = await h.service.deleteFact(h.lease, forgetRequest)

    expect(result).toMatchObject({ status: 'DELETED', factId: target.id, humanConfirmed: true })
    expect(h.invalidatedAt()).toBe('2026-07-27T06:05:00.000Z')
    expect(h.forgetPresent()).toBe(true)
    expect(h.keywordPresent()).toBe(false)
    expect(h.derivedPresent()).toBe(false)
    expect(h.filePresent()).toBe(false)
    expect(h.auditDelivered()).toBe(true)
    expect(h.wal()).toBeNull()
  })

  it('non-human delete creates a re-assertable tombstone without permanent forget row', async () => {
    const h = harness()
    const result = await h.service.deleteFact(h.lease, {
      ...forgetRequest,
      humanConfirmed: false,
      reason: 'Устаревший факт',
    })
    expect(result).toMatchObject({ status: 'DELETED', humanConfirmed: false })
    expect(h.forgetPresent()).toBe(false)
  })

  it('promotes an existing non-human tombstone to a permanent human-confirmed forget', async () => {
    let now = '2026-07-27T06:05:00.000Z'
    const h = harness({ nowIso: () => now })
    await h.service.deleteFact(h.lease, {
      ...forgetRequest,
      humanConfirmed: false,
      reason: 'Устаревший факт',
    })
    expect(h.invalidatedAt()).toBe(now)

    now = '2026-07-27T06:06:00.000Z'
    const result = await h.service.deleteFact(h.lease, forgetRequest)
    const event = [...h.externalAudit.values()].find((candidate) => candidate.humanConfirmed)

    expect(result).toMatchObject({ status: 'DELETED', humanConfirmed: true })
    expect(h.invalidatedAt()).toBe('2026-07-27T06:05:00.000Z')
    expect(h.forgetPresent()).toBe(true)
    expect(event).toMatchObject({
      invalidatedAt: '2026-07-27T06:05:00.000Z',
      ts: '2026-07-27T06:06:00.000Z',
    })
  })

  it('verifies every deletion surface again on a completed retry', async () => {
    const h = harness()
    const first = await h.service.deleteFact(h.lease, forgetRequest)
    await expect(h.service.deleteFact(h.lease, forgetRequest)).resolves.toEqual(first)
    expect(h.auditAttempts()).toBe(1)

    h.resurfaceDerived()
    h.resurfaceFile()
    await expect(h.service.deleteFact(h.lease, forgetRequest))
      .rejects.toMatchObject({ code: 'TARGET_CONFLICT' })
  })

  it('returns NOT_FOUND without durable effects for an unknown target', async () => {
    const h = harness({ targetMissing: true })
    await expect(h.service.deleteFact(h.lease, forgetRequest)).resolves.toEqual({
      status: 'NOT_FOUND', factId: target.id,
    })
    expect(h.wal()).toBeNull()
    expect(h.externalAudit.size).toBe(0)
  })

  it('recovers idempotently after every durable effect boundary', async () => {
    const faults: Fault[] = [
      'after-create-wal', 'after-tombstone', 'after-TOMBSTONED',
      'after-keyword', 'after-KEYWORD_PURGED', 'after-derived',
      'after-DERIVED_PURGED', 'after-file', 'after-FILE_REMOVED',
      'after-audit-delivery', 'after-audit-mark', 'after-AUDITED', 'after-delete-wal',
    ]
    for (const fault of faults) {
      const h = harness({ fault })
      await expect(h.service.deleteFact(h.lease, forgetRequest)).rejects.toThrow(`crash:${fault}`)
      const recovered = await h.service.recoverScope(h.lease, scope)
      const result = recovered[0] ?? await h.service.deleteFact(h.lease, forgetRequest)
      expect(result.status).toBe('DELETED')
      expect(h.wal()).toBeNull()
      expect(h.keywordPresent()).toBe(false)
      expect(h.derivedPresent()).toBe(false)
      expect(h.filePresent()).toBe(false)
      expect(h.externalAudit.size).toBe(1)
      expect(h.auditAttempts()).toBe(fault === 'after-audit-delivery' ? 2 : 1)
    }
  })

  it('blocks readers until every deletion WAL is recovered', async () => {
    const h = harness({ fault: 'after-create-wal' })
    await expect(h.service.deleteFact(h.lease, forgetRequest)).rejects.toThrow('crash:after-create-wal')
    await expect(h.service.assertScopeRecovered(h.lease, scope))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    await h.service.recoverScope(h.lease, scope)
    await expect(h.service.assertScopeRecovered(h.lease, scope)).resolves.toBeUndefined()
  })

  it('rejects a foreign project before resolving storage', async () => {
    const h = harness()
    await expect(h.service.deleteFact(h.lease, {
      ...forgetRequest,
      scope: { kind: 'project', scopeId: 'project:project-b', projectId: 'project-b' },
    })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    expect(h.wal()).toBeNull()
  })
})

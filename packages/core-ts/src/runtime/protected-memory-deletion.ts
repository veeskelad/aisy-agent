import { createHash } from 'node:crypto'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import {
  parseProtectedMemoryFactRecord,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SOURCE_PATH = /^memory\/facts\/[a-f0-9]{64}\.md$/

export type ProtectedMemoryDeletionPhase =
  | 'PREPARED'
  | 'TOMBSTONED'
  | 'KEYWORD_PURGED'
  | 'DERIVED_PURGED'
  | 'FILE_REMOVED'
  | 'AUDITED'

export interface ProtectedMemoryDeletionTarget {
  fact: ProtectedMemoryFactRecordV2
  invalidatedAt: string | null
}

export interface ProtectedMemoryDeletionWalV1 {
  schemaVersion: 1
  operationId: string
  operatorId: string
  profileId: string
  sessionId: string
  generation: number
  scope: ProtectedMemoryScope
  phase: ProtectedMemoryDeletionPhase
  target: ProtectedMemoryFactRecordV2
  reason: string
  humanConfirmed: boolean
  invalidatedAt: string
  createdAt: string
  updatedAt: string
}

export interface ProtectedMemoryDeletionAuditEvent {
  eventId: string
  kind: 'memory.committed'
  mutation: 'delete' | 'forget'
  operationId: string
  targetOperationId: string
  operatorId: string
  profileId: string
  scopeId: string
  projectId?: string
  sessionId: string
  factId: string
  factKey: string
  sourcePath: string
  contentHash: string
  reason: string
  humanConfirmed: boolean
  invalidatedAt: string
  ts: string
}

export interface ProtectedMemoryDeletionPersistencePort {
  loadTargetById(factId: string): Promise<ProtectedMemoryDeletionTarget | null>
  loadDeletionWal(operationId: string): Promise<unknown | null>
  listDeletionWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  createDeletionWal(wal: ProtectedMemoryDeletionWalV1): Promise<void>
  advanceDeletionWal(input: {
    operationId: string
    expectedPhase: ProtectedMemoryDeletionPhase
    next: ProtectedMemoryDeletionWalV1
  }): Promise<void>
  tombstoneAndCreateDeletionOutbox(input: {
    wal: ProtectedMemoryDeletionWalV1
    audit: ProtectedMemoryDeletionAuditEvent
  }): Promise<void>
  purgeKeywordProjection(wal: ProtectedMemoryDeletionWalV1): Promise<void>
  verifyDeletionState(wal: ProtectedMemoryDeletionWalV1): Promise<boolean>
  loadDeletionAudit(operationId: string): Promise<unknown | null>
  deliverDeletionAuditOnce(event: ProtectedMemoryDeletionAuditEvent): Promise<void>
  deletionAuditDelivered(eventId: string): Promise<boolean>
  deleteDeletionWal(operationId: string): Promise<void>
}

export interface ProtectedMemoryDeletionDerivedPort {
  purge(input: {
    scope: ProtectedMemoryScope
    factId: string
    factKey: string
    targetOperationId: string
    contentHash: string
  }): Promise<void>
  verifyPurged(input: {
    scope: ProtectedMemoryScope
    factId: string
    factKey: string
    targetOperationId: string
    contentHash: string
  }): Promise<boolean>
}

export interface ProtectedMemoryDeletionFilePort {
  removeInstalled(input: {
    sourcePath: string
    contentHash: string
    sizeBytes: number
  }): Promise<void>
  verifyAbsent(input: { sourcePath: string }): Promise<boolean>
}

export interface ProtectedMemoryDeletionResult {
  status: 'DELETED' | 'NOT_FOUND'
  factId: string
  operationId?: string
  humanConfirmed?: boolean
}

export interface ProtectedMemoryDeletionService {
  deleteFact(
    lease: TurnContextLease,
    request: {
      factId: string
      reason: string
      humanConfirmed: boolean
      scope: ProtectedMemoryScope
    },
  ): Promise<ProtectedMemoryDeletionResult>
  recoverScope(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
  ): Promise<ProtectedMemoryDeletionResult[]>
  assertScopeRecovered(lease: TurnContextLease, scope: ProtectedMemoryScope): Promise<void>
}

export class ProtectedMemoryDeletionError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'SCOPE_MISMATCH'
    | 'WAL_CONFLICT'
    | 'TARGET_CONFLICT'
    | 'DERIVED_PURGE_FAILED'
    | 'FILE_REMOVAL_FAILED'
    | 'DELETION_VERIFICATION_FAILED'
    | 'AUDIT_VERIFICATION_FAILED'
    | 'RECOVERY_SCOPE_MISMATCH'
    | 'RECOVERY_REQUIRED',
  ) {
    super(code)
    this.name = 'ProtectedMemoryDeletionError'
  }
}

const PHASES = new Set<ProtectedMemoryDeletionPhase>([
  'PREPARED', 'TOMBSTONED', 'KEYWORD_PURGED', 'DERIVED_PURGED', 'FILE_REMOVED', 'AUDITED',
])

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function safeScope(value: unknown): value is ProtectedMemoryScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as Partial<ProtectedMemoryScope>
  if (scope.kind === 'global') return scope.scopeId === 'global' && !('projectId' in scope)
  return scope.kind === 'project' && bounded(scope.projectId, 1024) &&
    scope.scopeId === `project:${scope.projectId}`
}

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

function validTarget(value: unknown): value is ProtectedMemoryDeletionTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as ProtectedMemoryDeletionTarget
  const keys = Object.keys(target)
  const fact = parseProtectedMemoryFactRecord(target.fact)
  return keys.length === 2 && keys.includes('fact') && keys.includes('invalidatedAt') &&
    fact !== null && fact.published === true &&
    (target.invalidatedAt === null || validIso(target.invalidatedAt))
}

export function parseProtectedMemoryDeletionWal(
  value: unknown,
): ProtectedMemoryDeletionWalV1 | null {
  if (typeof value !== 'object' || value === null) return null
  const wal = value as ProtectedMemoryDeletionWalV1
  const expected = new Set([
    'schemaVersion', 'operationId', 'operatorId', 'profileId', 'sessionId',
    'generation', 'scope', 'phase', 'target', 'reason', 'humanConfirmed',
    'invalidatedAt', 'createdAt', 'updatedAt',
  ])
  const keys = Object.keys(wal)
  const target = parseProtectedMemoryFactRecord(wal.target)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    wal.schemaVersion !== 1 || !HASH.test(wal.operationId) ||
    !bounded(wal.operatorId, 1024) || !bounded(wal.profileId, 1024) ||
    !bounded(wal.sessionId, 1024) || !Number.isSafeInteger(wal.generation) || wal.generation < 1 ||
    !safeScope(wal.scope) || !PHASES.has(wal.phase) || !target || !target.published ||
    target.operatorId !== wal.operatorId || target.profileId !== wal.profileId ||
    !sameScope(target.scope, wal.scope) || !bounded(wal.reason, 4096) ||
    typeof wal.humanConfirmed !== 'boolean' || !validIso(wal.invalidatedAt) ||
    !validIso(wal.createdAt) || !validIso(wal.updatedAt)) return null
  return structuredClone(wal)
}

export function parseProtectedMemoryDeletionAuditEvent(
  value: unknown,
): ProtectedMemoryDeletionAuditEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const event = value as ProtectedMemoryDeletionAuditEvent
  const expected = new Set([
    'eventId', 'kind', 'mutation', 'operationId', 'targetOperationId', 'operatorId',
    'profileId', 'scopeId', 'sessionId', 'factId', 'factKey', 'sourcePath',
    'contentHash', 'reason', 'humanConfirmed', 'invalidatedAt', 'ts',
    ...(event.projectId === undefined ? [] : ['projectId']),
  ])
  const keys = Object.keys(event)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    !HASH.test(event.eventId) || event.eventId !== event.operationId ||
    event.kind !== 'memory.committed' ||
    event.mutation !== (event.humanConfirmed ? 'forget' : 'delete') ||
    !HASH.test(event.targetOperationId) || !bounded(event.operatorId, 1024) ||
    !bounded(event.profileId, 1024) || !bounded(event.scopeId, 2048) ||
    !bounded(event.sessionId, 1024) || !ID.test(event.factId) || !HASH.test(event.factKey) ||
    !SOURCE_PATH.test(event.sourcePath) || !HASH.test(event.contentHash) ||
    !bounded(event.reason, 4096) || typeof event.humanConfirmed !== 'boolean' ||
    !validIso(event.invalidatedAt) || !validIso(event.ts) ||
    (event.projectId === undefined
      ? event.scopeId !== 'global'
      : !bounded(event.projectId, 1024) || event.scopeId !== `project:${event.projectId}`)) {
    return null
  }
  return structuredClone(event)
}

function assertLeaseScope(lease: TurnContextLease, scope: ProtectedMemoryScope): void {
  if (scope.kind === 'project' &&
    (lease.projectKind !== 'project' || lease.projectId !== scope.projectId)) {
    throw new ProtectedMemoryDeletionError('SCOPE_MISMATCH')
  }
}

function operationId(input: {
  lease: TurnContextLease
  scope: ProtectedMemoryScope
  target: ProtectedMemoryFactRecordV2
  reason: string
  humanConfirmed: boolean
}): string {
  return sha256(JSON.stringify([
    'aisy.protected-memory-deletion.v1', input.lease.operatorId, input.lease.profileId,
    input.lease.sessionId, input.scope.scopeId, input.target.operationId,
    input.reason, input.humanConfirmed,
  ]))
}

function auditFor(wal: ProtectedMemoryDeletionWalV1): ProtectedMemoryDeletionAuditEvent {
  return {
    eventId: wal.operationId,
    kind: 'memory.committed',
    mutation: wal.humanConfirmed ? 'forget' : 'delete',
    operationId: wal.operationId,
    targetOperationId: wal.target.operationId,
    operatorId: wal.operatorId,
    profileId: wal.profileId,
    scopeId: wal.scope.scopeId,
    ...(wal.scope.kind === 'project' ? { projectId: wal.scope.projectId } : {}),
    sessionId: wal.sessionId,
    factId: wal.target.id,
    factKey: wal.target.factKey,
    sourcePath: wal.target.sourcePath,
    contentHash: wal.target.contentHash,
    reason: wal.reason,
    humanConfirmed: wal.humanConfirmed,
    invalidatedAt: wal.invalidatedAt,
    ts: wal.createdAt,
  }
}

function requestMatches(
  wal: ProtectedMemoryDeletionWalV1,
  lease: TurnContextLease,
  request: { factId: string; reason: string; humanConfirmed: boolean; scope: ProtectedMemoryScope },
): boolean {
  return wal.operatorId === lease.operatorId && wal.profileId === lease.profileId &&
    wal.sessionId === lease.sessionId && wal.generation === lease.generation &&
    sameScope(wal.scope, request.scope) && wal.target.id === request.factId &&
    wal.reason === request.reason && wal.humanConfirmed === request.humanConfirmed
}

export function makeProtectedMemoryDeletionService(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  persistence(scope: ProtectedMemoryScope): ProtectedMemoryDeletionPersistencePort
  files(scope: ProtectedMemoryScope): ProtectedMemoryDeletionFilePort
  derived(scope: ProtectedMemoryScope): ProtectedMemoryDeletionDerivedPort
  withScopeExclusive<T>(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    run: () => Promise<T>,
  ): Promise<T>
  nowIso(): string
}): ProtectedMemoryDeletionService {
  const derivedInput = (wal: ProtectedMemoryDeletionWalV1) => ({
    scope: structuredClone(wal.scope),
    factId: wal.target.id,
    factKey: wal.target.factKey,
    targetOperationId: wal.target.operationId,
    contentHash: wal.target.contentHash,
  })
  const fileInput = (wal: ProtectedMemoryDeletionWalV1) => ({
    sourcePath: wal.target.sourcePath,
    contentHash: wal.target.contentHash,
    sizeBytes: Buffer.byteLength(wal.target.text, 'utf8'),
  })
  const advance = async (
    persistence: ProtectedMemoryDeletionPersistencePort,
    wal: ProtectedMemoryDeletionWalV1,
    phase: ProtectedMemoryDeletionPhase,
  ): Promise<ProtectedMemoryDeletionWalV1> => {
    const next = { ...wal, phase, updatedAt: deps.nowIso() }
    if (!parseProtectedMemoryDeletionWal(next)) throw new ProtectedMemoryDeletionError('WAL_CONFLICT')
    await persistence.advanceDeletionWal({ operationId: wal.operationId, expectedPhase: wal.phase, next })
    return next
  }
  const finish = async (
    walInput: ProtectedMemoryDeletionWalV1,
    persistence: ProtectedMemoryDeletionPersistencePort,
    files: ProtectedMemoryDeletionFilePort,
    derived: ProtectedMemoryDeletionDerivedPort,
  ): Promise<ProtectedMemoryDeletionResult> => {
    let wal = walInput
    while (true) {
      if (wal.phase === 'PREPARED') {
        await persistence.tombstoneAndCreateDeletionOutbox({ wal, audit: auditFor(wal) })
        wal = await advance(persistence, wal, 'TOMBSTONED')
        continue
      }
      if (wal.phase === 'TOMBSTONED') {
        await persistence.purgeKeywordProjection(wal)
        wal = await advance(persistence, wal, 'KEYWORD_PURGED')
        continue
      }
      if (wal.phase === 'KEYWORD_PURGED') {
        await derived.purge(derivedInput(wal))
        if (!await derived.verifyPurged(derivedInput(wal))) {
          throw new ProtectedMemoryDeletionError('DERIVED_PURGE_FAILED')
        }
        wal = await advance(persistence, wal, 'DERIVED_PURGED')
        continue
      }
      if (wal.phase === 'DERIVED_PURGED') {
        await files.removeInstalled(fileInput(wal))
        if (!await files.verifyAbsent({ sourcePath: wal.target.sourcePath })) {
          throw new ProtectedMemoryDeletionError('FILE_REMOVAL_FAILED')
        }
        wal = await advance(persistence, wal, 'FILE_REMOVED')
        continue
      }
      if (wal.phase === 'FILE_REMOVED') {
        if (!await persistence.verifyDeletionState(wal) ||
          !await derived.verifyPurged(derivedInput(wal)) ||
          !await files.verifyAbsent({ sourcePath: wal.target.sourcePath })) {
          throw new ProtectedMemoryDeletionError('DELETION_VERIFICATION_FAILED')
        }
        await persistence.deliverDeletionAuditOnce(auditFor(wal))
        wal = await advance(persistence, wal, 'AUDITED')
        continue
      }
      if (!await persistence.verifyDeletionState(wal) ||
        !await derived.verifyPurged(derivedInput(wal)) ||
        !await files.verifyAbsent({ sourcePath: wal.target.sourcePath }) ||
        !await persistence.deletionAuditDelivered(wal.operationId)) {
        throw new ProtectedMemoryDeletionError('AUDIT_VERIFICATION_FAILED')
      }
      await persistence.deleteDeletionWal(wal.operationId)
      return {
        status: 'DELETED',
        factId: wal.target.id,
        operationId: wal.operationId,
        humanConfirmed: wal.humanConfirmed,
      }
    }
  }

  return Object.freeze<ProtectedMemoryDeletionService>({
    async deleteFact(lease, request) {
      assertLeaseScope(lease, request.scope)
      if (!ID.test(request.factId) || !bounded(request.reason, 4096) ||
        typeof request.humanConfirmed !== 'boolean' || !safeScope(request.scope)) {
        throw new ProtectedMemoryDeletionError('INVALID_REQUEST')
      }
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        return await deps.withScopeExclusive(lease, request.scope, async () => {
          const persistence = deps.persistence(request.scope)
          const files = deps.files(request.scope)
          const derived = deps.derived(request.scope)
          const target = await persistence.loadTargetById(request.factId)
          if (!target) return { status: 'NOT_FOUND', factId: request.factId }
          if (!validTarget(target) || target.fact.operatorId !== lease.operatorId ||
            target.fact.profileId !== lease.profileId || !sameScope(target.fact.scope, request.scope)) {
            throw new ProtectedMemoryDeletionError('TARGET_CONFLICT')
          }
          const id = operationId({
            lease,
            scope: request.scope,
            target: target.fact,
            reason: request.reason,
            humanConfirmed: request.humanConfirmed,
          })
          const existing = await persistence.loadDeletionWal(id)
          if (existing !== null) {
            const wal = parseProtectedMemoryDeletionWal(existing)
            if (!wal || !requestMatches(wal, lease, request)) {
              throw new ProtectedMemoryDeletionError('WAL_CONFLICT')
            }
            return finish(wal, persistence, files, derived)
          }
          const completed = parseProtectedMemoryDeletionAuditEvent(
            await persistence.loadDeletionAudit(id),
          )
          if (completed) {
            const completedWal: ProtectedMemoryDeletionWalV1 = {
              schemaVersion: 1,
              operationId: id,
              operatorId: lease.operatorId,
              profileId: lease.profileId,
              sessionId: lease.sessionId,
              generation: lease.generation,
              scope: structuredClone(request.scope),
              phase: 'AUDITED',
              target: target.fact,
              reason: request.reason,
              humanConfirmed: request.humanConfirmed,
              invalidatedAt: completed.invalidatedAt,
              createdAt: completed.invalidatedAt,
              updatedAt: completed.invalidatedAt,
            }
            if (completed.factId !== request.factId || completed.reason !== request.reason ||
              completed.humanConfirmed !== request.humanConfirmed ||
              completed.targetOperationId !== target.fact.operationId ||
              !await persistence.verifyDeletionState(completedWal) ||
              !await derived.verifyPurged(derivedInput(completedWal)) ||
              !await files.verifyAbsent({ sourcePath: target.fact.sourcePath }) ||
              !await persistence.deletionAuditDelivered(id)) {
              throw new ProtectedMemoryDeletionError('TARGET_CONFLICT')
            }
            return {
              status: 'DELETED', factId: request.factId,
              operationId: id, humanConfirmed: request.humanConfirmed,
            }
          }
          if (target.invalidatedAt !== null && !request.humanConfirmed) {
            return { status: 'NOT_FOUND', factId: request.factId }
          }
          const createdAt = deps.nowIso()
          const wal: ProtectedMemoryDeletionWalV1 = {
            schemaVersion: 1,
            operationId: id,
            operatorId: lease.operatorId,
            profileId: lease.profileId,
            sessionId: lease.sessionId,
            generation: lease.generation,
            scope: structuredClone(request.scope),
            phase: 'PREPARED',
            target: structuredClone(target.fact),
            reason: request.reason,
            humanConfirmed: request.humanConfirmed,
            invalidatedAt: target.invalidatedAt ?? createdAt,
            createdAt,
            updatedAt: createdAt,
          }
          if (!parseProtectedMemoryDeletionWal(wal)) {
            throw new ProtectedMemoryDeletionError('INVALID_REQUEST')
          }
          await persistence.createDeletionWal(wal)
          return finish(wal, persistence, files, derived)
        })
      } finally {
        operation.complete()
      }
    },

    async recoverScope(lease, scope) {
      assertLeaseScope(lease, scope)
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        return await deps.withScopeExclusive(lease, scope, async () => {
          const persistence = deps.persistence(scope)
          const files = deps.files(scope)
          const derived = deps.derived(scope)
          const rows = await persistence.listDeletionWals(scope)
          const parsed = rows.map((row) => {
            const wal = parseProtectedMemoryDeletionWal(row)
            if (!wal || wal.operatorId !== lease.operatorId || wal.profileId !== lease.profileId ||
              !sameScope(wal.scope, scope)) {
              throw new ProtectedMemoryDeletionError('RECOVERY_SCOPE_MISMATCH')
            }
            return wal
          }).sort((left, right) => left.operationId.localeCompare(right.operationId))
          const results: ProtectedMemoryDeletionResult[] = []
          for (const wal of parsed) results.push(await finish(wal, persistence, files, derived))
          if ((await persistence.listDeletionWals(scope)).length > 0) {
            throw new ProtectedMemoryDeletionError('RECOVERY_REQUIRED')
          }
          return results
        })
      } finally {
        operation.complete()
      }
    },

    async assertScopeRecovered(lease, scope) {
      assertLeaseScope(lease, scope)
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        await deps.withScopeExclusive(lease, scope, async () => {
          if ((await deps.persistence(scope).listDeletionWals(scope)).length > 0) {
            throw new ProtectedMemoryDeletionError('RECOVERY_REQUIRED')
          }
        })
      } finally {
        operation.complete()
      }
    },
  })
}

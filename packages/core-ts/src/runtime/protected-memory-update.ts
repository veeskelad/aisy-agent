import { createHash } from 'node:crypto'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import type { ProtectedMemoryDeletionDerivedPort } from './protected-memory-deletion.js'
import {
  parseProtectedMemoryFactRecord,
  type PreparedMemoryFactMetadata,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryPublicationFilePort,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SOURCE_PATH = /^memory\/facts\/[a-f0-9]{64}\.md$/
const MAX_TEXT_BYTES = 1_048_576

export type ProtectedMemoryUpdatePhase =
  | 'PREPARED'
  | 'DB_PENDING'
  | 'FILE_INSTALLED'
  | 'LEDGER_SWAPPED'
  | 'KEYWORD_SWAPPED'
  | 'DERIVED_PURGED'
  | 'OLD_FILE_REMOVED'
  | 'AUDITED'

export interface ProtectedMemoryUpdateTarget {
  fact: ProtectedMemoryFactRecordV2
  invalidatedAt: string | null
}

export interface ProtectedMemoryUpdateWalV1 {
  schemaVersion: 1
  operationId: string
  operatorId: string
  profileId: string
  sessionId: string
  generation: number
  scope: ProtectedMemoryScope
  phase: ProtectedMemoryUpdatePhase
  target: ProtectedMemoryFactRecordV2
  fact: ProtectedMemoryFactRecordV2
  supersededAt: string
  createdAt: string
  updatedAt: string
}

export interface ProtectedMemoryUpdateAuditEvent {
  eventId: string
  kind: 'memory.superseded'
  operationId: string
  operatorId: string
  profileId: string
  scopeId: string
  projectId?: string
  sessionId: string
  previousOperationId: string
  previousFactId: string
  previousFactKey: string
  previousSourcePath: string
  previousContentHash: string
  factId: string
  factKey: string
  sourcePath: string
  contentHash: string
  provenance: string
  supersededAt: string
  ts: string
}

export interface ProtectedMemoryUpdatePersistencePort {
  loadUpdateTargetById(factId: string): Promise<ProtectedMemoryUpdateTarget | null>
  loadUpdateWal(operationId: string): Promise<unknown | null>
  listUpdateWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  createUpdateWal(wal: ProtectedMemoryUpdateWalV1): Promise<void>
  advanceUpdateWal(input: {
    operationId: string
    expectedPhase: ProtectedMemoryUpdatePhase
    next: ProtectedMemoryUpdateWalV1
  }): Promise<void>
  createPendingUpdate(input: {
    wal: ProtectedMemoryUpdateWalV1
    audit: ProtectedMemoryUpdateAuditEvent
  }): Promise<void>
  swapUpdateLedger(wal: ProtectedMemoryUpdateWalV1): Promise<void>
  swapUpdateKeywordProjection(wal: ProtectedMemoryUpdateWalV1): Promise<void>
  verifyUpdateState(wal: ProtectedMemoryUpdateWalV1): Promise<boolean>
  loadUpdatedFactByOperation(operationId: string): Promise<ProtectedMemoryFactRecordV2 | null>
  loadUpdateAudit(operationId: string): Promise<unknown | null>
  deliverUpdateAuditOnce(event: ProtectedMemoryUpdateAuditEvent): Promise<void>
  updateAuditDelivered(eventId: string): Promise<boolean>
  deleteUpdateWal(operationId: string): Promise<void>
}

export type ProtectedMemoryUpdateResult =
  | { status: 'SUPERSEDED'; fact: ProtectedMemoryFactRecordV2 }
  | { status: 'NOT_FOUND'; factId: string }

export interface ProtectedMemoryUpdateService {
  updateFact(lease: TurnContextLease, request: {
    targetFactId: string
    text: string
    provenance: string
    scope: ProtectedMemoryScope
  }): Promise<ProtectedMemoryUpdateResult>
  recoverScope(lease: TurnContextLease, scope: ProtectedMemoryScope): Promise<ProtectedMemoryUpdateResult[]>
  assertScopeRecovered(lease: TurnContextLease, scope: ProtectedMemoryScope): Promise<void>
}

export class ProtectedMemoryUpdateError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'SCOPE_MISMATCH'
    | 'WAL_CONFLICT'
    | 'TARGET_CONFLICT'
    | 'FILE_COLLISION'
    | 'FILE_HASH_MISMATCH'
    | 'DERIVED_PURGE_FAILED'
    | 'UPDATE_VERIFICATION_FAILED'
    | 'AUDIT_VERIFICATION_FAILED'
    | 'RECOVERY_SCOPE_MISMATCH'
    | 'RECOVERY_REQUIRED',
  ) {
    super(code)
    this.name = 'ProtectedMemoryUpdateError'
  }
}

const PHASES = new Set<ProtectedMemoryUpdatePhase>([
  'PREPARED', 'DB_PENDING', 'FILE_INSTALLED', 'LEDGER_SWAPPED',
  'KEYWORD_SWAPPED', 'DERIVED_PURGED', 'OLD_FILE_REMOVED', 'AUDITED',
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

function sameFact(left: ProtectedMemoryFactRecordV2, right: ProtectedMemoryFactRecordV2): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function parseProtectedMemoryUpdateWal(value: unknown): ProtectedMemoryUpdateWalV1 | null {
  if (typeof value !== 'object' || value === null) return null
  const wal = value as ProtectedMemoryUpdateWalV1
  const expected = new Set([
    'schemaVersion', 'operationId', 'operatorId', 'profileId', 'sessionId', 'generation',
    'scope', 'phase', 'target', 'fact', 'supersededAt', 'createdAt', 'updatedAt',
  ])
  const keys = Object.keys(wal)
  const target = parseProtectedMemoryFactRecord(wal.target)
  const fact = parseProtectedMemoryFactRecord(wal.fact)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    wal.schemaVersion !== 1 || !HASH.test(wal.operationId) || !bounded(wal.operatorId, 1024) ||
    !bounded(wal.profileId, 1024) || !bounded(wal.sessionId, 1024) ||
    !Number.isSafeInteger(wal.generation) || wal.generation < 1 || !safeScope(wal.scope) ||
    !PHASES.has(wal.phase) || !target || !target.published || !fact || fact.published ||
    target.id === fact.id || fact.operationId !== wal.operationId ||
    target.operatorId !== wal.operatorId || fact.operatorId !== wal.operatorId ||
    target.profileId !== wal.profileId || fact.profileId !== wal.profileId ||
    !sameScope(target.scope, wal.scope) || !sameScope(fact.scope, wal.scope) ||
    fact.supersedes !== target.factKey || !validIso(wal.supersededAt) ||
    !validIso(wal.createdAt) || !validIso(wal.updatedAt)) return null
  return structuredClone(wal)
}

export function parseProtectedMemoryUpdateAuditEvent(
  value: unknown,
): ProtectedMemoryUpdateAuditEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const event = value as ProtectedMemoryUpdateAuditEvent
  const expected = new Set([
    'eventId', 'kind', 'operationId', 'operatorId', 'profileId', 'scopeId', 'sessionId',
    'previousOperationId', 'previousFactId', 'previousFactKey', 'previousSourcePath',
    'previousContentHash', 'factId', 'factKey', 'sourcePath', 'contentHash', 'provenance',
    'supersededAt', 'ts', ...(event.projectId === undefined ? [] : ['projectId']),
  ])
  const keys = Object.keys(event)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    !HASH.test(event.eventId) || event.eventId !== event.operationId ||
    event.kind !== 'memory.superseded' || !bounded(event.operatorId, 1024) ||
    !bounded(event.profileId, 1024) || !bounded(event.scopeId, 2048) ||
    !bounded(event.sessionId, 1024) || !HASH.test(event.previousOperationId) ||
    !ID.test(event.previousFactId) || !HASH.test(event.previousFactKey) ||
    !SOURCE_PATH.test(event.previousSourcePath) || !HASH.test(event.previousContentHash) ||
    !ID.test(event.factId) || event.factId === event.previousFactId || !HASH.test(event.factKey) ||
    !SOURCE_PATH.test(event.sourcePath) || !HASH.test(event.contentHash) ||
    !bounded(event.provenance, 4096) || !validIso(event.supersededAt) || !validIso(event.ts) ||
    (event.projectId === undefined
      ? event.scopeId !== 'global'
      : !bounded(event.projectId, 1024) || event.scopeId !== `project:${event.projectId}`)) return null
  return structuredClone(event)
}

function assertLeaseScope(lease: TurnContextLease, scope: ProtectedMemoryScope): void {
  if (scope.kind === 'project' &&
    (lease.projectKind !== 'project' || lease.projectId !== scope.projectId)) {
    throw new ProtectedMemoryUpdateError('SCOPE_MISMATCH')
  }
}

function operationId(input: {
  lease: TurnContextLease
  scope: ProtectedMemoryScope
  target: ProtectedMemoryFactRecordV2
  contentHash: string
  provenance: string
}): string {
  return sha256(JSON.stringify([
    'aisy.protected-memory-update.v1', input.lease.operatorId, input.lease.profileId,
    input.lease.sessionId, input.scope.scopeId, input.target.operationId,
    input.contentHash, input.provenance,
  ]))
}

function auditFor(wal: ProtectedMemoryUpdateWalV1): ProtectedMemoryUpdateAuditEvent {
  return {
    eventId: wal.operationId,
    kind: 'memory.superseded',
    operationId: wal.operationId,
    operatorId: wal.operatorId,
    profileId: wal.profileId,
    scopeId: wal.scope.scopeId,
    ...(wal.scope.kind === 'project' ? { projectId: wal.scope.projectId } : {}),
    sessionId: wal.sessionId,
    previousOperationId: wal.target.operationId,
    previousFactId: wal.target.id,
    previousFactKey: wal.target.factKey,
    previousSourcePath: wal.target.sourcePath,
    previousContentHash: wal.target.contentHash,
    factId: wal.fact.id,
    factKey: wal.fact.factKey,
    sourcePath: wal.fact.sourcePath,
    contentHash: wal.fact.contentHash,
    provenance: wal.fact.provenance,
    supersededAt: wal.supersededAt,
    ts: wal.createdAt,
  }
}

function requestMatches(wal: ProtectedMemoryUpdateWalV1, lease: TurnContextLease, request: {
  targetFactId: string
  text: string
  provenance: string
  scope: ProtectedMemoryScope
}): boolean {
  return wal.operatorId === lease.operatorId && wal.profileId === lease.profileId &&
    wal.sessionId === lease.sessionId && wal.generation === lease.generation &&
    sameScope(wal.scope, request.scope) && wal.target.id === request.targetFactId &&
    wal.fact.text === request.text && wal.fact.provenance === request.provenance
}

export function makeProtectedMemoryUpdateService(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  persistence(scope: ProtectedMemoryScope): ProtectedMemoryUpdatePersistencePort
  files(scope: ProtectedMemoryScope): ProtectedMemoryPublicationFilePort & {
    removeInstalled(input: { sourcePath: string; contentHash: string; sizeBytes: number }): Promise<void>
    verifyAbsent(input: { sourcePath: string }): Promise<boolean>
  }
  derived(scope: ProtectedMemoryScope): ProtectedMemoryDeletionDerivedPort
  prepareFact(input: {
    lease: TurnContextLease
    scope: ProtectedMemoryScope
    factId: string
    text: string
    provenance: string
  }): Promise<PreparedMemoryFactMetadata>
  newFactId(): string
  withScopeExclusive<T>(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    run: () => Promise<T>,
  ): Promise<T>
  nowIso(): string
}): ProtectedMemoryUpdateService {
  const derivedInput = (wal: ProtectedMemoryUpdateWalV1) => ({
    scope: structuredClone(wal.scope),
    factId: wal.target.id,
    factKey: wal.target.factKey,
    targetOperationId: wal.target.operationId,
    contentHash: wal.target.contentHash,
  })
  const oldFile = (wal: ProtectedMemoryUpdateWalV1) => ({
    sourcePath: wal.target.sourcePath,
    contentHash: wal.target.contentHash,
    sizeBytes: Buffer.byteLength(wal.target.text, 'utf8'),
  })
  const newFile = (wal: ProtectedMemoryUpdateWalV1) => ({
    sourcePath: wal.fact.sourcePath,
    contentHash: wal.fact.contentHash,
    sizeBytes: Buffer.byteLength(wal.fact.text, 'utf8'),
  })
  const advance = async (
    persistence: ProtectedMemoryUpdatePersistencePort,
    wal: ProtectedMemoryUpdateWalV1,
    phase: ProtectedMemoryUpdatePhase,
  ): Promise<ProtectedMemoryUpdateWalV1> => {
    const next = { ...wal, phase, updatedAt: deps.nowIso() }
    if (!parseProtectedMemoryUpdateWal(next)) throw new ProtectedMemoryUpdateError('WAL_CONFLICT')
    await persistence.advanceUpdateWal({ operationId: wal.operationId, expectedPhase: wal.phase, next })
    return next
  }
  const finish = async (
    initial: ProtectedMemoryUpdateWalV1,
    persistence: ProtectedMemoryUpdatePersistencePort,
    files: ReturnType<typeof deps.files>,
    derived: ProtectedMemoryDeletionDerivedPort,
  ): Promise<ProtectedMemoryUpdateResult> => {
    let wal = initial
    const content = Buffer.from(wal.fact.text, 'utf8')
    while (true) {
      if (wal.phase === 'PREPARED') {
        await files.stage({
          operationId: wal.operationId,
          sourcePath: wal.fact.sourcePath,
          content,
          contentHash: wal.fact.contentHash,
        })
        await persistence.createPendingUpdate({ wal, audit: auditFor(wal) })
        wal = await advance(persistence, wal, 'DB_PENDING')
        continue
      }
      if (wal.phase === 'DB_PENDING') {
        const installed = await files.install({ operationId: wal.operationId, ...newFile(wal) })
        if (installed === 'collision') throw new ProtectedMemoryUpdateError('FILE_COLLISION')
        if (!await files.verifyInstalled(newFile(wal))) {
          throw new ProtectedMemoryUpdateError('FILE_HASH_MISMATCH')
        }
        wal = await advance(persistence, wal, 'FILE_INSTALLED')
        continue
      }
      if (wal.phase === 'FILE_INSTALLED') {
        if (!await files.verifyInstalled(newFile(wal))) {
          throw new ProtectedMemoryUpdateError('FILE_HASH_MISMATCH')
        }
        await persistence.swapUpdateLedger(wal)
        wal = await advance(persistence, wal, 'LEDGER_SWAPPED')
        continue
      }
      if (wal.phase === 'LEDGER_SWAPPED') {
        await persistence.swapUpdateKeywordProjection(wal)
        wal = await advance(persistence, wal, 'KEYWORD_SWAPPED')
        continue
      }
      if (wal.phase === 'KEYWORD_SWAPPED') {
        await derived.purge(derivedInput(wal))
        if (!await derived.verifyPurged(derivedInput(wal))) {
          throw new ProtectedMemoryUpdateError('DERIVED_PURGE_FAILED')
        }
        wal = await advance(persistence, wal, 'DERIVED_PURGED')
        continue
      }
      if (wal.phase === 'DERIVED_PURGED') {
        await files.removeInstalled(oldFile(wal))
        if (!await files.verifyAbsent({ sourcePath: wal.target.sourcePath })) {
          throw new ProtectedMemoryUpdateError('UPDATE_VERIFICATION_FAILED')
        }
        wal = await advance(persistence, wal, 'OLD_FILE_REMOVED')
        continue
      }
      if (wal.phase === 'OLD_FILE_REMOVED') {
        if (!await persistence.verifyUpdateState(wal) ||
          !await files.verifyInstalled(newFile(wal)) ||
          !await files.verifyAbsent({ sourcePath: wal.target.sourcePath }) ||
          !await derived.verifyPurged(derivedInput(wal))) {
          throw new ProtectedMemoryUpdateError('UPDATE_VERIFICATION_FAILED')
        }
        await persistence.deliverUpdateAuditOnce(auditFor(wal))
        wal = await advance(persistence, wal, 'AUDITED')
        continue
      }
      const fact = await persistence.loadUpdatedFactByOperation(wal.operationId)
      if (!fact || !sameFact(fact, { ...wal.fact, published: true }) ||
        !await persistence.verifyUpdateState(wal) ||
        !await files.verifyInstalled(newFile(wal)) ||
        !await files.verifyAbsent({ sourcePath: wal.target.sourcePath }) ||
        !await derived.verifyPurged(derivedInput(wal)) ||
        !await persistence.updateAuditDelivered(wal.operationId)) {
        throw new ProtectedMemoryUpdateError('AUDIT_VERIFICATION_FAILED')
      }
      await persistence.deleteUpdateWal(wal.operationId)
      return { status: 'SUPERSEDED', fact: structuredClone(fact) }
    }
  }

  return Object.freeze<ProtectedMemoryUpdateService>({
    async updateFact(lease, request) {
      assertLeaseScope(lease, request.scope)
      if (!ID.test(request.targetFactId) || !bounded(request.text, MAX_TEXT_BYTES) ||
        !bounded(request.provenance, 4096) || !safeScope(request.scope)) {
        throw new ProtectedMemoryUpdateError('INVALID_REQUEST')
      }
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        return await deps.withScopeExclusive(lease, request.scope, async () => {
          const persistence = deps.persistence(request.scope)
          const files = deps.files(request.scope)
          const derived = deps.derived(request.scope)
          const target = await persistence.loadUpdateTargetById(request.targetFactId)
          if (!target) return { status: 'NOT_FOUND', factId: request.targetFactId }
          const parsedTarget = parseProtectedMemoryFactRecord(target.fact)
          if (!parsedTarget || !parsedTarget.published || parsedTarget.operatorId !== lease.operatorId ||
            parsedTarget.profileId !== lease.profileId || !sameScope(parsedTarget.scope, request.scope)) {
            throw new ProtectedMemoryUpdateError('TARGET_CONFLICT')
          }
          const contentHash = sha256(Buffer.from(request.text, 'utf8'))
          const id = operationId({
            lease, scope: request.scope, target: parsedTarget,
            contentHash, provenance: request.provenance,
          })
          const existing = await persistence.loadUpdateWal(id)
          if (existing !== null) {
            const wal = parseProtectedMemoryUpdateWal(existing)
            if (!wal || !requestMatches(wal, lease, request)) {
              throw new ProtectedMemoryUpdateError('WAL_CONFLICT')
            }
            return finish(wal, persistence, files, derived)
          }
          const completed = parseProtectedMemoryUpdateAuditEvent(await persistence.loadUpdateAudit(id))
          if (completed) {
            const fact = await persistence.loadUpdatedFactByOperation(id)
            const completedWal: ProtectedMemoryUpdateWalV1 | null = fact
              ? parseProtectedMemoryUpdateWal({
                schemaVersion: 1,
                operationId: id,
                operatorId: lease.operatorId,
                profileId: lease.profileId,
                sessionId: lease.sessionId,
                generation: lease.generation,
                scope: structuredClone(request.scope),
                phase: 'AUDITED',
                target: parsedTarget,
                fact: { ...fact, published: false },
                supersededAt: completed.supersededAt,
                createdAt: completed.ts,
                updatedAt: completed.ts,
              })
              : null
            if (!fact || completed.previousFactId !== request.targetFactId ||
              completed.previousOperationId !== parsedTarget.operationId ||
              completed.previousFactKey !== parsedTarget.factKey ||
              completed.previousSourcePath !== parsedTarget.sourcePath ||
              completed.previousContentHash !== parsedTarget.contentHash ||
              completed.factId !== fact.id || completed.factKey !== fact.factKey ||
              completed.sourcePath !== fact.sourcePath ||
              completed.contentHash !== contentHash || completed.provenance !== request.provenance ||
              !completedWal || !await persistence.verifyUpdateState(completedWal) ||
              !await files.verifyInstalled(newFile(completedWal)) ||
              !await files.verifyAbsent({ sourcePath: parsedTarget.sourcePath }) ||
              !await derived.verifyPurged(derivedInput(completedWal)) ||
              !await persistence.updateAuditDelivered(id)) {
              throw new ProtectedMemoryUpdateError('TARGET_CONFLICT')
            }
            return { status: 'SUPERSEDED', fact: structuredClone(fact) }
          }
          if (target.invalidatedAt !== null) {
            return { status: 'NOT_FOUND', factId: request.targetFactId }
          }
          const factId = deps.newFactId()
          if (!ID.test(factId) || factId === parsedTarget.id) {
            throw new ProtectedMemoryUpdateError('INVALID_REQUEST')
          }
          const metadata = await deps.prepareFact({ lease, ...request, factId })
          const createdAt = deps.nowIso()
          const fact = parseProtectedMemoryFactRecord({
            schemaVersion: 2,
            operationId: id,
            id: factId,
            operatorId: lease.operatorId,
            profileId: lease.profileId,
            scope: structuredClone(request.scope),
            text: request.text,
            factKey: metadata.factKey,
            keyTokens: [...metadata.keyTokens],
            validAt: metadata.validAt,
            invalidAt: null,
            isHumanConfirmed: metadata.isHumanConfirmed,
            sourceAuthority: metadata.sourceAuthority,
            confidence: metadata.confidence,
            provenance: request.provenance,
            supersedes: parsedTarget.factKey,
            ...(metadata.contradicts === undefined ? {} : { contradicts: metadata.contradicts }),
            ...(metadata.extends === undefined ? {} : { extends: metadata.extends }),
            sourcePath: `memory/facts/${sha256(factId)}.md`,
            contentHash,
            published: false,
          })
          if (!fact) throw new ProtectedMemoryUpdateError('INVALID_REQUEST')
          const wal: ProtectedMemoryUpdateWalV1 = {
            schemaVersion: 1,
            operationId: id,
            operatorId: lease.operatorId,
            profileId: lease.profileId,
            sessionId: lease.sessionId,
            generation: lease.generation,
            scope: structuredClone(request.scope),
            phase: 'PREPARED',
            target: parsedTarget,
            fact,
            supersededAt: createdAt,
            createdAt,
            updatedAt: createdAt,
          }
          if (!parseProtectedMemoryUpdateWal(wal)) throw new ProtectedMemoryUpdateError('INVALID_REQUEST')
          await persistence.createUpdateWal(wal)
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
          const rows = await persistence.listUpdateWals(scope)
          const wals = rows.map((row) => {
            const wal = parseProtectedMemoryUpdateWal(row)
            if (!wal || wal.operatorId !== lease.operatorId || wal.profileId !== lease.profileId ||
              !sameScope(wal.scope, scope)) throw new ProtectedMemoryUpdateError('RECOVERY_SCOPE_MISMATCH')
            return wal
          }).sort((left, right) => left.operationId.localeCompare(right.operationId))
          const results: ProtectedMemoryUpdateResult[] = []
          for (const wal of wals) results.push(await finish(wal, persistence, files, derived))
          if ((await persistence.listUpdateWals(scope)).length > 0) {
            throw new ProtectedMemoryUpdateError('RECOVERY_REQUIRED')
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
          if ((await deps.persistence(scope).listUpdateWals(scope)).length > 0) {
            throw new ProtectedMemoryUpdateError('RECOVERY_REQUIRED')
          }
        })
      } finally {
        operation.complete()
      }
    },
  })
}

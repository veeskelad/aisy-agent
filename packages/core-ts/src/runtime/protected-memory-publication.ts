import { createHash } from 'node:crypto'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TEXT_BYTES = 1_048_576

export type ProtectedMemoryPublicationPhase =
  | 'PREPARED'
  | 'DB_PENDING'
  | 'FILE_INSTALLED'
  | 'PUBLISHED'
  | 'AUDITED'

export type ProtectedMemoryScope =
  | { kind: 'global'; scopeId: 'global' }
  | { kind: 'project'; scopeId: `project:${string}`; projectId: string }

export interface PreparedMemoryFactMetadata {
  factKey: string
  keyTokens: string[]
  validAt: string
  isHumanConfirmed: boolean
  sourceAuthority: number | null
  confidence: number | null
  supersedes?: string
  contradicts?: string
  extends?: string
}

export interface ProtectedMemoryFactRecordV2 {
  schemaVersion: 2
  operationId: string
  id: string
  operatorId: string
  profileId: string
  scope: ProtectedMemoryScope
  text: string
  factKey: string
  keyTokens: string[]
  validAt: string
  invalidAt: null
  isHumanConfirmed: boolean
  sourceAuthority: number | null
  confidence: number | null
  provenance: string
  supersedes?: string
  contradicts?: string
  extends?: string
  sourcePath: string
  contentHash: string
  published: boolean
}

export interface ProtectedMemoryPublicationWalV1 {
  schemaVersion: 1
  operationId: string
  operatorId: string
  profileId: string
  sessionId: string
  generation: number
  scope: ProtectedMemoryScope
  phase: ProtectedMemoryPublicationPhase
  fact: ProtectedMemoryFactRecordV2
  createdAt: string
  updatedAt: string
}

export interface ProtectedMemoryAuditEvent {
  eventId: string
  kind: 'memory.committed'
  operationId: string
  operatorId: string
  profileId: string
  scopeId: string
  projectId?: string
  sessionId: string
  factId: string
  factKey: string
  sourcePath: string
  contentHash: string
  provenance: string
  ts: string
}

export interface ProtectedMemoryPublicationPersistencePort {
  loadWal(operationId: string): Promise<unknown | null>
  listWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  createWal(wal: ProtectedMemoryPublicationWalV1): Promise<void>
  advanceWal(input: {
    operationId: string
    expectedPhase: ProtectedMemoryPublicationPhase
    next: ProtectedMemoryPublicationWalV1
  }): Promise<void>
  loadFactByOperation(operationId: string): Promise<ProtectedMemoryFactRecordV2 | null>
  createPendingFactAndOutbox(input: {
    fact: ProtectedMemoryFactRecordV2
    audit: ProtectedMemoryAuditEvent
  }): Promise<void>
  publishFactAndKeywordProjection(fact: ProtectedMemoryFactRecordV2): Promise<void>
  verifyPublished(fact: ProtectedMemoryFactRecordV2): Promise<boolean>
  deliverAuditOnce(event: ProtectedMemoryAuditEvent): Promise<void>
  auditDelivered(eventId: string): Promise<boolean>
  deleteWal(operationId: string): Promise<void>
}

export interface ProtectedMemoryPublicationFilePort {
  stage(input: {
    operationId: string
    sourcePath: string
    content: Buffer
    contentHash: string
  }): Promise<void>
  install(input: {
    operationId: string
    sourcePath: string
    contentHash: string
    sizeBytes: number
  }): Promise<'installed' | 'already-installed' | 'collision'>
  verifyInstalled(input: {
    sourcePath: string
    contentHash: string
    sizeBytes: number
  }): Promise<boolean>
}

export interface ProtectedMemoryPublicationService {
  publishFact(
    lease: TurnContextLease,
    request: {
      factId: string
      text: string
      provenance: string
      scope: ProtectedMemoryScope
    },
  ): Promise<ProtectedMemoryFactRecordV2>
  recoverScope(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
  ): Promise<ProtectedMemoryFactRecordV2[]>
  assertScopeRecovered(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
  ): Promise<void>
}

export class ProtectedMemoryPublicationError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'SCOPE_MISMATCH'
    | 'WAL_CONFLICT'
    | 'PENDING_FACT_CONFLICT'
    | 'FILE_COLLISION'
    | 'FILE_HASH_MISMATCH'
    | 'PUBLICATION_VERIFICATION_FAILED'
    | 'AUDIT_VERIFICATION_FAILED'
    | 'RECOVERY_SCOPE_MISMATCH'
    | 'RECOVERY_REQUIRED',
  ) {
    super(code)
    this.name = 'ProtectedMemoryPublicationError'
  }
}

const PHASES = new Set<ProtectedMemoryPublicationPhase>([
  'PREPARED', 'DB_PENDING', 'FILE_INSTALLED', 'PUBLISHED', 'AUDITED',
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
  if (scope.kind === 'global') {
    return scope.scopeId === 'global' && !('projectId' in scope)
  }
  return scope.kind === 'project' && bounded(scope.projectId, 1024) &&
    scope.scopeId === `project:${scope.projectId}`
}

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

function safeRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function validMetadata(value: PreparedMemoryFactMetadata): boolean {
  return HASH.test(value.factKey) && Array.isArray(value.keyTokens) &&
    value.keyTokens.length > 0 && value.keyTokens.length <= 256 &&
    value.keyTokens.every((token) => bounded(token, 256) && token === token.trim()) &&
    new Set(value.keyTokens).size === value.keyTokens.length &&
    value.factKey === sha256(value.keyTokens.join('|')) && validIso(value.validAt) &&
    typeof value.isHumanConfirmed === 'boolean' &&
    (value.sourceAuthority === null || Number.isSafeInteger(value.sourceAuthority)) &&
    (value.confidence === null || (Number.isFinite(value.confidence) &&
      value.confidence >= 0 && value.confidence <= 1)) &&
    [value.supersedes, value.contradicts, value.extends]
      .every((relation) => relation === undefined || HASH.test(relation))
}

function validFact(value: unknown): value is ProtectedMemoryFactRecordV2 {
  if (typeof value !== 'object' || value === null) return false
  const fact = value as ProtectedMemoryFactRecordV2
  const expectedKeys = new Set([
    'schemaVersion', 'operationId', 'id', 'operatorId', 'profileId', 'scope',
    'text', 'factKey', 'keyTokens', 'validAt', 'invalidAt', 'isHumanConfirmed',
    'sourceAuthority', 'confidence', 'provenance', 'sourcePath', 'contentHash',
    'published',
    ...(fact.supersedes === undefined ? [] : ['supersedes']),
    ...(fact.contradicts === undefined ? [] : ['contradicts']),
    ...(fact.extends === undefined ? [] : ['extends']),
  ])
  const keys = Object.keys(fact)
  return keys.length === expectedKeys.size && keys.every((key) => expectedKeys.has(key)) &&
    fact.schemaVersion === 2 && HASH.test(fact.operationId) && ID.test(fact.id) &&
    bounded(fact.operatorId, 1024) && bounded(fact.profileId, 1024) && safeScope(fact.scope) &&
    bounded(fact.text, MAX_TEXT_BYTES) && validMetadata({
      factKey: fact.factKey,
      keyTokens: fact.keyTokens,
      validAt: fact.validAt,
      isHumanConfirmed: fact.isHumanConfirmed,
      sourceAuthority: fact.sourceAuthority,
      confidence: fact.confidence,
      ...(fact.supersedes === undefined ? {} : { supersedes: fact.supersedes }),
      ...(fact.contradicts === undefined ? {} : { contradicts: fact.contradicts }),
      ...(fact.extends === undefined ? {} : { extends: fact.extends }),
    }) && fact.invalidAt === null && bounded(fact.provenance, 4096) &&
    safeRelativePath(fact.sourcePath) && fact.sourcePath === `memory/facts/${sha256(fact.id)}.md` &&
    HASH.test(fact.contentHash) && fact.contentHash === sha256(Buffer.from(fact.text, 'utf8')) &&
    typeof fact.published === 'boolean'
}

export function parseProtectedMemoryFactRecord(
  value: unknown,
): ProtectedMemoryFactRecordV2 | null {
  return validFact(value) ? structuredClone(value) : null
}

export function parseProtectedMemoryAuditEvent(
  value: unknown,
): ProtectedMemoryAuditEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const event = value as ProtectedMemoryAuditEvent
  const expected = new Set([
    'eventId', 'kind', 'operationId', 'operatorId', 'profileId', 'scopeId',
    'sessionId', 'factId', 'factKey', 'sourcePath', 'contentHash', 'provenance',
    'ts',
    ...(event.projectId === undefined ? [] : ['projectId']),
  ])
  const keys = Object.keys(event)
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    !HASH.test(event.eventId) || event.kind !== 'memory.committed' ||
    event.operationId !== event.eventId || !bounded(event.operatorId, 1024) ||
    !bounded(event.profileId, 1024) || !bounded(event.scopeId, 2048) ||
    !bounded(event.sessionId, 1024) || !ID.test(event.factId) ||
    !HASH.test(event.factKey) || !safeRelativePath(event.sourcePath) ||
    !HASH.test(event.contentHash) || !bounded(event.provenance, 4096) ||
    !validIso(event.ts) ||
    (event.projectId === undefined
      ? event.scopeId !== 'global'
      : !bounded(event.projectId, 1024) || event.scopeId !== `project:${event.projectId}`)) {
    return null
  }
  return structuredClone(event)
}

export function parseProtectedMemoryPublicationWal(
  value: unknown,
): ProtectedMemoryPublicationWalV1 | null {
  if (typeof value !== 'object' || value === null) return null
  const wal = value as ProtectedMemoryPublicationWalV1
  const keys = Object.keys(wal)
  const expected = new Set([
    'schemaVersion', 'operationId', 'operatorId', 'profileId', 'sessionId',
    'generation', 'scope', 'phase', 'fact', 'createdAt', 'updatedAt',
  ])
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) ||
    wal.schemaVersion !== 1 || !HASH.test(wal.operationId) ||
    !bounded(wal.operatorId, 1024) || !bounded(wal.profileId, 1024) ||
    !bounded(wal.sessionId, 1024) || !Number.isSafeInteger(wal.generation) ||
    wal.generation < 1 || !safeScope(wal.scope) || !PHASES.has(wal.phase) ||
    !validFact(wal.fact) || wal.fact.published !== false ||
    wal.operationId !== wal.fact.operationId || wal.operatorId !== wal.fact.operatorId ||
    wal.profileId !== wal.fact.profileId || !sameScope(wal.scope, wal.fact.scope) ||
    !validIso(wal.createdAt) || !validIso(wal.updatedAt)) return null
  return structuredClone(wal)
}

function assertLeaseScope(lease: TurnContextLease, scope: ProtectedMemoryScope): void {
  if (scope.kind === 'project' &&
    (lease.projectKind !== 'project' || lease.projectId !== scope.projectId)) {
    throw new ProtectedMemoryPublicationError('SCOPE_MISMATCH')
  }
}

function operationId(input: {
  lease: TurnContextLease
  scope: ProtectedMemoryScope
  factId: string
  contentHash: string
  provenance: string
}): string {
  return sha256(JSON.stringify([
    'aisy.protected-memory-publication.v1', input.lease.operatorId,
    input.lease.profileId, input.lease.sessionId, input.scope.scopeId, input.factId,
    input.contentHash, input.provenance,
  ]))
}

function factIdentityMatches(
  fact: ProtectedMemoryFactRecordV2,
  input: {
    lease: TurnContextLease
    scope: ProtectedMemoryScope
    factId: string
    text: string
    provenance: string
    operationId: string
  },
): boolean {
  return fact.operationId === input.operationId && fact.id === input.factId &&
    fact.operatorId === input.lease.operatorId && fact.profileId === input.lease.profileId &&
    sameScope(fact.scope, input.scope) && fact.text === input.text &&
    fact.provenance === input.provenance
}

export function makeProtectedMemoryPublicationService(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  persistence(scope: ProtectedMemoryScope): ProtectedMemoryPublicationPersistencePort
  files(scope: ProtectedMemoryScope): ProtectedMemoryPublicationFilePort
  prepareFact(input: {
    lease: TurnContextLease
    scope: ProtectedMemoryScope
    factId: string
    text: string
    provenance: string
  }): Promise<PreparedMemoryFactMetadata>
  withScopeExclusive<T>(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    run: () => Promise<T>,
  ): Promise<T>
  nowIso(): string
}): ProtectedMemoryPublicationService {
  const tails = new Map<string, Promise<void>>()
  const serialize = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try { return await run() } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

  const advance = async (
    persistence: ProtectedMemoryPublicationPersistencePort,
    wal: ProtectedMemoryPublicationWalV1,
    phase: ProtectedMemoryPublicationPhase,
  ): Promise<ProtectedMemoryPublicationWalV1> => {
    const next: ProtectedMemoryPublicationWalV1 = { ...wal, phase, updatedAt: deps.nowIso() }
    if (!parseProtectedMemoryPublicationWal(next)) {
      throw new ProtectedMemoryPublicationError('WAL_CONFLICT')
    }
    await persistence.advanceWal({ operationId: wal.operationId, expectedPhase: wal.phase, next })
    return next
  }

  const auditFor = (wal: ProtectedMemoryPublicationWalV1): ProtectedMemoryAuditEvent => ({
    eventId: wal.operationId,
    kind: 'memory.committed',
    operationId: wal.operationId,
    operatorId: wal.operatorId,
    profileId: wal.profileId,
    scopeId: wal.scope.scopeId,
    ...(wal.scope.kind === 'project' ? { projectId: wal.scope.projectId } : {}),
    sessionId: wal.sessionId,
    factId: wal.fact.id,
    factKey: wal.fact.factKey,
    sourcePath: wal.fact.sourcePath,
    contentHash: wal.fact.contentHash,
    provenance: wal.fact.provenance,
    ts: wal.createdAt,
  })

  const finish = async (
    walInput: ProtectedMemoryPublicationWalV1,
    persistence: ProtectedMemoryPublicationPersistencePort,
    files: ProtectedMemoryPublicationFilePort,
  ): Promise<ProtectedMemoryFactRecordV2> => {
    let wal = walInput
    const content = Buffer.from(wal.fact.text, 'utf8')
    while (true) {
      if (wal.phase === 'PREPARED') {
        await files.stage({
          operationId: wal.operationId,
          sourcePath: wal.fact.sourcePath,
          content,
          contentHash: wal.fact.contentHash,
        })
        await persistence.createPendingFactAndOutbox({ fact: wal.fact, audit: auditFor(wal) })
        wal = await advance(persistence, wal, 'DB_PENDING')
        continue
      }
      if (wal.phase === 'DB_PENDING') {
        const installed = await files.install({
          operationId: wal.operationId,
          sourcePath: wal.fact.sourcePath,
          contentHash: wal.fact.contentHash,
          sizeBytes: content.byteLength,
        })
        if (installed === 'collision') throw new ProtectedMemoryPublicationError('FILE_COLLISION')
        if (!await files.verifyInstalled({
          sourcePath: wal.fact.sourcePath,
          contentHash: wal.fact.contentHash,
          sizeBytes: content.byteLength,
        })) throw new ProtectedMemoryPublicationError('FILE_HASH_MISMATCH')
        wal = await advance(persistence, wal, 'FILE_INSTALLED')
        continue
      }
      if (wal.phase === 'FILE_INSTALLED') {
        if (!await files.verifyInstalled({
          sourcePath: wal.fact.sourcePath,
          contentHash: wal.fact.contentHash,
          sizeBytes: content.byteLength,
        })) throw new ProtectedMemoryPublicationError('FILE_HASH_MISMATCH')
        await persistence.publishFactAndKeywordProjection(wal.fact)
        wal = await advance(persistence, wal, 'PUBLISHED')
        continue
      }
      if (wal.phase === 'PUBLISHED') {
        if (!await persistence.verifyPublished(wal.fact) || !await files.verifyInstalled({
          sourcePath: wal.fact.sourcePath,
          contentHash: wal.fact.contentHash,
          sizeBytes: content.byteLength,
        })) throw new ProtectedMemoryPublicationError('PUBLICATION_VERIFICATION_FAILED')
        await persistence.deliverAuditOnce(auditFor(wal))
        wal = await advance(persistence, wal, 'AUDITED')
        continue
      }
      const fact = await persistence.loadFactByOperation(wal.operationId)
      if (!fact || !validFact(fact) || fact.published !== true ||
        !await persistence.verifyPublished(wal.fact) ||
        !await persistence.auditDelivered(wal.operationId) ||
        !await files.verifyInstalled({
          sourcePath: wal.fact.sourcePath,
          contentHash: wal.fact.contentHash,
          sizeBytes: content.byteLength,
        })) {
        throw new ProtectedMemoryPublicationError('AUDIT_VERIFICATION_FAILED')
      }
      await persistence.deleteWal(wal.operationId)
      return structuredClone(fact)
    }
  }

  const recoverOne = async (
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    raw: unknown,
  ): Promise<ProtectedMemoryFactRecordV2> => {
    const wal = parseProtectedMemoryPublicationWal(raw)
    if (!wal || wal.operatorId !== lease.operatorId || wal.profileId !== lease.profileId ||
      !sameScope(wal.scope, scope)) {
      throw new ProtectedMemoryPublicationError('RECOVERY_SCOPE_MISMATCH')
    }
    return finish(wal, deps.persistence(scope), deps.files(scope))
  }

  return Object.freeze<ProtectedMemoryPublicationService>({
    async publishFact(lease, request) {
      assertLeaseScope(lease, request.scope)
      if (!ID.test(request.factId) || !bounded(request.text, MAX_TEXT_BYTES) ||
        !bounded(request.provenance, 4096) || !safeScope(request.scope)) {
        throw new ProtectedMemoryPublicationError('INVALID_REQUEST')
      }
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        return await deps.withScopeExclusive(lease, request.scope, async () => {
          const contentHash = sha256(Buffer.from(request.text, 'utf8'))
          const id = operationId({
            lease,
            scope: request.scope,
            factId: request.factId,
            contentHash,
            provenance: request.provenance,
          })
          const persistence = deps.persistence(request.scope)
          const files = deps.files(request.scope)
          const key = `${lease.operatorId}\0${lease.profileId}\0${request.scope.scopeId}`
          return serialize(key, async () => {
            const existing = await persistence.loadWal(id)
            if (existing !== null) {
              const wal = parseProtectedMemoryPublicationWal(existing)
              if (!wal || wal.sessionId !== lease.sessionId || wal.generation !== lease.generation ||
                !factIdentityMatches(wal.fact, { lease, ...request, operationId: id })) {
                throw new ProtectedMemoryPublicationError('WAL_CONFLICT')
              }
              return finish(wal, persistence, files)
            }
            const completed = await persistence.loadFactByOperation(id)
            if (completed !== null) {
              if (!validFact(completed) || completed.published !== true ||
                !factIdentityMatches(completed, { lease, ...request, operationId: id }) ||
                !await persistence.verifyPublished(completed) ||
                !await persistence.auditDelivered(id) ||
                !await files.verifyInstalled({
                  sourcePath: completed.sourcePath,
                  contentHash: completed.contentHash,
                  sizeBytes: Buffer.byteLength(completed.text, 'utf8'),
                })) throw new ProtectedMemoryPublicationError('WAL_CONFLICT')
              return structuredClone(completed)
            }
            const metadata = await deps.prepareFact({ lease, ...request })
            if (!validMetadata(metadata)) {
              throw new ProtectedMemoryPublicationError('INVALID_REQUEST')
            }
            const createdAt = deps.nowIso()
            const fact: ProtectedMemoryFactRecordV2 = {
              schemaVersion: 2,
              operationId: id,
              id: request.factId,
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
              ...(metadata.supersedes === undefined ? {} : { supersedes: metadata.supersedes }),
              ...(metadata.contradicts === undefined ? {} : { contradicts: metadata.contradicts }),
              ...(metadata.extends === undefined ? {} : { extends: metadata.extends }),
              sourcePath: `memory/facts/${sha256(request.factId)}.md`,
              contentHash,
              published: false,
            }
            const wal: ProtectedMemoryPublicationWalV1 = {
              schemaVersion: 1,
              operationId: id,
              operatorId: lease.operatorId,
              profileId: lease.profileId,
              sessionId: lease.sessionId,
              generation: lease.generation,
              scope: structuredClone(request.scope),
              phase: 'PREPARED',
              fact,
              createdAt,
              updatedAt: createdAt,
            }
            if (!parseProtectedMemoryPublicationWal(wal)) {
              throw new ProtectedMemoryPublicationError('INVALID_REQUEST')
            }
            await persistence.createWal(wal)
            return finish(wal, persistence, files)
          })
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
          const rows = await persistence.listWals(scope)
          const parsed = rows.map((row) => {
            const wal = parseProtectedMemoryPublicationWal(row)
            if (!wal) throw new ProtectedMemoryPublicationError('WAL_CONFLICT')
            return wal
          }).sort((left, right) => left.operationId.localeCompare(right.operationId))
          const results: ProtectedMemoryFactRecordV2[] = []
          for (const wal of parsed) results.push(await recoverOne(lease, scope, wal))
          if ((await persistence.listWals(scope)).length > 0) {
            throw new ProtectedMemoryPublicationError('RECOVERY_REQUIRED')
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
          const rows = await deps.persistence(scope).listWals(scope)
          if (rows.length > 0) throw new ProtectedMemoryPublicationError('RECOVERY_REQUIRED')
        })
      } finally {
        operation.complete()
      }
    },
  })
}

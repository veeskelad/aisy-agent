import type { CommitResult, MemoryOp } from '../memory/index.js'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import {
  HYBRID_RRF_K,
  HybridRetrievalIntegrityError,
  makeHybridRetrieval,
  type HybridRetrievalHit,
  type HybridRetrievalResult,
  type RetrievalScope,
  type ScopedRetrievalCandidate,
  type SemanticRetrievalLeg,
} from './hybrid-retrieval.js'
import type {
  ProtectedMemoryDeletionService,
  ProtectedMemoryDeletionTarget,
} from './protected-memory-deletion.js'
import {
  parseProtectedMemoryFactRecord,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryPublicationService,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'
import type { ProtectedMemoryRecoveryGate } from './protected-memory-recovery-gate.js'
import type { ProtectedMemoryUpdateService } from './protected-memory-update.js'
import { ProtectedMemorySqliteStoreError } from './protected-memory-sqlite-store.js'
import type {
  ScopedMemoryEvent,
  ScopedMemoryHit,
  ScopedMemoryRouter,
  ScopedMemorySearchMode,
  ScopedMemorySearchResult,
} from './scoped-memory.js'

export interface ProtectedScopedMemoryRuntime {
  scope: ProtectedMemoryScope
  recovery: Pick<ProtectedMemoryRecoveryGate, 'assertScopeRecovered'>
  publication: Pick<ProtectedMemoryPublicationService, 'publishFact'>
  deletion: Pick<ProtectedMemoryDeletionService, 'deleteFact'>
  update: Pick<ProtectedMemoryUpdateService, 'updateFact'>
  store: {
    loadTargetById(factId: string): Promise<ProtectedMemoryDeletionTarget | null>
    loadLiveFactById(factId: string): Promise<ProtectedMemoryFactRecordV2 | null>
    searchKeyword(query: string, limit: number): Promise<Array<{
      fact: ProtectedMemoryFactRecordV2
      score: number
    }>>
  }
  /** Raw derived store retained for Node composition compatibility. */
  semantic?: {
    search(vector: readonly number[], limit: number): Promise<Array<{ hitId: string }>>
  }
  files: {
    verifyInstalled(input: {
      sourcePath: string
      contentHash: string
      sizeBytes: number
    }): Promise<boolean>
    verifyAbsent(input: { sourcePath: string }): Promise<boolean>
  }
}

export class ProtectedScopedMemoryError extends Error {
  constructor(public readonly code:
    | 'PROJECT_SCOPE_REQUIRED'
    | 'PROJECT_MEMORY_UNAVAILABLE'
    | 'GLOBAL_MEMORY_UNAVAILABLE'
    | 'READ_VERIFICATION_FAILED'
    | 'HUMAN_CONFIRMATION_REQUIRED',
  ) {
    super(code)
    this.name = 'ProtectedScopedMemoryError'
  }
}

function projectScope(projectId: string): ProtectedMemoryScope {
  return { kind: 'project', scopeId: `project:${projectId}`, projectId }
}

function isDegradableProjectFailure(error: unknown): boolean {
  return (error instanceof ProtectedScopedMemoryError &&
      error.code === 'PROJECT_MEMORY_UNAVAILABLE') ||
    (error instanceof ProtectedMemorySqliteStoreError &&
      error.code === 'CORRUPT_KEYWORD_INDEX')
}

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export function makeProtectedScopedMemoryRouter(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  globalRuntime(): ProtectedScopedMemoryRuntime | null
  projectRuntime(projectId: string): ProtectedScopedMemoryRuntime | null
  newFactId(): string
  provenanceFor(input: {
    lease: TurnContextLease
    op: MemoryOp
    scope: ProtectedMemoryScope
  }): string
  authorizeHumanConfirmedDelete(input: {
    lease: TurnContextLease
    factId: string
    targetOperationId: string
    factKey: string
    sourcePath: string
    contentHash: string
    reason: string
    scope: ProtectedMemoryScope
  }): Promise<boolean>
  /** Complete provider + scoped sqlite-vec leg. Absence is visible keyword-only degradation. */
  semanticFor?(
    runtime: ProtectedScopedMemoryRuntime,
    scope: ProtectedMemoryScope,
  ): SemanticRetrievalLeg | undefined
  emit?: (event: ScopedMemoryEvent) => void
}): ScopedMemoryRouter {
  const withLeaseIo = async <T>(lease: TurnContextLease, run: () => Promise<T>): Promise<T> => {
    const operation = deps.leases.reserveOperation(lease)
    try {
      operation.beginIo()
      return await run()
    } finally {
      operation.complete()
    }
  }

  const exactRuntime = (
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
  ): ProtectedScopedMemoryRuntime => {
    const runtime = scope.kind === 'global'
      ? deps.globalRuntime()
      : deps.projectRuntime(scope.projectId)
    if (!runtime) {
      throw new ProtectedScopedMemoryError(
        scope.kind === 'global' ? 'GLOBAL_MEMORY_UNAVAILABLE' : 'PROJECT_MEMORY_UNAVAILABLE',
      )
    }
    if (runtime.scope.scopeId !== scope.scopeId || runtime.scope.kind !== scope.kind ||
      (scope.kind === 'project' &&
        (runtime.scope.kind !== 'project' || runtime.scope.projectId !== scope.projectId))) {
      throw new ProtectedScopedMemoryError('READ_VERIFICATION_FAILED')
    }
    if (scope.kind === 'project' &&
      (lease.projectKind !== 'project' || lease.projectId !== scope.projectId)) {
      throw new ProtectedScopedMemoryError('PROJECT_SCOPE_REQUIRED')
    }
    return runtime
  }

  const retrievalScope = (scope: ProtectedMemoryScope): RetrievalScope => scope.kind === 'global'
    ? { kind: 'global', scopeId: 'global' }
    : { kind: 'project', scopeId: scope.scopeId, projectId: scope.projectId }

  const sameScope = (
    factScope: ProtectedMemoryScope,
    scope: ProtectedMemoryScope,
  ): boolean => factScope.kind === scope.kind && factScope.scopeId === scope.scopeId &&
    (scope.kind !== 'project' ||
      (factScope.kind === 'project' && factScope.projectId === scope.projectId))

  const candidateFromFact = (
    fact: ProtectedMemoryFactRecordV2,
    score: number,
  ): ScopedRetrievalCandidate => ({
    hitId: fact.id,
    scope: fact.scope.kind,
    scopeId: fact.scope.scopeId,
    ...(fact.scope.kind === 'project' ? { projectId: fact.scope.projectId } : {}),
    sourcePath: fact.sourcePath,
    chunkId: fact.id,
    contentHash: fact.contentHash,
    provenance: fact.provenance,
    score,
  })

  const verifyKeywordFact = async (
    runtime: ProtectedScopedMemoryRuntime,
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    source: ProtectedMemoryFactRecordV2,
  ): Promise<ProtectedMemoryFactRecordV2> => {
    const fact = parseProtectedMemoryFactRecord(source)
    if (!fact || !fact.published || fact.invalidAt !== null ||
      fact.operatorId !== lease.operatorId || fact.profileId !== lease.profileId ||
      !sameScope(fact.scope, scope) || !await runtime.files.verifyInstalled({
        sourcePath: fact.sourcePath,
        contentHash: fact.contentHash,
        sizeBytes: Buffer.byteLength(fact.text, 'utf8'),
      })) throw new ProtectedScopedMemoryError('READ_VERIFICATION_FAILED')
    return fact
  }

  const materialize = async (
    runtime: ProtectedScopedMemoryRuntime,
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    hit: HybridRetrievalHit,
  ): Promise<ScopedMemoryHit> => {
    const fact = parseProtectedMemoryFactRecord(await runtime.store.loadLiveFactById(hit.hitId))
    if (!fact) {
      throw new HybridRetrievalIntegrityError('DERIVED_FILTER_VIOLATION')
    }
    if (!fact.published || fact.invalidAt !== null ||
      fact.operatorId !== lease.operatorId || fact.profileId !== lease.profileId ||
      !sameScope(fact.scope, scope)) {
      throw new HybridRetrievalIntegrityError('DERIVED_FILTER_VIOLATION')
    }
    const expected = candidateFromFact(fact, hit.score)
    if (hit.hitId !== expected.hitId || hit.scope !== expected.scope ||
      hit.scopeId !== expected.scopeId || hit.projectId !== expected.projectId ||
      hit.sourcePath !== expected.sourcePath || hit.chunkId !== expected.chunkId ||
      hit.contentHash !== expected.contentHash || hit.provenance !== expected.provenance) {
      throw new HybridRetrievalIntegrityError('CONFLICTING_HIT')
    }
    if (!await runtime.files.verifyInstalled({
      sourcePath: fact.sourcePath,
      contentHash: fact.contentHash,
      sizeBytes: Buffer.byteLength(fact.text, 'utf8'),
    })) throw new ProtectedScopedMemoryError('READ_VERIFICATION_FAILED')
    return {
      id: fact.id,
      factKey: fact.factKey,
      text: fact.text,
      score: hit.score,
      scope: scope.kind,
      scopeId: fact.scope.scopeId,
      sourcePath: fact.sourcePath,
      chunkId: fact.id,
      contentHash: fact.contentHash,
      provenanceRef: fact.provenance,
      componentRanks: hit.componentRanks,
      ...(scope.kind === 'project' ? { projectId: scope.projectId } : {}),
    }
  }

  const searchOne = async (
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    query: string,
    limit: number,
    mode: ScopedMemorySearchMode,
  ): Promise<{ result: HybridRetrievalResult; hits: ScopedMemoryHit[] }> => {
    const runtime = exactRuntime(lease, scope)
    await runtime.recovery.assertScopeRecovered(lease, scope)
    const events: ScopedMemoryEvent[] = []
    const semantic = deps.semanticFor?.(runtime, scope)
    const search = makeHybridRetrieval({
      keyword: {
        search: async () => {
          const rows = await runtime.store.searchKeyword(query, 20)
          const candidates: ScopedRetrievalCandidate[] = []
          for (const row of rows) {
            candidates.push(candidateFromFact(
              await verifyKeywordFact(runtime, lease, scope, row.fact),
              row.score,
            ))
          }
          return candidates
        },
      },
      ...(semantic === undefined ? {} : { semantic }),
      emit: event => events.push({
        ...event, sessionId: lease.sessionId, generation: lease.generation,
      }),
    })
    const result = await search.search(retrievalScope(scope), query, { mode, limit })
    const hits: ScopedMemoryHit[] = []
    for (const hit of result.hits) hits.push(await materialize(runtime, lease, scope, hit))
    for (const event of events) deps.emit?.(event)
    return { result, hits }
  }

  const authorizeExactDeletion = async (
    runtime: ProtectedScopedMemoryRuntime,
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    factId: string,
    reason: string,
  ): Promise<void> => {
    const target = await runtime.store.loadTargetById(factId)
    if (!target) return
    const fact = parseProtectedMemoryFactRecord(target.fact)
    const sameScope = fact?.scope.kind === scope.kind && fact.scope.scopeId === scope.scopeId &&
      (scope.kind !== 'project' ||
        (fact.scope.kind === 'project' && fact.scope.projectId === scope.projectId))
    const validInvalidatedAt = target.invalidatedAt === null || validIso(target.invalidatedAt)
    if (!fact || !fact.published || fact.id !== factId || fact.operatorId !== lease.operatorId ||
      fact.profileId !== lease.profileId || !sameScope || !validInvalidatedAt) {
      throw new ProtectedScopedMemoryError('READ_VERIFICATION_FAILED')
    }
    const verified = target.invalidatedAt === null
      ? await runtime.files.verifyInstalled({
        sourcePath: fact.sourcePath,
        contentHash: fact.contentHash,
        sizeBytes: Buffer.byteLength(fact.text, 'utf8'),
      })
      : await runtime.files.verifyAbsent({ sourcePath: fact.sourcePath })
    if (!verified) throw new ProtectedScopedMemoryError('READ_VERIFICATION_FAILED')
    if (!await deps.authorizeHumanConfirmedDelete({
      lease,
      factId,
      targetOperationId: fact.operationId,
      factKey: fact.factKey,
      sourcePath: fact.sourcePath,
      contentHash: fact.contentHash,
      reason,
      scope,
    })) throw new ProtectedScopedMemoryError('HUMAN_CONFIRMATION_REQUIRED')
  }

  const commitOne = async (
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    op: MemoryOp,
  ): Promise<CommitResult> => {
    const runtime = exactRuntime(lease, scope)
    await runtime.recovery.assertScopeRecovered(lease, scope)
    if (op.op === 'NOOP') return { status: 'COMMITTED', factId: op.targetId }
    if (op.op === 'ADD') {
      const provenance = deps.provenanceFor({ lease, op, scope })
      const fact = await runtime.publication.publishFact(lease, {
        factId: deps.newFactId(), text: op.text, provenance, scope,
      })
      return { status: 'COMMITTED', factId: fact.id }
    }
    if (op.op === 'UPDATE') {
      const provenance = deps.provenanceFor({ lease, op, scope })
      const result = await runtime.update.updateFact(lease, {
        targetFactId: op.targetId, text: op.text, provenance, scope,
      })
      return result.status === 'NOT_FOUND'
        ? { status: 'NOT_FOUND', factId: result.factId }
        : { status: 'SUPERSEDED', factId: result.fact.id }
    }
    if (op.humanConfirmed) {
      await authorizeExactDeletion(runtime, lease, scope, op.targetId, op.reason)
    }
    const result = await runtime.deletion.deleteFact(lease, {
      factId: op.targetId,
      reason: op.reason,
      humanConfirmed: op.humanConfirmed,
      scope,
    })
    return result.status === 'NOT_FOUND'
      ? { status: 'NOT_FOUND', factId: result.factId }
      : { status: 'COMMITTED', factId: result.factId }
  }

  const forgetOne = async (
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    factId: string,
    reason: string,
    humanConfirmed: boolean,
  ): Promise<void> => {
    const runtime = exactRuntime(lease, scope)
    await runtime.recovery.assertScopeRecovered(lease, scope)
    if (humanConfirmed) await authorizeExactDeletion(runtime, lease, scope, factId, reason)
    await runtime.deletion.deleteFact(lease, {
      factId, reason, humanConfirmed, scope,
    })
  }

  const scopedResult = (
    result: HybridRetrievalResult,
    hits: ScopedMemoryHit[],
  ): ScopedMemorySearchResult => ({
    requestedMode: result.requestedMode,
    effectiveMode: result.effectiveMode,
    status: result.status,
    hits,
    ...(result.status === 'SEMANTIC_UNAVAILABLE'
      ? { semanticDegraded: 'SEMANTIC_UNAVAILABLE' as const }
      : {}),
  })

  const bytewise = (left: string, right: string): number =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))

  const bestRank = (hit: ScopedMemoryHit): number => Math.min(
    hit.componentRanks.keyword ?? Number.POSITIVE_INFINITY,
    hit.componentRanks.semantic ?? Number.POSITIVE_INFINITY,
  )

  const mergeScopedResults = (
    requestedMode: ScopedMemorySearchMode,
    sources: ReadonlyArray<{ result: HybridRetrievalResult; hits: ScopedMemoryHit[] }>,
    limit: number,
  ): ScopedMemorySearchResult => {
    const status = sources.some(source => source.result.status === 'SENSITIVE_INPUT_LOCAL_ONLY')
      ? 'SENSITIVE_INPUT_LOCAL_ONLY' as const
      : sources.some(source => source.result.status === 'SEMANTIC_UNAVAILABLE')
        ? 'SEMANTIC_UNAVAILABLE' as const
        : 'OK' as const
    const usedSemantic = sources.some(source =>
      source.result.effectiveMode === 'semantic' || source.result.effectiveMode === 'hybrid')
    const effectiveMode = requestedMode === 'keyword'
      ? 'keyword' as const
      : requestedMode === 'semantic'
        ? usedSemantic ? 'semantic' as const : 'none' as const
        : usedSemantic ? 'hybrid' as const : 'keyword' as const
    const hits = sources.flatMap(source => source.hits.map(hit => {
      const score = source.result.effectiveMode === 'hybrid'
        ? hit.score
        : 1 / (HYBRID_RRF_K + bestRank(hit))
      return { ...hit, score }
    })).sort((left, right) =>
      right.score - left.score || bestRank(left) - bestRank(right) ||
      bytewise(left.scopeId ?? '', right.scopeId ?? '') ||
      bytewise(left.sourcePath ?? '', right.sourcePath ?? '') ||
      bytewise(left.chunkId ?? '', right.chunkId ?? '')).slice(0, limit)
    return {
      requestedMode,
      effectiveMode,
      status,
      hits,
      ...(status === 'SEMANTIC_UNAVAILABLE'
        ? { semanticDegraded: 'SEMANTIC_UNAVAILABLE' as const }
        : {}),
    }
  }

  return Object.freeze<ScopedMemoryRouter>({
    searchAutomatic(lease, query, opts) {
      return withLeaseIo(lease, async () => {
        const limit = opts?.limit ?? 20
        const mode: ScopedMemorySearchMode = opts?.mode ?? 'hybrid'
        const global = await searchOne(
          lease, { kind: 'global', scopeId: 'global' }, query, limit, mode,
        )
        if (lease.projectKind !== 'project') {
          return scopedResult(global.result, global.hits.slice(0, limit))
        }
        try {
          const project = await searchOne(
            lease, projectScope(lease.projectId), query, limit, mode,
          )
          return mergeScopedResults(mode, [global, project], limit)
        } catch (error) {
          if (!isDegradableProjectFailure(error)) throw error
          deps.emit?.({
            kind: 'memory.scope_degraded',
            projectId: lease.projectId,
            sessionId: lease.sessionId,
            generation: lease.generation,
            reason: 'PROJECT_MEMORY_UNAVAILABLE',
          })
          return {
            ...scopedResult(global.result, global.hits.slice(0, limit)),
            degraded: 'PROJECT_MEMORY_UNAVAILABLE',
          }
        }
      })
    },

    commitGlobal: (lease, op) => withLeaseIo(
      lease,
      () => commitOne(lease, { kind: 'global', scopeId: 'global' }, op),
    ),
    commitProject(lease, op) {
      if (lease.projectKind !== 'project') {
        return Promise.reject(new ProtectedScopedMemoryError('PROJECT_SCOPE_REQUIRED'))
      }
      return withLeaseIo(lease, () => commitOne(lease, projectScope(lease.projectId), op))
    },
    forgetGlobal: (lease, factId, reason, humanConfirmed) => withLeaseIo(
      lease,
      () => forgetOne(lease, { kind: 'global', scopeId: 'global' }, factId, reason, humanConfirmed),
    ),
    forgetProject(lease, factId, reason, humanConfirmed) {
      if (lease.projectKind !== 'project') {
        return Promise.reject(new ProtectedScopedMemoryError('PROJECT_SCOPE_REQUIRED'))
      }
      return withLeaseIo(
        lease,
        () => forgetOne(lease, projectScope(lease.projectId), factId, reason, humanConfirmed),
      )
    },
  })
}

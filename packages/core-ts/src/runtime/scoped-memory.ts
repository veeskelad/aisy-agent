import type {
  CommitResult,
  Memory,
  MemoryOp,
  RankedHit,
} from '../memory/index.js'
import { ForgetListTamperError } from '../memory/index.js'
import type {
  ContextLeaseCoordinator,
  TurnContextLease,
} from './context-lease.js'

export interface ScopedMemoryHit extends RankedHit {
  scope: 'global' | 'project'
  projectId?: string
  /** Required by the protected production path; optional for legacy compatibility. */
  scopeId?: string
  sourcePath?: string
  chunkId?: string
  contentHash?: string
  provenanceRef?: string
  componentRanks: Readonly<{
    keyword?: number
    semantic?: number
  }>
}

export type ScopedMemorySearchMode = 'keyword' | 'semantic' | 'hybrid'

export interface ScopedMemorySearchResult {
  requestedMode: ScopedMemorySearchMode
  effectiveMode: ScopedMemorySearchMode | 'none'
  status: 'OK' | 'SEMANTIC_UNAVAILABLE' | 'SENSITIVE_INPUT_LOCAL_ONLY'
  hits: ScopedMemoryHit[]
  degraded?: 'PROJECT_MEMORY_UNAVAILABLE'
  /** Set when `semantic`/`hybrid` was asked for but only keyword could run. */
  semanticDegraded?: 'SEMANTIC_UNAVAILABLE'
}

export type ScopedMemoryEvent =
  | {
    kind: 'memory.scope_degraded'
    projectId: string
    sessionId: string
    generation: number
    reason: 'PROJECT_MEMORY_UNAVAILABLE'
  }
  | {
    kind: 'memory.semantic_degraded' | 'memory.embedding_input_blocked'
    scopeId: string
    sessionId: string
    generation: number
    status: 'SEMANTIC_UNAVAILABLE' | 'SENSITIVE_INPUT_LOCAL_ONLY'
  }

export interface ScopedMemoryRouter {
  searchAutomatic(
    lease: TurnContextLease,
    query: string,
    /** ADR-0065 retrieval mode; `hybrid` is the default and degrades to keyword
     *  when the semantic leg is unavailable. */
    opts?: { limit?: number; mode?: ScopedMemorySearchMode },
  ): Promise<ScopedMemorySearchResult>
  commitGlobal(
    lease: TurnContextLease,
    op: MemoryOp,
    ctx: { withinSession: boolean; operationId?: string },
  ): Promise<CommitResult>
  commitProject(
    lease: TurnContextLease,
    op: MemoryOp,
    ctx: { withinSession: boolean; operationId?: string },
  ): Promise<CommitResult>
  forgetGlobal(
    lease: TurnContextLease,
    factId: string,
    reason: string,
    humanConfirmed: boolean,
  ): Promise<void>
  forgetProject(
    lease: TurnContextLease,
    factId: string,
    reason: string,
    humanConfirmed: boolean,
  ): Promise<void>
}

export class ScopedMemoryError extends Error {
  constructor(
    public readonly code: 'PROJECT_SCOPE_REQUIRED' | 'PROJECT_MEMORY_UNAVAILABLE',
  ) {
    super(code)
    this.name = 'ScopedMemoryError'
  }
}

export function makeScopedMemoryRouter(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  globalMemory: Memory
  projectMemory(projectId: string): Memory | null
  emit?: (event: ScopedMemoryEvent) => void
}): ScopedMemoryRouter {
  const withLeaseIo = async <T>(lease: TurnContextLease, run: () => Promise<T>): Promise<T> => {
    const operation = deps.leases.reserveOperation(lease)
    try {
      operation.beginIo()
    } catch (error) {
      operation.complete()
      throw error
    }
    try {
      return await run()
    } finally {
      operation.complete()
    }
  }

  const projectStore = (lease: TurnContextLease): Memory => {
    if (lease.projectKind !== 'project') throw new ScopedMemoryError('PROJECT_SCOPE_REQUIRED')
    const memory = deps.projectMemory(lease.projectId)
    if (!memory) throw new ScopedMemoryError('PROJECT_MEMORY_UNAVAILABLE')
    return memory
  }

  return {
    searchAutomatic(lease, query, opts) {
      return withLeaseIo(lease, async () => {
        const limit = opts?.limit ?? 20
        const requestedMode = opts?.mode ?? 'hybrid'
        const unavailable = requestedMode !== 'keyword'
        const resultBase = {
          requestedMode,
          effectiveMode: requestedMode === 'semantic' ? 'none' as const : 'keyword' as const,
          status: unavailable ? 'SEMANTIC_UNAVAILABLE' as const : 'OK' as const,
          ...(unavailable ? { semanticDegraded: 'SEMANTIC_UNAVAILABLE' as const } : {}),
        }
        if (requestedMode === 'semantic') return { ...resultBase, hits: [] }
        const globalHits = (await deps.globalMemory.search(query, { limit })).map(
          (hit, index): ScopedMemoryHit => ({
            ...hit,
            scope: 'global',
            componentRanks: Object.freeze({ keyword: index + 1 }),
          }),
        )
        if (lease.projectKind !== 'project') {
          return { ...resultBase, hits: globalHits.slice(0, limit) }
        }

        let projectHits: ScopedMemoryHit[]
        try {
          const memory = deps.projectMemory(lease.projectId)
          if (!memory) throw new ScopedMemoryError('PROJECT_MEMORY_UNAVAILABLE')
          projectHits = (await memory.search(query, { limit })).map(
            (hit, index): ScopedMemoryHit => ({
              ...hit,
              scope: 'project',
              projectId: lease.projectId,
              componentRanks: Object.freeze({ keyword: index + 1 }),
            }),
          )
        } catch (error) {
          if (error instanceof ForgetListTamperError) throw error
          deps.emit?.({
            kind: 'memory.scope_degraded',
            projectId: lease.projectId,
            sessionId: lease.sessionId,
            generation: lease.generation,
            reason: 'PROJECT_MEMORY_UNAVAILABLE',
          })
          return {
            ...resultBase,
            hits: globalHits.slice(0, limit),
            degraded: 'PROJECT_MEMORY_UNAVAILABLE',
          }
        }

        const hits = [...projectHits, ...globalHits]
          .sort((left, right) =>
            left.score - right.score ||
            (left.scope === right.scope ? 0 : left.scope === 'project' ? -1 : 1) ||
            left.id.localeCompare(right.id),
          )
          .slice(0, limit)
        return { ...resultBase, hits }
      })
    },

    commitGlobal(lease, op, ctx) {
      return withLeaseIo(lease, () => deps.globalMemory.commit(op, ctx))
    },

    commitProject(lease, op, ctx) {
      if (lease.projectKind !== 'project') {
        return Promise.reject(new ScopedMemoryError('PROJECT_SCOPE_REQUIRED'))
      }
      return withLeaseIo(lease, () => projectStore(lease).commit(op, ctx))
    },

    forgetGlobal(lease, factId, reason, humanConfirmed) {
      return withLeaseIo(
        lease,
        () => deps.globalMemory.forget(factId, reason, humanConfirmed),
      )
    },

    forgetProject(lease, factId, reason, humanConfirmed) {
      if (lease.projectKind !== 'project') {
        return Promise.reject(new ScopedMemoryError('PROJECT_SCOPE_REQUIRED'))
      }
      return withLeaseIo(
        lease,
        () => projectStore(lease).forget(factId, reason, humanConfirmed),
      )
    },
  }
}

import { isAbsolute, win32 } from 'node:path'
import type { ContextSpan, TurnInput } from '../agent-loop/types.js'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'

export type LazyContextScope = 'global' | 'project'

export type LazyContextKind =
  | 'daily-journal'
  | 'memory-catalogue'
  | 'knowledge-catalogue'
  | 'current-task'
  | 'project-journal'
  | 'retrieved'

export interface LazyContextExcerpt {
  readonly scope: LazyContextScope
  readonly scopeId: string
  readonly projectId?: string
  readonly kind: LazyContextKind
  readonly rank: number
  readonly sourcePath: string
  readonly provenanceRef: string
  readonly text: string
}

export interface ProjectLazyContextBatch {
  readonly excerpts: readonly LazyContextExcerpt[]
  readonly degraded?: 'PROJECT_RETRIEVAL_UNAVAILABLE'
}

export interface LayeredContextBatch {
  readonly globalExcerpts: readonly LazyContextExcerpt[]
  readonly project: ProjectLazyContextBatch
}

export interface LayeredContextSource {
  load(input: {
    lease: TurnContextLease
    query: string
  }): Promise<LayeredContextBatch>
}

export interface LayeredContextEvent {
  kind: 'context.lazy_loaded' | 'context.project_degraded'
  leaseId: string
  projectId: string
  sessionId: string
  generation: number
  globalExcerpts: number
  projectExcerpts: number
}

export interface LayeredContextAssembler {
  augmentTurn(lease: TurnContextLease, input: TurnInput): Promise<ContextSpan[]>
}

export class LayeredContextError extends Error {
  constructor(public readonly code:
    | 'INVALID_QUERY'
    | 'INVALID_EXCERPT'
    | 'SCOPE_MISMATCH'
    | 'DUPLICATE_EXCERPT',
  ) {
    super(code)
    this.name = 'LayeredContextError'
  }
}

const KIND_ORDER: Readonly<Record<LazyContextKind, number>> = Object.freeze({
  'daily-journal': 0,
  'current-task': 0,
  'project-journal': 1,
  'memory-catalogue': 1,
  'knowledge-catalogue': 2,
  retrieved: 3,
})

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function safeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0') ||
    isAbsolute(value) || win32.isAbsolute(value)) return false
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0 && !value.includes('\0')
}

function validateExcerpt(excerpt: LazyContextExcerpt, lease: TurnContextLease): void {
  if (!Number.isSafeInteger(excerpt.rank) || excerpt.rank < 0 ||
    !safeRelativePath(excerpt.sourcePath) || !nonEmpty(excerpt.provenanceRef) ||
    !nonEmpty(excerpt.text) || KIND_ORDER[excerpt.kind] === undefined) {
    throw new LayeredContextError('INVALID_EXCERPT')
  }
  if (excerpt.scope === 'global') {
    if (excerpt.scopeId !== 'global' || excerpt.projectId !== undefined ||
      excerpt.kind === 'current-task' || excerpt.kind === 'project-journal') {
      throw new LayeredContextError('SCOPE_MISMATCH')
    }
    return
  }
  if (lease.projectKind !== 'project' || excerpt.scopeId !== `project:${lease.projectId}` ||
    excerpt.projectId !== lease.projectId || excerpt.kind === 'daily-journal') {
    throw new LayeredContextError('SCOPE_MISMATCH')
  }
}

function operatorQuery(input: TurnInput): string {
  const query = input.spans
    .filter(span => span.role === 'user' && span.provenance === 'operator')
    .map(span => span.text)
    .join('\n')
  if (query.trim().length === 0) throw new LayeredContextError('INVALID_QUERY')
  return query
}

function toSpan(excerpt: LazyContextExcerpt): ContextSpan {
  const metadata = JSON.stringify({
    scope: excerpt.scope,
    scopeId: excerpt.scopeId,
    ...(excerpt.projectId === undefined ? {} : { projectId: excerpt.projectId }),
    kind: excerpt.kind,
    sourcePath: excerpt.sourcePath,
    provenanceRef: excerpt.provenanceRef,
  })
  return {
    role: 'user',
    provenance: 'untrusted',
    text: `[AISY_LAZY_CONTEXT ${metadata}]\n${excerpt.text}`,
  }
}

/**
 * Assembles only the lazy global/project layers from an immutable turn lease.
 * Frozen DNA and durable transcript history remain owned by Agent Loop.
 */
export function makeLayeredContextAssembler(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  source: LayeredContextSource
  emit?: (event: LayeredContextEvent) => void
}): LayeredContextAssembler {
  return Object.freeze<LayeredContextAssembler>({
    async augmentTurn(lease, input) {
      if (input.sessionId !== lease.sessionId) throw new LayeredContextError('SCOPE_MISMATCH')
      const query = operatorQuery(input)
      const operation = deps.leases.reserveOperation(lease)
      try {
        operation.beginIo()
        const loaded = await deps.source.load({ lease, query })
        const global = [...loaded.globalExcerpts]
        const project = loaded.project
        if ((project.degraded !== undefined &&
          project.degraded !== 'PROJECT_RETRIEVAL_UNAVAILABLE') ||
          (project.degraded !== undefined &&
            project.excerpts.some(excerpt => excerpt.kind === 'retrieved')) ||
          (lease.projectKind === 'workspace' &&
            (project.degraded !== undefined || project.excerpts.length > 0))) {
          throw new LayeredContextError('INVALID_EXCERPT')
        }

        const all = [...global, ...project.excerpts]
        const seen = new Set<string>()
        for (const excerpt of all) {
          validateExcerpt(excerpt, lease)
          const identity = `${excerpt.scopeId}\0${excerpt.sourcePath}\0${excerpt.provenanceRef}`
          if (seen.has(identity)) throw new LayeredContextError('DUPLICATE_EXCERPT')
          seen.add(identity)
        }
        all.sort((left, right) =>
          (left.scope === right.scope ? 0 : left.scope === 'global' ? -1 : 1) ||
          KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
          left.rank - right.rank ||
          compareBytes(left.sourcePath, right.sourcePath) ||
          compareBytes(left.provenanceRef, right.provenanceRef),
        )

        // A switch may begin while the source is reading. Revalidate admission
        // before any old-context bytes can reach the model.
        const validation = deps.leases.reserveOperation(lease)
        validation.complete()

        const counts = {
          leaseId: lease.leaseId,
          projectId: lease.projectId,
          sessionId: lease.sessionId,
          generation: lease.generation,
          globalExcerpts: global.length,
          projectExcerpts: project.excerpts.length,
        }
        if (project.degraded !== undefined) {
          deps.emit?.({ kind: 'context.project_degraded', ...counts })
        }
        deps.emit?.({ kind: 'context.lazy_loaded', ...counts })
        return all.map(toSpan)
      } finally {
        operation.complete()
      }
    },
  })
}

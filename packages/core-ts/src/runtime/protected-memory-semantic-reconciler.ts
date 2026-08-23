import { createHash } from 'node:crypto'
import {
  HybridRetrievalIntegrityError,
  type EmbeddingDescriptor,
  type RetrievalScope,
  type ScopedRetrievalCandidate,
} from './hybrid-retrieval.js'
import {
  parseProtectedMemoryFactRecord,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'
import type {
  SemanticIndexResult,
  SemanticRetrievalRuntime,
} from './semantic-retrieval-runtime.js'
import { SemanticVectorStoreError } from './sqlite-vec-semantic-store.js'

export type ProtectedMemorySemanticReconcilerState =
  | 'IDLE'
  | 'QUEUED'
  | 'SCANNING'
  | 'DERIVING'
  | 'CURRENT'
  | 'DEGRADED'
  | 'REVOKED'
  | 'CLOSED'

export interface ProtectedMemorySemanticReconcileSummary {
  state: ProtectedMemorySemanticReconcilerState
  scanned: number
  indexed: number
  cached: number
  sensitiveSkipped: number
  staleSkipped: number
  failed: number
}

export type ProtectedMemorySemanticReconcilerEvent =
  | {
    kind: 'memory.semantic_reconcile_completed'
    status: 'CURRENT' | 'DEGRADED' | 'REVOKED'
    code:
      | 'RECONCILED'
      | 'DERIVATION_FAILED'
      | 'SOURCE_UNAVAILABLE'
      | 'SEMANTIC_UNAVAILABLE'
      | 'SEMANTIC_REVOKED'
    scopeId: string
    descriptorId: string
    counts: Readonly<Omit<ProtectedMemorySemanticReconcileSummary, 'state'>>
  }
  | {
    kind: 'memory.semantic_reconcile_item'
    code: 'ITEM_STALE' | 'ITEM_FAILED'
    scopeId: string
    descriptorId: string
    itemRef: string
  }

export interface ProtectedMemorySemanticSourcePort {
  assertRecovered(scope: ProtectedMemoryScope): Promise<void>
  /** Stable snapshot containing only published, live and not-forgotten facts. */
  listLiveFacts(scope: ProtectedMemoryScope): Promise<ProtectedMemoryFactRecordV2[]>
}

export interface ProtectedMemorySemanticDerivationPort {
  /** Provider implementations own their existing timeout/abort bound. */
  availability(scope: RetrievalScope): Promise<'healthy' | 'unavailable' | 'revoked'>
  indexDocument: SemanticRetrievalRuntime['indexDocument']
  /** Deliberately unused here: DELETE/UPDATE WAL owns negative reconciliation. */
  removeFact: SemanticRetrievalRuntime['removeFact']
}

export interface ProtectedMemorySemanticReconciler {
  readonly descriptorId: string
  state(): ProtectedMemorySemanticReconcilerState
  request(): void
  reconcile(): Promise<ProtectedMemorySemanticReconcileSummary>
  drain(): Promise<void>
  /** Refuses new requests and waits for the current already-bounded port operation. */
  close(): Promise<void>
}

export class ProtectedMemorySemanticReconcilerError extends Error {
  constructor(public readonly code: 'INVALID_SCOPE' | 'INVALID_DESCRIPTOR') {
    super(code)
    this.name = 'ProtectedMemorySemanticReconcilerError'
  }
}

function stableDescriptor(descriptor: EmbeddingDescriptor): EmbeddingDescriptor {
  const stable = {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    modelRevision: descriptor.modelRevision,
    dimensions: descriptor.dimensions,
    normalizationVersion: descriptor.normalizationVersion,
    chunkerVersion: descriptor.chunkerVersion,
  }
  if (!Number.isInteger(stable.dimensions) || stable.dimensions < 1 ||
    [stable.provider, stable.modelId, stable.modelRevision,
      stable.normalizationVersion, stable.chunkerVersion].some(value => value.length === 0)) {
    throw new ProtectedMemorySemanticReconcilerError('INVALID_DESCRIPTOR')
  }
  return Object.freeze(stable)
}

export function semanticDescriptorId(descriptor: EmbeddingDescriptor): string {
  return createHash('sha256')
    .update(JSON.stringify(stableDescriptor(descriptor)), 'utf8')
    .digest('hex')
}

function exactScope(scope: ProtectedMemoryScope): ProtectedMemoryScope {
  if (scope.kind === 'global') {
    if (scope.scopeId !== 'global') {
      throw new ProtectedMemorySemanticReconcilerError('INVALID_SCOPE')
    }
    return Object.freeze({ kind: 'global', scopeId: 'global' })
  }
  if (scope.projectId.length === 0 || scope.scopeId !== `project:${scope.projectId}`) {
    throw new ProtectedMemorySemanticReconcilerError('INVALID_SCOPE')
  }
  return Object.freeze({
    kind: 'project', scopeId: scope.scopeId, projectId: scope.projectId,
  })
}

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (right.kind !== 'project' ||
      (left.kind === 'project' && left.projectId === right.projectId))
}

function itemRef(factId: string): string {
  return createHash('sha256').update(factId, 'utf8').digest('hex')
}

function candidate(fact: ProtectedMemoryFactRecordV2): ScopedRetrievalCandidate {
  return {
    hitId: fact.id,
    scope: fact.scope.kind,
    scopeId: fact.scope.scopeId,
    ...(fact.scope.kind === 'project' ? { projectId: fact.scope.projectId } : {}),
    sourcePath: fact.sourcePath,
    chunkId: fact.id,
    contentHash: fact.contentHash,
    provenance: fact.provenance,
    score: 0,
  }
}

function blank(state: ProtectedMemorySemanticReconcilerState): ProtectedMemorySemanticReconcileSummary {
  return { state, scanned: 0, indexed: 0, cached: 0, sensitiveSkipped: 0, staleSkipped: 0, failed: 0 }
}

function staleDerivation(error: unknown): boolean {
  return (error instanceof HybridRetrievalIntegrityError &&
      error.code === 'DERIVED_FILTER_VIOLATION') ||
    (error instanceof SemanticVectorStoreError && error.code === 'FILTER_VIOLATION')
}

/** Positive-only, non-load-bearing semantic backfill for one protected scope. */
export function makeProtectedMemorySemanticReconciler(input: {
  scope: ProtectedMemoryScope
  descriptor: EmbeddingDescriptor
  source: ProtectedMemorySemanticSourcePort
  semantic: ProtectedMemorySemanticDerivationPort
  emit?: (event: ProtectedMemorySemanticReconcilerEvent) => void
}): ProtectedMemorySemanticReconciler {
  const scope = exactScope(input.scope)
  const descriptor = stableDescriptor(input.descriptor)
  const descriptorId = semanticDescriptorId(descriptor)
  let currentState: ProtectedMemorySemanticReconcilerState = 'IDLE'
  let latest = blank('IDLE')
  let queued = false
  let closed = false
  let running: Promise<void> | null = null
  let closing: Promise<void> | null = null

  const emit = (event: ProtectedMemorySemanticReconcilerEvent): void => {
    try { input.emit?.(event) } catch { /* observability is non-load-bearing */ }
  }
  const counts = (summary: ProtectedMemorySemanticReconcileSummary) => Object.freeze({
    scanned: summary.scanned,
    indexed: summary.indexed,
    cached: summary.cached,
    sensitiveSkipped: summary.sensitiveSkipped,
    staleSkipped: summary.staleSkipped,
    failed: summary.failed,
  })
  const completed = (
    code: Extract<ProtectedMemorySemanticReconcilerEvent, {
      kind: 'memory.semantic_reconcile_completed'
    }>['code'],
    summary: ProtectedMemorySemanticReconcileSummary,
  ): void => {
    const status = summary.state === 'CURRENT'
      ? 'CURRENT' as const
      : summary.state === 'REVOKED' ? 'REVOKED' as const : 'DEGRADED' as const
    emit({
      kind: 'memory.semantic_reconcile_completed',
      status,
      code,
      scopeId: scope.scopeId,
      descriptorId,
      counts: counts(summary),
    })
  }
  const itemEvent = (
    code: 'ITEM_STALE' | 'ITEM_FAILED',
    factId: string,
  ): void => emit({
    kind: 'memory.semantic_reconcile_item',
    code,
    scopeId: scope.scopeId,
    descriptorId,
    itemRef: itemRef(factId),
  })

  const runOnce = async (): Promise<void> => {
    currentState = 'SCANNING'
    const summary = blank('SCANNING')
    let snapshot: ProtectedMemoryFactRecordV2[]
    try {
      // Recovery and the code-owned scope snapshot always precede provider I/O.
      await input.source.assertRecovered(scope)
      snapshot = await input.source.listLiveFacts(scope)
    } catch {
      currentState = 'DEGRADED'
      latest = { ...summary, state: currentState, failed: 1 }
      completed('SOURCE_UNAVAILABLE', latest)
      return
    }

    summary.scanned = snapshot.length
    const valid: ProtectedMemoryFactRecordV2[] = []
    const seen = new Set<string>()
    for (const source of snapshot) {
      const fact = parseProtectedMemoryFactRecord(source)
      if (!fact || !fact.published || fact.invalidAt !== null ||
        !sameScope(fact.scope, scope) || seen.has(fact.id)) {
        summary.staleSkipped += 1
        itemEvent('ITEM_STALE', typeof source.id === 'string' ? source.id : '')
        continue
      }
      seen.add(fact.id)
      valid.push(fact)
    }

    let availability: 'healthy' | 'unavailable' | 'revoked'
    try {
      availability = await input.semantic.availability(scope)
    } catch {
      availability = 'unavailable'
    }
    if (availability !== 'healthy') {
      currentState = availability === 'revoked' ? 'REVOKED' : 'DEGRADED'
      latest = { ...summary, state: currentState }
      completed(availability === 'revoked' ? 'SEMANTIC_REVOKED' : 'SEMANTIC_UNAVAILABLE', latest)
      return
    }

    currentState = 'DERIVING'
    for (const fact of valid) {
      try {
        const result: SemanticIndexResult = await input.semantic.indexDocument({
          candidate: candidate(fact),
          factKey: fact.factKey,
          content: fact.text,
        })
        if (result === 'INDEXED') summary.indexed += 1
        else if (result === 'CACHED') summary.cached += 1
        else summary.sensitiveSkipped += 1
      } catch (error) {
        if (staleDerivation(error)) {
          summary.staleSkipped += 1
          itemEvent('ITEM_STALE', fact.id)
        } else {
          summary.failed += 1
          itemEvent('ITEM_FAILED', fact.id)
        }
      }
    }
    currentState = summary.failed > 0 || summary.staleSkipped > 0 ? 'DEGRADED' : 'CURRENT'
    latest = { ...summary, state: currentState }
    completed(currentState === 'DEGRADED' ? 'DERIVATION_FAILED' : 'RECONCILED', latest)
  }

  const pump = async (): Promise<void> => {
    while (queued && !closed) {
      queued = false
      await runOnce()
    }
  }

  const ensurePump = (): void => {
    if (closed || running !== null || !queued) return
    const task = Promise.resolve().then(pump)
    let guarded: Promise<void>
    guarded = task
      .catch(() => {
        currentState = 'DEGRADED'
        latest = { ...blank('DEGRADED'), failed: 1 }
        completed('SOURCE_UNAVAILABLE', latest)
      })
      .finally(() => {
        if (running === guarded) running = null
        if (queued && !closed) ensurePump()
      })
    running = guarded
    // The pump owns a catch handler even when the caller never drains it.
    void guarded
  }

  const request = (): void => {
    if (closed) return
    queued = true
    currentState = 'QUEUED'
    ensurePump()
  }

  const drain = async (): Promise<void> => {
    while (running !== null || queued) {
      if (!closed) ensurePump()
      const active = running
      if (active !== null) await active
      else if (closed) return
    }
  }

  return Object.freeze({
    descriptorId,
    state: () => currentState,
    request,
    async reconcile() {
      request()
      await drain()
      return Object.freeze({ ...latest })
    },
    drain,
    close() {
      if (closing !== null) return closing
      closed = true
      queued = false
      closing = drain().finally(() => {
        currentState = 'CLOSED'
        latest = { ...latest, state: 'CLOSED' }
      })
      return closing
    },
  })
}

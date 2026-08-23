import { createHash } from 'node:crypto'
import {
  HybridRetrievalIntegrityError,
  SensitiveEmbeddingInputError,
  embeddingCacheKey,
  makeSensitiveEmbeddingProvider,
  scanEmbeddingInput,
  type EmbeddingInput,
  type EmbeddingProvider,
  type RetrievalScope,
  type ScopedRetrievalCandidate,
  type SemanticRetrievalLeg,
} from './hybrid-retrieval.js'
import {
  SemanticVectorStoreError,
  type SemanticIndexRecord,
  type SemanticVectorStore,
} from './sqlite-vec-semantic-store.js'

export type SemanticIndexResult = 'INDEXED' | 'CACHED' | 'SKIPPED_SENSITIVE'

export interface SemanticRetrievalRuntimeEvent {
  kind:
    | 'memory.semantic_document_indexed'
    | 'memory.semantic_document_skipped'
    | 'memory.semantic_revoked'
  scopeId: string
  status: SemanticIndexResult | 'REVOKED'
}

export interface SemanticRetrievalRuntime extends SemanticRetrievalLeg {
  indexDocument(input: {
    candidate: ScopedRetrievalCandidate
    factKey: string
    content: string
  }): Promise<SemanticIndexResult>
  removeFact(factKey: string): void
  revokeAndPurge(): void
  enableAfterReconnect(): Promise<void>
}

export function normalizedEmbeddingContentHash(content: string): string {
  const normalized = content.replace(/\r\n?/g, '\n').normalize('NFKC')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function canonicalSourceContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function sameScope(left: RetrievalScope, right: RetrievalScope): boolean {
  if (left.kind !== right.kind || left.scopeId !== right.scopeId) return false
  if (left.kind === 'project' && right.kind === 'project') {
    return left.projectId === right.projectId
  }
  if (left.kind === 'monitoring' && right.kind === 'monitoring') {
    return left.monitorId === right.monitorId
  }
  return left.kind === 'global' && right.kind === 'global'
}

function candidateMatchesScope(
  candidate: ScopedRetrievalCandidate,
  scope: RetrievalScope,
): boolean {
  if (candidate.scope !== scope.kind || candidate.scopeId !== scope.scopeId) return false
  if (scope.kind === 'project') return candidate.projectId === scope.projectId
  return candidate.projectId === undefined
}

/** Coordinates provider, cache and one physically scoped sqlite-vec store. */
export function makeSemanticRetrievalRuntime(input: {
  scope: RetrievalScope
  provider: EmbeddingProvider
  store: SemanticVectorStore
  emit?: (event: SemanticRetrievalRuntimeEvent) => void
}): SemanticRetrievalRuntime {
  const scope = Object.freeze({ ...input.scope }) as RetrievalScope
  const provider = makeSensitiveEmbeddingProvider({ provider: input.provider })
  const controllers = new Set<AbortController>()
  let generation = 0
  let revoked = input.store.state() === 'revoked'

  const begin = (): { generation: number; controller: AbortController; complete(): void } => {
    if (revoked) throw new SemanticVectorStoreError('REVOKED')
    const controller = new AbortController()
    controllers.add(controller)
    const captured = generation
    return {
      generation: captured,
      controller,
      complete: () => controllers.delete(controller),
    }
  }
  const assertCurrent = (captured: number): void => {
    if (revoked || captured !== generation) throw new SemanticVectorStoreError('REVOKED')
  }
  const mapStoreError = (error: unknown): never => {
    if (error instanceof SemanticVectorStoreError && error.code === 'FILTER_VIOLATION') {
      throw new HybridRetrievalIntegrityError('DERIVED_FILTER_VIOLATION')
    }
    if (error instanceof SemanticVectorStoreError && error.code === 'CORRUPT_INDEX') {
      throw new HybridRetrievalIntegrityError('DERIVED_INDEX_CORRUPT')
    }
    throw error
  }
  const embedding = async (
    kind: 'query' | 'document',
    value: EmbeddingInput,
    operation: ReturnType<typeof begin>,
  ): Promise<readonly number[]> => {
    const cached = input.store.getCached(embeddingCacheKey(provider.descriptor, value.contentHash))
    if (cached) return cached
    const vectors = await provider.embed(kind, [value], operation.controller.signal)
    assertCurrent(operation.generation)
    const vector = vectors[0]
    if (!vector) throw new Error('embedding result missing')
    if (kind === 'query') {
      input.store.putCached(kind, embeddingCacheKey(provider.descriptor, value.contentHash), vector)
    }
    return vector
  }

  return Object.freeze({
    async availability(requestScope: RetrievalScope) {
      if (!sameScope(scope, requestScope)) {
        throw new HybridRetrievalIntegrityError('CROSS_SCOPE_HIT')
      }
      if (revoked || input.store.state() === 'revoked') return 'revoked'
      if (input.store.state() !== 'healthy') return 'unavailable'
      try {
        return await provider.health()
      } catch {
        return 'unavailable'
      }
    },

    async search(
      requestScope: RetrievalScope,
      query: string,
      options: { limit: number },
    ) {
      if (!sameScope(scope, requestScope)) {
        throw new HybridRetrievalIntegrityError('CROSS_SCOPE_HIT')
      }
      const operation = begin()
      try {
        const contentHash = normalizedEmbeddingContentHash(query)
        const vector = await embedding(
          'query',
          { content: query, contentHash },
          operation,
        )
        assertCurrent(operation.generation)
        try {
          return await input.store.search(vector, options.limit)
        } catch (error) {
          return mapStoreError(error)
        }
      } finally {
        operation.complete()
      }
    },

    async indexDocument(source: {
      candidate: ScopedRetrievalCandidate
      factKey: string
      content: string
    }) {
      const candidate = Object.freeze({ ...source.candidate })
      const factKey = source.factKey
      const content = source.content
      if (factKey.length === 0 || !candidateMatchesScope(candidate, scope) ||
        canonicalSourceContentHash(content) !== candidate.contentHash) {
        throw new SemanticVectorStoreError('INVALID_RECORD')
      }
      if (!scanEmbeddingInput({ content, sourcePath: candidate.sourcePath }).safe) {
        input.store.removeFact(factKey)
        input.emit?.({
          kind: 'memory.semantic_document_skipped',
          scopeId: scope.scopeId,
          status: 'SKIPPED_SENSITIVE',
        })
        return 'SKIPPED_SENSITIVE'
      }
      const operation = begin()
      try {
        const embeddingContentHash = normalizedEmbeddingContentHash(content)
        const cacheKey = embeddingCacheKey(provider.descriptor, embeddingContentHash)
        const cached = input.store.getCached(cacheKey)
        const vector = cached ?? await embedding(
          'document',
          { content, contentHash: embeddingContentHash, sourcePath: candidate.sourcePath },
          operation,
        )
        assertCurrent(operation.generation)
        const record: SemanticIndexRecord = { candidate, factKey, cacheKey }
        try {
          await input.store.upsert(record, vector)
        } catch (error) {
          return mapStoreError(error)
        }
        assertCurrent(operation.generation)
        if (!cached) input.store.putCached('document', cacheKey, vector)
        const status = cached ? 'CACHED' : 'INDEXED'
        input.emit?.({
          kind: 'memory.semantic_document_indexed',
          scopeId: scope.scopeId,
          status,
        })
        return status
      } catch (error) {
        if (error instanceof SensitiveEmbeddingInputError) {
          input.store.removeFact(factKey)
          input.emit?.({
            kind: 'memory.semantic_document_skipped',
            scopeId: scope.scopeId,
            status: 'SKIPPED_SENSITIVE',
          })
          return 'SKIPPED_SENSITIVE'
        }
        throw error
      } finally {
        operation.complete()
      }
    },

    removeFact: (factKey: string) => input.store.removeFact(factKey),

    revokeAndPurge() {
      // Flip/abort first so no in-flight response can be cached after purge.
      revoked = true
      generation += 1
      for (const controller of controllers) controller.abort()
      provider.revoke?.()
      input.store.revokeAndPurge()
      input.emit?.({ kind: 'memory.semantic_revoked', scopeId: scope.scopeId, status: 'REVOKED' })
    },

    async enableAfterReconnect() {
      const health = await provider.health()
      if (health !== 'healthy') throw new SemanticVectorStoreError('REVOKED')
      input.store.enableAfterReconnect()
      generation += 1
      revoked = false
    },
  })
}

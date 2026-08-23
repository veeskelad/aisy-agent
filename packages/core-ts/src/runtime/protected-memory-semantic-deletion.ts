import type { ProtectedMemoryDeletionDerivedPort } from './protected-memory-deletion.js'
import type { ProtectedMemoryScope } from './protected-memory-publication.js'
import type { SemanticVectorStore } from './sqlite-vec-semantic-store.js'

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

/** Purges and verifies the physically separate vector/cache projection for one exact scope. */
export function makeProtectedMemorySemanticDeletionPort(input: {
  scope: ProtectedMemoryScope
  store: Pick<SemanticVectorStore, 'removeFact' | 'hasFact' | 'integrityCheck'>
}): ProtectedMemoryDeletionDerivedPort {
  const scope = structuredClone(input.scope)
  const assertScope = (requested: ProtectedMemoryScope): void => {
    if (!sameScope(scope, requested)) throw new Error('SCOPE_MISMATCH')
  }
  return Object.freeze<ProtectedMemoryDeletionDerivedPort>({
    async purge(request) {
      assertScope(request.scope)
      input.store.removeFact(request.factKey)
    },
    async verifyPurged(request) {
      assertScope(request.scope)
      return input.store.integrityCheck().ok && !input.store.hasFact(request.factKey)
    },
  })
}

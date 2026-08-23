import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import type { ProtectedMemoryDeletionService } from './protected-memory-deletion.js'
import type { ProtectedMemoryPublicationService, ProtectedMemoryScope } from './protected-memory-publication.js'
import type { ProtectedMemoryUpdateService } from './protected-memory-update.js'

export interface ProtectedMemoryRecoveryStatePort {
  listWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  listDeletionWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  listUpdateWals(scope: ProtectedMemoryScope): Promise<unknown[]>
  integrityCheck(): { ok: boolean; detail?: string }
}

export interface ProtectedMemoryRecoveryReport {
  recovered: 'none' | 'publication' | 'deletion' | 'update'
  operations: number
}

export interface ProtectedMemoryRecoveryGate {
  recoverScope(lease: TurnContextLease, scope: ProtectedMemoryScope): Promise<ProtectedMemoryRecoveryReport>
  assertScopeRecovered(lease: TurnContextLease, scope: ProtectedMemoryScope): Promise<void>
}

export class ProtectedMemoryRecoveryGateError extends Error {
  constructor(public readonly code:
    | 'SCOPE_MISMATCH'
    | 'RECOVERY_REQUIRED'
    | 'RECOVERY_CONFLICT'
    | 'INTEGRITY_FAILED',
  ) {
    super(code)
    this.name = 'ProtectedMemoryRecoveryGateError'
  }
}

function sameLeaseScope(lease: TurnContextLease, scope: ProtectedMemoryScope): boolean {
  return scope.kind === 'global' ||
    (lease.projectKind === 'project' && lease.projectId === scope.projectId)
}

export function makeProtectedMemoryRecoveryGate(deps: {
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  persistence(scope: ProtectedMemoryScope): ProtectedMemoryRecoveryStatePort
  publication: Pick<ProtectedMemoryPublicationService, 'recoverScope'>
  deletion: Pick<ProtectedMemoryDeletionService, 'recoverScope'>
  update: Pick<ProtectedMemoryUpdateService, 'recoverScope'>
  withScopeExclusive<T>(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    run: () => Promise<T>,
  ): Promise<T>
}): ProtectedMemoryRecoveryGate {
  const inspect = async (lease: TurnContextLease, scope: ProtectedMemoryScope) => {
    const operation = deps.leases.reserveOperation(lease)
    try {
      operation.beginIo()
      return await deps.withScopeExclusive(lease, scope, async () => {
        const persistence = deps.persistence(scope)
        const [publication, deletion, update] = await Promise.all([
          persistence.listWals(scope),
          persistence.listDeletionWals(scope),
          persistence.listUpdateWals(scope),
        ])
        return {
          publication: publication.length,
          deletion: deletion.length,
          update: update.length,
          integrity: persistence.integrityCheck(),
        }
      })
    } finally {
      operation.complete()
    }
  }

  const assertScope = (lease: TurnContextLease, scope: ProtectedMemoryScope): void => {
    if (!sameLeaseScope(lease, scope)) throw new ProtectedMemoryRecoveryGateError('SCOPE_MISMATCH')
  }

  return Object.freeze<ProtectedMemoryRecoveryGate>({
    async recoverScope(lease, scope) {
      assertScope(lease, scope)
      const state = await inspect(lease, scope)
      const families = [
        ['publication', state.publication],
        ['deletion', state.deletion],
        ['update', state.update],
      ] as const
      const pending = families.filter(([, count]) => count > 0)
      const total = families.reduce((sum, [, count]) => sum + count, 0)
      if (pending.length > 1 || total > 1) {
        throw new ProtectedMemoryRecoveryGateError('RECOVERY_CONFLICT')
      }
      if (pending.length === 0) {
        if (!state.integrity.ok) throw new ProtectedMemoryRecoveryGateError('INTEGRITY_FAILED')
        return { recovered: 'none', operations: 0 }
      }
      const family = pending[0]![0]
      if (family === 'publication') await deps.publication.recoverScope(lease, scope)
      else if (family === 'deletion') await deps.deletion.recoverScope(lease, scope)
      else await deps.update.recoverScope(lease, scope)
      const completed = await inspect(lease, scope)
      if (completed.publication + completed.deletion + completed.update !== 0) {
        throw new ProtectedMemoryRecoveryGateError('RECOVERY_REQUIRED')
      }
      if (!completed.integrity.ok) throw new ProtectedMemoryRecoveryGateError('INTEGRITY_FAILED')
      return { recovered: family, operations: total }
    },

    async assertScopeRecovered(lease, scope) {
      assertScope(lease, scope)
      const state = await inspect(lease, scope)
      if (state.publication + state.deletion + state.update !== 0) {
        throw new ProtectedMemoryRecoveryGateError('RECOVERY_REQUIRED')
      }
      if (!state.integrity.ok) throw new ProtectedMemoryRecoveryGateError('INTEGRITY_FAILED')
    },
  })
}

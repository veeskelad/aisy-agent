// Lease source for paths that have no interactive turn (ADR-0074 §5).
//
// After ADR-0074 nothing touches memory without a `TurnContextLease` — not
// nightly, not cold start, not `aisy doctor`. This module is the only place that
// mints such leases, so "who is allowed to run without a turn" stays one
// answerable question instead of being spread across call sites.
//
// Every lease is closed in `finally`: a background job that throws must not leave
// the scope barrier holding an operation forever.

import type {
  ContextLeaseCoordinator,
  ResolvedWorkBinding,
  TurnContextLease,
  WorkContextKind,
} from '@aisy/core'

export type MemoryLeaseRefusal = 'invalid-binding' | 'invalid-workspace'

export class MemoryLeaseError extends Error {
  constructor(readonly reason: MemoryLeaseRefusal) {
    super(`memory lease refused: ${reason}`)
    this.name = 'MemoryLeaseError'
  }
}

export interface MemoryLeaseSource {
  /**
   * Short-lived Workspace lease for maintenance that belongs to no conversation:
   * cold-start recovery, onboarding checks, doctor probes.
   */
  withMaintenanceLease<T>(run: (lease: TurnContextLease) => Promise<T>): Promise<T>
  /** Lease bound to a durable background binding (nightly, triggers, goals). */
  withBackgroundLease<T>(
    binding: ResolvedWorkBinding,
    run: (lease: TurnContextLease) => Promise<T>,
  ): Promise<T>
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function makeMemoryLeaseSource(input: {
  leases: ContextLeaseCoordinator
  operatorId: string
  profileId: string
  /** Workspace context used for maintenance work. */
  workspace: { projectId: string; root: string }
  /** Root resolver for a background binding; returns null when the project is unknown. */
  rootFor(binding: ResolvedWorkBinding): string | null
}): MemoryLeaseSource {
  if (!nonEmpty(input.operatorId) || !nonEmpty(input.profileId) ||
    !nonEmpty(input.workspace.projectId) || !nonEmpty(input.workspace.root)) {
    throw new MemoryLeaseError('invalid-workspace')
  }

  const use = async <T>(
    acquired: Omit<TurnContextLease, 'leaseId'>,
    run: (lease: TurnContextLease) => Promise<T>,
  ): Promise<T> => {
    const lease = input.leases.acquire(acquired)
    try {
      return await run(lease)
    } finally {
      // Closing waits for in-flight operations to drain; a failed job must not
      // keep the scope barrier occupied.
      await input.leases.quiesceAndClose(lease)
    }
  }

  return {
    async withMaintenanceLease(run) {
      return use({
        operatorId: input.operatorId,
        profileId: input.profileId,
        projectId: input.workspace.projectId,
        projectKind: 'workspace',
        sessionId: `maintenance:${input.workspace.projectId}`,
        root: input.workspace.root,
        generation: 1,
      }, run)
    },

    async withBackgroundLease(binding, run) {
      if (!nonEmpty(binding?.operatorId) || !nonEmpty(binding.profileId) ||
        !nonEmpty(binding.projectId) || !nonEmpty(binding.sessionId)) {
        throw new MemoryLeaseError('invalid-binding')
      }
      // A background job never borrows the operator identity of the live turn:
      // it runs as the operator its own binding names.
      if (binding.operatorId !== input.operatorId || binding.profileId !== input.profileId) {
        throw new MemoryLeaseError('invalid-binding')
      }
      const root = input.rootFor(binding)
      if (!nonEmpty(root)) throw new MemoryLeaseError('invalid-binding')
      const projectKind: WorkContextKind = binding.scope === 'workspace' ? 'workspace' : 'project'
      return use({
        operatorId: binding.operatorId,
        profileId: binding.profileId,
        projectId: binding.projectId,
        projectKind,
        sessionId: binding.sessionId,
        root,
        generation: 1,
      }, run)
    },
  }
}

import type { TurnContextLease } from './context-lease.js'

export type WorkBindingScope = 'workspace' | 'project' | 'session'

/**
 * Durable identity of work that may outlive the interactive turn that created
 * it. Selection generation is deliberately not persisted: it is a monotonic
 * lease epoch, while project/session identity is the durable routing key.
 */
export interface WorkBinding {
  /**
   * Which bot of this installation owns the work (ADR-0076). Absent means the
   * first bot: existing durable records predate multi-bot and belong to it.
   */
  readonly botId?: string
  readonly operatorId: string
  readonly profileId: string
  readonly projectId: string
  readonly sessionId?: string
  readonly scope: WorkBindingScope
}

export interface ResolvedWorkBinding extends WorkBinding {
  readonly sessionId: string
}

export class WorkBindingError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_BINDING'
      | 'UNRESOLVED_BINDING'
      | 'SCOPE_MISMATCH'
      | 'PROJECT_NOT_FOUND'
      | 'PROJECT_ARCHIVED'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_ARCHIVED'
      | 'LEASE_BINDING_MISMATCH',
  ) {
    super(code)
    this.name = 'WorkBindingError'
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseWorkBinding(value: unknown): WorkBinding {
  if (typeof value !== 'object' || value === null) {
    throw new WorkBindingError('INVALID_BINDING')
  }
  const input = value as Record<string, unknown>
  if (!nonEmpty(input['operatorId']) || !nonEmpty(input['profileId']) ||
    !nonEmpty(input['projectId']) ||
    (input['scope'] !== 'workspace' && input['scope'] !== 'project' &&
      input['scope'] !== 'session') ||
    (input['sessionId'] !== undefined && !nonEmpty(input['sessionId']))) {
    throw new WorkBindingError('INVALID_BINDING')
  }
  return {
    operatorId: input['operatorId'].trim(),
    profileId: input['profileId'].trim(),
    projectId: input['projectId'].trim(),
    ...(input['sessionId'] === undefined ? {} : { sessionId: input['sessionId'].trim() }),
    scope: input['scope'],
  }
}

export function resolvedWorkBinding(value: unknown): ResolvedWorkBinding {
  const binding = parseWorkBinding(value)
  if (binding.sessionId === undefined) throw new WorkBindingError('UNRESOLVED_BINDING')
  return { ...binding, sessionId: binding.sessionId }
}

export function workBindingFromLease(
  lease: TurnContextLease,
  scope: WorkBindingScope,
  sessionId = lease.sessionId,
): ResolvedWorkBinding {
  if ((scope === 'workspace' && lease.projectKind !== 'workspace') ||
    (scope === 'project' && lease.projectKind !== 'project')) {
    throw new WorkBindingError('SCOPE_MISMATCH')
  }
  return resolvedWorkBinding({
    operatorId: lease.operatorId,
    profileId: lease.profileId,
    projectId: lease.projectId,
    sessionId,
    scope,
  })
}

export function assertLeaseMatchesBinding(
  lease: TurnContextLease,
  rawBinding: unknown,
): ResolvedWorkBinding {
  const binding = resolvedWorkBinding(rawBinding)
  if (lease.operatorId !== binding.operatorId || lease.profileId !== binding.profileId ||
    lease.projectId !== binding.projectId || lease.sessionId !== binding.sessionId ||
    (binding.scope === 'workspace' && lease.projectKind !== 'workspace') ||
    (binding.scope === 'project' && lease.projectKind !== 'project')) {
    throw new WorkBindingError('LEASE_BINDING_MISMATCH')
  }
  return binding
}

import type {
  ProjectRegistryV2,
  ProjectRegistryV2Owner,
} from './project-registry-v2-lifecycle.js'
import type {
  ProjectOrigin,
  ProjectRecordV2,
  ProjectSelectionV2,
} from './project-registry-v2.js'
import { ProjectRegistryV2Error } from './project-registry-v2.js'
import type { ProjectSessionRecord } from './project-registry.js'
import type {
  ContextLeaseCoordinator,
  TurnContextLease,
} from './context-lease.js'
import type {
  SwitchAuthority,
  SwitchAuthorityBinding,
  SwitchAuthorityReceipt,
} from './switch-authority.js'
import type {
  SessionRotationAuthority,
  SessionRotationAuthorityReceipt,
} from './session-rotation-authority.js'
import {
  assertLeaseMatchesBinding,
  parseWorkBinding,
  resolvedWorkBinding,
  workBindingFromLease,
  WorkBindingError,
  type ResolvedWorkBinding,
  type WorkBinding,
  type WorkBindingScope,
} from './work-binding.js'

export interface ProjectServiceEvent {
  kind:
    | 'project.switched'
    | 'project.created'
    | 'project.archived'
    | 'project.restored'
    | 'session.created'
    | 'session.renamed'
    | 'session.archived'
    | 'session.restored'
    | 'session.rotated'
    | 'job.binding_created'
    | 'job.binding_resolved'
    | 'job.paused_context_archived'
    | 'project.maintenance_lease_acquired'
    | 'project.maintenance_lease_released'
  projectId: string
  sessionId?: string
  generation: number
  scope?: WorkBindingScope
}

export interface ProjectServiceSwitchResult {
  selection: ProjectSelectionV2
  lease: TurnContextLease
  nonceAudit: 'consumed'
}

export interface ProjectServiceContextResult {
  selection: ProjectSelectionV2
  lease: TurnContextLease
}

export interface ProjectServiceRotationResult extends ProjectServiceContextResult {
  session: ProjectSessionRecord
  nonceAudit: 'consumed'
}

export type ProjectLifecycleAction = 'project.archive' | 'session.archive'

export interface ProjectLifecycleAuthorityBinding extends ProjectRegistryV2Owner {
  action: ProjectLifecycleAction
  projectId: string
  sessionId?: string
  expectedGeneration: number
  sourceMessageHash: string
}

export interface ProjectLifecycleAuthorityReceipt extends ProjectLifecycleAuthorityBinding {
  readonly purpose: 'aisy-project-lifecycle-v1'
  readonly receiptId: string
  readonly expiresAt: string
  readonly mac: string
}

export interface ProjectLifecycleAuthority {
  consume(
    receipt: ProjectLifecycleAuthorityReceipt,
    expected: ProjectLifecycleAuthorityBinding,
  ): void
}

export interface ProjectServiceLifecycleDeps {
  authority: ProjectLifecycleAuthority
  validateRestorableRoot(project: Readonly<ProjectRecordV2>): Promise<void> | void
}

export interface ProjectServiceArchiveResult<
  T extends ProjectRecordV2 | ProjectSessionRecord,
> {
  record: T
  selection: ProjectSelectionV2
  replacementLease?: TurnContextLease
  authorityAudit: 'consumed'
}

export interface ProjectService {
  listContexts(owner: ProjectRegistryV2Owner, includeArchived?: boolean): ProjectRecordV2[]
  acquireTurnContext(owner: ProjectRegistryV2Owner): TurnContextLease
  captureWorkBinding(
    lease: TurnContextLease,
    scope: WorkBindingScope,
  ): ResolvedWorkBinding
  acquireBoundContext(binding: WorkBinding): TurnContextLease
  /** Exclusive lease for Workspace-owned integrity work over one exact Project. */
  acquireMaintenanceContext(binding: WorkBinding): Promise<TurnContextLease>
  assertBoundContext(lease: TurnContextLease, binding: WorkBinding): void
  /** Synchronous lifecycle probe used by approval grants before tool I/O. */
  isBindingActive(binding: WorkBinding): boolean
  releaseTurnContext(lease: TurnContextLease): Promise<void>
  releaseMaintenanceContext(lease: TurnContextLease): Promise<void>
  publishPreparedProject(input: ProjectRegistryV2Owner & {
    name: string
    slug?: string
    root: string
    origin: Exclude<ProjectOrigin, 'workspace' | 'legacy'>
  }): Promise<ProjectServiceContextResult>
  switchContext(input: ProjectRegistryV2Owner & {
    targetProjectId: string
    targetSessionId?: string
    receipt: SwitchAuthorityReceipt
    sourceMessageHash: string
  }): Promise<ProjectServiceSwitchResult>
  rotateSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sourceSessionId: string
    newSessionId: string
    expectedGeneration: number
    localDate: string
    createKeyHash: string
    name?: string
    receipt: SessionRotationAuthorityReceipt
  }): Promise<ProjectServiceRotationResult>
  archiveProject(input: ProjectRegistryV2Owner & {
    projectId: string
    receipt: ProjectLifecycleAuthorityReceipt
    sourceMessageHash: string
  }): Promise<ProjectServiceArchiveResult<ProjectRecordV2>>
  restoreProject(input: ProjectRegistryV2Owner & {
    projectId: string
  }): Promise<ProjectRecordV2>
  createSession(input: ProjectRegistryV2Owner & {
    projectId: string
    name?: string
    expectedGeneration?: number
  }): ProjectSessionRecord
  renameSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
    name: string
    expectedGeneration?: number
  }): ProjectSessionRecord
  searchSessions(input: ProjectRegistryV2Owner & {
    projectId: string
    query: string
    includeArchived?: boolean
  }): ProjectSessionRecord[]
  archiveSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
    receipt: ProjectLifecycleAuthorityReceipt
    sourceMessageHash: string
  }): Promise<ProjectServiceArchiveResult<ProjectSessionRecord>>
  restoreSession(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
  }): Promise<ProjectSessionRecord>
}

export class ProjectServiceError extends Error {
  constructor(
    public readonly code:
      | 'ACTIVE_CONTEXT_NOT_FOUND'
      | 'TARGET_CONTEXT_NOT_FOUND'
      | 'PROJECT_LIFECYCLE_DISABLED'
      | 'CONTEXT_TRANSITION_IN_PROGRESS'
      | 'MAINTENANCE_LEASE_INVALID'
      | 'RESTORE_ROOT_INVALID',
  ) {
    super(code)
    this.name = 'ProjectServiceError'
  }
}

function ownerKey(owner: ProjectRegistryV2Owner): string {
  return `${owner.operatorId}\u0000${owner.profileId}`
}

export function makeProjectService(deps: {
  registry: ProjectRegistryV2
  leases: ContextLeaseCoordinator
  authority: SwitchAuthority
  rotationAuthority?: SessionRotationAuthority
  lifecycle?: ProjectServiceLifecycleDeps
  beforeArchive?: (event: ProjectServiceEvent) => void | Promise<void>
  emit?: (event: ProjectServiceEvent) => void
}): ProjectService {
  type LeaseRole = 'interactive' | 'background' | 'maintenance'
  type TrackedLease = { lease: TurnContextLease; role: LeaseRole }
  interface TransitionBarrier {
    blockInteractive: boolean
    projectId?: string
    sessionId?: string
  }
  const activeLeases = new Map<string, Map<string, TrackedLease>>()
  const transitions = new Map<string, TransitionBarrier>()
  const maintenanceTransitions = new Map<string, () => void>()

  const beginTransition = (
    owner: ProjectRegistryV2Owner,
    barrier: TransitionBarrier,
  ): (() => void) => {
    const key = ownerKey(owner)
    if (transitions.has(key)) {
      throw new ProjectServiceError('CONTEXT_TRANSITION_IN_PROGRESS')
    }
    transitions.set(key, Object.freeze({ ...barrier }))
    let released = false
    return () => {
      if (released) return
      released = true
      transitions.delete(key)
    }
  }

  const assertAcquisitionAllowed = (
    owner: ProjectRegistryV2Owner,
    role: LeaseRole,
    projectId?: string,
    sessionId?: string,
  ): void => {
    const barrier = transitions.get(ownerKey(owner))
    if (barrier === undefined) return
    if (role === 'interactive' && barrier.blockInteractive &&
      (barrier.projectId === undefined || barrier.projectId === projectId) &&
      (barrier.sessionId === undefined || barrier.sessionId === sessionId)) {
      throw new ProjectServiceError('CONTEXT_TRANSITION_IN_PROGRESS')
    }
    if (role === 'background' && barrier.projectId === projectId &&
      (barrier.sessionId === undefined || barrier.sessionId === sessionId)) {
      throw new ProjectServiceError('CONTEXT_TRANSITION_IN_PROGRESS')
    }
  }

  const track = (
    lease: TurnContextLease,
    role: LeaseRole,
  ): TurnContextLease => {
    const key = ownerKey(lease)
    const leases = activeLeases.get(key) ?? new Map<string, TrackedLease>()
    leases.set(lease.leaseId, { lease, role })
    activeLeases.set(key, leases)
    return lease
  }

  const untrack = (lease: TurnContextLease): void => {
    const key = ownerKey(lease)
    const leases = activeLeases.get(key)
    leases?.delete(lease.leaseId)
    if (leases?.size === 0) activeLeases.delete(key)
  }

  const acquire = (
    owner: ProjectRegistryV2Owner,
    enforceBarrier = false,
  ): TurnContextLease => {
    const selection = deps.registry.getActive(owner)
    if (enforceBarrier) {
      assertAcquisitionAllowed(owner, 'interactive', selection.projectId, selection.sessionId)
    }
    const context = deps.registry.listContexts(owner).find((item) => item.id === selection.projectId)
    if (!context) throw new ProjectServiceError('ACTIVE_CONTEXT_NOT_FOUND')
    return track(deps.leases.acquire({
      operatorId: selection.operatorId,
      profileId: selection.profileId,
      projectId: selection.projectId,
      projectKind: context.kind,
      sessionId: selection.sessionId,
      root: context.root,
      generation: selection.generation,
    }), 'interactive')
  }
  const closeLeases = async (
    owner: ProjectRegistryV2Owner,
    predicate: (tracked: TrackedLease) => boolean,
  ): Promise<void> => {
    const key = ownerKey(owner)
    const leases = [...(activeLeases.get(key)?.values() ?? [])]
      .filter(predicate)
    await Promise.all(leases.map(async ({ lease }) => {
      await deps.leases.quiesceAndClose(lease)
      untrack(lease)
    }))
  }
  const closeOwnerLeases = async (
    owner: ProjectRegistryV2Owner,
    role?: LeaseRole,
  ): Promise<void> => closeLeases(
    owner,
    (item) => role === undefined || item.role === role,
  )

  const lifecycle = (): ProjectServiceLifecycleDeps => {
    if (deps.lifecycle === undefined) {
      throw new ProjectServiceError('PROJECT_LIFECYCLE_DISABLED')
    }
    return deps.lifecycle
  }

  const resolveBinding = (rawBinding: WorkBinding): {
    binding: ResolvedWorkBinding
    context: ProjectRecordV2
    generation: number
  } => {
    const binding = resolvedWorkBinding(rawBinding)
    const owner = { operatorId: binding.operatorId, profileId: binding.profileId }
    const context = deps.registry.listContexts(owner, true)
      .find((item) => item.id === binding.projectId)
    if (!context) throw new WorkBindingError('PROJECT_NOT_FOUND')
    if (context.archivedAt !== undefined) {
      deps.emit?.({
        kind: 'job.paused_context_archived',
        projectId: context.id,
        sessionId: binding.sessionId,
        generation: deps.registry.getActive(owner).generation,
        scope: binding.scope,
      })
      throw new WorkBindingError('PROJECT_ARCHIVED')
    }
    if ((binding.scope === 'workspace' && context.kind !== 'workspace') ||
      (binding.scope === 'project' && context.kind !== 'project')) {
      throw new WorkBindingError('SCOPE_MISMATCH')
    }
    try {
      deps.registry.getSession({ ...owner, projectId: context.id, sessionId: binding.sessionId })
    } catch (error) {
      if (error instanceof ProjectRegistryV2Error) {
        if (error.code === 'SESSION_ARCHIVED') {
          deps.emit?.({
            kind: 'job.paused_context_archived',
            projectId: context.id,
            sessionId: binding.sessionId,
            generation: deps.registry.getActive(owner).generation,
            scope: binding.scope,
          })
          throw new WorkBindingError('SESSION_ARCHIVED')
        }
        if (error.code === 'SESSION_NOT_FOUND' || error.code === 'SESSION_PROJECT_MISMATCH') {
          throw new WorkBindingError('SESSION_NOT_FOUND')
        }
      }
      throw error
    }
    return { binding, context, generation: deps.registry.getActive(owner).generation }
  }

  const release = async (lease: TurnContextLease): Promise<void> => {
    await deps.leases.quiesceAndClose(lease)
    untrack(lease)
    const endTransition = maintenanceTransitions.get(lease.leaseId)
    if (endTransition === undefined) return
    maintenanceTransitions.delete(lease.leaseId)
    endTransition()
    deps.emit?.({
      kind: 'project.maintenance_lease_released',
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      generation: lease.generation,
      scope: 'project',
    })
  }

  return {
    listContexts(owner, includeArchived = false) {
      return deps.registry.listContexts(owner, includeArchived)
    },

    acquireTurnContext(owner) {
      return acquire(owner, true)
    },

    captureWorkBinding(lease, scope) {
      const operation = deps.leases.reserveOperation(lease)
      operation.beginIo()
      try {
        const initial = workBindingFromLease(lease, scope)
        resolveBinding(initial)
        const sessionId = scope === 'session'
          ? lease.sessionId
          : deps.registry.createSession({
              operatorId: lease.operatorId,
              profileId: lease.profileId,
              projectId: lease.projectId,
              name: `Aisy system (${scope})`,
            }).id
        const binding = workBindingFromLease(lease, scope, sessionId)
        deps.emit?.({
          kind: 'job.binding_created',
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          generation: lease.generation,
          scope: binding.scope,
        })
        return binding
      } finally {
        operation.complete()
      }
    },

    acquireBoundContext(rawBinding) {
      const { binding, context, generation } = resolveBinding(rawBinding)
      assertAcquisitionAllowed(
        binding,
        'background',
        binding.projectId,
        binding.sessionId,
      )
      const lease = track(deps.leases.acquire({
        operatorId: binding.operatorId,
        profileId: binding.profileId,
        projectId: binding.projectId,
        projectKind: context.kind,
        sessionId: binding.sessionId,
        root: context.root,
        generation,
      }), 'background')
      deps.emit?.({
        kind: 'job.binding_resolved',
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        generation,
        scope: binding.scope,
      })
      return lease
    },

    async acquireMaintenanceContext(rawBinding) {
      const { binding, context, generation } = resolveBinding(rawBinding)
      if (binding.scope !== 'project' || context.kind !== 'project') {
        throw new WorkBindingError('SCOPE_MISMATCH')
      }
      const owner = { operatorId: binding.operatorId, profileId: binding.profileId }
      const endTransition = beginTransition(owner, {
        blockInteractive: true,
        projectId: binding.projectId,
      })
      try {
        await closeLeases(owner, ({ lease }) => lease.projectId === binding.projectId)
        const lease = track(deps.leases.acquire({
          operatorId: binding.operatorId,
          profileId: binding.profileId,
          projectId: binding.projectId,
          projectKind: context.kind,
          sessionId: binding.sessionId,
          root: context.root,
          generation,
        }), 'maintenance')
        maintenanceTransitions.set(lease.leaseId, endTransition)
        deps.emit?.({
          kind: 'project.maintenance_lease_acquired',
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          generation,
          scope: binding.scope,
        })
        return lease
      } catch (error) {
        endTransition()
        throw error
      }
    },

    assertBoundContext(lease, rawBinding) {
      const binding = assertLeaseMatchesBinding(lease, rawBinding)
      resolveBinding(binding)
      const validation = deps.leases.reserveOperation(lease)
      validation.complete()
    },

    isBindingActive(rawBinding) {
      try {
        const binding = parseWorkBinding(rawBinding)
        const owner = { operatorId: binding.operatorId, profileId: binding.profileId }
        const context = deps.registry.listContexts(owner, true)
          .find((item) => item.id === binding.projectId)
        if (!context || context.archivedAt !== undefined) return false
        if ((binding.scope === 'workspace' && context.kind !== 'workspace') ||
          (binding.scope === 'project' && context.kind !== 'project')) return false
        if (binding.scope !== 'session') return true
        if (binding.sessionId === undefined) return false
        deps.registry.getSession({
          ...owner,
          projectId: binding.projectId,
          sessionId: binding.sessionId,
        })
        return true
      } catch {
        return false
      }
    },

    async releaseTurnContext(lease) {
      await release(lease)
    },

    async releaseMaintenanceContext(lease) {
      if (!maintenanceTransitions.has(lease.leaseId)) {
        throw new ProjectServiceError('MAINTENANCE_LEASE_INVALID')
      }
      await release(lease)
    },

    async publishPreparedProject(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const current = deps.registry.getActive(owner)
      const endTransition = beginTransition(owner, { blockInteractive: true })
      try {
        await closeOwnerLeases(owner, 'interactive')
        let selection: ProjectSelectionV2
        try {
          selection = deps.registry.createProject({
            ...owner,
            name: input.name,
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            root: input.root,
            origin: input.origin,
            expectedGeneration: current.generation,
          })
        } catch (error) {
          acquire(owner)
          throw error
        }
        const lease = acquire(owner)
        deps.emit?.({
          kind: 'project.created',
          projectId: selection.projectId,
          sessionId: selection.sessionId,
          generation: selection.generation,
        })
        return { selection, lease }
      } finally {
        endTransition()
      }
    },

    async switchContext(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const current = deps.registry.getActive(owner)
      const expected: SwitchAuthorityBinding = {
        ...owner,
        targetProjectId: input.targetProjectId,
        ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
        expectedGeneration: current.generation,
        sourceMessageHash: input.sourceMessageHash,
      }
      deps.authority.validate(input.receipt, expected)
      if (!deps.registry.listContexts(owner).some((item) => item.id === input.targetProjectId)) {
        throw new ProjectServiceError('TARGET_CONTEXT_NOT_FOUND')
      }
      if (input.targetSessionId !== undefined) {
        deps.registry.getSession({
          ...owner,
          projectId: input.targetProjectId,
          sessionId: input.targetSessionId,
        })
      }

      const endTransition = beginTransition(owner, { blockInteractive: true })
      try {
        // Spend the durable one-use authority before cancelling work or changing
        // the registry. If nonce persistence fails, the old lease and selection
        // remain untouched. A crash after this boundary may require a new receipt,
        // but can never repeat the switch effect after restart.
        deps.authority.consume(input.receipt, expected)

        await closeOwnerLeases(owner, 'interactive')
        let selection: ProjectSelectionV2
        try {
          selection = deps.registry.switchContext({
            ...owner,
            projectId: input.targetProjectId,
            ...(input.targetSessionId === undefined ? {} : { sessionId: input.targetSessionId }),
            expectedGeneration: current.generation,
          })
        } catch (error) {
          // The old selection is still authoritative when compare-and-swap or
          // target validation fails. Give subsequent turns a fresh lease for it.
          acquire(owner)
          throw error
        }

        const lease = acquire(owner)
        deps.emit?.({
          kind: 'project.switched',
          projectId: selection.projectId,
          sessionId: selection.sessionId,
          generation: selection.generation,
        })
        return { selection, lease, nonceAudit: 'consumed' }
      } finally {
        endTransition()
      }
    },

    async rotateSession(input) {
      if (deps.rotationAuthority === undefined) {
        throw new ProjectServiceError('PROJECT_LIFECYCLE_DISABLED')
      }
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const endTransition = beginTransition(owner, { blockInteractive: true })
      try {
        const current = deps.registry.getActive(owner)
        if (current.projectId !== input.projectId ||
          current.sessionId !== input.sourceSessionId ||
          current.generation !== input.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        const expected = {
          ...owner,
          projectId: input.projectId,
          sourceSessionId: input.sourceSessionId,
          newSessionId: input.newSessionId,
          expectedGeneration: input.expectedGeneration,
          localDate: input.localDate,
          createKeyHash: input.createKeyHash,
        }
        deps.rotationAuthority.consume(input.receipt, expected)
        await closeOwnerLeases(owner, 'interactive')
        let session: ProjectSessionRecord
        try {
          session = deps.registry.createSession({
            ...owner,
            projectId: input.projectId,
            expectedGeneration: input.expectedGeneration,
            sessionId: input.newSessionId,
            createKeyHash: input.createKeyHash,
            ...(input.name === undefined ? {} : { name: input.name }),
          })
          const selection = deps.registry.switchContext({
            ...owner,
            projectId: input.projectId,
            sessionId: session.id,
            expectedGeneration: input.expectedGeneration,
          })
          const lease = acquire(owner)
          deps.emit?.({
            kind: 'session.rotated',
            projectId: selection.projectId,
            sessionId: selection.sessionId,
            generation: selection.generation,
          })
          return { selection, lease, session, nonceAudit: 'consumed' }
        } catch (error) {
          acquire(owner)
          throw error
        }
      } finally {
        endTransition()
      }
    },

    async archiveProject(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const lifecycleDeps = lifecycle()
      const target = deps.registry.listContexts(owner, true)
        .find((item) => item.id === input.projectId)
      if (target === undefined) throw new ProjectServiceError('TARGET_CONTEXT_NOT_FOUND')
      if (target.kind === 'workspace') throw new ProjectRegistryV2Error('WORKSPACE_IMMUTABLE')
      if (target.archivedAt !== undefined) throw new ProjectRegistryV2Error('PROJECT_ARCHIVED')
      const current = deps.registry.getActive(owner)
      const endTransition = beginTransition(owner, {
        blockInteractive: current.projectId === target.id,
        projectId: target.id,
      })
      try {
        lifecycleDeps.authority.consume(input.receipt, {
          ...owner,
          action: 'project.archive',
          projectId: target.id,
          expectedGeneration: current.generation,
          sourceMessageHash: input.sourceMessageHash,
        })

        await closeLeases(owner, ({ lease }) => lease.projectId === target.id)
        try {
          await deps.beforeArchive?.({
            kind: 'project.archived',
            projectId: target.id,
            generation: current.generation,
          })
        } catch (error) {
          if (deps.registry.getActive(owner).projectId === target.id) acquire(owner)
          throw error
        }
        let record: ProjectRecordV2
        try {
          record = deps.registry.archiveProject({
            ...owner,
            projectId: target.id,
            expectedGeneration: current.generation,
          })
        } catch (error) {
          if (deps.registry.getActive(owner).projectId === target.id) acquire(owner)
          throw error
        }
        const selection = deps.registry.getActive(owner)
        const replacementLease = current.projectId === target.id ? acquire(owner) : undefined
        deps.emit?.({
          kind: 'project.archived',
          projectId: target.id,
          generation: selection.generation,
        })
        return {
          record,
          selection,
          ...(replacementLease === undefined ? {} : { replacementLease }),
          authorityAudit: 'consumed',
        }
      } finally {
        endTransition()
      }
    },

    async restoreProject(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const lifecycleDeps = lifecycle()
      const target = deps.registry.listContexts(owner, true)
        .find((item) => item.id === input.projectId)
      if (target === undefined) throw new ProjectServiceError('TARGET_CONTEXT_NOT_FOUND')
      if (target.kind === 'workspace') throw new ProjectRegistryV2Error('WORKSPACE_IMMUTABLE')
      if (target.archivedAt === undefined) throw new ProjectRegistryV2Error('PROJECT_NOT_ARCHIVED')
      const endTransition = beginTransition(owner, { blockInteractive: false })
      try {
        try {
          await lifecycleDeps.validateRestorableRoot(Object.freeze({ ...target }))
        } catch {
          throw new ProjectServiceError('RESTORE_ROOT_INVALID')
        }
        const record = deps.registry.restoreProject({ ...owner, projectId: target.id })
        deps.emit?.({
          kind: 'project.restored',
          projectId: target.id,
          generation: deps.registry.getActive(owner).generation,
        })
        return record
      } finally {
        endTransition()
      }
    },

    createSession(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const endTransition = beginTransition(owner, { blockInteractive: false })
      try {
        const record = deps.registry.createSession({
          ...owner,
          projectId: input.projectId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: input.expectedGeneration }),
        })
        deps.emit?.({
          kind: 'session.created',
          projectId: input.projectId,
          sessionId: record.id,
          generation: deps.registry.getActive(owner).generation,
        })
        return record
      } finally {
        endTransition()
      }
    },

    renameSession(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const endTransition = beginTransition(owner, { blockInteractive: false })
      try {
        const record = deps.registry.renameSession({
          ...owner,
          projectId: input.projectId,
          sessionId: input.sessionId,
          name: input.name,
          ...(input.expectedGeneration === undefined
            ? {}
            : { expectedGeneration: input.expectedGeneration }),
        })
        deps.emit?.({
          kind: 'session.renamed',
          projectId: input.projectId,
          sessionId: input.sessionId,
          generation: deps.registry.getActive(owner).generation,
        })
        return record
      } finally {
        endTransition()
      }
    },

    searchSessions(input) {
      return deps.registry.searchSessions(input)
    },

    async archiveSession(input) {
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const lifecycleDeps = lifecycle()
      deps.registry.getSession({
        ...owner,
        projectId: input.projectId,
        sessionId: input.sessionId,
      })
      const current = deps.registry.getActive(owner)
      const endTransition = beginTransition(owner, {
        blockInteractive: current.projectId === input.projectId &&
          current.sessionId === input.sessionId,
        projectId: input.projectId,
        sessionId: input.sessionId,
      })
      try {
        lifecycleDeps.authority.consume(input.receipt, {
          ...owner,
          action: 'session.archive',
          projectId: input.projectId,
          sessionId: input.sessionId,
          expectedGeneration: current.generation,
          sourceMessageHash: input.sourceMessageHash,
        })


        await closeLeases(
          owner,
          ({ lease }) => lease.projectId === input.projectId &&
            lease.sessionId === input.sessionId,
        )
        try {
          await deps.beforeArchive?.({
            kind: 'session.archived',
            projectId: input.projectId,
            sessionId: input.sessionId,
            generation: current.generation,
          })
        } catch (error) {
          const selected = deps.registry.getActive(owner)
          if (selected.projectId === input.projectId && selected.sessionId === input.sessionId) {
            acquire(owner)
          }
          throw error
        }
        let record: ProjectSessionRecord
        try {
          record = deps.registry.archiveSession({
            ...owner,
            projectId: input.projectId,
            sessionId: input.sessionId,
            expectedGeneration: current.generation,
          })
        } catch (error) {
          const selected = deps.registry.getActive(owner)
          if (selected.projectId === input.projectId && selected.sessionId === input.sessionId) {
            acquire(owner)
          }
          throw error
        }
        const selection = deps.registry.getActive(owner)
        const replacedActive = current.projectId === input.projectId &&
          current.sessionId === input.sessionId
        const replacementLease = replacedActive ? acquire(owner) : undefined
        deps.emit?.({
          kind: 'session.archived',
          projectId: input.projectId,
          sessionId: input.sessionId,
          generation: selection.generation,
        })
        return {
          record,
          selection,
          ...(replacementLease === undefined ? {} : { replacementLease }),
          authorityAudit: 'consumed',
        }
      } finally {
        endTransition()
      }
    },

    async restoreSession(input) {
      lifecycle()
      const owner = { operatorId: input.operatorId, profileId: input.profileId }
      const endTransition = beginTransition(owner, { blockInteractive: false })
      try {
        const record = deps.registry.restoreSession({
          ...owner,
          projectId: input.projectId,
          sessionId: input.sessionId,
        })
        deps.emit?.({
          kind: 'session.restored',
          projectId: input.projectId,
          sessionId: input.sessionId,
          generation: deps.registry.getActive(owner).generation,
        })
        return record
      } finally {
        endTransition()
      }
    },
  }
}

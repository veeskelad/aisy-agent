import { describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  type ProjectRegistryStateV2,
} from './project-registry-v2.js'
import { makeProjectRegistryV2 } from './project-registry-v2-lifecycle.js'
import { makeContextLeaseCoordinator } from './context-lease.js'
import { makeGrantStore } from '../safety/grants.js'
import {
  makeSwitchAuthority,
  type SwitchAuthorityNonceRecord,
} from './switch-authority.js'
import {
  makeProjectService,
  type ProjectLifecycleAction,
  type ProjectLifecycleAuthorityBinding,
  type ProjectLifecycleAuthorityReceipt,
  type ProjectServiceEvent,
} from './project-service.js'

const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const SOURCE_HASH = 'a'.repeat(64)

function setup(options: {
  failNonceConsume?: boolean
  failRestoreRoot?: boolean
} = {}) {
  let id = 0
  let failSave = false
  let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `registry-${++id}`,
    policy: POLICY,
  })
  const registry = makeProjectRegistryV2({
    state: durable,
    policy: POLICY,
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `registry-${++id}`,
    persistence: {
      saveAtomic: (state) => {
        if (failSave) {
          failSave = false
          throw new Error('injected registry persistence failure')
        }
        durable = state
      },
    },
  })
  const project = registry.createProject({
    ...OWNER,
    name: 'Project B',
    slug: 'project-b',
    root: '/Users/operator/projects/project-b',
    origin: 'created',
  })
  const workspace = registry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
  registry.switchContext({
    ...OWNER,
    projectId: workspace.id,
    expectedGeneration: project.generation,
  })

  let leaseId = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
  const nonceState = new Map<string, SwitchAuthorityNonceRecord>()
  const authority = makeSwitchAuthority({
    secret: Buffer.alloc(32, 9),
    nowMs: () => Date.parse('2026-07-26T21:00:00.000Z'),
    newId: () => 'receipt-1',
    nonces: {
      issue: (record) => { nonceState.set(record.receiptId, record) },
      has: (receiptId, mac) => nonceState.get(receiptId)?.mac === mac,
      consume: (receiptId, mac) => {
        if (options.failNonceConsume) return false
        if (nonceState.get(receiptId)?.mac !== mac) return false
        nonceState.delete(receiptId)
        return true
      },
    },
  })
  const events: ProjectServiceEvent[] = []
  const lifecycleReceipts = new Map<string, ProjectLifecycleAuthorityBinding>()
  const rootChecks: string[] = []
  let lifecycleId = 0
  const lifecycleAuthority = {
    consume(
      receipt: ProjectLifecycleAuthorityReceipt,
      expected: ProjectLifecycleAuthorityBinding,
    ) {
      const issued = lifecycleReceipts.get(receipt.receiptId)
      if (issued === undefined || JSON.stringify(issued) !== JSON.stringify(expected)) {
        throw new Error('LIFECYCLE_RECEIPT_DENIED')
      }
      lifecycleReceipts.delete(receipt.receiptId)
    },
  }
  const service = makeProjectService({
    registry,
    leases,
    authority,
    lifecycle: {
      authority: lifecycleAuthority,
      validateRestorableRoot: (project) => {
        rootChecks.push(project.root)
        if (options.failRestoreRoot) throw new Error('private root detail')
      },
    },
    emit: (event) => events.push(event),
  })
  const target = registry.listContexts(OWNER).find((item) => item.id === project.projectId)!
  const current = registry.getActive(OWNER)
  const receipt = authority.issue({
    ...OWNER,
    targetProjectId: target.id,
    expectedGeneration: current.generation,
    sourceMessageHash: SOURCE_HASH,
  }, 30_000)
  const issueLifecycle = (
    action: ProjectLifecycleAction,
    projectId: string,
    sessionId?: string,
  ): ProjectLifecycleAuthorityReceipt => {
    const binding: ProjectLifecycleAuthorityBinding = {
      ...OWNER,
      action,
      projectId,
      ...(sessionId === undefined ? {} : { sessionId }),
      expectedGeneration: registry.getActive(OWNER).generation,
      sourceMessageHash: SOURCE_HASH,
    }
    const receipt: ProjectLifecycleAuthorityReceipt = {
      purpose: 'aisy-project-lifecycle-v1',
      receiptId: `lifecycle-${++lifecycleId}`,
      ...binding,
      expiresAt: '2026-07-28T12:00:30.000Z',
      mac: 'f'.repeat(64),
    }
    lifecycleReceipts.set(receipt.receiptId, binding)
    return receipt
  }
  return {
    authority,
    durable: () => durable,
    events,
    failNextSave: () => { failSave = true },
    issueLifecycle,
    leases,
    lifecycleAuthority,
    lifecycleReceipts,
    nonceState,
    receipt,
    registry,
    rootChecks,
    service,
    target,
  }
}

describe('ProjectService switch barrier', () => {
  it('acquires a lease from the exact persisted context selection', () => {
    const { registry, service } = setup()

    const lease = service.acquireTurnContext(OWNER)
    const active = registry.getActive(OWNER)

    expect(lease).toMatchObject({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      generation: active.generation,
      projectKind: 'workspace',
      root: '/Users/operator/workspace',
    })
  })

  it('publishes a prepared project only after draining old I/O and returns its exact lease', async () => {
    const { leases, registry, service } = setup()
    const oldLease = service.acquireTurnContext(OWNER)
    const operation = leases.reserveOperation(oldLease)
    operation.beginIo()
    let completed = false
    const publishing = service.publishPreparedProject({
      ...OWNER,
      name: 'Project C',
      slug: 'project-c',
      root: '/Users/operator/projects/project-c',
      origin: 'created',
    }).then((result) => { completed = true; return result })

    await Promise.resolve()
    expect(completed).toBe(false)
    expect(leases.status(oldLease)).toBe('cancelling')
    expect(() => service.acquireTurnContext(OWNER)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    operation.complete()
    const result = await publishing

    expect(result.selection).toMatchObject({ projectId: result.lease.projectId, generation: 4 })
    expect(result.lease).toMatchObject({
      projectKind: 'project',
      root: '/Users/operator/projects/project-c',
      sessionId: result.selection.sessionId,
      generation: result.selection.generation,
    })
    expect(registry.getActive(OWNER)).toEqual(result.selection)
    expect(leases.status(oldLease)).toBe('closed')
  })

  it('restores an old-context lease when prepared project publication fails', async () => {
    const { leases, registry, service } = setup()
    const oldLease = service.acquireTurnContext(OWNER)
    const before = registry.getActive(OWNER)

    await expect(service.publishPreparedProject({
      ...OWNER,
      name: 'Unsafe',
      slug: '../unsafe',
      root: '/Users/operator/projects/unsafe',
      origin: 'created',
    })).rejects.toBeTruthy()

    expect(registry.getActive(OWNER)).toEqual(before)
    expect(leases.status(oldLease)).toBe('closed')
    expect(service.acquireTurnContext(OWNER)).toMatchObject({
      projectId: before.projectId,
      sessionId: before.sessionId,
      generation: before.generation,
    })
  })

  it('waits for old atomic I/O, persists generation+1, consumes receipt and returns a new lease', async () => {
    const { leases, nonceState, receipt, registry, service, target } = setup()
    const oldLease = service.acquireTurnContext(OWNER)
    const operation = leases.reserveOperation(oldLease)
    operation.beginIo()
    let completed = false
    const switching = service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    }).then((result) => { completed = true; return result })

    await Promise.resolve()
    expect(completed).toBe(false)
    expect(leases.status(oldLease)).toBe('cancelling')
    expect(() => service.acquireTurnContext(OWNER)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    operation.complete()
    const result = await switching

    expect(result.selection).toMatchObject({ projectId: target.id, generation: 4 })
    expect(result.lease).toMatchObject({ projectId: target.id, generation: 4 })
    expect(result.nonceAudit).toBe('consumed')
    expect(registry.getActive(OWNER)).toEqual(result.selection)
    expect(nonceState.has(receipt.receiptId)).toBe(false)
    expect(leases.status(oldLease)).toBe('closed')
  })

  it('rejects replay without another registry mutation', async () => {
    const { receipt, registry, service, target } = setup()
    await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const generation = registry.getActive(OWNER).generation

    await expect(service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrowError(expect.objectContaining({ code: 'RECEIPT_BINDING_MISMATCH' }))
    expect(registry.getActive(OWNER).generation).toBe(generation)
  })

  it('does not quiesce or mutate when durable nonce consumption fails', async () => {
    const { events, leases, receipt, registry, service, target } = setup({ failNonceConsume: true })
    const activeLease = service.acquireTurnContext(OWNER)
    const before = registry.getActive(OWNER)

    await expect(service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))

    expect(registry.getActive(OWNER)).toEqual(before)
    expect(leases.status(activeLease)).toBe('active')
    expect(events).toEqual([])
  })

  it('rejects an unissued otherwise valid receipt before quiescing active leases', async () => {
    const { nonceState, receipt, leases, service, target } = setup()
    const activeLease = service.acquireTurnContext(OWNER)
    nonceState.clear()

    await expect(service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))
    expect(leases.status(activeLease)).toBe('active')
  })

  it('resolves the target session before quiescing the old lease', async () => {
    const { authority, leases, registry, service, target } = setup()
    const activeLease = service.acquireTurnContext(OWNER)
    const current = registry.getActive(OWNER)
    const receipt = authority.issue({
      ...OWNER,
      targetProjectId: target.id,
      targetSessionId: 'missing-session',
      expectedGeneration: current.generation,
      sourceMessageHash: SOURCE_HASH,
    }, 30_000)

    await expect(service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      targetSessionId: 'missing-session',
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }))
    expect(leases.status(activeLease)).toBe('active')
    expect(registry.getActive(OWNER)).toEqual(current)
  })

  it('allows only one concurrent switch mutation for the same generation', async () => {
    const { receipt, registry, service, target } = setup()
    const input = {
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    }

    const results = await Promise.allSettled([
      service.switchContext(input),
      service.switchContext(input),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(registry.getActive(OWNER)).toMatchObject({ projectId: target.id, generation: 4 })
  })

  it('captures project/workspace jobs into a separate persisted system session', async () => {
    const { registry, service } = setup()
    const interactive = service.acquireTurnContext(OWNER)

    const binding = service.captureWorkBinding(interactive, 'workspace')

    expect(binding).toMatchObject({
      ...OWNER,
      projectId: interactive.projectId,
      scope: 'workspace',
    })
    expect(binding.sessionId).not.toBe(interactive.sessionId)
    expect(registry.getSession({
      ...OWNER,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    }).name).toBe('Aisy system (workspace)')
    await service.releaseTurnContext(interactive)
  })

  it('does not redirect or cancel a background lease when interactive selection switches', async () => {
    const { leases, receipt, registry, service, target } = setup()
    const interactive = service.acquireTurnContext(OWNER)
    const binding = service.captureWorkBinding(interactive, 'workspace')
    const background = service.acquireBoundContext(binding)

    const switched = service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    await switched

    expect(registry.getActive(OWNER).projectId).toBe(target.id)
    expect(leases.status(interactive)).toBe('closed')
    expect(leases.status(background)).toBe('active')
    expect(background).toMatchObject({
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      projectKind: 'workspace',
    })
    expect(() => service.assertBoundContext(background, binding)).not.toThrow()
    await service.releaseTurnContext(background)
  })

  it('acquires an exclusive per-Project maintenance lease after draining exact Project work', async () => {
    const { events, leases, registry, service, target } = setup()
    const systemSession = registry.createSession({
      ...OWNER,
      projectId: target.id,
      name: 'Aisy system (project)',
    })
    const binding = {
      ...OWNER,
      projectId: target.id,
      sessionId: systemSession.id,
      scope: 'project' as const,
    }
    const background = service.acquireBoundContext(binding)
    const operation = leases.reserveOperation(background)
    operation.beginIo()
    let acquired = false
    const pending = service.acquireMaintenanceContext(binding)
      .then((lease) => { acquired = true; return lease })

    await Promise.resolve()
    expect(acquired).toBe(false)
    expect(leases.status(background)).toBe('cancelling')
    expect(() => service.acquireBoundContext(binding)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )

    const workspaceTurn = service.acquireTurnContext(OWNER)
    expect(workspaceTurn.projectKind).toBe('workspace')
    operation.complete()
    const maintenance = await pending
    expect(maintenance).toMatchObject({
      ...OWNER,
      projectId: target.id,
      projectKind: 'project',
      sessionId: systemSession.id,
      root: target.root,
    })
    expect(leases.status(background)).toBe('closed')
    expect(() => service.assertBoundContext(maintenance, binding)).not.toThrow()
    expect(() => service.acquireBoundContext(binding)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )

    await service.releaseMaintenanceContext(maintenance)
    const resumed = service.acquireBoundContext(binding)
    await service.releaseTurnContext(resumed)
    await service.releaseTurnContext(workspaceTurn)
    expect(events.filter((event) => event.kind.startsWith('project.maintenance_')))
      .toEqual([
        expect.objectContaining({
          kind: 'project.maintenance_lease_acquired',
          projectId: target.id,
          sessionId: systemSession.id,
          scope: 'project',
        }),
        expect.objectContaining({
          kind: 'project.maintenance_lease_released',
          projectId: target.id,
          sessionId: systemSession.id,
          scope: 'project',
        }),
      ])
  })

  it('rejects Workspace or forged release as maintenance authority', async () => {
    const { leases, service } = setup()
    const workspace = service.acquireTurnContext(OWNER)
    const binding = service.captureWorkBinding(workspace, 'workspace')

    await expect(service.acquireMaintenanceContext(binding)).rejects.toThrowError(
      expect.objectContaining({ code: 'SCOPE_MISMATCH' }),
    )
    await expect(service.releaseMaintenanceContext(workspace)).rejects.toThrowError(
      expect.objectContaining({ code: 'MAINTENANCE_LEASE_INVALID' }),
    )
    expect(leases.status(workspace)).toBe('active')
    await service.releaseTurnContext(workspace)
  })

  it('fails closed before lease acquisition for unresolved or archived bindings', async () => {
    const { registry, service } = setup()
    const interactive = service.acquireTurnContext(OWNER)
    const binding = service.captureWorkBinding(interactive, 'workspace')
    await service.releaseTurnContext(interactive)

    expect(() => service.acquireBoundContext({
      ...OWNER,
      projectId: binding.projectId,
      scope: 'workspace',
    })).toThrowError(expect.objectContaining({ code: 'UNRESOLVED_BINDING' }))

    registry.archiveSession({
      ...OWNER,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    })
    expect(() => service.acquireBoundContext(binding))
      .toThrowError(expect.objectContaining({ code: 'SESSION_ARCHIVED' }))
  })

  it('reports grant bindings inactive after project/session archive without consulting selection', () => {
    const { registry, service, target } = setup()
    const projectBinding = {
      ...OWNER,
      projectId: target.id,
      scope: 'project' as const,
    }
    const session = registry.createSession({ ...OWNER, projectId: target.id, name: 'Grant session' })
    const sessionBinding = { ...projectBinding, sessionId: session.id, scope: 'session' as const }
    const grants = makeGrantStore({ isBindingUsable: service.isBindingActive })
    grants.record('bash', 'always', projectBinding)

    expect(service.isBindingActive(projectBinding)).toBe(true)
    expect(grants.has('bash', projectBinding)).toBe(true)
    expect(service.isBindingActive(sessionBinding)).toBe(true)
    registry.archiveSession({ ...OWNER, projectId: target.id, sessionId: session.id })
    expect(service.isBindingActive(sessionBinding)).toBe(false)
    expect(service.isBindingActive(projectBinding)).toBe(true)
    registry.archiveProject({ ...OWNER, projectId: target.id })
    expect(service.isBindingActive(projectBinding)).toBe(false)
    expect(grants.has('bash', projectBinding)).toBe(false)
  })

  it('archives the active Project only after draining its lease and returns an exact Workspace lease', async () => {
    const {
      events,
      issueLifecycle,
      leases,
      receipt,
      registry,
      service,
      target,
    } = setup()
    const switched = await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const targetBinding = service.captureWorkBinding(switched.lease, 'project')
    const operation = leases.reserveOperation(switched.lease)
    operation.beginIo()
    let completed = false
    const archiving = service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    }).then((result) => { completed = true; return result })

    await Promise.resolve()
    expect(completed).toBe(false)
    expect(leases.status(switched.lease)).toBe('cancelling')
    expect(() => service.acquireTurnContext(OWNER)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    expect(() => service.acquireBoundContext(targetBinding)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    operation.complete()
    const result = await archiving

    expect(result.record.archivedAt).toBeDefined()
    expect(result.authorityAudit).toBe('consumed')
    expect(result.selection).toMatchObject({
      projectId: result.replacementLease?.projectId,
      sessionId: result.replacementLease?.sessionId,
      generation: switched.selection.generation + 1,
    })
    expect(result.replacementLease).toMatchObject({
      projectKind: 'workspace',
      generation: result.selection.generation,
    })
    expect(registry.getActive(OWNER)).toEqual(result.selection)
    expect(leases.status(switched.lease)).toBe('closed')
    expect(() => service.acquireBoundContext(targetBinding)).toThrowError(
      expect.objectContaining({ code: 'PROJECT_ARCHIVED' }),
    )
    expect(events.filter((event) => event.kind === 'project.archived').at(-1)).toEqual({
      kind: 'project.archived',
      projectId: target.id,
      generation: result.selection.generation,
    })
  })

  it('rejects missing, replayed or wrong-purpose lifecycle authority before lease effects', async () => {
    const {
      issueLifecycle,
      leases,
      receipt,
      registry,
      service,
      target,
    } = setup()
    const switched = await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const before = registry.snapshot()
    const wrongPurpose = issueLifecycle(
      'session.archive',
      target.id,
      switched.selection.sessionId,
    )

    await expect(service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: wrongPurpose,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrow('LIFECYCLE_RECEIPT_DENIED')
    await expect(service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: { receiptId: 'never-issued' } as never,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrow('LIFECYCLE_RECEIPT_DENIED')

    expect(registry.snapshot()).toEqual(before)
    expect(leases.status(switched.lease)).toBe('active')
  })

  it('serializes concurrent archive attempts before a second authority or registry mutation', async () => {
    const { issueLifecycle, receipt, registry, service, target } = setup()
    await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const lifecycleReceipt = issueLifecycle('project.archive', target.id)
    const input = {
      ...OWNER,
      projectId: target.id,
      receipt: lifecycleReceipt,
      sourceMessageHash: SOURCE_HASH,
    }

    const results = await Promise.allSettled([
      service.archiveProject(input),
      service.archiveProject(input),
    ])

    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    expect(registry.listContexts(OWNER, true).find((item) => item.id === target.id)?.archivedAt)
      .toBeDefined()
  })

  it('cancels only background leases bound to the archived Project', async () => {
    const { issueLifecycle, leases, receipt, service, target } = setup()
    const workspaceInteractive = service.acquireTurnContext(OWNER)
    const workspaceBinding = service.captureWorkBinding(workspaceInteractive, 'workspace')
    const workspaceBackground = service.acquireBoundContext(workspaceBinding)
    const switched = await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const projectBinding = service.captureWorkBinding(switched.lease, 'project')
    const projectBackground = service.acquireBoundContext(projectBinding)

    await service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    })

    expect(leases.status(projectBackground)).toBe('closed')
    expect(leases.status(workspaceBackground)).toBe('active')
    expect(() => service.assertBoundContext(projectBackground, projectBinding))
      .toThrowError(expect.objectContaining({ code: 'PROJECT_ARCHIVED' }))
    expect(() => service.assertBoundContext(workspaceBackground, workspaceBinding)).not.toThrow()
    await service.releaseTurnContext(workspaceBackground)
  })

  it('restores the authoritative selection after archive persistence failure', async () => {
    const {
      events,
      failNextSave,
      issueLifecycle,
      leases,
      receipt,
      registry,
      service,
      target,
    } = setup()
    const switched = await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    failNextSave()

    await expect(service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toThrow('injected registry persistence failure')

    expect(registry.getActive(OWNER)).toEqual(switched.selection)
    expect(registry.listContexts(OWNER).some((item) => item.id === target.id)).toBe(true)
    expect(leases.status(switched.lease)).toBe('closed')
    expect(service.acquireTurnContext(OWNER)).toMatchObject(switched.selection)
    expect(events.some((event) => event.kind === 'project.archived')).toBe(false)
  })

  it('archives and restores an inactive Project without changing selection', async () => {
    const { issueLifecycle, registry, rootChecks, service, target } = setup()
    const before = registry.getActive(OWNER)

    const archived = await service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    })
    expect(archived.replacementLease).toBeUndefined()
    expect(archived.selection).toEqual(before)

    const restored = await service.restoreProject({ ...OWNER, projectId: target.id })
    expect(restored.archivedAt).toBeUndefined()
    expect(rootChecks).toEqual([target.root])
    expect(registry.getActive(OWNER)).toEqual(before)
  })

  it('fails closed and redacts root validation errors before restore publication', async () => {
    const { issueLifecycle, registry, service, target } = setup({ failRestoreRoot: true })
    await service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    })

    await expect(service.restoreProject({ ...OWNER, projectId: target.id })).rejects.toMatchObject({
      code: 'RESTORE_ROOT_INVALID',
      message: 'RESTORE_ROOT_INVALID',
    })
    expect(registry.listContexts(OWNER, true).find((item) => item.id === target.id)?.archivedAt)
      .toBeDefined()
  })

  it('archives the active session behind a lease barrier, selects a replacement, and restores without selecting', async () => {
    const { events, issueLifecycle, leases, registry, service } = setup()
    const active = registry.getActive(OWNER)
    const replacement = registry.createSession({
      ...OWNER,
      projectId: active.projectId,
      name: 'Replacement',
    })
    const activeLease = service.acquireTurnContext(OWNER)
    const activeBinding = service.captureWorkBinding(activeLease, 'session')
    const operation = leases.reserveOperation(activeLease)
    operation.beginIo()
    let completed = false
    const archiving = service.archiveSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      receipt: issueLifecycle('session.archive', active.projectId, active.sessionId),
      sourceMessageHash: SOURCE_HASH,
    }).then((result) => { completed = true; return result })

    await Promise.resolve()
    expect(completed).toBe(false)
    expect(() => service.acquireTurnContext(OWNER)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    expect(() => service.acquireBoundContext(activeBinding)).toThrowError(
      expect.objectContaining({ code: 'CONTEXT_TRANSITION_IN_PROGRESS' }),
    )
    operation.complete()
    const archived = await archiving
    expect(archived.record.status).toBe('archived')
    expect(archived.selection).toMatchObject({
      projectId: active.projectId,
      sessionId: replacement.id,
      generation: active.generation + 1,
    })
    expect(archived.replacementLease).toMatchObject(archived.selection)
    expect(leases.status(activeLease)).toBe('closed')
    expect(() => service.acquireBoundContext(activeBinding)).toThrowError(
      expect.objectContaining({ code: 'SESSION_ARCHIVED' }),
    )

    const beforeRestore = registry.getActive(OWNER)
    const restored = await service.restoreSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
    })
    expect(restored.status).toBe('active')
    expect(registry.getActive(OWNER)).toEqual(beforeRestore)
    expect(events.filter((event) =>
      event.kind === 'session.archived' || event.kind === 'session.restored',
    ).map((event) => event.kind)).toEqual([
      'session.archived',
      'session.restored',
    ])
  })

  it('creates, renames, searches, archives and restores Sessions through one service surface', async () => {
    const { events, issueLifecycle, registry, service } = setup()
    const active = registry.getActive(OWNER)
    const generation = active.generation

    const created = service.createSession({
      ...OWNER,
      projectId: active.projectId,
      name: 'Исследование',
    })
    const renamed = service.renameSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: created.id,
      name: 'Исследование MCP',
    })
    expect(renamed.name).toBe('Исследование MCP')
    expect(service.searchSessions({
      ...OWNER,
      projectId: active.projectId,
      query: 'mcp',
    })).toEqual([renamed])

    await service.archiveSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: created.id,
      receipt: issueLifecycle('session.archive', active.projectId, created.id),
      sourceMessageHash: SOURCE_HASH,
    })
    expect(service.searchSessions({
      ...OWNER,
      projectId: active.projectId,
      query: 'mcp',
    })).toEqual([])
    expect(service.searchSessions({
      ...OWNER,
      projectId: active.projectId,
      query: 'mcp',
      includeArchived: true,
    })).toMatchObject([{ id: created.id, status: 'archived' }])

    await service.restoreSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: created.id,
    })
    expect(service.searchSessions({
      ...OWNER,
      projectId: active.projectId,
      query: 'mcp',
    })).toMatchObject([{ id: created.id, status: 'active' }])
    expect(registry.getActive(OWNER).generation).toBe(generation)
    expect(events.filter((event) => event.sessionId === created.id).map((event) => event.kind))
      .toEqual([
        'session.created',
        'session.renamed',
        'session.archived',
        'session.restored',
      ])
  })

  it('keeps lifecycle disabled by default before any lease or registry effect', async () => {
    const { authority, leases, registry, target } = setup()
    const disabled = makeProjectService({ registry, leases, authority })
    const activeLease = disabled.acquireTurnContext(OWNER)
    const before = registry.snapshot()

    await expect(disabled.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: { receiptId: 'unused' } as never,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toMatchObject({ code: 'PROJECT_LIFECYCLE_DISABLED' })
    expect(registry.snapshot()).toEqual(before)
    expect(leases.status(activeLease)).toBe('active')
  })

  it('restores exact archived selection and generation from durable state after restart', async () => {
    const {
      authority,
      durable,
      issueLifecycle,
      receipt,
      registry,
      service,
      target,
    } = setup()
    await service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const archived = await service.archiveProject({
      ...OWNER,
      projectId: target.id,
      receipt: issueLifecycle('project.archive', target.id),
      sourceMessageHash: SOURCE_HASH,
    })
    let restartedId = 0
    const restartedRegistry = makeProjectRegistryV2({
      state: durable(),
      policy: POLICY,
      nowIso: () => '2026-07-26T21:00:00.000Z',
      newId: () => `restarted-${++restartedId}`,
      persistence: { saveAtomic: () => undefined },
    })
    const restartedLeases = makeContextLeaseCoordinator({
      newId: () => `restarted-lease-${++restartedId}`,
    })
    const restarted = makeProjectService({
      registry: restartedRegistry,
      leases: restartedLeases,
      authority,
    })

    expect(restartedRegistry.getActive(OWNER)).toEqual(archived.selection)
    expect(restartedRegistry.listContexts(OWNER, true)
      .find((item) => item.id === target.id)?.archivedAt).toBeDefined()
    expect(restarted.acquireTurnContext(OWNER)).toMatchObject(archived.selection)
    expect(registry.getActive(OWNER)).toEqual(archived.selection)
  })
})

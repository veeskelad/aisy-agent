import { describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  ProjectRegistryV2Error,
  type ProjectRegistryStateV2,
} from './project-registry-v2.js'
import {
  makeProjectRegistryV2,
  type ProjectRegistryV2Event,
} from './project-registry-v2-lifecycle.js'

const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const OWNER = { operatorId: 'telegram:42', profileId: 'default' }

function setup(initial?: ProjectRegistryStateV2) {
  let id = 0
  let tick = 0
  let durable = initial ?? makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-07-26T20:00:00.000Z',
    newId: () => `bootstrap-${++id}`,
    policy: POLICY,
  })
  const events: ProjectRegistryV2Event[] = []
  let saves = 0
  let failSave = false
  const registry = makeProjectRegistryV2({
    state: durable,
    policy: POLICY,
    nowIso: () => `2026-07-26T20:00:${String(tick++).padStart(2, '0')}.000Z`,
    newId: () => `id-${++id}`,
    persistence: {
      saveAtomic: (state) => {
        if (failSave) throw new Error('injected save failure')
        saves++
        durable = state
      },
    },
    emit: (event) => events.push(event),
  })
  return {
    registry,
    events,
    durable: () => durable,
    saves: () => saves,
    failNextSave: () => { failSave = true },
  }
}

describe('ProjectRegistry v2 lifecycle', () => {
  it('creates a lifecycle Session once for the same durable key', () => {
    const { registry, events, saves } = setup()
    const active = registry.getActive(OWNER)
    const input = {
      ...OWNER,
      projectId: active.projectId,
      name: '28 августа 2026',
      expectedGeneration: active.generation,
      sessionId: 'daily-session-2026-08-28',
      createKeyHash: 'c'.repeat(64),
    }

    const first = registry.createSession(input)
    const savedAfterFirst = saves()
    const second = registry.createSession(input)

    expect(second).toEqual(first)
    expect(second.createKeyHash).toBe(input.createKeyHash)
    expect(saves()).toBe(savedAfterFirst + 1)
    expect(events.filter((event) => event.kind === 'session.created')).toHaveLength(1)
  })

  it('rejects a reused lifecycle key with another Session id', () => {
    const { registry } = setup()
    const active = registry.getActive(OWNER)
    registry.createSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: 'daily-session-a',
      createKeyHash: 'd'.repeat(64),
    })

    expect(() => registry.createSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: 'daily-session-b',
      createKeyHash: 'd'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'CORRUPT_STATE' }))
  })

  it('persists monotonic generation across switches and restart', () => {
    const first = setup()
    const selected = first.registry.createProject({
      ...OWNER,
      name: 'Product',
      slug: 'product',
      root: '/Users/operator/projects/product',
      origin: 'created',
    })
    expect(selected.generation).toBe(2)

    const restarted = setup(first.durable())
    const workspace = restarted.registry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
    const switched = restarted.registry.switchContext({
      ...OWNER,
      projectId: workspace.id,
      expectedGeneration: selected.generation,
    })

    expect(switched.generation).toBe(3)
    expect(restarted.registry.getActive(OWNER)).toEqual(switched)
  })

  it('WP-07: cannot archive Workspace', () => {
    const { registry } = setup()
    const workspace = registry.listContexts(OWNER)[0]!

    expect(() => registry.archiveProject({ ...OWNER, projectId: workspace.id })).toThrowError(
      expect.objectContaining({ code: 'WORKSPACE_IMMUTABLE' }),
    )
  })

  it('WP-07: archives the active Project and selects Workspace atomically', () => {
    const { registry, saves, events } = setup()
    const projectSelection = registry.createProject({
      ...OWNER,
      name: 'Product',
      slug: 'product',
      root: '/Users/operator/projects/product',
      origin: 'created',
    })
    const before = saves()

    const archived = registry.archiveProject({ ...OWNER, projectId: projectSelection.projectId })
    const active = registry.getActive(OWNER)!

    expect(archived.archivedAt).toBeDefined()
    expect(active.projectId).not.toBe(projectSelection.projectId)
    expect(registry.listContexts(OWNER).find((item) => item.id === active.projectId)?.kind).toBe('workspace')
    expect(active.generation).toBe(projectSelection.generation + 1)
    expect(saves() - before).toBe(1)
    expect(events.slice(-2).map((event) => event.kind)).toEqual([
      'project.archived',
      'context.selected',
    ])
  })

  it('rejects stale or repeated project archive without persistence or events', () => {
    const { registry, saves, events } = setup()
    const projectSelection = registry.createProject({
      ...OWNER,
      name: 'Product',
      slug: 'product',
      root: '/Users/operator/projects/product',
      origin: 'created',
    })
    const beforeStale = saves()

    expect(() => registry.archiveProject({
      ...OWNER,
      projectId: projectSelection.projectId,
      expectedGeneration: projectSelection.generation - 1,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(saves()).toBe(beforeStale)

    registry.archiveProject({
      ...OWNER,
      projectId: projectSelection.projectId,
      expectedGeneration: projectSelection.generation,
    })
    const afterArchive = saves()
    const eventCount = events.length
    expect(() => registry.archiveProject({
      ...OWNER,
      projectId: projectSelection.projectId,
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_ARCHIVED' }))
    expect(saves()).toBe(afterArchive)
    expect(events).toHaveLength(eventCount)
  })

  it('WP-07: archives the selected session and selects a replacement in one publication', () => {
    const { registry, saves } = setup()
    const active = registry.getActive(OWNER)!
    const replacement = registry.createSession({
      ...OWNER,
      projectId: active.projectId,
      name: 'Replacement',
    })
    const before = saves()

    registry.archiveSession({ ...OWNER, projectId: active.projectId, sessionId: active.sessionId })

    expect(registry.getActive(OWNER)).toMatchObject({
      projectId: active.projectId,
      sessionId: replacement.id,
      generation: active.generation + 1,
    })
    expect(saves() - before).toBe(1)
  })

  it('rejects stale session archive before mutation', () => {
    const { registry, saves } = setup()
    const active = registry.getActive(OWNER)
    const before = saves()

    expect(() => registry.archiveSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      expectedGeneration: active.generation + 1,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(registry.getSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
    }).status).toBe('active')
    expect(saves()).toBe(before)
  })

  it('rejects stale session create and rename before persistence', () => {
    const { registry, saves } = setup()
    const active = registry.getActive(OWNER)
    const before = saves()

    expect(() => registry.createSession({
      ...OWNER,
      projectId: active.projectId,
      name: 'Stale create',
      expectedGeneration: active.generation + 1,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(() => registry.renameSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
      name: 'Stale rename',
      expectedGeneration: active.generation + 1,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(saves()).toBe(before)
    expect(registry.getSession({
      ...OWNER,
      projectId: active.projectId,
      sessionId: active.sessionId,
    }).name).not.toBe('Stale rename')
  })

  it('WP-07: creates a replacement when the selected session is the only active one', () => {
    const { registry } = setup()
    const active = registry.getActive(OWNER)!

    registry.archiveSession({ ...OWNER, projectId: active.projectId, sessionId: active.sessionId })

    const next = registry.getActive(OWNER)!
    expect(next.sessionId).not.toBe(active.sessionId)
    expect(next.generation).toBe(2)
    expect(registry.searchSessions({
      ...OWNER,
      projectId: active.projectId,
      query: '',
      includeArchived: false,
    })).toHaveLength(1)
  })

  it('restore revalidates overlap and never selects the restored Project', () => {
    const { registry } = setup()
    const created = registry.createProject({
      ...OWNER,
      name: 'Product',
      root: '/Users/operator/code/product',
      origin: 'registered',
    })
    registry.archiveProject({ ...OWNER, projectId: created.projectId })
    const before = registry.getActive(OWNER)

    const restored = registry.restoreProject({ ...OWNER, projectId: created.projectId })

    expect(restored.archivedAt).toBeUndefined()
    expect(registry.getActive(OWNER)).toEqual(before)
  })

  it('does not mutate memory or emit lifecycle events when atomic persistence fails', () => {
    const { registry, events, failNextSave } = setup()
    const before = registry.snapshot()
    failNextSave()

    expect(() => registry.createProject({
      ...OWNER,
      name: 'Product',
      slug: 'product',
      root: '/Users/operator/projects/product',
      origin: 'created',
    })).toThrow('injected save failure')
    expect(registry.snapshot()).toEqual(before)
    expect(events).toEqual([])
  })

  it('rejects foreign-owner lifecycle access', () => {
    const { registry } = setup()
    const workspace = registry.listContexts(OWNER)[0]!

    expect(() => registry.switchContext({
      operatorId: 'telegram:99',
      profileId: 'default',
      projectId: workspace.id,
      expectedGeneration: 1,
    })).toThrow(ProjectRegistryV2Error)
    expect(() => registry.searchSessions({
      operatorId: 'telegram:99',
      profileId: 'default',
      projectId: workspace.id,
      query: '',
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }))
  })

  it('rejects stale generation before selection persistence', () => {
    const { registry, saves } = setup()
    const workspace = registry.listContexts(OWNER)[0]!
    const before = saves()

    expect(() => registry.switchContext({
      ...OWNER,
      projectId: workspace.id,
      expectedGeneration: 99,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(saves()).toBe(before)
    expect(registry.getActive(OWNER).generation).toBe(1)
  })

  it('rejects stale prepared-project publication before allocating or saving state', () => {
    const { registry, saves } = setup()
    const before = registry.snapshot()

    expect(() => registry.createProject({
      ...OWNER,
      name: 'Product',
      slug: 'product',
      root: '/Users/operator/projects/product',
      origin: 'created',
      expectedGeneration: 99,
    })).toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
    expect(saves()).toBe(0)
    expect(registry.snapshot()).toEqual(before)
  })
})

import { describe, expect, it } from 'vitest'
import {
  makeProjectRegistry,
  ProjectRegistryError,
  type ProjectRegistryEvent,
  type ProjectRegistryState,
} from './project-registry.js'

function setup(initial: ProjectRegistryState | null = null) {
  let saved = initial
  let tick = 0
  let id = 0
  const events: ProjectRegistryEvent[] = []
  const registry = makeProjectRegistry({
    persistence: {
      load: () => saved,
      save: (state) => { saved = state },
    },
    nowIso: () => `2026-07-26T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    newId: () => `id-${++id}`,
    emit: (event) => events.push(event),
  })
  return { registry, events, saved: () => saved }
}

describe('ProjectRegistry (ADR-0060)', () => {
  it('AC-17-1: migrates legacy single-workspace state into one default project and session', () => {
    const { registry, saved } = setup()
    const selected = registry.ensureDefault({
      operatorId: 'telegram:42',
      profileId: 'default',
      root: '/work/legacy',
      legacySessionId: 'legacy-chat-42',
    })

    expect(selected.sessionId).toBe('legacy-chat-42')
    expect(registry.listProjects('telegram:42', 'default')).toMatchObject([
      { name: 'Default', root: '/work/legacy', isDefault: true },
    ])
    expect(saved()?.version).toBe(1)

    expect(registry.ensureDefault({
      operatorId: 'telegram:42',
      profileId: 'default',
      root: '/different',
    })).toEqual(selected)
    expect(registry.snapshot().projects).toHaveLength(1)
    expect(registry.snapshot().sessions).toHaveLength(1)
  })

  it('AC-17-2: creates and switches isolated projects with independent active sessions', () => {
    const { registry } = setup()
    registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/default' })
    const other = registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Product',
      root: '/work/product',
    })
    const selected = registry.switchProject({
      operatorId: 'op',
      profileId: 'p',
      projectId: other.id,
    })

    expect(selected.projectId).toBe(other.id)
    expect(registry.snapshot().sessions.find((item) => item.id === selected.sessionId)?.projectId).toBe(other.id)
    expect(registry.getActive('op', 'p')).toEqual(selected)
  })

  it('AC-17-3: creates, renames, searches, archives and restores sessions without deleting them', () => {
    const { registry } = setup()
    const selected = registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/default' })
    const session = registry.createSession(selected.projectId, 'API redesign')

    expect(registry.renameSession(selected.projectId, session.id, 'API v2').name).toBe('API v2')
    expect(registry.searchSessions(selected.projectId, 'v2').map((item) => item.id)).toEqual([session.id])

    registry.archiveSession(selected.projectId, session.id)
    expect(registry.searchSessions(selected.projectId, 'v2')).toEqual([])
    expect(registry.searchSessions(selected.projectId, 'v2', true)[0]?.status).toBe('archived')

    registry.restoreSession(selected.projectId, session.id)
    expect(registry.searchSessions(selected.projectId, 'v2')[0]?.status).toBe('active')
  })

  it('AC-17-4: rejects cross-project session access and traversal/absolute paths', () => {
    const { registry } = setup()
    const first = registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/one' })
    const secondProject = registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Two',
      root: '/work/two',
    })
    const second = registry.createSession(secondProject.id, 'Second')

    expect(registry.resolveOwnedPath(first.projectId, first.sessionId, 'src/a.ts')).toBe('/work/one/src/a.ts')
    expect(() => registry.resolveOwnedPath(first.projectId, second.id, 'src/a.ts')).toThrowError(
      expect.objectContaining({ code: 'SESSION_PROJECT_MISMATCH' }),
    )
    expect(() => registry.resolveOwnedPath(first.projectId, first.sessionId, '../two/a.ts')).toThrowError(
      expect.objectContaining({ code: 'PATH_OUTSIDE_PROJECT' }),
    )
    expect(() => registry.resolveOwnedPath(first.projectId, first.sessionId, '/etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'PATH_OUTSIDE_PROJECT' }),
    )
  })

  it('AC-17-5: archived sessions cannot be selected or used for file access', () => {
    const { registry } = setup()
    const active = registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/one' })
    registry.archiveSession(active.projectId, active.sessionId)

    expect(registry.getActive('op', 'p')).toBeNull()
    expect(() => registry.switchProject({
      operatorId: 'op',
      profileId: 'p',
      projectId: active.projectId,
      sessionId: active.sessionId,
    })).toThrowError(expect.objectContaining({ code: 'SESSION_ARCHIVED' }))
    expect(() => registry.resolveOwnedPath(active.projectId, active.sessionId, 'a.txt')).toThrowError(
      expect.objectContaining({ code: 'SESSION_ARCHIVED' }),
    )
  })

  it('AC-17-6: persists state and restores the exact active selection after restart', () => {
    const first = setup()
    const selected = first.registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/one' })
    const resumed = setup(first.saved()).registry

    expect(resumed.getActive('op', 'p')).toEqual(selected)
    expect(resumed.resolveOwnedPath(selected.projectId, selected.sessionId, 'a.txt')).toBe('/work/one/a.txt')
  })

  it('AC-17-7: keeps operator/profile selections isolated', () => {
    const { registry } = setup()
    const a = registry.ensureDefault({ operatorId: 'op-a', profileId: 'p', root: '/work/a' })
    const b = registry.ensureDefault({ operatorId: 'op-b', profileId: 'p', root: '/work/b' })

    expect(registry.getActive('op-a', 'p')).toEqual(a)
    expect(registry.getActive('op-b', 'p')).toEqual(b)
    expect(() => registry.switchProject({
      operatorId: 'op-b',
      profileId: 'p',
      projectId: a.projectId,
    })).toThrowError(expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }))
  })

  it('AC-17-8: rejects unsafe and duplicate roots without broadening file ownership', () => {
    const { registry } = setup()
    registry.createProject({ operatorId: 'op', profileId: 'p', name: 'One', root: '/work/one' })

    expect(() => registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Duplicate',
      root: '/work/one/../one',
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ROOT' }))
    expect(() => registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Nested',
      root: '/work/one/sub',
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ROOT' }))
    expect(() => registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Relative',
      root: 'work/relative',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ROOT' }))
    expect(() => registry.createProject({
      operatorId: 'op',
      profileId: 'p',
      name: 'Root',
      root: '/',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_ROOT' }))
  })

  it('AC-17-9: emits redaction-safe lifecycle identifiers and returns defensive snapshots', () => {
    const { registry, events } = setup()
    const selected = registry.ensureDefault({ operatorId: 'op', profileId: 'p', root: '/work/one' })
    const created = registry.createSession(selected.projectId, 'Private customer name')
    registry.renameSession(selected.projectId, created.id, 'Still private')

    expect(events.map((event) => event.kind)).toEqual([
      'project.created',
      'session.created',
      'project.selected',
      'session.created',
      'session.renamed',
    ])
    expect(JSON.stringify(events)).not.toContain('Private customer')
    const snapshot = registry.snapshot()
    snapshot.projects[0]!.name = 'mutated'
    expect(registry.snapshot().projects[0]!.name).toBe('Default')
  })

  it('fails closed on corrupt persisted state', () => {
    expect(() => makeProjectRegistry({
      persistence: {
        load: () => ({ version: 1, projects: [], sessions: [], selections: null } as unknown as ProjectRegistryState),
        save: () => {},
      },
      nowIso: () => '',
      newId: () => '',
    })).toThrow(ProjectRegistryError)

    const dangling: ProjectRegistryState = {
      version: 1,
      projects: [],
      sessions: [],
      selections: [{ operatorId: 'op', profileId: 'p', projectId: 'missing', sessionId: 'missing' }],
    }
    expect(() => setup(dangling)).toThrowError(expect.objectContaining({ code: 'CORRUPT_STATE' }))

    const nullProject = {
      version: 1,
      projects: [null],
      sessions: [],
      selections: [],
    } as unknown as ProjectRegistryState
    expect(() => setup(nullProject)).toThrowError(expect.objectContaining({ code: 'CORRUPT_STATE' }))
  })
})

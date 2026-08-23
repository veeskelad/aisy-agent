import { describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  type ProjectRegistryV2Policy,
} from '@aisy/core'

import { makeLiveProjectRegistryView } from './project-registry-v2-live-adapter.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY: ProjectRegistryV2Policy = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}

function view() {
  const state = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    policy: POLICY,
    nowIso: () => '2026-07-29T12:00:00Z',
    newId: (() => { let id = 0; return () => `id-${++id}` })(),
  })
  const registry = makeProjectRegistryV2({
    state,
    policy: POLICY,
    nowIso: () => '2026-07-29T12:00:00Z',
    newId: (() => { let id = 100; return () => `id-${++id}` })(),
  })
  return { registry, live: makeLiveProjectRegistryView({ registry, owner: OWNER }) }
}

describe('live project registry view over v2', () => {
  it('returns the active selection published by the migration', () => {
    const { live, registry } = view()
    const selection = live.ensureDefault(OWNER)
    const active = registry.getActive(OWNER)

    expect(selection).toEqual({
      operatorId: OWNER.operatorId,
      profileId: OWNER.profileId,
      projectId: active.projectId,
      sessionId: active.sessionId,
    })
    // The v1 shape carries no generation: callers must go through v2 to switch.
    expect(selection).not.toHaveProperty('generation')
  })

  it('derives isDefault from the workspace kind rather than storing it twice', () => {
    const { live } = view()
    const projects = live.snapshot().projects

    expect(projects).toHaveLength(1)
    expect(projects[0]!.isDefault).toBe(true)
    expect(projects[0]).not.toHaveProperty('kind')
  })

  it('refuses a selection requested for another owner', () => {
    const { live } = view()
    expect(() => live.ensureDefault({ operatorId: 'telegram:99', profileId: 'default' }))
      .toThrowError(/another owner/)
    expect(() => live.ensureDefault({ ...OWNER, profileId: 'other' }))
      .toThrowError(/another owner/)
  })

  it('creates a session through v2 authority and surfaces it in the snapshot', () => {
    const { live } = view()
    const projectId = live.ensureDefault(OWNER).projectId

    const session = live.createSession(projectId, 'Aisy system (nightly)')
    expect(session.projectId).toBe(projectId)
    expect(session.status).toBe('active')
    expect(live.snapshot().sessions.some(item => item.id === session.id)).toBe(true)
  })

  it('hands out defensive copies — mutating a snapshot cannot rewrite the registry', () => {
    const { live } = view()
    const first = live.snapshot()
    first.projects[0]!.name = 'mutated'
    first.sessions.splice(0, first.sessions.length)

    const second = live.snapshot()
    expect(second.projects[0]!.name).not.toBe('mutated')
    expect(second.sessions.length).toBeGreaterThan(0)
  })
})

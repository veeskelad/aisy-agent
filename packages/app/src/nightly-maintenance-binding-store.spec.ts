import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeNightlyMaintenanceBindingStore,
  makeNodeNightlyMaintenanceBindingStore,
  validateNightlyMaintenanceBindings,
  type NightlyMaintenanceBindings,
} from './nightly-maintenance-binding-store.js'

const WORKSPACE = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'workspace-1',
  sessionId: 'workspace-nightly',
  scope: 'workspace' as const,
}
const PROJECT_A = {
  ...WORKSPACE,
  projectId: 'project-a',
  sessionId: 'project-a-nightly',
  scope: 'project' as const,
}
const PROJECT_B = {
  ...WORKSPACE,
  projectId: 'project-b',
  sessionId: 'project-b-nightly',
  scope: 'project' as const,
}
const BINDINGS: NightlyMaintenanceBindings = {
  workspace: WORKSPACE,
  projects: [PROJECT_B, PROJECT_A],
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function ports(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/bindings.json', initial)
  return {
    path: '/bindings.json',
    exists: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path)!,
    saveAtomic: (content: string) => { files.set('/bindings.json', content) },
    content: () => files.get('/bindings.json'),
  }
}

describe('nightly maintenance binding store', () => {
  it('stores an exact sorted Workspace→Projects authority snapshot and restores it', () => {
    const state = ports()
    const store = makeNightlyMaintenanceBindingStore(state)
    store.save(BINDINGS)

    expect(store.load()).toEqual({
      status: 'ready',
      bindings: { workspace: WORKSPACE, projects: [PROJECT_A, PROJECT_B] },
    })
    expect(state.content()).not.toContain('root')
  })

  it.each([
    ['unknown field', { ...PROJECT_A, hiddenAuthority: true }],
    ['Workspace scope', { ...PROJECT_A, scope: 'workspace' }],
    ['foreign owner', { ...PROJECT_A, operatorId: 'telegram:7' }],
    ['Workspace id', { ...PROJECT_A, projectId: WORKSPACE.projectId }],
  ])('rejects %s without publishing', (_name, project) => {
    const state = ports()
    const store = makeNightlyMaintenanceBindingStore(state)
    expect(() => store.save({ workspace: WORKSPACE, projects: [project as typeof PROJECT_A] }))
      .toThrow()
    expect(state.content()).toBeUndefined()
  })

  it('rejects duplicate Project or system Session authority', () => {
    expect(() => validateNightlyMaintenanceBindings({
      workspace: WORKSPACE,
      projects: [PROJECT_A, { ...PROJECT_B, sessionId: PROJECT_A.sessionId }],
    })).toThrow()
    expect(() => validateNightlyMaintenanceBindings({
      workspace: WORKSPACE,
      projects: [PROJECT_A, { ...PROJECT_A, sessionId: 'another-session' }],
    })).toThrow()
  })

  it('quarantines malformed or oversized durable state without rewriting it', () => {
    const malformed = ports('{private-invalid-detail}')
    expect(makeNightlyMaintenanceBindingStore(malformed).load()).toEqual({
      status: 'quarantined',
      reason: 'invalid-maintenance-bindings',
    })
    expect(malformed.content()).toBe('{private-invalid-detail}')

    const oversized = ports('x'.repeat(1024 * 1024 + 1))
    expect(makeNightlyMaintenanceBindingStore(oversized).load()).toMatchObject({
      status: 'quarantined',
    })
  })

  it('uses private atomic Node persistence and survives a fresh store', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-nightly-maintenance-bindings-'))
    roots.push(root)
    const path = join(root, 'state', 'nightly-maintenance-bindings.json')
    makeNodeNightlyMaintenanceBindingStore({ path }).save(BINDINGS)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain('/Users/')
    expect(makeNodeNightlyMaintenanceBindingStore({ path }).load()).toEqual({
      status: 'ready',
      bindings: { workspace: WORKSPACE, projects: [PROJECT_A, PROJECT_B] },
    })
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeBackgroundBindingStore,
  makeNodeBackgroundBindingStore,
} from './background-binding-store.js'

const BINDING = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'workspace-1',
  sessionId: 'nightly-system-1',
  scope: 'workspace' as const,
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function deps(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set('/bindings.json', initial)
  return {
    path: '/bindings.json',
    readFile: (path: string) => files.get(path)!,
    saveAtomic: (content: string) => { files.set('/bindings.json', content) },
    exists: (path: string) => files.has(path),
  }
}

describe('makeBackgroundBindingStore', () => {
  it('persists and restores the exact nightly workspace/system-session binding', () => {
    const ports = deps()
    makeBackgroundBindingStore(ports).save('nightly', BINDING)

    expect(makeBackgroundBindingStore(ports).load('nightly')).toEqual({
      status: 'ready',
      binding: BINDING,
    })
  })

  it('distinguishes a new missing binding from an invalid legacy value', () => {
    expect(makeBackgroundBindingStore(deps()).load('nightly')).toEqual({ status: 'missing' })

    const ports = deps(JSON.stringify({ schemaVersion: 1, bindings: { nightly: {
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'workspace-1',
      scope: 'workspace',
    } } }))
    const store = makeBackgroundBindingStore(ports)
    expect(store.load('nightly')).toEqual({
      status: 'quarantined',
      reason: 'missing-or-invalid-work-binding',
    })
    expect(store.load('nightly')).toEqual({
      status: 'quarantined',
      reason: 'missing-or-invalid-work-binding',
    })
  })

  it('publishes the Node store atomically with private permissions and survives restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-background-binding-'))
    roots.push(root)
    const path = join(root, 'state', 'background-bindings.json')
    makeNodeBackgroundBindingStore({ path }).save('nightly', BINDING)
    const orphan = path + '.tmp'
    writeFileSync(orphan, '{"uncommitted":true}\n', { mode: 0o600 })

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('nightly-system-1')
    expect(makeNodeBackgroundBindingStore({ path }).load('nightly')).toEqual({
      status: 'ready',
      binding: BINDING,
    })
    expect(existsSync(orphan)).toBe(false)
  })

  it('disables only a future job bound to the deleted Session', () => {
    const ports = deps()
    const store = makeBackgroundBindingStore(ports)
    store.save('nightly', BINDING)

    expect(store.disableExactSession(BINDING)).toEqual(['nightly'])
    expect(store.disableExactSession(BINDING)).toEqual([])
    expect(store.load('nightly')).toEqual({
      status: 'quarantined',
      reason: 'context-deleted',
    })
  })
})

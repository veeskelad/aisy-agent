import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeGrantStore, type GrantBinding } from '@aisy/core'
import {
  makeApprovalGrantPersistence,
  makeNodeApprovalGrantPersistence,
} from './approval-grant-store.js'

const BINDING: GrantBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'project',
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('approval grant persistence', () => {
  it('returns invalid input to core quarantine without throwing', () => {
    const persistence = makeApprovalGrantPersistence({
      path: '/grants.json',
      exists: () => true,
      readFile: () => '{broken',
      saveAtomic: () => {},
    })
    const grants = makeGrantStore({ persistence })
    expect(grants.has('bash', BINDING)).toBe(false)
    expect(grants.list()).toEqual([])
  })

  it('atomically persists private v2 state and restores exact scope after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-grants-'))
    roots.push(root)
    const path = join(root, 'state', 'grants.json')
    const first = makeGrantStore({
      persistence: makeNodeApprovalGrantPersistence({ path }),
      nowIso: () => '2026-07-27T01:00:00.000Z',
    })
    first.record('bash', 'always', BINDING)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schemaVersion: 2 })
    const restarted = makeGrantStore({ persistence: makeNodeApprovalGrantPersistence({ path }) })
    expect(restarted.has('bash', { ...BINDING, sessionId: 'session-a2' })).toBe(true)
    expect(restarted.has('bash', { ...BINDING, projectId: 'project-b' })).toBe(false)
  })

  it('atomically persists private v3 similarity state without raw resource data', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-grants-v3-'))
    roots.push(root)
    const path = join(root, 'state', 'grants.json')
    const call = {
      tool: 'write_file', args: { path: 'src/operator-private.ts', content: 'private bytes' },
    }
    makeGrantStore({ persistence: makeNodeApprovalGrantPersistence({ path }) })
      .recordSimilar(call, 2, 'always', BINDING)

    const raw = readFileSync(path, 'utf8')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 3 })
    expect(raw).not.toContain('src/operator-private.ts')
    expect(raw).not.toContain('private bytes')
    const restarted = makeGrantStore({ persistence: makeNodeApprovalGrantPersistence({ path }) })
    expect(restarted.hasSimilar({
      tool: 'write_file', args: { path: 'src/operator-private.ts', content: 'new bytes' },
    }, 2, { ...BINDING, sessionId: 'session-a2' })).toBe(true)
  })

  it('keeps an existing legacy file disabled until an explicit bound grant is recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-grants-legacy-'))
    roots.push(root)
    const path = join(root, 'grants.json')
    writeFileSync(path, JSON.stringify({ always: ['bash'] }), { mode: 0o600 })

    const grants = makeGrantStore({ persistence: makeNodeApprovalGrantPersistence({ path }) })
    expect(grants.has('bash', BINDING)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ always: ['bash'] })

    grants.record('read_file', 'always', BINDING)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      quarantinedLegacyTools: ['bash'],
    })
  })
})

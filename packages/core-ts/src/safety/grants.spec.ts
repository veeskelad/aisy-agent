import { describe, it, expect } from 'vitest'
import { makeGrantStore } from './grants.js'
import type { GrantPersistencePort } from './types.js'

function fakePersistence(initial: string[] = []): {
  port: GrantPersistencePort
  saved: string[][]
} {
  let store = [...initial]
  const saved: string[][] = []
  return {
    saved,
    port: {
      loadAlways: () => [...store],
      saveAlways: (tools) => {
        store = [...tools]
        saved.push([...tools])
      },
    },
  }
}

describe('makeGrantStore', () => {
  it('starts empty without persistence', () => {
    const g = makeGrantStore()
    expect(g.has('bash')).toBe(false)
    expect(g.list()).toEqual([])
  })

  it('session grant is remembered in-memory but never persisted', () => {
    const { port, saved } = fakePersistence()
    const g = makeGrantStore({ persistence: port })
    g.record('bash', 'session')
    expect(g.has('bash')).toBe(true)
    expect(saved).toEqual([]) // session grants are not written to disk
    expect(g.list()).toEqual([{ tool: 'bash', scope: 'session' }])
  })

  it('always grant persists', () => {
    const { port, saved } = fakePersistence()
    const g = makeGrantStore({ persistence: port })
    g.record('write_file', 'always')
    expect(g.has('write_file')).toBe(true)
    expect(saved).toEqual([['write_file']])
  })

  it('loads persisted always grants on construction', () => {
    const { port } = fakePersistence(['bash', 'git'])
    const g = makeGrantStore({ persistence: port })
    expect(g.has('bash')).toBe(true)
    expect(g.has('git')).toBe(true)
    expect(g.list()).toEqual([
      { tool: 'bash', scope: 'always' },
      { tool: 'git', scope: 'always' },
    ])
  })

  it('always supersedes a prior session grant (promotion)', () => {
    const { port } = fakePersistence()
    const g = makeGrantStore({ persistence: port })
    g.record('bash', 'session')
    g.record('bash', 'always')
    expect(g.list()).toEqual([{ tool: 'bash', scope: 'always' }])
  })

  it('recording session for an already-always tool is a no-op', () => {
    const { port, saved } = fakePersistence(['bash'])
    const g = makeGrantStore({ persistence: port })
    g.record('bash', 'session')
    expect(g.list()).toEqual([{ tool: 'bash', scope: 'always' }])
    expect(saved).toEqual([]) // nothing changed
  })

  it('revoke removes both session and always and persists the always removal', () => {
    const { port, saved } = fakePersistence(['bash'])
    const g = makeGrantStore({ persistence: port })
    g.record('git', 'session')
    g.revoke('bash')
    g.revoke('git')
    expect(g.has('bash')).toBe(false)
    expect(g.has('git')).toBe(false)
    expect(saved).toEqual([[]]) // only the always removal wrote
  })

  it('revokeAll clears everything and persists once when always grants existed', () => {
    const { port, saved } = fakePersistence(['bash', 'git'])
    const g = makeGrantStore({ persistence: port })
    g.record('write_file', 'session')
    g.revokeAll()
    expect(g.list()).toEqual([])
    expect(saved).toEqual([[]])
  })

  it('revokeAll does not write when there were no always grants', () => {
    const { port, saved } = fakePersistence()
    const g = makeGrantStore({ persistence: port })
    g.record('bash', 'session')
    g.revokeAll()
    expect(saved).toEqual([])
  })
})

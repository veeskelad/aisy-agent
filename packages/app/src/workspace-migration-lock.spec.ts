import { describe, expect, it } from 'vitest'
import { makeWorkspaceMigrationLock } from './workspace-migration-lock.js'

function setup() {
  const directories = new Set<string>()
  const files = new Map<string, string>()
  const calls: string[] = []
  let nonce = 0
  const deps = {
    lockPath: '/state/migrations/workspace-v2.lock',
    createDirectoryExclusive: (path: string) => {
      calls.push(`mkdir-exclusive:${path}`)
      if (directories.has(path)) return false
      directories.add(path)
      return true
    },
    writeFile: (path: string, content: string) => {
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    readFile: (path: string) => files.get(path),
    syncFile: (path: string) => calls.push(`sync-file:${path}`),
    syncDirectory: (path: string) => calls.push(`sync-dir:${path}`),
    removeFile: (path: string) => {
      calls.push(`remove-file:${path}`)
      files.delete(path)
    },
    removeDirectory: (path: string) => {
      calls.push(`remove-dir:${path}`)
      directories.delete(path)
    },
    nowIso: () => '2026-07-26T21:00:00.000Z',
    pid: 42,
    bootId: 'boot-1',
    newNonce: () => `nonce-${++nonce}`,
  }
  return { calls, directories, files, deps, lock: makeWorkspaceMigrationLock(deps) }
}

describe('makeWorkspaceMigrationLock', () => {
  it('acquires through one atomic directory creation and durably records ownership', () => {
    const { calls, lock } = setup()

    const acquired = lock.acquire()

    expect(acquired).toMatchObject({ ok: true, token: { nonce: 'nonce-1', pid: 42 } })
    expect(calls).toEqual([
      'mkdir-exclusive:/state/migrations/workspace-v2.lock',
      'write:/state/migrations/workspace-v2.lock/owner.json',
      'sync-file:/state/migrations/workspace-v2.lock/owner.json',
      'sync-dir:/state/migrations/workspace-v2.lock',
      'sync-dir:/state/migrations',
    ])
  })

  it('fails closed when another process or a corrupt/stale directory holds the lock', () => {
    const { deps, lock } = setup()
    expect(lock.acquire().ok).toBe(true)

    const competing = makeWorkspaceMigrationLock({
      ...deps,
      pid: 99,
      bootId: 'boot-2',
      newNonce: () => 'other',
    }).acquire()

    expect(competing).toEqual({ ok: false, code: 'MIGRATION_LOCK_HELD' })
  })

  it('releases only a byte-matching owner token and never steals a mismatched lock', () => {
    const { directories, files, lock } = setup()
    const acquired = lock.acquire()
    if (!acquired.ok) throw new Error('expected lock')

    expect(lock.isHeld(acquired.token)).toBe(true)
    expect(lock.isHeld({ ...acquired.token, nonce: 'wrong' })).toBe(false)
    expect(lock.release({ ...acquired.token, nonce: 'wrong' })).toBe(false)
    expect(directories.has('/state/migrations/workspace-v2.lock')).toBe(true)
    expect(lock.release(acquired.token)).toBe(true)
    expect(directories.has('/state/migrations/workspace-v2.lock')).toBe(false)
    expect(files.has('/state/migrations/workspace-v2.lock/owner.json')).toBe(false)
  })

  it('cleans up only its own newly-created lock directory when initialization fails', () => {
    const { deps, directories } = setup()
    const lock = makeWorkspaceMigrationLock({
      ...deps,
      writeFile: () => { throw new Error('disk full') },
    })

    expect(() => lock.acquire()).toThrow('disk full')
    expect(directories.has('/state/migrations/workspace-v2.lock')).toBe(false)
  })
})

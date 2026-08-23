import { describe, expect, it } from 'vitest'
import type { WorkspaceMigrationManifest } from '@aisy/core'
import {
  makeJsonWorkspaceMigrationManifestStore,
  readWorkspaceRegistryStartupMode,
} from './workspace-migration-store.js'

function manifest(phase: WorkspaceMigrationManifest['phase'] = 'PREPARED'): WorkspaceMigrationManifest {
  return {
    version: 1,
    migrationId: 'migration-1',
    phase,
    sourceRegistrySha256: 'a'.repeat(64),
    createdArtifacts: [],
    backups: [],
    updatedAt: '2026-07-26T20:00:00.000Z',
  }
}

function setup(initial?: WorkspaceMigrationManifest) {
  const files = new Map<string, string>()
  if (initial) files.set('/state/migrations/workspace-v2.json', JSON.stringify(initial))
  const calls: string[] = []
  const store = makeJsonWorkspaceMigrationManifestStore({
    path: '/state/migrations/workspace-v2.json',
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writeFile: (path, content) => {
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    syncFile: (path) => calls.push(`sync-file:${path}`),
    renameFile: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path) => calls.push(`sync-dir:${path}`),
  })
  return { calls, files, store }
}

describe('makeJsonWorkspaceMigrationManifestStore', () => {
  it('loads and validates the durable manifest', () => {
    const { store } = setup(manifest('VERIFIED'))

    expect(store.load()).toEqual(manifest('VERIFIED'))
  })

  it('publishes through temp write, file fsync, rename and directory fsync', () => {
    const { calls, files, store } = setup(manifest())

    store.saveAtomic(manifest('COPIED'))

    expect(calls).toEqual([
      'write:/state/migrations/workspace-v2.json.tmp',
      'sync-file:/state/migrations/workspace-v2.json.tmp',
      'rename:/state/migrations/workspace-v2.json.tmp->/state/migrations/workspace-v2.json',
      'sync-dir:/state/migrations',
    ])
    expect(JSON.parse(files.get('/state/migrations/workspace-v2.json') ?? '')).toEqual(manifest('COPIED'))
  })

  it.each(['write', 'sync-file', 'rename'] as const)(
    'keeps the previous target authoritative when %s fails before publication',
    (failurePoint) => {
      const old = manifest('PREPARED')
      const files = new Map<string, string>([
        ['/state/migrations/workspace-v2.json', JSON.stringify(old)],
      ])
      const store = makeJsonWorkspaceMigrationManifestStore({
        path: '/state/migrations/workspace-v2.json',
        exists: (path) => files.has(path),
        readFile: (path) => files.get(path) ?? '',
        writeFile: (path, content) => {
          if (failurePoint === 'write') throw new Error('injected write failure')
          files.set(path, content)
        },
        syncFile: () => {
          if (failurePoint === 'sync-file') throw new Error('injected sync failure')
        },
        renameFile: (from, to) => {
          if (failurePoint === 'rename') throw new Error('injected rename failure')
          files.set(to, files.get(from) ?? '')
        },
        syncDirectory: () => {},
      })

      expect(() => store.saveAtomic(manifest('COPIED'))).toThrow('injected')
      expect(JSON.parse(files.get('/state/migrations/workspace-v2.json') ?? '')).toEqual(old)
    },
  )

  it('treats a directory-fsync failure after rename as restart-resolvable new state', () => {
    const files = new Map<string, string>([
      ['/state/migrations/workspace-v2.json', JSON.stringify(manifest('PREPARED'))],
    ])
    let failDirectorySync = true
    const deps = {
      path: '/state/migrations/workspace-v2.json',
      exists: (path: string) => files.has(path),
      readFile: (path: string) => files.get(path) ?? '',
      writeFile: (path: string, content: string) => { files.set(path, content) },
      syncFile: () => {},
      renameFile: (from: string, to: string) => {
        files.set(to, files.get(from) ?? '')
        files.delete(from)
      },
      syncDirectory: () => {
        if (failDirectorySync) throw new Error('injected directory sync failure')
      },
    }
    const store = makeJsonWorkspaceMigrationManifestStore(deps)

    expect(() => store.saveAtomic(manifest('COPIED'))).toThrow('injected directory sync failure')
    failDirectorySync = false
    expect(makeJsonWorkspaceMigrationManifestStore(deps).load().phase).toBe('COPIED')
  })

  it('rejects malformed state before touching the filesystem', () => {
    const { calls, store } = setup(manifest())

    expect(() => store.saveAtomic({
      ...manifest(),
      sourceRegistrySha256: 'invalid',
    })).toThrowError(expect.objectContaining({ code: 'CORRUPT_MANIFEST' }))
    expect(calls).toEqual([])
  })
})

describe('readWorkspaceRegistryStartupMode', () => {
  it('allows legacy runtime only while no migration manifest exists', () => {
    expect(readWorkspaceRegistryStartupMode({
      path: '/state/migrations/workspace-v2.json',
      exists: () => false,
      readFile: () => '',
    })).toBe('v1-live')
  })

  it('closes legacy writes during migration and after v2 activation', () => {
    const current = { value: manifest('VERIFIED') }
    const deps = {
      path: '/state/migrations/workspace-v2.json',
      exists: () => true,
      readFile: () => JSON.stringify(current.value),
    }

    expect(readWorkspaceRegistryStartupMode(deps)).toBe('maintenance')
    current.value = manifest('V2_WRITES_ENABLED')
    expect(readWorkspaceRegistryStartupMode(deps)).toBe('v2-live')
  })
})

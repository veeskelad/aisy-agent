import { describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  type ProjectRegistryStateV2,
} from '@aisy/core'
import {
  makeJsonProjectRegistryV2Store,
  type JsonProjectRegistryV2StoreDeps,
} from './project-registry-v2-store.js'

const PATH = '/state/projects-v2.json'
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const OWNER = { operatorId: 'telegram:42', profileId: 'default' }

function fresh(): ProjectRegistryStateV2 {
  let id = 0
  return makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `id-${++id}`,
    policy: POLICY,
  })
}

function memoryFs(initial?: string) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  const calls: string[] = []
  let failSync = false
  const deps: JsonProjectRegistryV2StoreDeps = {
    path: PATH,
    policy: POLICY,
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writeFileExclusive: (path, content) => {
      if (files.has(path)) throw new Error('exclusive temp exists')
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    syncFile: (path) => {
      calls.push(`fsync:${path}`)
      if (failSync) throw new Error('fsync failed')
    },
    renameFile: (from, to) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path) => { calls.push(`fsync-dir:${path}`) },
  }
  return { calls, deps, files, failNextSync: () => { failSync = true } }
}

describe('makeJsonProjectRegistryV2Store', () => {
  it('fails closed when the authoritative v2 registry is absent', () => {
    const store = makeJsonProjectRegistryV2Store(memoryFs().deps)
    expect(() => store.load()).toThrowError(expect.objectContaining({ code: 'REGISTRY_NOT_FOUND' }))
  })

  it('loads migration-compatible bytes and publishes only through durable atomic boundaries', () => {
    const state = fresh()
    const fs = memoryFs(JSON.stringify(state, null, 2) + '\n')
    const store = makeJsonProjectRegistryV2Store(fs.deps)
    expect(store.load()).toEqual(state)

    store.saveAtomic(state)
    expect(fs.calls).toEqual([
      `write:${PATH}.tmp`,
      `fsync:${PATH}.tmp`,
      `rename:${PATH}.tmp->${PATH}`,
      'fsync-dir:/state',
    ])
    expect(store.load()).toEqual(state)
  })

  it('rejects malformed JSON and structurally invalid registry state', () => {
    for (const content of [
      '{',
      JSON.stringify({ ...fresh(), sessions: [] }),
      JSON.stringify({ ...fresh(), version: 1 }),
    ]) {
      const store = makeJsonProjectRegistryV2Store(memoryFs(content).deps)
      expect(() => store.load()).toThrowError(expect.objectContaining({ code: 'CORRUPT_REGISTRY' }))
    }
  })

  it('keeps registry memory and target bytes unchanged when save fsync fails', () => {
    const initial = fresh()
    const fs = memoryFs(JSON.stringify(initial, null, 2) + '\n')
    const store = makeJsonProjectRegistryV2Store(fs.deps)
    let id = 10
    const registry = makeProjectRegistryV2({
      state: store.load(),
      policy: POLICY,
      nowIso: () => '2026-07-26T21:01:00.000Z',
      newId: () => `id-${++id}`,
      persistence: store,
    })
    const durableBefore = fs.files.get(PATH)
    fs.failNextSync()

    expect(() => registry.createProject({
      ...OWNER,
      name: 'Project B',
      slug: 'project-b',
      root: '/Users/operator/projects/project-b',
      origin: 'created',
    })).toThrow('fsync failed')
    expect(registry.snapshot()).toEqual(initial)
    expect(fs.files.get(PATH)).toBe(durableBefore)
  })
})

import { describe, expect, it } from 'vitest'
import type { ProjectRegistryState } from '@aisy/core'
import { makeJsonProjectRegistryStore } from './project-registry-store.js'

const EMPTY: ProjectRegistryState = {
  version: 1,
  projects: [],
  sessions: [],
  selections: [],
}

describe('makeJsonProjectRegistryStore', () => {
  it('returns null when the registry is absent', () => {
    const store = makeJsonProjectRegistryStore({
      path: '/state/projects.json',
      exists: () => false,
      readFile: () => '',
      writeFile: () => {},
      renameFile: () => {},
    })
    expect(store.load()).toBeNull()
  })

  it('publishes a save only through temp-write then atomic rename', () => {
    const calls: string[] = []
    const files = new Map<string, string>()
    const store = makeJsonProjectRegistryStore({
      path: '/state/projects.json',
      exists: (path) => files.has(path),
      readFile: (path) => files.get(path) ?? '',
      writeFile: (path, content) => {
        calls.push('write:' + path)
        files.set(path, content)
      },
      renameFile: (from, to) => {
        calls.push('rename:' + from + '->' + to)
        files.set(to, files.get(from) ?? '')
        files.delete(from)
      },
    })

    store.save(EMPTY)

    expect(calls).toEqual([
      'write:/state/projects.json.tmp',
      'rename:/state/projects.json.tmp->/state/projects.json',
    ])
    expect(store.load()).toEqual(EMPTY)
  })

  it('does not publish the target when temp writing fails', () => {
    const store = makeJsonProjectRegistryStore({
      path: '/state/projects.json',
      exists: () => false,
      readFile: () => '',
      writeFile: () => { throw new Error('disk full') },
      renameFile: () => { throw new Error('must not run') },
    })

    expect(() => store.save(EMPTY)).toThrow('disk full')
  })
})

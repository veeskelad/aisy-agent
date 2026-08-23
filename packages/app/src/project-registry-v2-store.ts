import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  validateProjectRegistryStateV2,
  type ProjectRegistryStateV2,
  type ProjectRegistryV2PersistencePort,
  type ProjectRegistryV2Policy,
} from '@aisy/core'

export interface ProjectRegistryV2Store extends ProjectRegistryV2PersistencePort {
  load(): ProjectRegistryStateV2
}

export interface JsonProjectRegistryV2StoreDeps {
  path: string
  policy: ProjectRegistryV2Policy
  exists(path: string): boolean
  readFile(path: string): string
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  renameFile(from: string, to: string): void
  syncDirectory(path: string): void
}

export class ProjectRegistryV2StoreError extends Error {
  constructor(public readonly code: 'REGISTRY_NOT_FOUND' | 'CORRUPT_REGISTRY') {
    super(code)
    this.name = 'ProjectRegistryV2StoreError'
  }
}

function validated(input: unknown, policy: ProjectRegistryV2Policy): ProjectRegistryStateV2 {
  try {
    return validateProjectRegistryStateV2(input as ProjectRegistryStateV2, policy)
  } catch {
    throw new ProjectRegistryV2StoreError('CORRUPT_REGISTRY')
  }
}

export function makeJsonProjectRegistryV2Store(
  deps: JsonProjectRegistryV2StoreDeps,
): ProjectRegistryV2Store {
  const tempPath = deps.path + '.tmp'
  return {
    load() {
      if (!deps.exists(deps.path)) throw new ProjectRegistryV2StoreError('REGISTRY_NOT_FOUND')
      try {
        return validated(JSON.parse(deps.readFile(deps.path)) as unknown, deps.policy)
      } catch (error) {
        if (error instanceof ProjectRegistryV2StoreError) throw error
        throw new ProjectRegistryV2StoreError('CORRUPT_REGISTRY')
      }
    },

    saveAtomic(input) {
      const state = validated(input, deps.policy)
      deps.writeFileExclusive(tempPath, JSON.stringify(state, null, 2) + '\n')
      deps.syncFile(tempPath)
      deps.renameFile(tempPath, deps.path)
      deps.syncDirectory(dirname(deps.path))
    },
  }
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function makeNodeProjectRegistryV2Store(input: {
  path: string
  policy: ProjectRegistryV2Policy
}): ProjectRegistryV2Store {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeJsonProjectRegistryV2Store({
    path: input.path,
    policy: input.policy,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFileExclusive: (path, content) => writeFileSync(path, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
    syncFile: syncPath,
    renameFile: (from, to) => renameSync(from, to),
    syncDirectory: syncPath,
  })
}

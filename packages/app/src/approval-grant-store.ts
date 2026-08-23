import type {
  GrantPersistencePort,
  GrantPersistenceStateV2,
  GrantPersistenceStateV3,
} from '@aisy/core'
import { randomUUID } from 'node:crypto'
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

export interface ApprovalGrantPersistenceDeps {
  path: string
  exists(path: string): boolean
  readFile(path: string): string
  saveAtomic(content: string): void
}

/**
 * Raw JSON adapter. Validation, legacy quarantine and scope semantics belong to
 * the core GrantStore so every transport gets the same fail-closed behavior.
 */
export function makeApprovalGrantPersistence(
  deps: ApprovalGrantPersistenceDeps,
): GrantPersistencePort {
  return {
    load() {
      if (!deps.exists(deps.path)) return undefined
      try {
        return JSON.parse(deps.readFile(deps.path)) as unknown
      } catch {
        return { schemaVersion: 'invalid-json' }
      }
    },

    save(state: GrantPersistenceStateV2 | GrantPersistenceStateV3) {
      deps.saveAtomic(JSON.stringify(state, null, 2) + '\n')
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function makeNodeApprovalGrantPersistence(input: {
  path: string
}): GrantPersistencePort {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeApprovalGrantPersistence({
    path: input.path,
    exists: (path) => existsSync(path),
    readFile: (path) => readFileSync(path, 'utf8'),
    saveAtomic: (content) => {
      const tempPath = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(tempPath)
      renameSync(tempPath, input.path)
      syncPath(directory)
    },
  })
}

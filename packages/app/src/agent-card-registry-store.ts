import type { AgentCardRegistryPersistencePort, AgentCardRegistryStateV2 } from '@aisy/core'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 4 * 1024 * 1024

/**
 * Raw JSON adapter for the Agent Card registry (ADR-0069). Validation, revision
 * semantics and approval rules stay in core, so every transport gets the same
 * fail-closed behaviour; this file only moves bytes atomically and privately.
 */
export function makeAgentCardRegistryStore(input: {
  path: string
}): AgentCardRegistryPersistencePort {
  const syncPath = (path: string): void => {
    const descriptor = openSync(path, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }

  return {
    load() {
      if (!existsSync(input.path)) return undefined
      // An oversized file is treated as absent state rather than parsed: core would
      // drop it anyway, and refusing early keeps startup bounded.
      if (statSync(input.path).size > MAX_BYTES) return undefined
      try {
        return JSON.parse(readFileSync(input.path, 'utf8')) as unknown
      } catch {
        return undefined
      }
    },

    save(state: AgentCardRegistryStateV2) {
      const directory = dirname(input.path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      syncPath(temporary)
      renameSync(temporary, input.path)
      syncPath(directory)
    },
  }
}

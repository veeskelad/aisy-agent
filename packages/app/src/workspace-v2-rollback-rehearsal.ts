// Rollback rehearsal for the Workspace v2 cutover (ADR-0073).
//
// A rehearsal is an actual restore: backup bytes are copied to a private scratch
// directory and re-hashed there. Nothing in the live tree is touched, and a
// rehearsal that did not restore byte-identical content is never recorded.

import type { WorkspaceMigrationManifest, WorkspaceV2RollbackRehearsal } from '@aisy/core'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SHA256 = /^[0-9a-f]{64}$/
const MAX_STATE_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

export type RollbackRehearsalRefusal =
  | 'backup-missing'
  | 'backup-unreadable'
  | 'restore-mismatch'
  | 'cohort-invalid'

export class RollbackRehearsalError extends Error {
  constructor(readonly reason: RollbackRehearsalRefusal) {
    super(`rollback rehearsal refused: ${reason}`)
    this.name = 'RollbackRehearsalError'
  }
}

function sha256File(path: string): string {
  if (statSync(path).size > MAX_ARTIFACT_BYTES) throw new RollbackRehearsalError('backup-unreadable')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Restore one backup into scratch space and prove the bytes came back identical. */
function restoreAndVerify(backup: { path: string; sha256: string }, scratch: string): string {
  const source = backup?.path
  const expected = backup?.sha256
  if (typeof source !== 'string' || source === '' || typeof expected !== 'string' || !SHA256.test(expected)) {
    throw new RollbackRehearsalError('backup-missing')
  }
  if (!existsSync(source)) throw new RollbackRehearsalError('backup-missing')
  const target = join(scratch, `restore-${createHash('sha256').update(source).digest('hex').slice(0, 32)}`)
  try {
    copyFileSync(source, target)
    chmodSync(target, 0o600)
  } catch {
    throw new RollbackRehearsalError('backup-unreadable')
  }
  const actual = sha256File(target)
  if (actual !== expected) throw new RollbackRehearsalError('restore-mismatch')
  return actual
}

export interface RollbackRehearsalInput {
  cohortId: string
  registryManifest: WorkspaceMigrationManifest
  /** Memory ledger backup recorded by the memory migration manifest. */
  memoryBackup: { path: string; sha256: string }
  /** Private scratch root; a fresh subdirectory is created and removed per rehearsal. */
  scratchRoot: string
  nowIso: () => string
  newRehearsalId?: () => string
}

/**
 * Perform a rehearsal. Returns evidence only when both backups restored
 * byte-identically; any failure throws with a stable reason and leaves no record.
 */
export function performWorkspaceV2RollbackRehearsal(
  input: RollbackRehearsalInput,
): WorkspaceV2RollbackRehearsal {
  const cohortId = input.cohortId
  if (typeof cohortId !== 'string' || cohortId === '') {
    throw new RollbackRehearsalError('cohort-invalid')
  }
  const registryBackup = input.registryManifest?.backups?.[0]
  if (registryBackup === undefined) throw new RollbackRehearsalError('backup-missing')

  const scratch = join(resolve(input.scratchRoot), `rehearsal-${randomUUID()}`)
  mkdirSync(scratch, { recursive: true, mode: 0o700 })
  chmodSync(scratch, 0o700)
  try {
    const restoredRegistrySha256 = restoreAndVerify(registryBackup, scratch)
    const restoredMemoryLedgerSha256 = restoreAndVerify(input.memoryBackup, scratch)
    return Object.freeze({
      rehearsalId: (input.newRehearsalId ?? (() => randomUUID()))(),
      cohortId,
      performedAt: input.nowIso(),
      restoredRegistrySha256,
      restoredMemoryLedgerSha256,
      verdict: 'passed' as const,
    })
  } finally {
    // Scratch never survives the rehearsal: restored bytes are proof, not state.
    rmSync(scratch, { recursive: true, force: true })
  }
}

export interface RollbackRehearsalStore {
  load(cohortId: string): WorkspaceV2RollbackRehearsal | null
  save(rehearsal: WorkspaceV2RollbackRehearsal): void
}

interface RehearsalStateV1 {
  schemaVersion: 1
  rehearsals: WorkspaceV2RollbackRehearsal[]
}

function validRehearsal(value: unknown): value is WorkspaceV2RollbackRehearsal {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return Object.hasOwn(item, 'verdict') && item.verdict === 'passed' &&
    typeof item.rehearsalId === 'string' && item.rehearsalId !== '' &&
    typeof item.cohortId === 'string' && item.cohortId !== '' &&
    typeof item.performedAt === 'string' && Number.isFinite(Date.parse(item.performedAt)) &&
    typeof item.restoredRegistrySha256 === 'string' && SHA256.test(item.restoredRegistrySha256) &&
    typeof item.restoredMemoryLedgerSha256 === 'string' && SHA256.test(item.restoredMemoryLedgerSha256)
}

/** Durable rehearsal record: private, atomic, and never partially parsed. */
export function makeRollbackRehearsalStore(input: { path: string }): RollbackRehearsalStore {
  const read = (): WorkspaceV2RollbackRehearsal[] => {
    if (!existsSync(input.path)) return []
    try {
      if (statSync(input.path).size > MAX_STATE_BYTES) return []
      const parsed = JSON.parse(readFileSync(input.path, 'utf8')) as RehearsalStateV1
      if (typeof parsed !== 'object' || parsed === null || parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.rehearsals)) return []
      return parsed.rehearsals.filter(validRehearsal)
    } catch {
      return []
    }
  }

  return {
    load(cohortId: string) {
      const matching = read().filter(item => item.cohortId === cohortId)
      // Latest rehearsal wins; an older one for the same cohort is history.
      return matching[matching.length - 1] ?? null
    },

    save(rehearsal: WorkspaceV2RollbackRehearsal) {
      if (!validRehearsal(rehearsal)) throw new RollbackRehearsalError('cohort-invalid')
      const next: RehearsalStateV1 = { schemaVersion: 1, rehearsals: [...read(), rehearsal] }
      const directory = dirname(input.path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      const descriptor = openSync(temporary, 'r')
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(temporary, input.path)
    },
  }
}

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import {
  SESSION_ACTIVITY_MAX_CONTROL_BYTES,
  SessionActivityPersistenceError,
  type ActivityBinding,
  type SessionActivityJournalPersistencePort,
  type SessionActivityJournalStateV1,
  type SessionActivityQuarantineReason,
} from '@aisy/core'

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const STATE_FILE = 'activity-journal-v1.json'
const QUARANTINE_FILE = 'activity-journal-v1.quarantine.json'

export const SESSION_ACTIVITY_STORE_PREVIEW_ONLY = true as const

export class SessionActivityJournalStoreError extends Error {
  constructor(
    readonly code:
      | 'ACTIVITY_STORE_PATH_UNSAFE'
      | 'ACTIVITY_STORE_TOO_LARGE'
      | 'ACTIVITY_STORE_CAS_CONFLICT'
      | 'ACTIVITY_STORE_QUARANTINED'
      | 'ACTIVITY_STORE_IO_FAILED',
  ) {
    super(code)
    this.name = 'SessionActivityJournalStoreError'
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

export function sessionActivityBindingStorageKey(binding: ActivityBinding): string {
  if (![binding.operatorId, binding.profileId, binding.projectId, binding.sessionId]
    .every(part => typeof part === 'string' && ID.test(part))) {
    throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
  }
  return createHash('sha256')
    .update(JSON.stringify([
      'aisy.session-activity.storage-binding.v1', binding.operatorId,
      binding.profileId, binding.projectId, binding.sessionId,
    ]), 'utf8')
    .digest('hex')
}

function assertPrivateDirectory(path: string): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
    }
  } catch (error) {
    if (error instanceof SessionActivityJournalStoreError) throw error
    throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) {
    try { mkdirSync(path, { recursive: true, mode: 0o700 }) } catch {
      throw new SessionActivityJournalStoreError('ACTIVITY_STORE_IO_FAILED')
    }
  }
  assertPrivateDirectory(path)
}

function safeSessionDirectory(root: string, binding: ActivityBinding, create: boolean): string | null {
  const directory = join(root, sessionActivityBindingStorageKey(binding))
  if (!pathEntryExists(directory)) {
    if (!create) return null
    try { mkdirSync(directory, { mode: 0o700 }) } catch {
      throw new SessionActivityJournalStoreError('ACTIVITY_STORE_IO_FAILED')
    }
  }
  assertPrivateDirectory(directory)
  return directory
}

function readPrivateFile(path: string, maxBytes: number): string {
  let before
  try { before = lstatSync(path) } catch {
    throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes ||
    (before.mode & 0o077) !== 0) {
    throw new SessionActivityJournalStoreError(
      before.size > maxBytes ? 'ACTIVITY_STORE_TOO_LARGE' : 'ACTIVITY_STORE_PATH_UNSAFE',
    )
  }
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
    throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
  }
  try {
    const after = fstatSync(descriptor)
    if (!after.isFile() || after.size > maxBytes || (after.mode & 0o077) !== 0 ||
      before.dev !== after.dev || before.ino !== after.ino) {
      throw new SessionActivityJournalStoreError(
        after.size > maxBytes ? 'ACTIVITY_STORE_TOO_LARGE' : 'ACTIVITY_STORE_PATH_UNSAFE',
      )
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeAtomic(directory: string, target: string, content: string): void {
  const temporary = join(directory, `.activity-${process.pid}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    if (pathEntryExists(target)) {
      const current = lstatSync(target)
      if (!current.isFile() || current.isSymbolicLink() || (current.mode & 0o077) !== 0) {
        throw new SessionActivityJournalStoreError('ACTIVITY_STORE_PATH_UNSAFE')
      }
    }
    renameSync(temporary, target)
    syncPath(directory)
  } catch (error) {
    try { if (pathEntryExists(temporary)) unlinkSync(temporary) } catch { /* best-effort private temp cleanup */ }
    if (error instanceof SessionActivityJournalStoreError) throw error
    throw new SessionActivityJournalStoreError('ACTIVITY_STORE_IO_FAILED')
  }
}

function revisionFromRaw(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const revision = (value as Record<string, unknown>)['revision']
    return Number.isSafeInteger(revision) && Number(revision) >= 1 ? Number(revision) : null
  } catch {
    return null
  }
}

function sameBinding(a: ActivityBinding, b: ActivityBinding): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId
}

/**
 * Preview-only Node persistence. CAS and atomic publication are deterministic
 * inside one process, but this adapter intentionally does not claim or acquire
 * a multi-process singleton writer lease.
 */
export function makeNodeSessionActivityJournalPersistence(input: {
  root: string
}): SessionActivityJournalPersistencePort {
  const root = resolve(input.root)
  ensurePrivateDirectory(root)
  const observed = new Map<string, { revision: number; digest: string }>()

  const markQuarantined = (
    binding: ActivityBinding,
    reason: SessionActivityQuarantineReason,
  ): void => {
    const directory = safeSessionDirectory(root, binding, true)!
    const target = join(directory, QUARANTINE_FILE)
    if (pathEntryExists(target)) return
    const content = JSON.stringify({
      schemaVersion: 1,
      code: 'ACTIVITY_QUARANTINED',
      reason,
    }) + '\n'
    writeAtomic(directory, target, content)
  }

  return {
    async load(binding) {
      let directory: string | null
      try { directory = safeSessionDirectory(root, binding, false) } catch {
        return { status: 'quarantined' }
      }
      if (directory === null) return { status: 'missing' }
      const quarantinePath = join(directory, QUARANTINE_FILE)
      if (pathEntryExists(quarantinePath)) return { status: 'quarantined' }
      const statePath = join(directory, STATE_FILE)
      if (!pathEntryExists(statePath)) return { status: 'missing' }
      try {
        const raw = readPrivateFile(statePath, SESSION_ACTIVITY_MAX_CONTROL_BYTES)
        const value = JSON.parse(raw) as unknown
        const revision = revisionFromRaw(raw)
        if (revision === null) {
          markQuarantined(binding, 'invalid-state')
          return { status: 'quarantined' }
        }
        observed.set(sessionActivityBindingStorageKey(binding), { revision, digest: digest(raw) })
        return { status: 'ready', value }
      } catch {
        try { markQuarantined(binding, 'invalid-state') } catch { /* unsafe path remains denied */ }
        return { status: 'quarantined' }
      }
    },

    async commit({ binding, expectedRevision, state }) {
      if (!sameBinding(binding, state.binding)) {
        throw new SessionActivityPersistenceError('cas-conflict')
      }
      const content = JSON.stringify(state, null, 2) + '\n'
      if (Buffer.byteLength(content, 'utf8') > SESSION_ACTIVITY_MAX_CONTROL_BYTES) {
        throw new SessionActivityPersistenceError('unavailable')
      }
      try {
        const directory = safeSessionDirectory(root, binding, true)!
        const quarantinePath = join(directory, QUARANTINE_FILE)
        if (pathEntryExists(quarantinePath)) {
          throw new SessionActivityPersistenceError('unavailable')
        }
        const statePath = join(directory, STATE_FILE)
        if (expectedRevision === null) {
          if (pathEntryExists(statePath)) {
            throw new SessionActivityPersistenceError('cas-conflict')
          }
        } else {
          if (!pathEntryExists(statePath)) {
            throw new SessionActivityPersistenceError('cas-conflict')
          }
          const raw = readPrivateFile(statePath, SESSION_ACTIVITY_MAX_CONTROL_BYTES)
          const current = revisionFromRaw(raw)
          const prior = observed.get(sessionActivityBindingStorageKey(binding))
          if (current !== expectedRevision || prior?.revision !== expectedRevision ||
            prior.digest !== digest(raw)) {
            throw new SessionActivityPersistenceError('cas-conflict')
          }
        }
        writeAtomic(directory, statePath, content)
        observed.set(sessionActivityBindingStorageKey(binding), {
          revision: state.revision,
          digest: digest(content),
        })
      } catch (error) {
        if (error instanceof SessionActivityPersistenceError) throw error
        throw new SessionActivityPersistenceError('unavailable')
      }
    },

    async quarantine(binding, reason) {
      try { markQuarantined(binding, reason) } catch (error) {
        if (error instanceof SessionActivityJournalStoreError) throw error
        throw new SessionActivityJournalStoreError('ACTIVITY_STORE_IO_FAILED')
      }
    },
  }
}

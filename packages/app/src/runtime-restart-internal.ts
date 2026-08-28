// Internal restart receipt protocol (plan 11.9).
//
// The receipt is deliberately code-owned.  A restart is requested only after
// the receipt and its directory entry are durable; uncertainty keeps the
// current process alive and permanently closes this instance to later writes.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { restartCheckpoint } from './runtime-restart-checkpoint.js'

export type RestartRefusal =
  | 'not-supervised'
  | 'busy'
  | 'intent-not-durable'
  | 'restart-state-ambiguous'

export interface RestartIntent {
  readonly requestedAt: string
  readonly reason: string
  /** Turns that were running when the operator asked. */
  readonly activeTurns: number
}

export type RestartCommitResult =
  | 'committed'
  | 'already-committed'
  | 'not-supervised'
  | 'busy'
  | 'restart-state-ambiguous'

export type RestartCancelResult = 'cancelled' | 'already-cancelled' | 'restart-state-ambiguous'
export type RestartPreviousAckResult =
  | 'acknowledged'
  | 'already-acknowledged'
  | 'restart-state-ambiguous'

export interface RuntimeRestart {
  /**
   * Ask for a restart. Returns the recorded intent, or a refusal — a runtime
   * nobody would bring back up must not exit on request.
   */
  prepare(reason: string): RestartIntent | RestartRefusal
  /** Exit only for the exact, durably prepared object and at most once. */
  commitExit(intent: RestartIntent): Promise<RestartCommitResult>
  /** Durably remove an uncommitted intent after acknowledgement delivery fails. */
  cancel(intent: RestartIntent): RestartCancelResult
  /** The durably consumed intent of the run that exited, if there was one. */
  previous(): RestartIntent | null
  /** Remove the retained previous intent only after its transport update advanced. */
  acknowledgePrevious(intent: RestartIntent): RestartPreviousAckResult
}

const MAX_RECEIPT_BYTES = 4096

interface OwnedFile {
  dev: number
  ino: number
  uid: number
}

interface PrivateDirectory extends OwnedFile {
  fd: number
  path: string
}

class AmbiguousRestartState extends Error {}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new AmbiguousRestartState('POSIX uid is unavailable')
  }
  return Number(uid)
}

function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new AmbiguousRestartState('O_NOFOLLOW is unavailable')
  }
  return constants.O_NOFOLLOW
}

function directoryFlag(): number {
  if (!Number.isInteger(constants.O_DIRECTORY)) {
    throw new AmbiguousRestartState('O_DIRECTORY is unavailable')
  }
  return constants.O_DIRECTORY
}

function sameIdentity(value: { dev: number; ino: number }, owned: OwnedFile): boolean {
  return value.dev === owned.dev && value.ino === owned.ino
}

function isOwnedRegular(
  value: Stats,
  uid: number,
): boolean {
  return value.isFile()
    && !value.isSymbolicLink()
    && value.uid === uid
    && value.nlink === 1
}

function isPrivateRegular(value: Stats, uid: number): boolean {
  return isOwnedRegular(value, uid) && (value.mode & 0o777) === 0o600
}

function openPrivateDirectory(path: string): PrivateDirectory {
  const uid = currentUid()
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw new AmbiguousRestartState('restart directory unavailable')
  }

  let pathStat: Stats
  try {
    pathStat = lstatSync(path)
  } catch {
    throw new AmbiguousRestartState('restart directory cannot be inspected')
  }
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink() || pathStat.uid !== uid) {
    throw new AmbiguousRestartState('restart directory is not private and owned')
  }

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
  } catch {
    throw new AmbiguousRestartState('restart directory cannot be opened safely')
  }
  try {
    let opened = fstatSync(fd)
    if (!opened.isDirectory()
      || opened.uid !== uid
      || !sameIdentity(opened, pathStat)) {
      throw new AmbiguousRestartState('restart directory changed while opening')
    }
    // Tighten through the verified descriptor so a path swap cannot make chmod
    // follow a symlink.  We never widen or take ownership of somebody else's
    // directory.
    fchmodSync(fd, 0o700)
    opened = fstatSync(fd)
    if ((opened.mode & 0o777) !== 0o700 || !sameIdentity(opened, pathStat)) {
      throw new AmbiguousRestartState('restart directory mode is not 0700')
    }
    return { fd, path, dev: opened.dev, ino: opened.ino, uid }
  } catch (error) {
    closeQuietly(fd)
    if (error instanceof AmbiguousRestartState) throw error
    throw new AmbiguousRestartState('restart directory cannot be verified')
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return
  try {
    closeSync(fd)
  } catch {
    // Closing an already-verified descriptor changes neither file identity nor
    // the result of the preceding fsync.
  }
}

function assertDirectoryIdentity(directory: PrivateDirectory): void {
  let current: Stats
  try {
    current = lstatSync(directory.path)
  } catch {
    throw new AmbiguousRestartState('restart directory disappeared')
  }
  if (!current.isDirectory()
    || current.isSymbolicLink()
    || current.uid !== directory.uid
    || (current.mode & 0o777) !== 0o700
    || !sameIdentity(current, directory)) {
    throw new AmbiguousRestartState('restart directory identity changed')
  }
}

function statOwnedPrivateFile(path: string, owned: OwnedFile): boolean {
  try {
    const current = lstatSync(path)
    return isPrivateRegular(current, owned.uid) && sameIdentity(current, owned)
  } catch {
    return false
  }
}

function statOwnedRegularFile(path: string, owned: OwnedFile): boolean {
  try {
    const current = lstatSync(path)
    return isOwnedRegular(current, owned.uid) && sameIdentity(current, owned)
  } catch {
    return false
  }
}

function pathIsAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw new AmbiguousRestartState('restart receipt cannot be inspected')
  }
}

function isUtcIsoTimestamp(value: string): boolean {
  if (value.length === 0 || value.length > 64 || value !== value.trim()) return false
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return false
  const canonical = new Date(epoch).toISOString()
  return value === canonical || value === canonical.replace('.000Z', 'Z')
}

function decode(raw: string): RestartIntent | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (keys.length !== 3
    || keys[0] !== 'activeTurns'
    || keys[1] !== 'reason'
    || keys[2] !== 'requestedAt') return null
  if (typeof input['requestedAt'] !== 'string'
    || !isUtcIsoTimestamp(input['requestedAt'])) return null
  if (typeof input['reason'] !== 'string'
    || input['reason'].length === 0
    || input['reason'].length > 500
    || input['reason'] !== input['reason'].replace(/\s+/g, ' ').trim()) return null
  const turns = input['activeTurns']
  if (!Number.isSafeInteger(turns) || Number(turns) < 0) return null
  return {
    requestedAt: input['requestedAt'],
    reason: input['reason'],
    activeTurns: Number(turns),
  }
}

function decodeBytes(bytes: Buffer): RestartIntent | null {
  try {
    return decode(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
}

function sameRestartIntent(left: RestartIntent, right: RestartIntent): boolean {
  return left.requestedAt === right.requestedAt &&
    left.reason === right.reason &&
    left.activeTurns === right.activeTurns
}

function readBoundedReceipt(fd: number, uid: number): { intent: RestartIntent | null; owned: OwnedFile } {
  const before = fstatSync(fd)
  if (!isPrivateRegular(before, uid) || before.size > MAX_RECEIPT_BYTES) {
    throw new AmbiguousRestartState('restart receipt is not a bounded private regular file')
  }

  const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1)
  let read = 0
  while (read < buffer.length) {
    const count = readSync(fd, buffer, read, buffer.length - read, read)
    if (count === 0) break
    read += count
  }
  const after = fstatSync(fd)
  if (read > MAX_RECEIPT_BYTES
    || !isPrivateRegular(after, uid)
    || !sameIdentity(after, before)
    || after.size !== read) {
    throw new AmbiguousRestartState('restart receipt changed while reading')
  }
  return {
    intent: decodeBytes(buffer.subarray(0, read)),
    owned: { dev: after.dev, ino: after.ino, uid },
  }
}

function rollbackConsumedReceipt(
  path: string,
  previousPath: string,
  owned: OwnedFile,
  directory: PrivateDirectory,
): boolean {
  try {
    assertDirectoryIdentity(directory)
    if (!pathIsAbsent(path) || !statOwnedPrivateFile(previousPath, owned)) return false
    restartCheckpoint('consume:before-rollback-rename')
    renameSync(previousPath, path)
    restartCheckpoint('consume:before-rollback-dir-fsync')
    fsyncSync(directory.fd)
    return true
  } catch {
    return false
  }
}

function readRetainedPrevious(
  previousPath: string,
  directory: PrivateDirectory,
): { previous: RestartIntent | null; previousOwned: OwnedFile | null } {
  let receipt: number | null = null
  try {
    receipt = openSync(previousPath, constants.O_RDONLY | noFollowFlag())
    const read = readBoundedReceipt(receipt, directory.uid)
    return read.intent === null
      ? { previous: null, previousOwned: null }
      : { previous: read.intent, previousOwned: read.owned }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { previous: null, previousOwned: null }
    // The retained file is evidence for transport deduplication, not authority
    // to restart. Unsafe or malformed residue must never block a fresh runtime.
    return { previous: null, previousOwned: null }
  } finally {
    closeQuietly(receipt)
  }
}

function consumePrevious(path: string): {
  previous: RestartIntent | null
  previousOwned: OwnedFile | null
  ambiguous: boolean
} {
  let directory: PrivateDirectory | null = null
  let receipt: number | null = null
  let moved = false
  let owned: OwnedFile | null = null
  const previousPath = `${path}.previous`
  try {
    directory = openPrivateDirectory(dirname(path))
    assertDirectoryIdentity(directory)
    try {
      receipt = openSync(path, constants.O_RDONLY | noFollowFlag())
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { ...readRetainedPrevious(previousPath, directory), ambiguous: false }
      }
      throw new AmbiguousRestartState('restart receipt cannot be opened safely')
    }
    const read = readBoundedReceipt(receipt, directory.uid)
    owned = read.owned
    const consumedDescriptor = receipt
    receipt = null
    closeSync(consumedDescriptor)

    assertDirectoryIdentity(directory)
    if (!statOwnedPrivateFile(path, owned)) {
      throw new AmbiguousRestartState('restart receipt identity changed before consume')
    }
    restartCheckpoint('consume:before-rename')
    renameSync(path, previousPath)
    moved = true
    restartCheckpoint('consume:after-rename')
    restartCheckpoint('consume:before-dir-fsync')
    fsyncSync(directory.fd)
    restartCheckpoint('consume:after-dir-fsync')
    return {
      previous: read.intent,
      previousOwned: read.intent === null ? null : read.owned,
      ambiguous: false,
    }
  } catch {
    if (moved && owned !== null && directory !== null
      && rollbackConsumedReceipt(path, previousPath, owned, directory)) {
      return { previous: null, previousOwned: null, ambiguous: false }
    }
    return { previous: null, previousOwned: null, ambiguous: true }
  } finally {
    closeQuietly(receipt)
    closeQuietly(directory?.fd ?? null)
  }
}

function cleanOwnedTemporary(path: string, owned: OwnedFile | null, uid: number | null): void {
  if (path === '') return
  if (owned !== null && !statOwnedRegularFile(path, owned)) return
  if (owned === null) {
    if (uid === null) return
    try {
      // The path was randomly generated and exclusively created inside the
      // verified 0700 directory.  This fallback covers a failed first fstat;
      // it still refuses symlinks, non-regular files and foreign ownership.
      if (!isOwnedRegular(lstatSync(path), uid)) return
    } catch {
      return
    }
  }
  try {
    unlinkSync(path)
  } catch {
    // A private non-authoritative temporary is harmless; a future request uses
    // a fresh random name and never treats this file as a receipt.
  }
}

function rollbackPublishedReceipt(
  path: string,
  owned: OwnedFile,
  directory: PrivateDirectory,
): boolean {
  try {
    assertDirectoryIdentity(directory)
    if (!statOwnedPrivateFile(path, owned)) return false
    restartCheckpoint('publish:before-rollback-unlink')
    unlinkSync(path)
    restartCheckpoint('publish:before-rollback-dir-fsync')
    fsyncSync(directory.fd)
    return true
  } catch {
    return false
  }
}

function cancelPublishedReceipt(path: string, owned: OwnedFile): boolean {
  let directory: PrivateDirectory | null = null
  try {
    directory = openPrivateDirectory(dirname(path))
    assertDirectoryIdentity(directory)
    if (!statOwnedPrivateFile(path, owned)) return false
    restartCheckpoint('cancel:before-unlink')
    unlinkSync(path)
    restartCheckpoint('cancel:before-dir-fsync')
    fsyncSync(directory.fd)
    return true
  } catch {
    return false
  } finally {
    closeQuietly(directory?.fd ?? null)
  }
}

function publishIntent(
  path: string,
  intent: RestartIntent,
): { kind: 'durable'; owned: OwnedFile } | { kind: 'not-durable' } | { kind: 'ambiguous' } {
  let directory: PrivateDirectory | null = null
  let file: number | null = null
  let temporary = ''
  let owned: OwnedFile | null = null
  let renamed = false
  try {
    directory = openPrivateDirectory(dirname(path))
    assertDirectoryIdentity(directory)
    if (!pathIsAbsent(path)) throw new AmbiguousRestartState('restart receipt already exists')

    temporary = join(directory.path, `.${basename(path)}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`)
    file = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    )
    restartCheckpoint('publish:after-open-before-stat')
    const created = fstatSync(file)
    owned = { dev: created.dev, ino: created.ino, uid: directory.uid }
    if (!isOwnedRegular(created, directory.uid)) {
      throw new Error('restart temporary failed ownership validation')
    }
    fchmodSync(file, 0o600)
    const privateCreated = fstatSync(file)
    if (!isPrivateRegular(privateCreated, directory.uid) || !sameIdentity(privateCreated, owned)) {
      throw new Error('restart temporary failed validation')
    }
    writeFileSync(file, JSON.stringify(intent, null, 2) + '\n')
    const written = fstatSync(file)
    if (!isPrivateRegular(written, directory.uid)
      || !sameIdentity(written, owned)
      || written.size > MAX_RECEIPT_BYTES) {
      throw new Error('restart receipt failed validation')
    }
    restartCheckpoint('publish:before-file-fsync')
    fsyncSync(file)
    restartCheckpoint('publish:after-file-fsync')
    const publishedDescriptor = file
    file = null
    closeSync(publishedDescriptor)

    assertDirectoryIdentity(directory)
    if (!pathIsAbsent(path) || !statOwnedPrivateFile(temporary, owned)) {
      throw new AmbiguousRestartState('restart publication target changed')
    }
    restartCheckpoint('publish:before-rename')
    renameSync(temporary, path)
    renamed = true
    restartCheckpoint('publish:after-rename')
    if (!statOwnedPrivateFile(path, owned)) {
      throw new AmbiguousRestartState('published restart receipt changed identity')
    }
    restartCheckpoint('publish:before-dir-fsync')
    fsyncSync(directory.fd)
    restartCheckpoint('publish:after-dir-fsync')
    return { kind: 'durable', owned }
  } catch (error) {
    if (renamed && owned !== null && directory !== null) {
      return { kind: rollbackPublishedReceipt(path, owned, directory) ? 'not-durable' : 'ambiguous' }
    }
    cleanOwnedTemporary(temporary, owned, directory?.uid ?? null)
    return { kind: error instanceof AmbiguousRestartState ? 'ambiguous' : 'not-durable' }
  } finally {
    closeQuietly(file)
    closeQuietly(directory?.fd ?? null)
  }
}

export interface RuntimeRestartDeps {
  path: string
  nowIso: () => string
  /** True only when a supervisor is configured to bring this process back. */
  supervised: () => boolean
  /** How many turns are running right now. */
  activeTurns: () => number
  /** Obtain one short-lived permit from the authenticated parent supervisor. */
  authorizePlannedRestart: (intentHash: string) => Promise<void>
  /** Called only after the intent and directory entry are durable. */
  exit: (intent: RestartIntent) => void
}

function restartIntentHash(intent: RestartIntent): string {
  return createHash('sha256')
    .update('aisy.runtime-restart.intent.v1\0')
    .update(JSON.stringify({
      requestedAt: intent.requestedAt,
      reason: intent.reason,
      activeTurns: intent.activeTurns,
    }))
    .digest('hex')
}

export function makeRuntimeRestartInternal(
  deps: RuntimeRestartDeps,
): RuntimeRestart {
  const consumed = consumePrevious(deps.path)
  let ambiguous = consumed.ambiguous
  let prepared: RestartIntent | null = null
  let preparedOwned: OwnedFile | null = null
  let cancelled: RestartIntent | null = null
  let committed = false

  const cancelPreparedAtCommit = (
    intent: RestartIntent,
    result: 'not-supervised' | 'busy',
  ): RestartCommitResult => {
    if (prepared !== intent || preparedOwned === null
      || !cancelPublishedReceipt(deps.path, preparedOwned)) {
      ambiguous = true
      return 'restart-state-ambiguous'
    }
    cancelled = intent
    prepared = null
    preparedOwned = null
    return result
  }

  return {
    previous: () => (consumed.previous === null ? null : { ...consumed.previous }),

    acknowledgePrevious(intent) {
      if (consumed.previous === null || consumed.previousOwned === null) {
        return 'already-acknowledged'
      }
      if (!sameRestartIntent(consumed.previous, intent)) return 'restart-state-ambiguous'
      if (!cancelPublishedReceipt(`${deps.path}.previous`, consumed.previousOwned)) {
        ambiguous = true
        return 'restart-state-ambiguous'
      }
      consumed.previous = null
      consumed.previousOwned = null
      return 'acknowledged'
    },

    prepare(reason) {
      if (ambiguous) return 'restart-state-ambiguous'
      if (prepared !== null) return prepared
      if (!deps.supervised()) return 'not-supervised'
      const active = deps.activeTurns()
      if (active > 0) return 'busy'

      const intent: RestartIntent = Object.freeze({
        requestedAt: deps.nowIso(),
        reason: reason.replace(/\s+/g, ' ').trim().slice(0, 500) || 'по просьбе оператора',
        activeTurns: active,
      })
      // The same exact schema is required both when publishing and recovering;
      // malformed code-owned input must not create a receipt that the next run
      // would reject.
      if (decode(JSON.stringify(intent)) === null) return 'intent-not-durable'
      const publication = publishIntent(deps.path, intent)
      if (publication.kind === 'ambiguous') {
        ambiguous = true
        return 'restart-state-ambiguous'
      }
      if (publication.kind === 'not-durable') return 'intent-not-durable'

      prepared = intent
      preparedOwned = publication.owned
      return intent
    },

    cancel(intent) {
      if (cancelled === intent) return 'already-cancelled'
      if (ambiguous || committed || prepared === null || preparedOwned === null || intent !== prepared) {
        return 'restart-state-ambiguous'
      }
      if (!cancelPublishedReceipt(deps.path, preparedOwned)) {
        ambiguous = true
        return 'restart-state-ambiguous'
      }
      cancelled = intent
      prepared = null
      preparedOwned = null
      return 'cancelled'
    },

    async commitExit(intent) {
      if (ambiguous || prepared === null || intent !== prepared) return 'restart-state-ambiguous'
      if (committed) return 'already-committed'
      // Admission is deliberately rechecked at the irreversible boundary. A
      // supervisor can disappear and a new turn can start while Telegram is
      // accepting the operator-facing acknowledgement.
      if (!deps.supervised()) return cancelPreparedAtCommit(intent, 'not-supervised')
      if (deps.activeTurns() > 0) return cancelPreparedAtCommit(intent, 'busy')
      try {
        await deps.authorizePlannedRestart(restartIntentHash(intent))
      } catch {
        return cancelPreparedAtCommit(intent, 'not-supervised')
      }
      // Nothing asynchronous may occur after this last admission check. The
      // parent permit is short-lived and applies only to the current session.
      if (!deps.supervised()) return cancelPreparedAtCommit(intent, 'not-supervised')
      if (deps.activeTurns() > 0) return cancelPreparedAtCommit(intent, 'busy')
      committed = true
      try {
        deps.exit(intent)
      } catch {
        ambiguous = true
        return 'restart-state-ambiguous'
      }
      return 'committed'
    },
  }
}

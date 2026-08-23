import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_OWNER_BYTES = 4096
const MAX_ARCHIVED_RECOVERIES = 64
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/
const RECOVERY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export type MediaInboxWriterLockInspection =
  | { readonly state: 'absent'; readonly archivedRecoveries: number }
  | {
    readonly state: 'held'
    readonly ownerFingerprint: string
    readonly acquiredAt: string
    readonly archivedRecoveries: number
  }
  /**
   * Захват оборвался на середине: директория lock есть, владельца в ней нет.
   *
   * Это не «повреждённое состояние», требующее человека. Писатель, не успевший
   * записать владельца, ничего не писал и в inbox: между `mkdir` и `owner.json`
   * его убили — рестартом, OOM или падением. Отличать этот случай пришлось
   * потому, что иначе он читался как `corrupt` и выключал приём вложений и
   * голоса навсегда: ни один код не умел его разобрать.
   */
  | { readonly state: 'abandoned'; readonly archivedRecoveries: number }
  | { readonly state: 'corrupt'; readonly archivedRecoveries: number }

export type MediaInboxWriterRecoveryCode =
  | 'INVALID_REQUEST'
  | 'WRITER_LOCK_ABSENT'
  | 'WRITER_LOCK_CHANGED'
  | 'WRITER_LOCK_HELD'
  | 'RECOVERY_NOT_AUTHORIZED'
  | 'RUNTIME_NOT_QUIESCENT'
  | 'RECOVERY_COLLISION'
  | 'RECOVERY_ARCHIVE_MISSING'
  | 'STATE_CORRUPT'
  | 'RECOVERY_INCOMPLETE'
  | 'UNSUPPORTED_PLATFORM'

export class MediaInboxWriterRecoveryError extends Error {
  constructor(public readonly code: MediaInboxWriterRecoveryCode) {
    super(code)
    this.name = 'MediaInboxWriterRecoveryError'
  }
}

export interface MediaInboxWriterRecoveryAuthorizationPort {
  /** Atomically validates and consumes one exact approval grant. */
  consume(input: {
    readonly action: 'archive-abandoned-writer-lock' | 'restore-archived-writer-lock'
    readonly actionHash: string
    readonly approval: unknown
  }): boolean
}

export interface MediaInboxWriterQuiescenceLease {
  /** True only while runtime startup is blocked and all prior ingests are drained. */
  assertHeld(): boolean
  release(): void
}

export interface MediaInboxWriterQuiescencePort {
  acquire(): MediaInboxWriterQuiescenceLease | null
}

export interface MediaInboxWriterRecovery {
  inspect(): MediaInboxWriterLockInspection
  archive(input: {
    readonly expectedOwnerFingerprint: string
    readonly approval: unknown
  }): { readonly recoveryId: string; readonly ownerFingerprint: string }
  /**
   * Убирает оборванный захват — пустую директорию lock без владельца.
   *
   * Без approval намеренно: одобрять здесь нечего. Архивация отбирает lock у
   * писателя, который мог что-то писать, и потому спрашивает; пустая директория
   * не принадлежит никому — владельца в ней не появилось, а значит и записи в
   * inbox не начиналось. Тишина рантайма всё же проверяется: удалять чужой путь
   * посреди чужой работы нельзя даже пустой.
   *
   * Возвращает `false`, если убирать нечего.
   */
  discardAbandoned(): boolean
  restore(input: {
    readonly recoveryId: string
    readonly expectedOwnerFingerprint: string
    readonly approval: unknown
  }): { readonly ownerFingerprint: string }
}

interface ParsedOwner {
  readonly raw: string
  readonly fingerprint: string
  readonly acquiredAt: string
}

function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new MediaInboxWriterRecoveryError('UNSUPPORTED_PLATFORM')
  }
  return constants.O_NOFOLLOW
}

function privateDirectory(path: string): void {
  const canonical = resolve(path)
  const info = lstatSync(canonical)
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid ||
    (info.mode & 0o077) !== 0 || realpathSync(canonical) !== canonical) {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
}

function privateExistingAncestor(path: string): void {
  let candidate = resolve(path)
  while (!pathExists(candidate)) {
    const parent = resolve(candidate, '..')
    if (parent === candidate) throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
    candidate = parent
  }
  privateDirectory(candidate)
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | noFollow())
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    ![...value].some(character => character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127) && Buffer.byteLength(value, 'utf8') <= maximum
}

function parseOwner(directory: string): ParsedOwner {
  privateDirectory(directory)
  const entries = readdirSync(directory)
  if (entries.length !== 1 || entries[0] !== 'owner.json') {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  const ownerPath = join(directory, 'owner.json')
  let descriptor: number
  try { descriptor = openSync(ownerPath, constants.O_RDONLY | noFollow()) } catch {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  let raw: string
  try {
    const info = fstatSync(descriptor)
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.nlink !== 1 || info.uid !== expectedUid ||
      (info.mode & 0o077) !== 0 || info.size < 1 || info.size > MAX_OWNER_BYTES) {
      throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
    }
    raw = readFileSync(descriptor, 'utf8')
  } catch (error) {
    if (error instanceof MediaInboxWriterRecoveryError) throw error
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  } finally {
    try { closeSync(descriptor) } catch {
      throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
    }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  const owner = parsed as Record<string, unknown>
  const keys = Object.keys(owner).sort()
  if (JSON.stringify(keys) !== JSON.stringify(['acquiredAt', 'nonce', 'pid', 'version']) ||
    owner['version'] !== 1 || !Number.isSafeInteger(owner['pid']) ||
    (owner['pid'] as number) < 1 || !safeText(owner['nonce'], 256) ||
    !safeText(owner['acquiredAt'], 128) ||
    !Number.isFinite(Date.parse(owner['acquiredAt'] as string))) {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  return Object.freeze({
    raw,
    fingerprint: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    acquiredAt: owner['acquiredAt'] as string,
  })
}

function archivedRecoveryCount(root: string): number {
  const archiveRoot = join(root, '.writer-lock-recovery')
  if (!pathExists(archiveRoot)) return 0
  privateDirectory(archiveRoot)
  const entries = readdirSync(archiveRoot)
  if (entries.length > MAX_ARCHIVED_RECOVERIES) {
    throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
  }
  for (const entry of entries) {
    if (!entry.startsWith('recovery-') || !RECOVERY_ID.test(entry.slice('recovery-'.length))) {
      throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
    }
    parseOwner(join(archiveRoot, entry))
  }
  return entries.length
}

export function inspectMediaInboxWriterLock(input: {
  inboxRoot: string
}): MediaInboxWriterLockInspection {
  const root = resolve(input.inboxRoot)
  try {
    if (!pathExists(root)) {
      privateExistingAncestor(root)
      return { state: 'absent', archivedRecoveries: 0 }
    }
    privateDirectory(root)
    const archivedRecoveries = archivedRecoveryCount(root)
    const lockPath = join(root, '.writer.lock')
    if (!pathExists(lockPath)) return { state: 'absent', archivedRecoveries }
    privateDirectory(lockPath)
    if (readdirSync(lockPath).length === 0) return { state: 'abandoned', archivedRecoveries }
    const owner = parseOwner(lockPath)
    return Object.freeze({
      state: 'held',
      ownerFingerprint: owner.fingerprint,
      acquiredAt: owner.acquiredAt,
      archivedRecoveries,
    })
  } catch {
    return { state: 'corrupt', archivedRecoveries: 0 }
  }
}

function actionHash(input: {
  action: 'archive-abandoned-writer-lock' | 'restore-archived-writer-lock'
  rootIdentity: string
  ownerFingerprint: string
  recoveryId?: string
}): string {
  return createHash('sha256').update(JSON.stringify([
    'aisy.media-inbox-writer-recovery.v1',
    input.action,
    input.rootIdentity,
    input.ownerFingerprint,
    input.recoveryId ?? null,
  ])).digest('hex')
}

function authorized(
  port: MediaInboxWriterRecoveryAuthorizationPort,
  input: {
    action: 'archive-abandoned-writer-lock' | 'restore-archived-writer-lock'
    rootIdentity: string
    ownerFingerprint: string
    recoveryId?: string
    approval: unknown
  },
): void {
  let allowed = false
  try {
    allowed = port.consume({
      action: input.action,
      actionHash: actionHash(input),
      approval: input.approval,
    }) === true
  } catch { /* code-only refusal */ }
  if (!allowed) throw new MediaInboxWriterRecoveryError('RECOVERY_NOT_AUTHORIZED')
}

function acquireQuiescence(port: MediaInboxWriterQuiescencePort): MediaInboxWriterQuiescenceLease {
  let lease: MediaInboxWriterQuiescenceLease | null = null
  try { lease = port.acquire() } catch { /* code-only refusal */ }
  if (lease === null) throw new MediaInboxWriterRecoveryError('RUNTIME_NOT_QUIESCENT')
  try {
    if (lease.assertHeld() !== true) throw new MediaInboxWriterRecoveryError('RUNTIME_NOT_QUIESCENT')
  } catch (error) {
    try { lease.release() } catch { /* preserve refusal */ }
    if (error instanceof MediaInboxWriterRecoveryError) throw error
    throw new MediaInboxWriterRecoveryError('RUNTIME_NOT_QUIESCENT')
  }
  return lease
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists and belongs to someone else. Only ESRCH
    // proves it is gone; anything else is treated as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Quiescence by proof that the writer that held the lock no longer exists.
 *
 * This is the only quiescence a fresh process can honestly assert: it has not
 * yet opened the inbox, so if the recorded pid is dead nobody is writing. A pid
 * that is alive — including a newer agent that already took over — refuses.
 */
export function makeDeadWriterQuiescence(input: {
  inboxRoot: string
  isProcessAlive?: (pid: number) => boolean
}): MediaInboxWriterQuiescencePort {
  const lockPath = join(resolve(input.inboxRoot), '.writer.lock')
  const isProcessAlive = input.isProcessAlive ?? defaultProcessAlive
  const abandoned = (): boolean => {
    try {
      // Оборванный захват: директория есть, владельца в ней нет. Доказательство
      // тишины здесь прямее, чем мёртвый pid, — никакой процесс не успел
      // объявить себя писателем, а значит и писать не начинал. Прежде этот
      // случай проваливался в catch и читался как «рантайм занят», из-за чего
      // уборка не начиналась никогда.
      if (readdirSync(lockPath).length === 0) return true
    } catch {
      return false
    }
    try {
      const owner = JSON.parse(parseOwner(lockPath).raw) as { pid: number }
      return owner.pid !== process.pid && !isProcessAlive(owner.pid)
    } catch {
      return false
    }
  }
  return Object.freeze<MediaInboxWriterQuiescencePort>({
    acquire: () => abandoned()
      ? Object.freeze({ assertHeld: abandoned, release: () => undefined })
      : null,
  })
}

/**
 * Approval for a recovery nobody is present to approve.
 *
 * The guarantee here is not consent — it is the liveness proof in the
 * quiescence port plus the fingerprint the archive re-checks. Never use this
 * where an operator could be asked.
 */
export const unattendedRecoveryAuthorization: MediaInboxWriterRecoveryAuthorizationPort =
  Object.freeze({ consume: () => true })

export function makeMediaInboxWriterRecovery(input: {
  inboxRoot: string
  authorization: MediaInboxWriterRecoveryAuthorizationPort
  quiescence: MediaInboxWriterQuiescencePort
  newId?: () => string
}): MediaInboxWriterRecovery {
  const root = resolve(input.inboxRoot)
  const rootIdentity = createHash('sha256').update(root).digest('hex')
  const lockPath = join(root, '.writer.lock')
  const archiveRoot = join(root, '.writer-lock-recovery')
  const newId = input.newId ?? randomUUID

  return Object.freeze({
    inspect: () => inspectMediaInboxWriterLock({ inboxRoot: root }),

    discardAbandoned(): boolean {
      if (inspectMediaInboxWriterLock({ inboxRoot: root }).state !== 'abandoned') return false
      const lease = acquireQuiescence(input.quiescence)
      try {
        // Состояние перепроверяется под lease: между осмотром и удалением
        // прерванный писатель мог дописать владельца и стать настоящим.
        const current = inspectMediaInboxWriterLock({ inboxRoot: root })
        if (current.state !== 'abandoned' || lease.assertHeld() !== true) return false
        privateDirectory(root)
        rmdirSync(lockPath)
        syncDirectory(root)
        return inspectMediaInboxWriterLock({ inboxRoot: root }).state === 'absent'
      } catch (error) {
        if (error instanceof MediaInboxWriterRecoveryError) throw error
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      } finally {
        try { lease.release() } catch { /* уборка состоялась или не начиналась */ }
      }
    },

    archive(request: {
      readonly expectedOwnerFingerprint: string
      readonly approval: unknown
    }) {
      if (!FINGERPRINT.test(request.expectedOwnerFingerprint)) {
        throw new MediaInboxWriterRecoveryError('INVALID_REQUEST')
      }
      const before = inspectMediaInboxWriterLock({ inboxRoot: root })
      if (before.state === 'absent') throw new MediaInboxWriterRecoveryError('WRITER_LOCK_ABSENT')
      // Оборванный захват архивировать нечего и не от кого: у него нет
      // владельца, с которым сверяют fingerprint. Его убирает discardAbandoned.
      if (before.state === 'abandoned') {
        throw new MediaInboxWriterRecoveryError('WRITER_LOCK_ABSENT')
      }
      if (before.state === 'corrupt') throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
      if (before.ownerFingerprint !== request.expectedOwnerFingerprint) {
        throw new MediaInboxWriterRecoveryError('WRITER_LOCK_CHANGED')
      }
      authorized(input.authorization, {
        action: 'archive-abandoned-writer-lock',
        rootIdentity,
        ownerFingerprint: before.ownerFingerprint,
        approval: request.approval,
      })
      const lease = acquireQuiescence(input.quiescence)
      let operationFailed = false
      try {
        const current = inspectMediaInboxWriterLock({ inboxRoot: root })
        if (current.state !== 'held' ||
          current.ownerFingerprint !== request.expectedOwnerFingerprint ||
          lease.assertHeld() !== true) {
          throw new MediaInboxWriterRecoveryError('WRITER_LOCK_CHANGED')
        }
        const recoveryId = newId()
        if (!safeText(recoveryId, 64) || !RECOVERY_ID.test(recoveryId)) {
          throw new MediaInboxWriterRecoveryError('STATE_CORRUPT')
        }
        privateDirectory(root)
        if (!pathExists(archiveRoot)) {
          mkdirSync(archiveRoot, { mode: 0o700 })
          syncDirectory(root)
        } else {
          privateDirectory(archiveRoot)
        }
        const target = join(archiveRoot, `recovery-${recoveryId}`)
        if (pathExists(target)) throw new MediaInboxWriterRecoveryError('RECOVERY_COLLISION')
        renameSync(lockPath, target)
        syncDirectory(archiveRoot)
        syncDirectory(root)
        const archived = parseOwner(target)
        if (archived.fingerprint !== request.expectedOwnerFingerprint ||
          inspectMediaInboxWriterLock({ inboxRoot: root }).state !== 'absent') {
          throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
        return Object.freeze({ recoveryId, ownerFingerprint: archived.fingerprint })
      } catch (error) {
        operationFailed = true
        if (error instanceof MediaInboxWriterRecoveryError) throw error
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      } finally {
        try { lease.release() } catch {
          if (!operationFailed) throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
      }
    },

    restore(request: {
      readonly recoveryId: string
      readonly expectedOwnerFingerprint: string
      readonly approval: unknown
    }) {
      if (!RECOVERY_ID.test(request.recoveryId) ||
        !FINGERPRINT.test(request.expectedOwnerFingerprint)) {
        throw new MediaInboxWriterRecoveryError('INVALID_REQUEST')
      }
      authorized(input.authorization, {
        action: 'restore-archived-writer-lock',
        rootIdentity,
        ownerFingerprint: request.expectedOwnerFingerprint,
        recoveryId: request.recoveryId,
        approval: request.approval,
      })
      const lease = acquireQuiescence(input.quiescence)
      let operationFailed = false
      try {
        privateDirectory(root)
        if (pathExists(lockPath)) throw new MediaInboxWriterRecoveryError('WRITER_LOCK_HELD')
        const source = join(archiveRoot, `recovery-${request.recoveryId}`)
        if (!pathExists(source)) {
          throw new MediaInboxWriterRecoveryError('RECOVERY_ARCHIVE_MISSING')
        }
        const archived = parseOwner(source)
        if (archived.fingerprint !== request.expectedOwnerFingerprint ||
          lease.assertHeld() !== true) {
          throw new MediaInboxWriterRecoveryError('WRITER_LOCK_CHANGED')
        }
        mkdirSync(lockPath, { mode: 0o700 })
        let descriptor: number
        try {
          descriptor = openSync(
            join(lockPath, 'owner.json'),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
            0o600,
          )
          try {
            writeFileSync(descriptor, archived.raw, 'utf8')
            fsyncSync(descriptor)
          } finally {
            closeSync(descriptor)
          }
          syncDirectory(lockPath)
          syncDirectory(root)
        } catch {
          throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
        const restored = parseOwner(lockPath)
        if (restored.fingerprint !== request.expectedOwnerFingerprint) {
          throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
        return Object.freeze({ ownerFingerprint: restored.fingerprint })
      } catch (error) {
        operationFailed = true
        if (error instanceof MediaInboxWriterRecoveryError) throw error
        throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
      } finally {
        try { lease.release() } catch {
          if (!operationFailed) throw new MediaInboxWriterRecoveryError('RECOVERY_INCOMPLETE')
        }
      }
    },
  })
}

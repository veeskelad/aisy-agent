// Kernel-released singleton writer lease for the session journal (ADR-0068).

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'

import {
  acquirePrivateSqliteLease,
  inspectPrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseIdentityV1,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

/** Legacy path is retained as a permanent downgrade-compatibility barrier. */
export const TRANSCRIPT_WRITER_LOCK_DIRNAME = '.transcript-writer.lock'
export const TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME = '.transcript-writer-lease'
export const TRANSCRIPT_WRITER_LEASE_DB_FILENAME = 'transcript-writer-lease.sqlite3'

const APPLICATION_ID = 0x41495359
const DATABASE_ID = /^[a-f0-9]{64}$/
const DECIMAL_ID = /^(0|[1-9][0-9]{0,19})$/
const TRANSCRIPT_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'transcript-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const PROFILE: PrivateSqliteLeaseProfile = {
  role: 'transcript-writer',
  filename: TRANSCRIPT_WRITER_LEASE_DB_FILENAME,
  applicationId: APPLICATION_ID,
  userVersion: 1,
  exactSchemaSql: TRANSCRIPT_SCHEMA,
}

export type TranscriptWriterLeaseRefusal =
  | 'held-by-another-process'
  | 'legacy-residue'
  | 'lease-unsafe'
  | 'lease-corrupt'
  | 'lease-unavailable'
  | 'lease-lost'

export class TranscriptWriterLeaseError extends Error {
  constructor(readonly reason: TranscriptWriterLeaseRefusal) {
    super('transcript writer lease refused: ' + reason)
    this.name = 'TranscriptWriterLeaseError'
  }
}

export interface TranscriptWriterLease {
  readonly identity: PrivateSqliteLeaseIdentityV1
  /** Re-check kernel ownership, immutable DB identity and compatibility barrier. */
  assertOwned(): void
  /** Release only the kernel transaction; durable identity and barrier remain. */
  release(): void
}

export interface TranscriptWriterLeaseInspection {
  state: 'absent' | 'held' | 'corrupt'
}

interface TranscriptWriterBarrierV1 {
  version: 1
  kind: 'transcript-writer-sqlite-v1'
  databaseId: string
  dev: string
  ino: string
}

interface TranscriptWriterAnchorV1 {
  version: 1
  role: 'transcript-writer'
  databaseId: string
  dev: string
  ino: string
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  return Number(uid)
}

function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new TranscriptWriterLeaseError('lease-unavailable')
  return constants.O_NOFOLLOW
}

function directoryFlag(): number {
  if (!Number.isInteger(constants.O_DIRECTORY)) throw new TranscriptWriterLeaseError('lease-unavailable')
  return constants.O_DIRECTORY
}

function sameIdentity(
  a: { dev: number | bigint; ino: number | bigint },
  b: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
}

function privateRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid &&
    stat.nlink === 1 && (stat.mode & 0o777) === 0o600
}

function mapPrivateError(error: unknown): TranscriptWriterLeaseError {
  if (error instanceof TranscriptWriterLeaseError) return error
  if (!(error instanceof PrivateSqliteLeaseError)) {
    return new TranscriptWriterLeaseError('lease-unavailable')
  }
  switch (error.failure) {
    case 'busy': return new TranscriptWriterLeaseError('held-by-another-process')
    case 'unsafe': return new TranscriptWriterLeaseError('lease-unsafe')
    case 'corrupt': return new TranscriptWriterLeaseError('lease-corrupt')
    case 'unavailable': return new TranscriptWriterLeaseError('lease-unavailable')
    case 'lost': return new TranscriptWriterLeaseError('lease-lost')
  }
}

function decodeBarrier(raw: string): TranscriptWriterBarrierV1 | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 5) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.kind !== 'transcript-writer-sqlite-v1' ||
    typeof record.databaseId !== 'string' || !DATABASE_ID.test(record.databaseId) ||
    typeof record.dev !== 'string' || !DECIMAL_ID.test(record.dev) ||
    typeof record.ino !== 'string' || !DECIMAL_ID.test(record.ino)) return null
  return {
    version: 1,
    kind: 'transcript-writer-sqlite-v1',
    databaseId: record.databaseId,
    dev: record.dev,
    ino: record.ino,
  }
}

function decodeAnchor(raw: string): TranscriptWriterAnchorV1 | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 5) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.role !== 'transcript-writer' ||
    typeof record.databaseId !== 'string' || !DATABASE_ID.test(record.databaseId) ||
    typeof record.dev !== 'string' || !DECIMAL_ID.test(record.dev) ||
    typeof record.ino !== 'string' || !DECIMAL_ID.test(record.ino)) return null
  return {
    version: 1,
    role: 'transcript-writer',
    databaseId: record.databaseId,
    dev: record.dev,
    ino: record.ino,
  }
}

function readExactPrivateFile(input: {
  path: string
  missing: 'absent' | 'legacy'
}): { raw: string; stat: Stats } | null {
  const uid = currentUid()
  let fd: number | null = null
  try {
    fd = openSync(input.path, constants.O_RDONLY | noFollowFlag())
    const before = fstatSync(fd)
    if (!privateRegular(before, uid) || before.size > 1024) {
      throw new TranscriptWriterLeaseError('lease-unsafe')
    }
    const raw = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    const current = lstatSync(input.path)
    if (!privateRegular(after, uid) || !privateRegular(current, uid) ||
      before.size !== after.size || after.size !== Buffer.byteLength(raw, 'utf8') ||
      !sameIdentity(before, after) || !sameIdentity(after, current)) {
      throw new TranscriptWriterLeaseError('lease-unsafe')
    }
    return { raw, stat: after }
  } catch (error) {
    if (error instanceof TranscriptWriterLeaseError) throw error
    const code = nodeErrorCode(error)
    if (code === 'ENOENT') return null
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw new TranscriptWriterLeaseError(
        input.missing === 'legacy' ? 'legacy-residue' : 'lease-unsafe',
      )
    }
    throw new TranscriptWriterLeaseError('lease-unavailable')
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* result already fixed */ }
  }
}

function readBarrier(path: string): TranscriptWriterBarrierV1 | null {
  let published: Stats
  try { published = lstatSync(path) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  if (published.isDirectory()) throw new TranscriptWriterLeaseError('legacy-residue')
  if (published.isSymbolicLink() || !published.isFile()) {
    throw new TranscriptWriterLeaseError('lease-unsafe')
  }
  const file = readExactPrivateFile({ path, missing: 'legacy' })
  if (file === null) return null
  const barrier = decodeBarrier(file.raw)
  if (barrier === null || file.raw !== JSON.stringify(barrier) + '\n') {
    throw new TranscriptWriterLeaseError('lease-corrupt')
  }
  return barrier
}

function recoverBarrierPublication(root: string, barrierPath: string): void {
  let published: Stats
  try { published = lstatSync(barrierPath) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  if (privateRegular(published, currentUid())) return
  if (!published.isFile() || published.isSymbolicLink() || published.uid !== currentUid() ||
    (published.mode & 0o777) !== 0o600 || published.nlink !== 2) return
  let names: string[]
  try {
    names = readdirSync(root).filter(name =>
      /^\.\.transcript-writer\.lock\.compat\.[a-f0-9]{32}\.tmp$/.test(name))
  } catch {
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  const matches = names
    .map(name => join(root, name))
    .filter(path => {
      try {
        const stat = lstatSync(path)
        return stat.isFile() && !stat.isSymbolicLink() && stat.uid === published.uid &&
          (stat.mode & 0o777) === 0o600 && sameIdentity(stat, published)
      } catch {
        return false
      }
    })
  if (matches.length !== 1) return
  const directory = openPrivateDirectory(root)
  try {
    exactUnlink(matches[0]!, published, directory.uid)
    fsyncSync(directory.fd)
  } catch {
    throw new TranscriptWriterLeaseError('lease-unavailable')
  } finally {
    try { closeSync(directory.fd) } catch { /* recovery result already fixed */ }
  }
}

function readAnchor(path: string): TranscriptWriterAnchorV1 {
  const file = readExactPrivateFile({ path, missing: 'absent' })
  if (file === null) throw new TranscriptWriterLeaseError('lease-corrupt')
  const anchor = decodeAnchor(file.raw)
  if (anchor === null || file.raw !== JSON.stringify(anchor) + '\n') {
    throw new TranscriptWriterLeaseError('lease-corrupt')
  }
  return anchor
}

function expectedBarrier(identity: PrivateSqliteLeaseIdentityV1): TranscriptWriterBarrierV1 {
  return {
    version: 1,
    kind: 'transcript-writer-sqlite-v1',
    databaseId: identity.databaseId,
    dev: identity.dev,
    ino: identity.ino,
  }
}

function assertBarrierMatches(
  root: string,
  barrier: TranscriptWriterBarrierV1,
  identity?: PrivateSqliteLeaseIdentityV1,
): void {
  const dbPath = join(
    root,
    TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME,
    TRANSCRIPT_WRITER_LEASE_DB_FILENAME,
  )
  let db: Stats
  try { db = lstatSync(dbPath) } catch {
    throw new TranscriptWriterLeaseError('lease-corrupt')
  }
  if (!privateRegular(db, currentUid()) ||
    barrier.dev !== String(db.dev) || barrier.ino !== String(db.ino)) {
    throw new TranscriptWriterLeaseError('lease-corrupt')
  }
  const anchor = readAnchor(dbPath + '.identity.json')
  const disk = {
    databaseId: anchor.databaseId,
    dev: anchor.dev,
    ino: anchor.ino,
  }
  const barrierIdentity = {
    databaseId: barrier.databaseId,
    dev: barrier.dev,
    ino: barrier.ino,
  }
  if (JSON.stringify(disk) !== JSON.stringify(barrierIdentity) ||
    (identity !== undefined &&
      JSON.stringify(barrierIdentity) !== JSON.stringify({
        databaseId: identity.databaseId,
        dev: identity.dev,
        ino: identity.ino,
      }))) {
    throw new TranscriptWriterLeaseError('lease-corrupt')
  }
}

function openPrivateDirectory(path: string): { fd: number; uid: number; stat: Stats } {
  const uid = currentUid()
  let before: Stats
  try { before = lstatSync(path) } catch {
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid ||
    (before.mode & 0o777) !== 0o700) throw new TranscriptWriterLeaseError('lease-unsafe')
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | directoryFlag() | noFollowFlag())
  } catch {
    throw new TranscriptWriterLeaseError('lease-unavailable')
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || opened.uid !== uid || (opened.mode & 0o777) !== 0o700 ||
      !sameIdentity(before, opened)) throw new TranscriptWriterLeaseError('lease-unsafe')
    return { fd, uid, stat: opened }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function exactUnlink(path: string, expected: Stats, uid: number): void {
  try {
    const current = lstatSync(path)
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid ||
      (current.mode & 0o777) !== 0o600 || !sameIdentity(current, expected)) return
    unlinkSync(path)
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }
}

function publishBarrier(
  root: string,
  barrierPath: string,
  barrier: TranscriptWriterBarrierV1,
): TranscriptWriterBarrierV1 {
  const directory = openPrivateDirectory(root)
  const temporary = join(
    root,
    '..transcript-writer.lock.compat.' + randomBytes(16).toString('hex') + '.tmp',
  )
  let fd: number | null = null
  let tempStat: Stats | null = null
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    )
    tempStat = fstatSync(fd)
    writeFileSync(fd, JSON.stringify(barrier) + '\n')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(temporary, barrierPath)
      fsyncSync(directory.fd)
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
    }
    exactUnlink(temporary, tempStat, directory.uid)
    tempStat = null
    fsyncSync(directory.fd)
    const published = readBarrier(barrierPath)
    if (published === null || JSON.stringify(published) !== JSON.stringify(barrier)) {
      throw new TranscriptWriterLeaseError('lease-corrupt')
    }
    return published
  } catch (error) {
    throw error instanceof TranscriptWriterLeaseError
      ? error
      : new TranscriptWriterLeaseError('lease-unavailable')
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* stable error already fixed */ }
    if (tempStat !== null) try { exactUnlink(temporary, tempStat, directory.uid) } catch { /* no broad cleanup */ }
    try { fsyncSync(directory.fd) } catch { /* published result already fixed */ }
    try { closeSync(directory.fd) } catch { /* published result already fixed */ }
  }
}

function releaseAfterFailure(lease: PrivateSqliteLease, error: unknown): never {
  try { lease.release() } catch { /* original refusal is authoritative */ }
  throw mapPrivateError(error)
}

/**
 * Acquire before any transcript, WAL, manifest, provider, tool or Telegram I/O.
 * The SQLite transaction is released by the kernel after SIGKILL.
 */
export function acquireTranscriptWriterLease(input: { root: string }): TranscriptWriterLease {
  const barrierPath = join(input.root, TRANSCRIPT_WRITER_LOCK_DIRNAME)
  recoverBarrierPublication(input.root, barrierPath)
  const before = readBarrier(barrierPath)
  if (before !== null) assertBarrierMatches(input.root, before)

  let primitive: PrivateSqliteLease
  try {
    primitive = acquirePrivateSqliteLease({
      root: join(input.root, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME),
      profile: PROFILE,
    })
  } catch (error) {
    throw mapPrivateError(error)
  }
  try {
    const barrier = before ?? publishBarrier(
      input.root,
      barrierPath,
      expectedBarrier(primitive.identity),
    )
    assertBarrierMatches(input.root, barrier, primitive.identity)
    return {
      identity: primitive.identity,
      assertOwned() {
        try {
          primitive.assertHeld()
        } catch (error) {
          throw mapPrivateError(error)
        }
        try {
          const current = readBarrier(barrierPath)
          if (current === null) throw new Error()
          assertBarrierMatches(input.root, current, primitive.identity)
        } catch {
          throw new TranscriptWriterLeaseError('lease-lost')
        }
      },
      release() {
        primitive.release()
      },
    }
  } catch (error) {
    return releaseAfterFailure(primitive, error)
  }
}

/**
 * Read-only doctor probe. It never creates or repairs DB, anchor, barrier or
 * rollback journal. The persistent exact v2 state is reported free as absent.
 */
export function inspectTranscriptWriterLease(input: { root: string }): TranscriptWriterLeaseInspection {
  try {
    const barrierPath = join(input.root, TRANSCRIPT_WRITER_LOCK_DIRNAME)
    const barrier = readBarrier(barrierPath)
    const leaseRoot = join(input.root, TRANSCRIPT_WRITER_LEASE_ROOT_DIRNAME)
    if (barrier === null) {
      const probe = inspectPrivateSqliteLease({ root: leaseRoot, profile: PROFILE })
      return { state: probe.state === 'absent' ? 'absent' : 'corrupt' }
    }
    assertBarrierMatches(input.root, barrier)
    const probe = inspectPrivateSqliteLease({ root: leaseRoot, profile: PROFILE })
    if (probe.state === 'held') return { state: 'held' }
    if (probe.state === 'free') return { state: 'absent' }
    return { state: 'corrupt' }
  } catch {
    return { state: 'corrupt' }
  }
}

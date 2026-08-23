import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import Database from 'better-sqlite3'

const DATABASE_ID = /^[a-f0-9]{64}$/
const DECIMAL_ID = /^(0|[1-9][0-9]{0,19})$/
const FILENAME = /^[a-z0-9][a-z0-9.-]{0,127}$/
const ROLE = /^[a-z][a-z0-9-]{0,63}$/

export type PrivateSqliteLeaseFailure =
  | 'busy'
  | 'unsafe'
  | 'corrupt'
  | 'unavailable'
  | 'lost'

export class PrivateSqliteLeaseError extends Error {
  constructor(readonly failure: PrivateSqliteLeaseFailure) {
    super('private SQLite lease refused: ' + failure)
    this.name = 'PrivateSqliteLeaseError'
  }
}

export interface PrivateSqliteLeaseProfile {
  readonly role: string
  readonly filename: string
  readonly applicationId: number
  readonly userVersion: 1
  readonly exactSchemaSql: string
  /** Compatibility seam for adapters whose historical isHeld checked only DB identity. */
  readonly validateRootWhileHeld?: boolean
}

export interface PrivateSqliteLeaseIdentityV1 {
  version: 1
  path: string
  dev: string
  ino: string
  databaseId: string
}

export interface PrivateSqliteLease {
  readonly identity: PrivateSqliteLeaseIdentityV1
  isHeld(): boolean
  assertHeld(): void
  onLost(listener: () => void): () => void
  release(): void
}

export type PrivateSqliteLeaseInspectionState =
  | 'absent'
  | 'free'
  | 'held'
  | 'unsafe'
  | 'corrupt'
  | 'unavailable'

const heldPaths = new Map<string, { dev: string; ino: string }>()

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) throw new PrivateSqliteLeaseError('unavailable')
  return Number(uid)
}

function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new PrivateSqliteLeaseError('unavailable')
  return constants.O_NOFOLLOW
}

function directoryFlag(): number {
  if (!Number.isInteger(constants.O_DIRECTORY)) throw new PrivateSqliteLeaseError('unavailable')
  return constants.O_DIRECTORY
}

function sameIdentity(
  a: { dev: number | bigint; ino: number | bigint },
  b: { dev: number | bigint; ino: number | bigint },
): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
}

function ownedRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o777) === 0o600
}

function privateRegular(stat: Stats, uid: number): boolean {
  return ownedRegular(stat, uid) && stat.nlink === 1
}

function pathMatchesHeldIdentity(path: string): boolean {
  const held = heldPaths.get(path)
  if (held === undefined) return false
  try {
    const current = lstatSync(path)
    return String(current.dev) === held.dev && String(current.ino) === held.ino
  } catch {
    return false
  }
}

function validateProfile(profile: PrivateSqliteLeaseProfile): void {
  if (!ROLE.test(profile.role) || !FILENAME.test(profile.filename) ||
    !Number.isSafeInteger(profile.applicationId) || profile.applicationId <= 0 ||
    profile.applicationId > 0x7fff_ffff || profile.userVersion !== 1 ||
    profile.exactSchemaSql.length === 0 || profile.exactSchemaSql.length > 4096 ||
    (profile.validateRootWhileHeld !== undefined &&
      typeof profile.validateRootWhileHeld !== 'boolean')) {
    throw new PrivateSqliteLeaseError('unsafe')
  }
}

function canonicalRoot(path: string): string {
  let requested = resolve(path)
  if (!isAbsolute(requested)) throw new PrivateSqliteLeaseError('unsafe')
  if (process.platform === 'darwin' &&
    (requested === '/var' || requested.startsWith('/var' + sep))) {
    let canonicalTemporary: string
    try { canonicalTemporary = realpathSync('/var') } catch {
      throw new PrivateSqliteLeaseError('unavailable')
    }
    if (canonicalTemporary !== '/private/var') throw new PrivateSqliteLeaseError('unsafe')
    requested = join(canonicalTemporary, relative('/var', requested))
  }
  const parsed = parse(requested)
  let current = parsed.root
  for (const component of requested.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new PrivateSqliteLeaseError('unsafe')
    } catch (error) {
      if (error instanceof PrivateSqliteLeaseError) throw error
      if (nodeErrorCode(error) === 'ENOENT') break
      throw new PrivateSqliteLeaseError('unavailable')
    }
  }
  return requested
}

interface OpenedPrivateRoot {
  fd: number
  uid: number
  stat: Stats
}

function openPrivateRoot(root: string, create: boolean): OpenedPrivateRoot | null {
  const uid = currentUid()
  const absolute = resolve(root)
  const parsed = parse(absolute)
  let current = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PrivateSqliteLeaseError('unsafe')
    } catch (error) {
      if (error instanceof PrivateSqliteLeaseError) throw error
      if (nodeErrorCode(error) !== 'ENOENT') throw new PrivateSqliteLeaseError('unavailable')
      if (!create) return null
      try { mkdirSync(current, { mode: 0o700 }) } catch (mkdirError) {
        if (nodeErrorCode(mkdirError) !== 'EEXIST') throw new PrivateSqliteLeaseError('unavailable')
        const raced = lstatSync(current)
        if (!raced.isDirectory() || raced.isSymbolicLink()) throw new PrivateSqliteLeaseError('unsafe')
      }
    }
  }
  let before: Stats
  try { before = lstatSync(root) } catch (error) {
    if (!create && nodeErrorCode(error) === 'ENOENT') return null
    throw new PrivateSqliteLeaseError('unavailable')
  }
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid ||
    (before.mode & 0o777) !== 0o700) throw new PrivateSqliteLeaseError('unsafe')
  let fd: number
  try { fd = openSync(root, constants.O_RDONLY | directoryFlag() | noFollowFlag()) } catch {
    throw new PrivateSqliteLeaseError('unavailable')
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || opened.uid !== uid || (opened.mode & 0o777) !== 0o700 ||
      !sameIdentity(before, opened)) throw new PrivateSqliteLeaseError('unsafe')
    return { fd, uid, stat: opened }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function validateRootIdentity(root: string, expected: OpenedPrivateRoot): boolean {
  try {
    const current = lstatSync(root)
    return current.isDirectory() && !current.isSymbolicLink() &&
      current.uid === expected.uid && (current.mode & 0o777) === 0o700 &&
      sameIdentity(current, expected.stat)
  } catch {
    return false
  }
}

function artifactState(path: string, uid: number): 'absent' | 'private' | 'unsafe' {
  try {
    return privateRegular(lstatSync(path), uid) ? 'private' : 'unsafe'
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'absent'
    throw new PrivateSqliteLeaseError('unavailable')
  }
}

function validateArtifacts(dbPath: string, uid: number, allowJournal: boolean): void {
  const journal = artifactState(dbPath + '-journal', uid)
  if (journal === 'unsafe') throw new PrivateSqliteLeaseError('unsafe')
  if (journal === 'private' && !allowJournal) throw new PrivateSqliteLeaseError('corrupt')
  for (const suffix of ['-wal', '-shm']) {
    const state = artifactState(dbPath + suffix, uid)
    if (state === 'unsafe') throw new PrivateSqliteLeaseError('unsafe')
    if (state === 'private') throw new PrivateSqliteLeaseError('corrupt')
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function configureConnection(db: Database.Database): void {
  db.pragma('busy_timeout = 0')
  db.pragma('locking_mode = NORMAL')
  db.pragma('synchronous = FULL')
  db.pragma('trusted_schema = OFF')
}

function validateDatabase(
  db: Database.Database,
  profile: PrivateSqliteLeaseProfile,
  createdDatabaseId?: string,
): string {
  configureConnection(db)
  const journal = createdDatabaseId === undefined
    ? String(db.pragma('journal_mode', { simple: true })).toLowerCase()
    : String(db.pragma('journal_mode = DELETE', { simple: true })).toLowerCase()
  if (journal !== 'delete') throw new PrivateSqliteLeaseError('corrupt')
  if (createdDatabaseId !== undefined) {
    if (!DATABASE_ID.test(createdDatabaseId)) throw new PrivateSqliteLeaseError('corrupt')
    db.pragma('application_id = ' + profile.applicationId)
    db.pragma('user_version = ' + profile.userVersion)
    db.exec(profile.exactSchemaSql)
    db.prepare('INSERT INTO lease_meta(singleton, role, schema_version, database_id) VALUES (1, ?, 1, ?)')
      .run(profile.role, createdDatabaseId)
  }
  const applicationId = Number(db.pragma('application_id', { simple: true }))
  const userVersion = Number(db.pragma('user_version', { simple: true }))
  const lockingMode = String(db.pragma('locking_mode', { simple: true })).toLowerCase()
  const synchronous = Number(db.pragma('synchronous', { simple: true }))
  const trustedSchema = Number(db.pragma('trusted_schema', { simple: true }))
  const integrity = String(db.pragma('quick_check', { simple: true }))
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ type: string; name: string; sql: string | null }>
  const rows = db.prepare(
    'SELECT singleton, role, schema_version, database_id FROM lease_meta',
  ).all() as Array<{ singleton: number; role: string; schema_version: number; database_id: string }>
  const row = rows[0]
  if (applicationId !== profile.applicationId || userVersion !== profile.userVersion ||
    journal !== 'delete' || lockingMode !== 'normal' || synchronous !== 2 || trustedSchema !== 0 ||
    integrity !== 'ok' || objects.length !== 1 || objects[0]?.type !== 'table' ||
    objects[0].name !== 'lease_meta' || objects[0].sql === null ||
    normalizeSql(objects[0].sql) !== normalizeSql(profile.exactSchemaSql) ||
    rows.length !== 1 || row?.singleton !== 1 || row.role !== profile.role ||
    row.schema_version !== 1 || !DATABASE_ID.test(row.database_id) ||
    (createdDatabaseId !== undefined && row.database_id !== createdDatabaseId)) {
    throw new PrivateSqliteLeaseError('corrupt')
  }
  return row.database_id
}

interface LeaseIdentityAnchorV1 {
  version: 1
  role: string
  databaseId: string
  dev: string
  ino: string
}

function decodeAnchor(raw: string, role: string): LeaseIdentityAnchorV1 | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 5) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.role !== role ||
    typeof record.databaseId !== 'string' || !DATABASE_ID.test(record.databaseId) ||
    typeof record.dev !== 'string' || !DECIMAL_ID.test(record.dev) ||
    typeof record.ino !== 'string' || !DECIMAL_ID.test(record.ino)) return null
  return {
    version: 1,
    role,
    databaseId: record.databaseId,
    dev: record.dev,
    ino: record.ino,
  }
}

function readAnchor(path: string, uid: number, role: string): LeaseIdentityAnchorV1 | null {
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
    const before = fstatSync(fd)
    if (!privateRegular(before, uid) || before.size > 1024) throw new PrivateSqliteLeaseError('unsafe')
    const raw = readFileSync(fd, 'utf8')
    const after = fstatSync(fd)
    const current = lstatSync(path)
    if (!privateRegular(after, uid) || !privateRegular(current, uid) ||
      before.size !== after.size || after.size !== Buffer.byteLength(raw, 'utf8') ||
      !sameIdentity(before, after) || !sameIdentity(after, current)) {
      throw new PrivateSqliteLeaseError('unsafe')
    }
    const anchor = decodeAnchor(raw, role)
    if (anchor === null || raw !== JSON.stringify(anchor) + '\n') {
      throw new PrivateSqliteLeaseError('corrupt')
    }
    return anchor
  } catch (error) {
    if (error instanceof PrivateSqliteLeaseError) throw error
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw new PrivateSqliteLeaseError('unavailable')
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* result already fixed */ }
  }
}

function exactUnlink(path: string, expected: Stats, uid: number): void {
  try {
    const current = lstatSync(path)
    if (!ownedRegular(current, uid) || !sameIdentity(current, expected)) return
    unlinkSync(path)
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }
}

function recoverPublishedLink(input: {
  root: string
  filename: string
  target: string
  prefix: string
  suffix: string
  directory: OpenedPrivateRoot
}): Stats {
  let published = lstatSync(input.target)
  if (privateRegular(published, input.directory.uid)) return published
  if (!ownedRegular(published, input.directory.uid) || published.nlink !== 2) {
    throw new PrivateSqliteLeaseError('unsafe')
  }
  const matches = readdirSync(input.root)
    .filter(name => name.startsWith(input.prefix) && name.endsWith(input.suffix))
    .map(name => join(input.root, name))
    .filter(path => {
      try {
        const stat = lstatSync(path)
        return ownedRegular(stat, input.directory.uid) && sameIdentity(stat, published)
      } catch {
        return false
      }
    })
  if (matches.length !== 1) throw new PrivateSqliteLeaseError('unsafe')
  exactUnlink(matches[0]!, published, input.directory.uid)
  fsyncSync(input.directory.fd)
  published = lstatSync(input.target)
  if (!privateRegular(published, input.directory.uid)) throw new PrivateSqliteLeaseError('unsafe')
  return published
}

function bootstrapDatabase(input: {
  root: string
  dbPath: string
  directory: OpenedPrivateRoot
  profile: PrivateSqliteLeaseProfile
}): void {
  const token = randomBytes(16).toString('hex')
  const temporary = join(input.root, '.' + input.profile.filename + '.bootstrap.' + token + '.sqlite3')
  let tempStat: Stats | null = null
  let file: number | null = null
  let db: Database.Database | null = null
  try {
    file = openSync(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    )
    chmodSync(temporary, 0o600)
    tempStat = fstatSync(file)
    fsyncSync(file)
    closeSync(file)
    file = null
    db = new Database(temporary, { timeout: 0, fileMustExist: true })
    validateDatabase(db, input.profile, randomBytes(32).toString('hex'))
    db.close()
    db = null
    file = openSync(temporary, constants.O_RDONLY | noFollowFlag())
    const initialized = fstatSync(file)
    if (!privateRegular(initialized, input.directory.uid) || !sameIdentity(initialized, tempStat)) {
      throw new PrivateSqliteLeaseError('unsafe')
    }
    fsyncSync(file)
    closeSync(file)
    file = null
    try {
      linkSync(temporary, input.dbPath)
      fsyncSync(input.directory.fd)
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
    }
  } finally {
    try { db?.close() } catch { /* stable mapped error below */ }
    if (file !== null) try { closeSync(file) } catch { /* stable mapped error below */ }
    if (tempStat !== null) exactUnlink(temporary, tempStat, input.directory.uid)
    fsyncSync(input.directory.fd)
  }
}

function publishAnchor(input: {
  root: string
  anchorPath: string
  directory: OpenedPrivateRoot
  profile: PrivateSqliteLeaseProfile
  expected: LeaseIdentityAnchorV1
}): void {
  const temporary = join(
    input.root,
    '.' + input.profile.filename + '.identity.' + randomBytes(16).toString('hex') + '.tmp',
  )
  let fd: number | null = null
  let owned: Stats | null = null
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    )
    chmodSync(temporary, 0o600)
    owned = fstatSync(fd)
    writeFileSync(fd, JSON.stringify(input.expected) + '\n')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(temporary, input.anchorPath)
      fsyncSync(input.directory.fd)
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error
    }
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* stable mapped error below */ }
    if (owned !== null) exactUnlink(temporary, owned, input.directory.uid)
    fsyncSync(input.directory.fd)
  }
}

function ensureAnchor(input: {
  root: string
  anchorPath: string
  directory: OpenedPrivateRoot
  profile: PrivateSqliteLeaseProfile
  databaseId: string
  dbStat: Stats
}): LeaseIdentityAnchorV1 {
  const expected: LeaseIdentityAnchorV1 = {
    version: 1,
    role: input.profile.role,
    databaseId: input.databaseId,
    dev: String(input.dbStat.dev),
    ino: String(input.dbStat.ino),
  }
  try {
    const published = lstatSync(input.anchorPath)
    if (!privateRegular(published, input.directory.uid)) {
      if (!ownedRegular(published, input.directory.uid) || published.nlink !== 2) {
        throw new PrivateSqliteLeaseError('unsafe')
      }
      recoverPublishedLink({
        root: input.root,
        filename: input.profile.filename,
        target: input.anchorPath,
        prefix: '.' + input.profile.filename + '.identity.',
        suffix: '.tmp',
        directory: input.directory,
      })
    }
  } catch (error) {
    if (error instanceof PrivateSqliteLeaseError) throw error
    if (nodeErrorCode(error) !== 'ENOENT') throw new PrivateSqliteLeaseError('unavailable')
  }
  let anchor = readAnchor(input.anchorPath, input.directory.uid, input.profile.role)
  if (anchor === null) {
    publishAnchor({ ...input, expected })
    anchor = readAnchor(input.anchorPath, input.directory.uid, input.profile.role)
  }
  if (anchor === null || JSON.stringify(anchor) !== JSON.stringify(expected)) {
    throw new PrivateSqliteLeaseError('corrupt')
  }
  return anchor
}

function mapUnknown(error: unknown): PrivateSqliteLeaseError {
  if (error instanceof PrivateSqliteLeaseError) return error
  const code = nodeErrorCode(error)
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return new PrivateSqliteLeaseError('busy')
  if (code?.startsWith('SQLITE_')) return new PrivateSqliteLeaseError('corrupt')
  return new PrivateSqliteLeaseError('unavailable')
}

export function acquirePrivateSqliteLease(input: {
  root: string
  profile: PrivateSqliteLeaseProfile
}): PrivateSqliteLease {
  validateProfile(input.profile)
  const root = canonicalRoot(input.root)
  const directory = openPrivateRoot(root, true)
  if (directory === null) throw new PrivateSqliteLeaseError('unavailable')
  const dbPath = join(root, input.profile.filename)
  const anchorPath = dbPath + '.identity.json'
  let db: Database.Database | null = null
  try {
    if (pathMatchesHeldIdentity(dbPath)) throw new PrivateSqliteLeaseError('busy')
    validateArtifacts(dbPath, directory.uid, true)
    let dbExists = true
    try { lstatSync(dbPath) } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error
      dbExists = false
    }
    if (!dbExists) {
      if (readAnchor(anchorPath, directory.uid, input.profile.role) !== null) {
        throw new PrivateSqliteLeaseError('corrupt')
      }
      bootstrapDatabase({ root, dbPath, directory, profile: input.profile })
    }
    const beforeOpen = recoverPublishedLink({
      root,
      filename: input.profile.filename,
      target: dbPath,
      prefix: '.' + input.profile.filename + '.bootstrap.',
      suffix: '.sqlite3',
      directory,
    })
    db = new Database(dbPath, { timeout: 0, fileMustExist: true })
    const stat = lstatSync(dbPath)
    if (!privateRegular(stat, directory.uid) || !sameIdentity(beforeOpen, stat)) {
      throw new PrivateSqliteLeaseError('unsafe')
    }
    const databaseId = validateDatabase(db, input.profile)
    const anchor = ensureAnchor({
      root,
      anchorPath,
      directory,
      profile: input.profile,
      databaseId,
      dbStat: stat,
    })
    fsyncSync(directory.fd)
    validateArtifacts(dbPath, directory.uid, true)
    try { db.exec('BEGIN IMMEDIATE') } catch (error) { throw mapUnknown(error) }
    const identity: PrivateSqliteLeaseIdentityV1 = {
      version: 1,
      path: dbPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      databaseId,
    }
    const connection = db
    db = null
    let held = true
    heldPaths.set(dbPath, { dev: String(stat.dev), ino: String(stat.ino) })
    const listeners = new Set<() => void>()
    let timer: ReturnType<typeof setInterval> | null = null
    const isHeld = (): boolean => {
      if (!held || !connection.inTransaction || !pathMatchesHeldIdentity(dbPath) ||
        (input.profile.validateRootWhileHeld !== false &&
          !validateRootIdentity(root, directory))) return false
      try {
        const current = lstatSync(dbPath)
        if (!privateRegular(current, directory.uid) || !sameIdentity(current, stat)) return false
        const currentAnchor = readAnchor(anchorPath, directory.uid, input.profile.role)
        return currentAnchor !== null && JSON.stringify(currentAnchor) === JSON.stringify(anchor)
      } catch {
        return false
      }
    }
    const notifyLoss = (): void => {
      if (isHeld()) return
      if (timer !== null) clearInterval(timer)
      timer = null
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) try { listener() } catch { /* isolated */ }
    }
    return {
      identity,
      isHeld,
      assertHeld() {
        if (!isHeld()) throw new PrivateSqliteLeaseError('lost')
      },
      onLost(listener) {
        if (!isHeld()) {
          try { listener() } catch { /* isolated */ }
          return () => undefined
        }
        listeners.add(listener)
        if (timer === null) {
          timer = setInterval(notifyLoss, 25)
          timer.unref?.()
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
      },
      release() {
        if (!held) return
        held = false
        const registered = heldPaths.get(dbPath)
        if (registered?.dev === String(stat.dev) && registered.ino === String(stat.ino)) {
          heldPaths.delete(dbPath)
        }
        if (timer !== null) clearInterval(timer)
        timer = null
        listeners.clear()
        try {
          if (connection.inTransaction) connection.exec('ROLLBACK')
        } finally {
          try {
            connection.close()
          } finally {
            closeSync(directory.fd)
          }
        }
      },
    }
  } catch (error) {
    try { db?.close() } catch { /* stable mapped error below */ }
    try { closeSync(directory.fd) } catch { /* stable mapped error below */ }
    throw mapUnknown(error)
  }
}

export function inspectPrivateSqliteLease(input: {
  root: string
  profile: PrivateSqliteLeaseProfile
}): { state: PrivateSqliteLeaseInspectionState } {
  let directory: OpenedPrivateRoot | null = null
  let db: Database.Database | null = null
  try {
    validateProfile(input.profile)
    const root = canonicalRoot(input.root)
    directory = openPrivateRoot(root, false)
    if (directory === null) return { state: 'absent' }
    const dbPath = join(root, input.profile.filename)
    const anchorPath = dbPath + '.identity.json'
    if (pathMatchesHeldIdentity(dbPath)) return { state: 'held' }
    const dbState = artifactState(dbPath, directory.uid)
    const anchorState = artifactState(anchorPath, directory.uid)
    if (dbState === 'absent' && anchorState === 'absent') return { state: 'absent' }
    if (dbState === 'unsafe' || anchorState === 'unsafe') return { state: 'unsafe' }
    if (dbState !== 'private' || anchorState !== 'private') return { state: 'corrupt' }
    validateArtifacts(dbPath, directory.uid, false)
    const before = lstatSync(dbPath)
    db = new Database(dbPath, { timeout: 0, fileMustExist: true })
    const after = lstatSync(dbPath)
    if (!privateRegular(after, directory.uid) || !sameIdentity(before, after)) return { state: 'unsafe' }
    const databaseId = validateDatabase(db, input.profile)
    const anchor = readAnchor(anchorPath, directory.uid, input.profile.role)
    if (anchor === null || anchor.databaseId !== databaseId ||
      anchor.dev !== String(after.dev) || anchor.ino !== String(after.ino)) return { state: 'corrupt' }
    try {
      db.exec('BEGIN IMMEDIATE')
      db.exec('ROLLBACK')
      return { state: 'free' }
    } catch (error) {
      const mapped = mapUnknown(error)
      if (mapped.failure === 'busy') return { state: 'held' }
      return { state: mapped.failure === 'unavailable' ? 'unavailable' : 'corrupt' }
    }
  } catch (error) {
    const mapped = mapUnknown(error)
    if (mapped.failure === 'unsafe') return { state: 'unsafe' }
    if (mapped.failure === 'unavailable') return { state: 'unavailable' }
    if (mapped.failure === 'busy') return { state: 'held' }
    return { state: 'corrupt' }
  } finally {
    try { db?.close() } catch { /* read-only inspection result already fixed */ }
    if (directory !== null) try { closeSync(directory.fd) } catch { /* result already fixed */ }
  }
}

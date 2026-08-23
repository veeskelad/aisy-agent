import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import Database from 'better-sqlite3'

import {
  CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE,
  CODEX_APP_SERVER_PROTOCOL_PROFILE,
  type CodexAppServerThreadRecord,
  type CodexAppServerThreadStore,
} from './codex-app-server-driver.js'

export class CodexThreadStoreError extends Error {
  constructor(public readonly code:
    | 'INVALID_STORE_PATH'
    | 'INSECURE_STORE'
    | 'CORRUPT_STORE'
    | 'INVALID_THREAD_RECORD'
    | 'THREAD_BINDING_CONFLICT',
  ) {
    super(code)
    this.name = 'CodexThreadStoreError'
  }
}

export interface SqliteCodexThreadStore extends CodexAppServerThreadStore {
  close(): void
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SCHEMA_VERSION = 1
const MAX_PERSISTED_BINDINGS = 100_000

interface ThreadRow {
  project_id: string
  session_id: string
  thread_id: string
  protocol_profile: string
}

function validId(value: string): boolean {
  return ID.test(value)
}

function validRecord(value: CodexAppServerThreadRecord): boolean {
  return validId(value.projectId) && validId(value.sessionId) && validId(value.threadId) &&
    (value.protocolProfile === CODEX_APP_SERVER_PROTOCOL_PROFILE ||
      value.protocolProfile === CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE)
}

function fromRow(row: ThreadRow): CodexAppServerThreadRecord {
  const value = {
    projectId: row.project_id,
    sessionId: row.session_id,
    threadId: row.thread_id,
    protocolProfile: row.protocol_profile,
  } as CodexAppServerThreadRecord
  if (!validRecord(value)) throw new CodexThreadStoreError('CORRUPT_STORE')
  return Object.freeze(value)
}

interface ColumnExpectation {
  name: string
  type: 'INTEGER' | 'TEXT'
  notnull: 0 | 1
  pk: number
}

function validateTable(
  db: Database.Database,
  name: string,
  expected: readonly ColumnExpectation[],
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as Array<ColumnExpectation>
  return rows.length === expected.length && rows.every((row, index) => {
    const wanted = expected[index]
    return wanted !== undefined && row.name === wanted.name && row.type === wanted.type &&
      row.notnull === wanted.notnull && row.pk === wanted.pk
  })
}

/** Durable, metadata-only Project/Session to Codex thread binding store. */
export function makeSqliteCodexThreadStore(input: { dbPath: string }): SqliteCodexThreadStore {
  const parent = dirname(input.dbPath)
  if (!resolve(input.dbPath).startsWith(`${resolve(parent)}/`) || basename(input.dbPath).length === 0) {
    throw new CodexThreadStoreError('INVALID_STORE_PATH')
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  let canonicalParent: string
  try { canonicalParent = realpathSync(parent) } catch {
    throw new CodexThreadStoreError('INVALID_STORE_PATH')
  }
  const canonicalPath = join(canonicalParent, basename(input.dbPath))
  if (canonicalPath !== input.dbPath) throw new CodexThreadStoreError('INVALID_STORE_PATH')
  const parentStat = lstatSync(canonicalParent)
  const parentOwnerOk = typeof process.getuid !== 'function' || parentStat.uid === process.getuid()
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !parentOwnerOk ||
    (parentStat.mode & 0o077) !== 0) {
    throw new CodexThreadStoreError('INSECURE_STORE')
  }

  const existed = existsSync(canonicalPath)
  if (existed) {
    const stat = lstatSync(canonicalPath)
    const ownerOk = typeof process.getuid !== 'function' || stat.uid === process.getuid()
    if (!stat.isFile() || stat.isSymbolicLink() || !ownerOk || (stat.mode & 0o077) !== 0) {
      throw new CodexThreadStoreError('INSECURE_STORE')
    }
  }

  let db: Database.Database
  try { db = new Database(canonicalPath) } catch {
    throw new CodexThreadStoreError('CORRUPT_STORE')
  }
  const openedStat = lstatSync(canonicalPath)
  const openedOwnerOk = typeof process.getuid !== 'function' || openedStat.uid === process.getuid()
  if (!openedStat.isFile() || openedStat.isSymbolicLink() || !openedOwnerOk) {
    db.close()
    throw new CodexThreadStoreError('INSECURE_STORE')
  }
  if (!existed) chmodSync(canonicalPath, 0o600)
  try {
    db.pragma('journal_mode = DELETE')
    db.pragma('synchronous = FULL')
    db.pragma('secure_delete = ON')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')

    if (!existed) {
      db.exec(`
        CREATE TABLE codex_thread_control (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE codex_thread_bindings (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          protocol_profile TEXT NOT NULL,
          PRIMARY KEY (project_id, session_id)
        ) STRICT;
        CREATE UNIQUE INDEX codex_thread_bindings_thread_id
          ON codex_thread_bindings(thread_id);
        INSERT INTO codex_thread_control(singleton, schema_version) VALUES (1, 1);
      `)
    }

    const objects = db.prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    ).all() as Array<{ type: string; name: string }>
    if (objects.map(row => `${row.type}:${row.name}`).join(',') !==
      'index:codex_thread_bindings_thread_id,table:codex_thread_bindings,table:codex_thread_control') {
      throw new CodexThreadStoreError('CORRUPT_STORE')
    }

    if (!validateTable(db, 'codex_thread_control', [
      { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
    ]) || !validateTable(db, 'codex_thread_bindings', [
      { name: 'project_id', type: 'TEXT', notnull: 1, pk: 1 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 2 },
      { name: 'thread_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'protocol_profile', type: 'TEXT', notnull: 1, pk: 0 },
    ])) {
      throw new CodexThreadStoreError('CORRUPT_STORE')
    }
    const control = db.prepare(
      'SELECT schema_version FROM codex_thread_control WHERE singleton = 1',
    ).get() as { schema_version: number } | undefined
    const indexes = db.prepare('PRAGMA index_list(codex_thread_bindings)').all() as Array<{
      name: string
      unique: number
      origin: string
    }>
    if (control?.schema_version !== SCHEMA_VERSION ||
      indexes.length !== 2 ||
      !indexes.some(index => index.name === 'codex_thread_bindings_thread_id' &&
        index.unique === 1 && index.origin === 'c') ||
      !indexes.some(index => index.unique === 1 && index.origin === 'pk') ||
      db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new CodexThreadStoreError('CORRUPT_STORE')
    }
    const persisted = db.prepare(
      `SELECT project_id, session_id, thread_id, protocol_profile
       FROM codex_thread_bindings LIMIT ?`,
    ).all(MAX_PERSISTED_BINDINGS + 1) as ThreadRow[]
    if (persisted.length > MAX_PERSISTED_BINDINGS) {
      throw new CodexThreadStoreError('CORRUPT_STORE')
    }
    for (const row of persisted) fromRow(row)
  } catch (error) {
    db.close()
    if (error instanceof CodexThreadStoreError) throw error
    throw new CodexThreadStoreError('CORRUPT_STORE')
  }

  const byBinding = db.prepare(
    `SELECT project_id, session_id, thread_id, protocol_profile
       FROM codex_thread_bindings WHERE project_id = ? AND session_id = ?`,
  )
  const byThread = db.prepare(
    `SELECT project_id, session_id, thread_id, protocol_profile
       FROM codex_thread_bindings WHERE thread_id = ?`,
  )
  const insert = db.prepare(
    `INSERT INTO codex_thread_bindings(project_id, session_id, thread_id, protocol_profile)
     VALUES (?, ?, ?, ?)`,
  )

  const store: SqliteCodexThreadStore = {
    async load(projectId, sessionId) {
      if (!validId(projectId) || !validId(sessionId)) {
        throw new CodexThreadStoreError('INVALID_THREAD_RECORD')
      }
      const row = byBinding.get(projectId, sessionId) as ThreadRow | undefined
      return row ? fromRow(row) : null
    },

    async saveNew(record) {
      if (!validRecord(record)) throw new CodexThreadStoreError('INVALID_THREAD_RECORD')
      const transaction = db.transaction(() => {
        const existing = byBinding.get(record.projectId, record.sessionId) as ThreadRow | undefined
        const owner = byThread.get(record.threadId) as ThreadRow | undefined
        if (existing || owner) {
          if (existing && existing.thread_id === record.threadId &&
            existing.protocol_profile === record.protocolProfile &&
            owner?.project_id === record.projectId && owner?.session_id === record.sessionId) return
          throw new CodexThreadStoreError('THREAD_BINDING_CONFLICT')
        }
        insert.run(record.projectId, record.sessionId, record.threadId, record.protocolProfile)
      })
      try { transaction.immediate() } catch (error) {
        if (error instanceof CodexThreadStoreError) throw error
        throw new CodexThreadStoreError('CORRUPT_STORE')
      }
    },

    close() { db.close() },
  }
  return Object.freeze(store)
}

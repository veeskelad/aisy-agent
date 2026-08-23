import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import Database from 'better-sqlite3'

import type {
  ApiCredentialCommittingRecord,
  ApiCredentialIngressRecord,
  ApiCredentialIngressStore,
  ApiCredentialIssuedRecord,
} from './api-credential-ingress.js'
import type { ApiCredentialBinding } from './api-key-setup-driver.js'

const SCHEMA = `
CREATE TABLE ingress_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
);
INSERT INTO ingress_control (singleton, schema_version) VALUES (1, 1);
CREATE TABLE credential_ingress (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  vault_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'committing', 'ready', 'failed', 'revoked')),
  code_hash TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error_code TEXT,
  CHECK (
    (status = 'issued' AND code_hash IS NOT NULL AND last_error_code IS NULL) OR
    (status = 'committing' AND code_hash IS NULL AND last_error_code IS NULL) OR
    (status = 'ready' AND code_hash IS NULL AND last_error_code IS NULL) OR
    (status = 'failed' AND code_hash IS NULL AND last_error_code IS NOT NULL) OR
    (status = 'revoked' AND code_hash IS NULL AND last_error_code IS NULL)
  )
);
CREATE INDEX credential_ingress_binding_idx
  ON credential_ingress(connection_id, provider, vault_key, issued_at DESC);
CREATE UNIQUE INDEX credential_ingress_code_hash_idx
  ON credential_ingress(code_hash) WHERE code_hash IS NOT NULL;
`

interface Row {
  id: string
  connection_id: string
  provider: string
  vault_key: string
  status: string
  code_hash: string | null
  issued_at: string
  expires_at: string
  updated_at: string
  last_error_code: string | null
}

export class SqliteApiCredentialIngressStoreError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'UNSAFE_PATH'
    | 'STATE_CORRUPT'
    | 'STATE_BUSY'
    | 'INVALID_RECORD'
    | 'DUPLICATE_RECORD') {
    super(code)
    this.name = 'SqliteApiCredentialIngressStoreError'
  }
}

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VAULT_KEY = /^AISY_PROVIDER_[A-Z0-9_]{1,96}_KEY$/
const HASH = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const STATUSES = new Set(['issued', 'committing', 'ready', 'failed', 'revoked'])
const EXPECTED_CONTROL_COLUMNS = [
  { name: 'singleton', type: 'INTEGER', notnull: 0, pk: 1 },
  { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
]
const EXPECTED_COLUMNS = [
  { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
  { name: 'connection_id', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'provider', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'vault_key', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'status', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'code_hash', type: 'TEXT', notnull: 0, pk: 0 },
  { name: 'issued_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'expires_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
  { name: 'last_error_code', type: 'TEXT', notnull: 0, pk: 0 },
]
const EXPECTED_INDEXES = [
  { name: 'credential_ingress_binding_idx', unique: 0, origin: 'c', partial: 0 },
  { name: 'credential_ingress_code_hash_idx', unique: 1, origin: 'c', partial: 1 },
  { name: 'sqlite_autoindex_credential_ingress_1', unique: 1, origin: 'pk', partial: 0 },
]
const MAX_RECORDS = 10_000

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validBinding(value: ApiCredentialBinding): boolean {
  return ID.test(value.connectionId) && ID.test(value.provider) && VAULT_KEY.test(value.vaultKey)
}

function validateIssued(value: ApiCredentialIssuedRecord): ApiCredentialIssuedRecord {
  if (!validBinding(value) || !ID.test(value.id) || value.status !== 'issued' ||
    !HASH.test(value.codeHash) || !validIso(value.issuedAt) || !validIso(value.expiresAt) ||
    !validIso(value.updatedAt) || value.issuedAt !== value.updatedAt ||
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    throw new SqliteApiCredentialIngressStoreError('INVALID_RECORD')
  }
  return structuredClone(value)
}

function fromRow(row: Row): ApiCredentialIngressRecord {
  if (!ID.test(row.id) || !ID.test(row.connection_id) || !ID.test(row.provider) ||
    !VAULT_KEY.test(row.vault_key) || !STATUSES.has(row.status) ||
    !validIso(row.issued_at) || !validIso(row.expires_at) || !validIso(row.updated_at) ||
    Date.parse(row.expires_at) <= Date.parse(row.issued_at)) {
    throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
  }
  const base = {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    vaultKey: row.vault_key,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
  if (row.status === 'issued') {
    if (row.code_hash === null || !HASH.test(row.code_hash) || row.last_error_code !== null) {
      throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    }
    return { ...base, status: 'issued', codeHash: row.code_hash }
  }
  if (row.code_hash !== null) throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
  if (row.status === 'committing') {
    if (row.last_error_code !== null) throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    return { ...base, status: 'committing' }
  }
  if (row.status === 'failed') {
    if (row.last_error_code === null || !ERROR_CODE.test(row.last_error_code)) {
      throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    }
    return { ...base, status: 'failed', lastErrorCode: row.last_error_code }
  }
  if ((row.status !== 'ready' && row.status !== 'revoked') || row.last_error_code !== null) {
    throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
  }
  return { ...base, status: row.status }
}

function ensurePrivatePath(path: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    realpathSync(directory) !== directory) {
    throw new SqliteApiCredentialIngressStoreError('UNSAFE_PATH')
  }
  chmodSync(directory, 0o700)
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    realpathSync(path) !== path || (info.mode & 0o077) !== 0) {
    throw new SqliteApiCredentialIngressStoreError('UNSAFE_PATH')
  }
}

function sqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_BUSY'
}

function configure(db: Database.Database, initialize: boolean): void {
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 0')
  db.pragma('foreign_keys = ON')
  db.pragma('secure_delete = ON')
  if (initialize) {
    db.pragma('journal_mode = DELETE')
  }
}

function open(path: string): Database.Database {
  ensurePrivatePath(path)
  const existed = existsSync(path)
  const db = new Database(path, { timeout: 0 })
  try {
    configure(db, !existed)
    chmodSync(path, 0o600)
    if (!existed) db.exec(SCHEMA)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function asRow(value: unknown): Row {
  return value as Row
}

function withTransaction<T>(db: Database.Database, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.inTransaction) {
      try { db.exec('ROLLBACK') } catch { /* preserve primary error */ }
    }
    throw error
  }
}

export function makeSqliteApiCredentialIngressStore(input: {
  path: string
}): ApiCredentialIngressStore {
  const path = resolve(input.path)
  if (path.length === 0) throw new SqliteApiCredentialIngressStoreError('INVALID_CONFIGURATION')
  let initialization: Database.Database | null = null
  try {
    initialization = open(path)
    const control = initialization.prepare(
      'SELECT schema_version FROM ingress_control WHERE singleton = 1',
    ).get() as { schema_version: number } | undefined
    const columnShape = (table: string) => (initialization!.pragma(`table_info(${table})`) as Array<{
      name: string; type: string; notnull: number; pk: number
    }>).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))
    const controlColumns = columnShape('ingress_control')
    const columns = columnShape('credential_ingress')
    const indexes = (initialization.pragma('index_list(credential_ingress)') as Array<{
      name: string; unique: number; origin: string; partial: number
    }>).map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const integrity = initialization.pragma('integrity_check') as Array<{ integrity_check: string }>
    const journalMode = initialization.pragma('journal_mode', { simple: true })
    const secureDelete = initialization.pragma('secure_delete', { simple: true })
    if (control?.schema_version !== 1 ||
      !isDeepStrictEqual(controlColumns, EXPECTED_CONTROL_COLUMNS) ||
      !isDeepStrictEqual(columns, EXPECTED_COLUMNS) ||
      !isDeepStrictEqual(indexes, EXPECTED_INDEXES) || journalMode !== 'delete' || secureDelete !== 1 ||
      integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    }
    const rows = initialization.prepare('SELECT * FROM credential_ingress').all() as Row[]
    if (rows.length > MAX_RECORDS) throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    rows.forEach(fromRow)
  } catch (error) {
    if (error instanceof SqliteApiCredentialIngressStoreError) throw error
    if (sqliteBusy(error)) throw new SqliteApiCredentialIngressStoreError('STATE_BUSY')
    throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
  } finally {
    initialization?.close()
  }

  const use = <T>(run: (db: Database.Database) => T): T => {
    let db: Database.Database | null = null
    try {
      db = open(path)
      return run(db)
    } catch (error) {
      if (error instanceof SqliteApiCredentialIngressStoreError) throw error
      if (sqliteBusy(error)) throw new SqliteApiCredentialIngressStoreError('STATE_BUSY')
      throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
    } finally {
      db?.close()
    }
  }

  const latest = (db: Database.Database, binding: ApiCredentialBinding): Row | undefined =>
    db.prepare(`
      SELECT * FROM credential_ingress
      WHERE connection_id = ? AND provider = ? AND vault_key = ?
      ORDER BY issued_at DESC, rowid DESC LIMIT 1
    `).get(binding.connectionId, binding.provider, binding.vaultKey) as Row | undefined

  return Object.freeze<ApiCredentialIngressStore>({
    async issue(value) {
      const record = validateIssued(value)
      use((db) => withTransaction(db, () => {
        const count = (db.prepare('SELECT COUNT(*) AS count FROM credential_ingress').get() as { count: number }).count
        if (count >= MAX_RECORDS) throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
        db.prepare(`
          UPDATE credential_ingress
          SET status = 'failed', code_hash = NULL,
              last_error_code = 'API_CREDENTIAL_SUPERSEDED', updated_at = ?
          WHERE connection_id = ? AND provider = ? AND vault_key = ?
            AND status IN ('issued', 'committing')
        `).run(record.issuedAt, record.connectionId, record.provider, record.vaultKey)
        try {
          db.prepare(`
            INSERT INTO credential_ingress (
              id, connection_id, provider, vault_key, status, code_hash,
              issued_at, expires_at, updated_at, last_error_code
            ) VALUES (?, ?, ?, ?, 'issued', ?, ?, ?, ?, NULL)
          `).run(
            record.id, record.connectionId, record.provider, record.vaultKey,
            record.codeHash, record.issuedAt, record.expiresAt, record.updatedAt,
          )
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error &&
            String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')) {
            throw new SqliteApiCredentialIngressStoreError('DUPLICATE_RECORD')
          }
          throw error
        }
      }))
    },

    async claim(codeHash, nowIso) {
      if (!HASH.test(codeHash) || !validIso(nowIso)) return null
      return use((db) => withTransaction(db, () => {
        const rows = db.prepare(`
          SELECT * FROM credential_ingress
          WHERE code_hash = ? AND status = 'issued' AND expires_at > ?
        `).all(codeHash, nowIso) as Row[]
        if (rows.length === 0) return null
        if (rows.length !== 1) throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
        const row = rows[0]!
        const changed = db.prepare(`
          UPDATE credential_ingress
          SET status = 'committing', code_hash = NULL, updated_at = ?
          WHERE id = ? AND status = 'issued' AND code_hash = ?
        `).run(nowIso, row.id, codeHash)
        if (changed.changes !== 1) return null
        const claimed = db.prepare('SELECT * FROM credential_ingress WHERE id = ?').get(row.id)
        const record = fromRow(asRow(claimed))
        if (record.status !== 'committing') {
          throw new SqliteApiCredentialIngressStoreError('STATE_CORRUPT')
        }
        return record as ApiCredentialCommittingRecord
      }))
    },

    async current(binding) {
      if (!validBinding(binding)) return null
      return use((db) => {
        const row = latest(db, binding)
        return row === undefined ? null : fromRow(row)
      })
    },

    async markReady(id, nowIso) {
      if (!ID.test(id) || !validIso(nowIso)) return false
      return use((db) => withTransaction(db, () => {
        const row = db.prepare('SELECT * FROM credential_ingress WHERE id = ?').get(id) as Row | undefined
        if (row === undefined || row.status !== 'committing') return false
        const binding = fromRow(row)
        db.prepare(`
          UPDATE credential_ingress SET status = 'revoked', updated_at = ?
          WHERE connection_id = ? AND provider = ? AND vault_key = ?
            AND status = 'ready' AND id <> ?
        `).run(nowIso, binding.connectionId, binding.provider, binding.vaultKey, id)
        const changed = db.prepare(`
          UPDATE credential_ingress SET status = 'ready', updated_at = ?
          WHERE id = ? AND status = 'committing'
        `).run(nowIso, id)
        return changed.changes === 1
      }))
    },

    async markFailed(id, errorCode, nowIso) {
      if (!ID.test(id) || !ERROR_CODE.test(errorCode) || !validIso(nowIso)) return false
      return use((db) => {
        const changed = db.prepare(`
          UPDATE credential_ingress
          SET status = 'failed', last_error_code = ?, updated_at = ?
          WHERE id = ? AND status = 'committing'
        `).run(errorCode, nowIso, id)
        return changed.changes === 1
      })
    },

    async markRevoked(binding, nowIso) {
      if (!validBinding(binding) || !validIso(nowIso)) return false
      return use((db) => withTransaction(db, () => {
        const changed = db.prepare(`
          UPDATE credential_ingress
          SET status = 'revoked', code_hash = NULL, last_error_code = NULL, updated_at = ?
          WHERE connection_id = ? AND provider = ? AND vault_key = ?
            AND status IN ('issued', 'committing', 'ready', 'failed')
        `).run(nowIso, binding.connectionId, binding.provider, binding.vaultKey)
        return changed.changes > 0
      }))
    },
  })
}

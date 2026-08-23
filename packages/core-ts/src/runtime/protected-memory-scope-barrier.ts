import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import type { TurnContextLease } from './context-lease.js'
import type { ProtectedMemoryScope } from './protected-memory-publication.js'

const BARRIER_SCHEMA = `
CREATE TABLE IF NOT EXISTS barrier_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  CHECK (
    (scope_kind = 'global' AND scope_id = 'global' AND project_id IS NULL) OR
    (scope_kind = 'project' AND project_id IS NOT NULL AND scope_id = 'project:' || project_id)
  )
);
CREATE TABLE IF NOT EXISTS barrier_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  operator_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
`

interface BarrierOwner {
  singleton: number
  operator_id: string
  profile_id: string
  session_id: string
  generation: number
  pid: number
  nonce: string
  acquired_at: string
}

export class ProtectedMemoryScopeBarrierError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'UNSAFE_PATH'
    | 'SCOPE_MISMATCH'
    | 'SCOPE_BUSY'
    | 'STATE_CORRUPT',
  ) {
    super(code)
    this.name = 'ProtectedMemoryScopeBarrierError'
  }
}

export interface ProtectedMemoryScopeBarrier {
  withScopeExclusive<T>(
    lease: TurnContextLease,
    scope: ProtectedMemoryScope,
    run: () => Promise<T>,
  ): Promise<T>
}

function scopeValid(scope: ProtectedMemoryScope): boolean {
  return scope.kind === 'global'
    ? scope.scopeId === 'global'
    : scope.projectId.length > 0 && scope.scopeId === `project:${scope.projectId}`
}

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

function ensurePrivateDatabasePath(path: string): void {
  const canonical = resolve(path)
  const directory = dirname(canonical)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    realpathSync(directory) !== directory) {
    throw new ProtectedMemoryScopeBarrierError('UNSAFE_PATH')
  }
  chmodSync(directory, 0o700)
  if (!existsSync(canonical)) return
  const info = lstatSync(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    realpathSync(canonical) !== canonical || (info.mode & 0o077) !== 0) {
    throw new ProtectedMemoryScopeBarrierError('UNSAFE_PATH')
  }
}

function configure(db: Database.Database, initialize: boolean): void {
  db.pragma('synchronous = FULL')
  db.pragma('busy_timeout = 0')
  if (initialize) {
    db.pragma('journal_mode = DELETE')
    db.pragma('secure_delete = ON')
  }
}

function open(path: string, initialize = false): Database.Database {
  const db = new Database(path, { timeout: 0 })
  try {
    configure(db, initialize)
    chmodSync(path, 0o600)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function sqliteBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'SQLITE_BUSY'
}

export function makeProtectedMemoryScopeBarrier(input: {
  lockPath: string
  operatorId: string
  profileId: string
  scope: ProtectedMemoryScope
  nowIso?: () => string
  newNonce?: () => string
  pid?: number
}): ProtectedMemoryScopeBarrier {
  const lockPath = resolve(input.lockPath)
  const scope = structuredClone(input.scope)
  if (!scopeValid(scope) || input.operatorId.trim().length === 0 ||
    input.profileId.trim().length === 0) {
    throw new ProtectedMemoryScopeBarrierError('INVALID_CONFIGURATION')
  }
  const existed = existsSync(lockPath)
  ensurePrivateDatabasePath(lockPath)
  let initialization: Database.Database | null = null
  try {
    initialization = open(lockPath, !existed)
    if (!existed) initialization.exec(BARRIER_SCHEMA)
    const control = initialization.prepare(
      'SELECT * FROM barrier_control WHERE singleton = 1',
    ).get() as {
      schema_version: number
      operator_id: string
      profile_id: string
      scope_kind: string
      scope_id: string
      project_id: string | null
    } | undefined
    if (!control) {
      initialization.prepare(`
        INSERT INTO barrier_control (
          singleton, schema_version, operator_id, profile_id,
          scope_kind, scope_id, project_id
        ) VALUES (1, 1, ?, ?, ?, ?, ?)
      `).run(
        input.operatorId,
        input.profileId,
        scope.kind,
        scope.scopeId,
        scope.kind === 'project' ? scope.projectId : null,
      )
    } else if (control.schema_version !== 1 || control.operator_id !== input.operatorId ||
      control.profile_id !== input.profileId || control.scope_kind !== scope.kind ||
      control.scope_id !== scope.scopeId ||
      control.project_id !== (scope.kind === 'project' ? scope.projectId : null)) {
      throw new ProtectedMemoryScopeBarrierError('SCOPE_MISMATCH')
    }
    const expected = {
      barrier_control: [
        'singleton', 'schema_version', 'operator_id', 'profile_id',
        'scope_kind', 'scope_id', 'project_id',
      ],
      barrier_owner: [
        'singleton', 'operator_id', 'profile_id', 'session_id',
        'generation', 'pid', 'nonce', 'acquired_at',
      ],
    }
    for (const [table, expectedColumns] of Object.entries(expected)) {
      const actual = (initialization.pragma(`table_info(${table})`) as Array<{ name: string }>)
        .map((row) => row.name)
      if (!isDeepStrictEqual(actual, expectedColumns)) {
        throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
      }
    }
    const ownerCount = (initialization.prepare(
      'SELECT COUNT(*) AS count FROM barrier_owner',
    ).get() as { count: number }).count
    if (ownerCount !== 0) throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
  } catch (error) {
    if (error instanceof ProtectedMemoryScopeBarrierError) throw error
    if (sqliteBusy(error)) throw new ProtectedMemoryScopeBarrierError('SCOPE_BUSY')
    throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
  } finally {
    initialization?.close()
  }

  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const newNonce = input.newNonce ?? randomUUID
  const pid = input.pid ?? process.pid

  return Object.freeze<ProtectedMemoryScopeBarrier>({
    async withScopeExclusive<T>(
      lease: TurnContextLease,
      requestedScope: ProtectedMemoryScope,
      run: () => Promise<T>,
    ): Promise<T> {
      if (lease.operatorId !== input.operatorId || lease.profileId !== input.profileId ||
        !sameScope(scope, requestedScope) ||
        (scope.kind === 'project' &&
          (lease.projectKind !== 'project' || lease.projectId !== scope.projectId))) {
        throw new ProtectedMemoryScopeBarrierError('SCOPE_MISMATCH')
      }
      let db: Database.Database
      try {
        ensurePrivateDatabasePath(lockPath)
        db = open(lockPath)
      } catch (error) {
        if (error instanceof ProtectedMemoryScopeBarrierError) throw error
        if (sqliteBusy(error)) throw new ProtectedMemoryScopeBarrierError('SCOPE_BUSY')
        throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
      }
      let callbackFailed = false
      try {
        try {
          db.exec('BEGIN IMMEDIATE')
        } catch (error) {
          if (sqliteBusy(error)) throw new ProtectedMemoryScopeBarrierError('SCOPE_BUSY')
          throw error
        }
        const owner: BarrierOwner = {
          singleton: 1,
          operator_id: lease.operatorId,
          profile_id: lease.profileId,
          session_id: lease.sessionId,
          generation: lease.generation,
          pid,
          nonce: newNonce(),
          acquired_at: nowIso(),
        }
        db.prepare(`
          INSERT INTO barrier_owner (
            singleton, operator_id, profile_id, session_id,
            generation, pid, nonce, acquired_at
          ) VALUES (@singleton, @operator_id, @profile_id, @session_id,
            @generation, @pid, @nonce, @acquired_at)
        `).run(owner)
        let result: T
        try {
          result = await run()
        } catch (error) {
          callbackFailed = true
          try { db.exec('ROLLBACK') } catch { /* preserve the callback error */ }
          throw error
        }
        const durableOwner = db.prepare(
          'SELECT * FROM barrier_owner WHERE singleton = 1',
        ).get() as BarrierOwner | undefined
        if (!isDeepStrictEqual(durableOwner, owner)) {
          db.exec('ROLLBACK')
          throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
        }
        const deleted = db.prepare(
          'DELETE FROM barrier_owner WHERE singleton = 1 AND nonce = ?',
        ).run(owner.nonce)
        if (deleted.changes !== 1) {
          db.exec('ROLLBACK')
          throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
        }
        db.exec('COMMIT')
        return result
      } catch (error) {
        if (db.inTransaction) {
          try { db.exec('ROLLBACK') } catch { /* preserve the primary error */ }
        }
        if (callbackFailed) throw error
        if (error instanceof ProtectedMemoryScopeBarrierError) throw error
        if (sqliteBusy(error)) throw new ProtectedMemoryScopeBarrierError('SCOPE_BUSY')
        throw new ProtectedMemoryScopeBarrierError('STATE_CORRUPT')
      } finally {
        db.close()
      }
    },
  })
}

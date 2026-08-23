import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type {
  EmbeddingDescriptor,
  RetrievalScope,
  ScopedRetrievalCandidate,
} from './hybrid-retrieval.js'

const SCHEMA_VERSION = 1

export type SemanticVectorStoreState = 'healthy' | 'revoked' | 'disabled'

export class SemanticVectorStoreError extends Error {
  constructor(public readonly code:
    | 'EXTENSION_UNAVAILABLE'
    | 'DESCRIPTOR_MISMATCH'
    | 'SCOPE_MISMATCH'
    | 'FILTER_VIOLATION'
    | 'CORRUPT_INDEX'
    | 'REVOKED'
    | 'DISABLED'
    | 'INVALID_RECORD'
    | 'REENABLE_REQUIRES_EMPTY_STORE',
  ) {
    super(code)
    this.name = 'SemanticVectorStoreError'
  }
}

export interface SemanticIndexRecord {
  candidate: ScopedRetrievalCandidate
  factKey: string
  cacheKey: string
}

export interface SemanticVectorIntegrityResult {
  ok: boolean
  detail?: 'SQLITE_INTEGRITY' | 'ROWSET_MISMATCH' | 'INVALID_VECTOR_CACHE'
}

export interface SemanticVectorStore {
  state(): SemanticVectorStoreState
  getCached(cacheKey: string): readonly number[] | null
  putCached(
    kind: 'query' | 'document',
    cacheKey: string,
    vector: readonly number[],
  ): void
  upsert(record: SemanticIndexRecord, vector: readonly number[]): Promise<void>
  search(vector: readonly number[], limit: number): Promise<ScopedRetrievalCandidate[]>
  removeFact(factKey: string): void
  hasFact(factKey: string): boolean
  revokeAndPurge(): void
  enableAfterReconnect(): void
  integrityCheck(): SemanticVectorIntegrityResult
  close(): void
}

interface ControlRow {
  schema_version: number
  scope_json: string
  descriptor_json: string
  state: SemanticVectorStoreState
}

interface MetadataRow {
  rowid: number
  hit_id: string
  scope: RetrievalScope['kind']
  scope_id: string
  project_id: string | null
  source_path: string
  chunk_id: string
  content_hash: string
  provenance: string
  fact_key: string
  cache_key: string
}

function stableDescriptor(descriptor: EmbeddingDescriptor): EmbeddingDescriptor {
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    modelRevision: descriptor.modelRevision,
    dimensions: descriptor.dimensions,
    normalizationVersion: descriptor.normalizationVersion,
    chunkerVersion: descriptor.chunkerVersion,
  }
}

function stableScope(scope: RetrievalScope): RetrievalScope {
  if (scope.kind === 'global') return { kind: 'global', scopeId: 'global' }
  if (scope.kind === 'project') {
    return { kind: 'project', scopeId: scope.scopeId, projectId: scope.projectId }
  }
  return { kind: 'monitoring', scopeId: scope.scopeId, monitorId: scope.monitorId }
}

function scopeValid(scope: RetrievalScope): boolean {
  if (scope.kind === 'global') return scope.scopeId === 'global'
  if (scope.kind === 'project') {
    return scope.projectId.length > 0 && scope.scopeId === `project:${scope.projectId}`
  }
  return scope.monitorId.length > 0 && scope.scopeId === `monitoring:${scope.monitorId}`
}

function logicalKey(candidate: ScopedRetrievalCandidate): string {
  return [candidate.scopeId, candidate.sourcePath, candidate.chunkId]
    .map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`)
    .join('|')
}

function keyValid(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

function vectorBuffer(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

function vecRowId(value: number | bigint): bigint {
  const numeric = typeof value === 'bigint' ? value : BigInt(value)
  if (numeric < 1n || numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SemanticVectorStoreError('CORRUPT_INDEX')
  }
  return numeric
}

function decodeVector(bytes: Buffer): number[] {
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new SemanticVectorStoreError('CORRUPT_INDEX')
  }
  const copy = Buffer.from(bytes)
  return Array.from(new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
  ))
}

function candidateFrom(row: MetadataRow, score: number): ScopedRetrievalCandidate {
  return {
    hitId: row.hit_id,
    scope: row.scope,
    scopeId: row.scope_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    sourcePath: row.source_path,
    chunkId: row.chunk_id,
    contentHash: row.content_hash,
    provenance: row.provenance,
    score,
  }
}

/**
 * One sqlite-vec database owns exactly one scope and embedding descriptor.
 * Canonical text is never stored here; this database is derived/disposable.
 */
export function makeSqliteVecSemanticStore(input: {
  dbPath: string
  scope: RetrievalScope
  descriptor: EmbeddingDescriptor
  verifyLive(record: SemanticIndexRecord): boolean | Promise<boolean>
}): SemanticVectorStore {
  const scope = Object.freeze(stableScope(input.scope))
  const descriptor = Object.freeze(stableDescriptor(input.descriptor))
  if (!scopeValid(scope)) throw new SemanticVectorStoreError('SCOPE_MISMATCH')
  if (!Number.isInteger(descriptor.dimensions) || descriptor.dimensions < 1 ||
    [descriptor.provider, descriptor.modelId, descriptor.modelRevision,
      descriptor.normalizationVersion, descriptor.chunkerVersion]
      .some((value) => value.length === 0)) {
    throw new SemanticVectorStoreError('DESCRIPTOR_MISMATCH')
  }

  mkdirSync(dirname(input.dbPath), { recursive: true, mode: 0o700 })
  const existed = existsSync(input.dbPath)
  if (existed) {
    let stat
    try {
      stat = lstatSync(input.dbPath)
    } catch {
      throw new SemanticVectorStoreError('CORRUPT_INDEX')
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SemanticVectorStoreError('CORRUPT_INDEX')
    }
  }
  let db: Database.Database | undefined
  try {
    db = new Database(input.dbPath)
    chmodSync(input.dbPath, 0o600)
    sqliteVec.load(db)
  } catch {
    try { db?.close() } catch { /* preserve the typed startup error */ }
    throw new SemanticVectorStoreError('EXTENSION_UNAVAILABLE')
  }
  db.pragma('journal_mode = DELETE')
  db.pragma('synchronous = FULL')
  db.pragma('secure_delete = ON')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      scope_json TEXT NOT NULL,
      descriptor_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('healthy', 'revoked', 'disabled')),
      reason TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS embedding_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('query', 'document')),
      vector BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS semantic_metadata (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      logical_key TEXT UNIQUE NOT NULL,
      hit_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      project_id TEXT,
      source_path TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      provenance TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      cache_key TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS semantic_metadata_fact_key
      ON semantic_metadata(fact_key);
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vectors USING vec0(
      embedding float[${descriptor.dimensions}] distance_metric=cosine
    );
  `)

  const expectedScope = JSON.stringify(scope)
  const expectedDescriptor = JSON.stringify(descriptor)
  const control = db.prepare(
    'SELECT schema_version, scope_json, descriptor_json, state FROM semantic_control WHERE singleton = 1',
  ).get() as ControlRow | undefined
  if (control === undefined) {
    if (existed) {
      db.close()
      throw new SemanticVectorStoreError('CORRUPT_INDEX')
    }
    db.prepare(
      `INSERT INTO semantic_control
       (singleton, schema_version, scope_json, descriptor_json, state, reason)
       VALUES (1, ?, ?, ?, 'healthy', '')`,
    ).run(SCHEMA_VERSION, expectedScope, expectedDescriptor)
  } else if (control.schema_version !== SCHEMA_VERSION ||
    control.descriptor_json !== expectedDescriptor) {
    db.close()
    throw new SemanticVectorStoreError('DESCRIPTOR_MISMATCH')
  } else if (control.scope_json !== expectedScope) {
    db.close()
    throw new SemanticVectorStoreError('SCOPE_MISMATCH')
  }
  let currentState = control?.state ?? 'healthy'

  const assertVector = (vector: readonly number[]): void => {
    if (vector.length !== descriptor.dimensions ||
      vector.some((value) => !Number.isFinite(value))) {
      throw new SemanticVectorStoreError('INVALID_RECORD')
    }
  }
  const assertUsable = (): void => {
    if (currentState === 'revoked') throw new SemanticVectorStoreError('REVOKED')
    if (currentState === 'disabled') throw new SemanticVectorStoreError('DISABLED')
  }
  const setState = (state: SemanticVectorStoreState, reason: string): void => {
    currentState = state
    db.prepare('UPDATE semantic_control SET state = ?, reason = ? WHERE singleton = 1')
      .run(state, reason)
  }
  const recordValid = (record: SemanticIndexRecord): boolean => {
    const candidate = record.candidate
    return candidate.scope === scope.kind && candidate.scopeId === scope.scopeId &&
      (scope.kind === 'project'
        ? candidate.projectId === scope.projectId
        : candidate.projectId === undefined) &&
      [candidate.hitId, candidate.sourcePath, candidate.chunkId, candidate.contentHash,
        candidate.provenance, record.factKey].every((value) => value.length > 0) &&
      Number.isFinite(candidate.score) && keyValid(record.cacheKey)
  }
  const metadataFor = (rowid: number): MetadataRow | undefined => db.prepare(
    `SELECT rowid, hit_id, scope, scope_id, project_id, source_path, chunk_id,
            content_hash, provenance, fact_key, cache_key
       FROM semantic_metadata WHERE rowid = ?`,
  ).get(rowid) as MetadataRow | undefined

  return {
    state: () => currentState,

    getCached(cacheKey) {
      assertUsable()
      if (!keyValid(cacheKey)) throw new SemanticVectorStoreError('INVALID_RECORD')
      const row = db.prepare('SELECT vector FROM embedding_cache WHERE cache_key = ?')
        .get(cacheKey) as { vector: Buffer } | undefined
      if (!row) return null
      const vector = decodeVector(row.vector)
      assertVector(vector)
      return Object.freeze(vector)
    },

    putCached(kind, cacheKey, vector) {
      assertUsable()
      if (!keyValid(cacheKey)) throw new SemanticVectorStoreError('INVALID_RECORD')
      assertVector(vector)
      db.prepare(
        `INSERT INTO embedding_cache (cache_key, kind, vector) VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET kind = excluded.kind, vector = excluded.vector`,
      ).run(cacheKey, kind, vectorBuffer(vector))
    },

    async upsert(source, vector) {
      assertUsable()
      const record: SemanticIndexRecord = Object.freeze({
        candidate: Object.freeze({ ...source.candidate }),
        factKey: source.factKey,
        cacheKey: source.cacheKey,
      })
      if (!recordValid(record)) throw new SemanticVectorStoreError('INVALID_RECORD')
      assertVector(vector)
      if (!await input.verifyLive(record)) {
        db.prepare('DELETE FROM embedding_cache WHERE cache_key = ?').run(record.cacheKey)
        throw new SemanticVectorStoreError('FILTER_VIOLATION')
      }
      assertUsable()
      const write = db.transaction(() => {
        const key = logicalKey(record.candidate)
        const existing = db.prepare(
          'SELECT rowid FROM semantic_metadata WHERE logical_key = ?',
        ).get(key) as { rowid: number } | undefined
        const projectId = record.candidate.projectId ?? null
        if (existing) {
          db.prepare('DELETE FROM semantic_vectors WHERE rowid = ?').run(vecRowId(existing.rowid))
          db.prepare(
            `UPDATE semantic_metadata SET hit_id = ?, scope = ?, scope_id = ?, project_id = ?,
              source_path = ?, chunk_id = ?, content_hash = ?, provenance = ?, fact_key = ?,
              cache_key = ? WHERE rowid = ?`,
          ).run(
            record.candidate.hitId,
            record.candidate.scope,
            record.candidate.scopeId,
            projectId,
            record.candidate.sourcePath,
            record.candidate.chunkId,
            record.candidate.contentHash,
            record.candidate.provenance,
            record.factKey,
            record.cacheKey,
            existing.rowid,
          )
          db.prepare('INSERT INTO semantic_vectors(rowid, embedding) VALUES (?, ?)')
            .run(vecRowId(existing.rowid), vectorBuffer(vector))
          return
        }
        const inserted = db.prepare(
          `INSERT INTO semantic_metadata
            (logical_key, hit_id, scope, scope_id, project_id, source_path, chunk_id,
             content_hash, provenance, fact_key, cache_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          key,
          record.candidate.hitId,
          record.candidate.scope,
          record.candidate.scopeId,
          projectId,
          record.candidate.sourcePath,
          record.candidate.chunkId,
          record.candidate.contentHash,
          record.candidate.provenance,
          record.factKey,
          record.cacheKey,
        )
        const rowid = Number(inserted.lastInsertRowid)
        if (!Number.isSafeInteger(rowid)) {
          throw new SemanticVectorStoreError('CORRUPT_INDEX')
        }
        db.prepare('INSERT INTO semantic_vectors(rowid, embedding) VALUES (?, ?)')
          .run(vecRowId(rowid), vectorBuffer(vector))
      })
      write()
    },

    async search(vector, limit) {
      assertUsable()
      assertVector(vector)
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new SemanticVectorStoreError('INVALID_RECORD')
      }
      const rows = db.prepare(
        `SELECT rowid, distance FROM semantic_vectors
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      ).all(vectorBuffer(vector), limit) as Array<{ rowid: number; distance: number }>
      const results: ScopedRetrievalCandidate[] = []
      for (const row of rows) {
        const metadata = metadataFor(row.rowid)
        if (!metadata || !Number.isFinite(row.distance)) {
          setState('disabled', 'ROWSET_MISMATCH')
          throw new SemanticVectorStoreError('CORRUPT_INDEX')
        }
        const candidate = candidateFrom(metadata, 1 - row.distance)
        const record = Object.freeze({
          candidate: Object.freeze(candidate),
          factKey: metadata.fact_key,
          cacheKey: metadata.cache_key,
        })
        if (!await input.verifyLive(record)) {
          setState('disabled', 'FILTER_VIOLATION')
          throw new SemanticVectorStoreError('FILTER_VIOLATION')
        }
        results.push(Object.freeze(candidate))
      }
      assertUsable()
      return results
    },

    removeFact(factKey) {
      if (factKey.length === 0) throw new SemanticVectorStoreError('INVALID_RECORD')
      const remove = db.transaction(() => {
        const rows = db.prepare(
          'SELECT rowid, cache_key FROM semantic_metadata WHERE fact_key = ?',
        ).all(factKey) as Array<{ rowid: number; cache_key: string }>
        for (const row of rows) {
          db.prepare('DELETE FROM semantic_vectors WHERE rowid = ?').run(vecRowId(row.rowid))
          db.prepare('DELETE FROM semantic_metadata WHERE rowid = ?').run(row.rowid)
          const stillUsed = db.prepare(
            'SELECT 1 FROM semantic_metadata WHERE cache_key = ? LIMIT 1',
          ).get(row.cache_key)
          if (!stillUsed) db.prepare('DELETE FROM embedding_cache WHERE cache_key = ?').run(row.cache_key)
        }
      })
      remove()
    },

    hasFact(factKey) {
      if (!keyValid(factKey)) throw new SemanticVectorStoreError('INVALID_RECORD')
      return db.prepare(
        'SELECT 1 FROM semantic_metadata WHERE fact_key = ? LIMIT 1',
      ).get(factKey) !== undefined
    },

    revokeAndPurge() {
      // Persist revocation before deletion. If purge fails, restart remains
      // revoked and cannot serve leftover derived rows.
      setState('revoked', 'PROVIDER_REVOKED')
      const purge = db.transaction(() => {
        db.exec('DELETE FROM semantic_vectors')
        db.exec('DELETE FROM semantic_metadata')
        db.exec('DELETE FROM embedding_cache')
      })
      purge()
    },

    enableAfterReconnect() {
      const counts = db.prepare(
        `SELECT
          (SELECT count(*) FROM semantic_metadata) AS metadata_count,
          (SELECT count(*) FROM semantic_vectors) AS vector_count,
          (SELECT count(*) FROM embedding_cache) AS cache_count`,
      ).get() as { metadata_count: number; vector_count: number; cache_count: number }
      if (counts.metadata_count !== 0 || counts.vector_count !== 0 || counts.cache_count !== 0) {
        throw new SemanticVectorStoreError('REENABLE_REQUIRES_EMPTY_STORE')
      }
      setState('healthy', '')
    },

    integrityCheck() {
      try {
        const sqlite = db.pragma('integrity_check', { simple: true }) as string
        if (sqlite !== 'ok') return { ok: false, detail: 'SQLITE_INTEGRITY' }
        const counts = db.prepare(
          `SELECT
            (SELECT count(*) FROM semantic_metadata) AS metadata_count,
            (SELECT count(*) FROM semantic_vectors) AS vector_count`,
        ).get() as { metadata_count: number; vector_count: number }
        if (counts.metadata_count !== counts.vector_count) {
          return { ok: false, detail: 'ROWSET_MISMATCH' }
        }
        const cache = db.prepare('SELECT vector FROM embedding_cache').all() as Array<{ vector: Buffer }>
        if (cache.some((row) => {
          try {
            assertVector(decodeVector(row.vector))
            return false
          } catch {
            return true
          }
        })) return { ok: false, detail: 'INVALID_VECTOR_CACHE' }
        return { ok: true }
      } catch {
        return { ok: false, detail: 'SQLITE_INTEGRITY' }
      }
    },

    close: () => db.close(),
  }
}

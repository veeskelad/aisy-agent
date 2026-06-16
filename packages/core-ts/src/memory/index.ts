import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

import type {
  Memory,
  MemoryStoreDeps,
  MemoryOp,
  CommitResult,
  RankedHit,
  LazyLoadStep,
  FrozenSnapshot,
  IntegrityResult,
} from './types.js'
import { CorruptIndexError, ForgetListTamperError } from './types.js'

export type { Memory, Memory as MemoryStore, MemoryStoreDeps, MemoryFact } from './types.js'

export type {
  FactKey,
  MemoryOp,
  GuardVerdict,
  CommitResult,
  RankedHit,
  LazyLoadStep,
  ForgetListEntry,
  FrozenSnapshot,
  IntegrityResult,
} from './types.js'

export {
  CorruptIndexError,
  ForgetListTamperError,
  BypassError,
  GuardBlocked,
} from './types.js'

// ---------------------------------------------------------------------------
// Deterministic fact-key extraction (§5.4) — equivalence class over
// (entity, relation, object), no model call on this path.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'i', 'my', 'me', 'a', 'an', 'the', 'is', 'are', 'was', 'were', 'in', 'on',
  'at', 'of', 'to', 'and', 'or', 'where', 'that', 'this', 'it', 'be', 'am',
])

/** Relation/synonym canonicalization — collapses common paraphrases. */
const CANON: Record<string, string> = {
  live: 'reside', lives: 'reside', living: 'reside', home: 'reside',
  reside: 'reside', resides: 'reside', residence: 'reside',
  job: 'role', position: 'role', role: 'role',
}

function keyTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t))
    .map(t => CANON[t] ?? t)
  return [...new Set(tokens)].sort()
}

function factKeyOf(tokens: string[]): string {
  return sha256(tokens.join('|'))
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  text TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  key_tokens TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  is_human_confirmed INTEGER NOT NULL DEFAULT 0,
  source_authority INTEGER,
  confidence REAL,
  provenance TEXT NOT NULL DEFAULT '',
  supersedes TEXT,
  contradicts TEXT,
  extends_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(fact_key);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(text);
CREATE TABLE IF NOT EXISTS do_not_remember (
  rowid INTEGER PRIMARY KEY,
  fact_key TEXT NOT NULL,
  key_tokens TEXT NOT NULL,
  reason TEXT NOT NULL,
  is_human_confirmed INTEGER NOT NULL,
  ts TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL
);
`

interface FactRow {
  rowid: number
  id: string
  text: string
  fact_key: string
  key_tokens: string
  valid_at: string
  invalid_at: string | null
  is_human_confirmed: number
}

interface DnrRow {
  rowid: number
  fact_key: string
  key_tokens: string
  reason: string
  is_human_confirmed: number
  ts: string
  prev_hash: string
  row_hash: string
}

/** The read/ingestion filter (§5.1 step 1) — applied in the SQL itself. */
const LIVE_FILTER = `invalid_at IS NULL AND fact_key NOT IN (SELECT fact_key FROM do_not_remember)`

/**
 * Spec §3 "Events emitted" — the Observability binding vocabulary. Each commit
 * outcome maps to its declared event name (a fact mutation that did not
 * supersede/block is `memory.committed`; NOT_FOUND is still a committed-class
 * no-op outcome). The spec has no `memory.commit`/`memory.forget` event.
 */
const EVENT_BY_STATUS: Record<CommitResult['status'], string> = {
  COMMITTED: 'memory.committed',
  SUPERSEDED: 'memory.superseded',
  BLOCKED: 'memory.guard_blocked',
  ROUTED_TO_REVIEW: 'memory.routed_to_review',
  NOT_FOUND: 'memory.committed',
}

// ---------------------------------------------------------------------------
// makeMemoryStore — the single indexer choke point (§5.1, ADR-0030)
// ---------------------------------------------------------------------------

export function makeMemoryStore(deps: MemoryStoreDeps): Memory {
  let db: Database.Database | null = null
  let frozen: FrozenSnapshot | null = null

  const open = (): Database.Database => {
    if (db) return db
    mkdirSync(dirname(deps.dbPath), { recursive: true })
    db = new Database(deps.dbPath)
    db.exec(SCHEMA)
    return db
  }

  /** Reads block on cold start (§5.8 fail-loud) until an index exists. */
  const openForRead = (): Database.Database => {
    if (db) return db
    if (!existsSync(deps.dbPath)) {
      throw new CorruptIndexError('cold start: no index on disk — run rebuildFromFiles() first')
    }
    return open()
  }

  // --- forget-list (append-only, hash-chained; §4) ---

  const dnrRows = (d: Database.Database): DnrRow[] =>
    d.prepare('SELECT * FROM do_not_remember ORDER BY rowid').all() as DnrRow[]

  const appendForgetRow = (
    d: Database.Database,
    factKey: string,
    tokens: string[],
    reason: string,
    humanConfirmed: boolean,
  ): void => {
    const last = d.prepare('SELECT row_hash FROM do_not_remember ORDER BY rowid DESC LIMIT 1').get() as
      | { row_hash: string }
      | undefined
    const prevHash = last?.row_hash ?? 'genesis'
    const ts = deps.nowIso()
    const rowHash = sha256(`${prevHash}‖${factKey}‖${tokens.join('|')}‖${reason}‖${ts}`)
    d.prepare(
      'INSERT INTO do_not_remember (fact_key, key_tokens, reason, is_human_confirmed, ts, prev_hash, row_hash) VALUES (?,?,?,?,?,?,?)',
    ).run(factKey, tokens.join('|'), reason, humanConfirmed ? 1 : 0, ts, prevHash, rowHash)
  }

  const verifyForgetChain = (d: Database.Database): { ok: boolean; detail?: string } => {
    let prev = 'genesis'
    for (const row of dnrRows(d)) {
      const expect = sha256(`${prev}‖${row.fact_key}‖${row.key_tokens}‖${row.reason}‖${row.ts}`)
      if (row.prev_hash !== prev || row.row_hash !== expect) {
        return { ok: false, detail: `hash mismatch at row ${row.rowid}` }
      }
      prev = row.row_hash
    }
    return { ok: true }
  }

  // --- resurrection-guard (§5.5) — write-time, deterministic ---

  type Guard = 'PASS' | 'BLOCK' | 'REVIEW'

  const guardCheck = (d: Database.Database, factKey: string, tokens: string[]): Guard => {
    const exact = d.prepare('SELECT rowid FROM do_not_remember WHERE fact_key = ?').get(factKey)
    if (exact) return 'BLOCK'
    // Residual-paraphrase fail-safe (§5.4): partial token overlap with a
    // forgotten equivalence class routes to human review, never silent commit.
    const tokenSet = new Set(tokens)
    for (const row of dnrRows(d)) {
      const theirs = row.key_tokens.split('|')
      if (theirs.some(t => t.length > 0 && tokenSet.has(t))) return 'REVIEW'
    }
    return 'PASS'
  }

  // --- tombstone helper (soft delete; no hard DELETE — §4) ---

  const invalidate = (d: Database.Database, row: FactRow, humanConfirmed: boolean): void => {
    d.prepare('UPDATE facts SET invalid_at = ?, is_human_confirmed = ? WHERE rowid = ?').run(
      deps.nowIso(),
      humanConfirmed ? 1 : 0,
      row.rowid,
    )
    d.prepare('DELETE FROM fts WHERE rowid = ?').run(row.rowid)
  }

  const insertFact = (
    d: Database.Database,
    text: string,
    factKey: string,
    tokens: string[],
    supersedes?: string,
  ): string => {
    const id = randomUUID()
    const info = d.prepare(
      'INSERT INTO facts (id, text, fact_key, key_tokens, valid_at, provenance, supersedes) VALUES (?,?,?,?,?,?,?)',
    ).run(id, text, factKey, tokens.join('|'), deps.nowIso(), 'commit', supersedes ?? null)
    d.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)').run(info.lastInsertRowid, text)
    return id
  }

  const findById = (d: Database.Database, id: string): FactRow | undefined =>
    d.prepare('SELECT * FROM facts WHERE id = ?').get(id) as FactRow | undefined

  const refreshDerivedIndex = (d: Database.Database): void => {
    // Every rebuild re-applies the full forget invariant (ADR-0030): the
    // filter is in the SQL — there is no path around it.
    d.exec('BEGIN')
    d.exec('DELETE FROM fts')
    d.exec(`INSERT INTO fts (rowid, text) SELECT rowid, text FROM facts WHERE ${LIVE_FILTER}`)
    d.exec('COMMIT')
  }

  const reindexScoped = (d: Database.Database, ids: string[]): void => {
    // Scoped reindex (§5.1, ADR-0030): re-sync ONLY the listed ids' FTS rows,
    // still through the forget filter. A listed id that is tombstoned/forgotten
    // is dropped from the index; a live one is re-inserted. Unlisted ids are
    // left untouched.
    const selectLive = d.prepare(
      `SELECT rowid, text FROM facts WHERE id = ? AND ${LIVE_FILTER}`,
    )
    const findRowid = d.prepare('SELECT rowid FROM facts WHERE id = ?')
    const delFts = d.prepare('DELETE FROM fts WHERE rowid = ?')
    const insFts = d.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)')
    d.exec('BEGIN')
    try {
      for (const id of ids) {
        const known = findRowid.get(id) as { rowid: number } | undefined
        if (!known) continue
        delFts.run(known.rowid)
        const live = selectLive.get(id) as { rowid: number; text: string } | undefined
        if (live) insFts.run(live.rowid, live.text)
      }
      d.exec('COMMIT')
    } catch (err) {
      try { d.exec('ROLLBACK') } catch { /* preserve the original error */ }
      throw err
    }
  }

  return {
    // READ PATH — filter applied in the SQL itself (§5.2)
    async search(query: string, opts?: { limit?: number }): Promise<RankedHit[]> {
      const d = openForRead()
      const chain = verifyForgetChain(d)
      if (!chain.ok) throw new ForgetListTamperError(chain.detail ?? 'hash chain break')
      // Reduce each token to its FTS5-indexable content (letters/digits) FIRST,
      // then drop tokens that are now empty, so a query of only quotes /
      // whitespace / punctuation yields no MATCH terms and is caught by the
      // guard below — never relying on FTS5 treating '""' as an empty query.
      const match = query
        .split(/\s+/)
        .map(t => t.replace(/[^a-zA-Z0-9]+/g, ''))
        .filter(t => t.length > 0)
        .map(t => `"${t}"`)
        .join(' OR ')
      if (!match) return []
      const rows = d.prepare(
        `SELECT f.id, f.fact_key, f.text, bm25(fts) AS score
         FROM fts JOIN facts f ON f.rowid = fts.rowid
         WHERE fts MATCH ? AND f.invalid_at IS NULL
           AND f.fact_key NOT IN (SELECT fact_key FROM do_not_remember)
         ORDER BY score LIMIT ?`,
      ).all(match, opts?.limit ?? 20) as Array<{ id: string; fact_key: string; text: string; score: number }>
      return rows.map(r => ({ id: r.id, factKey: r.fact_key, text: r.text, score: r.score }))
    },

    // Filter applies at EVERY lazy-load step — a tombstoned fact never leaks
    // even as a 50-token annotation (§5.2).
    async load(hitId: string, step: LazyLoadStep): Promise<string> {
      const d = openForRead()
      const chain = verifyForgetChain(d)
      if (!chain.ok) throw new ForgetListTamperError(chain.detail ?? 'hash chain break')
      const row = findById(d, hitId)
      if (!row || row.invalid_at !== null) {
        throw new CorruptIndexError(`fact ${hitId} is not live (tombstoned or unknown)`)
      }
      const dnr = d.prepare('SELECT rowid FROM do_not_remember WHERE fact_key = ?').get(row.fact_key)
      if (dnr) throw new CorruptIndexError(`fact ${hitId} is on the forget-list`)
      if (step === 'annotation') return row.text.slice(0, 200)
      if (step === 'overview') return row.text.slice(0, 2000)
      return row.text
    },

    // SESSION SNAPSHOT — read once, frozen for the store's lifetime (ADR-0007)
    async readFrozenSnapshot(): Promise<FrozenSnapshot> {
      if (frozen) return frozen
      const parts: Buffer[] = []
      for (const name of ['constitution.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
        const p = join(deps.memoryRoot, name)
        if (existsSync(p)) parts.push(readFileSync(p))
      }
      const bytes = Buffer.concat(parts)
      frozen = { bytes, sha256: sha256(bytes) }
      return frozen
    },

    // WRITE PATH — the single choke point (§5.1). Guard + contradiction
    // resolution + reindex in one transaction; journal emit is fail-closed.
    async commit(op: MemoryOp, _ctx: { withinSession: boolean }): Promise<CommitResult> {
      const d = open()
      d.exec('BEGIN')
      try {
        let result: CommitResult

        if (op.op === 'NOOP') {
          result = { status: 'COMMITTED', factId: op.targetId }
        } else if (op.op === 'DELETE') {
          const target = findById(d, op.targetId)
          if (target) {
            invalidate(d, target, op.humanConfirmed)
            if (op.humanConfirmed) {
              appendForgetRow(d, target.fact_key, target.key_tokens.split('|'), op.reason, true)
            }
            result = { status: 'COMMITTED', factId: op.targetId }
          } else {
            // No such fact — the intended (permanent) forget never happened.
            // Surface that nothing was deleted rather than a misleading COMMITTED.
            result = { status: 'NOT_FOUND', factId: op.targetId }
          }
        } else {
          // ADD / UPDATE share the guarded insert path
          const tokens = keyTokens(op.text)
          const factKey = factKeyOf(tokens)
          const guard = guardCheck(d, factKey, tokens)
          if (guard === 'BLOCK') {
            result = {
              status: 'BLOCKED',
              verdict: { decision: 'BLOCK', matched: 'forget_list', factId: factKey },
            }
          } else if (guard === 'REVIEW') {
            // fail-safe: surfaced for human review, never stored searchable
            result = { status: 'ROUTED_TO_REVIEW', verdict: { decision: 'REVIEW', reason: 'residual_paraphrase' } }
          } else if (op.op === 'UPDATE') {
            const target = findById(d, op.targetId)
            if (target && target.invalid_at === null) invalidate(d, target, false)
            const id = insertFact(d, op.text, factKey, tokens, target?.fact_key)
            result = { status: 'SUPERSEDED', factId: id }
          } else {
            // Contradiction resolution (§5.6): a live fact with the same key is
            // recency-superseded (tombstone, NOT forget-list) — re-assertable.
            const live = d.prepare('SELECT * FROM facts WHERE fact_key = ? AND invalid_at IS NULL').all(
              factKey,
            ) as FactRow[]
            for (const row of live) invalidate(d, row, false)
            const id = insertFact(d, op.text, factKey, tokens)
            result = { status: 'COMMITTED', factId: id }
          }
        }

        // Fail-closed journal binding: if the Observability emit fails, the
        // whole commit rolls back and no searchable fact persists (AC-03-15).
        // Event name comes from the spec §3 "Events emitted" vocabulary,
        // selected by outcome so the Observability binding is correct.
        await deps.emitEvent(EVENT_BY_STATUS[result.status], { op: op.op, status: result.status })
        d.exec('COMMIT')
        return result
      } catch (err) {
        try { d.exec('ROLLBACK') } catch { /* preserve the original error */ }
        throw err
      }
    },

    // FORGET-LIST — append-only, integrity-protected (§4)
    async forget(factId: string, reason: string, humanConfirmed: boolean): Promise<void> {
      const d = open()
      d.exec('BEGIN')
      try {
        const row = findById(d, factId)
        if (row) {
          invalidate(d, row, humanConfirmed)
          if (humanConfirmed) appendForgetRow(d, row.fact_key, row.key_tokens.split('|'), reason, true)
        }
        // forget() is a fact mutation (tombstone + forget-list append) →
        // the spec §3 vocabulary records it as memory.committed.
        await deps.emitEvent('memory.committed', { op: 'forget', factId, humanConfirmed })
        d.exec('COMMIT')
      } catch (err) {
        try { d.exec('ROLLBACK') } catch { /* preserve the original error */ }
        throw err
      }
    },

    // DERIVED-INDEX CONTRACT — any reindex routes through the choke point's
    // filter, never around it (ADR-0030). A scoped { ids } request reindexes
    // only those ids; 'all' rebuilds the whole derived index.
    async reindex(scope: 'all' | { ids: string[] }): Promise<void> {
      const d = open()
      if (scope === 'all') refreshDerivedIndex(d)
      else reindexScoped(d, scope.ids)
    },

    async rebuildFromFiles(): Promise<void> {
      // Reconstructs the derived FTS index from the canonical store,
      // re-applying the full forget invariant during rebuild (§5.8).
      refreshDerivedIndex(open())
    },

    // DETERMINISM — byte-stable MEMORY.md regeneration (§5.7): stable sort,
    // fixed UTC format, \n endings, single trailing newline, no volatile ids.
    async serializeMemoryIndex(): Promise<{ content: string; sha256: string }> {
      const d = open()
      const rows = d.prepare(
        `SELECT fact_key, valid_at, text FROM facts WHERE ${LIVE_FILTER}
         ORDER BY fact_key, valid_at, text`,
      ).all() as Array<{ fact_key: string; valid_at: string; text: string }>
      const lines = ['# Memory index', '']
      for (const r of rows) {
        lines.push(`- ${r.fact_key.slice(0, 12)} ${r.valid_at} ${r.text.replace(/\s+/g, ' ').trimEnd()}`)
      }
      const content = lines.join('\n').replace(/\n+$/, '') + '\n'
      return { content, sha256: sha256(content) }
    },

    // INTEGRITY — PRAGMA + forget-list chain (§5.8); fails loud, never empty
    async integrityCheck(): Promise<IntegrityResult> {
      if (!db && !existsSync(deps.dbPath)) {
        return { ok: false, detail: 'no index on disk' }
      }
      const d = open()
      const pragma = d.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (pragma[0]?.integrity_check !== 'ok') {
        return { ok: false, detail: `PRAGMA integrity_check: ${pragma[0]?.integrity_check}` }
      }
      const chain = verifyForgetChain(d)
      if (!chain.ok) {
        return { ok: false, detail: `ForgetListTamperError: ${chain.detail}` }
      }
      return { ok: true }
    },
  }
}

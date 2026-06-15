// Memory component types — extracted from spec §3 and §4.
// Pure interfaces and types; no implementation here.

// ---------------------------------------------------------------------------
// Core primitives
// ---------------------------------------------------------------------------

/** Hash of normalized (entity, relation, object) equivalence class. */
export type FactKey = string

/** The unit of forgetting and contradiction resolution (§4 fact row). */
export interface MemoryFact {
  id: string
  text: string              // canonical markdown surface form; files remain authoritative
  factKey: FactKey
  validAt: string           // ISO-8601; when the fact became true
  invalidAt: string | null  // null = live; set = soft-deleted/superseded; no hard DELETE
  isHumanConfirmed: boolean
  sourceAuthority: number | null // contradiction tier 3
  confidence: number | null      // contradiction tier 4
  provenance: string             // origin record id binding to the Observability journal

  // Typed relationship edges (§3 / §4)
  supersedes?: string  // fact_key this record replaces; sets predecessor invalid_at = now
  contradicts?: string // fact_key that conflicts; flagged for human contradiction resolution
  extends?: string     // fact_key this record elaborates or specializes
}

// ---------------------------------------------------------------------------
// Write-path types
// ---------------------------------------------------------------------------

export type MemoryOp =
  | { op: 'ADD'; text: string }
  | { op: 'UPDATE'; targetId: string; text: string }
  | { op: 'DELETE'; targetId: string; humanConfirmed: boolean; reason: string }
  | { op: 'NOOP'; targetId: string }

export type GuardVerdict =
  | { decision: 'PASS' }
  | { decision: 'BLOCK'; matched: 'tombstone' | 'forget_list' | 'human_confirmed_delete'; factId: string }
  | { decision: 'REVIEW'; reason: 'residual_paraphrase' } // fail-safe; never a silent commit

export interface CommitResult {
  status: 'COMMITTED' | 'BLOCKED' | 'ROUTED_TO_REVIEW' | 'SUPERSEDED' | 'NOT_FOUND'
  factId?: string
  verdict?: GuardVerdict
}

// ---------------------------------------------------------------------------
// Read-path types
// ---------------------------------------------------------------------------

export interface RankedHit {
  id: string
  factKey: FactKey
  text: string
  score: number // BM25 rank
  annotation?: string  // ~50-token excerpt; present when loaded at 'annotation' step
}

/** The three-step lazy-load depth (annotation → overview → full). */
export type LazyLoadStep = 'annotation' | 'overview' | 'full'

// ---------------------------------------------------------------------------
// Forget-list / tombstone types
// ---------------------------------------------------------------------------

/** One row of the append-only, hash-chained do_not_remember table (§4). */
export interface ForgetListEntry {
  factKey: FactKey
  reason: string
  isHumanConfirmed: boolean
  ts: string      // ISO-8601
  prevHash: string
  rowHash: string // H(prevHash ‖ factKey ‖ keyTokens ‖ reason ‖ ts) — keyTokens covered so the residual-paraphrase guard (CSO-H4) is tamper-evident
}

// ---------------------------------------------------------------------------
// Frozen snapshot (§4, §5.3)
// ---------------------------------------------------------------------------

export interface FrozenSnapshot {
  bytes: Buffer
  sha256: string
}

// ---------------------------------------------------------------------------
// Integrity / error types
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  ok: boolean
  detail?: string
}

/** Fail-loud error: corrupt FTS5/SQLite index detected. */
export class CorruptIndexError extends Error {
  constructor(detail: string) {
    super(`CorruptIndexError: ${detail}`)
    this.name = 'CorruptIndexError'
  }
}

/** Fail-loud error: hash-chain break on the do_not_remember forget-list. */
export class ForgetListTamperError extends Error {
  constructor(detail: string) {
    super(`ForgetListTamperError: ${detail}`)
    this.name = 'ForgetListTamperError'
  }
}

/** A fact-mutating write arrived without passing the indexer choke point. */
export class BypassError extends Error {
  constructor(detail: string) {
    super(`BypassError: ${detail}`)
    this.name = 'BypassError'
  }
}

/** Resurrection-guard blocked a write (convenience alias over CommitResult). */
export class GuardBlocked extends Error {
  constructor(public readonly verdict: GuardVerdict & { decision: 'BLOCK' }) {
    super(`GuardBlocked: fact_key matched ${verdict.matched}`)
    this.name = 'GuardBlocked'
  }
}

// ---------------------------------------------------------------------------
// Main Memory interface (§3)
// ---------------------------------------------------------------------------

export interface Memory {
  // READ PATH — every result filtered: invalid_at IS NULL AND id NOT IN do_not_remember
  search(query: string, opts?: { limit?: number }): Promise<RankedHit[]>  // FTS5/BM25 ~20ms
  load(hitId: string, step: LazyLoadStep): Promise<string>

  // SESSION SNAPSHOT — read once at session start, frozen for the session
  readFrozenSnapshot(): Promise<FrozenSnapshot>

  // WRITE PATH — the single choke point.
  // Applies read filter + resurrection-guard + contradiction resolution, then reindexes.
  // Returns BLOCK/REVIEW without storing a searchable fact on guard hit.
  commit(op: MemoryOp, ctx: { withinSession: boolean }): Promise<CommitResult>

  // FORGET-LIST — append-only, integrity-protected; no raw-write path exists.
  forget(factId: string, reason: string, humanConfirmed: boolean): Promise<void>

  // DERIVED-INDEX CONTRACT — any reindex/import/rebuild routes here, never around it.
  reindex(scope: 'all' | { ids: string[] }): Promise<void>
  rebuildFromFiles(): Promise<void> // used on corruption; re-applies the full forget invariant

  // DETERMINISM — byte-stable regeneration of the MEMORY.md index file
  serializeMemoryIndex(): Promise<{ content: string; sha256: string }>

  // INTEGRITY — PRAGMA integrity_check + FTS5 consistency
  integrityCheck(): Promise<IntegrityResult>
}

// ---------------------------------------------------------------------------
// Dependency injection surface (for makeMemoryStore)
// ---------------------------------------------------------------------------

export interface MemoryStoreDeps {
  /** Filesystem root that contains constitution.md, MEMORY.md, working/, daily/, etc. */
  memoryRoot: string
  /** Path to the SQLite db file (FTS5 index). */
  dbPath: string
  /** Emit an event to the Observability journal. Fail-closed: commit rolls back if this throws. */
  emitEvent(event: string, payload: unknown): Promise<void>
  /** Returns current time as ISO-8601 string (injectable for deterministic tests). */
  nowIso(): string
}

/** The public store type — same contract as Memory with its deps baked in. */
export type MemoryStore = Memory

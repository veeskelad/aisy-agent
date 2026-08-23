import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { isIP } from 'node:net'
import Database from 'better-sqlite3'
import { resolvedWorkBinding, type ResolvedWorkBinding } from '../runtime/work-binding.js'
import { isPublicHttpUrl } from '../runtime/web-tools.js'
import { MonitoringError } from './errors.js'
import { DEFAULT_CATEGORY_WEIGHTS } from './types.js'
import type {
  CollectedEvidence,
  DigestBuildConfig,
  DigestItem,
  EvidenceCategory,
  EvidenceScore,
  MonitoringDigest,
  MonitoringEngine,
  MonitoringEvent,
  MonitoringHttpPort,
  MonitoringHttpResponse,
  MonitoringEvidence,
  MonitoringFeedback,
  MonitoringPollBudget,
  MonitoringPollResult,
  MonitoringSearchHit,
  MonitoringSource,
  MonitoringSourceKind,
  MonitoringStore,
  MonitoringTickBudget,
} from './types.js'

export {
  makeGitHubMonitoringCollector,
  makeRssMonitoringCollector,
  makeTelegramMonitoringCollector,
  makeWebMonitoringCollector,
  makeYouTubeMonitoringCollector,
  parseMonitoringFeed,
  parsePublicTelegramPage,
} from './collectors.js'
export { makeProviderMonitoringScorer } from './scorer.js'
export { makeMonitoringFollowupEngine } from './followups.js'
export { MonitoringError } from './errors.js'

export type {
  CollectedEvidence,
  CollectionBatch,
  DigestBuildConfig,
  DigestItem,
  EvidenceCategory,
  EvidenceScore,
  EvidenceScoreInput,
  MonitoringCollector,
  MonitoringDigest,
  MonitoringEngine,
  MonitoringEvent,
  MonitoringHttpPort,
  MonitoringHttpResponse,
  MonitoringEvidence,
  MonitoringFeedback,
  MonitoringActionProposalV1,
  MonitoringFollowupActionFamily,
  MonitoringFollowupActionInput,
  MonitoringFollowupApprovalConsumer,
  MonitoringFollowupApprovalProof,
  MonitoringFollowupApprovalReceipt,
  MonitoringFollowupCode,
  MonitoringFollowupEngine,
  MonitoringFollowupEvidenceRef,
  MonitoringFollowupExecutionOutcome,
  MonitoringFollowupExecutionReceipt,
  MonitoringFollowupPrecondition,
  MonitoringFollowupRollbackReceipt,
  MonitoringFollowupRollbackVerificationReceipt,
  MonitoringFollowupStatus,
  MonitoringFollowupTier,
  MonitoringFollowupVerificationReceipt,
  MonitoringPollBudget,
  MonitoringPollResult,
  MonitoringScorer,
  MonitoringSearchHit,
  MonitoringSource,
  MonitoringSourceKind,
  MonitoringSourceStatus,
  MonitoringStore,
  MonitoringTickBudget,
} from './types.js'

const SOURCE_KINDS = new Set<MonitoringSourceKind>(['telegram', 'rss', 'youtube', 'github', 'web'])
const CATEGORIES = new Set<EvidenceCategory>(['critical', 'important', 'useful', 'noise'])
const MONITORING_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SECRET_QUERY_KEY = /(?:api[_-]?key|token|secret|password|authorization|credential)/i
const SECRET_QUERY_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}\b|\b[A-Fa-f0-9]{48,}\b|\b[A-Za-z0-9+/_-]{64,}={0,2}\b)/i

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitoring_sources (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  egress_domain TEXT,
  binding_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  criteria TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_collected_at TEXT,
  paused_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitoring_sources_route ON monitoring_sources(route_key, status);

CREATE TABLE IF NOT EXISTS monitoring_evidence (
  rowid INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  source_id TEXT NOT NULL REFERENCES monitoring_sources(id),
  binding_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  primary_url TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  collected_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance = 'untrusted'),
  score REAL,
  category TEXT,
  summary TEXT,
  why_useful TEXT,
  scored_at TEXT,
  needs_scoring INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_evidence_route_time
  ON monitoring_evidence(route_key, collected_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_evidence_hash
  ON monitoring_evidence(route_key, content_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS monitoring_fts USING fts5(title, text, author);

CREATE TABLE IF NOT EXISTS monitoring_digests (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  items_json TEXT NOT NULL,
  delivery_receipt TEXT,
  paused_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_monitoring_digests_due
  ON monitoring_digests(status, not_before, expires_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_digests_window
  ON monitoring_digests(route_key, window_start, window_end, created_at, id);

CREATE TABLE IF NOT EXISTS monitoring_feedback (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  digest_id TEXT NOT NULL REFERENCES monitoring_digests(id),
  evidence_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_followups (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  route_key TEXT NOT NULL,
  digest_id TEXT NOT NULL REFERENCES monitoring_digests(id),
  evidence_json TEXT NOT NULL,
  evidence_snapshot_hash TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tier INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  paused_from TEXT,
  proposal_delivery_receipt TEXT,
  approval_json TEXT,
  execution_receipt_json TEXT,
  verification_receipt_json TEXT,
  rollback_receipt_json TEXT,
  rollback_verification_receipt_json TEXT,
  last_code TEXT,
  claim_token TEXT,
  claim_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(route_key, action_hash)
);
CREATE INDEX IF NOT EXISTS idx_monitoring_followups_delivery
  ON monitoring_followups(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_monitoring_followups_execution
  ON monitoring_followups(status, claim_until, created_at, id);
`

interface SourceRow {
  id: string
  schema_version: number
  kind: string
  locator: string
  egress_domain: string | null
  binding_json: string
  criteria: string
  poll_interval_ms: number
  status: string
  cursor: string | null
  created_at: string
  updated_at: string
  last_collected_at: string | null
  paused_reason: string | null
}

interface EvidenceRow {
  rowid: number
  id: string
  source_id: string
  binding_json: string
  external_id: string
  primary_url: string
  title: string
  text: string
  author: string | null
  published_at: string | null
  collected_at: string
  content_hash: string
  provenance: string
  score: number | null
  category: string | null
  summary: string | null
  why_useful: string | null
  scored_at: string | null
  needs_scoring: number
}

interface DigestRow {
  id: string
  schema_version: number
  binding_json: string
  window_start: string
  window_end: string
  not_before: string
  expires_at: string
  created_at: string
  status: string
  items_json: string
  delivery_receipt: string | null
  paused_reason: string | null
}

function nonEmpty(value: string, max: number): string {
  const clean = value.trim()
  if (clean.length === 0 || clean.length > max) throw new MonitoringError('INVALID_SOURCE')
  return clean
}

function iso(value: string, code: MonitoringError['code']): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new MonitoringError(code)
  return value
}

function routeKey(binding: ResolvedWorkBinding): string {
  const clean = resolvedWorkBinding(binding)
  return [clean.operatorId, clean.profileId, clean.projectId, clean.scope,
    clean.scope === 'session' ? clean.sessionId : ''].join('\u0000')
}

function sameRoute(a: ResolvedWorkBinding, b: ResolvedWorkBinding): boolean {
  return routeKey(a) === routeKey(b)
}

function cleanLocator(value: string): string {
  const locator = nonEmpty(value, 2048)
  if (/^https?:\/\//i.test(locator)) {
    try {
      const url = new URL(locator)
      if (url.protocol !== 'https:') throw new Error('protocol')
      if (url.username.length > 0 || url.password.length > 0) throw new Error('credentials')
      for (const [key, queryValue] of url.searchParams) {
        if (SECRET_QUERY_KEY.test(key) || SECRET_QUERY_VALUE.test(queryValue)) {
          throw new Error('credentials')
        }
      }
      if (!isPublicHttpUrl(locator)) throw new Error('private-host')
    } catch {
      throw new MonitoringError('INVALID_SOURCE')
    }
  }
  return locator
}

/** Code-owned exact HTTPS authority derived once when a source is registered. */
function sourceEgressDomain(kind: MonitoringSourceKind, locator: string): string {
  const clean = cleanLocator(locator)
  if (clean !== locator) throw new MonitoringError('INVALID_SOURCE')
  if (kind === 'telegram') {
    const channel = clean.replace(/^@/, '')
    if (!/^[A-Za-z0-9_]{5,64}$/.test(channel)) throw new MonitoringError('INVALID_SOURCE')
    return 't.me'
  }
  if (kind === 'youtube' && !/^https?:\/\//i.test(clean)) {
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(clean)) throw new MonitoringError('INVALID_SOURCE')
    return 'www.youtube.com'
  }
  let url: URL
  try { url = new URL(clean) } catch { throw new MonitoringError('INVALID_SOURCE') }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || isIP(hostname) !== 0 || !MONITORING_DOMAIN.test(hostname) ||
    !isPublicHttpUrl(url.toString()) || (kind === 'github' && hostname !== 'github.com')) {
    throw new MonitoringError('INVALID_SOURCE')
  }
  return hostname
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    if (url.username.length > 0 || url.password.length > 0) throw new Error('credentials')
    if (!isPublicHttpUrl(value)) throw new Error('private-host')
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.toString()
  } catch {
    throw new MonitoringError('INVALID_EVIDENCE')
  }
}

function hashEvidence(item: CollectedEvidence): string {
  return createHash('sha256').update(JSON.stringify({
    primaryUrl: canonicalUrl(item.primaryUrl),
    title: item.title.normalize('NFKC').trim(),
    text: item.text.normalize('NFKC').replace(/\s+/g, ' ').trim(),
    author: item.author?.normalize('NFKC').trim() ?? '',
    publishedAt: item.publishedAt ?? '',
  })).digest('hex')
}

function cleanEvidence(item: CollectedEvidence): CollectedEvidence {
  const externalId = nonEmpty(item.externalId, 512)
  const title = nonEmpty(item.title, 1000)
  const text = nonEmpty(item.text, 1_000_000)
  const primaryUrl = canonicalUrl(item.primaryUrl)
  const author = item.author?.trim()
  if (author !== undefined && author.length > 500) throw new MonitoringError('INVALID_EVIDENCE')
  if (item.publishedAt !== undefined) iso(item.publishedAt, 'INVALID_EVIDENCE')
  return {
    externalId,
    primaryUrl,
    title,
    text,
    ...(author === undefined || author.length === 0 ? {} : { author }),
    ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
  }
}

function sourceFromRow(row: SourceRow): MonitoringSource {
  if (row.schema_version !== 1 || !SOURCE_KINDS.has(row.kind as MonitoringSourceKind) ||
    (row.status !== 'active' && row.status !== 'paused' && row.status !== 'quarantined')) {
    throw new MonitoringError('INVALID_SOURCE')
  }
  const expectedDomain = sourceEgressDomain(row.kind as MonitoringSourceKind, row.locator)
  if (row.egress_domain !== expectedDomain) throw new MonitoringError('INVALID_SOURCE')
  const binding = resolvedWorkBinding(JSON.parse(row.binding_json) as unknown)
  return {
    schemaVersion: 1,
    id: row.id,
    kind: row.kind as MonitoringSourceKind,
    locator: row.locator,
    binding,
    criteria: row.criteria,
    pollIntervalMs: row.poll_interval_ms,
    status: row.status,
    ...(row.cursor === null ? {} : { cursor: row.cursor }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_collected_at === null ? {} : { lastCollectedAt: row.last_collected_at }),
    ...(row.paused_reason === null ? {} : {
      pausedReason: row.paused_reason as NonNullable<MonitoringSource['pausedReason']>,
    }),
  }
}

function evidenceFromRow(row: EvidenceRow): MonitoringEvidence {
  const binding = resolvedWorkBinding(JSON.parse(row.binding_json) as unknown)
  return {
    id: row.id,
    sourceId: row.source_id,
    binding,
    externalId: row.external_id,
    primaryUrl: row.primary_url,
    title: row.title,
    text: row.text,
    ...(row.author === null ? {} : { author: row.author }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    collectedAt: row.collected_at,
    contentHash: row.content_hash,
    provenance: 'untrusted',
    ...(row.score === null ? {} : { score: row.score }),
    ...(row.category === null ? {} : { category: row.category as EvidenceCategory }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.why_useful === null ? {} : { whyUseful: row.why_useful }),
    ...(row.scored_at === null ? {} : { scoredAt: row.scored_at }),
    needsScoring: row.needs_scoring === 1,
  }
}

function digestFromRow(row: DigestRow): MonitoringDigest {
  if (row.schema_version !== 1 ||
    (row.status !== 'ready' && row.status !== 'delivered' && row.status !== 'expired' &&
      row.status !== 'paused' && row.status !== 'quarantined')) {
    throw new MonitoringError('INVALID_DIGEST_CONFIG')
  }
  const items = JSON.parse(row.items_json) as DigestItem[]
  if (!Array.isArray(items)) throw new MonitoringError('INVALID_DIGEST_CONFIG')
  return {
    schemaVersion: 1,
    id: row.id,
    binding: resolvedWorkBinding(JSON.parse(row.binding_json) as unknown),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    notBefore: row.not_before,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: row.status,
    items,
    ...(row.delivery_receipt === null ? {} : { deliveryReceipt: row.delivery_receipt }),
    ...(row.paused_reason === null ? {} : {
      pausedReason: row.paused_reason as NonNullable<MonitoringDigest['pausedReason']>,
    }),
  }
}

function ftsQuery(value: string): string | null {
  const tokens = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens.slice(0, 16).map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

export function makeMonitoringStore(input: { dbPath: string }): MonitoringStore {
  mkdirSync(dirname(input.dbPath), { recursive: true, mode: 0o700 })
  const db = new Database(input.dbPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  const schemaVersion = db.pragma('user_version', { simple: true }) as number
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > 3) {
    db.close()
    throw new MonitoringError('SCHEMA_UNSUPPORTED')
  }
  db.transaction(() => {
    db.exec(SCHEMA)
    const sourceColumns = db.prepare('PRAGMA table_info(monitoring_sources)')
      .all() as Array<{ name: string }>
    if (!sourceColumns.some((column) => column.name === 'egress_domain')) {
      // Legacy sources had no operator-owned network authority. Do not
      // silently promote them; safeSource quarantines them until re-added.
      db.exec('ALTER TABLE monitoring_sources ADD COLUMN egress_domain TEXT')
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_monitoring_sources_egress
      ON monitoring_sources(egress_domain, status)`)
    db.pragma('user_version = 3')
  })()
  chmodSync(input.dbPath, 0o600)

  const sourceRow = (id: string): SourceRow | undefined =>
    db.prepare('SELECT * FROM monitoring_sources WHERE id = ?').get(id) as SourceRow | undefined
  const evidenceRow = (id: string): EvidenceRow | undefined =>
    db.prepare('SELECT * FROM monitoring_evidence WHERE id = ?').get(id) as EvidenceRow | undefined
  const safeSource = (row: SourceRow): MonitoringSource | null => {
    if (row.status === 'deleted') return null
    try {
      return sourceFromRow(row)
    } catch {
      db.prepare(`UPDATE monitoring_sources SET status='quarantined', paused_reason='invalid-binding'
        , egress_domain=NULL WHERE id=?`).run(row.id)
      return null
    }
  }
  const safeDigest = (row: DigestRow): MonitoringDigest | null => {
    try {
      return digestFromRow(row)
    } catch {
      db.prepare(`UPDATE monitoring_digests SET status='quarantined', paused_reason='invalid-binding'
        WHERE id=?`).run(row.id)
      return null
    }
  }

  return {
    registerSource(source) {
      const binding = resolvedWorkBinding(source.binding)
      const egressDomain = sourceEgressDomain(source.kind, source.locator)
      db.prepare(`INSERT INTO monitoring_sources
        (id, schema_version, kind, locator, egress_domain, binding_json, route_key, criteria,
         poll_interval_ms, status, cursor, created_at, updated_at, last_collected_at, paused_reason)
        VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        source.id, source.kind, source.locator, egressDomain, JSON.stringify(binding), routeKey(binding),
        source.criteria, source.pollIntervalMs, source.status, source.cursor ?? null,
        source.createdAt, source.updatedAt, source.lastCollectedAt ?? null, source.pausedReason ?? null,
      )
    },

    getSource(id) {
      const row = sourceRow(id)
      return row === undefined ? null : safeSource(row)
    },

    listSources(binding) {
      return (db.prepare('SELECT * FROM monitoring_sources WHERE route_key = ? ORDER BY created_at, id')
        .all(routeKey(binding)) as SourceRow[]).flatMap((row) => {
          const source = safeSource(row)
          return source === null ? [] : [source]
        })
    },

    listDueSources(now) {
      const nowMs = Date.parse(iso(now, 'INVALID_SOURCE'))
      return (db.prepare(`SELECT * FROM monitoring_sources WHERE status='active'
        ORDER BY COALESCE(last_collected_at, created_at), id`).all() as SourceRow[]).flatMap((row) => {
          const source = safeSource(row)
          if (source === null) return []
          if (source.lastCollectedAt === undefined) return [source]
          return Date.parse(source.lastCollectedAt) + source.pollIntervalMs <= nowMs ? [source] : []
        })
    },

    updateSource(source) {
      const binding = resolvedWorkBinding(source.binding)
      const currentRow = sourceRow(source.id)
      const current = currentRow === undefined ? null : safeSource(currentRow)
      if (current === null) throw new MonitoringError('SOURCE_NOT_FOUND')
      if (current.kind !== source.kind || current.locator !== source.locator ||
        !sameRoute(current.binding, binding) ||
        currentRow?.egress_domain !== sourceEgressDomain(source.kind, source.locator)) {
        throw new MonitoringError('BINDING_MISMATCH')
      }
      const info = db.prepare(`UPDATE monitoring_sources SET kind=?, locator=?, binding_json=?, route_key=?,
        criteria=?, poll_interval_ms=?, status=?, cursor=?, updated_at=?, last_collected_at=?, paused_reason=?
        WHERE id=?`).run(
        source.kind, source.locator, JSON.stringify(binding), routeKey(binding), source.criteria,
        source.pollIntervalMs, source.status, source.cursor ?? null, source.updatedAt,
        source.lastCollectedAt ?? null, source.pausedReason ?? null, source.id,
      )
      if (info.changes !== 1) throw new MonitoringError('SOURCE_NOT_FOUND')
    },

    getSourceEgressDomain(id) {
      const row = sourceRow(id)
      if (row === undefined || row.status === 'deleted' || safeSource(row) === null) return null
      return row.egress_domain
    },

    removeSource(id, binding, removedAt) {
      const row = sourceRow(id)
      if (row === undefined) throw new MonitoringError('SOURCE_NOT_FOUND')
      let persistedBinding: ResolvedWorkBinding
      try { persistedBinding = resolvedWorkBinding(JSON.parse(row.binding_json) as unknown) } catch {
        throw new MonitoringError('BINDING_MISMATCH')
      }
      if (!sameRoute(persistedBinding, resolvedWorkBinding(binding))) {
        throw new MonitoringError('BINDING_MISMATCH')
      }
      if (row.status === 'deleted') return
      const info = db.prepare(`UPDATE monitoring_sources
        SET status='deleted', egress_domain=NULL, cursor=NULL, updated_at=?, paused_reason='operator'
        WHERE id=? AND status!='deleted'`).run(iso(removedAt, 'INVALID_SOURCE'), id)
      if (info.changes !== 1) throw new MonitoringError('SOURCE_NOT_FOUND')
    },

    ingest(source, rawItems, collectedAt) {
      const binding = resolvedWorkBinding(source.binding)
      const route = routeKey(binding)
      const inserted: MonitoringEvidence[] = []
      const changed: MonitoringEvidence[] = []
      const unchanged: MonitoringEvidence[] = []
      let duplicates = 0
      const transaction = db.transaction(() => {
        for (const raw of rawItems) {
          const item = cleanEvidence(raw)
          const contentHash = hashEvidence(item)
          const existing = db.prepare(
            'SELECT * FROM monitoring_evidence WHERE source_id = ? AND external_id = ?',
          ).get(source.id, item.externalId) as EvidenceRow | undefined
          if (existing?.content_hash === contentHash) {
            db.prepare('UPDATE monitoring_evidence SET collected_at = ? WHERE rowid = ?')
              .run(collectedAt, existing.rowid)
            unchanged.push(evidenceFromRow({ ...existing, collected_at: collectedAt }))
            continue
          }
          const duplicate = db.prepare(
            'SELECT id FROM monitoring_evidence WHERE route_key = ? AND content_hash = ? AND id != ?',
          ).get(route, contentHash, existing?.id ?? '') as { id: string } | undefined
          if (duplicate !== undefined) {
            duplicates++
            continue
          }
          if (existing !== undefined) {
            db.prepare(`UPDATE monitoring_evidence SET binding_json=?, route_key=?, primary_url=?, title=?,
              text=?, author=?, published_at=?, collected_at=?, content_hash=?, score=NULL, category=NULL,
              summary=NULL, why_useful=NULL, scored_at=NULL, needs_scoring=1 WHERE rowid=?`).run(
              JSON.stringify(binding), route, item.primaryUrl, item.title, item.text, item.author ?? null,
              item.publishedAt ?? null, collectedAt, contentHash, existing.rowid,
            )
            db.prepare('DELETE FROM monitoring_fts WHERE rowid = ?').run(existing.rowid)
            db.prepare('INSERT INTO monitoring_fts (rowid,title,text,author) VALUES (?,?,?,?)')
              .run(existing.rowid, item.title, item.text, item.author ?? '')
            changed.push(evidenceFromRow(evidenceRow(existing.id)!))
            continue
          }
          const evidenceId = createHash('sha256')
            .update(`${source.id}\u0000${item.externalId}`).digest('hex')
          const info = db.prepare(`INSERT INTO monitoring_evidence
            (id,source_id,binding_json,route_key,external_id,primary_url,title,text,author,published_at,
             collected_at,content_hash,provenance,needs_scoring)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'untrusted',1)`).run(
              evidenceId, source.id, JSON.stringify(binding), route, item.externalId, item.primaryUrl,
              item.title, item.text, item.author ?? null, item.publishedAt ?? null, collectedAt, contentHash,
            )
          db.prepare('INSERT INTO monitoring_fts (rowid,title,text,author) VALUES (?,?,?,?)')
            .run(info.lastInsertRowid, item.title, item.text, item.author ?? '')
          inserted.push(evidenceFromRow(evidenceRow(evidenceId)!))
        }
      })
      transaction()
      return { inserted, changed, unchanged, duplicates }
    },

    pendingForScoring(sourceId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new MonitoringError('INVALID_BUDGET')
      return (db.prepare(`SELECT * FROM monitoring_evidence
        WHERE source_id = ? AND needs_scoring = 1 ORDER BY collected_at, id LIMIT ?`)
        .all(sourceId, limit) as EvidenceRow[]).map(evidenceFromRow)
    },

    saveScore(evidenceId, score, scoredAt) {
      const info = db.prepare(`UPDATE monitoring_evidence SET score=?, category=?, summary=?, why_useful=?,
        scored_at=?, needs_scoring=0 WHERE id=?`).run(
        score.score, score.category, score.summary, score.whyUseful, scoredAt, evidenceId,
      )
      if (info.changes !== 1) throw new MonitoringError('INVALID_EVIDENCE')
    },

    search(binding, query, limit) {
      const match = ftsQuery(query)
      if (match === null || !Number.isSafeInteger(limit) || limit <= 0) return []
      const rows = db.prepare(`SELECT e.*, bm25(monitoring_fts) AS rank
        FROM monitoring_fts JOIN monitoring_evidence e ON e.rowid = monitoring_fts.rowid
        WHERE monitoring_fts MATCH ? AND e.route_key = ? ORDER BY rank, e.collected_at DESC LIMIT ?`)
        .all(match, routeKey(binding), limit) as Array<EvidenceRow & { rank: number }>
      return rows.map((row): MonitoringSearchHit => ({ evidence: evidenceFromRow(row), rank: row.rank }))
    },

    candidates(binding, windowStart, windowEnd) {
      return (db.prepare(`SELECT * FROM monitoring_evidence WHERE route_key = ?
        AND needs_scoring = 0 AND score IS NOT NULL
        AND COALESCE(published_at, collected_at) >= ? AND COALESCE(published_at, collected_at) <= ?
        ORDER BY score DESC, collected_at DESC, id`).all(
          routeKey(binding), windowStart, windowEnd,
        ) as EvidenceRow[]).map(evidenceFromRow)
    },

    saveDigest(digest) {
      const binding = resolvedWorkBinding(digest.binding)
      db.prepare(`INSERT INTO monitoring_digests
        (id,schema_version,binding_json,route_key,window_start,window_end,not_before,expires_at,
         created_at,status,items_json,delivery_receipt,paused_reason)
        VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?)`).run(
        digest.id, JSON.stringify(binding), routeKey(binding), digest.windowStart, digest.windowEnd,
        digest.notBefore, digest.expiresAt, digest.createdAt, digest.status, JSON.stringify(digest.items),
        digest.deliveryReceipt ?? null, digest.pausedReason ?? null,
      )
    },

    getDigest(id) {
      const row = db.prepare('SELECT * FROM monitoring_digests WHERE id = ?').get(id) as DigestRow | undefined
      return row === undefined ? null : safeDigest(row)
    },

    getDigestForWindow(binding, windowStart, windowEnd) {
      const row = db.prepare(`SELECT * FROM monitoring_digests
        WHERE route_key = ? AND window_start = ? AND window_end = ?
        ORDER BY created_at, id LIMIT 1`).get(
        routeKey(binding),
        iso(windowStart, 'INVALID_DIGEST_CONFIG'),
        iso(windowEnd, 'INVALID_DIGEST_CONFIG'),
      ) as DigestRow | undefined
      return row === undefined ? null : safeDigest(row)
    },

    listDueDigests(now) {
      iso(now, 'INVALID_DIGEST_CONFIG')
      db.prepare(`UPDATE monitoring_digests SET status='expired'
        WHERE status='ready' AND expires_at < ?`).run(now)
      return (db.prepare(`SELECT * FROM monitoring_digests WHERE status='ready'
        AND not_before <= ? AND expires_at >= ? ORDER BY not_before, created_at, id`)
        .all(now, now) as DigestRow[]).flatMap((row) => {
          const digest = safeDigest(row)
          return digest === null ? [] : [digest]
        })
    },

    markDigestDelivered(id, receipt) {
      const cleanReceipt = nonEmpty(receipt, 1000)
      const info = db.prepare(`UPDATE monitoring_digests SET status='delivered', delivery_receipt=?
        WHERE id=? AND status='ready'`).run(cleanReceipt, id)
      if (info.changes !== 1) throw new MonitoringError('DIGEST_NOT_FOUND')
      return digestFromRow(db.prepare('SELECT * FROM monitoring_digests WHERE id = ?').get(id) as DigestRow)
    },

    pauseDigest(id, reason) {
      const info = db.prepare(`UPDATE monitoring_digests SET status='paused', paused_reason=?
        WHERE id=? AND status='ready'`).run(reason, id)
      const row = db.prepare('SELECT * FROM monitoring_digests WHERE id = ?').get(id) as DigestRow | undefined
      if (info.changes !== 1 && (row?.status !== 'paused' || row.paused_reason !== reason)) {
        throw new MonitoringError('DIGEST_NOT_FOUND')
      }
      if (!row) throw new MonitoringError('DIGEST_NOT_FOUND')
      return digestFromRow(row)
    },

    stageFeedback(feedback) {
      const binding = resolvedWorkBinding(feedback.binding)
      db.prepare(`INSERT INTO monitoring_feedback
        (id,schema_version,binding_json,route_key,digest_id,evidence_id,verdict,status,created_at)
        VALUES (?,1,?,?,?,?,?,'staged',?)`).run(
        feedback.id, JSON.stringify(binding), routeKey(binding), feedback.digestId,
        feedback.evidenceId, feedback.verdict, feedback.createdAt,
      )
    },

    prune(input) {
      if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 0) {
        throw new MonitoringError('INVALID_BUDGET')
      }
      const olderThan = iso(input.olderThan, 'INVALID_BUDGET')
      const now = iso(input.now, 'INVALID_BUDGET')

      // Evidence a live digest still points at is never dropped: a delivered
      // digest whose links go dead is worse than a slightly larger database.
      const live = new Set<string>()
      for (const row of db.prepare(
        `SELECT items_json FROM monitoring_digests WHERE expires_at >= ?`,
      ).all(now) as Array<{ items_json: string }>) {
        try {
          for (const item of JSON.parse(row.items_json) as DigestItem[]) live.add(item.evidenceId)
        } catch { /* a corrupted digest protects nothing, and must not stop the sweep */ }
      }

      const drop = (rows: Array<{ id: string; rowid: number }>): number => {
        let deleted = 0
        const removeEvidence = db.prepare('DELETE FROM monitoring_evidence WHERE id = ?')
        const removeFts = db.prepare('DELETE FROM monitoring_fts WHERE rowid = ?')
        for (const row of rows) {
          if (live.has(row.id)) continue
          removeFts.run(row.rowid)
          removeEvidence.run(row.id)
          deleted += 1
        }
        return deleted
      }

      const byAge = drop(db.prepare(
        `SELECT id, rowid FROM monitoring_evidence
         WHERE COALESCE(published_at, collected_at) < ?`,
      ).all(olderThan) as Array<{ id: string; rowid: number }>)

      const remaining = (db.prepare('SELECT COUNT(*) AS n FROM monitoring_evidence')
        .get() as { n: number }).n
      const byVolume = remaining <= input.maxRows ? 0 : drop(db.prepare(
        `SELECT id, rowid FROM monitoring_evidence
         ORDER BY COALESCE(published_at, collected_at) ASC, id ASC LIMIT ?`,
      ).all(remaining - input.maxRows) as Array<{ id: string; rowid: number }>)

      return {
        byAge,
        byVolume,
        kept: (db.prepare('SELECT COUNT(*) AS n FROM monitoring_evidence').get() as { n: number }).n,
      }
    },
  }
}

/** Global criteria first, then the source's own narrowing. */
function joinCriteria(global: string | null, source: string): string {
  const trimmed = (global ?? '').trim()
  return trimmed === '' ? source : `${trimmed}\n\nДля этого источника: ${source}`
}

function validBudget(budget: MonitoringPollBudget): void {
  if (!Number.isSafeInteger(budget.maxCollectedItems) || budget.maxCollectedItems < 0 ||
    !Number.isSafeInteger(budget.maxScoringCalls) || budget.maxScoringCalls < 0) {
    throw new MonitoringError('INVALID_BUDGET')
  }
}

function validScore(score: EvidenceScore): EvidenceScore {
  if (!Number.isFinite(score.score) || score.score < 0 || score.score > 1 ||
    !CATEGORIES.has(score.category) || score.summary.trim().length === 0 ||
    score.summary.length > 4000 || score.whyUseful.trim().length === 0 ||
    score.whyUseful.length > 4000) throw new MonitoringError('INVALID_SCORE')
  return { ...score, summary: score.summary.trim(), whyUseful: score.whyUseful.trim() }
}

function validateDigestConfig(config: DigestBuildConfig): void {
  const start = Date.parse(iso(config.windowStart, 'INVALID_DIGEST_CONFIG'))
  const end = Date.parse(iso(config.windowEnd, 'INVALID_DIGEST_CONFIG'))
  const notBefore = Date.parse(iso(config.notBefore, 'INVALID_DIGEST_CONFIG'))
  const expiresAt = Date.parse(iso(config.expiresAt, 'INVALID_DIGEST_CONFIG'))
  if (start > end || notBefore > expiresAt ||
    !Number.isSafeInteger(config.maxItems) || config.maxItems <= 0 ||
    !Number.isSafeInteger(config.maxPerSource) || config.maxPerSource <= 0 ||
    !Number.isSafeInteger(config.maxPerAuthor) || config.maxPerAuthor <= 0 ||
    !Number.isFinite(config.halfLifeHours) || config.halfLifeHours <= 0 ||
    Object.values(config.halfLifeHoursByKind ?? {})
      .some((hours) => !Number.isFinite(hours) || hours <= 0) ||
    Object.values(config.categoryWeights ?? {})
      .some((weight) => !Number.isFinite(weight) || weight < 0) ||
    config.categories?.some((item) => !CATEGORIES.has(item)) === true) {
    throw new MonitoringError('INVALID_DIGEST_CONFIG')
  }
}

export function makeMonitoringEngine(deps: {
  store: MonitoringStore
  /**
   * Criteria that apply to every source — what this operator considers worth
   * their attention at all (ADR-0084). Per-source criteria narrow it; they do
   * not replace it, because "интересно вообще" and "интересно из этой ленты"
   * are different questions.
   */
  globalCriteria?: () => string | null
  collectors: Partial<Record<MonitoringSourceKind, import('./types.js').MonitoringCollector>>
  scorer?: import('./types.js').MonitoringScorer
  resolveBinding(binding: ResolvedWorkBinding): void
  nowIso: () => string
  newId: () => string
  emit?: (event: MonitoringEvent) => void
}): MonitoringEngine {
  const mergedCriteria = (sourceCriteria: string): string => {
    let global: string | null = null
    try {
      global = deps.globalCriteria?.() ?? null
    } catch {
      // Unreadable global criteria narrow nothing; the source's own still apply.
      global = null
    }
    return joinCriteria(global, sourceCriteria)
  }

  const bindingAvailable = (binding: ResolvedWorkBinding): boolean => {
    try {
      deps.resolveBinding(resolvedWorkBinding(binding))
      return true
    } catch {
      return false
    }
  }

  const sourceForBinding = (
    sourceId: string,
    binding: ResolvedWorkBinding,
  ): MonitoringSource => {
    const source = deps.store.getSource(nonEmpty(sourceId, 200))
    if (source === null) throw new MonitoringError('SOURCE_NOT_FOUND')
    if (!sameRoute(source.binding, resolvedWorkBinding(binding))) {
      throw new MonitoringError('BINDING_MISMATCH')
    }
    return source
  }

  const pollOne = async (
    sourceId: string,
    budget: MonitoringPollBudget,
  ): Promise<MonitoringPollResult> => {
    validBudget(budget)
    const source = deps.store.getSource(sourceId)
    if (!source) throw new MonitoringError('SOURCE_NOT_FOUND')
    const base: Omit<MonitoringPollResult, 'status'> = {
      sourceId, collected: 0, inserted: 0, changed: 0, unchanged: 0,
      duplicates: 0, scoringCalls: 0, scored: 0, scoringDeferred: 0,
    }
    if (source.status !== 'active') {
      return source.pausedReason === 'operator' || source.pausedReason === 'invalid-binding'
        ? { ...base, status: 'paused' }
        : { ...base, status: 'paused', reason: source.pausedReason ?? 'context-unavailable' }
    }
    if (!bindingAvailable(source.binding)) {
      const paused = { ...source, status: 'paused' as const, pausedReason: 'context-unavailable' as const, updatedAt: deps.nowIso() }
      deps.store.updateSource(paused)
      deps.emit?.({
        kind: 'monitor.poll_paused', projectId: source.binding.projectId,
        sessionId: source.binding.sessionId, scope: source.binding.scope,
        sourceId, reason: 'context-unavailable',
      })
      return { ...base, status: 'paused', reason: 'context-unavailable' }
    }
    if (budget.maxCollectedItems === 0) {
      const paused = { ...source, status: 'paused' as const, pausedReason: 'budget-exhausted' as const, updatedAt: deps.nowIso() }
      deps.store.updateSource(paused)
      return { ...base, status: 'paused', reason: 'budget-exhausted' }
    }
    const collector = deps.collectors[source.kind]
    if (!collector) throw new MonitoringError('COLLECTOR_UNAVAILABLE')
    let batch
    try {
      batch = await collector.collect(source)
      if (!Array.isArray(batch.items)) throw new Error('invalid batch')
    } catch {
      deps.store.updateSource({
        ...source, status: 'paused', pausedReason: 'collector-error', updatedAt: deps.nowIso(),
      })
      return { ...base, status: 'failed', reason: 'collector-error' }
    }
    const now = iso(deps.nowIso(), 'INVALID_EVIDENCE')
    const items = batch.items.slice(0, budget.maxCollectedItems)
    const ingested = deps.store.ingest(source, items, now)
    let scoringCalls = 0
    let scored = 0
    const pending = deps.store.pendingForScoring(source.id, budget.maxScoringCalls)
    if (deps.scorer) {
      for (const evidence of pending) {
        scoringCalls++
        try {
          const score = validScore(await deps.scorer.score({
            evidenceId: evidence.id,
            title: evidence.title,
            text: evidence.text,
            ...(evidence.author === undefined ? {} : { author: evidence.author }),
            ...(evidence.publishedAt === undefined ? {} : { publishedAt: evidence.publishedAt }),
            criteria: mergedCriteria(source.criteria),
            provenance: 'untrusted',
            outboundAllowed: false,
          }))
          deps.store.saveScore(evidence.id, score, deps.nowIso())
          scored++
        } catch {
          // Item stays needs_scoring=1 for an explicit later retry.
        }
      }
    }
    const deferred = deps.store.pendingForScoring(source.id, Number.MAX_SAFE_INTEGER).length
    const { pausedReason: _pausedReason, ...activeSource } = source
    deps.store.updateSource({
      ...activeSource,
      status: 'active',
      ...(batch.cursor === undefined ? {} : { cursor: batch.cursor }),
      lastCollectedAt: now,
      updatedAt: now,
    })
    const result: MonitoringPollResult = {
      sourceId,
      status: 'completed',
      collected: items.length,
      inserted: ingested.inserted.length,
      changed: ingested.changed.length,
      unchanged: ingested.unchanged.length,
      duplicates: ingested.duplicates,
      scoringCalls,
      scored,
      scoringDeferred: deferred,
    }
    deps.emit?.({
      kind: 'monitor.poll_completed', projectId: source.binding.projectId,
      sessionId: source.binding.sessionId, scope: source.binding.scope, sourceId,
      counts: {
        collected: result.collected, inserted: result.inserted, changed: result.changed,
        unchanged: result.unchanged, duplicates: result.duplicates,
        scoringCalls: result.scoringCalls, scored: result.scored,
      },
    })
    return result
  }

  return {
    registerSource(input) {
      const binding = resolvedWorkBinding(input.binding)
      if (!SOURCE_KINDS.has(input.kind) || !deps.collectors[input.kind] ||
        !Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 60_000) {
        throw new MonitoringError('INVALID_SOURCE')
      }
      if (!bindingAvailable(binding)) throw new MonitoringError('CONTEXT_UNAVAILABLE')
      const now = iso(deps.nowIso(), 'INVALID_SOURCE')
      const source: MonitoringSource = {
        schemaVersion: 1,
        id: nonEmpty(input.id, 200),
        kind: input.kind,
        locator: cleanLocator(input.locator),
        binding,
        criteria: input.criteria.trim().slice(0, 10_000),
        pollIntervalMs: input.pollIntervalMs,
        status: 'active',
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.lastCollectedAt === undefined ? {} : { lastCollectedAt: input.lastCollectedAt }),
        ...(input.pausedReason === undefined ? {} : { pausedReason: input.pausedReason }),
        createdAt: now,
        updatedAt: now,
      }
      deps.store.registerSource(source)
      deps.emit?.({
        kind: 'monitor.source_registered', projectId: binding.projectId,
        sessionId: binding.sessionId, scope: binding.scope, sourceId: source.id,
      })
      return source
    },

    pauseSource(sourceId, binding) {
      const source = sourceForBinding(sourceId, binding)
      const now = iso(deps.nowIso(), 'INVALID_SOURCE')
      const paused: MonitoringSource = {
        ...source,
        status: 'paused',
        pausedReason: 'operator',
        updatedAt: now,
      }
      deps.store.updateSource(paused)
      deps.emit?.({
        kind: 'monitor.source_paused', projectId: source.binding.projectId,
        sessionId: source.binding.sessionId, scope: source.binding.scope, sourceId,
      })
      return paused
    },

    resumeSource(sourceId, binding) {
      const source = sourceForBinding(sourceId, binding)
      if (!bindingAvailable(source.binding)) throw new MonitoringError('CONTEXT_UNAVAILABLE')
      const { pausedReason: _pausedReason, ...rest } = source
      const resumed: MonitoringSource = {
        ...rest,
        status: 'active',
        updatedAt: iso(deps.nowIso(), 'INVALID_SOURCE'),
      }
      deps.store.updateSource(resumed)
      deps.emit?.({
        kind: 'monitor.source_resumed', projectId: source.binding.projectId,
        sessionId: source.binding.sessionId, scope: source.binding.scope, sourceId,
      })
      return resumed
    },

    removeSource(sourceId, binding) {
      const source = sourceForBinding(sourceId, binding)
      deps.store.removeSource(source.id, source.binding, deps.nowIso())
      deps.emit?.({
        kind: 'monitor.source_removed', projectId: source.binding.projectId,
        sessionId: source.binding.sessionId, scope: source.binding.scope, sourceId,
      })
    },

    async poll(sourceId, budget) {
      return pollOne(sourceId, budget)
    },

    async tick(budget: MonitoringTickBudget) {
      validBudget(budget)
      if (!Number.isSafeInteger(budget.maxSources) || budget.maxSources < 0) {
        throw new MonitoringError('INVALID_BUDGET')
      }
      let itemsLeft = budget.maxCollectedItems
      let scoringLeft = budget.maxScoringCalls
      const results: MonitoringPollResult[] = []
      for (const source of deps.store.listDueSources(deps.nowIso()).slice(0, budget.maxSources)) {
        if (itemsLeft === 0) break
        const result = await pollOne(source.id, {
          maxCollectedItems: itemsLeft,
          maxScoringCalls: scoringLeft,
        })
        results.push(result)
        itemsLeft = Math.max(0, itemsLeft - result.collected)
        scoringLeft = Math.max(0, scoringLeft - result.scoringCalls)
      }
      return results
    },

    buildDigest(rawBinding, config) {
      const binding = resolvedWorkBinding(rawBinding)
      validateDigestConfig(config)
      const id = nonEmpty(deps.newId(), 200)
      const createdAt = iso(deps.nowIso(), 'INVALID_DIGEST_CONFIG')
      if (!bindingAvailable(binding)) {
        const paused: MonitoringDigest = {
          schemaVersion: 1, id, binding, ...config, createdAt,
          status: 'paused', pausedReason: 'context-unavailable', items: [],
        }
        deps.store.saveDigest(paused)
        deps.emit?.({
          kind: 'monitor.digest_paused', projectId: binding.projectId,
          sessionId: binding.sessionId, scope: binding.scope, digestId: id,
          reason: 'context-unavailable',
        })
        return paused
      }
      const categories = new Set(config.categories ?? ['critical', 'important', 'useful'])
      const referenceMs = Date.parse(config.windowEnd)
      const sourceCounts = new Map<string, number>()
      const authorCounts = new Map<string, number>()
      const weights = { ...DEFAULT_CATEGORY_WEIGHTS, ...(config.categoryWeights ?? {}) }
      // Decay window per source kind: a release feed keeps for days, a chat
      // goes stale in hours, and one half-life for both ranks one of them wrong.
      const sourceKinds = new Map(deps.store.listSources(binding).map((s) => [s.id, s.kind]))
      const ranked = deps.store.candidates(binding, config.windowStart, config.windowEnd)
        .filter((item) => item.score !== undefined && item.category !== undefined && categories.has(item.category))
        .map((item) => {
          const itemMs = Date.parse(item.publishedAt ?? item.collectedAt)
          const ageHours = Math.max(0, (referenceMs - itemMs) / 3_600_000)
          const kind = sourceKinds.get(item.sourceId)
          const halfLife = (kind === undefined
            ? undefined
            : config.halfLifeHoursByKind?.[kind]) ?? config.halfLifeHours
          const weight = weights[item.category!] ?? 1
          return { item, rankScore: item.score! * weight * Math.pow(0.5, ageHours / halfLife) }
        })
        .sort((a, b) => b.rankScore - a.rankScore || a.item.id.localeCompare(b.item.id))
      const items: DigestItem[] = []
      for (const candidate of ranked) {
        if (items.length >= config.maxItems) break
        const evidence = candidate.item
        const authorKey = evidence.author?.trim().toLowerCase() || `source:${evidence.sourceId}`
        if ((sourceCounts.get(evidence.sourceId) ?? 0) >= config.maxPerSource ||
          (authorCounts.get(authorKey) ?? 0) >= config.maxPerAuthor) continue
        sourceCounts.set(evidence.sourceId, (sourceCounts.get(evidence.sourceId) ?? 0) + 1)
        authorCounts.set(authorKey, (authorCounts.get(authorKey) ?? 0) + 1)
        items.push({
          evidenceId: evidence.id,
          sourceId: evidence.sourceId,
          primaryUrl: evidence.primaryUrl,
          title: evidence.title,
          summary: evidence.summary ?? evidence.title,
          whyUseful: evidence.whyUseful ?? '',
          ...(evidence.author === undefined ? {} : { author: evidence.author }),
          ...(evidence.publishedAt === undefined ? {} : { publishedAt: evidence.publishedAt }),
          category: evidence.category!,
          rawScore: evidence.score!,
          rankScore: candidate.rankScore,
        })
      }
      const digest: MonitoringDigest = {
        schemaVersion: 1, id, binding, ...config, createdAt, status: 'ready', items,
      }
      deps.store.saveDigest(digest)
      deps.emit?.({
        kind: 'monitor.digest_ready', projectId: binding.projectId,
        sessionId: binding.sessionId, scope: binding.scope, digestId: id,
        counts: { items: items.length },
      })
      return digest
    },

    listDueDigests(now) {
      const due = deps.store.listDueDigests(now)
      const ready: MonitoringDigest[] = []
      for (const digest of due) {
        if (bindingAvailable(digest.binding)) ready.push(digest)
        else {
          deps.store.pauseDigest(digest.id, 'context-unavailable')
          deps.emit?.({
            kind: 'monitor.digest_paused', projectId: digest.binding.projectId,
            sessionId: digest.binding.sessionId, scope: digest.binding.scope,
            digestId: digest.id, reason: 'context-unavailable',
          })
        }
      }
      return ready
    },

    markDelivered(digestId, receipt) {
      const digest = deps.store.getDigest(digestId)
      if (!digest) throw new MonitoringError('DIGEST_NOT_FOUND')
      if (!bindingAvailable(digest.binding)) {
        deps.store.pauseDigest(digest.id, 'context-unavailable')
        throw new MonitoringError('CONTEXT_UNAVAILABLE')
      }
      const delivered = deps.store.markDigestDelivered(digestId, receipt)
      deps.emit?.({
        kind: 'monitor.digest_delivered', projectId: digest.binding.projectId,
        sessionId: digest.binding.sessionId, scope: digest.binding.scope, digestId,
      })
      return delivered
    },

    stageFeedback(input) {
      const binding = resolvedWorkBinding(input.binding)
      const digest = deps.store.getDigest(input.digestId)
      if (!digest) throw new MonitoringError('DIGEST_NOT_FOUND')
      if (!sameRoute(binding, digest.binding) ||
        !digest.items.some((item) => item.evidenceId === input.evidenceId)) {
        throw new MonitoringError('BINDING_MISMATCH')
      }
      const feedback: MonitoringFeedback = {
        schemaVersion: 1,
        id: nonEmpty(deps.newId(), 200),
        binding,
        digestId: input.digestId,
        evidenceId: input.evidenceId,
        verdict: input.verdict,
        status: 'staged',
        createdAt: deps.nowIso(),
      }
      deps.store.stageFeedback(feedback)
      deps.emit?.({
        kind: 'monitor.feedback_staged', projectId: binding.projectId,
        sessionId: binding.sessionId, scope: binding.scope, digestId: digest.id,
      })
      return feedback
    },
  }
}

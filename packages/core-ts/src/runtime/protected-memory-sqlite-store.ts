import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import {
  parseProtectedMemoryDeletionAuditEvent,
  parseProtectedMemoryDeletionWal,
  type ProtectedMemoryDeletionAuditEvent,
  type ProtectedMemoryDeletionPersistencePort,
  type ProtectedMemoryDeletionWalV1,
} from './protected-memory-deletion.js'
import {
  parseProtectedMemoryAuditEvent,
  parseProtectedMemoryFactRecord,
  parseProtectedMemoryPublicationWal,
  type ProtectedMemoryAuditEvent,
  type ProtectedMemoryFactRecordV2,
  type ProtectedMemoryPublicationPersistencePort,
  type ProtectedMemoryPublicationWalV1,
  type ProtectedMemoryScope,
} from './protected-memory-publication.js'
import {
  parseProtectedMemoryUpdateAuditEvent,
  parseProtectedMemoryUpdateWal,
  type ProtectedMemoryUpdateAuditEvent,
  type ProtectedMemoryUpdatePersistencePort,
  type ProtectedMemoryUpdateWalV1,
} from './protected-memory-update.js'
import type { SemanticIndexRecord } from './sqlite-vec-semantic-store.js'
import {
  PROTECTED_KEYWORD_SCHEMA,
  PROTECTED_LEDGER_SCHEMA,
} from './protected-memory-schema.js'

const HASH = /^[a-f0-9]{64}$/
const MAX_WAL_ROWS = 10_000

export type ProtectedMemorySqliteFault =
  | 'after-create-wal'
  | 'after-advance-wal'
  | 'after-pending'
  | 'after-ledger-publish'
  | 'after-keyword-publish'
  | 'after-audit-delivery'
  | 'after-audit-mark'
  | 'after-delete-wal'
  | 'after-create-deletion-wal'
  | 'after-advance-deletion-wal'
  | 'after-tombstone'
  | 'after-keyword-purge'
  | 'after-deletion-audit-delivery'
  | 'after-deletion-audit-mark'
  | 'after-delete-deletion-wal'
  | 'after-create-update-wal'
  | 'after-advance-update-wal'
  | 'after-pending-update'
  | 'after-update-ledger-swap'
  | 'after-update-keyword-swap'
  | 'after-update-audit-delivery'
  | 'after-update-audit-mark'
  | 'after-delete-update-wal'

export class ProtectedMemorySqliteStoreError extends Error {
  constructor(public readonly code:
    | 'UNSAFE_PATH'
    | 'SCOPE_MISMATCH'
    | 'CORRUPT_LEDGER'
    | 'CORRUPT_KEYWORD_INDEX'
    | 'STATE_CONFLICT'
    | 'FORGOTTEN_FACT'
    | 'RECOVERY_REQUIRED'
    | 'LIMIT_EXCEEDED',
  ) {
    super(code)
    this.name = 'ProtectedMemorySqliteStoreError'
  }
}

export interface ProtectedMemorySqliteStore
  extends ProtectedMemoryPublicationPersistencePort,
  ProtectedMemoryDeletionPersistencePort,
  ProtectedMemoryUpdatePersistencePort {
  integrityCheck(): { ok: boolean; detail?: string }
  searchKeyword(query: string, limit: number): Promise<Array<{
    fact: ProtectedMemoryFactRecordV2
    score: number
  }>>
  loadLiveFactById(factId: string): Promise<ProtectedMemoryFactRecordV2 | null>
  listLiveFacts(): Promise<ProtectedMemoryFactRecordV2[]>
  classifyForgetCandidates(
    candidates: readonly ProtectedMemoryForgetCandidate[],
  ): ProtectedMemoryForgetVerdict
  verifySemanticRecord(record: SemanticIndexRecord): Promise<boolean>
  close(): void
}

export interface ProtectedMemoryForgetCandidate {
  factKey: string
  keyTokens: string[]
}

export type ProtectedMemoryForgetVerdict = 'PASS' | 'FORGOTTEN' | 'REVIEW'

interface FactRow {
  operation_id: string | null
  id: string
  text: string
  fact_key: string
  key_tokens: string
  valid_at: string
  invalid_at: string | null
  is_human_confirmed: number
  source_authority: number | null
  confidence: number | null
  provenance: string
  supersedes: string | null
  contradicts: string | null
  extends_key: string | null
  published: number
  source_path: string | null
  content_hash: string | null
}

interface WalRow {
  operation_id: string
  scope_id: string
  phase: string
  wal_json: string
  wal_hash: string
}

interface AuditRow {
  event_id: string
  event_json: string
  event_hash: string
  delivered: number
}

interface ForgetRow {
  rowid: number
  operation_id: string | null
  fact_key: string
  key_tokens: string
  reason: string
  is_human_confirmed: number
  ts: string
  prev_hash: string
  row_hash: string
}

interface KeywordRow {
  rowid: number | bigint
  operation_id: string
  fact_id: string
  fact_key: string
  source_path: string
  content_hash: string
  provenance: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function sameScope(left: ProtectedMemoryScope, right: ProtectedMemoryScope): boolean {
  return left.kind === right.kind && left.scopeId === right.scopeId &&
    (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId))
}

function scopeValid(scope: ProtectedMemoryScope): boolean {
  return scope.kind === 'global'
    ? scope.scopeId === 'global'
    : scope.projectId.length > 0 && scope.scopeId === `project:${scope.projectId}`
}

function ensurePrivateDatabasePath(path: string): void {
  const canonical = resolve(path)
  const directory = dirname(canonical)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() ||
    realpathSync(directory) !== directory) {
    throw new ProtectedMemorySqliteStoreError('UNSAFE_PATH')
  }
  chmodSync(directory, 0o700)
  if (!existsSync(canonical)) return
  const info = lstatSync(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    realpathSync(canonical) !== canonical || (info.mode & 0o077) !== 0) {
    throw new ProtectedMemorySqliteStoreError('UNSAFE_PATH')
  }
}

function configure(db: Database.Database): void {
  db.pragma('journal_mode = DELETE')
  db.pragma('synchronous = FULL')
  db.pragma('secure_delete = ON')
  db.pragma('foreign_keys = ON')
}

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

function exactColumns(db: Database.Database, table: string, expected: string[]): boolean {
  const actual = columns(db, table)
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function parseWalRow(row: WalRow | undefined): ProtectedMemoryPublicationWalV1 | null {
  if (!row) return null
  if (!HASH.test(row.operation_id) || !HASH.test(row.wal_hash) ||
    sha256(row.wal_json) !== row.wal_hash) {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  let parsed: unknown
  try { parsed = JSON.parse(row.wal_json) as unknown } catch {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  const wal = parseProtectedMemoryPublicationWal(parsed)
  if (!wal || wal.operationId !== row.operation_id || wal.scope.scopeId !== row.scope_id ||
    wal.phase !== row.phase) {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  return wal
}

function parseDeletionWalRow(row: WalRow | undefined): ProtectedMemoryDeletionWalV1 | null {
  if (!row) return null
  if (!HASH.test(row.operation_id) || !HASH.test(row.wal_hash) ||
    sha256(row.wal_json) !== row.wal_hash) {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  let parsed: unknown
  try { parsed = JSON.parse(row.wal_json) as unknown } catch {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  const wal = parseProtectedMemoryDeletionWal(parsed)
  if (!wal || wal.operationId !== row.operation_id || wal.scope.scopeId !== row.scope_id ||
    wal.phase !== row.phase) {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  return wal
}

function parseUpdateWalRow(row: WalRow | undefined): ProtectedMemoryUpdateWalV1 | null {
  if (!row) return null
  if (!HASH.test(row.operation_id) || !HASH.test(row.wal_hash) ||
    sha256(row.wal_json) !== row.wal_hash) {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  let parsed: unknown
  try { parsed = JSON.parse(row.wal_json) as unknown } catch {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  const wal = parseProtectedMemoryUpdateWal(parsed)
  if (!wal || wal.operationId !== row.operation_id || wal.scope.scopeId !== row.scope_id ||
    wal.phase !== row.phase) throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  return wal
}

function factRowIdentityMatches(row: FactRow, fact: ProtectedMemoryFactRecordV2): boolean {
  return row.operation_id === fact.operationId && row.id === fact.id && row.text === fact.text &&
    row.fact_key === fact.factKey && row.key_tokens === fact.keyTokens.join('|') &&
    row.valid_at === fact.validAt &&
    (row.is_human_confirmed !== 0) === fact.isHumanConfirmed &&
    row.source_authority === fact.sourceAuthority && row.confidence === fact.confidence &&
    row.provenance === fact.provenance && row.supersedes === (fact.supersedes ?? null) &&
    row.contradicts === (fact.contradicts ?? null) && row.extends_key === (fact.extends ?? null) &&
    row.source_path === fact.sourcePath && row.content_hash === fact.contentHash
}

function factRowMatches(row: FactRow, fact: ProtectedMemoryFactRecordV2): boolean {
  return factRowIdentityMatches(row, fact) && row.invalid_at === fact.invalidAt
}

function auditMatchesFact(event: ProtectedMemoryAuditEvent, fact: ProtectedMemoryFactRecordV2): boolean {
  return event.operationId === fact.operationId && event.operatorId === fact.operatorId &&
    event.profileId === fact.profileId && event.scopeId === fact.scope.scopeId &&
    event.projectId === (fact.scope.kind === 'project' ? fact.scope.projectId : undefined) &&
    event.factId === fact.id && event.factKey === fact.factKey &&
    event.sourcePath === fact.sourcePath && event.contentHash === fact.contentHash &&
    event.provenance === fact.provenance
}

function deletionAuditMatchesWal(
  event: ProtectedMemoryDeletionAuditEvent,
  wal: ProtectedMemoryDeletionWalV1,
): boolean {
  return event.operationId === wal.operationId &&
    event.targetOperationId === wal.target.operationId &&
    event.operatorId === wal.operatorId && event.profileId === wal.profileId &&
    event.scopeId === wal.scope.scopeId &&
    event.projectId === (wal.scope.kind === 'project' ? wal.scope.projectId : undefined) &&
    event.sessionId === wal.sessionId && event.factId === wal.target.id &&
    event.factKey === wal.target.factKey && event.sourcePath === wal.target.sourcePath &&
    event.contentHash === wal.target.contentHash && event.reason === wal.reason &&
    event.humanConfirmed === wal.humanConfirmed && event.invalidatedAt === wal.invalidatedAt &&
    event.ts === wal.createdAt
}

function updateAuditMatchesWal(
  event: ProtectedMemoryUpdateAuditEvent,
  wal: ProtectedMemoryUpdateWalV1,
): boolean {
  return event.operationId === wal.operationId && event.operatorId === wal.operatorId &&
    event.profileId === wal.profileId && event.scopeId === wal.scope.scopeId &&
    event.projectId === (wal.scope.kind === 'project' ? wal.scope.projectId : undefined) &&
    event.sessionId === wal.sessionId && event.previousOperationId === wal.target.operationId &&
    event.previousFactId === wal.target.id && event.previousFactKey === wal.target.factKey &&
    event.previousSourcePath === wal.target.sourcePath &&
    event.previousContentHash === wal.target.contentHash && event.factId === wal.fact.id &&
    event.factKey === wal.fact.factKey && event.sourcePath === wal.fact.sourcePath &&
    event.contentHash === wal.fact.contentHash && event.provenance === wal.fact.provenance &&
    event.supersededAt === wal.supersededAt && event.ts === wal.createdAt
}

export function makeProtectedMemorySqliteStore(input: {
  ledgerPath: string
  keywordPath: string
  operatorId: string
  profileId: string
  scope: ProtectedMemoryScope
  startedAt: string
  deliverAuditOnce(event: ProtectedMemoryAuditEvent): Promise<void>
  deliverDeletionAuditOnce(event: ProtectedMemoryDeletionAuditEvent): Promise<void>
  deliverUpdateAuditOnce(event: ProtectedMemoryUpdateAuditEvent): Promise<void>
  faultAt?: (point: ProtectedMemorySqliteFault) => void
}): ProtectedMemorySqliteStore {
  const scope = structuredClone(input.scope)
  if (!scopeValid(scope) || input.operatorId.trim().length === 0 ||
    input.profileId.trim().length === 0 ||
    resolve(input.ledgerPath) === resolve(input.keywordPath)) {
    throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
  }
  ensurePrivateDatabasePath(input.ledgerPath)
  ensurePrivateDatabasePath(input.keywordPath)
  if (existsSync(input.ledgerPath)) {
    let probe: Database.Database | null = null
    try {
      probe = new Database(input.ledgerPath, { readonly: true, fileMustExist: true })
      probe.pragma('query_only = ON')
      const identity = probe.prepare(`
        SELECT schema_version, operator_id, profile_id, scope_kind, scope_id, project_id
        FROM ledger_control WHERE singleton = 1
      `).get() as {
        schema_version: number
        operator_id: string | null
        profile_id: string | null
        scope_kind: string
        scope_id: string
        project_id: string | null
      } | undefined
      if (!identity || identity.schema_version !== 2 ||
        identity.operator_id !== input.operatorId || identity.profile_id !== input.profileId ||
        identity.scope_kind !== scope.kind || identity.scope_id !== scope.scopeId ||
        identity.project_id !== (scope.kind === 'project' ? scope.projectId : null)) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
    } catch (error) {
      if (error instanceof ProtectedMemorySqliteStoreError) throw error
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    } finally {
      probe?.close()
    }
  }
  let ledger: Database.Database
  try {
    ledger = new Database(input.ledgerPath)
    chmodSync(input.ledgerPath, 0o600)
  } catch {
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }
  let keyword: Database.Database
  try {
    keyword = new Database(input.keywordPath)
    chmodSync(input.keywordPath, 0o600)
  } catch {
    ledger.close()
    throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
  }
  try {
    configure(ledger)
    configure(keyword)
    ledger.exec(PROTECTED_LEDGER_SCHEMA)
    keyword.exec(PROTECTED_KEYWORD_SCHEMA)
    const control = ledger.prepare('SELECT * FROM ledger_control WHERE singleton = 1').get() as
      | {
        schema_version: number
        operator_id: string | null
        profile_id: string | null
        scope_kind: string
        scope_id: string
        project_id: string | null
      }
      | undefined
    if (!control) {
      ledger.prepare(`
        INSERT INTO ledger_control (
          singleton, schema_version, operator_id, profile_id,
          scope_kind, scope_id, project_id,
          source_sha256, migration_id, started_at, forget_count, forget_head_hash
        ) VALUES (1, 2, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, 'genesis')
      `).run(
        input.operatorId,
        input.profileId,
        scope.kind,
        scope.scopeId,
        scope.kind === 'project' ? scope.projectId : null,
        input.startedAt,
      )
    } else if (control.schema_version !== 2 || control.operator_id !== input.operatorId ||
      control.profile_id !== input.profileId || control.scope_kind !== scope.kind ||
      control.scope_id !== scope.scopeId ||
      control.project_id !== (scope.kind === 'project' ? scope.projectId : null)) {
      throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
    }
    const keywordControl = keyword.prepare(
      'SELECT * FROM keyword_control WHERE singleton = 1',
    ).get() as
      | {
        schema_version: number
        operator_id: string
        profile_id: string
        scope_kind: string
        scope_id: string
        project_id: string | null
      }
      | undefined
    if (!keywordControl) {
      keyword.prepare(`
        INSERT INTO keyword_control (
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
    } else if (keywordControl.schema_version !== 1 ||
      keywordControl.operator_id !== input.operatorId ||
      keywordControl.profile_id !== input.profileId || keywordControl.scope_kind !== scope.kind ||
      keywordControl.scope_id !== scope.scopeId ||
      keywordControl.project_id !== (scope.kind === 'project' ? scope.projectId : null)) {
      throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
    }
    if (!exactColumns(ledger, 'ledger_control', [
      'singleton', 'schema_version', 'operator_id', 'profile_id',
      'scope_kind', 'scope_id', 'project_id',
      'source_sha256', 'migration_id', 'started_at', 'forget_count',
      'forget_head_hash',
    ]) || !exactColumns(ledger, 'facts', [
      'rowid', 'operation_id', 'id', 'text', 'fact_key', 'key_tokens', 'valid_at',
      'invalid_at', 'is_human_confirmed', 'source_authority', 'confidence',
      'provenance', 'supersedes', 'contradicts', 'extends_key', 'published',
      'source_path', 'content_hash',
    ]) || !exactColumns(ledger, 'do_not_remember', [
      'rowid', 'operation_id', 'fact_key', 'key_tokens', 'reason',
      'is_human_confirmed', 'ts', 'prev_hash', 'row_hash',
    ]) || !exactColumns(ledger, 'memory_publication_wal', [
      'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
    ]) || !exactColumns(ledger, 'audit_outbox', [
      'event_id', 'event_json', 'event_hash', 'delivered',
    ]) || !exactColumns(ledger, 'memory_deletion_wal', [
      'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
    ]) || !exactColumns(ledger, 'memory_deletion_audit_outbox', [
      'event_id', 'event_json', 'event_hash', 'delivered',
    ]) || !exactColumns(ledger, 'memory_update_wal', [
      'operation_id', 'scope_id', 'phase', 'wal_json', 'wal_hash',
    ]) || !exactColumns(ledger, 'memory_update_audit_outbox', [
      'event_id', 'event_json', 'event_hash', 'delivered',
    ]) || !exactColumns(keyword, 'keyword_control', [
      'singleton', 'schema_version', 'operator_id', 'profile_id',
      'scope_kind', 'scope_id', 'project_id',
    ]) || !exactColumns(keyword, 'keyword_metadata', [
      'rowid', 'operation_id', 'fact_id', 'fact_key', 'source_path',
      'content_hash', 'provenance',
    ]) || !exactColumns(keyword, 'keyword_fts', ['text'])) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
  } catch (error) {
    ledger.close()
    keyword.close()
    if (error instanceof ProtectedMemorySqliteStoreError) throw error
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }

  const factRow = (operationId: string): FactRow | undefined => ledger.prepare(
    'SELECT * FROM facts WHERE operation_id = ?',
  ).get(operationId) as FactRow | undefined
  const factRowById = (factId: string): FactRow | undefined => ledger.prepare(
    'SELECT * FROM facts WHERE id = ?',
  ).get(factId) as FactRow | undefined
  const walRow = (operationId: string): WalRow | undefined => ledger.prepare(
    'SELECT * FROM memory_publication_wal WHERE operation_id = ?',
  ).get(operationId) as WalRow | undefined
  const auditRow = (eventId: string): AuditRow | undefined => ledger.prepare(
    'SELECT * FROM audit_outbox WHERE event_id = ?',
  ).get(eventId) as AuditRow | undefined
  const deletionWalRow = (operationId: string): WalRow | undefined => ledger.prepare(
    'SELECT * FROM memory_deletion_wal WHERE operation_id = ?',
  ).get(operationId) as WalRow | undefined
  const deletionAuditRow = (eventId: string): AuditRow | undefined => ledger.prepare(
    'SELECT * FROM memory_deletion_audit_outbox WHERE event_id = ?',
  ).get(eventId) as AuditRow | undefined
  const updateWalRow = (operationId: string): WalRow | undefined => ledger.prepare(
    'SELECT * FROM memory_update_wal WHERE operation_id = ?',
  ).get(operationId) as WalRow | undefined
  const updateAuditRow = (eventId: string): AuditRow | undefined => ledger.prepare(
    'SELECT * FROM memory_update_audit_outbox WHERE event_id = ?',
  ).get(eventId) as AuditRow | undefined
  const keywordRow = (operationId: string): KeywordRow | undefined => keyword.prepare(
    'SELECT * FROM keyword_metadata WHERE operation_id = ?',
  ).get(operationId) as KeywordRow | undefined

  const assertNoMutationWals = (): void => {
    const counts = ledger.prepare(`
      SELECT
        (SELECT count(*) FROM memory_publication_wal) +
        (SELECT count(*) FROM memory_deletion_wal) +
        (SELECT count(*) FROM memory_update_wal) AS count
    `).get() as { count: number }
    if (counts.count !== 0) throw new ProtectedMemorySqliteStoreError('RECOVERY_REQUIRED')
  }

  const verifyForgetChain = (): void => {
    const control = ledger.prepare(`
      SELECT forget_count, forget_head_hash
      FROM ledger_control WHERE singleton = 1
    `).get() as { forget_count: number; forget_head_hash: string } | undefined
    if (!control || !Number.isSafeInteger(control.forget_count) || control.forget_count < 0 ||
      (control.forget_head_hash !== 'genesis' && !HASH.test(control.forget_head_hash))) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    const rows = ledger.prepare(
      'SELECT * FROM do_not_remember ORDER BY rowid',
    ).all() as ForgetRow[]
    let previous = 'genesis'
    for (const row of rows) {
      const expected = sha256(
        `${previous}‖${row.fact_key}‖${row.key_tokens}‖${row.reason}‖${row.ts}`,
      )
      if (!Number.isSafeInteger(row.rowid) || row.rowid < 1 ||
        (row.operation_id !== null && !HASH.test(row.operation_id)) ||
        !HASH.test(row.fact_key) || typeof row.key_tokens !== 'string' ||
        typeof row.reason !== 'string' ||
        (row.is_human_confirmed !== 0 && row.is_human_confirmed !== 1) ||
        row.ts.length === 0 || row.prev_hash !== previous ||
        !HASH.test(row.row_hash) || row.row_hash !== expected) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      previous = row.row_hash
    }
    if (rows.length !== control.forget_count || previous !== control.forget_head_hash) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
  }

  const outboxEvent = (row: AuditRow): ProtectedMemoryAuditEvent => {
    if (!HASH.test(row.event_hash) || sha256(row.event_json) !== row.event_hash ||
      (row.delivered !== 0 && row.delivered !== 1)) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    try {
      const event = parseProtectedMemoryAuditEvent(JSON.parse(row.event_json) as unknown)
      if (!event || event.eventId !== row.event_id || event.operatorId !== input.operatorId ||
        event.profileId !== input.profileId) throw new Error('invalid event')
      return event
    } catch {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
  }

  const deletionOutboxEvent = (row: AuditRow): ProtectedMemoryDeletionAuditEvent => {
    if (!HASH.test(row.event_hash) || sha256(row.event_json) !== row.event_hash ||
      (row.delivered !== 0 && row.delivered !== 1)) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    try {
      const event = parseProtectedMemoryDeletionAuditEvent(
        JSON.parse(row.event_json) as unknown,
      )
      if (!event || event.eventId !== row.event_id || event.operatorId !== input.operatorId ||
        event.profileId !== input.profileId) throw new Error('invalid event')
      return event
    } catch {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
  }

  const updateOutboxEvent = (row: AuditRow): ProtectedMemoryUpdateAuditEvent => {
    if (!HASH.test(row.event_hash) || sha256(row.event_json) !== row.event_hash ||
      (row.delivered !== 0 && row.delivered !== 1)) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    try {
      const event = parseProtectedMemoryUpdateAuditEvent(JSON.parse(row.event_json) as unknown)
      if (!event || event.eventId !== row.event_id || event.operatorId !== input.operatorId ||
        event.profileId !== input.profileId) throw new Error('invalid event')
      return event
    } catch {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
  }

  const legacyOperationId = (row: FactRow): string => sha256(JSON.stringify([
    'aisy.protected-memory-legacy-fact.v1', input.operatorId, input.profileId,
    scope.scopeId, row.id, row.content_hash, row.provenance,
  ]))

  const factSnapshot = (row: FactRow): ProtectedMemoryFactRecordV2 => {
    const wal = row.operation_id === null ? null : parseWalRow(walRow(row.operation_id))
    const audit = row.operation_id === null ? undefined : auditRow(row.operation_id)
    const event = audit ? outboxEvent(audit) : null
    const updateWal = row.operation_id === null ? null : parseUpdateWalRow(updateWalRow(row.operation_id))
    const updateAudit = row.operation_id === null ? undefined : updateAuditRow(row.operation_id)
    const updateEvent = updateAudit ? updateOutboxEvent(updateAudit) : null
    const owner = row.operation_id === null
      ? { operatorId: input.operatorId, profileId: input.profileId }
      : wal
      ? { operatorId: wal.operatorId, profileId: wal.profileId }
      : event
      ? { operatorId: event.operatorId, profileId: event.profileId }
      : updateWal
      ? { operatorId: updateWal.operatorId, profileId: updateWal.profileId }
      : updateEvent ? { operatorId: updateEvent.operatorId, profileId: updateEvent.profileId } : null
    if (!owner || owner.operatorId !== input.operatorId || owner.profileId !== input.profileId ||
      row.source_path === null || row.content_hash === null) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    const fact = parseProtectedMemoryFactRecord({
      schemaVersion: 2,
      operationId: row.operation_id ?? legacyOperationId(row),
      id: row.id,
      ...owner,
      scope,
      text: row.text,
      factKey: row.fact_key,
      keyTokens: row.key_tokens.split('|'),
      validAt: row.valid_at,
      invalidAt: null,
      isHumanConfirmed: row.is_human_confirmed !== 0,
      sourceAuthority: row.source_authority,
      confidence: row.confidence,
      provenance: row.provenance,
      ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
      ...(row.contradicts === null ? {} : { contradicts: row.contradicts }),
      ...(row.extends_key === null ? {} : { extends: row.extends_key }),
      sourcePath: row.source_path,
      contentHash: row.content_hash,
      published: row.published !== 0,
    })
    if (!fact || (wal && !factRowIdentityMatches(row, wal.fact)) ||
      (event && !auditMatchesFact(event, fact)) ||
      (updateWal && !factRowIdentityMatches(row, updateWal.fact)) ||
      (updateEvent && (updateEvent.factId !== fact.id || updateEvent.factKey !== fact.factKey ||
        updateEvent.sourcePath !== fact.sourcePath || updateEvent.contentHash !== fact.contentHash ||
        updateEvent.provenance !== fact.provenance))) {
      throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
    }
    return fact
  }

  const factRowMatchesDeletionTarget = (
    row: FactRow,
    target: ProtectedMemoryFactRecordV2,
  ): boolean => {
    const operationMatches = row.operation_id === target.operationId ||
      (row.operation_id === null && row.content_hash !== null &&
        legacyOperationId(row) === target.operationId)
    return operationMatches && row.id === target.id && row.text === target.text &&
      row.fact_key === target.factKey && row.key_tokens === target.keyTokens.join('|') &&
      row.valid_at === target.validAt &&
      (row.is_human_confirmed !== 0) === target.isHumanConfirmed &&
      row.source_authority === target.sourceAuthority && row.confidence === target.confidence &&
      row.provenance === target.provenance && row.supersedes === (target.supersedes ?? null) &&
      row.contradicts === (target.contradicts ?? null) &&
      row.extends_key === (target.extends ?? null) && row.published === 1 &&
      row.source_path === target.sourcePath && row.content_hash === target.contentHash
  }

  const publicFact = (operationId: string): ProtectedMemoryFactRecordV2 | null => {
    const row = factRow(operationId)
    if (!row) return null
    if (row.invalid_at !== null) return null
    return factSnapshot(row)
  }

  const keywordProjectionMatches = (fact: ProtectedMemoryFactRecordV2): boolean => {
    const metadata = keywordRow(fact.operationId)
    if (!metadata || metadata.fact_id !== fact.id || metadata.fact_key !== fact.factKey ||
      metadata.source_path !== fact.sourcePath || metadata.content_hash !== fact.contentHash ||
      metadata.provenance !== fact.provenance) return false
    const fts = keyword.prepare('SELECT text FROM keyword_fts WHERE rowid = ?').get(
      metadata.rowid,
    ) as { text: string } | undefined
    return fts?.text === fact.text
  }

  const verifyDeletionRecoveryState = (): void => {
    const walRows = ledger.prepare('SELECT * FROM memory_deletion_wal').all() as WalRow[]
    const auditRows = ledger.prepare(
      'SELECT * FROM memory_deletion_audit_outbox',
    ).all() as AuditRow[]
    const wals = new Map<string, ProtectedMemoryDeletionWalV1>()
    const audits = new Map<string, { event: ProtectedMemoryDeletionAuditEvent; delivered: number }>()
    for (const row of walRows) {
      const wal = parseDeletionWalRow(row)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      wals.set(wal.operationId, wal)
    }
    for (const row of auditRows) {
      const event = deletionOutboxEvent(row)
      audits.set(event.operationId, { event, delivered: row.delivered })
    }
    for (const wal of wals.values()) {
      const row = factRowById(wal.target.id)
      const audit = audits.get(wal.operationId)
      if (!row || !factRowMatchesDeletionTarget(row, wal.target) ||
        (row.invalid_at !== null && row.invalid_at !== wal.invalidatedAt) ||
        (audit && !deletionAuditMatchesWal(audit.event, wal))) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      const tombstoned = row.invalid_at === wal.invalidatedAt
      if (wal.phase === 'PREPARED') {
        if (tombstoned !== (audit !== undefined)) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
        }
      } else if (!tombstoned || !audit) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      if (['KEYWORD_PURGED', 'DERIVED_PURGED', 'FILE_REMOVED', 'AUDITED'].includes(wal.phase) &&
        keywordRow(wal.target.operationId)) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
      }
      if (wal.phase === 'AUDITED' && audit?.delivered !== 1) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
    }
    for (const { event, delivered } of audits.values()) {
      if (wals.has(event.operationId)) continue
      if (delivered !== 1) throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      const row = factRowById(event.factId)
      const snapshot = row ? factSnapshot(row) : null
      if (!row || !snapshot || row.invalid_at !== event.invalidatedAt ||
        event.targetOperationId !== snapshot.operationId || event.factKey !== snapshot.factKey ||
        event.sourcePath !== snapshot.sourcePath || event.contentHash !== snapshot.contentHash ||
        !factRowMatchesDeletionTarget(row, snapshot)) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
    }
  }

  const verifyUpdateRecoveryState = (): void => {
    const walRows = ledger.prepare('SELECT * FROM memory_update_wal').all() as WalRow[]
    const auditRows = ledger.prepare('SELECT * FROM memory_update_audit_outbox').all() as AuditRow[]
    const wals = new Map<string, ProtectedMemoryUpdateWalV1>()
    const audits = new Map<string, { event: ProtectedMemoryUpdateAuditEvent; delivered: number }>()
    const deletionEvents = (ledger.prepare(
      'SELECT * FROM memory_deletion_audit_outbox',
    ).all() as AuditRow[]).map(deletionOutboxEvent)
    for (const row of walRows) {
      const wal = parseUpdateWalRow(row)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      wals.set(wal.operationId, wal)
    }
    for (const row of auditRows) {
      const event = updateOutboxEvent(row)
      audits.set(event.operationId, { event, delivered: row.delivered })
    }
    for (const wal of wals.values()) {
      const target = factRowById(wal.target.id)
      const replacement = factRow(wal.operationId)
      const audit = audits.get(wal.operationId)
      if (!target || !factRowMatchesDeletionTarget(target, wal.target) ||
        (target.invalid_at !== null && target.invalid_at !== wal.supersededAt) ||
        ((replacement === undefined) !== (audit === undefined)) ||
        (audit && !updateAuditMatchesWal(audit.event, wal))) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      if (!replacement) {
        if (wal.phase !== 'PREPARED' || target.invalid_at !== null) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
        }
        continue
      }
      if (!factRowIdentityMatches(replacement, wal.fact) || replacement.invalid_at !== null ||
        (replacement.published !== 0 && replacement.published !== 1)) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      const swapped = target.invalid_at === wal.supersededAt && replacement.published === 1
      const pending = target.invalid_at === null && replacement.published === 0
      if (!swapped && !pending) throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      const oldKeyword = keywordRow(wal.target.operationId)
      const newKeyword = keywordRow(wal.fact.operationId)
      if (pending && (!oldKeyword || newKeyword) || swapped && (oldKeyword !== undefined) ===
        (newKeyword !== undefined)) throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
      if (['KEYWORD_SWAPPED', 'DERIVED_PURGED', 'OLD_FILE_REMOVED', 'AUDITED'].includes(wal.phase) &&
        !newKeyword) throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
      if (wal.phase === 'AUDITED' && audit?.delivered !== 1) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
    }
    for (const { event, delivered } of audits.values()) {
      if (wals.has(event.operationId)) continue
      if (delivered !== 1) throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      const target = factRowById(event.previousFactId)
      const replacement = factRow(event.operationId)
      const targetSnapshot = target ? factSnapshot(target) : null
      const replacementSnapshot = replacement ? factSnapshot(replacement) : null
      const downstreamDeletion = deletionEvents.find(
        (candidate) => candidate.targetOperationId === event.operationId,
      )
      const downstreamUpdate = [...audits.values()].map((entry) => entry.event).find(
        (candidate) => candidate.previousOperationId === event.operationId,
      )
      const replacementRetired = replacement?.invalid_at !== null &&
        ((downstreamDeletion !== undefined &&
          downstreamDeletion.factId === replacement?.id &&
          downstreamDeletion.factKey === replacement?.fact_key &&
          downstreamDeletion.invalidatedAt === replacement?.invalid_at) ||
        (downstreamUpdate !== undefined &&
          downstreamUpdate.previousFactId === replacement?.id &&
          downstreamUpdate.previousFactKey === replacement?.fact_key &&
          downstreamUpdate.supersededAt === replacement?.invalid_at))
      const replacementProjectionValid = replacement?.invalid_at === null
        ? replacementSnapshot !== null && keywordProjectionMatches(replacementSnapshot)
        : replacementRetired && keywordRow(event.operationId) === undefined
      if (!target || !replacement || target.invalid_at !== event.supersededAt ||
        replacement.published !== 1 ||
        targetSnapshot?.operationId !== event.previousOperationId || replacement.id !== event.factId ||
        replacement.fact_key !== event.factKey || replacement.source_path !== event.sourcePath ||
        replacement.content_hash !== event.contentHash || keywordRow(event.previousOperationId) ||
        !replacementProjectionValid) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
    }
  }

  try {
    verifyForgetChain()
    const walRows = ledger.prepare('SELECT * FROM memory_publication_wal').all() as WalRow[]
    walRows.forEach((row) => {
      const wal = parseWalRow(row)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
    })
    const outboxRows = ledger.prepare('SELECT * FROM audit_outbox').all() as AuditRow[]
    outboxRows.forEach(outboxEvent)
    const deletionWalRows = ledger.prepare('SELECT * FROM memory_deletion_wal').all() as WalRow[]
    deletionWalRows.forEach((row) => {
      const wal = parseDeletionWalRow(row)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
    })
    const deletionOutboxRows = ledger.prepare(
      'SELECT * FROM memory_deletion_audit_outbox',
    ).all() as AuditRow[]
    deletionOutboxRows.forEach(deletionOutboxEvent)
    const updateWalRows = ledger.prepare('SELECT * FROM memory_update_wal').all() as WalRow[]
    updateWalRows.forEach((row) => {
      const wal = parseUpdateWalRow(row)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
    })
    const updateOutboxRows = ledger.prepare(
      'SELECT * FROM memory_update_audit_outbox',
    ).all() as AuditRow[]
    updateOutboxRows.forEach(updateOutboxEvent)
    verifyDeletionRecoveryState()
    verifyUpdateRecoveryState()
  } catch (error) {
    ledger.close()
    keyword.close()
    if (error instanceof ProtectedMemorySqliteStoreError) throw error
    throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
  }

  return Object.freeze<ProtectedMemorySqliteStore>({
    async loadWal(operationId) {
      verifyForgetChain()
      const wal = parseWalRow(walRow(operationId))
      if (wal && (wal.operatorId !== input.operatorId || wal.profileId !== input.profileId)) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
      return wal
    },

    async listWals(requestedScope) {
      if (!sameScope(scope, requestedScope)) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
      verifyForgetChain()
      const rows = ledger.prepare(
        'SELECT * FROM memory_publication_wal WHERE scope_id = ? ORDER BY operation_id',
      ).all(scope.scopeId) as WalRow[]
      if (rows.length > MAX_WAL_ROWS) throw new ProtectedMemorySqliteStoreError('LIMIT_EXCEEDED')
      return rows.map((row) => {
        const wal = parseWalRow(row)
        if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
          throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
        }
        return wal
      })
    },

    async createWal(value) {
      const wal = parseProtectedMemoryPublicationWal(value)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const json = stableJson(wal)
      const existing = parseWalRow(walRow(wal.operationId))
      if (existing) {
        if (!isDeepStrictEqual(existing, wal)) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
      } else {
        ledger.prepare(`
          INSERT INTO memory_publication_wal (
            operation_id, scope_id, phase, wal_json, wal_hash
          ) VALUES (?, ?, ?, ?, ?)
        `).run(wal.operationId, scope.scopeId, wal.phase, json, sha256(json))
      }
      input.faultAt?.('after-create-wal')
    },

    async advanceWal({ operationId, expectedPhase, next }) {
      const wal = parseProtectedMemoryPublicationWal(next)
      const stored = walRow(operationId)
      const current = parseWalRow(stored)
      if (!wal || !current || current.phase !== expectedPhase ||
        !stored || wal.operationId !== operationId || wal.operatorId !== input.operatorId ||
        wal.profileId !== input.profileId || !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const json = stableJson(wal)
      const result = ledger.prepare(`
        UPDATE memory_publication_wal
        SET phase = ?, wal_json = ?, wal_hash = ?
        WHERE operation_id = ? AND phase = ? AND wal_hash = ?
      `).run(wal.phase, json, sha256(json), operationId, expectedPhase, stored.wal_hash)
      if (result.changes !== 1) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      input.faultAt?.('after-advance-wal')
    },

    async loadFactByOperation(operationId) {
      verifyForgetChain()
      return publicFact(operationId)
    },

    async createPendingFactAndOutbox({ fact: rawFact, audit: rawAudit }) {
      const fact = parseProtectedMemoryFactRecord(rawFact)
      const audit = parseProtectedMemoryAuditEvent(rawAudit)
      if (!fact || fact.published || !audit || fact.operatorId !== input.operatorId ||
        fact.profileId !== input.profileId || !sameScope(scope, fact.scope) ||
        !auditMatchesFact(audit, fact) || fact.keyTokens.some((token) => token.includes('|'))) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      ledger.transaction(() => {
        verifyForgetChain()
        const forgotten = ledger.prepare(
          'SELECT rowid FROM do_not_remember WHERE fact_key = ?',
        ).get(fact.factKey)
        if (forgotten) throw new ProtectedMemorySqliteStoreError('FORGOTTEN_FACT')
        const existing = factRow(fact.operationId)
        if (existing) {
          if (!factRowMatches(existing, fact) || existing.published !== 0) {
            throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
          }
        } else {
          ledger.prepare(`
            INSERT INTO facts (
              operation_id, id, text, fact_key, key_tokens, valid_at, invalid_at,
              is_human_confirmed, source_authority, confidence, provenance,
              supersedes, contradicts, extends_key, published, source_path, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `).run(
            fact.operationId, fact.id, fact.text, fact.factKey, fact.keyTokens.join('|'),
            fact.validAt, fact.isHumanConfirmed ? 1 : 0, fact.sourceAuthority,
            fact.confidence, fact.provenance, fact.supersedes ?? null,
            fact.contradicts ?? null, fact.extends ?? null, fact.sourcePath, fact.contentHash,
          )
        }
        const eventJson = stableJson(audit)
        const existingAudit = auditRow(audit.eventId)
        if (existingAudit) {
          if (outboxEvent(existingAudit).eventId !== audit.eventId ||
            existingAudit.event_json !== eventJson) {
            throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
          }
        } else {
          ledger.prepare(`
            INSERT INTO audit_outbox (event_id, event_json, event_hash, delivered)
            VALUES (?, ?, ?, 0)
          `).run(audit.eventId, eventJson, sha256(eventJson))
        }
      })()
      input.faultAt?.('after-pending')
    },

    async publishFactAndKeywordProjection(rawFact) {
      const fact = parseProtectedMemoryFactRecord(rawFact)
      if (!fact || fact.published || fact.operatorId !== input.operatorId ||
        fact.profileId !== input.profileId || !sameScope(scope, fact.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      ledger.transaction(() => {
        verifyForgetChain()
        const row = factRow(fact.operationId)
        if (!row || !factRowMatches(row, fact) || row.invalid_at !== null) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
        if (ledger.prepare('SELECT rowid FROM do_not_remember WHERE fact_key = ?').get(fact.factKey)) {
          throw new ProtectedMemorySqliteStoreError('FORGOTTEN_FACT')
        }
        if (row.published === 0) {
          ledger.prepare('UPDATE facts SET published = 1 WHERE operation_id = ?').run(fact.operationId)
        }
      })()
      input.faultAt?.('after-ledger-publish')

      keyword.transaction(() => {
        let metadata = keywordRow(fact.operationId)
        if (!metadata) {
          const result = keyword.prepare(`
            INSERT INTO keyword_metadata (
              operation_id, fact_id, fact_key, source_path, content_hash, provenance
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            fact.operationId, fact.id, fact.factKey, fact.sourcePath,
            fact.contentHash, fact.provenance,
          )
          const rowid = result.lastInsertRowid
          keyword.prepare('INSERT INTO keyword_fts(rowid, text) VALUES (?, ?)').run(rowid, fact.text)
          metadata = keywordRow(fact.operationId)
        }
        if (!metadata || metadata.fact_id !== fact.id || metadata.fact_key !== fact.factKey ||
          metadata.source_path !== fact.sourcePath || metadata.content_hash !== fact.contentHash ||
          metadata.provenance !== fact.provenance) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
        const fts = keyword.prepare('SELECT text FROM keyword_fts WHERE rowid = ?').get(
          metadata.rowid,
        ) as { text: string } | undefined
        if (!fts) keyword.prepare('INSERT INTO keyword_fts(rowid, text) VALUES (?, ?)').run(
          metadata.rowid,
          fact.text,
        )
        else if (fts.text !== fact.text) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
        }
      })()
      input.faultAt?.('after-keyword-publish')
    },

    async verifyPublished(rawFact) {
      verifyForgetChain()
      const fact = parseProtectedMemoryFactRecord(rawFact)
      if (!fact || fact.operatorId !== input.operatorId || fact.profileId !== input.profileId ||
        !sameScope(scope, fact.scope)) return false
      const row = factRow(fact.operationId)
      if (!row || row.published !== 1 || row.invalid_at !== null || !factRowMatches(row, fact) ||
        ledger.prepare('SELECT rowid FROM do_not_remember WHERE fact_key = ?').get(fact.factKey)) {
        return false
      }
      return keywordProjectionMatches(fact)
    },

    async deliverAuditOnce(rawEvent) {
      const event = parseProtectedMemoryAuditEvent(rawEvent)
      const row = event ? auditRow(event.eventId) : undefined
      if (!event || event.operatorId !== input.operatorId || event.profileId !== input.profileId ||
        !row || !isDeepStrictEqual(outboxEvent(row), event)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      if (row.delivered === 1) return
      await input.deliverAuditOnce(event)
      input.faultAt?.('after-audit-delivery')
      const result = ledger.prepare(`
        UPDATE audit_outbox SET delivered = 1
        WHERE event_id = ? AND delivered = 0 AND event_hash = ?
      `).run(event.eventId, row.event_hash)
      if (result.changes !== 1 && auditRow(event.eventId)?.delivered !== 1) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      input.faultAt?.('after-audit-mark')
    },

    async auditDelivered(eventId) {
      const row = auditRow(eventId)
      return row !== undefined && outboxEvent(row).eventId === eventId && row.delivered === 1
    },

    async deleteWal(operationId) {
      ledger.prepare('DELETE FROM memory_publication_wal WHERE operation_id = ?').run(operationId)
      input.faultAt?.('after-delete-wal')
    },

    async loadTargetById(factId) {
      verifyForgetChain()
      const row = factRowById(factId)
      if (!row || row.published !== 1) return null
      if (row.invalid_at === null && ledger.prepare(
        'SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1',
      ).get(row.fact_key)) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      }
      const fact = factSnapshot(row)
      return { fact, invalidatedAt: row.invalid_at }
    },

    async loadDeletionWal(operationId) {
      verifyForgetChain()
      const wal = parseDeletionWalRow(deletionWalRow(operationId))
      if (wal && (wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope))) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
      return wal
    },

    async listDeletionWals(requestedScope) {
      if (!sameScope(scope, requestedScope)) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
      verifyForgetChain()
      const rows = ledger.prepare(
        'SELECT * FROM memory_deletion_wal WHERE scope_id = ? ORDER BY operation_id',
      ).all(scope.scopeId) as WalRow[]
      if (rows.length > MAX_WAL_ROWS) throw new ProtectedMemorySqliteStoreError('LIMIT_EXCEEDED')
      return rows.map((row) => {
        const wal = parseDeletionWalRow(row)
        if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
          throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
        }
        return wal
      })
    },

    async createDeletionWal(value) {
      verifyForgetChain()
      const wal = parseProtectedMemoryDeletionWal(value)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const json = stableJson(wal)
      const existing = parseDeletionWalRow(deletionWalRow(wal.operationId))
      if (existing) {
        if (!isDeepStrictEqual(existing, wal)) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
      } else {
        ledger.prepare(`
          INSERT INTO memory_deletion_wal (
            operation_id, scope_id, phase, wal_json, wal_hash
          ) VALUES (?, ?, ?, ?, ?)
        `).run(wal.operationId, scope.scopeId, wal.phase, json, sha256(json))
      }
      input.faultAt?.('after-create-deletion-wal')
    },

    async advanceDeletionWal({ operationId, expectedPhase, next }) {
      verifyForgetChain()
      const wal = parseProtectedMemoryDeletionWal(next)
      const stored = deletionWalRow(operationId)
      const current = parseDeletionWalRow(stored)
      if (!wal || !current || !stored || current.phase !== expectedPhase ||
        wal.operationId !== operationId || wal.operatorId !== input.operatorId ||
        wal.profileId !== input.profileId || !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const json = stableJson(wal)
      const result = ledger.prepare(`
        UPDATE memory_deletion_wal SET phase = ?, wal_json = ?, wal_hash = ?
        WHERE operation_id = ? AND phase = ? AND wal_hash = ?
      `).run(wal.phase, json, sha256(json), operationId, expectedPhase, stored.wal_hash)
      if (result.changes !== 1) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      input.faultAt?.('after-advance-deletion-wal')
    },

    async tombstoneAndCreateDeletionOutbox({ wal: rawWal, audit: rawAudit }) {
      const wal = parseProtectedMemoryDeletionWal(rawWal)
      const audit = parseProtectedMemoryDeletionAuditEvent(rawAudit)
      if (!wal || !audit || wal.operatorId !== input.operatorId ||
        wal.profileId !== input.profileId || !sameScope(scope, wal.scope) ||
        !deletionAuditMatchesWal(audit, wal)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      ledger.transaction(() => {
        verifyForgetChain()
        const row = factRowById(wal.target.id)
        if (!row || !factRowMatchesDeletionTarget(row, wal.target) ||
          (row.invalid_at !== null && row.invalid_at !== wal.invalidatedAt)) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
        if (row.invalid_at === null) {
          ledger.prepare('UPDATE facts SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
            .run(wal.invalidatedAt, wal.target.id)
        }
        if (wal.humanConfirmed) {
          const existingForget = ledger.prepare(
            'SELECT * FROM do_not_remember WHERE operation_id = ?',
          ).get(wal.operationId) as ForgetRow | undefined
          if (existingForget) {
            if (existingForget.fact_key !== wal.target.factKey ||
              existingForget.key_tokens !== wal.target.keyTokens.join('|') ||
              existingForget.reason !== wal.reason || existingForget.is_human_confirmed !== 1 ||
              existingForget.ts !== wal.invalidatedAt) {
              throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
            }
          } else {
            const control = ledger.prepare(`
              SELECT forget_count, forget_head_hash FROM ledger_control WHERE singleton = 1
            `).get() as { forget_count: number; forget_head_hash: string }
            const keyTokens = wal.target.keyTokens.join('|')
            const rowHash = sha256(
              `${control.forget_head_hash}‖${wal.target.factKey}‖${keyTokens}‖${wal.reason}‖${wal.invalidatedAt}`,
            )
            ledger.prepare(`
              INSERT INTO do_not_remember (
                operation_id, fact_key, key_tokens, reason, is_human_confirmed,
                ts, prev_hash, row_hash
              ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            `).run(
              wal.operationId, wal.target.factKey, keyTokens, wal.reason,
              wal.invalidatedAt, control.forget_head_hash, rowHash,
            )
            const anchored = ledger.prepare(`
              UPDATE ledger_control
              SET forget_count = ?, forget_head_hash = ?
              WHERE singleton = 1 AND forget_count = ? AND forget_head_hash = ?
            `).run(
              control.forget_count + 1, rowHash,
              control.forget_count, control.forget_head_hash,
            )
            if (anchored.changes !== 1) {
              throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
            }
          }
        }
        const eventJson = stableJson(audit)
        const existingAudit = deletionAuditRow(audit.eventId)
        if (existingAudit) {
          if (!isDeepStrictEqual(deletionOutboxEvent(existingAudit), audit) ||
            existingAudit.event_json !== eventJson) {
            throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
          }
        } else {
          ledger.prepare(`
            INSERT INTO memory_deletion_audit_outbox (
              event_id, event_json, event_hash, delivered
            ) VALUES (?, ?, ?, 0)
          `).run(audit.eventId, eventJson, sha256(eventJson))
        }
        verifyForgetChain()
      })()
      input.faultAt?.('after-tombstone')
    },

    async purgeKeywordProjection(rawWal) {
      verifyForgetChain()
      const wal = parseProtectedMemoryDeletionWal(rawWal)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      keyword.transaction(() => {
        const metadata = keywordRow(wal.target.operationId)
        if (!metadata) return
        if (metadata.fact_id !== wal.target.id || metadata.fact_key !== wal.target.factKey ||
          metadata.content_hash !== wal.target.contentHash ||
          metadata.source_path !== wal.target.sourcePath) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
        }
        keyword.prepare('DELETE FROM keyword_fts WHERE rowid = ?').run(metadata.rowid)
        keyword.prepare('DELETE FROM keyword_metadata WHERE rowid = ?').run(metadata.rowid)
      })()
      input.faultAt?.('after-keyword-purge')
    },

    async verifyDeletionState(rawWal) {
      verifyForgetChain()
      const wal = parseProtectedMemoryDeletionWal(rawWal)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) return false
      const row = factRowById(wal.target.id)
      if (!row || !factRowMatchesDeletionTarget(row, wal.target) ||
        row.invalid_at !== wal.invalidatedAt || keywordRow(wal.target.operationId)) return false
      const forgotten = ledger.prepare(
        'SELECT * FROM do_not_remember WHERE operation_id = ?',
      ).get(wal.operationId) as ForgetRow | undefined
      if (!wal.humanConfirmed) return forgotten === undefined
      return forgotten?.fact_key === wal.target.factKey &&
        forgotten.key_tokens === wal.target.keyTokens.join('|') &&
        forgotten.reason === wal.reason && forgotten.is_human_confirmed === 1 &&
        forgotten.ts === wal.invalidatedAt
    },

    async loadDeletionAudit(operationId) {
      verifyForgetChain()
      const row = deletionAuditRow(operationId)
      return row ? deletionOutboxEvent(row) : null
    },

    async deliverDeletionAuditOnce(rawEvent) {
      verifyForgetChain()
      const event = parseProtectedMemoryDeletionAuditEvent(rawEvent)
      const row = event ? deletionAuditRow(event.eventId) : undefined
      if (!event || event.operatorId !== input.operatorId || event.profileId !== input.profileId ||
        !row || !isDeepStrictEqual(deletionOutboxEvent(row), event)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      if (row.delivered === 1) return
      await input.deliverDeletionAuditOnce(event)
      input.faultAt?.('after-deletion-audit-delivery')
      const result = ledger.prepare(`
        UPDATE memory_deletion_audit_outbox SET delivered = 1
        WHERE event_id = ? AND delivered = 0 AND event_hash = ?
      `).run(event.eventId, row.event_hash)
      if (result.changes !== 1 && deletionAuditRow(event.eventId)?.delivered !== 1) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      input.faultAt?.('after-deletion-audit-mark')
    },

    async deletionAuditDelivered(eventId) {
      verifyForgetChain()
      const row = deletionAuditRow(eventId)
      return row !== undefined && deletionOutboxEvent(row).eventId === eventId && row.delivered === 1
    },

    async deleteDeletionWal(operationId) {
      ledger.prepare('DELETE FROM memory_deletion_wal WHERE operation_id = ?').run(operationId)
      input.faultAt?.('after-delete-deletion-wal')
    },

    async loadUpdateTargetById(factId) {
      verifyForgetChain()
      const row = factRowById(factId)
      if (!row || row.published !== 1) return null
      if (row.invalid_at === null && ledger.prepare(
        'SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1',
      ).get(row.fact_key)) throw new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')
      return { fact: factSnapshot(row), invalidatedAt: row.invalid_at }
    },

    async loadUpdateWal(operationId) {
      verifyForgetChain()
      const wal = parseUpdateWalRow(updateWalRow(operationId))
      if (wal && (wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope))) throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      return wal
    },

    async listUpdateWals(requestedScope) {
      if (!sameScope(scope, requestedScope)) {
        throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
      }
      verifyForgetChain()
      const rows = ledger.prepare(
        'SELECT * FROM memory_update_wal WHERE scope_id = ? ORDER BY operation_id',
      ).all(scope.scopeId) as WalRow[]
      if (rows.length > MAX_WAL_ROWS) throw new ProtectedMemorySqliteStoreError('LIMIT_EXCEEDED')
      return rows.map((row) => {
        const wal = parseUpdateWalRow(row)
        if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId) {
          throw new ProtectedMemorySqliteStoreError('SCOPE_MISMATCH')
        }
        return wal
      })
    },

    async createUpdateWal(value) {
      verifyForgetChain()
      const wal = parseProtectedMemoryUpdateWal(value)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      const json = stableJson(wal)
      const existing = parseUpdateWalRow(updateWalRow(wal.operationId))
      if (existing) {
        if (!isDeepStrictEqual(existing, wal)) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
      } else {
        ledger.prepare(`
          INSERT INTO memory_update_wal (operation_id, scope_id, phase, wal_json, wal_hash)
          VALUES (?, ?, ?, ?, ?)
        `).run(wal.operationId, scope.scopeId, wal.phase, json, sha256(json))
      }
      input.faultAt?.('after-create-update-wal')
    },

    async advanceUpdateWal({ operationId, expectedPhase, next }) {
      verifyForgetChain()
      const wal = parseProtectedMemoryUpdateWal(next)
      const stored = updateWalRow(operationId)
      const current = parseUpdateWalRow(stored)
      if (!wal || !stored || !current || current.phase !== expectedPhase ||
        wal.operationId !== operationId || wal.operatorId !== input.operatorId ||
        wal.profileId !== input.profileId || !sameScope(scope, wal.scope)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const json = stableJson(wal)
      const result = ledger.prepare(`
        UPDATE memory_update_wal SET phase = ?, wal_json = ?, wal_hash = ?
        WHERE operation_id = ? AND phase = ? AND wal_hash = ?
      `).run(wal.phase, json, sha256(json), operationId, expectedPhase, stored.wal_hash)
      if (result.changes !== 1) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      input.faultAt?.('after-advance-update-wal')
    },

    async createPendingUpdate({ wal: rawWal, audit: rawAudit }) {
      const wal = parseProtectedMemoryUpdateWal(rawWal)
      const audit = parseProtectedMemoryUpdateAuditEvent(rawAudit)
      if (!wal || !audit || wal.operatorId !== input.operatorId ||
        wal.profileId !== input.profileId || !sameScope(scope, wal.scope) ||
        !updateAuditMatchesWal(audit, wal)) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      ledger.transaction(() => {
        verifyForgetChain()
        const target = factRowById(wal.target.id)
        if (!target || !factRowMatchesDeletionTarget(target, wal.target) ||
          target.invalid_at !== null) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        if (ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
          .get(wal.fact.factKey)) throw new ProtectedMemorySqliteStoreError('FORGOTTEN_FACT')
        const existingFact = factRow(wal.operationId)
        if (existingFact) {
          if (!factRowMatches(existingFact, wal.fact) || existingFact.published !== 0) {
            throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
          }
        } else {
          ledger.prepare(`
            INSERT INTO facts (
              operation_id, id, text, fact_key, key_tokens, valid_at, invalid_at,
              is_human_confirmed, source_authority, confidence, provenance,
              supersedes, contradicts, extends_key, published, source_path, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `).run(
            wal.fact.operationId, wal.fact.id, wal.fact.text, wal.fact.factKey,
            wal.fact.keyTokens.join('|'), wal.fact.validAt, wal.fact.isHumanConfirmed ? 1 : 0,
            wal.fact.sourceAuthority, wal.fact.confidence, wal.fact.provenance,
            wal.fact.supersedes ?? null, wal.fact.contradicts ?? null, wal.fact.extends ?? null,
            wal.fact.sourcePath, wal.fact.contentHash,
          )
        }
        const eventJson = stableJson(audit)
        const existingAudit = updateAuditRow(audit.eventId)
        if (existingAudit) {
          if (!isDeepStrictEqual(updateOutboxEvent(existingAudit), audit) ||
            existingAudit.event_json !== eventJson) {
            throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
          }
        } else {
          ledger.prepare(`
            INSERT INTO memory_update_audit_outbox (event_id, event_json, event_hash, delivered)
            VALUES (?, ?, ?, 0)
          `).run(audit.eventId, eventJson, sha256(eventJson))
        }
      })()
      input.faultAt?.('after-pending-update')
    },

    async swapUpdateLedger(rawWal) {
      const wal = parseProtectedMemoryUpdateWal(rawWal)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      ledger.transaction(() => {
        verifyForgetChain()
        const target = factRowById(wal.target.id)
        const replacement = factRow(wal.operationId)
        if (!target || !replacement || !factRowMatchesDeletionTarget(target, wal.target) ||
          !factRowIdentityMatches(replacement, wal.fact) ||
          (target.invalid_at !== null && target.invalid_at !== wal.supersededAt) ||
          (replacement.published !== 0 && replacement.published !== 1) ||
          ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
            .get(wal.fact.factKey)) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        if (target.invalid_at === null) {
          ledger.prepare('UPDATE facts SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
            .run(wal.supersededAt, wal.target.id)
        }
        if (replacement.published === 0) {
          ledger.prepare('UPDATE facts SET published = 1 WHERE operation_id = ? AND published = 0')
            .run(wal.operationId)
        }
      })()
      input.faultAt?.('after-update-ledger-swap')
    },

    async swapUpdateKeywordProjection(rawWal) {
      verifyForgetChain()
      const wal = parseProtectedMemoryUpdateWal(rawWal)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      keyword.transaction(() => {
        const previous = keywordRow(wal.target.operationId)
        if (previous) {
          if (previous.fact_id !== wal.target.id || previous.fact_key !== wal.target.factKey ||
            previous.source_path !== wal.target.sourcePath ||
            previous.content_hash !== wal.target.contentHash) {
            throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
          }
          keyword.prepare('DELETE FROM keyword_fts WHERE rowid = ?').run(previous.rowid)
          keyword.prepare('DELETE FROM keyword_metadata WHERE rowid = ?').run(previous.rowid)
        }
        let replacement = keywordRow(wal.fact.operationId)
        if (!replacement) {
          const inserted = keyword.prepare(`
            INSERT INTO keyword_metadata (
              operation_id, fact_id, fact_key, source_path, content_hash, provenance
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            wal.fact.operationId, wal.fact.id, wal.fact.factKey, wal.fact.sourcePath,
            wal.fact.contentHash, wal.fact.provenance,
          )
          keyword.prepare('INSERT INTO keyword_fts(rowid, text) VALUES (?, ?)')
            .run(inserted.lastInsertRowid, wal.fact.text)
          replacement = keywordRow(wal.fact.operationId)
        }
        if (!replacement || replacement.fact_id !== wal.fact.id ||
          replacement.fact_key !== wal.fact.factKey ||
          replacement.source_path !== wal.fact.sourcePath ||
          replacement.content_hash !== wal.fact.contentHash ||
          replacement.provenance !== wal.fact.provenance) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
        const fts = keyword.prepare('SELECT text FROM keyword_fts WHERE rowid = ?')
          .get(replacement.rowid) as { text: string } | undefined
        if (!fts) keyword.prepare('INSERT INTO keyword_fts(rowid, text) VALUES (?, ?)')
          .run(replacement.rowid, wal.fact.text)
        else if (fts.text !== wal.fact.text) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
        }
      })()
      input.faultAt?.('after-update-keyword-swap')
    },

    async verifyUpdateState(rawWal) {
      verifyForgetChain()
      const wal = parseProtectedMemoryUpdateWal(rawWal)
      if (!wal || wal.operatorId !== input.operatorId || wal.profileId !== input.profileId ||
        !sameScope(scope, wal.scope)) return false
      const target = factRowById(wal.target.id)
      const replacement = factRow(wal.operationId)
      if (!target || !replacement || target.invalid_at !== wal.supersededAt ||
        replacement.invalid_at !== null || replacement.published !== 1 ||
        !factRowMatchesDeletionTarget(target, wal.target) ||
        !factRowIdentityMatches(replacement, wal.fact) || keywordRow(wal.target.operationId) ||
        ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
          .get(wal.fact.factKey)) return false
      return keywordProjectionMatches({ ...wal.fact, published: true })
    },

    async loadUpdatedFactByOperation(operationId) {
      verifyForgetChain()
      return publicFact(operationId)
    },

    async loadUpdateAudit(operationId) {
      verifyForgetChain()
      const row = updateAuditRow(operationId)
      return row ? updateOutboxEvent(row) : null
    },

    async deliverUpdateAuditOnce(rawEvent) {
      verifyForgetChain()
      const event = parseProtectedMemoryUpdateAuditEvent(rawEvent)
      const row = event ? updateAuditRow(event.eventId) : undefined
      if (!event || event.operatorId !== input.operatorId || event.profileId !== input.profileId ||
        !row || !isDeepStrictEqual(updateOutboxEvent(row), event)) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      if (row.delivered === 1) return
      await input.deliverUpdateAuditOnce(event)
      input.faultAt?.('after-update-audit-delivery')
      const result = ledger.prepare(`
        UPDATE memory_update_audit_outbox SET delivered = 1
        WHERE event_id = ? AND delivered = 0 AND event_hash = ?
      `).run(event.eventId, row.event_hash)
      if (result.changes !== 1 && updateAuditRow(event.eventId)?.delivered !== 1) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      input.faultAt?.('after-update-audit-mark')
    },

    async updateAuditDelivered(eventId) {
      verifyForgetChain()
      const row = updateAuditRow(eventId)
      return row !== undefined && updateOutboxEvent(row).eventId === eventId && row.delivered === 1
    },

    async deleteUpdateWal(operationId) {
      ledger.prepare('DELETE FROM memory_update_wal WHERE operation_id = ?').run(operationId)
      input.faultAt?.('after-delete-update-wal')
    },

    async verifySemanticRecord(record) {
      verifyForgetChain()
      assertNoMutationWals()
      if (record.candidate.scope !== scope.kind || record.candidate.scopeId !== scope.scopeId ||
        record.candidate.projectId !== (scope.kind === 'project' ? scope.projectId : undefined)) {
        return false
      }
      const row = factRowById(record.candidate.hitId)
      const fact = row === undefined || row.invalid_at !== null ? null : factSnapshot(row)
      return fact !== null && fact.published && fact.id === record.candidate.chunkId &&
        fact.factKey === record.factKey && fact.sourcePath === record.candidate.sourcePath &&
        fact.contentHash === record.candidate.contentHash &&
        fact.provenance === record.candidate.provenance && keywordProjectionMatches(fact) &&
        !ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1').get(fact.factKey)
    },

    async searchKeyword(query, limit) {
      verifyForgetChain()
      assertNoMutationWals()
      if (typeof query !== 'string' || Buffer.byteLength(query, 'utf8') > 16_384 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const match = (query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
        .map((token) => `"${token}"`)
        .join(' OR ')
      if (match.length === 0) return []
      const rows = keyword.prepare(`
        SELECT m.operation_id, bm25(keyword_fts) AS score
        FROM keyword_fts
        JOIN keyword_metadata m ON m.rowid = keyword_fts.rowid
        WHERE keyword_fts MATCH ?
        ORDER BY score, m.operation_id
        LIMIT ?
      `).all(match, limit) as Array<{ operation_id: string; score: number }>
      return rows.map((row) => {
        const fact = publicFact(row.operation_id)
        if (!fact || !fact.published || !Number.isFinite(row.score) ||
          ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
            .get(fact.factKey) || !keywordProjectionMatches(fact)) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
        }
        return { fact: structuredClone(fact), score: row.score }
      })
    },

    async loadLiveFactById(factId) {
      verifyForgetChain()
      assertNoMutationWals()
      const row = factRowById(factId)
      if (!row || row.published !== 1 || row.invalid_at !== null) return null
      const fact = factSnapshot(row)
      if (ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
        .get(fact.factKey) || !keywordProjectionMatches(fact)) {
        throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
      }
      return structuredClone(fact)
    },

    async listLiveFacts() {
      verifyForgetChain()
      assertNoMutationWals()
      const rows = ledger.prepare(`
        SELECT * FROM facts
        WHERE published = 1 AND invalid_at IS NULL
        ORDER BY valid_at, id
        LIMIT ?
      `).all(MAX_WAL_ROWS + 1) as FactRow[]
      if (rows.length > MAX_WAL_ROWS) throw new ProtectedMemorySqliteStoreError('LIMIT_EXCEEDED')
      return rows.map((row) => {
        const fact = factSnapshot(row)
        if (ledger.prepare('SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1')
          .get(fact.factKey) || !keywordProjectionMatches(fact)) {
          throw new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX')
        }
        return structuredClone(fact)
      })
    },

    classifyForgetCandidates(candidates: readonly ProtectedMemoryForgetCandidate[]) {
      verifyForgetChain()
      assertNoMutationWals()
      if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 4) {
        throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
      }
      const candidateTokens = new Set<string>()
      const candidateKeys: string[] = []
      for (const candidate of candidates) {
        if (!candidate || !HASH.test(candidate.factKey) || !Array.isArray(candidate.keyTokens) ||
          candidate.keyTokens.length < 1 || candidate.keyTokens.length > 256 ||
          candidate.keyTokens.some((token: string) => typeof token !== 'string' || token.length < 1 ||
            token.length > 256 || token !== token.trim() || token.includes('|')) ||
          new Set(candidate.keyTokens).size !== candidate.keyTokens.length ||
          sha256(candidate.keyTokens.join('|')) !== candidate.factKey) {
          throw new ProtectedMemorySqliteStoreError('STATE_CONFLICT')
        }
        candidateKeys.push(candidate.factKey)
        candidate.keyTokens.forEach((token: string) => candidateTokens.add(token))
      }
      const exact = ledger.prepare(
        'SELECT 1 FROM do_not_remember WHERE fact_key = ? LIMIT 1',
      )
      if (candidateKeys.some(factKey => exact.get(factKey) !== undefined)) return 'FORGOTTEN'
      const rows = ledger.prepare(
        'SELECT key_tokens FROM do_not_remember ORDER BY rowid',
      ).all() as Array<{ key_tokens: string }>
      for (const row of rows) {
        if (row.key_tokens.split('|').some(token => token.length > 0 && candidateTokens.has(token))) {
          return 'REVIEW'
        }
      }
      return 'PASS'
    },

    integrityCheck() {
      try {
        const ledgerIntegrity = ledger.pragma('integrity_check') as Array<{ integrity_check: string }>
        const keywordIntegrity = keyword.pragma('integrity_check') as Array<{ integrity_check: string }>
        if (ledgerIntegrity[0]?.integrity_check !== 'ok') return { ok: false, detail: 'LEDGER' }
        if (keywordIntegrity[0]?.integrity_check !== 'ok') return { ok: false, detail: 'KEYWORD' }
        verifyDeletionRecoveryState()
        const walRows = ledger.prepare('SELECT * FROM memory_publication_wal').all() as WalRow[]
        walRows.forEach((row) => parseWalRow(row))
        const outboxRows = ledger.prepare('SELECT * FROM audit_outbox').all() as AuditRow[]
        outboxRows.forEach(outboxEvent)
        const deletionWalRows = ledger.prepare(
          'SELECT * FROM memory_deletion_wal',
        ).all() as WalRow[]
        deletionWalRows.forEach((row) => parseDeletionWalRow(row))
        const deletionOutboxRows = ledger.prepare(
          'SELECT * FROM memory_deletion_audit_outbox',
        ).all() as AuditRow[]
        const deletionEvents = deletionOutboxRows.map(deletionOutboxEvent)
        const updateWalRows = ledger.prepare('SELECT * FROM memory_update_wal').all() as WalRow[]
        updateWalRows.forEach((row) => parseUpdateWalRow(row))
        const updateOutboxRows = ledger.prepare(
          'SELECT * FROM memory_update_audit_outbox',
        ).all() as AuditRow[]
        const updateEvents = updateOutboxRows.map(updateOutboxEvent)
        verifyForgetChain()
        verifyUpdateRecoveryState()
        const factRows = ledger.prepare(
          'SELECT * FROM facts WHERE operation_id IS NOT NULL ORDER BY operation_id',
        ).all() as FactRow[]
        for (const row of factRows) {
          if (row.operation_id === null || !HASH.test(row.operation_id)) {
            return { ok: false, detail: 'FACT' }
          }
          if (row.invalid_at === null) {
            const fact = publicFact(row.operation_id)
            if (!fact || (row.published === 1) !== fact.published ||
              (row.published === 1 && !keywordProjectionMatches(fact)) ||
              (row.published === 0 && keywordRow(row.operation_id) !== undefined)) {
              return { ok: false, detail: 'PROJECTION' }
            }
          } else {
            const fact = factSnapshot(row)
            const deletion = deletionEvents.find(
              (event) => event.targetOperationId === fact.operationId,
            )
            const update = updateEvents.find(
              (event) => event.previousOperationId === fact.operationId,
            )
            if (row.published !== 1 || keywordRow(row.operation_id) !== undefined ||
              (!deletion && !update) ||
              (deletion && (deletion.factId !== fact.id || deletion.invalidatedAt !== row.invalid_at)) ||
              (update && (update.previousFactId !== fact.id || update.supersededAt !== row.invalid_at))) {
              return { ok: false, detail: 'TOMBSTONE' }
            }
          }
        }
        const metadataRows = keyword.prepare(
          'SELECT * FROM keyword_metadata ORDER BY operation_id',
        ).all() as KeywordRow[]
        for (const metadata of metadataRows) {
          const row = factRow(metadata.operation_id)
          if (!row || row.published !== 1 || row.invalid_at !== null) {
            return { ok: false, detail: 'ORPHAN_KEYWORD' }
          }
        }
        for (const row of outboxRows) {
          const event = outboxEvent(row)
          const rawFact = factRow(event.operationId)
          const fact = rawFact ? factSnapshot(rawFact) : null
          if (!fact || !auditMatchesFact(event, fact)) {
            return { ok: false, detail: 'ORPHAN_AUDIT' }
          }
        }
        for (const event of deletionEvents) {
          const rawFact = ledger.prepare('SELECT * FROM facts WHERE id = ?').get(
            event.factId,
          ) as FactRow | undefined
          const snapshot = rawFact ? factSnapshot(rawFact) : null
          if (!rawFact || !snapshot || rawFact.invalid_at !== event.invalidatedAt ||
            event.targetOperationId !== snapshot.operationId || event.factKey !== snapshot.factKey ||
            event.sourcePath !== snapshot.sourcePath || event.contentHash !== snapshot.contentHash ||
            !factRowMatchesDeletionTarget(rawFact, snapshot)) {
            return { ok: false, detail: 'ORPHAN_DELETION_AUDIT' }
          }
        }
        for (const event of updateEvents) {
          if (updateWalRows.some((row) => row.operation_id === event.operationId)) continue
          const target = factRowById(event.previousFactId)
          const replacement = factRow(event.operationId)
          const targetSnapshot = target ? factSnapshot(target) : null
          const replacementSnapshot = replacement ? factSnapshot(replacement) : null
          const downstreamDeletion = deletionEvents.find(
            (candidate) => candidate.targetOperationId === event.operationId,
          )
          const downstreamUpdate = updateEvents.find(
            (candidate) => candidate.previousOperationId === event.operationId,
          )
          const replacementRetired = replacement?.invalid_at !== null &&
            ((downstreamDeletion !== undefined &&
              downstreamDeletion.factId === replacement?.id &&
              downstreamDeletion.factKey === replacement?.fact_key &&
              downstreamDeletion.invalidatedAt === replacement?.invalid_at) ||
            (downstreamUpdate !== undefined &&
              downstreamUpdate.previousFactId === replacement?.id &&
              downstreamUpdate.previousFactKey === replacement?.fact_key &&
              downstreamUpdate.supersededAt === replacement?.invalid_at))
          const replacementProjectionValid = replacement?.invalid_at === null
            ? replacementSnapshot !== null && keywordProjectionMatches(replacementSnapshot)
            : replacementRetired && keywordRow(event.operationId) === undefined
          if (!target || !replacement || target.invalid_at !== event.supersededAt ||
            replacement.published !== 1 ||
            targetSnapshot?.operationId !== event.previousOperationId || replacement.id !== event.factId ||
            replacement.fact_key !== event.factKey || replacement.source_path !== event.sourcePath ||
            replacement.content_hash !== event.contentHash || !replacementProjectionValid) {
            return { ok: false, detail: 'ORPHAN_UPDATE_AUDIT' }
          }
        }
        return { ok: true }
      } catch {
        return { ok: false, detail: 'ROWSET' }
      }
    },

    close() {
      ledger.close()
      keyword.close()
    },
  })
}

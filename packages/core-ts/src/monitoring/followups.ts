import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { resolvedWorkBinding, type ResolvedWorkBinding } from '../runtime/work-binding.js'
import { MonitoringError } from './errors.js'
import type {
  DigestItem,
  MonitoringActionProposalV1,
  MonitoringFollowupActionFamily,
  MonitoringFollowupApprovalConsumer,
  MonitoringFollowupApprovalProof,
  MonitoringFollowupApprovalReceipt,
  MonitoringFollowupCode,
  MonitoringFollowupEngine,
  MonitoringFollowupEvidenceRef,
  MonitoringFollowupExecutionOutcome,
  MonitoringFollowupExecutionReceipt,
  MonitoringFollowupRollbackReceipt,
  MonitoringFollowupRollbackVerificationReceipt,
  MonitoringFollowupStatus,
  MonitoringFollowupVerificationReceipt,
  MonitoringStore,
} from './types.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_BATCH = 100
const MAX_EVIDENCE = 32
const MAX_PARAMETERS_BYTES = 64 * 1024
const FOLLOWUP_STATUSES = new Set<MonitoringFollowupStatus>([
  'proposed', 'awaiting-approval', 'approved', 'paused', 'executing', 'verifying',
  'rollback-pending', 'verified', 'rejected', 'expired', 'blocked', 'rolled-back',
  'reconciliation-required', 'rollback-failed', 'quarantined',
])
const FOLLOWUP_CODES = new Set<MonitoringFollowupCode>([
  'FOLLOWUP_BINDING_UNAVAILABLE', 'FOLLOWUP_EVIDENCE_MISMATCH',
  'FOLLOWUP_APPROVAL_INVALID', 'FOLLOWUP_PRECONDITION_FAILED',
  'FOLLOWUP_EXECUTION_FAILED', 'FOLLOWUP_RECEIPT_MISSING',
  'FOLLOWUP_VERIFICATION_FAILED', 'FOLLOWUP_RECONCILIATION_REQUIRED',
  'FOLLOWUP_ROLLBACK_FAILED', 'FOLLOWUP_QUARANTINED',
])

interface FollowupRow {
  id: string
  schema_version: number
  binding_json: string
  digest_id: string
  evidence_json: string
  evidence_snapshot_hash: string
  action_kind: string
  parameters_json: string
  action_hash: string
  idempotency_key: string
  tier: number
  summary: string
  created_at: string
  expires_at: string
  status: string
  paused_from: string | null
  proposal_delivery_receipt: string | null
  approval_json: string | null
  execution_receipt_json: string | null
  verification_receipt_json: string | null
  rollback_receipt_json: string | null
  rollback_verification_receipt_json: string | null
  last_code: string | null
  claim_token: string | null
  claim_until: string | null
  attempts: number
  revision: number
}

function iso(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new MonitoringError('FOLLOWUP_INVALID')
  return new Date(milliseconds).toISOString()
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new MonitoringError('FOLLOWUP_INVALID')
  const clean = value.trim()
  if (clean.length === 0 || clean.length > max) throw new MonitoringError('FOLLOWUP_INVALID')
  return clean
}

function canonicalValue(value: unknown, depth = 0): string {
  if (depth > 16) throw new MonitoringError('FOLLOWUP_INVALID')
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MonitoringError('FOLLOWUP_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalValue(item, depth + 1)).join(',')}]`
  }
  if (typeof value !== 'object') throw new MonitoringError('FOLLOWUP_INVALID')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalValue(record[key], depth + 1)}`).join(',')}}`
}

function canonicalRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const encoded = canonicalValue(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PARAMETERS_BYTES) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return deepFreeze(JSON.parse(encoded) as Record<string, unknown>)
}

function hash(domain: string, value: unknown): string {
  return createHash('sha256').update(`${domain}\u0000${canonicalValue(value)}`).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function routeKey(binding: ResolvedWorkBinding): string {
  const clean = resolvedWorkBinding(binding)
  return [clean.operatorId, clean.profileId, clean.projectId, clean.scope,
    clean.scope === 'session' ? clean.sessionId : ''].join('\u0000')
}

function sameRoute(a: ResolvedWorkBinding, b: ResolvedWorkBinding): boolean {
  return routeKey(a) === routeKey(b)
}

function validEvidenceRef(value: unknown): value is MonitoringFollowupEvidenceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return ID.test(String(record['evidenceId'])) && ID.test(String(record['sourceId'])) &&
    typeof record['primaryUrl'] === 'string' && record['primaryUrl'].length > 0
}

function approvalProofFrom(value: unknown): MonitoringFollowupApprovalProof {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const item = value as Record<string, unknown>
  if (item['schemaVersion'] !== 1 || !ID.test(String(item['proposalId'])) ||
    !HASH.test(String(item['actionHash'])) || !ID.test(String(item['cardId'])) ||
    !ID.test(String(item['challengeId'])) || typeof item['token'] !== 'string' ||
    item['token'].length === 0 || item['token'].length > 4096) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return {
    schemaVersion: 1,
    proposalId: String(item['proposalId']),
    actionHash: String(item['actionHash']),
    cardId: String(item['cardId']),
    challengeId: String(item['challengeId']),
    token: item['token'],
  }
}

function approvalReceiptFrom(value: unknown): MonitoringFollowupApprovalReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const item = value as Record<string, unknown>
  if (item['schemaVersion'] !== 1 || !ID.test(String(item['proposalId'])) ||
    !HASH.test(String(item['actionHash'])) || !ID.test(String(item['cardId'])) ||
    !ID.test(String(item['challengeId'])) || item['provenance'] !== 'gateway-issued' ||
    typeof item['stepUpVerified'] !== 'boolean') throw new MonitoringError('FOLLOWUP_INVALID')
  return {
    schemaVersion: 1,
    proposalId: String(item['proposalId']),
    actionHash: String(item['actionHash']),
    cardId: String(item['cardId']),
    challengeId: String(item['challengeId']),
    confirmedAt: iso(item['confirmedAt']),
    provenance: 'gateway-issued',
    stepUpVerified: item['stepUpVerified'],
  }
}

function executionReceiptFrom(value: unknown): MonitoringFollowupExecutionReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const item = value as Record<string, unknown>
  if (item['schemaVersion'] !== 1 || !ID.test(String(item['proposalId'])) ||
    !HASH.test(String(item['actionHash'])) || typeof item['idempotencyKey'] !== 'string' ||
    item['idempotencyKey'].length === 0 || item['idempotencyKey'].length > 1024 ||
    !ID.test(String(item['receiptId']))) throw new MonitoringError('FOLLOWUP_INVALID')
  return {
    schemaVersion: 1, proposalId: String(item['proposalId']), actionHash: String(item['actionHash']),
    idempotencyKey: String(item['idempotencyKey']), receiptId: String(item['receiptId']),
    occurredAt: iso(item['occurredAt']),
  }
}

function verificationReceiptFrom(value: unknown): MonitoringFollowupVerificationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const item = value as Record<string, unknown>
  if (item['schemaVersion'] !== 1 || !ID.test(String(item['proposalId'])) ||
    !HASH.test(String(item['actionHash'])) || !ID.test(String(item['executionReceiptId'])) ||
    !HASH.test(String(item['probeHash'])) || typeof item['verified'] !== 'boolean') {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return {
    schemaVersion: 1, proposalId: String(item['proposalId']), actionHash: String(item['actionHash']),
    executionReceiptId: String(item['executionReceiptId']), probeHash: String(item['probeHash']),
    verified: item['verified'], verifiedAt: iso(item['verifiedAt']),
  }
}

function rollbackReceiptFrom(value: unknown): MonitoringFollowupRollbackReceipt {
  const receipt = executionReceiptFrom(value)
  return receipt
}

function rollbackVerificationFrom(value: unknown): MonitoringFollowupRollbackVerificationReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const item = value as Record<string, unknown>
  if (item['schemaVersion'] !== 1 || !ID.test(String(item['proposalId'])) ||
    !HASH.test(String(item['actionHash'])) || !ID.test(String(item['rollbackReceiptId'])) ||
    !HASH.test(String(item['probeHash'])) || typeof item['rolledBack'] !== 'boolean') {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return {
    schemaVersion: 1, proposalId: String(item['proposalId']), actionHash: String(item['actionHash']),
    rollbackReceiptId: String(item['rollbackReceiptId']), probeHash: String(item['probeHash']),
    rolledBack: item['rolledBack'], verifiedAt: iso(item['verifiedAt']),
  }
}

function parseOptional<T>(value: string | null, parse: (raw: unknown) => T): T | undefined {
  return value === null ? undefined : parse(JSON.parse(value) as unknown)
}

function proposalFromRow(row: FollowupRow): MonitoringActionProposalV1 {
  if (row.schema_version !== 1 || !ID.test(row.id) || !ID.test(row.digest_id) ||
    !ID.test(row.action_kind) || !HASH.test(row.evidence_snapshot_hash) ||
    !HASH.test(row.action_hash) || (row.tier !== 1 && row.tier !== 2 && row.tier !== 3) ||
    !FOLLOWUP_STATUSES.has(row.status as MonitoringFollowupStatus) ||
    !Number.isSafeInteger(row.attempts) || row.attempts < 0 ||
    !Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const evidence = JSON.parse(row.evidence_json) as unknown
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_EVIDENCE ||
    !evidence.every(validEvidenceRef)) throw new MonitoringError('FOLLOWUP_INVALID')
  const status = row.status as MonitoringFollowupStatus
  const pausedFrom = row.paused_from
  if (pausedFrom !== null && pausedFrom !== 'proposed' && pausedFrom !== 'awaiting-approval' &&
    pausedFrom !== 'approved') throw new MonitoringError('FOLLOWUP_INVALID')
  if ((status === 'paused') !== (pausedFrom !== null)) throw new MonitoringError('FOLLOWUP_INVALID')
  const lastCode = row.last_code
  if (lastCode !== null && !FOLLOWUP_CODES.has(lastCode as MonitoringFollowupCode)) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return cloneFrozen({
    schemaVersion: 1 as const,
    id: row.id,
    binding: resolvedWorkBinding(JSON.parse(row.binding_json) as unknown),
    digestId: row.digest_id,
    evidence: evidence as MonitoringFollowupEvidenceRef[],
    evidenceSnapshotHash: row.evidence_snapshot_hash,
    actionKind: row.action_kind,
    parameters: canonicalRecord(JSON.parse(row.parameters_json) as unknown),
    actionHash: row.action_hash,
    idempotencyKey: row.idempotency_key,
    tier: row.tier,
    summary: boundedString(row.summary, 1000),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    status,
    ...(pausedFrom === null ? {} : { pausedFrom }),
    ...(row.proposal_delivery_receipt === null ? {} : {
      proposalDeliveryReceipt: boundedString(row.proposal_delivery_receipt, 1000),
    }),
    ...(row.approval_json === null ? {} : {
      approval: parseOptional(row.approval_json, approvalReceiptFrom)!,
    }),
    ...(row.execution_receipt_json === null ? {} : {
      executionReceipt: parseOptional(row.execution_receipt_json, executionReceiptFrom)!,
    }),
    ...(row.verification_receipt_json === null ? {} : {
      verificationReceipt: parseOptional(row.verification_receipt_json, verificationReceiptFrom)!,
    }),
    ...(row.rollback_receipt_json === null ? {} : {
      rollbackReceipt: parseOptional(row.rollback_receipt_json, rollbackReceiptFrom)!,
    }),
    ...(row.rollback_verification_receipt_json === null ? {} : {
      rollbackVerificationReceipt: parseOptional(
        row.rollback_verification_receipt_json, rollbackVerificationFrom,
      )!,
    }),
    ...(lastCode === null ? {} : { lastCode: lastCode as MonitoringFollowupCode }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.claim_until === null ? {} : { claimUntil: iso(row.claim_until) }),
    attempts: row.attempts,
    revision: row.revision,
  })
}

function evidenceSnapshot(
  digestId: string,
  binding: ResolvedWorkBinding,
  selected: readonly DigestItem[],
): string {
  return hash('monitoring-followup-evidence-v1', {
    digestId,
    binding,
    items: [...selected].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
  })
}

function actionAuthorityHash(input: {
  binding: ResolvedWorkBinding
  digestId: string
  evidenceSnapshotHash: string
  actionKind: string
  parameters: Readonly<Record<string, unknown>>
  tier: 1 | 2 | 3
}): string {
  return hash('monitoring-followup-action-v1', input)
}

function actionIdempotencyKey(id: string, actionHash: string): string {
  return `monitoring-followup:${id}:${actionHash}`
}

function validBatch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  return value
}

function validExecutionReceipt(
  raw: unknown,
  proposal: MonitoringActionProposalV1,
): MonitoringFollowupExecutionReceipt | null {
  if (raw === null) return null
  try {
    const receipt = executionReceiptFrom(raw)
    return receipt.proposalId === proposal.id && receipt.actionHash === proposal.actionHash &&
      receipt.idempotencyKey === proposal.idempotencyKey ? receipt : null
  } catch {
    return null
  }
}

function validVerificationReceipt(
  raw: unknown,
  proposal: MonitoringActionProposalV1,
  receipt: MonitoringFollowupExecutionReceipt,
): MonitoringFollowupVerificationReceipt | null {
  try {
    const verification = verificationReceiptFrom(raw)
    return verification.proposalId === proposal.id && verification.actionHash === proposal.actionHash &&
      verification.executionReceiptId === receipt.receiptId ? verification : null
  } catch {
    return null
  }
}

function validRollbackReceipt(
  raw: unknown,
  proposal: MonitoringActionProposalV1,
  key: string,
): MonitoringFollowupRollbackReceipt | null {
  if (raw === null) return null
  try {
    const receipt = rollbackReceiptFrom(raw)
    return receipt.proposalId === proposal.id && receipt.actionHash === proposal.actionHash &&
      receipt.idempotencyKey === key ? receipt : null
  } catch {
    return null
  }
}

export function makeMonitoringFollowupEngine(input: {
  dbPath: string
  monitoring: Pick<MonitoringStore, 'getDigest'>
  actions?: ReadonlyMap<string, MonitoringFollowupActionFamily>
  approvalConsumer: MonitoringFollowupApprovalConsumer
  resolveBinding(binding: ResolvedWorkBinding): void
  nowIso?: () => string
  newId?: () => string
  newClaimToken?: () => string
  claimMs?: number
}): MonitoringFollowupEngine {
  const actions = new Map(input.actions ?? [])
  for (const [kind, action] of actions) {
    if (!ID.test(kind) || action.kind !== kind ||
      (action.tier !== 1 && action.tier !== 2 && action.tier !== 3)) {
      throw new MonitoringError('FOLLOWUP_INVALID')
    }
  }
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const newId = input.newId ?? randomUUID
  const newClaimToken = input.newClaimToken ?? randomUUID
  const claimMs = input.claimMs ?? 30_000
  if (!Number.isSafeInteger(claimMs) || claimMs < 1 || claimMs > 300_000) {
    throw new MonitoringError('FOLLOWUP_INVALID')
  }
  const db = new Database(input.dbPath)
  db.pragma('foreign_keys = ON')
  const schemaVersion = db.pragma('user_version', { simple: true }) as number
  // v3 only adds exact-domain authority to monitoring_sources; follow-up
  // rows and their authority schema remain unchanged and compatible with v2.
  if (schemaVersion !== 2 && schemaVersion !== 3) {
    db.close()
    throw new MonitoringError('SCHEMA_UNSUPPORTED')
  }

  const row = (id: string): FollowupRow | undefined =>
    db.prepare('SELECT * FROM monitoring_followups WHERE id=?').get(id) as FollowupRow | undefined
  const quarantine = (id: string): void => {
    db.prepare(`UPDATE monitoring_followups SET status='quarantined',
      last_code='FOLLOWUP_QUARANTINED', claim_token=NULL, claim_until=NULL, revision=revision+1
      WHERE id=?`).run(id)
  }
  const safe = (candidate: FollowupRow): MonitoringActionProposalV1 | null => {
    try { return proposalFromRow(candidate) } catch { quarantine(candidate.id); return null }
  }
  const get = (id: string): MonitoringActionProposalV1 | null => {
    const candidate = row(id)
    return candidate === undefined ? null : safe(candidate)
  }
  const requireProposal = (id: string): MonitoringActionProposalV1 => {
    const proposal = get(id)
    if (proposal === null) throw new MonitoringError('FOLLOWUP_NOT_FOUND')
    return proposal
  }
  const bindingAvailable = (binding: ResolvedWorkBinding): boolean => {
    try { input.resolveBinding(resolvedWorkBinding(binding)); return true } catch { return false }
  }
  const authorityValid = (proposal: MonitoringActionProposalV1): boolean => {
    try {
      const expectedActionHash = actionAuthorityHash({
        binding: proposal.binding,
        digestId: proposal.digestId,
        evidenceSnapshotHash: proposal.evidenceSnapshotHash,
        actionKind: proposal.actionKind,
        parameters: proposal.parameters,
        tier: proposal.tier,
      })
      if (proposal.actionHash !== expectedActionHash ||
        proposal.idempotencyKey !== actionIdempotencyKey(proposal.id, expectedActionHash)) return false
      const digest = input.monitoring.getDigest(proposal.digestId)
      if (digest === null || !sameRoute(proposal.binding, digest.binding)) return false
      const selected = proposal.evidence.map(ref => digest.items.find(item =>
        item.evidenceId === ref.evidenceId && item.sourceId === ref.sourceId &&
        item.primaryUrl === ref.primaryUrl,
      )).filter((item): item is DigestItem => item !== undefined)
      return selected.length === proposal.evidence.length &&
        evidenceSnapshot(digest.id, proposal.binding, selected) === proposal.evidenceSnapshotHash &&
        actions.get(proposal.actionKind)?.tier === proposal.tier
    } catch {
      return false
    }
  }
  const approvalValid = (proposal: MonitoringActionProposalV1, now: string): boolean => {
    const approval = proposal.approval
    if (!(approval !== undefined && approval.schemaVersion === 1 &&
      approval.provenance === 'gateway-issued' && approval.proposalId === proposal.id &&
      approval.actionHash === proposal.actionHash &&
      (proposal.tier !== 3 || approval.stepUpVerified) &&
      Date.parse(approval.confirmedAt) >= Date.parse(proposal.createdAt) &&
      Date.parse(approval.confirmedAt) <= Date.parse(now) &&
      Date.parse(approval.confirmedAt) < Date.parse(proposal.expiresAt))) return false
    try {
      return input.approvalConsumer.validate({
        receipt: approval,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        tier: proposal.tier,
      })
    } catch {
      return false
    }
  }
  const updateSimple = (
    id: string,
    from: readonly MonitoringFollowupStatus[],
    to: MonitoringFollowupStatus,
    code: MonitoringFollowupCode | null,
    claimToken?: string,
  ): boolean => {
    const placeholders = from.map(() => '?').join(',')
    const sql = `UPDATE monitoring_followups SET status=?, last_code=?, claim_token=NULL,
      claim_until=NULL, revision=revision+1 WHERE id=? AND status IN (${placeholders})${
      claimToken === undefined ? '' : ' AND claim_token=?'}`
    const values: unknown[] = [to, code, id, ...from]
    if (claimToken !== undefined) values.push(claimToken)
    return db.prepare(sql).run(...values).changes === 1
  }
  const outcome = (
    proposalId: string,
    status: MonitoringFollowupExecutionOutcome['status'],
    code?: MonitoringFollowupCode,
  ): MonitoringFollowupExecutionOutcome => Object.freeze({ proposalId, status, ...(code ? { code } : {}) })

  const pause = (proposal: MonitoringActionProposalV1): void => {
    const from = proposal.status === 'proposed' || proposal.status === 'awaiting-approval' ||
      proposal.status === 'approved' ? proposal.status : null
    if (from === null) {
      updateSimple(proposal.id, [proposal.status], 'reconciliation-required',
        'FOLLOWUP_BINDING_UNAVAILABLE', proposal.claimToken)
      return
    }
    db.prepare(`UPDATE monitoring_followups SET status='paused', paused_from=?,
      last_code='FOLLOWUP_BINDING_UNAVAILABLE', claim_token=NULL, claim_until=NULL,
      revision=revision+1 WHERE id=? AND status=?`).run(from, proposal.id, from)
  }

  const pauseClaimedApproval = (proposal: MonitoringActionProposalV1): void => {
    const info = db.prepare(`UPDATE monitoring_followups SET status='paused', paused_from='approved',
      last_code='FOLLOWUP_BINDING_UNAVAILABLE', claim_token=NULL, claim_until=NULL,
      revision=revision+1 WHERE id=? AND status='executing' AND claim_token=?`).run(
      proposal.id, proposal.claimToken,
    )
    if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
  }

  const claim = (id: string): { proposal: MonitoringActionProposalV1; prior: MonitoringFollowupStatus } | null => {
    const now = iso(nowIso())
    const token = boundedString(newClaimToken(), 256)
    const until = new Date(Date.parse(now) + claimMs).toISOString()
    return db.transaction(() => {
      const current = get(id)
      if (current === null) return null
      const prior = current.status
      if (prior !== 'approved' && prior !== 'executing' && prior !== 'verifying' &&
        prior !== 'rollback-pending') return null
      if (prior === 'approved' && Date.parse(current.expiresAt) <= Date.parse(now)) {
        updateSimple(id, ['approved'], 'expired', null)
        return null
      }
      if (prior !== 'approved' && current.claimUntil !== undefined && current.claimUntil > now) return null
      const nextStatus = prior === 'approved' ? 'executing' : prior
      const info = db.prepare(`UPDATE monitoring_followups SET status=?, claim_token=?, claim_until=?,
        attempts=attempts+?, revision=revision+1 WHERE id=? AND revision=?`).run(
        nextStatus, token, until, prior === 'approved' ? 1 : 0, id, current.revision,
      )
      if (info.changes !== 1) return null
      const claimed = get(id)
      return claimed === null ? null : { proposal: claimed, prior }
    })()
  }

  const saveExecutionReceipt = (
    proposal: MonitoringActionProposalV1,
    receipt: MonitoringFollowupExecutionReceipt,
  ): MonitoringActionProposalV1 => {
    const info = db.prepare(`UPDATE monitoring_followups SET status='verifying', execution_receipt_json=?,
      last_code=NULL, revision=revision+1 WHERE id=? AND status='executing' AND claim_token=?`).run(
      JSON.stringify(receipt), proposal.id, proposal.claimToken,
    )
    if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
    return requireProposal(proposal.id)
  }

  const finishVerification = (
    proposal: MonitoringActionProposalV1,
    receipt: MonitoringFollowupVerificationReceipt,
  ): MonitoringActionProposalV1 => {
    const status = receipt.verified ? 'verified' : 'rollback-pending'
    const info = db.prepare(`UPDATE monitoring_followups SET status=?, verification_receipt_json=?,
      last_code=?, claim_token=NULL, claim_until=NULL, revision=revision+1
      WHERE id=? AND status='verifying' AND claim_token=?`).run(
      status, JSON.stringify(receipt), receipt.verified ? null : 'FOLLOWUP_VERIFICATION_FAILED',
      proposal.id, proposal.claimToken,
    )
    if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
    return requireProposal(proposal.id)
  }

  const finishRollback = (
    proposal: MonitoringActionProposalV1,
    receipt: MonitoringFollowupRollbackReceipt,
    verification: MonitoringFollowupRollbackVerificationReceipt,
  ): MonitoringActionProposalV1 => {
    const status = verification.rolledBack ? 'rolled-back' : 'rollback-failed'
    const info = db.prepare(`UPDATE monitoring_followups SET status=?, rollback_receipt_json=?,
      rollback_verification_receipt_json=?, last_code=?, claim_token=NULL, claim_until=NULL,
      revision=revision+1 WHERE id=? AND status='rollback-pending' AND claim_token=?`).run(
      status, JSON.stringify(receipt), JSON.stringify(verification),
      verification.rolledBack ? 'FOLLOWUP_VERIFICATION_FAILED' : 'FOLLOWUP_ROLLBACK_FAILED',
      proposal.id, proposal.claimToken,
    )
    if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
    return requireProposal(proposal.id)
  }

  const rollback = async (
    proposal: MonitoringActionProposalV1,
    family: MonitoringFollowupActionFamily,
    recovery: boolean,
  ): Promise<MonitoringFollowupExecutionOutcome> => {
    const execution = proposal.executionReceipt
    const rollbackKey = `${proposal.idempotencyKey}:rollback`
    if (execution === undefined || family.rollback === undefined ||
      family.verifyRollback === undefined || family.recoverRollbackReceipt === undefined) {
      updateSimple(proposal.id, ['rollback-pending'], 'reconciliation-required',
        'FOLLOWUP_RECONCILIATION_REQUIRED', proposal.claimToken)
      return outcome(proposal.id, 'reconciliation-required', 'FOLLOWUP_RECONCILIATION_REQUIRED')
    }
    const deferRecovery = (): MonitoringFollowupExecutionOutcome => {
      const info = db.prepare(`UPDATE monitoring_followups SET last_code='FOLLOWUP_RECONCILIATION_REQUIRED',
        claim_token=NULL, claim_until=NULL, revision=revision+1
        WHERE id=? AND status='rollback-pending' AND claim_token=?`).run(
        proposal.id, proposal.claimToken,
      )
      if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      return outcome(proposal.id, 'rollback-pending', 'FOLLOWUP_RECONCILIATION_REQUIRED')
    }
    let raw: MonitoringFollowupRollbackReceipt | null
    try {
      raw = recovery
        ? await family.recoverRollbackReceipt({ proposal, idempotencyKey: rollbackKey })
        : await family.rollback({ proposal, receipt: execution, idempotencyKey: rollbackKey })
    } catch {
      raw = null
    }
    const receipt = validRollbackReceipt(raw, proposal, rollbackKey)
    if (receipt === null) return deferRecovery()
    let checked: MonitoringFollowupRollbackVerificationReceipt | null = null
    try {
      const candidate = rollbackVerificationFrom(await family.verifyRollback({ proposal, receipt }))
      checked = candidate.proposalId === proposal.id && candidate.actionHash === proposal.actionHash &&
        candidate.rollbackReceiptId === receipt.receiptId ? candidate : null
    } catch { /* stable failure below */ }
    if (checked === null) return deferRecovery()
    const finished = finishRollback(proposal, receipt, checked)
    return outcome(proposal.id, finished.status,
      finished.status === 'rolled-back' ? 'FOLLOWUP_VERIFICATION_FAILED' : 'FOLLOWUP_ROLLBACK_FAILED')
  }

  const verify = async (
    proposal: MonitoringActionProposalV1,
    family: MonitoringFollowupActionFamily,
  ): Promise<MonitoringFollowupExecutionOutcome> => {
    const receipt = proposal.executionReceipt
    if (receipt === undefined) {
      updateSimple(proposal.id, ['verifying'], 'reconciliation-required',
        'FOLLOWUP_RECONCILIATION_REQUIRED', proposal.claimToken)
      return outcome(proposal.id, 'reconciliation-required', 'FOLLOWUP_RECONCILIATION_REQUIRED')
    }
    let checked: MonitoringFollowupVerificationReceipt | null = null
    try { checked = validVerificationReceipt(await family.verify({ proposal, receipt }), proposal, receipt) } catch {
      // Verification is read-only and may be retried after the claim lease expires.
    }
    if (checked === null) {
      db.prepare(`UPDATE monitoring_followups SET last_code='FOLLOWUP_VERIFICATION_FAILED',
        claim_token=NULL, claim_until=NULL, revision=revision+1
        WHERE id=? AND status='verifying' AND claim_token=?`).run(proposal.id, proposal.claimToken)
      return outcome(proposal.id, 'verifying', 'FOLLOWUP_VERIFICATION_FAILED')
    }
    const finished = finishVerification(proposal, checked)
    if (finished.status === 'verified') return outcome(proposal.id, 'verified')
    const rollbackClaim = claim(proposal.id)
    if (rollbackClaim === null) {
      return outcome(proposal.id, 'rollback-pending', 'FOLLOWUP_VERIFICATION_FAILED')
    }
    return rollback(rollbackClaim.proposal, family, false)
  }

  return Object.freeze({
    propose(candidate) {
      const action = actions.get(candidate.actionKind)
      if (action === undefined) throw new MonitoringError('FOLLOWUP_INVALID')
      const binding = resolvedWorkBinding(candidate.binding)
      if (!bindingAvailable(binding)) throw new MonitoringError('FOLLOWUP_BINDING_UNAVAILABLE')
      let digest
      try { digest = input.monitoring.getDigest(candidate.digestId) } catch {
        throw new MonitoringError('FOLLOWUP_EVIDENCE_MISMATCH')
      }
      if (digest === null || !sameRoute(binding, digest.binding) ||
        digest.status === 'paused' || digest.status === 'quarantined' || digest.status === 'expired') {
        throw new MonitoringError('FOLLOWUP_EVIDENCE_MISMATCH')
      }
      const evidenceIds = [...new Set(candidate.evidenceIds)].sort()
      if (evidenceIds.length === 0 || evidenceIds.length > MAX_EVIDENCE ||
        evidenceIds.some(id => !ID.test(id))) throw new MonitoringError('FOLLOWUP_INVALID')
      const selected = evidenceIds.map(id => digest.items.find(item => item.evidenceId === id))
      if (selected.some(item => item === undefined)) throw new MonitoringError('FOLLOWUP_EVIDENCE_MISMATCH')
      const selectedItems = selected as DigestItem[]
      let parameters: Readonly<Record<string, unknown>>
      try { parameters = canonicalRecord(action.validateParameters(candidate.parameters)) } catch {
        throw new MonitoringError('FOLLOWUP_INVALID')
      }
      const summary = boundedString(candidate.summary, 1000)
      const createdAt = iso(nowIso())
      const expiresAt = iso(candidate.expiresAt)
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new MonitoringError('FOLLOWUP_INVALID')
      const id = boundedString(newId(), 256)
      if (!ID.test(id)) throw new MonitoringError('FOLLOWUP_INVALID')
      const evidence: MonitoringFollowupEvidenceRef[] = selectedItems.map(item => ({
        evidenceId: item.evidenceId, sourceId: item.sourceId, primaryUrl: item.primaryUrl,
      }))
      const snapshotHash = evidenceSnapshot(digest.id, binding, selectedItems)
      const actionHash = actionAuthorityHash({
        binding, digestId: digest.id, evidenceSnapshotHash: snapshotHash,
        actionKind: action.kind, parameters, tier: action.tier,
      })
      const proposal: MonitoringActionProposalV1 = cloneFrozen({
        schemaVersion: 1 as const, id, binding, digestId: digest.id, evidence,
        evidenceSnapshotHash: snapshotHash, actionKind: action.kind, parameters,
        actionHash, idempotencyKey: actionIdempotencyKey(id, actionHash),
        tier: action.tier, summary, createdAt, expiresAt, status: 'proposed' as const,
        attempts: 0, revision: 0,
      })
      db.prepare(`INSERT OR IGNORE INTO monitoring_followups
        (id,schema_version,binding_json,route_key,digest_id,evidence_json,evidence_snapshot_hash,
         action_kind,parameters_json,action_hash,idempotency_key,tier,summary,created_at,expires_at,
         status,attempts,revision) VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',0,0)`).run(
        proposal.id, JSON.stringify(binding), routeKey(binding), proposal.digestId,
        JSON.stringify(proposal.evidence), proposal.evidenceSnapshotHash, proposal.actionKind,
        canonicalValue(proposal.parameters), proposal.actionHash, proposal.idempotencyKey,
        proposal.tier, proposal.summary, proposal.createdAt, proposal.expiresAt,
      )
      const stored = db.prepare('SELECT * FROM monitoring_followups WHERE route_key=? AND action_hash=?')
        .get(routeKey(binding), actionHash) as FollowupRow | undefined
      if (stored === undefined) throw new MonitoringError('FOLLOWUP_INVALID')
      const result = safe(stored)
      if (result === null) throw new MonitoringError('FOLLOWUP_QUARANTINED')
      return result
    },

    get,

    listForProposalDelivery(maxItems) {
      const now = iso(nowIso())
      const limit = validBatch(maxItems)
      db.prepare(`UPDATE monitoring_followups SET status='expired', claim_token=NULL,
        claim_until=NULL, revision=revision+1 WHERE status IN ('proposed','awaiting-approval','approved')
        AND expires_at<=?`).run(now)
      const rows = db.prepare(`SELECT * FROM monitoring_followups WHERE status='proposed'
        ORDER BY created_at,id LIMIT ?`).all(limit) as FollowupRow[]
      const result: MonitoringActionProposalV1[] = []
      for (const candidate of rows) {
        const proposal = safe(candidate)
        if (proposal === null) continue
        if (!authorityValid(proposal)) { quarantine(proposal.id); continue }
        if (!bindingAvailable(proposal.binding)) { pause(proposal); continue }
        result.push(proposal)
      }
      return Object.freeze(result)
    },

    recordProposalDelivery(id, actionHash, rawReceipt) {
      const receipt = boundedString(rawReceipt, 1000)
      const proposal = requireProposal(id)
      if (proposal.actionHash !== actionHash || proposal.status !== 'proposed') {
        throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      }
      if (!authorityValid(proposal)) { quarantine(id); throw new MonitoringError('FOLLOWUP_QUARANTINED') }
      if (!bindingAvailable(proposal.binding)) {
        pause(proposal)
        throw new MonitoringError('FOLLOWUP_BINDING_UNAVAILABLE')
      }
      const info = db.prepare(`UPDATE monitoring_followups SET status='awaiting-approval',
        proposal_delivery_receipt=?, revision=revision+1 WHERE id=? AND status='proposed'
        AND action_hash=?`).run(receipt, id, actionHash)
      if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      return requireProposal(id)
    },

    approve(id, rawProof) {
      const proposal = requireProposal(id)
      let proof: MonitoringFollowupApprovalProof
      try { proof = approvalProofFrom(rawProof) } catch {
        throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      }
      const now = iso(nowIso())
      if (proposal.status !== 'awaiting-approval' || proof.proposalId !== proposal.id ||
        proof.actionHash !== proposal.actionHash || Date.parse(proposal.expiresAt) <= Date.parse(now)) {
        throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      }
      if (!authorityValid(proposal)) { quarantine(id); throw new MonitoringError('FOLLOWUP_QUARANTINED') }
      if (!bindingAvailable(proposal.binding)) {
        pause(proposal)
        throw new MonitoringError('FOLLOWUP_BINDING_UNAVAILABLE')
      }
      let approval: MonitoringFollowupApprovalReceipt | null = null
      try {
        approval = input.approvalConsumer.consume({
          proof,
          proposalId: proposal.id,
          actionHash: proposal.actionHash,
          tier: proposal.tier,
        })
        if (approval !== null) approval = approvalReceiptFrom(approval)
      } catch { /* invalid or already-consumed proof */ }
      if (approval === null || approval.proposalId !== proposal.id ||
        approval.actionHash !== proposal.actionHash || approval.cardId !== proof.cardId ||
        approval.challengeId !== proof.challengeId ||
        (proposal.tier === 3 && !approval.stepUpVerified) ||
        Date.parse(approval.confirmedAt) < Date.parse(proposal.createdAt) ||
        Date.parse(approval.confirmedAt) > Date.parse(now) ||
        Date.parse(approval.confirmedAt) >= Date.parse(proposal.expiresAt)) {
        throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      }
      try {
        if (!input.approvalConsumer.validate({
          receipt: approval,
          proposalId: proposal.id,
          actionHash: proposal.actionHash,
          tier: proposal.tier,
        })) throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      } catch {
        throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      }
      const info = db.prepare(`UPDATE monitoring_followups SET status='approved', approval_json=?,
        last_code=NULL, revision=revision+1 WHERE id=? AND status='awaiting-approval'
        AND action_hash=?`).run(JSON.stringify(approval), id, proposal.actionHash)
      if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      return requireProposal(id)
    },

    reject(id, actionHash) {
      const proposal = requireProposal(id)
      if (proposal.status !== 'awaiting-approval' || proposal.actionHash !== actionHash) {
        throw new MonitoringError('FOLLOWUP_APPROVAL_INVALID')
      }
      if (!updateSimple(id, ['awaiting-approval'], 'rejected', null)) {
        throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      }
      return requireProposal(id)
    },

    resumePaused(id) {
      const proposal = requireProposal(id)
      if (proposal.status !== 'paused' || proposal.pausedFrom === undefined) {
        throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      }
      if (!authorityValid(proposal)) {
        quarantine(id)
        return requireProposal(id)
      }
      const now = iso(nowIso())
      if (Date.parse(proposal.expiresAt) <= Date.parse(now)) {
        const info = db.prepare(`UPDATE monitoring_followups SET status='expired', paused_from=NULL,
          last_code=NULL, revision=revision+1 WHERE id=? AND status='paused' AND revision=?`).run(
          id, proposal.revision,
        )
        if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
        return requireProposal(id)
      }
      if (proposal.pausedFrom === 'approved' && !approvalValid(proposal, now)) {
        quarantine(id)
        return requireProposal(id)
      }
      if (!bindingAvailable(proposal.binding)) {
        throw new MonitoringError('FOLLOWUP_BINDING_UNAVAILABLE')
      }
      const info = db.prepare(`UPDATE monitoring_followups SET status=?, paused_from=NULL,
        last_code=NULL, revision=revision+1 WHERE id=? AND status='paused' AND revision=?`).run(
        proposal.pausedFrom, id, proposal.revision,
      )
      if (info.changes !== 1) throw new MonitoringError('FOLLOWUP_STATE_CONFLICT')
      return requireProposal(id)
    },

    listExecutable(maxItems) {
      const now = iso(nowIso())
      const limit = validBatch(maxItems)
      db.prepare(`UPDATE monitoring_followups SET status='expired', revision=revision+1
        WHERE status='approved' AND expires_at<=?`).run(now)
      const rows = db.prepare(`SELECT * FROM monitoring_followups WHERE status IN
        ('approved','verifying','rollback-pending') OR
        (status='executing' AND (claim_until IS NULL OR claim_until<=?))
        ORDER BY created_at,id LIMIT ?`).all(now, limit) as FollowupRow[]
      const result: MonitoringActionProposalV1[] = []
      for (const candidate of rows) {
        const proposal = safe(candidate)
        if (proposal === null) continue
        if (!authorityValid(proposal)) { quarantine(proposal.id); continue }
        if (!bindingAvailable(proposal.binding)) { pause(proposal); continue }
        result.push(proposal)
      }
      return Object.freeze(result)
    },

    async execute(id) {
      const claimed = claim(id)
      if (claimed === null) return outcome(id, 'skipped')
      let proposal = claimed.proposal
      const family = actions.get(proposal.actionKind)
      if (family === undefined || family.tier !== proposal.tier || !authorityValid(proposal)) {
        quarantine(id)
        return outcome(id, 'quarantined', 'FOLLOWUP_QUARANTINED')
      }
      if (!bindingAvailable(proposal.binding)) {
        if (claimed.prior === 'approved') pauseClaimedApproval(proposal)
        else pause(proposal)
        return outcome(id, claimed.prior === 'approved' ? 'paused' : 'reconciliation-required',
          'FOLLOWUP_BINDING_UNAVAILABLE')
      }
      if (claimed.prior === 'approved' && !approvalValid(proposal, iso(nowIso()))) {
        quarantine(id)
        return outcome(id, 'quarantined', 'FOLLOWUP_QUARANTINED')
      }
      if (claimed.prior === 'verifying') return verify(proposal, family)
      if (claimed.prior === 'rollback-pending') return rollback(proposal, family, true)

      let executionReceipt: MonitoringFollowupExecutionReceipt | null = null
      if (claimed.prior === 'executing') {
        try {
          executionReceipt = validExecutionReceipt(await family.recoverReceipt({
            proposal, idempotencyKey: proposal.idempotencyKey,
          }), proposal)
        } catch { /* stable reconciliation below */ }
        if (executionReceipt === null) {
          updateSimple(id, ['executing'], 'reconciliation-required',
            'FOLLOWUP_RECONCILIATION_REQUIRED', proposal.claimToken)
          return outcome(id, 'reconciliation-required', 'FOLLOWUP_RECONCILIATION_REQUIRED')
        }
      } else {
        let precondition
        try { precondition = await family.precondition(proposal) } catch {
          precondition = { ok: false as const, code: 'FOLLOWUP_PRECONDITION_FAILED' as const }
        }
        if (!precondition.ok || !HASH.test(precondition.snapshotHash)) {
          updateSimple(id, ['executing'], 'blocked', 'FOLLOWUP_PRECONDITION_FAILED', proposal.claimToken)
          return outcome(id, 'blocked', 'FOLLOWUP_PRECONDITION_FAILED')
        }
        const fresh = get(id)
        if (fresh === null) {
          return outcome(id, 'quarantined', 'FOLLOWUP_QUARANTINED')
        }
        if (fresh.status !== 'executing' || fresh.claimToken !== proposal.claimToken) {
          return outcome(id, 'skipped')
        }
        proposal = fresh
        const revalidationNow = iso(nowIso())
        if (!authorityValid(proposal) || !approvalValid(proposal, revalidationNow)) {
          quarantine(id)
          return outcome(id, 'quarantined', 'FOLLOWUP_QUARANTINED')
        }
        if (Date.parse(proposal.expiresAt) <= Date.parse(revalidationNow)) {
          updateSimple(id, ['executing'], 'expired', null, proposal.claimToken)
          return outcome(id, 'expired')
        }
        if (!bindingAvailable(proposal.binding)) {
          pauseClaimedApproval(proposal)
          return outcome(id, 'paused', 'FOLLOWUP_BINDING_UNAVAILABLE')
        }
        try {
          executionReceipt = validExecutionReceipt(await family.execute({
            proposal, preconditionHash: precondition.snapshotHash,
            idempotencyKey: proposal.idempotencyKey,
          }), proposal)
        } catch {
          updateSimple(id, ['executing'], 'reconciliation-required',
            'FOLLOWUP_EXECUTION_FAILED', proposal.claimToken)
          return outcome(id, 'reconciliation-required', 'FOLLOWUP_EXECUTION_FAILED')
        }
        if (executionReceipt === null) {
          updateSimple(id, ['executing'], 'reconciliation-required',
            'FOLLOWUP_RECEIPT_MISSING', proposal.claimToken)
          return outcome(id, 'reconciliation-required', 'FOLLOWUP_RECEIPT_MISSING')
        }
      }
      proposal = saveExecutionReceipt(proposal, executionReceipt)
      return verify(proposal, family)
    },
  } satisfies MonitoringFollowupEngine)
}

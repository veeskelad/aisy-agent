import { createHash, createHmac } from 'node:crypto'
import type { PendingAction } from '../gateway/index.js'
import type { ApprovalDecision } from './hook-gate.js'
import type { TurnContextLease } from './context-lease.js'
import type { ProtectedMemoryScope } from './protected-memory-publication.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SOURCE_PATH = /^memory\/facts\/[a-f0-9]{64}\.md$/
const DEFAULT_RECEIPT_TTL_MS = 60_000
const DEFAULT_APPROVAL_MAX_AGE_MS = 15 * 60_000
const MAX_DATE_MS = 8_640_000_000_000_000

export interface MemoryPermanenceAuthorizationRequest {
  lease: TurnContextLease
  scope: ProtectedMemoryScope
  factId: string
  targetOperationId: string
  factKey: string
  sourcePath: string
  contentHash: string
  reason: string
}

export interface MemoryPermanenceNonceRecord {
  receiptId: string
  mac: string
  expiresAt: string
}

export interface MemoryPermanenceNonceStore {
  issue(record: MemoryPermanenceNonceRecord): void
  consume(receiptId: string, mac: string): boolean
}

export interface MemoryPermanenceReceipt {
  schemaVersion: 1
  receiptId: string
  actionId: string
  cardId: string
  actionHash: string
  operatorId: string
  profileId: string
  sessionId: string
  generation: number
  scope: ProtectedMemoryScope
  factId: string
  targetOperationId: string
  factKey: string
  sourcePath: string
  contentHash: string
  reasonHash: string
  confirmedAt: string
  consumedAt: string
  expiresAt: string
  stepUpVerified: true
  mac: string
}

export interface MemoryPermanenceAuditEvent extends MemoryPermanenceReceipt {
  eventId: string
  kind: 'memory.permanence.authorized'
}

export interface MemoryPermanenceAuthority {
  authorize(
    request: MemoryPermanenceAuthorizationRequest,
  ): Promise<MemoryPermanenceReceipt | null>
}

export class MemoryPermanenceAuthorityError extends Error {
  constructor(public readonly code:
    | 'INVALID_AUTHORITY_SECRET'
    | 'INVALID_REQUEST'
    | 'APPROVAL_PROOF_REQUIRED'
    | 'APPROVAL_PROOF_MISMATCH'
    | 'APPROVAL_PROOF_STALE'
    | 'RECEIPT_CONSUME_FAILED',
  ) {
    super(code)
    this.name = 'MemoryPermanenceAuthorityError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function bounded(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= maxBytes
}

function validIso(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function safeScope(value: ProtectedMemoryScope): boolean {
  return value.kind === 'global'
    ? value.scopeId === 'global' && !('projectId' in value)
    : bounded(value.projectId, 1024) && value.scopeId === `project:${value.projectId}`
}

function sameLeaseScope(lease: TurnContextLease, scope: ProtectedMemoryScope): boolean {
  return scope.kind === 'global' ||
    (lease.projectKind === 'project' && lease.projectId === scope.projectId)
}

function validateRequest(
  request: MemoryPermanenceAuthorizationRequest,
): MemoryPermanenceAuthorizationRequest {
  if (!ID.test(request.factId) || !HASH.test(request.targetOperationId) ||
    !HASH.test(request.factKey) || !SOURCE_PATH.test(request.sourcePath) ||
    !HASH.test(request.contentHash) || !bounded(request.reason, 4096) ||
    !safeScope(request.scope) || !sameLeaseScope(request.lease, request.scope) ||
    !bounded(request.lease.operatorId, 1024) || !bounded(request.lease.profileId, 1024) ||
    !bounded(request.lease.sessionId, 1024) ||
    !Number.isSafeInteger(request.lease.generation) || request.lease.generation < 1) {
    throw new MemoryPermanenceAuthorityError('INVALID_REQUEST')
  }
  return {
    ...request,
    scope: structuredClone(request.scope),
  }
}

function bindingPayload(
  request: MemoryPermanenceAuthorizationRequest,
  reasonHash: string,
): string {
  return JSON.stringify([
    'aisy-memory-permanence-action-v1',
    request.lease.operatorId,
    request.lease.profileId,
    request.lease.sessionId,
    request.lease.generation,
    request.scope.kind,
    request.scope.scopeId,
    request.scope.kind === 'project' ? request.scope.projectId : null,
    request.factId,
    request.targetOperationId,
    request.factKey,
    request.sourcePath,
    request.contentHash,
    reasonHash,
  ])
}

function receiptPayload(receipt: Omit<MemoryPermanenceReceipt, 'mac'>): string {
  return JSON.stringify([
    'aisy-memory-permanence-receipt-v1',
    receipt.receiptId,
    receipt.actionId,
    receipt.cardId,
    receipt.actionHash,
    receipt.operatorId,
    receipt.profileId,
    receipt.sessionId,
    receipt.generation,
    receipt.scope.kind,
    receipt.scope.scopeId,
    receipt.scope.kind === 'project' ? receipt.scope.projectId : null,
    receipt.factId,
    receipt.targetOperationId,
    receipt.factKey,
    receipt.sourcePath,
    receipt.contentHash,
    receipt.reasonHash,
    receipt.confirmedAt,
    receipt.consumedAt,
    receipt.expiresAt,
    receipt.stepUpVerified,
  ])
}

export function makeMemoryPermanenceAuthority(deps: {
  secret: Uint8Array
  nowMs(): number
  newActionId(): string
  newReceiptId(): string
  nonces: MemoryPermanenceNonceStore
  approve(
    lease: TurnContextLease,
    action: PendingAction,
  ): Promise<ApprovalDecision>
  deliverAuditOnce(event: MemoryPermanenceAuditEvent): Promise<void>
  receiptTtlMs?: number
  approvalMaxAgeMs?: number
}): MemoryPermanenceAuthority {
  if (deps.secret.byteLength < 32) {
    throw new MemoryPermanenceAuthorityError('INVALID_AUTHORITY_SECRET')
  }
  const receiptTtlMs = deps.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS
  const approvalMaxAgeMs = deps.approvalMaxAgeMs ?? DEFAULT_APPROVAL_MAX_AGE_MS
  if (!Number.isSafeInteger(receiptTtlMs) || receiptTtlMs < 1 || receiptTtlMs > 15 * 60_000 ||
    !Number.isSafeInteger(approvalMaxAgeMs) || approvalMaxAgeMs < 1 ||
    approvalMaxAgeMs > 60 * 60_000) {
    throw new MemoryPermanenceAuthorityError('INVALID_REQUEST')
  }
  const secret = Buffer.from(deps.secret)

  return Object.freeze<MemoryPermanenceAuthority>({
    async authorize(rawRequest) {
      const request = validateRequest(rawRequest)
      const reasonHash = sha256(request.reason)
      const actionHash = sha256(bindingPayload(request, reasonHash))
      const actionId = deps.newActionId()
      if (!ID.test(actionId)) throw new MemoryPermanenceAuthorityError('INVALID_REQUEST')
      const action: PendingAction = {
        actionId,
        actionHash,
        tier: 3,
        requiresStepUp: true,
        summary: [
          'Необратимо забыть факт',
          `Scope: ${request.scope.scopeId}`,
          `Fact: ${request.factId}`,
          `Причина: ${request.reason}`,
        ].join('\n'),
      }
      const decision = await deps.approve(request.lease, action)
      if (decision.decision !== 'confirmed') return null
      const proof = decision.proof
      if (!proof) throw new MemoryPermanenceAuthorityError('APPROVAL_PROOF_REQUIRED')
      if (proof.actionId !== actionId || proof.actionHash !== actionHash ||
        !ID.test(proof.cardId) || proof.stepUpVerified !== true ||
        !validIso(proof.confirmedAt)) {
        throw new MemoryPermanenceAuthorityError('APPROVAL_PROOF_MISMATCH')
      }
      const now = deps.nowMs()
      const confirmedAtMs = Date.parse(proof.confirmedAt)
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS - receiptTtlMs) {
        throw new MemoryPermanenceAuthorityError('INVALID_REQUEST')
      }
      if (confirmedAtMs > now || now - confirmedAtMs > approvalMaxAgeMs) {
        throw new MemoryPermanenceAuthorityError('APPROVAL_PROOF_STALE')
      }
      const receiptId = deps.newReceiptId()
      if (!ID.test(receiptId)) throw new MemoryPermanenceAuthorityError('INVALID_REQUEST')
      const consumedAt = new Date(now).toISOString()
      const expiresAt = new Date(now + receiptTtlMs).toISOString()
      const unsigned: Omit<MemoryPermanenceReceipt, 'mac'> = {
        schemaVersion: 1,
        receiptId,
        actionId,
        cardId: proof.cardId,
        actionHash,
        operatorId: request.lease.operatorId,
        profileId: request.lease.profileId,
        sessionId: request.lease.sessionId,
        generation: request.lease.generation,
        scope: structuredClone(request.scope),
        factId: request.factId,
        targetOperationId: request.targetOperationId,
        factKey: request.factKey,
        sourcePath: request.sourcePath,
        contentHash: request.contentHash,
        reasonHash,
        confirmedAt: proof.confirmedAt,
        consumedAt,
        expiresAt,
        stepUpVerified: true,
      }
      const mac = createHmac('sha256', secret).update(receiptPayload(unsigned)).digest('hex')
      const receipt: MemoryPermanenceReceipt = { ...unsigned, mac }
      deps.nonces.issue({ receiptId, mac, expiresAt })
      if (!deps.nonces.consume(receiptId, mac)) {
        throw new MemoryPermanenceAuthorityError('RECEIPT_CONSUME_FAILED')
      }
      await deps.deliverAuditOnce({
        ...structuredClone(receipt),
        eventId: receiptId,
        kind: 'memory.permanence.authorized',
      })
      return structuredClone(receipt)
    },
  })
}

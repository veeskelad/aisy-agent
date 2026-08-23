import type { ResolvedWorkBinding } from '../runtime/work-binding.js'

export type MonitoringSourceKind = 'telegram' | 'rss' | 'youtube' | 'github' | 'web'
export type MonitoringSourceStatus = 'active' | 'paused' | 'quarantined'
export type EvidenceCategory = 'critical' | 'important' | 'useful' | 'noise'

export interface MonitoringSource {
  schemaVersion: 1
  id: string
  kind: MonitoringSourceKind
  /** Public URL, channel/repository identifier, or other non-secret locator. */
  locator: string
  binding: ResolvedWorkBinding
  criteria: string
  pollIntervalMs: number
  status: MonitoringSourceStatus
  cursor?: string
  createdAt: string
  updatedAt: string
  lastCollectedAt?: string
  pausedReason?: 'operator' | 'context-unavailable' | 'budget-exhausted' | 'collector-error' | 'invalid-binding'
}

export interface CollectedEvidence {
  externalId: string
  primaryUrl: string
  title: string
  text: string
  author?: string
  publishedAt?: string
}

export interface CollectionBatch {
  items: CollectedEvidence[]
  cursor?: string
}

export interface MonitoringCollector {
  collect(source: MonitoringSource): Promise<CollectionBatch>
}

export interface MonitoringHttpResponse {
  status: number
  body: string
  finalUrl: string
  etag?: string
  lastModified?: string
}

export interface MonitoringHttpPort {
  /**
   * Security boundary: implementations MUST enforce DNS/IP allowlisting,
   * validate every redirect before I/O, and stop reading after maxBytes.
   * Core never falls back to ambient/global fetch.
   */
  get(input: {
    /** Exact persisted source whose operator-owned grant authorizes this request. */
    sourceId: string
    url: string
    maxBytes: number
    etag?: string
    lastModified?: string
  }): Promise<MonitoringHttpResponse>
}

export interface EvidenceScoreInput {
  evidenceId: string
  title: string
  text: string
  author?: string
  publishedAt?: string
  criteria: string
  provenance: 'untrusted'
  outboundAllowed: false
}

export interface EvidenceScore {
  score: number
  category: EvidenceCategory
  summary: string
  whyUseful: string
}

export interface MonitoringScorer {
  score(input: EvidenceScoreInput): Promise<EvidenceScore>
}

export interface MonitoringPollBudget {
  maxCollectedItems: number
  maxScoringCalls: number
}

export interface MonitoringTickBudget extends MonitoringPollBudget {
  maxSources: number
}

export interface MonitoringPollResult {
  sourceId: string
  status: 'completed' | 'paused' | 'failed'
  collected: number
  inserted: number
  changed: number
  unchanged: number
  duplicates: number
  /** Provider attempts, including failed/invalid responses; this is the call budget debit. */
  scoringCalls: number
  scored: number
  scoringDeferred: number
  reason?: 'context-unavailable' | 'budget-exhausted' | 'collector-error'
}

export interface MonitoringEvidence {
  id: string
  sourceId: string
  binding: ResolvedWorkBinding
  externalId: string
  primaryUrl: string
  title: string
  text: string
  author?: string
  publishedAt?: string
  collectedAt: string
  contentHash: string
  provenance: 'untrusted'
  score?: number
  category?: EvidenceCategory
  summary?: string
  whyUseful?: string
  scoredAt?: string
  needsScoring: boolean
}

export interface DigestBuildConfig {
  windowStart: string
  windowEnd: string
  notBefore: string
  expiresAt: string
  maxItems: number
  maxPerSource: number
  maxPerAuthor: number
  halfLifeHours: number
  /**
   * Per-kind decay override: a release feed stays relevant for days while a
   * chat goes stale in hours, and one half-life for both ranks one of them
   * wrong. Missing kinds fall back to `halfLifeHours`.
   */
  halfLifeHoursByKind?: Partial<Record<MonitoringSourceKind, number>>
  /**
   * Category multiplier applied before decay. A critical item that is a few
   * hours old should still outrank a fresh useful one; without a weight the
   * model's raw score alone decides, and it does not know that.
   */
  categoryWeights?: Partial<Record<EvidenceCategory, number>>
  categories?: EvidenceCategory[]
}

/** Weights used when the caller supplies none. */
export const DEFAULT_CATEGORY_WEIGHTS: Readonly<Record<EvidenceCategory, number>> = Object.freeze({
  critical: 1.6,
  important: 1.25,
  useful: 1,
  noise: 0.4,
})

export interface DigestItem {
  evidenceId: string
  sourceId: string
  primaryUrl: string
  title: string
  summary: string
  whyUseful: string
  author?: string
  publishedAt?: string
  category: EvidenceCategory
  rawScore: number
  rankScore: number
}

export interface MonitoringDigest {
  schemaVersion: 1
  id: string
  binding: ResolvedWorkBinding
  windowStart: string
  windowEnd: string
  notBefore: string
  expiresAt: string
  createdAt: string
  status: 'ready' | 'delivered' | 'expired' | 'paused' | 'quarantined'
  items: DigestItem[]
  deliveryReceipt?: string
  pausedReason?: 'context-unavailable' | 'invalid-binding'
}

export interface MonitoringSearchHit {
  evidence: MonitoringEvidence
  rank: number
}

export interface MonitoringFeedback {
  schemaVersion: 1
  id: string
  binding: ResolvedWorkBinding
  digestId: string
  evidenceId: string
  verdict: 'important' | 'not-useful'
  status: 'staged'
  createdAt: string
}

export interface MonitoringEvent {
  kind:
    | 'monitor.source_registered'
    | 'monitor.source_paused'
    | 'monitor.source_resumed'
    | 'monitor.source_removed'
    | 'monitor.poll_completed'
    | 'monitor.poll_paused'
    | 'monitor.digest_ready'
    | 'monitor.digest_paused'
    | 'monitor.digest_delivered'
    | 'monitor.feedback_staged'
  projectId: string
  sessionId: string
  scope: ResolvedWorkBinding['scope']
  sourceId?: string
  digestId?: string
  counts?: Record<string, number>
  reason?: string
}

export interface MonitoringStore {
  registerSource(source: MonitoringSource): void
  getSource(id: string): MonitoringSource | null
  listSources(binding: ResolvedWorkBinding): MonitoringSource[]
  listDueSources(now: string): MonitoringSource[]
  updateSource(source: MonitoringSource): void
  /** Exact HTTPS domain grant; null means missing, legacy, corrupt, or removed. */
  getSourceEgressDomain(id: string): string | null
  /** Tombstones the source and atomically revokes its egress grant. */
  removeSource(id: string, binding: ResolvedWorkBinding, removedAt: string): void
  ingest(source: MonitoringSource, items: CollectedEvidence[], collectedAt: string): {
    inserted: MonitoringEvidence[]
    changed: MonitoringEvidence[]
    unchanged: MonitoringEvidence[]
    duplicates: number
  }
  pendingForScoring(sourceId: string, limit: number): MonitoringEvidence[]
  saveScore(evidenceId: string, score: EvidenceScore, scoredAt: string): void
  search(binding: ResolvedWorkBinding, query: string, limit: number): MonitoringSearchHit[]
  candidates(binding: ResolvedWorkBinding, windowStart: string, windowEnd: string): MonitoringEvidence[]
  saveDigest(digest: MonitoringDigest): void
  getDigest(id: string): MonitoringDigest | null
  /** Exact persisted window lookup used to make scheduled build restart-idempotent. */
  getDigestForWindow(
    binding: ResolvedWorkBinding,
    windowStart: string,
    windowEnd: string,
  ): MonitoringDigest | null
  listDueDigests(now: string): MonitoringDigest[]
  markDigestDelivered(id: string, receipt: string): MonitoringDigest
  pauseDigest(id: string, reason: 'context-unavailable'): MonitoringDigest
  stageFeedback(feedback: MonitoringFeedback): void
  /**
   * Retention (ADR-0084): drop evidence older than `olderThan`, then, if the
   * table is still above `maxRows`, drop the oldest rows past that count.
   * Evidence referenced by a digest that is not yet expired is kept: a delivered
   * digest must not turn into dead links.
   */
  prune(input: { olderThan: string; maxRows: number; now: string }): {
    byAge: number
    byVolume: number
    kept: number
  }
}

export interface MonitoringEngine {
  registerSource(input: Omit<MonitoringSource, 'schemaVersion' | 'createdAt' | 'updatedAt' | 'status'>): MonitoringSource
  pauseSource(sourceId: string, binding: ResolvedWorkBinding): MonitoringSource
  resumeSource(sourceId: string, binding: ResolvedWorkBinding): MonitoringSource
  removeSource(sourceId: string, binding: ResolvedWorkBinding): void
  poll(sourceId: string, budget: MonitoringPollBudget): Promise<MonitoringPollResult>
  tick(budget: MonitoringTickBudget): Promise<MonitoringPollResult[]>
  buildDigest(binding: ResolvedWorkBinding, config: DigestBuildConfig): MonitoringDigest
  listDueDigests(now: string): MonitoringDigest[]
  markDelivered(digestId: string, receipt: string): MonitoringDigest
  stageFeedback(input: Omit<MonitoringFeedback, 'schemaVersion' | 'id' | 'status' | 'createdAt'>): MonitoringFeedback
}

export type MonitoringFollowupTier = 1 | 2 | 3

export type MonitoringFollowupStatus =
  | 'proposed'
  | 'awaiting-approval'
  | 'approved'
  | 'paused'
  | 'executing'
  | 'verifying'
  | 'rollback-pending'
  | 'verified'
  | 'rejected'
  | 'expired'
  | 'blocked'
  | 'rolled-back'
  | 'reconciliation-required'
  | 'rollback-failed'
  | 'quarantined'

export type MonitoringFollowupCode =
  | 'FOLLOWUP_BINDING_UNAVAILABLE'
  | 'FOLLOWUP_EVIDENCE_MISMATCH'
  | 'FOLLOWUP_APPROVAL_INVALID'
  | 'FOLLOWUP_PRECONDITION_FAILED'
  | 'FOLLOWUP_EXECUTION_FAILED'
  | 'FOLLOWUP_RECEIPT_MISSING'
  | 'FOLLOWUP_VERIFICATION_FAILED'
  | 'FOLLOWUP_RECONCILIATION_REQUIRED'
  | 'FOLLOWUP_ROLLBACK_FAILED'
  | 'FOLLOWUP_QUARANTINED'

export interface MonitoringFollowupEvidenceRef {
  readonly evidenceId: string
  readonly sourceId: string
  readonly primaryUrl: string
}

export interface MonitoringFollowupApprovalProof {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly cardId: string
  readonly challengeId: string
  /** Opaque gateway-issued one-shot credential. Never persisted by the engine. */
  readonly token: string
}

export interface MonitoringFollowupApprovalReceipt {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly cardId: string
  readonly challengeId: string
  readonly confirmedAt: string
  readonly provenance: 'gateway-issued'
  readonly stepUpVerified: boolean
}

export interface MonitoringFollowupApprovalConsumer {
  consume(input: {
    proof: MonitoringFollowupApprovalProof
    proposalId: string
    actionHash: string
    tier: MonitoringFollowupTier
  }): MonitoringFollowupApprovalReceipt | null
  /** Verifies code-minted provenance again after restart or persisted-state reload. */
  validate(input: {
    receipt: MonitoringFollowupApprovalReceipt
    proposalId: string
    actionHash: string
    tier: MonitoringFollowupTier
  }): boolean
}

export interface MonitoringFollowupExecutionReceipt {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly idempotencyKey: string
  readonly receiptId: string
  readonly occurredAt: string
}

export interface MonitoringFollowupVerificationReceipt {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly executionReceiptId: string
  readonly probeHash: string
  readonly verified: boolean
  readonly verifiedAt: string
}

export interface MonitoringFollowupRollbackReceipt {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly idempotencyKey: string
  readonly receiptId: string
  readonly occurredAt: string
}

export interface MonitoringFollowupRollbackVerificationReceipt {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly actionHash: string
  readonly rollbackReceiptId: string
  readonly probeHash: string
  readonly rolledBack: boolean
  readonly verifiedAt: string
}

export interface MonitoringActionProposalV1 {
  readonly schemaVersion: 1
  readonly id: string
  readonly binding: ResolvedWorkBinding
  readonly digestId: string
  readonly evidence: readonly MonitoringFollowupEvidenceRef[]
  readonly evidenceSnapshotHash: string
  readonly actionKind: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly actionHash: string
  readonly idempotencyKey: string
  readonly tier: MonitoringFollowupTier
  /** Untrusted display-only copy; never policy or executor authority. */
  readonly summary: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly status: MonitoringFollowupStatus
  readonly pausedFrom?: 'proposed' | 'awaiting-approval' | 'approved'
  readonly proposalDeliveryReceipt?: string
  readonly approval?: MonitoringFollowupApprovalReceipt
  readonly executionReceipt?: MonitoringFollowupExecutionReceipt
  readonly verificationReceipt?: MonitoringFollowupVerificationReceipt
  readonly rollbackReceipt?: MonitoringFollowupRollbackReceipt
  readonly rollbackVerificationReceipt?: MonitoringFollowupRollbackVerificationReceipt
  readonly lastCode?: MonitoringFollowupCode
  readonly claimToken?: string
  readonly claimUntil?: string
  readonly attempts: number
  readonly revision: number
}

export type MonitoringFollowupPrecondition =
  | { readonly ok: true; readonly snapshotHash: string }
  | { readonly ok: false; readonly code: 'FOLLOWUP_PRECONDITION_FAILED' }

export interface MonitoringFollowupActionInput {
  readonly proposal: MonitoringActionProposalV1
  readonly preconditionHash: string
  readonly idempotencyKey: string
}

export interface MonitoringFollowupActionFamily {
  readonly kind: string
  /** Deterministic code-owned tier. Candidate/model output never supplies it. */
  readonly tier: MonitoringFollowupTier
  validateParameters(value: unknown): Readonly<Record<string, unknown>>
  precondition(proposal: MonitoringActionProposalV1): Promise<MonitoringFollowupPrecondition>
  execute(input: MonitoringFollowupActionInput): Promise<MonitoringFollowupExecutionReceipt | null>
  recoverReceipt(input: {
    proposal: MonitoringActionProposalV1
    idempotencyKey: string
  }): Promise<MonitoringFollowupExecutionReceipt | null>
  verify(input: {
    proposal: MonitoringActionProposalV1
    receipt: MonitoringFollowupExecutionReceipt
  }): Promise<MonitoringFollowupVerificationReceipt>
  rollback?(input: {
    proposal: MonitoringActionProposalV1
    receipt: MonitoringFollowupExecutionReceipt
    idempotencyKey: string
  }): Promise<MonitoringFollowupRollbackReceipt | null>
  recoverRollbackReceipt?(input: {
    proposal: MonitoringActionProposalV1
    idempotencyKey: string
  }): Promise<MonitoringFollowupRollbackReceipt | null>
  verifyRollback?(input: {
    proposal: MonitoringActionProposalV1
    receipt: MonitoringFollowupRollbackReceipt
  }): Promise<MonitoringFollowupRollbackVerificationReceipt>
}

export interface MonitoringFollowupExecutionOutcome {
  readonly proposalId: string
  readonly status: MonitoringFollowupStatus | 'skipped'
  readonly code?: MonitoringFollowupCode
}

export interface MonitoringFollowupEngine {
  propose(input: {
    binding: ResolvedWorkBinding
    digestId: string
    evidenceIds: readonly string[]
    actionKind: string
    parameters: unknown
    summary: string
    expiresAt: string
  }): MonitoringActionProposalV1
  get(id: string): MonitoringActionProposalV1 | null
  listForProposalDelivery(maxItems: number): readonly MonitoringActionProposalV1[]
  recordProposalDelivery(id: string, actionHash: string, receipt: string): MonitoringActionProposalV1
  approve(id: string, proof: MonitoringFollowupApprovalProof): MonitoringActionProposalV1
  reject(id: string, actionHash: string): MonitoringActionProposalV1
  resumePaused(id: string): MonitoringActionProposalV1
  listExecutable(maxItems: number): readonly MonitoringActionProposalV1[]
  execute(id: string): Promise<MonitoringFollowupExecutionOutcome>
}

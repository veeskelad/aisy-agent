interface FollowupProposal {
  readonly schemaVersion: 1
  readonly id: string
  readonly digestId: string
  readonly evidence: readonly {
    readonly evidenceId: string
    readonly sourceId: string
    readonly primaryUrl: string
  }[]
  readonly evidenceSnapshotHash: string
  readonly actionKind: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly actionHash: string
  readonly idempotencyKey: string
  readonly tier: 1 | 2 | 3
  readonly summary: string
  readonly expiresAt: string
  readonly status: string
}

interface FollowupExecutionOutcome {
  readonly proposalId: string
  readonly status: string
  readonly code?: string
}

export interface MonitoringFollowupCoordinatorEngine {
  listForProposalDelivery(maxItems: number): readonly FollowupProposal[]
  recordProposalDelivery(id: string, actionHash: string, receipt: string): FollowupProposal
  listExecutable(maxItems: number): readonly FollowupProposal[]
  execute(id: string): Promise<FollowupExecutionOutcome>
}

export interface MonitoringFollowupProposalDeliveryPort {
  deliver(input: {
    card: MonitoringFollowupApprovalCardV1
    /** Stable adapter-side idempotency key; delivery never grants approval. */
    idempotencyKey: string
  }): Promise<string | null | undefined>
}

export interface MonitoringFollowupApprovalCardV1 {
  readonly schemaVersion: 1
  readonly proposalId: string
  readonly digestId: string
  readonly action: {
    readonly kind: string
    /** Display-only summary; the action hash remains the execution authority. */
    readonly summary: string
    readonly parameters: Readonly<Record<string, unknown>>
  }
  readonly tier: 1 | 2 | 3
  readonly expiresAt: string
  readonly evidence: readonly {
    readonly evidenceId: string
    readonly sourceId: string
    readonly primaryUrl: string
  }[]
  readonly evidenceSnapshotHash: string
  readonly actionHash: string
}

export interface MonitoringFollowupProposalTickResult {
  due: number
  attempted: number
  delivered: number
  noReceipt: number
  failed: number
}

export interface MonitoringFollowupExecutionTickResult {
  due: number
  attempted: number
  completed: number
  skipped: number
  failed: number
  byStatus: Readonly<Record<string, number>>
}

const MAX_BATCH = 100

function batch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH) {
    throw new RangeError('maxItems must be an integer between 1 and 100')
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export function monitoringFollowupApprovalCard(
  proposal: FollowupProposal,
): MonitoringFollowupApprovalCardV1 {
  return deepFreeze({
    schemaVersion: 1 as const,
    proposalId: proposal.id,
    digestId: proposal.digestId,
    action: {
      kind: proposal.actionKind,
      summary: proposal.summary,
      parameters: structuredClone(proposal.parameters),
    },
    tier: proposal.tier,
    expiresAt: proposal.expiresAt,
    evidence: proposal.evidence.map(item => ({
      evidenceId: item.evidenceId,
      sourceId: item.sourceId,
      primaryUrl: item.primaryUrl,
    })),
    evidenceSnapshotHash: proposal.evidenceSnapshotHash,
    actionHash: proposal.actionHash,
  })
}

/**
 * Explicit one-tick coordinator. Construction performs no transport I/O and
 * a delivery receipt only advances the proposal to its approval boundary.
 */
export function makeMonitoringFollowupProposalCoordinator(input: {
  engine: MonitoringFollowupCoordinatorEngine
  delivery: MonitoringFollowupProposalDeliveryPort
}) {
  return Object.freeze({
    async tick(maxItems: number): Promise<MonitoringFollowupProposalTickResult> {
      const proposals = input.engine.listForProposalDelivery(batch(maxItems))
      const result: MonitoringFollowupProposalTickResult = {
        due: proposals.length, attempted: 0, delivered: 0, noReceipt: 0, failed: 0,
      }
      for (const proposal of proposals) {
        result.attempted += 1
        try {
          const raw = await input.delivery.deliver({
            card: monitoringFollowupApprovalCard(proposal),
            idempotencyKey: `${proposal.idempotencyKey}:proposal`,
          })
          const receipt = typeof raw === 'string' ? raw.trim() : ''
          if (receipt.length === 0) {
            result.noReceipt += 1
            continue
          }
          input.engine.recordProposalDelivery(proposal.id, proposal.actionHash, receipt)
          result.delivered += 1
        } catch {
          result.failed += 1
        }
      }
      return Object.freeze(result)
    },
  })
}

/** Explicit one-tick executor; there are no timers or action adapters here. */
export function makeMonitoringFollowupExecutionCoordinator(input: {
  engine: MonitoringFollowupCoordinatorEngine
}) {
  return Object.freeze({
    async tick(maxItems: number): Promise<MonitoringFollowupExecutionTickResult> {
      const proposals = input.engine.listExecutable(batch(maxItems))
      const byStatus: Record<string, number> = Object.create(null) as Record<string, number>
      const result = {
        due: proposals.length, attempted: 0, completed: 0, skipped: 0, failed: 0, byStatus,
      }
      for (const proposal of proposals) {
        result.attempted += 1
        try {
          const outcome = await input.engine.execute(proposal.id)
          byStatus[outcome.status] = (byStatus[outcome.status] ?? 0) + 1
          if (outcome.status === 'skipped') result.skipped += 1
          else result.completed += 1
        } catch {
          result.failed += 1
        }
      }
      return Object.freeze({ ...result, byStatus: Object.freeze({ ...byStatus }) })
    },
  })
}

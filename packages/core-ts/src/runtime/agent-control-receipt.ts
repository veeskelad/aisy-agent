import { createHash } from 'node:crypto'

export type AgentControlOutcome =
  | 'session-renamed'
  | 'session-delete-preview'
  | 'session-name-proposed'
  | 'policy-tightened'
  | 'policy-relaxed'
  | 'policy-path-resolved'

export interface VerifiedAgentControlReceiptV1 {
  kind: 'agent.control/v1'
  operation: 'session.rename' | 'session.request-delete' | 'session.propose-name' |
    'policy.tighten-project' | 'policy.tighten-path'
    | 'policy.relax-project' | 'policy.relax-path' | 'policy.resolve-path'
  outcome: AgentControlOutcome
  turnId: string
  receiptId: string
}

function receiptId(input: Omit<VerifiedAgentControlReceiptV1, 'receiptId'>): string {
  return createHash('sha256')
    .update('aisy.agent.control.receipt.v1\0')
    .update(JSON.stringify([input.operation, input.outcome, input.turnId]))
    .digest('hex')
}

export function makeAgentControlReceipt(input: {
  operation: VerifiedAgentControlReceiptV1['operation']
  outcome: AgentControlOutcome
  turnId: string
}): VerifiedAgentControlReceiptV1 {
  const base = Object.freeze({ kind: 'agent.control/v1' as const, ...input })
  return Object.freeze({ ...base, receiptId: receiptId(base) })
}

export function parseAgentControlReceipt(value: unknown): VerifiedAgentControlReceiptV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Partial<VerifiedAgentControlReceiptV1>
  if (candidate.kind !== 'agent.control/v1' ||
    (candidate.operation !== 'session.rename' && candidate.operation !== 'session.request-delete' &&
      candidate.operation !== 'session.propose-name' &&
      candidate.operation !== 'policy.tighten-project' && candidate.operation !== 'policy.tighten-path' &&
      candidate.operation !== 'policy.relax-project' && candidate.operation !== 'policy.relax-path' &&
      candidate.operation !== 'policy.resolve-path') ||
    (candidate.outcome !== 'session-renamed' && candidate.outcome !== 'session-delete-preview' &&
      candidate.outcome !== 'session-name-proposed' && candidate.outcome !== 'policy-tightened' &&
      candidate.outcome !== 'policy-relaxed' && candidate.outcome !== 'policy-path-resolved') ||
    typeof candidate.turnId !== 'string' || candidate.turnId.length === 0 || candidate.turnId.length > 256 ||
    typeof candidate.receiptId !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.receiptId) ||
    Object.keys(candidate).some((key) =>
      !['kind', 'operation', 'outcome', 'turnId', 'receiptId'].includes(key))) return null
  const expectedOutcome = candidate.operation === 'session.rename'
    ? 'session-renamed'
    : candidate.operation === 'session.request-delete'
      ? 'session-delete-preview'
      : candidate.operation === 'session.propose-name'
        ? 'session-name-proposed'
        : candidate.operation === 'policy.resolve-path'
          ? 'policy-path-resolved'
          : candidate.operation === 'policy.tighten-project' || candidate.operation === 'policy.tighten-path'
          ? 'policy-tightened'
          : 'policy-relaxed'
  if (candidate.outcome !== expectedOutcome) return null
  const normalized = {
    kind: candidate.kind,
    operation: candidate.operation,
    outcome: candidate.outcome,
    turnId: candidate.turnId,
  }
  return candidate.receiptId === receiptId(normalized)
    ? Object.freeze({ ...normalized, receiptId: candidate.receiptId })
    : null
}

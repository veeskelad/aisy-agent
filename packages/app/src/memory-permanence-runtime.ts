import { randomUUID } from 'node:crypto'
import {
  makeMemoryPermanenceAuthority,
  type ApprovalDecision,
  type MemoryPermanenceAuditEvent,
  type MemoryPermanenceAuthorizationRequest,
  type PendingAction,
  type TurnContextLease,
} from '@aisy/core'
import { makeNodeMemoryPermanenceNonceStore } from './memory-permanence-nonce-store.js'

export interface NodeMemoryPermanenceRuntime {
  authorizeHumanConfirmedDelete(
    request: MemoryPermanenceAuthorizationRequest,
  ): Promise<boolean>
}

/**
 * Composes the code-owned memory-permanence authority with a durable one-use
 * nonce journal. Callers still own the operator-facing approval transport and
 * audit sink; no secret is read from environment or persisted by this adapter.
 */
export function makeNodeMemoryPermanenceRuntime(input: {
  secret: Uint8Array
  noncePath: string
  approve(lease: TurnContextLease, action: PendingAction): Promise<ApprovalDecision>
  deliverAuditOnce(event: MemoryPermanenceAuditEvent): Promise<void>
  nowMs?: () => number
  newActionId?: () => string
  newReceiptId?: () => string
}): NodeMemoryPermanenceRuntime {
  const nowMs = input.nowMs ?? Date.now
  const authority = makeMemoryPermanenceAuthority({
    secret: input.secret,
    nowMs,
    newActionId: input.newActionId ?? randomUUID,
    newReceiptId: input.newReceiptId ?? randomUUID,
    nonces: makeNodeMemoryPermanenceNonceStore({ path: input.noncePath, nowMs }),
    approve: input.approve,
    deliverAuditOnce: input.deliverAuditOnce,
  })
  return Object.freeze<NodeMemoryPermanenceRuntime>({
    async authorizeHumanConfirmedDelete(request) {
      return await authority.authorize(request) !== null
    },
  })
}

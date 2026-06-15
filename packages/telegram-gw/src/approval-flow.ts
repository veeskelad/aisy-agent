// Approval-card tap resolution (plan §6).
//
// Bridges a decoded callback to the deterministic confirmer. The adapter holds
// the PendingAction it carded; getIssuedCard (ADR-0046) supplies card liveness;
// handleCardTap is the sole confirmer. Reject and info are handled adapter-side
// (handleCardTap only ever *confirms*): reject abandons the card, info shows
// details. Confirm echoes the button's nonce and the displayed action-hash.

import {
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from '@aisy/core'
import type { Gateway, PendingAction, CardTap } from '@aisy/core'
import { renderResolved } from './approval-card.js'
import type { CardCallback } from './approval-card.js'

export type TapOutcome =
  | { kind: 'confirmed'; actionId: string; footer: string }
  | { kind: 'rejected'; footer: string }
  | { kind: 'info' }
  | { kind: 'stepup_required' }
  | { kind: 'stepup_failed' }
  | { kind: 'expired' }
  | { kind: 'replay' }
  | { kind: 'hash_mismatch' }

export interface ApprovalFlowDeps {
  gateway: Pick<Gateway, 'getIssuedCard' | 'handleCardTap'>
  /** ISO timestamp source for the resolved footer. */
  now(): string
}

/**
 * Resolve a tapped approval button. Pure routing over the gateway: it builds
 * the CardTap (echoing the button's nonce and the displayed action-hash) and
 * maps the gateway's deterministic verdict / typed errors to a render outcome.
 */
export async function resolveTap(
  cb: CardCallback,
  chatId: number,
  action: PendingAction,
  deps: ApprovalFlowDeps,
  opts?: { stepUpProof?: string },
): Promise<TapOutcome> {
  if (cb.verb === 'info') return { kind: 'info' }
  if (cb.verb === 'reject') {
    return { kind: 'rejected', footer: renderResolved(action, 'rejected', deps.now()) }
  }

  // confirm
  if (deps.gateway.getIssuedCard(cb.cardId) === null) return { kind: 'expired' }

  const tap: CardTap = {
    cardId: cb.cardId,
    nonce: cb.nonce, // echo the nonce the tapped button carried (anti-stale)
    presentedActionHash: action.actionHash, // echo the hash shown on the card
    chatId,
    ...(opts?.stepUpProof !== undefined ? { stepUpProof: opts.stepUpProof } : {}),
  }

  try {
    const result = await deps.gateway.handleCardTap(tap)
    if (result.decision === 'confirmed') {
      return {
        kind: 'confirmed',
        actionId: result.actionId,
        footer: renderResolved(action, 'confirmed', deps.now()),
      }
    }
    return { kind: 'rejected', footer: renderResolved(action, 'rejected', deps.now()) }
  } catch (err) {
    if (err instanceof StepUpRequired) return { kind: 'stepup_required' }
    if (err instanceof StepUpFailed) return { kind: 'stepup_failed' }
    if (err instanceof NonceReplay) return { kind: 'replay' }
    if (err instanceof NonceStale || err instanceof NoSuchPendingAction) {
      return { kind: 'expired' }
    }
    if (err instanceof ActionHashMismatch) return { kind: 'hash_mismatch' }
    throw err
  }
}

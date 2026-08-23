import { createHash, randomBytes } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import type { ResolvedWorkBinding } from '@aisy/core'

import type { DurableDelegationResolutionRequestV2 } from './durable-delegation-live-adapter.js'
import {
  makeDurableDelegationOperationResolutionAuthorityV1,
  type DurableDelegationOperationResolutionAuthorityV1,
} from './durable-delegation-operation-control.js'
import {
  durableParentAmbiguityOperationHash,
  type DurableParentAmbiguityV1,
  type DurableParentContinuationRecordV1,
  type DurableParentContinuationStoreV1,
} from './durable-parent-continuation.js'
import {
  durableAmbiguityOperationId,
  type DurableTurnActorProductionPortsV1,
} from './durable-turn-actor-production-ports.js'
import {
  durableTurnWorkBindingHash,
  type DurableTurnActorRecordV1,
  type DurableTurnApprovalCardV1,
  type DurableTurnBudgetV1,
  type DurableTurnDecisionResultV1,
  type DurableTurnResumePermitV1,
  type NodeDurableTurnActorControllerV1,
} from './durable-turn-actor.js'

const HASH = /^[a-f0-9]{64}$/
const RECEIPT_DOMAIN = 'aisy.durable-delegation-turn-coordinator.receipt.v1\0'
const RESOLUTION_DOMAIN = 'aisy.durable-delegation-turn-coordinator.resolution.v1\0'
const OWNER_DOMAIN = 'aisy.durable-delegation-turn-coordinator.owner.v1\0'

export type DurableDelegationTurnCoordinatorErrorCode =
  | 'DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID'
  | 'DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH'
  | 'DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED'

export class DurableDelegationTurnCoordinatorError extends Error {
  constructor(readonly code: DurableDelegationTurnCoordinatorErrorCode) {
    super(code)
    this.name = 'DurableDelegationTurnCoordinatorError'
  }
}

export interface DurableDelegationTurnCoordinatorV1 {
  onAmbiguity(request: DurableDelegationResolutionRequestV2): void
  resolveAmbiguity(
    request: DurableDelegationResolutionRequestV2,
  ): DurableDelegationOperationResolutionAuthorityV1 | undefined
  onResolutionApplied(
    request: DurableDelegationResolutionRequestV2,
    decision: 'retry-once' | 'cancel',
  ): void
  pendingCard(): Readonly<{
    card: DurableTurnApprovalCardV1
    retryClass: 'retry-once'
  }> | null
  markCardDelivered(input: Readonly<{
    actorId: string
    revision: number
    messageId: string
  }>): DurableTurnActorRecordV1
  recordTransportDecision(input: Readonly<{
    actorId: string
    actionId: string
    actionHash: string
    cardId: string
    operatorId: string
    chatId: string
    sessionId: string
    turnId: string
    nonce: string
    decision: 'confirmed' | 'rejected'
    stepUpVerified: boolean
  }>): DurableTurnDecisionResultV1
  recordCardDecision(input: Readonly<{
    actorId: string
    operatorId: string
    chatId: string
    messageId: string
    nonce: string
    decision: 'confirmed' | 'rejected'
    stepUpVerified: boolean
  }>): DurableTurnDecisionResultV1
  recover(): Readonly<{
    kind: 'none' | 'card-pending' | 'awaiting-decision' | 'resume-ready' |
      'reconciliation-required' | 'cancelling'
    card?: DurableTurnApprovalCardV1
  }>
  requestStop(): Readonly<{
    kind: 'cancelled' | 'replayed'
    receiptHash: string
  }>
  retireParent(receiptHash: string): DurableParentContinuationRecordV1
}

function fail(code: DurableDelegationTurnCoordinatorErrorCode): never {
  throw new DurableDelegationTurnCoordinatorError(code)
}

function hash(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update(JSON.stringify(value), 'utf8').digest('hex')
}

function captureRequest(value: unknown): DurableDelegationResolutionRequestV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const required = [
    'runRootHash', 'taskId', 'controlLogicalSlotHash', 'journalLogicalSlotHash',
    'attempt', 'phase', 'ordinal', 'retryClass',
  ]
  if (Object.keys(descriptors).sort().join(',') !== required.sort().join(',') ||
    Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
  }
  const raw = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) =>
    [key, descriptor.value])) as Record<string, unknown>
  if (typeof raw['runRootHash'] !== 'string' || !HASH.test(raw['runRootHash']) ||
    typeof raw['taskId'] !== 'string' || raw['taskId'].length === 0 || raw['taskId'].length > 128 ||
    typeof raw['controlLogicalSlotHash'] !== 'string' || !HASH.test(raw['controlLogicalSlotHash']) ||
    typeof raw['journalLogicalSlotHash'] !== 'string' || !HASH.test(raw['journalLogicalSlotHash']) ||
    (raw['attempt'] !== 1 && raw['attempt'] !== 2) ||
    (raw['phase'] !== 'provider' && raw['phase'] !== 'tool') ||
    !Number.isSafeInteger(raw['ordinal']) || Number(raw['ordinal']) < 1 ||
    (raw['retryClass'] !== 'retry-once' && raw['retryClass'] !== 'new-task-only')) {
    fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
  }
  return Object.freeze({
    runRootHash: raw['runRootHash'],
    taskId: raw['taskId'],
    controlLogicalSlotHash: raw['controlLogicalSlotHash'],
    journalLogicalSlotHash: raw['journalLogicalSlotHash'],
    attempt: raw['attempt'],
    phase: raw['phase'],
    ordinal: Number(raw['ordinal']),
    retryClass: raw['retryClass'],
  } as DurableDelegationResolutionRequestV2)
}

function sameAmbiguity(
  ambiguity: Readonly<DurableParentAmbiguityV1> | undefined,
  request: DurableDelegationResolutionRequestV2,
): boolean {
  return ambiguity !== undefined &&
    ambiguity.operationHash === durableParentAmbiguityOperationHash(request) &&
    ambiguity.runRootHash === request.runRootHash && ambiguity.taskId === request.taskId &&
    ambiguity.controlLogicalSlotHash === request.controlLogicalSlotHash &&
    ambiguity.journalLogicalSlotHash === request.journalLogicalSlotHash &&
    ambiguity.attempt === request.attempt && ambiguity.phase === request.phase &&
    ambiguity.ordinal === request.ordinal && ambiguity.retryClass === request.retryClass
}

function exactActor(
  actor: DurableTurnActorRecordV1,
  continuation: DurableParentContinuationRecordV1,
  request: DurableDelegationResolutionRequestV2,
): boolean {
  const operationHash = durableParentAmbiguityOperationHash(request)
  return actor.identity.operationHash === operationHash &&
    actor.identity.operationId === durableAmbiguityOperationId(operationHash) &&
    actor.identity.continuationHash === continuation.continuationHash &&
    actor.identity.workBindingHash === durableTurnWorkBindingHash(continuation.identity.binding) &&
    actor.identity.sessionId === continuation.identity.sessionId &&
    actor.identity.turnId === continuation.identity.turnId &&
    actor.identity.supervisorBindingHash === continuation.identity.supervisorBindingHash &&
    actor.identity.policyRevision === continuation.identity.policyRevision
}

function activeContinuation(store: DurableParentContinuationStoreV1): DurableParentContinuationRecordV1 {
  const loaded = store.load()
  if (loaded.status !== 'ready' || loaded.record.phase === 'terminal') {
    fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
  }
  return loaded.record
}

export function makeDurableDelegationTurnCoordinatorV1(input: Readonly<{
  continuation: DurableParentContinuationStoreV1
  actor: NodeDurableTurnActorControllerV1
  actorPorts: Pick<DurableTurnActorProductionPortsV1, 'admitTransportCallback'>
  budget(
    request: DurableDelegationResolutionRequestV2,
    continuation: DurableParentContinuationRecordV1,
  ): DurableTurnBudgetV1
  chatId: string
  nowMs(): number
  approvalTtlMs: number
  quiescenceReceipt(
    request: DurableDelegationResolutionRequestV2,
    continuation: DurableParentContinuationRecordV1,
  ): string
  retireCancelledRun(
    request: DurableDelegationResolutionRequestV2,
    receiptHash: string,
  ): void
  newOwnerHash?(): string
}>): DurableDelegationTurnCoordinatorV1 {
  if (typeof input !== 'object' || input === null || utilTypes.isProxy(input) ||
    typeof input.continuation !== 'object' || input.continuation === null ||
    typeof input.actor !== 'object' || input.actor === null ||
    typeof input.actorPorts !== 'object' || input.actorPorts === null ||
    typeof input.budget !== 'function' || typeof input.nowMs !== 'function' ||
    typeof input.quiescenceReceipt !== 'function' ||
    typeof input.retireCancelledRun !== 'function' ||
    typeof input.chatId !== 'string' || input.chatId.length === 0 || input.chatId.length > 128 ||
    !Number.isSafeInteger(input.approvalTtlMs) || input.approvalTtlMs < 1 ||
    input.approvalTtlMs > 24 * 60 * 60 * 1000 ||
    (input.newOwnerHash !== undefined && typeof input.newOwnerHash !== 'function')) {
    fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
  }
  let pending: Readonly<{ card: DurableTurnApprovalCardV1; retryClass: 'retry-once' }> | null = null
  let resolution: Readonly<{
    operationHash: string
    authority: DurableDelegationOperationResolutionAuthorityV1
    permit: DurableTurnResumePermitV1 | null
    actorId: string
  }> | null = null

  const ownerHash = (): string => {
    const candidate = input.newOwnerHash?.() ?? hash(OWNER_DOMAIN, randomBytes(32).toString('hex'))
    if (!HASH.test(candidate)) fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
    return candidate
  }

  const actorFor = (
    continuation: DurableParentContinuationRecordV1,
    request: DurableDelegationResolutionRequestV2,
  ): DurableTurnActorRecordV1 | null => {
    const recovered = input.actor.manager.recover()
    if (recovered.kind === 'none') return null
    if (recovered.kind === 'authority-lost' || !exactActor(recovered.record, continuation, request)) {
      fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
    }
    return recovered.record
  }

  const pauseContinuation = (
    request: DurableDelegationResolutionRequestV2,
  ): DurableParentContinuationRecordV1 => {
    const current = activeContinuation(input.continuation)
    if (current.phase === 'paused') {
      if (!sameAmbiguity(current.ambiguity, request)) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      return current
    }
    return input.continuation.pause({
      continuationHash: current.continuationHash,
      ownerId: current.ownerId,
      expectedRevision: current.revision,
      request,
    })
  }

  const rotateRecoveredCard = (record: DurableTurnActorRecordV1): void => {
    if (pending !== null) return
    const replaced = record.approval.delivery === 'pending'
      ? input.actor.manager.rotatePendingCard({
          actorId: record.identity.actorId,
          expectedRevision: record.revision,
        })
      : input.actor.manager.replaceCardAfterRecovery({
          actorId: record.identity.actorId,
          expectedRevision: record.revision,
        })
    pending = Object.freeze({ card: replaced.card, retryClass: 'retry-once' as const })
  }

  const ensurePermit = (
    record: DurableTurnActorRecordV1,
    operationHash: string,
  ): DurableTurnResumePermitV1 => {
    if (resolution?.operationHash === operationHash && resolution.permit !== null) {
      return resolution.permit
    }
    if (record.decision?.kind !== 'confirmed') {
      fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
    }
    const claimed = record.claim === null
      ? input.actor.manager.claimResume({
          actorId: record.identity.actorId,
          expectedRevision: record.revision,
          ownerHash: ownerHash(),
        })
      : input.actor.manager.reconcileClaim({
          actorId: record.identity.actorId,
          expectedRevision: record.revision,
          ownerHash: ownerHash(),
        })
    if (claimed.kind !== 'claimed') {
      fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
    }
    return claimed.permit
  }

  const coordinator: DurableDelegationTurnCoordinatorV1 = Object.freeze({
    onAmbiguity(rawRequest: DurableDelegationResolutionRequestV2) {
      const request = captureRequest(rawRequest)
      const continuation = pauseContinuation(request)
      if (request.retryClass === 'new-task-only') {
        input.continuation.retire({
          continuationHash: continuation.continuationHash,
          ownerId: continuation.ownerId,
          expectedRevision: continuation.revision,
          terminalReceiptHash: hash(RECEIPT_DOMAIN, ['manual-recovery', continuation.continuationHash,
            durableParentAmbiguityOperationHash(request)]),
        })
        return
      }
      const existing = actorFor(continuation, request)
      if (existing !== null) {
        if (existing.phase === 'paused-awaiting-approval') rotateRecoveredCard(existing)
        return
      }
      const now = input.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now + input.approvalTtlMs > Number.MAX_SAFE_INTEGER) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
      }
      const paused = input.actor.manager.pause({
        identity: {
          operationId: durableAmbiguityOperationId(continuation.ambiguity!.operationHash),
          operationHash: continuation.ambiguity!.operationHash,
          continuationHash: continuation.continuationHash,
          binding: continuation.identity.binding as Readonly<ResolvedWorkBinding>,
          workBindingHash: durableTurnWorkBindingHash(continuation.identity.binding),
          sessionId: continuation.identity.sessionId,
          turnId: continuation.identity.turnId,
          supervisorBindingHash: continuation.identity.supervisorBindingHash,
          policyRevision: continuation.identity.policyRevision,
          budget: input.budget(request, continuation),
        },
        approval: {
          actionId: `retry-${continuation.ambiguity!.operationHash.slice(0, 32)}`,
          tier: 'tier-2',
          requiresStepUp: false,
          canRememberSimilar: false,
          chatId: input.chatId,
          expiresAtMs: now + input.approvalTtlMs,
        },
      })
      if (paused.kind !== 'paused') {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      pending = Object.freeze({ card: paused.card, retryClass: 'retry-once' as const })
    },

    resolveAmbiguity(rawRequest: DurableDelegationResolutionRequestV2) {
      const request = captureRequest(rawRequest)
      if (request.retryClass !== 'retry-once') return undefined
      const continuation = activeContinuation(input.continuation)
      if (continuation.phase !== 'paused' || !sameAmbiguity(continuation.ambiguity, request)) {
        return undefined
      }
      const record = actorFor(continuation, request)
      if (record === null || record.phase !== 'resume-ready' || record.decision === null) return undefined
      const operationHash = continuation.ambiguity!.operationHash
      if (resolution?.operationHash === operationHash) return resolution.authority
      const decision = record.decision.kind === 'confirmed' ? 'retry-once' as const : 'cancel' as const
      const permit = decision === 'retry-once' ? ensurePermit(record, operationHash) : null
      const resolutionHash = hash(RESOLUTION_DOMAIN, [
        record.identity.actorId,
        record.approval.actionHash,
        record.decision.kind,
        record.decision.decidedAtMs,
        operationHash,
      ])
      const authority = makeDurableDelegationOperationResolutionAuthorityV1({
        runRootHash: request.runRootHash,
        taskId: request.taskId,
        logicalSlotHash: request.controlLogicalSlotHash,
        ambiguousAttempt: request.attempt,
        decision,
        resolutionHash,
      })
      resolution = Object.freeze({
        operationHash,
        authority,
        permit,
        actorId: record.identity.actorId,
      })
      return authority
    },

    onResolutionApplied(
      rawRequest: DurableDelegationResolutionRequestV2,
      decision: 'retry-once' | 'cancel',
    ) {
      const request = captureRequest(rawRequest)
      if (decision !== 'retry-once' && decision !== 'cancel') {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
      }
      const continuation = activeContinuation(input.continuation)
      const operationHash = durableParentAmbiguityOperationHash(request)
      if (continuation.phase === 'paused' && !sameAmbiguity(continuation.ambiguity, request)) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      const record = actorFor(continuation, request)
      if (record === null && continuation.phase === 'active') return
      if (record === null || record.phase !== 'resume-ready' || record.decision === null ||
        (record.decision.kind === 'confirmed' ? 'retry-once' : 'cancel') !== decision) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      const permit = decision === 'retry-once' ? ensurePermit(record, operationHash) : null
      if (continuation.phase === 'paused') {
        input.continuation.resume({
          continuationHash: continuation.continuationHash,
          ownerId: continuation.ownerId,
          expectedRevision: continuation.revision,
          operationHash,
        })
      }
      if (decision === 'retry-once') {
        input.actor.manager.finishWithPermit({
          permit: permit!,
          terminal: {
            kind: 'completed',
            code: 'AMBIGUITY_RETRY_AUTHORIZED',
            receiptHash: hash(RECEIPT_DOMAIN, ['retry-once', operationHash]),
          },
        })
      } else {
        input.actor.manager.terminalizeRejected({
          actorId: record.identity.actorId,
          expectedRevision: record.revision,
        })
      }
      resolution = null
      pending = null
    },

    pendingCard() { return pending },

    markCardDelivered(
      delivery: Parameters<DurableDelegationTurnCoordinatorV1['markCardDelivered']>[0],
    ) {
      const current = pending
      if (current === null || delivery.actorId !== current.card.actorId ||
        delivery.revision !== current.card.revision) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
      }
      const record = input.actor.manager.markCardDelivered({
        actorId: delivery.actorId,
        expectedRevision: delivery.revision,
        messageId: delivery.messageId,
      })
      pending = null
      return record
    },

    recordTransportDecision(
      decisionInput: Parameters<DurableDelegationTurnCoordinatorV1['recordTransportDecision']>[0],
    ) {
      const authority = Object.freeze({
        actorId: decisionInput.actorId,
        actionId: decisionInput.actionId,
        actionHash: decisionInput.actionHash,
        cardId: decisionInput.cardId,
        operatorId: decisionInput.operatorId,
        chatId: decisionInput.chatId,
        sessionId: decisionInput.sessionId,
        turnId: decisionInput.turnId,
      })
      input.actorPorts.admitTransportCallback(authority, decisionInput.stepUpVerified)
      const admission = input.actor.manager.admitCallback(authority)
      return input.actor.callback.recordDecision({
        admission,
        nonce: decisionInput.nonce,
        decision: decisionInput.decision,
      })
    },

    recordCardDecision(
      decisionInput: Parameters<DurableDelegationTurnCoordinatorV1['recordCardDecision']>[0],
    ) {
      const recovered = input.actor.manager.recover()
      if ((recovered.kind !== 'awaiting-decision' && recovered.kind !== 'resume-ready') ||
        recovered.record.identity.actorId !== decisionInput.actorId ||
        recovered.record.approval.operatorId !== decisionInput.operatorId ||
        recovered.record.approval.chatId !== decisionInput.chatId ||
        recovered.record.approval.messageId !== decisionInput.messageId) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
      }
      const authority = Object.freeze({
        actorId: recovered.record.identity.actorId,
        actionId: recovered.record.approval.actionId,
        actionHash: recovered.record.approval.actionHash,
        cardId: recovered.record.approval.cardId,
        operatorId: recovered.record.approval.operatorId,
        chatId: recovered.record.approval.chatId,
        sessionId: recovered.record.identity.sessionId,
        turnId: recovered.record.identity.turnId,
      })
      input.actorPorts.admitTransportCallback(authority, decisionInput.stepUpVerified)
      const admission = input.actor.manager.admitCallback(authority)
      return input.actor.callback.recordDecision({
        admission,
        nonce: decisionInput.nonce,
        decision: decisionInput.decision,
      })
    },

    recover() {
      const recovered = input.actor.manager.recover()
      if (recovered.kind === 'none') return Object.freeze({ kind: 'none' as const })
      if (recovered.kind === 'authority-lost') {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      if (recovered.kind === 'replace-card-required' || recovered.kind === 'awaiting-decision') {
        rotateRecoveredCard(recovered.record)
        return Object.freeze({ kind: 'card-pending' as const, card: pending!.card })
      }
      if (recovered.kind === 'resume-ready' || recovered.kind === 'rejection-ready') {
        return Object.freeze({ kind: 'resume-ready' as const })
      }
      if (recovered.kind === 'reconciliation-required') {
        return Object.freeze({ kind: 'reconciliation-required' as const })
      }
      return Object.freeze({ kind: 'cancelling' as const })
    },

    requestStop() {
      let loaded = input.continuation.load()
      if (loaded.status !== 'ready' || loaded.record.ambiguity === undefined) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      const { operationHash, ...rawRequest } = loaded.record.ambiguity
      const request = captureRequest(rawRequest)
      if (operationHash !== durableParentAmbiguityOperationHash(request)) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      if (loaded.record.phase === 'terminal') {
        const receiptHash = loaded.record.cancellationReceiptHash
        if (receiptHash === undefined || loaded.record.terminalReceiptHash !== receiptHash) {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
        }
        input.retireCancelledRun(request, receiptHash)
        return Object.freeze({ kind: 'replayed' as const, receiptHash })
      }

      let recovered = input.actor.manager.recover()
      if (loaded.record.phase !== 'cancelling') {
        if (recovered.kind === 'none' || recovered.kind === 'authority-lost' ||
          !exactActor(recovered.record, loaded.record, request)) {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
        }
        const cancelling = recovered.record.phase === 'cancelling'
          ? recovered.record
          : input.actor.manager.requestCancel({
              actorId: recovered.record.identity.actorId,
              expectedRevision: recovered.record.revision,
            })
        const receiptHash = input.quiescenceReceipt(request, loaded.record)
        if (!HASH.test(receiptHash)) {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
        }
        input.continuation.beginCancellation({
          continuationHash: loaded.record.continuationHash,
          ownerId: loaded.record.ownerId,
          expectedRevision: loaded.record.revision,
          operationHash,
          cancellationReceiptHash: receiptHash,
        })
        loaded = input.continuation.load()
        if (loaded.status !== 'ready' || loaded.record.phase !== 'cancelling') {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
        }
        recovered = Object.freeze({ kind: 'continue-cancelling' as const, record: cancelling })
      }

      const receiptHash = loaded.record.cancellationReceiptHash
      if (receiptHash === undefined) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      if (recovered.kind !== 'none') {
        if (recovered.kind === 'authority-lost' || recovered.record.phase !== 'cancelling' ||
          !exactActor(recovered.record, loaded.record, request)) {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
        }
        const acknowledgement = input.actor.manager.acknowledgeCancellation({
          actorId: recovered.record.identity.actorId,
          expectedRevision: recovered.record.revision,
          receiptHash,
        })
        input.actor.manager.finishCancellation({ acknowledgement, code: 'operator-stop' })
      }
      const terminal = input.continuation.finishCancellation({
        continuationHash: loaded.record.continuationHash,
        ownerId: loaded.record.ownerId,
        expectedRevision: loaded.record.revision,
        operationHash,
        cancellationReceiptHash: receiptHash,
      })
      input.retireCancelledRun(request, receiptHash)
      pending = null
      resolution = null
      return Object.freeze({ kind: 'cancelled' as const, receiptHash: terminal.terminalReceiptHash! })
    },

    retireParent(receiptHash: string) {
      if (typeof receiptHash !== 'string' || !HASH.test(receiptHash)) {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_INPUT_INVALID')
      }
      const loaded = input.continuation.load()
      if (loaded.status !== 'ready') {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
      }
      if (loaded.record.phase === 'terminal') {
        if (loaded.record.terminalReceiptHash !== receiptHash) {
          fail('DURABLE_DELEGATION_TURN_COORDINATOR_STATE_MISMATCH')
        }
        return loaded.record
      }
      if (loaded.record.phase !== 'active' || input.actor.manager.recover().kind !== 'none') {
        fail('DURABLE_DELEGATION_TURN_COORDINATOR_TRANSITION_DENIED')
      }
      return input.continuation.retire({
        continuationHash: loaded.record.continuationHash,
        ownerId: loaded.record.ownerId,
        expectedRevision: loaded.record.revision,
        terminalReceiptHash: receiptHash,
      })
    },
  })
  return coordinator
}

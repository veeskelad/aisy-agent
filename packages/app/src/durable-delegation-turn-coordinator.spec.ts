import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedWorkBinding } from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'

import type { DurableDelegationResolutionRequestV2 } from './durable-delegation-live-adapter.js'
import { makeDurableDelegationTurnCoordinatorV1 } from './durable-delegation-turn-coordinator.js'
import {
  durableParentContinuationWorkBindingHash,
  makeNodeDurableParentContinuationStore,
} from './durable-parent-continuation.js'
import { makeDurableTurnActorProductionPortsV1 } from './durable-turn-actor-production-ports.js'
import { makeNodeDurableTurnActorController } from './durable-turn-actor.js'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

const roots: string[] = []
const BINDING_HASH = 'a'.repeat(64)
const LIVENESS_HASH = 'b'.repeat(64)
const PARENT_NONCE = 'p'.repeat(43)
const CHILD_NONCE = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE_ID = 'l'.repeat(43)
const CANCELLATION_RECEIPT_HASH = '8'.repeat(64)

const binding: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
})

const retryRequest: DurableDelegationResolutionRequestV2 = Object.freeze({
  runRootHash: '1'.repeat(64),
  taskId: 'review',
  controlLogicalSlotHash: '2'.repeat(64),
  journalLogicalSlotHash: '3'.repeat(64),
  attempt: 1,
  phase: 'provider',
  ordinal: 1,
  retryClass: 'retry-once',
})

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-turn-coordinator-')))
  chmodSync(value, 0o700)
  roots.push(value)
  return value
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineLease(): Promise<ExecutionSupervisorLease> {
  const replies = [
    frame({
      version: 3, type: 'hello-challenge', requestId: 'hello-1', deadlineAtMs: 3_000,
      parentNonce: PARENT_NONCE,
    }),
    frame({
      version: 3, type: 'hello-ack', requestId: 'hello-1', deadlineAtMs: 3_000,
      sessionId: SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1', parentNonce: PARENT_NONCE, childNonce: CHILD_NONCE,
        sessionId: SESSION, livenessDescriptorHash: LIVENESS_HASH,
      }),
    }),
    frame({
      version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: 3_000,
      sessionId: SESSION, bindingHash: BINDING_HASH, leaseId: LEASE_ID,
    }),
  ]
  const channel: ExecutionSupervisorChannel = {
    send: () => {},
    receive: async () => {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect: () => () => {},
    close: () => {},
  }
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => 'capture-1',
    randomNonce: () => CHILD_NONCE,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS_HASH,
  })
  return session.captureTurn(BINDING_HASH)
}

async function fixture(directory = root()) {
  const lease = await genuineLease()
  const continuation = makeNodeDurableParentContinuationStore({
    path: join(directory, 'parent-continuation.json'),
  })
  const captured = continuation.capture({
    ownerId: 'parent-owner',
    identity: {
      binding,
      workBindingHash: durableParentContinuationWorkBindingHash(binding),
      sessionId: binding.sessionId,
      turnId: 'telegram:42:turn-a',
      turnTs: '2026-08-13T10:00:00.000Z',
      supervisorBindingHash: BINDING_HASH,
      policyRevision: 'durable-parent-continuation-v1',
      spans: Object.freeze([
        Object.freeze({
          role: 'user' as const,
          provenance: 'operator' as const,
          text: 'Продолжай точный родительский ход.',
        }),
      ]),
    },
  })
  if (captured.kind !== 'captured' && captured.kind !== 'replayed') {
    throw new Error('capture failed')
  }
  let resolutionApplied = false
  let replaySafe = true
  let sequence = 0
  let callbackPersistence = 0
  const retiredCancellations: Array<{ request: DurableDelegationResolutionRequestV2; receiptHash: string }> = []
  const ports = makeDurableTurnActorProductionPortsV1({
    continuation,
    currentLease: () => lease,
    assertBudget: () => true,
    assertResolutionApplied: () => resolutionApplied,
    assertClaimReplaySafe: () => replaySafe,
    assertCancellationQuiesced: () => true,
  })
  const actorPath = join(directory, 'turn-actor.sqlite3')
  const makeActor = () => makeNodeDurableTurnActorController({
    path: actorPath,
    ...ports,
    nowMs: () => 2_000,
    newActorId: () => `actor-${++sequence}`,
    newCardId: () => `card-${++sequence}`,
    newNonce: () => `nonce-${++sequence}`,
    newClaimId: () => `claim-${++sequence}`,
  })
  const makeCoordinator = (actor: ReturnType<typeof makeActor>) =>
    makeDurableDelegationTurnCoordinatorV1({
      continuation,
      actor,
      actorPorts: {
        admitTransportCallback(authority, stepUpVerified) {
          callbackPersistence += 1
          ports.admitTransportCallback(authority, stepUpVerified)
        },
      },
      budget: () => ({
        iterations: 2, inputTokens: 100, outputTokens: 40, spendNanos: 100,
        wallMs: 5_000, ledgerRevision: 1,
      }),
      chatId: 'chat-42',
      nowMs: () => 2_000,
      approvalTtlMs: 8_000,
      quiescenceReceipt: () => CANCELLATION_RECEIPT_HASH,
      retireCancelledRun(request, receiptHash) {
        retiredCancellations.push({ request, receiptHash })
      },
      newOwnerHash: () => '9'.repeat(64),
    })
  const actor = makeActor()
  return {
    directory, lease, continuation, ports, actorPath, actor,
    coordinator: makeCoordinator(actor),
    makeActor,
    makeCoordinator,
    setResolutionApplied(value: boolean) { resolutionApplied = value },
    setReplaySafe(value: boolean) { replaySafe = value },
    callbackPersistence: () => callbackPersistence,
    retiredCancellations,
  }
}

function confirm(fx: Awaited<ReturnType<typeof fixture>>, decision: 'confirmed' | 'rejected') {
  const pending = fx.coordinator.pendingCard()
  if (pending === null) throw new Error('card missing')
  const card = pending.card
  fx.coordinator.markCardDelivered({
    actorId: card.actorId,
    revision: card.revision,
    messageId: 'telegram-message-1',
  })
  return fx.coordinator.recordTransportDecision({
    actorId: card.actorId,
    actionId: card.actionId,
    actionHash: card.actionHash,
    cardId: card.cardId,
    operatorId: card.operatorId,
    chatId: card.chatId,
    sessionId: binding.sessionId,
    turnId: 'telegram:42:turn-a',
    nonce: card.nonce,
    decision,
    stepUpVerified: false,
  })
}

describe('durable delegation turn coordinator', () => {
  it('persists pause before card, records callback without external I/O and resumes after resolution', async () => {
    const fx = await fixture()
    fx.coordinator.onAmbiguity(retryRequest)
    expect(fx.continuation.load()).toMatchObject({
      status: 'ready', record: { phase: 'paused', ambiguity: retryRequest },
    })
    expect(confirm(fx, 'confirmed')).toMatchObject({ kind: 'recorded' })
    expect(fx.callbackPersistence()).toBe(1)
    expect(fx.coordinator.resolveAmbiguity(retryRequest)).toBeDefined()
    fx.setResolutionApplied(true)
    fx.coordinator.onResolutionApplied(retryRequest, 'retry-once')

    expect(fx.continuation.load()).toMatchObject({ status: 'ready', record: { phase: 'active' } })
    expect(fx.actor.manager.recover()).toEqual({ kind: 'none' })
    expect(() => fx.coordinator.onResolutionApplied(retryRequest, 'retry-once')).not.toThrow()
    expect(fx.coordinator.retireParent('8'.repeat(64))).toMatchObject({
      phase: 'terminal', terminalReceiptHash: '8'.repeat(64),
    })
    expect(fx.coordinator.retireParent('8'.repeat(64))).toMatchObject({ phase: 'terminal' })
    fx.actor.close()
  })

  it('reconciles a crash after claim before issuing replacement retry authority', async () => {
    const fx = await fixture()
    fx.coordinator.onAmbiguity(retryRequest)
    confirm(fx, 'confirmed')
    expect(fx.coordinator.resolveAmbiguity(retryRequest)).toBeDefined()
    fx.actor.close()

    const actor = fx.makeActor()
    const replacement = fx.makeCoordinator(actor)
    expect(replacement.recover()).toEqual({ kind: 'reconciliation-required' })
    expect(replacement.resolveAmbiguity(retryRequest)).toBeDefined()
    fx.setResolutionApplied(true)
    replacement.onResolutionApplied(retryRequest, 'retry-once')
    expect(actor.manager.recover()).toEqual({ kind: 'none' })
    actor.close()
  })

  it('maps rejection to exact cancel and resumes the parent only after it is durable', async () => {
    const fx = await fixture()
    fx.coordinator.onAmbiguity(retryRequest)
    confirm(fx, 'rejected')
    expect(fx.coordinator.resolveAmbiguity(retryRequest)).toBeDefined()
    fx.setResolutionApplied(true)
    fx.coordinator.onResolutionApplied(retryRequest, 'cancel')
    expect(fx.continuation.load()).toMatchObject({ status: 'ready', record: { phase: 'active' } })
    expect(fx.actor.manager.recover()).toEqual({ kind: 'none' })
    fx.actor.close()
  })

  it('rotates a delivered card after restart and invalidates the old callback', async () => {
    const fx = await fixture()
    fx.coordinator.onAmbiguity(retryRequest)
    const old = fx.coordinator.pendingCard()!.card
    fx.coordinator.markCardDelivered({
      actorId: old.actorId, revision: old.revision, messageId: 'telegram-message-1',
    })
    fx.actor.close()

    const actor = fx.makeActor()
    const replacement = fx.makeCoordinator(actor)
    const recovered = replacement.recover()
    expect(recovered.kind).toBe('card-pending')
    expect(recovered.card?.cardId).not.toBe(old.cardId)
    expect(() => replacement.recordTransportDecision({
      actorId: old.actorId, actionId: old.actionId, actionHash: old.actionHash,
      cardId: old.cardId, operatorId: old.operatorId, chatId: old.chatId,
      sessionId: binding.sessionId, turnId: 'telegram:42:turn-a', nonce: old.nonce,
      decision: 'confirmed', stepUpVerified: false,
    })).toThrow()
    actor.close()
  })

  it('terminalizes new-task-only ambiguity without creating retry actor authority', async () => {
    const fx = await fixture()
    const mutation = Object.freeze({
      ...retryRequest,
      phase: 'tool' as const,
      retryClass: 'new-task-only' as const,
    })
    fx.coordinator.onAmbiguity(mutation)
    expect(fx.continuation.load()).toMatchObject({ status: 'ready', record: { phase: 'terminal' } })
    expect(fx.coordinator.pendingCard()).toBeNull()
    expect(fx.coordinator.resolveAmbiguity(mutation)).toBeUndefined()
    expect(fx.actor.manager.recover()).toEqual({ kind: 'none' })
    fx.actor.close()
  })

  it('makes /stop win one durable CAS, invalidates the card and retires the exact run', async () => {
    const fx = await fixture()
    fx.coordinator.onAmbiguity(retryRequest)
    const staleCard = fx.coordinator.pendingCard()!.card

    expect(fx.coordinator.requestStop()).toEqual({
      kind: 'cancelled', receiptHash: CANCELLATION_RECEIPT_HASH,
    })
    expect(fx.continuation.load()).toMatchObject({
      status: 'ready',
      record: {
        phase: 'terminal',
        ambiguity: retryRequest,
        cancellationReceiptHash: CANCELLATION_RECEIPT_HASH,
        terminalReceiptHash: CANCELLATION_RECEIPT_HASH,
      },
    })
    expect(fx.actor.manager.recover()).toEqual({ kind: 'none' })
    expect(() => fx.coordinator.recordTransportDecision({
      actorId: staleCard.actorId, actionId: staleCard.actionId,
      actionHash: staleCard.actionHash, cardId: staleCard.cardId,
      operatorId: staleCard.operatorId, chatId: staleCard.chatId,
      sessionId: binding.sessionId, turnId: 'telegram:42:turn-a', nonce: staleCard.nonce,
      decision: 'confirmed', stepUpVerified: false,
    })).toThrow()
    expect(fx.retiredCancellations).toEqual([
      { request: retryRequest, receiptHash: CANCELLATION_RECEIPT_HASH },
    ])
    expect(fx.coordinator.requestStop()).toEqual({
      kind: 'replayed', receiptHash: CANCELLATION_RECEIPT_HASH,
    })
    fx.actor.close()
  })

  it('finishes /stop after crashes before and after actor cancellation terminal', async () => {
    const first = await fixture()
    first.coordinator.onAmbiguity(retryRequest)
    const active = first.actor.manager.recover()
    if (active.kind === 'none' || active.kind === 'authority-lost') throw new Error('actor missing')
    first.actor.manager.requestCancel({
      actorId: active.record.identity.actorId,
      expectedRevision: active.record.revision,
    })
    first.actor.close()

    const replacementActor = first.makeActor()
    const replacement = first.makeCoordinator(replacementActor)
    expect(replacement.recover()).toEqual({ kind: 'cancelling' })
    expect(replacement.requestStop()).toMatchObject({ kind: 'cancelled' })
    replacementActor.close()

    const second = await fixture()
    second.coordinator.onAmbiguity(retryRequest)
    const paused = second.continuation.load()
    const actorState = second.actor.manager.recover()
    if (paused.status !== 'ready' || paused.record.ambiguity === undefined ||
      actorState.kind === 'none' || actorState.kind === 'authority-lost') {
      throw new Error('cancellation fixture missing')
    }
    const cancellingActor = second.actor.manager.requestCancel({
      actorId: actorState.record.identity.actorId,
      expectedRevision: actorState.record.revision,
    })
    second.continuation.beginCancellation({
      continuationHash: paused.record.continuationHash,
      ownerId: paused.record.ownerId,
      expectedRevision: paused.record.revision,
      operationHash: paused.record.ambiguity.operationHash,
      cancellationReceiptHash: CANCELLATION_RECEIPT_HASH,
    })
    const acknowledgement = second.actor.manager.acknowledgeCancellation({
      actorId: cancellingActor.identity.actorId,
      expectedRevision: cancellingActor.revision,
      receiptHash: CANCELLATION_RECEIPT_HASH,
    })
    second.actor.manager.finishCancellation({ acknowledgement, code: 'operator-stop' })
    second.actor.close()

    const finalActor = second.makeActor()
    const finalCoordinator = second.makeCoordinator(finalActor)
    expect(finalCoordinator.requestStop()).toMatchObject({ kind: 'cancelled' })
    expect(second.continuation.load()).toMatchObject({
      status: 'ready', record: { phase: 'terminal' },
    })
    finalActor.close()
  })
})

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ResolvedWorkBinding } from '@aisy/core'

import { decodeDurableTurnCallback, encodeDurableTurnCallback } from '../src/bot.ts'
import type { DurableDelegationResolutionRequestV2 } from '../src/durable-delegation-live-adapter.ts'
import { makeDurableDelegationTurnCoordinatorV1 } from '../src/durable-delegation-turn-coordinator.ts'
import {
  durableParentContinuationWorkBindingHash,
  makeNodeDurableParentContinuationStore,
} from '../src/durable-parent-continuation.ts'
import { makeDurableTurnActorProductionPortsV1 } from '../src/durable-turn-actor-production-ports.ts'
import { makeNodeDurableTurnActorController } from '../src/durable-turn-actor.ts'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
} from '../src/execution-supervisor-ipc.ts'

const stateRoot = required('AISY_DURABLE_TURN_STATE_ROOT')
const tracePath = required('AISY_DURABLE_TURN_TRACE')
const phase = required('AISY_DURABLE_TURN_PHASE')
const recovery = process.env['AISY_DURABLE_TURN_RECOVERY'] === '1'

const BINDING_HASH = 'a'.repeat(64)
const LIVENESS_HASH = 'b'.repeat(64)
const PARENT_NONCE = 'p'.repeat(43)
const CHILD_NONCE = 'c'.repeat(43)
const SUPERVISOR_SESSION = 's'.repeat(43)
const LEASE_ID = 'l'.repeat(43)
const CANCELLATION_RECEIPT_HASH = '8'.repeat(64)

const binding: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
})

const request: DurableDelegationResolutionRequestV2 = Object.freeze({
  runRootHash: '1'.repeat(64),
  taskId: 'review',
  controlLogicalSlotHash: '2'.repeat(64),
  journalLogicalSlotHash: '3'.repeat(64),
  attempt: 1,
  phase: 'provider',
  ordinal: 1,
  retryClass: 'retry-once',
})

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name}_MISSING`)
  return value
}

function trace(line: string): void {
  appendFileSync(tracePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineLease() {
  const replies = [
    frame({
      version: 3, type: 'hello-challenge', requestId: 'hello-1', deadlineAtMs: 3_000,
      parentNonce: PARENT_NONCE,
    }),
    frame({
      version: 3, type: 'hello-ack', requestId: 'hello-1', deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1', parentNonce: PARENT_NONCE, childNonce: CHILD_NONCE,
        sessionId: SUPERVISOR_SESSION, livenessDescriptorHash: LIVENESS_HASH,
      }),
    }),
    frame({
      version: 3, type: 'capture-ack', requestId: 'capture-1', deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION, bindingHash: BINDING_HASH, leaseId: LEASE_ID,
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

mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
chmodSync(stateRoot, 0o700)
const lease = await genuineLease()
const continuation = makeNodeDurableParentContinuationStore({
  path: join(stateRoot, 'parent-continuation.json'),
})
let resolutionApplied = false
let sequence = 0
const ports = makeDurableTurnActorProductionPortsV1({
  continuation,
  currentLease: () => lease,
  assertBudget: () => true,
  assertResolutionApplied: () => resolutionApplied,
  assertClaimReplaySafe: () => true,
  assertCancellationQuiesced: () => true,
})
const actor = makeNodeDurableTurnActorController({
  path: join(stateRoot, 'turn-actor.sqlite3'),
  ...ports,
  nowMs: () => 2_000,
  newActorId: () => `actor-${++sequence}`,
  newCardId: () => `card-${++sequence}`,
  newNonce: () => `nonce-${++sequence}`,
  newClaimId: () => `claim-${++sequence}`,
})
const coordinator = makeDurableDelegationTurnCoordinatorV1({
  continuation,
  actor,
  actorPorts: ports,
  budget: () => ({
    iterations: 2, inputTokens: 100, outputTokens: 40, spendNanos: 100,
    wallMs: 5_000, ledgerRevision: 2,
  }),
  chatId: '42',
  nowMs: () => 2_000,
  approvalTtlMs: 8_000,
  quiescenceReceipt: () => CANCELLATION_RECEIPT_HASH,
  retireCancelledRun: () => { trace('run-retired') },
  newOwnerHash: () => '9'.repeat(64),
})

function stop(label: string): never {
  trace(`stop ${label}`)
  process.kill(process.pid, 'SIGSTOP')
  throw new Error('SIGSTOP_RETURNED')
}

function capturedParent(): void {
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
  if (captured.kind !== 'captured') throw new Error('CAPTURE_FAILED')
}

function pendingCard() {
  const pending = coordinator.pendingCard()
  if (pending === null) throw new Error('CARD_MISSING')
  return pending.card
}

if (!recovery) {
  capturedParent()
  coordinator.onAmbiguity(request)
  if (phase === 'pause-before-card') stop(phase)

  const card = pendingCard()
  coordinator.markCardDelivered({
    actorId: card.actorId,
    revision: card.revision,
    messageId: 'telegram-message-1',
  })
  if (phase === 'card-delivered') stop(phase)

  if (phase === 'callback-recorded' || phase === 'actor-claimed' ||
    phase === 'resolution-applied' || phase === 'stop-after-callback' ||
    phase === 'stop-after-claim') {
    const callbackData = encodeDurableTurnCallback(card.actorId, card.nonce, 'retry-once')
    const decoded = decodeDurableTurnCallback(callbackData)
    if (decoded === null) throw new Error('CALLBACK_INVALID')
    coordinator.recordCardDecision({
      actorId: decoded.actorId,
      operatorId: card.operatorId,
      chatId: card.chatId,
      messageId: 'telegram-message-1',
      nonce: decoded.nonce,
      decision: 'confirmed',
      stepUpVerified: false,
    })
    if (phase === 'callback-recorded') stop(phase)
    if (phase === 'stop-after-callback') {
      const resumeReady = actor.manager.recover()
      if (resumeReady.kind === 'none' || resumeReady.kind === 'authority-lost') {
        throw new Error('ACTOR_MISSING')
      }
      actor.manager.requestCancel({
        actorId: resumeReady.record.identity.actorId,
        expectedRevision: resumeReady.record.revision,
      })
      stop(phase)
    }
    coordinator.resolveAmbiguity(request)
    if (phase === 'actor-claimed') stop(phase)
    if (phase === 'stop-after-claim') {
      const claimed = actor.manager.recover()
      if (claimed.kind === 'none' || claimed.kind === 'authority-lost') {
        throw new Error('ACTOR_MISSING')
      }
      actor.manager.requestCancel({
        actorId: claimed.record.identity.actorId,
        expectedRevision: claimed.record.revision,
      })
      stop(phase)
    }
    const parent = continuation.load()
    if (parent.status !== 'ready' || parent.record.phase !== 'paused') {
      throw new Error('PARENT_NOT_PAUSED')
    }
    continuation.resume({
      continuationHash: parent.record.continuationHash,
      ownerId: parent.record.ownerId,
      expectedRevision: parent.record.revision,
      operationHash: parent.record.ambiguity!.operationHash,
    })
    stop(phase)
  }

  const recovered = actor.manager.recover()
  if (recovered.kind === 'none' || recovered.kind === 'authority-lost') {
    throw new Error('ACTOR_MISSING')
  }
  const cancelling = actor.manager.requestCancel({
    actorId: recovered.record.identity.actorId,
    expectedRevision: recovered.record.revision,
  })
  if (phase === 'stop-requested') stop(phase)
  const parent = continuation.load()
  if (parent.status !== 'ready' || parent.record.phase !== 'paused') {
    throw new Error('PARENT_NOT_PAUSED')
  }
  continuation.beginCancellation({
    continuationHash: parent.record.continuationHash,
    ownerId: parent.record.ownerId,
    expectedRevision: parent.record.revision,
    operationHash: parent.record.ambiguity!.operationHash,
    cancellationReceiptHash: CANCELLATION_RECEIPT_HASH,
  })
  const acknowledgement = actor.manager.acknowledgeCancellation({
    actorId: cancelling.identity.actorId,
    expectedRevision: cancelling.revision,
    receiptHash: CANCELLATION_RECEIPT_HASH,
  })
  actor.manager.finishCancellation({ acknowledgement, code: 'operator-stop' })
  stop(phase)
}

if (phase === 'pause-before-card' || phase === 'card-delivered') {
  const result = coordinator.recover()
  trace(`recovered ${result.kind}`)
} else if (phase === 'callback-recorded' || phase === 'actor-claimed') {
  coordinator.resolveAmbiguity(request)
  resolutionApplied = true
  coordinator.onResolutionApplied(request, 'retry-once')
  trace('recovered completed')
} else if (phase === 'resolution-applied') {
  resolutionApplied = true
  coordinator.onResolutionApplied(request, 'retry-once')
  trace('recovered completed')
} else if (phase === 'stop-requested' || phase === 'stop-after-callback' ||
  phase === 'stop-after-claim' || phase === 'actor-cancelled') {
  const result = coordinator.requestStop()
  trace(`recovered ${result.kind}`)
} else {
  throw new Error('UNKNOWN_PHASE')
}

actor.close()

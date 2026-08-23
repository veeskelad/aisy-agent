import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedWorkBinding } from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  durableParentContinuationWorkBindingHash,
  makeNodeDurableParentContinuationStore,
  type DurableParentContinuationRecordV1,
} from './durable-parent-continuation.js'
import {
  durableAmbiguityOperationId,
  DurableTurnActorProductionPortsError,
  makeDurableTurnActorProductionPortsV1,
} from './durable-turn-actor-production-ports.js'
import {
  DurableTurnActorError,
  durableTurnWorkBindingHash,
  makeNodeDurableTurnActorController,
  type DurableTurnActorIdentityV1,
  type DurableTurnApprovalCardV1,
  type DurableTurnBudgetV1,
} from './durable-turn-actor.js'
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
const RUN_ROOT_HASH = 'b'.repeat(64)
const CONTROL_SLOT_HASH = 'c'.repeat(64)
const JOURNAL_SLOT_HASH = 'd'.repeat(64)
const LIVENESS_HASH = 'e'.repeat(64)
const PARENT_NONCE = 'p'.repeat(43)
const CHILD_NONCE = 'c'.repeat(43)
const SUPERVISOR_SESSION = 's'.repeat(43)
const LEASE_ID = 'l'.repeat(43)
const RECEIPT_HASH = 'f'.repeat(64)

const binding: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
})

const budget: DurableTurnBudgetV1 = Object.freeze({
  iterations: 2,
  inputTokens: 100,
  outputTokens: 40,
  spendNanos: 123_456_789,
  wallMs: 5_000,
  ledgerRevision: 7,
})

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-turn-production-ports-')))
  chmodSync(value, 0o700)
  roots.push(value)
  return value
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineLease(): Promise<Readonly<{
  lease: ExecutionSupervisorLease
  disconnect(): void
}>> {
  const replies = [
    frame({
      version: 3,
      type: 'hello-challenge',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      parentNonce: PARENT_NONCE,
    }),
    frame({
      version: 3,
      type: 'hello-ack',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1',
        parentNonce: PARENT_NONCE,
        childNonce: CHILD_NONCE,
        sessionId: SUPERVISOR_SESSION,
        livenessDescriptorHash: LIVENESS_HASH,
      }),
    }),
    frame({
      version: 3,
      type: 'capture-ack',
      requestId: 'capture-1',
      deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION,
      bindingHash: BINDING_HASH,
      leaseId: LEASE_ID,
    }),
  ]
  const listeners = new Set<() => void>()
  const channel: ExecutionSupervisorChannel = {
    send: () => {},
    receive: async () => {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: () => {},
  }
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => 'capture-1',
    randomNonce: () => CHILD_NONCE,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS_HASH,
  })
  return Object.freeze({
    lease: await session.captureTurn(BINDING_HASH),
    disconnect() { for (const listener of listeners) listener() },
  })
}

function pausedContinuation(directory: string): Readonly<{
  store: ReturnType<typeof makeNodeDurableParentContinuationStore>
  record: DurableParentContinuationRecordV1
}> {
  const store = makeNodeDurableParentContinuationStore({
    path: join(directory, 'parent-continuation.json'),
  })
  const captured = store.capture({
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
  if (captured.kind !== 'captured') throw new Error('capture failed')
  const record = store.pause({
    continuationHash: captured.record.continuationHash,
    ownerId: captured.record.ownerId,
    expectedRevision: captured.record.revision,
    request: {
      runRootHash: RUN_ROOT_HASH,
      taskId: 'review',
      controlLogicalSlotHash: CONTROL_SLOT_HASH,
      journalLogicalSlotHash: JOURNAL_SLOT_HASH,
      attempt: 1,
      phase: 'provider',
      ordinal: 1,
      retryClass: 'retry-once',
    },
  })
  return Object.freeze({ store, record })
}

function actorIdentity(record: DurableParentContinuationRecordV1): Omit<
  DurableTurnActorIdentityV1,
  'schemaVersion' | 'actorId'
> {
  if (record.ambiguity === undefined) throw new Error('ambiguity missing')
  return {
    operationId: durableAmbiguityOperationId(record.ambiguity.operationHash),
    operationHash: record.ambiguity.operationHash,
    continuationHash: record.continuationHash,
    binding,
    workBindingHash: durableTurnWorkBindingHash(binding),
    sessionId: binding.sessionId,
    turnId: record.identity.turnId,
    supervisorBindingHash: BINDING_HASH,
    policyRevision: record.identity.policyRevision,
    budget,
  }
}

function callbackAuthority(card: DurableTurnApprovalCardV1) {
  return Object.freeze({
    actorId: card.actorId,
    actionId: card.actionId,
    actionHash: card.actionHash,
    cardId: card.cardId,
    operatorId: card.operatorId,
    chatId: card.chatId,
    sessionId: binding.sessionId,
    turnId: 'telegram:42:turn-a',
  })
}

describe('durable turn actor production ports', () => {
  it('binds a real held supervisor lease, exact paused continuation and one-shot callback', async () => {
    const directory = root()
    const supervised = await genuineLease()
    const continuation = pausedContinuation(directory)
    let budgetChecks = 0
    let replayChecks = 0
    let cancellationChecks = 0
    const ports = makeDurableTurnActorProductionPortsV1({
      continuation: continuation.store,
      currentLease: () => supervised.lease,
      assertBudget(candidate) {
        budgetChecks += 1
        return JSON.stringify(candidate) === JSON.stringify(budget)
      },
      assertResolutionApplied: () => true,
      assertClaimReplaySafe() { replayChecks += 1; return true },
      assertCancellationQuiesced() { cancellationChecks += 1; return true },
    })
    let sequence = 0
    const controller = makeNodeDurableTurnActorController({
      path: join(directory, 'turn-actor.sqlite3'),
      ...ports,
      nowMs: () => 2_000,
      newActorId: () => `actor-${++sequence}`,
      newCardId: () => `card-${++sequence}`,
      newNonce: () => `nonce-${++sequence}`,
      newClaimId: () => `claim-${++sequence}`,
    })
    const paused = controller.manager.pause({
      identity: actorIdentity(continuation.record),
      approval: {
        actionId: 'retry-provider-once',
        tier: 'tier-2',
        requiresStepUp: false,
        canRememberSimilar: false,
        chatId: 'chat-42',
        expiresAtMs: 10_000,
      },
    })
    expect(paused.kind).toBe('paused')
    if (paused.kind !== 'paused') throw new Error('actor pause failed')
    controller.manager.markCardDelivered({
      actorId: paused.record.identity.actorId,
      expectedRevision: paused.record.revision,
      messageId: 'telegram-message-1',
    })
    const authority = callbackAuthority(paused.card)
    ports.admitTransportCallback(authority, false)
    expect(() => ports.admitTransportCallback(authority, false)).toThrowError(
      new DurableTurnActorProductionPortsError('DURABLE_TURN_PRODUCTION_PORTS_ADMISSION_DENIED'),
    )
    const admission = controller.manager.admitCallback(authority)
    const decision = controller.callback.recordDecision({
      admission,
      nonce: paused.card.nonce,
      decision: 'confirmed',
    })

    expect(decision).toMatchObject({ kind: 'recorded', record: { phase: 'resume-ready' } })
    expect(budgetChecks).toBeGreaterThan(0)
    expect(replayChecks).toBe(0)
    expect(cancellationChecks).toBe(0)
    expect(continuation.store.load()).toEqual({ status: 'ready', record: continuation.record })
    controller.close()
  })

  it('denies structural or lost lease authority before consulting budgets', async () => {
    const directory = root()
    const supervised = await genuineLease()
    const continuation = pausedContinuation(directory)
    let selected: ExecutionSupervisorLease | null = {
      ...supervised.lease,
      isHeld: () => true,
    } as ExecutionSupervisorLease
    let budgetChecks = 0
    const ports = makeDurableTurnActorProductionPortsV1({
      continuation: continuation.store,
      currentLease: () => selected,
      assertBudget() { budgetChecks += 1; return true },
      assertResolutionApplied: () => true,
      assertClaimReplaySafe: () => true,
      assertCancellationQuiesced: () => true,
    })
    const identity = actorIdentity(continuation.record)

    expect(ports.operationControl.assertHeld(identity)).toBe(false)
    expect(budgetChecks).toBe(0)
    selected = supervised.lease
    expect(ports.operationControl.assertHeld(identity)).toBe(true)
    expect(budgetChecks).toBe(1)
    supervised.disconnect()
    expect(ports.operationControl.assertHeld(identity)).toBe(false)
    expect(budgetChecks).toBe(1)
  })

  it('consumes mismatched callback admission fail-closed and requires a new transport admission', async () => {
    const directory = root()
    const supervised = await genuineLease()
    const continuation = pausedContinuation(directory)
    const ports = makeDurableTurnActorProductionPortsV1({
      continuation: continuation.store,
      currentLease: () => supervised.lease,
      assertBudget: () => true,
      assertResolutionApplied: () => true,
      assertClaimReplaySafe: () => true,
      assertCancellationQuiesced: () => true,
    })
    const exact = Object.freeze({
      actorId: 'actor-1', actionId: 'action-1', actionHash: '1'.repeat(64), cardId: 'card-1',
      operatorId: binding.operatorId, chatId: 'chat-42', sessionId: binding.sessionId,
      turnId: 'telegram:42:turn-a',
    })
    ports.admitTransportCallback(exact, true)
    expect(ports.callbackAdmission.assertAdmitted({ ...exact, cardId: 'card-2' })).toBe(false)
    expect(ports.callbackAdmission.assertAdmitted(exact)).toBe(false)
    ports.admitTransportCallback(exact, true)
    expect(ports.callbackAdmission.assertAdmitted(exact)).toBe('step-up-admitted')
    expect(ports.callbackAdmission.assertAdmitted(exact)).toBe(false)
  })

  it('reissues a claim after restart only through exact external replay reconciliation', async () => {
    const directory = root()
    const supervised = await genuineLease()
    const continuation = pausedContinuation(directory)
    let replaySafe = false
    const reconciliationAuthorities: unknown[] = []
    const ports = makeDurableTurnActorProductionPortsV1({
      continuation: continuation.store,
      currentLease: () => supervised.lease,
      assertBudget: () => true,
      assertResolutionApplied: () => true,
      assertClaimReplaySafe(authority) {
        reconciliationAuthorities.push(structuredClone(authority))
        return replaySafe
      },
      assertCancellationQuiesced: () => true,
    })
    let sequence = 0
    const options = {
      path: join(directory, 'turn-actor.sqlite3'),
      ...ports,
      nowMs: () => 2_000,
      newActorId: () => `actor-${++sequence}`,
      newCardId: () => `card-${++sequence}`,
      newNonce: () => `nonce-${++sequence}`,
      newClaimId: () => `claim-${++sequence}`,
    }
    const first = makeNodeDurableTurnActorController(options)
    const paused = first.manager.pause({
      identity: actorIdentity(continuation.record),
      approval: {
        actionId: 'retry-provider-once', tier: 'tier-2', requiresStepUp: false,
        canRememberSimilar: false, chatId: 'chat-42', expiresAtMs: 10_000,
      },
    })
    if (paused.kind !== 'paused') throw new Error('actor pause failed')
    first.manager.markCardDelivered({
      actorId: paused.record.identity.actorId,
      expectedRevision: paused.record.revision,
      messageId: 'telegram-message-1',
    })
    const authority = callbackAuthority(paused.card)
    ports.admitTransportCallback(authority, false)
    const admission = first.manager.admitCallback(authority)
    const decided = first.callback.recordDecision({
      admission, nonce: paused.card.nonce, decision: 'confirmed',
    })
    if (decided.kind !== 'recorded') throw new Error('decision failed')
    const claimed = first.manager.claimResume({
      actorId: paused.record.identity.actorId,
      expectedRevision: decided.record.revision,
      ownerHash: '2'.repeat(64),
    })
    if (claimed.kind !== 'claimed') throw new Error('claim failed')
    first.close()

    const replacement = makeNodeDurableTurnActorController(options)
    expect(replacement.manager.recover()).toMatchObject({ kind: 'reconciliation-required' })
    expect(() => replacement.manager.reconcileClaim({
      actorId: paused.record.identity.actorId,
      expectedRevision: claimed.record.revision,
      ownerHash: '3'.repeat(64),
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    replaySafe = true
    const reconciled = replacement.manager.reconcileClaim({
      actorId: paused.record.identity.actorId,
      expectedRevision: claimed.record.revision,
      ownerHash: '3'.repeat(64),
    })
    expect(reconciled).toMatchObject({
      kind: 'claimed',
      record: { claim: { ownerHash: '3'.repeat(64) } },
    })
    expect(reconciliationAuthorities).toHaveLength(2)
    replacement.close()
  })

  it('finishes cancellation only after an exact external quiescence receipt', async () => {
    const directory = root()
    const supervised = await genuineLease()
    const continuation = pausedContinuation(directory)
    let quiesced = false
    const receipts: string[] = []
    const ports = makeDurableTurnActorProductionPortsV1({
      continuation: continuation.store,
      currentLease: () => supervised.lease,
      assertBudget: () => true,
      assertResolutionApplied: () => true,
      assertClaimReplaySafe: () => true,
      assertCancellationQuiesced(authority) {
        receipts.push(authority.receiptHash)
        return quiesced && authority.receiptHash === RECEIPT_HASH
      },
    })
    let sequence = 0
    const controller = makeNodeDurableTurnActorController({
      path: join(directory, 'turn-actor.sqlite3'),
      ...ports,
      nowMs: () => 2_000,
      newActorId: () => `actor-${++sequence}`,
      newCardId: () => `card-${++sequence}`,
      newNonce: () => `nonce-${++sequence}`,
      newClaimId: () => `claim-${++sequence}`,
    })
    const paused = controller.manager.pause({
      identity: actorIdentity(continuation.record),
      approval: {
        actionId: 'retry-provider-once', tier: 'tier-2', requiresStepUp: false,
        canRememberSimilar: false, chatId: 'chat-42', expiresAtMs: 10_000,
      },
    })
    if (paused.kind !== 'paused') throw new Error('actor pause failed')
    const cancelling = controller.manager.requestCancel({
      actorId: paused.record.identity.actorId,
      expectedRevision: paused.record.revision,
    })
    expect(() => controller.manager.acknowledgeCancellation({
      actorId: paused.record.identity.actorId,
      expectedRevision: cancelling.revision,
      receiptHash: RECEIPT_HASH,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    continuation.store.beginCancellation({
      continuationHash: continuation.record.continuationHash,
      ownerId: continuation.record.ownerId,
      expectedRevision: continuation.record.revision,
      operationHash: continuation.record.ambiguity!.operationHash,
      cancellationReceiptHash: RECEIPT_HASH,
    })
    expect(() => controller.manager.acknowledgeCancellation({
      actorId: paused.record.identity.actorId,
      expectedRevision: cancelling.revision,
      receiptHash: RECEIPT_HASH,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    quiesced = true
    const acknowledgement = controller.manager.acknowledgeCancellation({
      actorId: paused.record.identity.actorId,
      expectedRevision: cancelling.revision,
      receiptHash: RECEIPT_HASH,
    })
    expect(controller.manager.finishCancellation({ acknowledgement, code: 'operator-stop' }))
      .toMatchObject({ phase: 'terminal', terminal: { receiptHash: RECEIPT_HASH } })
    expect(receipts).toEqual([RECEIPT_HASH, RECEIPT_HASH])
    controller.close()
  })
})

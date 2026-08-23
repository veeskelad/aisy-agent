import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DurableTurnActorError,
  durableTurnWorkBindingHash,
  makeDurableTurnStartupRecoveryPortV1,
  makeNodeDurableTurnActorController,
  type DurableTurnActorIdentityV1,
  type DurableTurnApprovalCardV1,
  type DurableTurnOperationControlPort,
  type DurableTurnPauseInputV1,
} from './durable-turn-actor.js'

const H = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const roots: string[] = []
let mintSequence = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: {
  held?: boolean
  path?: string
  clock?: { now: number }
  callbackAdmission?: false | 'admitted' | 'step-up-admitted'
  quiesced?: boolean
  replaySafe?: boolean
} = {}) {
  const root = options.path === undefined ? mkdtempSync(join(tmpdir(), 'aisy-turn-actor-')) : undefined
  if (root !== undefined) roots.push(root)
  const path = options.path ?? join(root!, 'turn-actor.sqlite3')
  const clock = options.clock ?? { now: 1_000 }
  let held = options.held ?? true
  const authorities: unknown[] = []
  const callbackAuthorities: unknown[] = []
  const cancellationAuthorities: unknown[] = []
  const reconciliationAuthorities: unknown[] = []
  const control: DurableTurnOperationControlPort = {
    assertHeld(authority) {
      authorities.push(structuredClone(authority))
      return held
    },
  }
  const controller = makeNodeDurableTurnActorController({
    path,
    operationControl: control,
    callbackAdmission: {
      assertAdmitted(authority) {
        callbackAuthorities.push(structuredClone(authority))
        return options.callbackAdmission ?? 'admitted'
      },
    },
    cancellationControl: {
      assertQuiesced(authority) {
        cancellationAuthorities.push(structuredClone(authority))
        return options.quiesced ?? true
      },
    },
    claimReconciliation: {
      assertReplaySafe(authority) {
        reconciliationAuthorities.push(structuredClone(authority))
        return options.replaySafe ?? false
      },
    },
    nowMs: () => clock.now,
    newActorId: () => `actor-${++mintSequence}`,
    newCardId: () => `card-${++mintSequence}`,
    newNonce: () => `nonce-${++mintSequence}`,
    newClaimId: () => `claim-${++mintSequence}`,
  })
  return {
    root: root ?? join(path, '..'),
    path,
    clock,
    controller,
    authorities,
    callbackAuthorities,
    cancellationAuthorities,
    reconciliationAuthorities,
    setHeld(value: boolean) { held = value },
  }
}

const binding = {
  operatorId: 'operator-1',
  profileId: 'profile-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
}

function pauseInput(overrides: Partial<DurableTurnPauseInputV1> = {}): DurableTurnPauseInputV1 {
  return {
    identity: {
      operationId: 'operation-1',
      operationHash: H,
      continuationHash: H2,
      binding,
      workBindingHash: durableTurnWorkBindingHash(binding),
      sessionId: binding.sessionId,
      turnId: 'turn-1',
      supervisorBindingHash: H,
      policyRevision: 'policy-1',
      budget: {
        iterations: 2,
        inputTokens: 100,
        outputTokens: 40,
        spendNanos: 123_456_789,
        wallMs: 5_000,
        ledgerRevision: 7,
      },
    },
    approval: {
      actionId: 'action-1',
      tier: 'tier-2',
      requiresStepUp: false,
      canRememberSimilar: false,
      chatId: 'chat-1',
      expiresAtMs: 10_000,
    },
    ...overrides,
  }
}

function pauseAndDeliver(fx: ReturnType<typeof fixture>): {
  actorId: string
  card: DurableTurnApprovalCardV1
  revision: number
} {
  const paused = fx.controller.manager.pause(pauseInput())
  expect(paused.kind).toBe('paused')
  if (paused.kind !== 'paused') throw new Error('expected paused')
  const delivered = fx.controller.manager.markCardDelivered({
    actorId: paused.record.identity.actorId,
    expectedRevision: paused.record.revision,
    messageId: 'message-1',
  })
  return { actorId: paused.record.identity.actorId, card: paused.card, revision: delivered.revision }
}

function decide(
  fx: ReturnType<typeof fixture>,
  card: DurableTurnApprovalCardV1,
  decision: 'confirmed' | 'rejected' = 'confirmed',
  admitted = admitCallback(fx, card),
) {
  return fx.controller.callback.recordDecision({
    admission: admitted,
    nonce: card.nonce,
    decision,
  })
}

function admitCallback(
  fx: ReturnType<typeof fixture>,
  card: DurableTurnApprovalCardV1,
) {
  return fx.controller.manager.admitCallback({
    actorId: card.actorId,
    actionId: card.actionId,
    actionHash: card.actionHash,
    cardId: card.cardId,
    operatorId: card.operatorId,
    chatId: card.chatId,
    sessionId: binding.sessionId,
    turnId: 'turn-1',
  })
}

describe('durable turn actor', () => {
  it('rejects a structurally forged unified recovery context before state read', async () => {
    const fx = fixture()
    const port = makeDurableTurnStartupRecoveryPortV1(fx.controller.manager)
    const context = Object.freeze({
      schemaVersion: 1 as const,
      bindingHash: H,
      authorityPhase: 'checkpoint-bound' as const,
      isHeld: () => true,
    })
    await expect(port.recover(context as never)).resolves.toEqual({
      kind: 'denied',
      code: 'DURABLE_TURN_RECOVERY_AUTHORITY_INVALID',
    })
    fx.controller.close()
  })

  it('persists exact identity, budget and approval without the raw nonce', () => {
    const fx = fixture()
    const paused = fx.controller.manager.pause(pauseInput())
    expect(paused.kind).toBe('paused')
    if (paused.kind !== 'paused') throw new Error('expected paused')

    expect(paused.record.identity.budget).toEqual(pauseInput().identity.budget)
    expect(paused.record.identity.binding).toEqual(binding)
    expect(paused.record.approval.actionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(paused.record.approval.nonceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(fx.path).includes(Buffer.from(paused.card.nonce))).toBe(false)
    expect(Object.keys(fx.controller.callback)).toEqual(['recordDecision'])
    expect(fx.controller.callback).not.toHaveProperty('manager')
    expect(fx.controller.callback).not.toHaveProperty('close')
    fx.controller.close()
  })

  it('enforces one nonterminal actor across sessions and frees admission only after terminal', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    expect(fx.controller.manager.admission('session-1')).toEqual({
      kind: 'busy-session', actorId: active.actorId,
    })
    expect(fx.controller.manager.admission('session-2')).toEqual({
      kind: 'busy-installation', actorId: active.actorId, sessionId: 'session-1',
    })
    expect(fx.controller.manager.pause(pauseInput())).toEqual({
      kind: 'busy-session', actorId: active.actorId,
    })

    const decided = decide(fx, active.card)
    expect(decided.kind).toBe('recorded')
    if (decided.kind !== 'recorded') throw new Error('expected decision')
    const claimed = fx.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decided.record.revision,
      ownerHash: H,
    })
    expect(claimed.kind).toBe('claimed')
    if (claimed.kind !== 'claimed') throw new Error('expected claim')
    const terminal = fx.controller.manager.finishWithPermit({
      permit: claimed.permit,
      terminal: { kind: 'completed', code: 'OK', receiptHash: H2 },
    })
    expect(terminal.phase).toBe('terminal')
    expect(fx.controller.manager.admission('session-2')).toEqual({ kind: 'free' })
    expect(() => fx.controller.manager.finishWithPermit({
      permit: claimed.permit,
      terminal: { kind: 'completed', code: 'OK' },
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    fx.controller.close()
  })

  it('recovers pending delivery after crash only through nonce rotation', () => {
    const first = fixture()
    const paused = first.controller.manager.pause(pauseInput())
    if (paused.kind !== 'paused') throw new Error('expected paused')
    const { path, clock } = first
    first.controller.close()

    const second = fixture({ path, clock })
    const recovered = second.controller.manager.recover()
    expect(recovered.kind).toBe('replace-card-required')
    if (recovered.kind !== 'replace-card-required') throw new Error('expected pending recovery')
    const rotated = second.controller.manager.rotatePendingCard({
      actorId: recovered.record.identity.actorId,
      expectedRevision: recovered.record.revision,
    })
    expect(rotated.card.cardId).not.toBe(paused.card.cardId)
    expect(() => admitCallback(second, paused.card)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'),
    )
    const delivered = second.controller.manager.markCardDelivered({
      actorId: rotated.record.identity.actorId,
      expectedRevision: rotated.record.revision,
      messageId: 'message-2',
    })
    expect(delivered.approval.actionHash).toBe(rotated.card.actionHash)
    expect(decide(second, rotated.card).kind).toBe('recorded')
    second.controller.close()
  })

  it('invalidates a delivered card when startup recovery replaces it', () => {
    const first = fixture()
    const active = pauseAndDeliver(first)
    const { path, clock } = first
    first.controller.close()

    const second = fixture({ path, clock })
    const recovered = second.controller.manager.recover()
    expect(recovered.kind).toBe('awaiting-decision')
    if (recovered.kind !== 'awaiting-decision') throw new Error('expected delivered recovery')
    const replacement = second.controller.manager.replaceCardAfterRecovery({
      actorId: active.actorId,
      expectedRevision: recovered.record.revision,
    })
    expect(replacement.card.cardId).not.toBe(active.card.cardId)
    expect(replacement.record.approval.delivery).toBe('pending')
    expect(() => admitCallback(second, active.card)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'),
    )
    second.controller.close()
  })

  it('makes callback versus stop race fail closed in either ordering', () => {
    const stopFirst = fixture()
    const a = pauseAndDeliver(stopFirst)
    const stopFirstAdmission = admitCallback(stopFirst, a.card)
    const cancelling = stopFirst.controller.manager.requestCancel({
      actorId: a.actorId,
      expectedRevision: a.revision,
    })
    expect(decide(stopFirst, a.card, 'confirmed', stopFirstAdmission)).toEqual({ kind: 'cancelled' })
    expect(stopFirst.controller.manager.recover().kind).toBe('continue-cancelling')
    stopFirst.controller.close()

    const callbackFirst = fixture()
    const b = pauseAndDeliver(callbackFirst)
    const decision = decide(callbackFirst, b.card)
    expect(decision.kind).toBe('recorded')
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const stopped = callbackFirst.controller.manager.requestCancel({
      actorId: b.actorId,
      expectedRevision: decision.record.revision,
    })
    expect(stopped.phase).toBe('cancelling')
    expect(stopped.revision).toBe(decision.record.revision + 1)
    expect(cancelling.decision).toBeNull()
    callbackFirst.controller.close()
  })

  it('makes claim versus stop one-shot and prevents a claimed permit from winning after stop', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    const decision = decide(fx, active.card)
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const claim = fx.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
      ownerHash: H,
    })
    if (claim.kind !== 'claimed') throw new Error('expected claim')
    const cancelling = fx.controller.manager.requestCancel({
      actorId: active.actorId,
      expectedRevision: claim.record.revision,
    })
    expect(cancelling.phase).toBe('cancelling')
    expect(() => fx.controller.manager.finishWithPermit({
      permit: claim.permit,
      terminal: { kind: 'completed', code: 'SHOULD_NOT_RUN' },
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    expect(() => fx.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: cancelling.revision,
      ownerHash: H,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    fx.controller.close()
  })

  it('does not recreate a process-local permit after a crash with a durable claim', () => {
    const first = fixture()
    const active = pauseAndDeliver(first)
    const decision = decide(first, active.card)
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const claim = first.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
      ownerHash: H,
    })
    if (claim.kind !== 'claimed') throw new Error('expected claim')
    const { path, clock } = first
    first.controller.close()

    const second = fixture({ path, clock })
    expect(second.controller.manager.recover().kind).toBe('reconciliation-required')
    expect(second.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: claim.record.revision,
      ownerHash: H,
    }).kind).toBe('reconciliation-required')
    expect(() => second.controller.manager.finishWithPermit({
      permit: claim.permit,
      terminal: { kind: 'completed', code: 'STALE_PROCESS' },
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    expect(() => second.controller.manager.reconcileClaim({
      actorId: active.actorId,
      expectedRevision: claim.record.revision,
      ownerHash: H2,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    second.controller.close()
  })

  it('reissues a process-local permit only after exact claim reconciliation', () => {
    const first = fixture()
    const active = pauseAndDeliver(first)
    const decision = decide(first, active.card)
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const claim = first.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
      ownerHash: H,
    })
    if (claim.kind !== 'claimed') throw new Error('expected claim')
    const { path, clock } = first
    first.controller.close()

    const second = fixture({ path, clock, replaySafe: true })
    const reconciled = second.controller.manager.reconcileClaim({
      actorId: active.actorId,
      expectedRevision: claim.record.revision,
      ownerHash: H2,
    })
    if (reconciled.kind !== 'claimed') throw new Error('expected reconciled claim')
    expect(reconciled.record.claim).toMatchObject({ ownerHash: H2 })
    expect(reconciled.record.claim?.claimId).not.toBe(claim.record.claim?.claimId)
    expect(second.reconciliationAuthorities).toEqual([expect.objectContaining({
      actorId: active.actorId,
      revision: claim.record.revision,
      operationId: 'operation-1',
      operationHash: H,
      continuationHash: H2,
      priorClaim: claim.record.claim,
      newOwnerHash: H2,
    })])
    expect(second.controller.manager.finishWithPermit({
      permit: reconciled.permit,
      terminal: { kind: 'completed', code: 'REPLAYED_AFTER_RECONCILIATION' },
    }).terminal?.code).toBe('REPLAYED_AFTER_RECONCILIATION')
    second.controller.close()
  })

  it('records a callback decision once and treats an exact duplicate as a replay', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    const first = decide(fx, active.card)
    const second = decide(fx, active.card)
    expect(first.kind).toBe('recorded')
    expect(second.kind).toBe('replayed')
    if (first.kind === 'recorded' && second.kind === 'replayed') {
      expect(second.record.revision).toBe(first.record.revision)
    }
    const contraryAdmission = admitCallback(fx, active.card)
    expect(fx.controller.callback.recordDecision({
      admission: contraryAdmission,
      nonce: active.card.nonce,
      decision: 'rejected',
    })).toEqual({ kind: 'stale' })
    const replayAdmission = admitCallback(fx, active.card)
    expect(fx.controller.callback.recordDecision({
      admission: replayAdmission,
      nonce: 'wrong-nonce',
      decision: 'confirmed',
    })).toEqual({ kind: 'stale' })
    fx.controller.close()
  })

  it('terminalizes rejection without ever issuing an execution permit', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    const decision = decide(fx, active.card, 'rejected')
    expect(decision.kind).toBe('recorded')
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const { path, clock } = fx
    fx.controller.close()

    const resumed = fixture({ path, clock })
    expect(resumed.controller.manager.recover().kind).toBe('rejection-ready')
    expect(() => resumed.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
      ownerHash: H,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    const terminal = resumed.controller.manager.terminalizeRejected({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
    })
    expect(terminal).toMatchObject({
      phase: 'terminal', terminal: { kind: 'denied', code: 'APPROVAL_REJECTED' },
    })
    expect(resumed.controller.manager.admission('session-2')).toEqual({ kind: 'free' })
    resumed.controller.close()
  })

  it('requires held authority at callback CAS and preserves the paused record on loss', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    const admission = admitCallback(fx, active.card)
    fx.setHeld(false)
    expect(() => decide(fx, active.card, 'confirmed', admission)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_AUTHORITY_LOST'),
    )
    fx.setHeld(true)
    expect(fx.controller.manager.recover()).toMatchObject({
      kind: 'awaiting-decision', record: { revision: active.revision },
    })
    expect(decide(fx, active.card, 'confirmed', admission).kind).toBe('recorded')
    fx.controller.close()
  })

  it('requires a code-owned step-up admission for tier-3 confirmation', () => {
    const denied = fixture({ callbackAdmission: 'admitted' })
    const paused = denied.controller.manager.pause(pauseInput({
      approval: {
        ...pauseInput().approval,
        tier: 'tier-3',
        requiresStepUp: true,
      },
    }))
    if (paused.kind !== 'paused') throw new Error('expected paused')
    denied.controller.manager.markCardDelivered({
      actorId: paused.record.identity.actorId,
      expectedRevision: paused.record.revision,
      messageId: 'message-tier3',
    })
    const unverified = admitCallback(denied, paused.card)
    expect(() => decide(denied, paused.card, 'confirmed', unverified)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'),
    )
    expect(decide(denied, paused.card, 'rejected', unverified).kind).toBe('recorded')
    denied.controller.close()

    const allowed = fixture({ callbackAdmission: 'step-up-admitted' })
    const allowedPaused = allowed.controller.manager.pause(pauseInput({
      approval: {
        ...pauseInput().approval,
        tier: 'tier-3',
        requiresStepUp: true,
      },
    }))
    if (allowedPaused.kind !== 'paused') throw new Error('expected paused')
    allowed.controller.manager.markCardDelivered({
      actorId: allowedPaused.record.identity.actorId,
      expectedRevision: allowedPaused.record.revision,
      messageId: 'message-tier3-ok',
    })
    expect(decide(allowed, allowedPaused.card).kind).toBe('recorded')
    allowed.controller.close()
  })

  it('persists cancellation before terminal and survives both crash boundaries', () => {
    const first = fixture()
    const active = pauseAndDeliver(first)
    const cancelling = first.controller.manager.requestCancel({
      actorId: active.actorId,
      expectedRevision: active.revision,
    })
    const { path, clock } = first
    first.controller.close()

    const second = fixture({ path, clock })
    expect(second.controller.manager.recover().kind).toBe('continue-cancelling')
    const acknowledgement = second.controller.manager.acknowledgeCancellation({
      actorId: active.actorId,
      expectedRevision: cancelling.revision,
      receiptHash: H,
    })
    const terminal = second.controller.manager.finishCancellation({
      acknowledgement,
      code: 'STOPPED',
    })
    expect(terminal.terminal?.kind).toBe('cancelled')
    second.controller.close()

    const third = fixture({ path, clock })
    expect(third.controller.manager.recover()).toEqual({ kind: 'none' })
    expect(third.controller.manager.admission('session-1')).toEqual({ kind: 'free' })
    third.controller.close()
  })

  it('requires a genuine quiescence acknowledgement with a mandatory receipt', () => {
    const denied = fixture({ quiesced: false })
    const active = pauseAndDeliver(denied)
    const cancelling = denied.controller.manager.requestCancel({
      actorId: active.actorId,
      expectedRevision: active.revision,
    })
    expect(() => denied.controller.manager.acknowledgeCancellation({
      actorId: active.actorId,
      expectedRevision: cancelling.revision,
      receiptHash: H,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    denied.controller.close()

    const allowed = fixture()
    const other = pauseAndDeliver(allowed)
    const stopping = allowed.controller.manager.requestCancel({
      actorId: other.actorId,
      expectedRevision: other.revision,
    })
    const acknowledgement = allowed.controller.manager.acknowledgeCancellation({
      actorId: other.actorId,
      expectedRevision: stopping.revision,
      receiptHash: H2,
    })
    expect(allowed.cancellationAuthorities).toEqual([{
      actorId: other.actorId,
      revision: stopping.revision,
      operationId: 'operation-1',
      operationHash: H,
      continuationHash: H2,
      workBindingHash: durableTurnWorkBindingHash(binding),
      sessionId: 'session-1',
      turnId: 'turn-1',
      supervisorBindingHash: H,
      policyRevision: 'policy-1',
      budget: pauseInput().identity.budget,
      receiptHash: H2,
    }])
    expect(() => allowed.controller.manager.finishCancellation({
      acknowledgement: { ...acknowledgement },
      code: 'FORGED',
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    expect(allowed.controller.manager.finishCancellation({
      acknowledgement,
      code: 'STOPPED',
    }).terminal?.receiptHash).toBe(H2)
    allowed.controller.close()
  })

  it('fails closed when operation authority is lost without mutating durable state', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    fx.setHeld(false)
    const recovery = fx.controller.manager.recover()
    expect(recovery.kind).toBe('authority-lost')
    expect(() => fx.controller.manager.requestCancel({
      actorId: active.actorId,
      expectedRevision: active.revision,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_AUTHORITY_LOST'))
    fx.setHeld(true)
    expect(fx.controller.manager.recover().kind).toBe('awaiting-decision')
    fx.controller.close()
  })

  it('denies wrong binding hashes, remembered approvals and structural capability copies', () => {
    const fx = fixture()
    expect(() => fx.controller.manager.pause(pauseInput({
      identity: { ...pauseInput().identity, workBindingHash: H },
    }))).toThrowError(new DurableTurnActorError('DURABLE_TURN_INPUT_INVALID'))

    expect(() => fx.controller.manager.pause(pauseInput({
      approval: { ...pauseInput().approval, canRememberSimilar: true },
    }))).toThrowError(new DurableTurnActorError('DURABLE_TURN_INPUT_INVALID'))

    const active = pauseAndDeliver(fx)
    const admission = admitCallback(fx, active.card)
    expect(() => fx.controller.callback.recordDecision({
      admission: { ...admission },
      nonce: active.card.nonce,
      decision: 'confirmed',
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    const decision = decide(fx, active.card)
    if (decision.kind !== 'recorded') throw new Error('expected decision')
    const claim = fx.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: decision.record.revision,
      ownerHash: H,
    })
    if (claim.kind !== 'claimed') throw new Error('expected claim')
    expect(() => fx.controller.manager.finishWithPermit({
      permit: { ...claim.permit },
      terminal: { kind: 'completed', code: 'COPY' },
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    fx.controller.close()
  })

  it('quarantines a corrupt durable row instead of admitting new work', () => {
    const first = fixture()
    const paused = first.controller.manager.pause(pauseInput())
    if (paused.kind !== 'paused') throw new Error('expected paused')
    const { path, clock } = first
    first.controller.close()
    const db = new Database(path)
    db.prepare('UPDATE durable_turn_actors SET record_json = ? WHERE actor_id = ?')
      .run('{"schemaVersion":1}', paused.record.identity.actorId)
    db.close()

    const second = fixture({ path, clock })
    expect(() => second.controller.manager.recover()).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_STORE_CORRUPT'),
    )
    expect(() => second.controller.manager.admission('session-2')).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_STORE_CORRUPT'),
    )
    second.controller.close()
  })

  it('rejects unsafe SQLite sidecars and extra schema objects', () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), 'aisy-turn-actor-sidecar-'))
    roots.push(sidecarRoot)
    const sidecarPath = join(sidecarRoot, 'turn-actor.sqlite3')
    writeFileSync(sidecarPath + '-wal', 'foreign', { mode: 0o600 })
    expect(() => fixture({ path: sidecarPath })).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_STORE_UNSAFE'),
    )

    const first = fixture()
    const { path, clock } = first
    first.controller.close()
    const database = new Database(path)
    database.exec('CREATE TABLE extra_state (value TEXT)')
    database.close()
    expect(() => fixture({ path, clock })).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_STORE_CORRUPT'),
    )
  })

  it('lets one of two admitted callback decisions win the durable CAS', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    const confirmed = admitCallback(fx, active.card)
    const rejected = admitCallback(fx, active.card)
    expect(decide(fx, active.card, 'confirmed', confirmed).kind).toBe('recorded')
    expect(decide(fx, active.card, 'rejected', rejected)).toEqual({ kind: 'stale' })
    expect(fx.controller.manager.recover().kind).toBe('resume-ready')
    fx.controller.close()
  })

  it('fails closed on clock rollback without changing the durable revision', () => {
    const clock = { now: 1_000 }
    const fx = fixture({ clock })
    const active = pauseAndDeliver(fx)
    const admission = admitCallback(fx, active.card)
    clock.now = 999
    expect(() => decide(fx, active.card, 'confirmed', admission)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'),
    )
    clock.now = 1_000
    expect(fx.controller.manager.recover()).toMatchObject({
      kind: 'awaiting-decision', record: { revision: active.revision },
    })
    fx.controller.close()
  })

  it('persists approval expiry so a wall-clock rollback cannot revive the callback', () => {
    const clock = { now: 1_000 }
    const first = fixture({ clock })
    const active = pauseAndDeliver(first)
    const admission = admitCallback(first, active.card)

    clock.now = 10_000
    expect(decide(first, active.card, 'confirmed', admission)).toEqual({ kind: 'expired' })
    const { path } = first
    first.controller.close()

    clock.now = 9_000
    const resumed = fixture({ path, clock })
    expect(resumed.controller.manager.recover()).toEqual({ kind: 'none' })
    expect(resumed.controller.manager.admission('session-2')).toEqual({ kind: 'free' })
    expect(() => decide(resumed, active.card, 'confirmed', admission)).toThrowError(
      new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'),
    )
    expect(() => resumed.controller.callback.recordDecision({
      admission: { ...admission },
      nonce: active.card.nonce,
      decision: 'confirmed',
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    expect(() => resumed.controller.manager.claimResume({
      actorId: active.actorId,
      expectedRevision: active.revision + 1,
      ownerHash: H,
    })).toThrowError(new DurableTurnActorError('DURABLE_TURN_TRANSITION_DENIED'))
    expect(resumed.authorities).toEqual([])
    expect(resumed.callbackAuthorities).toEqual([])
    expect(resumed.cancellationAuthorities).toEqual([])
    resumed.controller.close()
  })

  it('binds every operation-control check to the exact persisted authority tuple', () => {
    const fx = fixture()
    const active = pauseAndDeliver(fx)
    admitCallback(fx, active.card)
    expect(fx.authorities.length).toBeGreaterThanOrEqual(2)
    for (const authority of fx.authorities) {
      expect(authority).toEqual({
        operationId: 'operation-1',
        operationHash: H,
        continuationHash: H2,
        workBindingHash: durableTurnWorkBindingHash(binding),
        sessionId: 'session-1',
        turnId: 'turn-1',
        supervisorBindingHash: H,
        policyRevision: 'policy-1',
        budget: pauseInput().identity.budget,
      })
      expect(authority).not.toHaveProperty('binding')
    }
    expect(fx.callbackAuthorities).toEqual([{
      actorId: active.actorId,
      actionId: active.card.actionId,
      actionHash: active.card.actionHash,
      cardId: active.card.cardId,
      operatorId: 'operator-1',
      chatId: 'chat-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
    }])
    fx.controller.close()
  })
})

// Compile-time proof that the actor identity is a metadata-only envelope.
const _identityShape: DurableTurnActorIdentityV1 | undefined = undefined
void _identityShape

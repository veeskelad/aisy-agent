import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  durableExecutionEnvelopeHash,
  durableExecutionWorkBindingHash,
  makeNodeDurableExecutionEnvelopeController,
  type DurableExecutionActorRefV1,
  type DurableExecutionEnvelopeRecordV1,
  type DurableExecutionEnvelopeTransitionV1,
} from './durable-execution-envelope.js'
import * as coordinatorModule from './execution-recovery-coordinator.js'
import {
  makeExecutionRecoveryCoordinatorV1,
  type ExecutionRecoveryDelegationSnapshotV1,
  type ExecutionRecoveryInspectorsV1,
  type ExecutionRecoveryTelegramSnapshotV1,
  type ExecutionRecoveryTerminalDeliverySnapshotV1,
  type ExecutionRecoveryTurnActorSnapshotV1,
} from './execution-recovery-coordinator.js'

const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const H3 = '3'.repeat(64)
const H4 = '4'.repeat(64)
const H5 = '5'.repeat(64)
const H6 = '6'.repeat(64)
const H7 = '7'.repeat(64)
const H8 = '8'.repeat(64)
const H9 = '9'.repeat(64)
const HA = 'a'.repeat(64)
const HB = 'b'.repeat(64)
const HC = 'c'.repeat(64)
const HD = 'd'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const binding = Object.freeze({
  botId: 'bot-1',
  operatorId: 'operator-1',
  profileId: 'profile-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
})

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-recovery-coordinator-'))
  roots.push(root)
  return join(root, 'execution-envelope.sqlite3')
}

function identity() {
  const projection = {
    binding,
    sessionId: binding.sessionId,
    installationHash: H1,
    mode: 'confirm' as const,
    runLivenessHash: H2,
    workBindingHash: durableExecutionWorkBindingHash(binding),
    chatBindingHash: H3,
    replyBindingHash: H4,
    dispatchId: H5,
    turnIdHash: H6,
    executionBindingHash: H7,
    supervisorBindingHash: H7,
    continuationHash: H8,
    policyRevision: 'policy-1',
  }
  return { ...projection, envelopeHash: durableExecutionEnvelopeHash(projection) }
}

function actorRef(record: DurableExecutionEnvelopeRecordV1): DurableExecutionActorRefV1 {
  return {
    actorId: 'actor-1', actorHash: H9, revision: 1,
    envelopeHash: record.identity.envelopeHash,
    workBindingHash: record.identity.workBindingHash,
    executionBindingHash: record.identity.executionBindingHash,
    policyRevision: record.identity.policyRevision,
  }
}

function transition(
  record: DurableExecutionEnvelopeRecordV1,
  nextPhase: DurableExecutionEnvelopeTransitionV1['nextPhase'],
  overrides: Partial<DurableExecutionEnvelopeTransitionV1> = {},
): DurableExecutionEnvelopeTransitionV1 {
  return {
    envelopeHash: record.identity.envelopeHash,
    expectedRevision: record.revision,
    expectedPhase: record.phase,
    nextPhase,
    telegramDelivery: record.telegramDelivery,
    delegationInventory: record.delegationInventory,
    actor: record.actor,
    control: record.control,
    terminalReceipt: null,
    ...overrides,
  }
}

function startEnvelope(options: Readonly<{ actor?: boolean; delegation?: boolean }> = {}) {
  const controller = makeNodeDurableExecutionEnvelopeController({
    path: statePath(), nowMs: () => 1_000,
  })
  const id = identity()
  const result = controller.manager.start({
    identity: id,
    telegramDelivery: {
      revision: 1, delivery: 'pending',
      executionBindingHash: id.executionBindingHash,
      replyBindingHash: id.replyBindingHash,
      dispatchId: id.dispatchId,
      checkpointHash: HD,
      refHash: null,
    },
    delegationInventory: options.delegation === true ? [{
      runRootHash: HA, inventoryHash: HB, authorityHash: HC, revision: 1,
      policyRevision: id.policyRevision,
    }] : [],
    actor: null,
    control: {
      controlHash: H9, revision: 1, envelopeHash: id.envelopeHash,
      supervisorBindingHash: id.supervisorBindingHash,
      policyRevision: id.policyRevision,
    },
  })
  if (result.kind !== 'started') throw new Error('expected start')
  if (options.actor !== true) return { controller, record: result.record }
  return {
    controller,
    record: controller.manager.transition(transition(result.record, 'paused-awaiting-approval', {
      actor: actorRef(result.record),
    })),
  }
}

function leaseAuthority(record: DurableExecutionEnvelopeRecordV1) {
  return {
    envelopeHash: record.identity.envelopeHash,
    installationHash: record.identity.installationHash,
    executionBindingHash: record.identity.executionBindingHash,
    supervisorBindingHash: record.identity.supervisorBindingHash,
    runLivenessHash: record.identity.runLivenessHash,
    policyRevision: record.identity.policyRevision,
  }
}

function inspectionHarness(record: DurableExecutionEnvelopeRecordV1) {
  const counts = { lease: 0, telegram: 0, actor: 0, delegation: 0, terminal: 0 }
  let held = true
  let telegram: ExecutionRecoveryTelegramSnapshotV1 = {
    state: 'ready', envelopeHash: record.identity.envelopeHash,
    executionBindingHash: record.identity.executionBindingHash,
    replyBindingHash: record.identity.replyBindingHash,
    dispatchId: record.identity.dispatchId,
    revision: record.telegramDelivery.revision,
    delivery: record.telegramDelivery.delivery,
    checkpointHash: record.telegramDelivery.checkpointHash,
    recovery: 'none',
  }
  let actor: ExecutionRecoveryTurnActorSnapshotV1 = record.actor === null
    ? { state: 'absent' }
    : {
        state: 'ready', actor: record.actor,
        continuationHash: record.identity.continuationHash,
        recovery: 'awaiting-decision',
      }
  let delegation: ExecutionRecoveryDelegationSnapshotV1 =
    record.delegationInventory.length === 0
      ? { state: 'absent' }
      : {
          state: 'ready', envelopeHash: record.identity.envelopeHash,
          workBindingHash: record.identity.workBindingHash,
          executionBindingHash: record.identity.executionBindingHash,
          continuationHash: record.identity.continuationHash,
          policyRevision: record.identity.policyRevision,
          inventory: record.delegationInventory,
          continuation: 'exact', recovery: 'recoverable',
        }
  let terminal: ExecutionRecoveryTerminalDeliverySnapshotV1 = record.phase === 'terminal'
    ? {
        state: 'ready', envelopeHash: record.identity.envelopeHash,
        executionBindingHash: record.identity.executionBindingHash,
        replyBindingHash: record.identity.replyBindingHash,
        dispatchId: record.identity.dispatchId,
        delivery: record.telegramDelivery.delivery,
        terminalReceiptHash: record.terminalReceipt!.receiptHash,
      }
    : { state: 'absent' }
  const inspectors: ExecutionRecoveryInspectorsV1 = {
    supervisorLease: { assertHeld() { counts.lease += 1; return held } },
    telegram: { inspect() { counts.telegram += 1; return telegram } },
    turnActor: { inspect() { counts.actor += 1; return actor } },
    delegation: { inspect() { counts.delegation += 1; return delegation } },
    terminalDelivery: { inspect() { counts.terminal += 1; return terminal } },
  }
  return {
    inspectors,
    counts,
    setHeld(value: boolean) { held = value },
    setTelegram(value: ExecutionRecoveryTelegramSnapshotV1) { telegram = value },
    setActor(value: ExecutionRecoveryTurnActorSnapshotV1) { actor = value },
    setDelegation(value: ExecutionRecoveryDelegationSnapshotV1) { delegation = value },
    setTerminal(value: ExecutionRecoveryTerminalDeliverySnapshotV1) { terminal = value },
  }
}

function coordinator(
  controller: ReturnType<typeof makeNodeDurableExecutionEnvelopeController>,
  record: DurableExecutionEnvelopeRecordV1,
  inspectors: ExecutionRecoveryInspectorsV1,
  mode: 'supervised' | 'direct' = 'supervised',
) {
  return makeExecutionRecoveryCoordinatorV1({
    mode,
    leaseAuthority: leaseAuthority(record),
    envelopeInspector: controller.inspector,
    inspectors,
  })
}

describe('read-only dormant execution recovery coordinator', () => {
  it('inspects all siblings, seals the plan and refuses exact binding drift', () => {
    const { controller, record } = startEnvelope({ delegation: true })
    const harness = inspectionHarness(record)
    harness.setTelegram({ ...harness.inspectors.telegram.inspect(), dispatchId: H1 })
    harness.counts.telegram = 0
    const instance = coordinator(controller, record, harness.inspectors)
    const plan = instance.inspect()
    expect(plan.classification).toBe('manual-recovery')
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.participantHashes)).toBe(true)
    expect(harness.counts).toMatchObject({ telegram: 1, actor: 1, delegation: 1, terminal: 1 })
    expect(instance.execute(plan)).toEqual({
      kind: 'manual-recovery', code: 'RECOVERY_ACTION_PORT_UNAVAILABLE',
    })
    expect(harness.counts).toMatchObject({ telegram: 2, actor: 2, delegation: 2, terminal: 2 })
    controller.close()
  })

  it.each(['absent', 'foreign', 'corrupt'] as const)(
    'classifies a %s required sibling manual without any action surface', state => {
      const { controller, record } = startEnvelope({ delegation: true })
      const harness = inspectionHarness(record)
      harness.setTelegram({ state })
      const instance = coordinator(controller, record, harness.inspectors)
      const plan = instance.inspect()
      expect(plan.classification).toBe('manual-recovery')
      expect(instance.execute(plan)).toMatchObject({ kind: 'manual-recovery' })
      expect(Object.keys(harness.inspectors.supervisorLease)).toEqual(['assertHeld'])
      expect(Object.keys(harness.inspectors.telegram)).toEqual(['inspect'])
      expect(Object.keys(harness.inspectors.turnActor)).toEqual(['inspect'])
      expect(Object.keys(harness.inspectors.delegation)).toEqual(['inspect'])
      expect(Object.keys(harness.inspectors.terminalDelivery)).toEqual(['inspect'])
      controller.close()
    },
  )

  it('distinguishes an envelope inspection failure from a genuine empty store', () => {
    const { controller, record } = startEnvelope()
    const harness = inspectionHarness(record)
    harness.setTelegram({ state: 'absent' })
    harness.setActor({ state: 'absent' })
    harness.setDelegation({ state: 'absent' })
    harness.setTerminal({ state: 'absent' })
    const instance = makeExecutionRecoveryCoordinatorV1({
      mode: 'supervised', leaseAuthority: leaseAuthority(record),
      envelopeInspector: { recoveryPlan() { throw new Error('corrupt') }, inspect: () => null },
      inspectors: harness.inspectors,
    })
    const plan = instance.inspect()
    expect(plan.classification).toBe('manual-recovery')
    expect(instance.execute(plan)).toMatchObject({ kind: 'manual-recovery' })
    expect(harness.counts).toMatchObject({ telegram: 2, actor: 2, delegation: 2, terminal: 2 })
    controller.close()
  })

  it('waits for an approval but makes every actor control phase manual', () => {
    const { controller, record } = startEnvelope({ actor: true })
    const harness = inspectionHarness(record)
    const instance = coordinator(controller, record, harness.inspectors)
    const waiting = instance.inspect()
    expect(waiting.classification).toBe('await-approval')
    expect(instance.execute(waiting)).toEqual({ kind: 'awaiting-approval' })

    harness.setActor({
      state: 'ready', actor: record.actor!, continuationHash: record.identity.continuationHash,
      recovery: 'replace-card-required',
    })
    const control = instance.inspect()
    expect(control.classification).toBe('actor-control-required')
    expect(instance.execute(control)).toEqual({
      kind: 'manual-recovery', code: 'RECOVERY_ACTION_PORT_UNAVAILABLE',
    })
    controller.close()
  })

  it('classifies exact delegation recovery but cannot execute it', () => {
    const { controller, record } = startEnvelope({ delegation: true })
    const harness = inspectionHarness(record)
    const instance = coordinator(controller, record, harness.inspectors)
    const plan = instance.inspect()
    expect(plan.classification).toBe('delegation-recovery-required')
    expect(instance.execute(plan)).toMatchObject({ kind: 'manual-recovery' })
    expect(Object.keys(harness.inspectors.delegation)).toEqual(['inspect'])
    controller.close()
  })

  it('keeps reconcile, resume, cancellation and quarantine phases read-only', () => {
    const cases: Array<{
      controller: ReturnType<typeof makeNodeDurableExecutionEnvelopeController>
      record: DurableExecutionEnvelopeRecordV1
      configure(harness: ReturnType<typeof inspectionHarness>): void
      classification: string
    }> = []

    const telegramCase = startEnvelope({ delegation: true })
    cases.push({
      ...telegramCase,
      configure(harness) {
        harness.setTelegram({ ...harness.inspectors.telegram.inspect(), recovery: 'reconcile' })
      },
      classification: 'reconcile-telegram-required',
    })

    const resumeCase = startEnvelope({ actor: true })
    const resumeRecord = resumeCase.controller.manager.transition(
      transition(resumeCase.record, 'resume-ready', {
        actor: { ...resumeCase.record.actor!, revision: 2 },
      }),
    )
    cases.push({
      controller: resumeCase.controller,
      record: resumeRecord,
      configure(harness) {
        harness.setActor({
          state: 'ready', actor: resumeRecord.actor!,
          continuationHash: resumeRecord.identity.continuationHash,
          recovery: 'resume-ready',
        })
      },
      classification: 'actor-control-required',
    })

    const cancellingCase = startEnvelope({ actor: true })
    const cancellingRecord = cancellingCase.controller.manager.transition(
      transition(cancellingCase.record, 'cancelling'),
    )
    cases.push({
      controller: cancellingCase.controller,
      record: cancellingRecord,
      configure(harness) {
        harness.setActor({
          state: 'ready', actor: cancellingRecord.actor!,
          continuationHash: cancellingRecord.identity.continuationHash,
          recovery: 'continue-cancelling',
        })
      },
      classification: 'actor-control-required',
    })

    const quarantineCase = startEnvelope()
    const quarantineRecord = quarantineCase.controller.manager.transition(
      transition(quarantineCase.record, 'quarantine'),
    )
    cases.push({
      controller: quarantineCase.controller,
      record: quarantineRecord,
      configure() {},
      classification: 'manual-recovery',
    })

    for (const item of cases) {
      const harness = inspectionHarness(item.record)
      item.configure(harness)
      const instance = coordinator(item.controller, item.record, harness.inspectors)
      const plan = instance.inspect()
      expect(plan.classification).toBe(item.classification)
      expect(instance.execute(plan)).toMatchObject({ kind: 'manual-recovery' })
      expect(Object.values(harness.inspectors).every(port => Object.keys(port).length === 1))
        .toBe(true)
      item.controller.close()
    }
  })

  it('requires terminal delivery before release while exposing neither action', () => {
    const { controller, record: running } = startEnvelope()
    const terminal = controller.manager.transition(transition(running, 'terminal', {
      terminalReceipt: {
        kind: 'completed', code: 'DONE', receiptHash: HA,
        envelopeHash: running.identity.envelopeHash,
        workBindingHash: running.identity.workBindingHash,
        executionBindingHash: running.identity.executionBindingHash,
        dispatchId: running.identity.dispatchId,
        policyRevision: running.identity.policyRevision,
        atMs: 1_000,
      },
    }))
    const pendingHarness = inspectionHarness(terminal)
    const pending = coordinator(controller, terminal, pendingHarness.inspectors)
    const deliveryPlan = pending.inspect()
    expect(deliveryPlan.classification).toBe('terminal-delivery-required')
    expect(pending.execute(deliveryPlan)).toMatchObject({ kind: 'manual-recovery' })

    const delivered = controller.manager.recordTelegramDelivery({
      envelopeHash: terminal.identity.envelopeHash,
      expectedRevision: terminal.revision,
      delivery: {
        ...terminal.telegramDelivery, revision: terminal.telegramDelivery.revision + 1,
        delivery: 'delivered', checkpointHash: HB, refHash: HC,
      },
    })
    const deliveredHarness = inspectionHarness(delivered)
    const release = coordinator(controller, delivered, deliveredHarness.inspectors)
    const releasePlan = release.inspect()
    expect(releasePlan.classification).toBe('terminal-release-required')
    expect(release.execute(releasePlan)).toMatchObject({ kind: 'manual-recovery' })
    expect(Object.keys(deliveredHarness.inspectors.supervisorLease)).toEqual(['assertHeld'])
    expect(controller.inspector.recoveryPlan()).not.toBeNull()
    controller.close()
  })

  it('reads no durable participant after lease loss', () => {
    const { controller, record } = startEnvelope({ delegation: true })
    const harness = inspectionHarness(record)
    harness.setHeld(false)
    const instance = coordinator(controller, record, harness.inspectors)
    const plan = instance.inspect()
    expect(plan.classification).toBe('manual-recovery')
    expect(harness.counts).toEqual({ lease: 1, telegram: 0, actor: 0, delegation: 0, terminal: 0 })
    expect(instance.execute(plan)).toEqual({ kind: 'stale-plan' })
    expect(harness.counts.telegram + harness.counts.actor +
      harness.counts.delegation + harness.counts.terminal).toBe(0)
    controller.close()
  })

  it('rejects structural and genuinely stale plan copies', () => {
    const { controller, record } = startEnvelope({ delegation: true })
    const harness = inspectionHarness(record)
    const instance = coordinator(controller, record, harness.inspectors)
    const plan = instance.inspect()
    expect(instance.execute(structuredClone(plan) as never)).toEqual({ kind: 'stale-plan' })
    harness.setDelegation({ ...harness.inspectors.delegation.inspect(), recovery: 'manual' })
    expect(instance.execute(plan)).toEqual({ kind: 'stale-plan' })
    controller.close()
  })

  it('enforces close and keeps direct mode at zero state reads', () => {
    const { controller, record } = startEnvelope({ delegation: true })
    const supervisedHarness = inspectionHarness(record)
    const supervised = coordinator(controller, record, supervisedHarness.inspectors)
    const plan = supervised.inspect()
    supervised.close()
    expect(supervised.execute(plan)).toEqual({ kind: 'closed' })
    expect(() => supervised.inspect()).toThrowError('EXECUTION_RECOVERY_COORDINATOR_CLOSED')

    const directHarness = inspectionHarness(record)
    const direct = coordinator(controller, record, directHarness.inspectors, 'direct')
    const directPlan = direct.inspect()
    expect(directPlan.classification).toBe('direct-noop')
    expect(direct.execute(directPlan)).toEqual({ kind: 'direct-noop' })
    expect(directHarness.counts).toEqual({ lease: 0, telegram: 0, actor: 0, delegation: 0, terminal: 0 })
    controller.close()
  })

  it('exports no mutation authority or participant action factory', () => {
    expect(coordinatorModule).not.toHaveProperty('makeExecutionRecoveryMutationAuthorityV1')
    expect(coordinatorModule).not.toHaveProperty('makeExecutionRecoveryParticipantAttestationV1')
    expect(Object.keys(coordinatorModule)).toEqual(['makeExecutionRecoveryCoordinatorV1'])
  })
})

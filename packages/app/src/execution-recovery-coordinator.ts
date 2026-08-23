// Dormant, read-only recovery coordinator. It deliberately cannot mutate a
// participant or release a lease until concrete owners expose genuine
// attestations and lease-aware action ports. There is no production importer.

import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  type DurableExecutionActorRefV1,
  type DurableExecutionDelegationInventoryRefV1,
  type DurableExecutionEnvelopeInspectorV1,
  type DurableExecutionRecoveryPlanV1,
} from './durable-execution-envelope.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PLAN_DOMAIN = 'aisy.execution-recovery-coordinator.plan.v1\0'

export type ExecutionRecoveryCoordinatorModeV1 = 'supervised' | 'direct'
export type ExecutionRecoveryParticipantStateV1 = 'absent' | 'ready' | 'foreign' | 'corrupt'

export interface ExecutionRecoveryLeaseAuthorityV1 {
  readonly envelopeHash: string
  readonly installationHash: string
  readonly executionBindingHash: string
  readonly supervisorBindingHash: string
  readonly runLivenessHash: string
  readonly policyRevision: string
}

export interface ExecutionRecoverySupervisorLeaseInspectorV1 {
  assertHeld(authority: Readonly<ExecutionRecoveryLeaseAuthorityV1>): boolean
}

export interface ExecutionRecoveryTelegramSnapshotV1 {
  readonly state: ExecutionRecoveryParticipantStateV1
  readonly envelopeHash?: string
  readonly executionBindingHash?: string
  readonly replyBindingHash?: string
  readonly dispatchId?: string
  readonly revision?: number
  readonly delivery?: 'pending' | 'delivered'
  readonly checkpointHash?: string
  readonly recovery?: 'none' | 'reconcile'
}

export interface ExecutionRecoveryTelegramInspectorV1 {
  inspect(): ExecutionRecoveryTelegramSnapshotV1
}

export interface ExecutionRecoveryTurnActorSnapshotV1 {
  readonly state: ExecutionRecoveryParticipantStateV1
  readonly actor?: DurableExecutionActorRefV1
  readonly continuationHash?: string
  readonly recovery?:
    | 'awaiting-decision'
    | 'replace-card-required'
    | 'resume-ready'
    | 'rejection-ready'
    | 'continue-cancelling'
    | 'reconciliation-required'
    | 'authority-lost'
    | 'none'
}

export interface ExecutionRecoveryTurnActorInspectorV1 {
  inspect(): ExecutionRecoveryTurnActorSnapshotV1
}

export interface ExecutionRecoveryDelegationSnapshotV1 {
  readonly state: ExecutionRecoveryParticipantStateV1
  readonly envelopeHash?: string
  readonly workBindingHash?: string
  readonly executionBindingHash?: string
  readonly continuationHash?: string
  readonly policyRevision?: string
  readonly inventory?: readonly DurableExecutionDelegationInventoryRefV1[]
  readonly continuation?: 'exact' | 'missing' | 'unresolved'
  readonly recovery?: 'none' | 'recoverable' | 'manual'
}

export interface ExecutionRecoveryDelegationInspectorV1 {
  inspect(): ExecutionRecoveryDelegationSnapshotV1
}

export interface ExecutionRecoveryTerminalDeliverySnapshotV1 {
  readonly state: ExecutionRecoveryParticipantStateV1
  readonly envelopeHash?: string
  readonly executionBindingHash?: string
  readonly replyBindingHash?: string
  readonly dispatchId?: string
  readonly delivery?: 'pending' | 'delivered'
  readonly terminalReceiptHash?: string
}

export interface ExecutionRecoveryTerminalDeliveryInspectorV1 {
  inspect(): ExecutionRecoveryTerminalDeliverySnapshotV1
}

export interface ExecutionRecoveryInspectorsV1 {
  readonly supervisorLease: ExecutionRecoverySupervisorLeaseInspectorV1
  readonly telegram: ExecutionRecoveryTelegramInspectorV1
  readonly turnActor: ExecutionRecoveryTurnActorInspectorV1
  readonly delegation: ExecutionRecoveryDelegationInspectorV1
  readonly terminalDelivery: ExecutionRecoveryTerminalDeliveryInspectorV1
}

export type ExecutionRecoveryClassificationV1 =
  | 'direct-noop'
  | 'no-active-envelope'
  | 'manual-recovery'
  | 'await-approval'
  | 'reconcile-telegram-required'
  | 'actor-control-required'
  | 'delegation-recovery-required'
  | 'terminal-delivery-required'
  | 'terminal-release-required'

const planBrand: unique symbol = Symbol('aisy.execution-recovery-coordinator.plan.v1')

export interface ExecutionRecoveryCoordinatorPlanV1 {
  readonly [planBrand]: true
  readonly schemaVersion: 1
  readonly mode: ExecutionRecoveryCoordinatorModeV1
  readonly classification: ExecutionRecoveryClassificationV1
  readonly envelope: DurableExecutionRecoveryPlanV1 | null
  readonly telegram: Readonly<ExecutionRecoveryTelegramSnapshotV1>
  readonly turnActor: Readonly<ExecutionRecoveryTurnActorSnapshotV1>
  readonly delegation: Readonly<ExecutionRecoveryDelegationSnapshotV1>
  readonly terminalDelivery: Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1>
  readonly participantHashes: Readonly<{
    telegram: string
    turnActor: string
    delegation: string
    terminalDelivery: string
  }>
  readonly planHash: string
}

export type ExecutionRecoveryCoordinatorResultV1 =
  | Readonly<{ kind: 'direct-noop' | 'no-action' | 'awaiting-approval' }>
  | Readonly<{ kind: 'manual-recovery'; code: 'RECOVERY_ACTION_PORT_UNAVAILABLE' }>
  | Readonly<{ kind: 'stale-plan' | 'closed' }>

export interface ExecutionRecoveryCoordinatorV1 {
  inspect(): ExecutionRecoveryCoordinatorPlanV1
  execute(plan: ExecutionRecoveryCoordinatorPlanV1): ExecutionRecoveryCoordinatorResultV1
  close(): void
}

interface PlanState {
  readonly owner: object
  readonly planHash: string
}

const planStates = new WeakMap<object, PlanState>()

function fail(): never {
  throw new Error('EXECUTION_RECOVERY_COORDINATOR_INPUT_INVALID')
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []):
Record<string, unknown> {
  if (!plain(value)) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) fail()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) fail()
    result[key] = descriptor.value
  }
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail()
  return value
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) fail()
  return value
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail()
  return value
}

function state(value: unknown): ExecutionRecoveryParticipantStateV1 {
  if (value !== 'absent' && value !== 'ready' && value !== 'foreign' && value !== 'corrupt') fail()
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(PLAN_DOMAIN, 'utf8').update(value, 'utf8').digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

function cleanActorRef(value: unknown): Readonly<DurableExecutionActorRefV1> {
  const raw = exact(value, [
    'actorId', 'actorHash', 'revision', 'envelopeHash', 'workBindingHash',
    'executionBindingHash', 'policyRevision',
  ])
  return Object.freeze({
    actorId: identifier(raw['actorId']),
    actorHash: hash(raw['actorHash']),
    revision: revision(raw['revision']),
    envelopeHash: hash(raw['envelopeHash']),
    workBindingHash: hash(raw['workBindingHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    policyRevision: identifier(raw['policyRevision']),
  })
}

function cleanInventory(value: unknown): readonly Readonly<DurableExecutionDelegationInventoryRefV1>[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > 1024) fail()
  const result = value.map(item => {
    const raw = exact(item, [
      'runRootHash', 'inventoryHash', 'authorityHash', 'revision', 'policyRevision',
    ])
    return Object.freeze({
      runRootHash: hash(raw['runRootHash']),
      inventoryHash: hash(raw['inventoryHash']),
      authorityHash: hash(raw['authorityHash']),
      revision: revision(raw['revision']),
      policyRevision: identifier(raw['policyRevision']),
    })
  })
  if (result.some((item, index) => index > 0 &&
    result[index - 1]!.runRootHash >= item.runRootHash)) fail()
  return Object.freeze(result)
}

function cleanTelegram(value: unknown): Readonly<ExecutionRecoveryTelegramSnapshotV1> {
  const raw = exact(value, ['state'], [
    'envelopeHash', 'executionBindingHash', 'replyBindingHash', 'dispatchId', 'revision',
    'delivery', 'checkpointHash', 'recovery',
  ])
  const participantState = state(raw['state'])
  if (participantState !== 'ready') {
    if (Object.keys(raw).length !== 1) fail()
    return Object.freeze({ state: participantState })
  }
  if ((raw['delivery'] !== 'pending' && raw['delivery'] !== 'delivered') ||
    (raw['recovery'] !== 'none' && raw['recovery'] !== 'reconcile')) fail()
  return Object.freeze({
    state: participantState,
    envelopeHash: hash(raw['envelopeHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    replyBindingHash: hash(raw['replyBindingHash']),
    dispatchId: hash(raw['dispatchId']),
    revision: revision(raw['revision']),
    delivery: raw['delivery'],
    checkpointHash: hash(raw['checkpointHash']),
    recovery: raw['recovery'],
  })
}

function cleanActor(value: unknown): Readonly<ExecutionRecoveryTurnActorSnapshotV1> {
  const raw = exact(value, ['state'], ['actor', 'continuationHash', 'recovery'])
  const participantState = state(raw['state'])
  if (participantState !== 'ready') {
    if (Object.keys(raw).length !== 1) fail()
    return Object.freeze({ state: participantState })
  }
  const recovery = raw['recovery']
  if (recovery !== 'awaiting-decision' && recovery !== 'replace-card-required' &&
    recovery !== 'resume-ready' && recovery !== 'rejection-ready' &&
    recovery !== 'continue-cancelling' && recovery !== 'reconciliation-required' &&
    recovery !== 'authority-lost' && recovery !== 'none') fail()
  return Object.freeze({
    state: participantState,
    actor: cleanActorRef(raw['actor']),
    continuationHash: hash(raw['continuationHash']),
    recovery,
  })
}

function cleanDelegation(value: unknown): Readonly<ExecutionRecoveryDelegationSnapshotV1> {
  const raw = exact(value, ['state'], [
    'envelopeHash', 'workBindingHash', 'executionBindingHash', 'continuationHash',
    'policyRevision', 'inventory', 'continuation', 'recovery',
  ])
  const participantState = state(raw['state'])
  if (participantState !== 'ready') {
    if (Object.keys(raw).length !== 1) fail()
    return Object.freeze({ state: participantState })
  }
  if ((raw['continuation'] !== 'exact' && raw['continuation'] !== 'missing' &&
      raw['continuation'] !== 'unresolved') ||
    (raw['recovery'] !== 'none' && raw['recovery'] !== 'recoverable' &&
      raw['recovery'] !== 'manual')) fail()
  return Object.freeze({
    state: participantState,
    envelopeHash: hash(raw['envelopeHash']),
    workBindingHash: hash(raw['workBindingHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    continuationHash: hash(raw['continuationHash']),
    policyRevision: identifier(raw['policyRevision']),
    inventory: cleanInventory(raw['inventory']),
    continuation: raw['continuation'],
    recovery: raw['recovery'],
  })
}

function cleanTerminal(value: unknown): Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1> {
  const raw = exact(value, ['state'], [
    'envelopeHash', 'executionBindingHash', 'replyBindingHash', 'dispatchId', 'delivery',
    'terminalReceiptHash',
  ])
  const participantState = state(raw['state'])
  if (participantState !== 'ready') {
    if (Object.keys(raw).length !== 1) fail()
    return Object.freeze({ state: participantState })
  }
  if (raw['delivery'] !== 'pending' && raw['delivery'] !== 'delivered') fail()
  return Object.freeze({
    state: participantState,
    envelopeHash: hash(raw['envelopeHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    replyBindingHash: hash(raw['replyBindingHash']),
    dispatchId: hash(raw['dispatchId']),
    delivery: raw['delivery'],
    terminalReceiptHash: hash(raw['terminalReceiptHash']),
  })
}

function cleanLeaseAuthority(value: unknown): Readonly<ExecutionRecoveryLeaseAuthorityV1> {
  const raw = exact(value, [
    'envelopeHash', 'installationHash', 'executionBindingHash', 'supervisorBindingHash',
    'runLivenessHash', 'policyRevision',
  ])
  return Object.freeze({
    envelopeHash: hash(raw['envelopeHash']),
    installationHash: hash(raw['installationHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    supervisorBindingHash: hash(raw['supervisorBindingHash']),
    runLivenessHash: hash(raw['runLivenessHash']),
    policyRevision: identifier(raw['policyRevision']),
  })
}

function captureMethod<T extends object, K extends keyof T>(value: T, key: K): T[K] {
  if (!plain(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    descriptor.get !== undefined || descriptor.set !== undefined ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) fail()
  return descriptor.value.bind(value) as T[K]
}

function captureInspectors(value: ExecutionRecoveryInspectorsV1): Readonly<ExecutionRecoveryInspectorsV1> {
  const raw = exact(value, [
    'supervisorLease', 'telegram', 'turnActor', 'delegation', 'terminalDelivery',
  ])
  const lease = raw['supervisorLease'] as ExecutionRecoverySupervisorLeaseInspectorV1
  const telegram = raw['telegram'] as ExecutionRecoveryTelegramInspectorV1
  const actor = raw['turnActor'] as ExecutionRecoveryTurnActorInspectorV1
  const delegation = raw['delegation'] as ExecutionRecoveryDelegationInspectorV1
  const terminal = raw['terminalDelivery'] as ExecutionRecoveryTerminalDeliveryInspectorV1
  exact(lease, ['assertHeld'])
  exact(telegram, ['inspect'])
  exact(actor, ['inspect'])
  exact(delegation, ['inspect'])
  exact(terminal, ['inspect'])
  return Object.freeze({
    supervisorLease: Object.freeze({ assertHeld: captureMethod(lease, 'assertHeld') }),
    telegram: Object.freeze({ inspect: captureMethod(telegram, 'inspect') }),
    turnActor: Object.freeze({ inspect: captureMethod(actor, 'inspect') }),
    delegation: Object.freeze({ inspect: captureMethod(delegation, 'inspect') }),
    terminalDelivery: Object.freeze({ inspect: captureMethod(terminal, 'inspect') }),
  })
}

function authorityFromEnvelope(envelope: DurableExecutionRecoveryPlanV1):
Readonly<ExecutionRecoveryLeaseAuthorityV1> {
  return Object.freeze({
    envelopeHash: envelope.envelopeHash,
    installationHash: envelope.installationHash,
    executionBindingHash: envelope.executionBindingHash,
    supervisorBindingHash: envelope.supervisorBindingHash,
    runLivenessHash: envelope.runLivenessHash,
    policyRevision: envelope.policyRevision,
  })
}

function siblingsExact(
  envelope: DurableExecutionRecoveryPlanV1,
  telegram: Readonly<ExecutionRecoveryTelegramSnapshotV1>,
  actor: Readonly<ExecutionRecoveryTurnActorSnapshotV1>,
  delegation: Readonly<ExecutionRecoveryDelegationSnapshotV1>,
  terminal: Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1>,
): boolean {
  if (telegram.state !== 'ready' || telegram.envelopeHash !== envelope.envelopeHash ||
    telegram.executionBindingHash !== envelope.executionBindingHash ||
    telegram.replyBindingHash !== envelope.replyBindingHash ||
    telegram.dispatchId !== envelope.dispatchId ||
    telegram.revision !== envelope.telegramDelivery.revision ||
    telegram.delivery !== envelope.telegramDelivery.delivery ||
    telegram.checkpointHash !== envelope.telegramDelivery.checkpointHash) return false

  if (envelope.actor === null ? actor.state !== 'absent' :
    actor.state !== 'ready' || JSON.stringify(actor.actor) !== JSON.stringify(envelope.actor) ||
      actor.continuationHash !== envelope.continuationHash) return false

  if (envelope.delegationInventory.length === 0) {
    if (delegation.state !== 'absent') return false
  } else if (delegation.state !== 'ready' || delegation.envelopeHash !== envelope.envelopeHash ||
    delegation.workBindingHash !== envelope.workBindingHash ||
    delegation.executionBindingHash !== envelope.executionBindingHash ||
    delegation.continuationHash !== envelope.continuationHash ||
    delegation.policyRevision !== envelope.policyRevision ||
    JSON.stringify(delegation.inventory) !== JSON.stringify(envelope.delegationInventory)) return false

  if (envelope.phase === 'terminal') {
    if (envelope.terminalReceipt === null || terminal.state !== 'ready' ||
      terminal.envelopeHash !== envelope.envelopeHash ||
      terminal.executionBindingHash !== envelope.executionBindingHash ||
      terminal.replyBindingHash !== envelope.replyBindingHash ||
      terminal.dispatchId !== envelope.dispatchId ||
      terminal.delivery !== envelope.telegramDelivery.delivery ||
      terminal.terminalReceiptHash !== envelope.terminalReceipt.receiptHash) return false
  } else if (terminal.state !== 'absent') return false
  return true
}

function classify(
  envelope: DurableExecutionRecoveryPlanV1 | null,
  telegram: Readonly<ExecutionRecoveryTelegramSnapshotV1>,
  actor: Readonly<ExecutionRecoveryTurnActorSnapshotV1>,
  delegation: Readonly<ExecutionRecoveryDelegationSnapshotV1>,
  terminal: Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1>,
): ExecutionRecoveryClassificationV1 {
  if (envelope === null) {
    return telegram.state === 'absent' && actor.state === 'absent' &&
      delegation.state === 'absent' && terminal.state === 'absent'
      ? 'no-active-envelope'
      : 'manual-recovery'
  }
  if (!siblingsExact(envelope, telegram, actor, delegation, terminal) ||
    envelope.kind === 'manual-recovery') return 'manual-recovery'
  if (telegram.recovery === 'reconcile') return 'reconcile-telegram-required'
  if (envelope.phase === 'paused-awaiting-approval') {
    if (actor.state !== 'ready') return 'manual-recovery'
    if (actor.recovery === 'awaiting-decision') return 'await-approval'
    return actor.recovery === 'replace-card-required'
      ? 'actor-control-required'
      : 'manual-recovery'
  }
  if (envelope.phase === 'resume-ready' || envelope.phase === 'cancelling') {
    if (actor.state !== 'ready') return 'manual-recovery'
    const expected = envelope.phase === 'resume-ready'
      ? ['resume-ready', 'rejection-ready']
      : ['continue-cancelling']
    return expected.includes(String(actor.recovery))
      ? 'actor-control-required'
      : 'manual-recovery'
  }
  if (envelope.phase === 'running') {
    if (delegation.state !== 'ready' || delegation.continuation !== 'exact') {
      return 'manual-recovery'
    }
    return delegation.recovery === 'recoverable'
      ? 'delegation-recovery-required'
      : 'manual-recovery'
  }
  if (envelope.phase === 'terminal') {
    return envelope.telegramDelivery.delivery === 'pending'
      ? 'terminal-delivery-required'
      : 'terminal-release-required'
  }
  return 'manual-recovery'
}

function safeAbsent(): Readonly<{ state: 'absent' }> {
  return Object.freeze({ state: 'absent' })
}

export function makeExecutionRecoveryCoordinatorV1(input: Readonly<{
  mode: ExecutionRecoveryCoordinatorModeV1
  leaseAuthority: ExecutionRecoveryLeaseAuthorityV1
  envelopeInspector: DurableExecutionEnvelopeInspectorV1
  inspectors: ExecutionRecoveryInspectorsV1
}>): ExecutionRecoveryCoordinatorV1 {
  const raw = exact(input, ['mode', 'leaseAuthority', 'envelopeInspector', 'inspectors'])
  if (raw['mode'] !== 'supervised' && raw['mode'] !== 'direct') fail()
  const mode: ExecutionRecoveryCoordinatorModeV1 = raw['mode']
  const leaseAuthority = cleanLeaseAuthority(raw['leaseAuthority'])
  const inspectorInput = raw['envelopeInspector'] as DurableExecutionEnvelopeInspectorV1
  const envelopeInspector = Object.freeze({
    recoveryPlan: captureMethod(inspectorInput, 'recoveryPlan'),
  })
  const inspectors = captureInspectors(raw['inspectors'] as ExecutionRecoveryInspectorsV1)
  const owner = Object.freeze({})
  let closed = false

  const makePlan = (
    classification: ExecutionRecoveryClassificationV1,
    envelope: DurableExecutionRecoveryPlanV1 | null,
    telegram: Readonly<ExecutionRecoveryTelegramSnapshotV1>,
    actor: Readonly<ExecutionRecoveryTurnActorSnapshotV1>,
    delegation: Readonly<ExecutionRecoveryDelegationSnapshotV1>,
    terminal: Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1>,
  ): ExecutionRecoveryCoordinatorPlanV1 => {
    const participantHashes = Object.freeze({
      telegram: sha256(JSON.stringify(telegram)),
      turnActor: sha256(JSON.stringify(actor)),
      delegation: sha256(JSON.stringify(delegation)),
      terminalDelivery: sha256(JSON.stringify(terminal)),
    })
    const projection = {
      schemaVersion: 1 as const,
      mode,
      classification,
      envelope,
      telegram,
      turnActor: actor,
      delegation,
      terminalDelivery: terminal,
      participantHashes,
    }
    const plan = deepFreeze({
      ...structuredClone(projection),
      [planBrand]: true as const,
      planHash: sha256(JSON.stringify(projection)),
    })
    planStates.set(plan, { owner, planHash: plan.planHash })
    return plan
  }

  const held = (): boolean => {
    try { return inspectors.supervisorLease.assertHeld(leaseAuthority) === true } catch { return false }
  }

  const inspect = (): ExecutionRecoveryCoordinatorPlanV1 => {
    if (closed) throw new Error('EXECUTION_RECOVERY_COORDINATOR_CLOSED')
    if (mode === 'direct') {
      return makePlan('direct-noop', null, safeAbsent(), safeAbsent(), safeAbsent(), safeAbsent())
    }
    if (!held()) {
      return makePlan('manual-recovery', null,
        safeAbsent(), safeAbsent(), safeAbsent(), safeAbsent())
    }

    let envelope: DurableExecutionRecoveryPlanV1 | null = null
    let envelopeFailed = true
    let telegram: Readonly<ExecutionRecoveryTelegramSnapshotV1> = Object.freeze({ state: 'corrupt' })
    let actor: Readonly<ExecutionRecoveryTurnActorSnapshotV1> = Object.freeze({ state: 'corrupt' })
    let delegation: Readonly<ExecutionRecoveryDelegationSnapshotV1> = Object.freeze({ state: 'corrupt' })
    let terminal: Readonly<ExecutionRecoveryTerminalDeliverySnapshotV1> =
      Object.freeze({ state: 'corrupt' })
    try { envelope = envelopeInspector.recoveryPlan(); envelopeFailed = false } catch { /* inspect all */ }
    try { telegram = cleanTelegram(inspectors.telegram.inspect()) } catch { /* corrupt */ }
    try { actor = cleanActor(inspectors.turnActor.inspect()) } catch { /* corrupt */ }
    try { delegation = cleanDelegation(inspectors.delegation.inspect()) } catch { /* corrupt */ }
    try { terminal = cleanTerminal(inspectors.terminalDelivery.inspect()) } catch { /* corrupt */ }

    if (envelopeFailed || !held()) {
      return makePlan('manual-recovery', envelopeFailed ? null : envelope,
        telegram, actor, delegation, terminal)
    }
    if (envelope !== null &&
      JSON.stringify(authorityFromEnvelope(envelope)) !== JSON.stringify(leaseAuthority)) {
      return makePlan('manual-recovery', envelope, telegram, actor, delegation, terminal)
    }
    return makePlan(classify(envelope, telegram, actor, delegation, terminal),
      envelope, telegram, actor, delegation, terminal)
  }

  return Object.freeze({
    inspect,
    execute(plan: ExecutionRecoveryCoordinatorPlanV1): ExecutionRecoveryCoordinatorResultV1 {
      if (closed) return Object.freeze({ kind: 'closed' })
      const state = planStates.get(plan)
      if (state === undefined || state.owner !== owner || state.planHash !== plan.planHash) {
        return Object.freeze({ kind: 'stale-plan' })
      }
      if (mode === 'direct') return Object.freeze({ kind: 'direct-noop' })
      if (!held()) return Object.freeze({ kind: 'stale-plan' })
      const current = inspect()
      if (!held() || current.planHash !== plan.planHash) {
        return Object.freeze({ kind: 'stale-plan' })
      }
      if (plan.classification === 'no-active-envelope') return Object.freeze({ kind: 'no-action' })
      if (plan.classification === 'await-approval') {
        return Object.freeze({ kind: 'awaiting-approval' })
      }
      return Object.freeze({ kind: 'manual-recovery', code: 'RECOVERY_ACTION_PORT_UNAVAILABLE' })
    },
    close() { closed = true },
  })
}

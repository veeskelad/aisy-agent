import { types as utilTypes } from 'node:util'

import {
  durableTurnWorkBindingHash,
  type DurableTurnBudgetV1,
  type DurableTurnCallbackAdmissionPort,
  type DurableTurnCancellationControlPort,
  type DurableTurnClaimReconciliationControlPort,
  type DurableTurnOperationControlPort,
} from './durable-turn-actor.js'
import type {
  DurableParentAmbiguityV1,
  DurableParentContinuationRecordV1,
  DurableParentContinuationStoreV1,
} from './durable-parent-continuation.js'
import {
  isGenuineExecutionSupervisorLease,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

type CallbackAuthority = Parameters<DurableTurnCallbackAdmissionPort['assertAdmitted']>[0]
type CancellationAuthority = Parameters<DurableTurnCancellationControlPort['assertQuiesced']>[0]
type ClaimReconciliationAuthority = Parameters<
  DurableTurnClaimReconciliationControlPort['assertReplaySafe']
>[0]
type OperationAuthority = Parameters<DurableTurnOperationControlPort['assertHeld']>[0]

export interface DurableTurnActorProductionPortsV1 {
  readonly operationControl: DurableTurnOperationControlPort
  readonly callbackAdmission: DurableTurnCallbackAdmissionPort
  readonly cancellationControl: DurableTurnCancellationControlPort
  readonly claimReconciliation: DurableTurnClaimReconciliationControlPort
  /** Called only after the Telegram adapter authenticated the exact callback. */
  admitTransportCallback(
    authority: CallbackAuthority,
    stepUpVerified: boolean,
  ): void
}

export type DurableTurnActorProductionPortsErrorCode =
  | 'DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID'
  | 'DURABLE_TURN_PRODUCTION_PORTS_ADMISSION_DENIED'

export class DurableTurnActorProductionPortsError extends Error {
  constructor(readonly code: DurableTurnActorProductionPortsErrorCode) {
    super(code)
    this.name = 'DurableTurnActorProductionPortsError'
  }
}

function fail(code: DurableTurnActorProductionPortsErrorCode): never {
  throw new DurableTurnActorProductionPortsError(code)
}

function exact(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).sort().join(',') !== [...required].sort().join(',') ||
    Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function callbackSnapshot(value: unknown): Readonly<CallbackAuthority> {
  const raw = exact(value, [
    'actorId', 'actionId', 'actionHash', 'cardId', 'operatorId', 'chatId', 'sessionId', 'turnId',
  ])
  for (const field of ['actorId', 'actionId', 'cardId'] as const) {
    if (typeof raw[field] !== 'string' || !ID.test(raw[field])) {
      fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
    }
  }
  if (typeof raw['actionHash'] !== 'string' || !HASH.test(raw['actionHash']) ||
    ['operatorId', 'chatId', 'sessionId', 'turnId'].some(field =>
      typeof raw[field] !== 'string' || raw[field].length === 0 ||
      raw[field].length > 512 || raw[field].includes('\0'))) {
    fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
  }
  return Object.freeze({
    actorId: raw['actorId'] as string,
    actionId: raw['actionId'] as string,
    actionHash: raw['actionHash'] as string,
    cardId: raw['cardId'] as string,
    operatorId: raw['operatorId'] as string,
    chatId: raw['chatId'] as string,
    sessionId: raw['sessionId'] as string,
    turnId: raw['turnId'] as string,
  })
}

function sameCallback(left: CallbackAuthority, right: CallbackAuthority): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function durableAmbiguityOperationId(operationHash: string): string {
  if (!HASH.test(operationHash)) fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
  return `ambiguity:${operationHash}`
}

export function makeDurableTurnActorProductionPortsV1(input: Readonly<{
  continuation: DurableParentContinuationStoreV1
  currentLease(): ExecutionSupervisorLease | null
  assertBudget(
    budget: Readonly<DurableTurnBudgetV1>,
    continuation: DurableParentContinuationRecordV1,
    ambiguity: DurableParentAmbiguityV1 | null,
  ): boolean
  /** Exact operation inventory proves resolution durable after continuation resumed. */
  assertResolutionApplied(
    authority: OperationAuthority,
    continuation: DurableParentContinuationRecordV1,
  ): boolean
  assertClaimReplaySafe(
    authority: Parameters<DurableTurnClaimReconciliationControlPort['assertReplaySafe']>[0],
    continuation: DurableParentContinuationRecordV1,
    ambiguity: DurableParentAmbiguityV1 | null,
  ): boolean
  assertCancellationQuiesced(
    authority: Parameters<DurableTurnCancellationControlPort['assertQuiesced']>[0],
    continuation: DurableParentContinuationRecordV1,
    ambiguity: DurableParentAmbiguityV1 | null,
  ): boolean
}>): DurableTurnActorProductionPortsV1 {
  const raw = exact(input, [
    'continuation', 'currentLease', 'assertBudget', 'assertResolutionApplied', 'assertClaimReplaySafe',
    'assertCancellationQuiesced',
  ])
  const continuation = raw['continuation'] as DurableParentContinuationStoreV1
  const currentLease = raw['currentLease'] as () => ExecutionSupervisorLease | null
  const assertBudget = raw['assertBudget'] as typeof input.assertBudget
  const assertResolutionApplied = raw['assertResolutionApplied'] as typeof input.assertResolutionApplied
  const assertClaimReplaySafe = raw['assertClaimReplaySafe'] as typeof input.assertClaimReplaySafe
  const assertCancellationQuiesced = raw['assertCancellationQuiesced'] as typeof input.assertCancellationQuiesced
  if (typeof continuation !== 'object' || continuation === null || utilTypes.isProxy(continuation) ||
    typeof continuation.load !== 'function' || typeof currentLease !== 'function' ||
    typeof assertBudget !== 'function' || typeof assertResolutionApplied !== 'function' ||
    typeof assertClaimReplaySafe !== 'function' ||
    typeof assertCancellationQuiesced !== 'function') {
    fail('DURABLE_TURN_PRODUCTION_PORTS_INPUT_INVALID')
  }

  let pendingCallback: Readonly<{
    authority: Readonly<CallbackAuthority>
    stepUpVerified: boolean
  }> | null = null

  const active = (authority: OperationAuthority): Readonly<{
    continuation: DurableParentContinuationRecordV1
    ambiguity: DurableParentAmbiguityV1 | null
  }> | null => {
    let lease: ExecutionSupervisorLease | null
    try { lease = currentLease() } catch { return null }
    if (!isGenuineExecutionSupervisorLease(lease) || !lease.isHeld() ||
      lease.bindingHash !== authority.supervisorBindingHash) return null
    const loaded = continuation.load()
    if (loaded.status !== 'ready' || loaded.record.phase === 'terminal') return null
    const record = loaded.record
    if (record.continuationHash !== authority.continuationHash ||
      record.identity.supervisorBindingHash !== authority.supervisorBindingHash ||
      record.identity.sessionId !== authority.sessionId ||
      record.identity.turnId !== authority.turnId ||
      record.identity.policyRevision !== authority.policyRevision ||
      durableTurnWorkBindingHash(record.identity.binding) !== authority.workBindingHash) return null
    let ambiguity: DurableParentAmbiguityV1 | null = null
    if (record.phase === 'paused' || record.phase === 'cancelling') {
      ambiguity = record.ambiguity ?? null
      if (ambiguity === null || ambiguity.operationHash !== authority.operationHash ||
        durableAmbiguityOperationId(ambiguity.operationHash) !== authority.operationId) return null
    } else {
      ambiguity = record.ambiguity ?? null
      if (ambiguity === null || ambiguity.operationHash !== authority.operationHash ||
        durableAmbiguityOperationId(ambiguity.operationHash) !== authority.operationId) return null
      let resolutionApplied = false
      try { resolutionApplied = assertResolutionApplied(authority, record) === true } catch {
        resolutionApplied = false
      }
      if (!resolutionApplied) return null
    }
    let budgetAllowed = false
    try { budgetAllowed = assertBudget(authority.budget, record, ambiguity) === true } catch {
      budgetAllowed = false
    }
    return budgetAllowed ? Object.freeze({ continuation: record, ambiguity }) : null
  }

  const operationControl: DurableTurnOperationControlPort = Object.freeze({
    assertHeld(authority: OperationAuthority) { return active(authority) !== null },
  })
  const callbackAdmission: DurableTurnCallbackAdmissionPort = Object.freeze({
    assertAdmitted(authority: CallbackAuthority) {
      const captured = callbackSnapshot(authority)
      const pending = pendingCallback
      pendingCallback = null
      if (pending === null || !sameCallback(pending.authority, captured)) return false
      return pending.stepUpVerified ? 'step-up-admitted' : 'admitted'
    },
  })
  const claimReconciliation: DurableTurnClaimReconciliationControlPort = Object.freeze({
    assertReplaySafe(authority: ClaimReconciliationAuthority) {
      const state = active(authority)
      if (state === null) return false
      try { return assertClaimReplaySafe(authority, state.continuation, state.ambiguity) === true } catch {
        return false
      }
    },
  })
  const cancellationControl: DurableTurnCancellationControlPort = Object.freeze({
    assertQuiesced(authority: CancellationAuthority) {
      const state = active(authority)
      if (state === null || state.continuation.phase !== 'cancelling' ||
        state.continuation.cancellationReceiptHash !== authority.receiptHash) return false
      try {
        return assertCancellationQuiesced(authority, state.continuation, state.ambiguity) === true
      } catch { return false }
    },
  })

  return Object.freeze({
    operationControl,
    callbackAdmission,
    cancellationControl,
    claimReconciliation,
    admitTransportCallback(authority: CallbackAuthority, stepUpVerified: boolean) {
      if (typeof stepUpVerified !== 'boolean' || pendingCallback !== null) {
        fail('DURABLE_TURN_PRODUCTION_PORTS_ADMISSION_DENIED')
      }
      pendingCallback = Object.freeze({
        authority: callbackSnapshot(authority),
        stepUpVerified,
      })
    },
  })
}

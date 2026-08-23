// Dormant unified startup recovery envelope from ADR-0071.
// Production composition does not import this module yet.

import { types as utilTypes } from 'node:util'

import {
  isGenuineExecutionSupervisorLease,
  makeExecutionSupervisorRecoveryContextV1,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

const HASH = /^[a-f0-9]{64}$/
const CODE = /^[A-Z][A-Z0-9_]{0,127}$/
const executionStartupRecoveryContextBrand: unique symbol = Symbol(
  'aisy.execution-startup-recovery-context-v1',
)

export type ExecutionStartupRecoveryStep = 'telegram' | 'approval-stop' | 'delegation'

export type ExecutionStartupRecoveryStepResultV1 =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'terminal'; bindingHash: string }>
  | Readonly<{ kind: 'continuation'; bindingHash: string }>
  | Readonly<{ kind: 'denied'; code: string }>

export interface ExecutionStartupRecoveryContextV1 {
  readonly [executionStartupRecoveryContextBrand]: true
  readonly schemaVersion: 1
  readonly bindingHash: string
  readonly authorityPhase: 'captured-unbound' | 'checkpoint-bound'
  isHeld(): boolean
}

export interface ExecutionStartupRecoveryPortV1 {
  recover(
    context: ExecutionStartupRecoveryContextV1,
  ): Promise<ExecutionStartupRecoveryStepResultV1>
}

export type ExecutionStartupRecoveryCoordinatorErrorCode =
  | 'EXECUTION_RECOVERY_CONFIG_INVALID'
  | 'EXECUTION_RECOVERY_AUTHORITY_INVALID'
  | 'EXECUTION_RECOVERY_AUTHORITY_LOST'
  | 'EXECUTION_RECOVERY_STEP_DENIED'
  | 'EXECUTION_RECOVERY_STEP_FAILED'
  | 'EXECUTION_RECOVERY_STATE_MISSING'
  | 'EXECUTION_RECOVERY_RELEASE_FAILED'
  | 'EXECUTION_RECOVERY_RECONCILE_BUSY'

export class ExecutionStartupRecoveryCoordinatorError extends Error {
  constructor(readonly code: ExecutionStartupRecoveryCoordinatorErrorCode) {
    super(code)
    this.name = 'ExecutionStartupRecoveryCoordinatorError'
  }
}

export interface ExecutionStartupRecoveryReadyV1 {
  readonly kind: 'ready'
  readonly bindingHash: string
}

export interface ExecutionStartupRecoveryContinuationV1 {
  readonly kind: 'continuation-required'
  readonly bindingHash: string
  /** Re-runs the complete ordered envelope and releases only when all are clean. */
  reconcile(): Promise<ExecutionStartupRecoveryReadyV1 | ExecutionStartupRecoveryContinuationV1>
}

export type ExecutionStartupRecoveryResultV1 =
  | ExecutionStartupRecoveryReadyV1
  | ExecutionStartupRecoveryContinuationV1

export interface ExecutionStartupRecoveryEventV1 {
  readonly kind: 'execution.startup-recovery.step' | 'execution.startup-recovery.ready'
  readonly step?: ExecutionStartupRecoveryStep
  readonly status?: 'none' | 'terminal' | 'continuation' | 'denied'
}

function fail(code: ExecutionStartupRecoveryCoordinatorErrorCode): never {
  throw new ExecutionStartupRecoveryCoordinatorError(code)
}

function captureMethod(
  owner: unknown,
  name: 'recover',
): ExecutionStartupRecoveryPortV1['recover'] {
  if (typeof owner !== 'object' || owner === null || utilTypes.isProxy(owner) ||
    Object.getPrototypeOf(owner) !== Object.prototype ||
    Object.getOwnPropertySymbols(owner).length !== 0) {
    fail('EXECUTION_RECOVERY_CONFIG_INVALID')
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
    fail('EXECUTION_RECOVERY_CONFIG_INVALID')
  }
  return descriptor.value as ExecutionStartupRecoveryPortV1['recover']
}

function captureEmitter(
  value: unknown,
): ((event: ExecutionStartupRecoveryEventV1) => void) | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    fail('EXECUTION_RECOVERY_CONFIG_INVALID')
  }
  return value as (event: ExecutionStartupRecoveryEventV1) => void
}

function captureResult(value: unknown): ExecutionStartupRecoveryStepResultV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('EXECUTION_RECOVERY_STEP_FAILED')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value') ||
    descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail('EXECUTION_RECOVERY_STEP_FAILED')
  }
  const raw = value as Record<string, unknown>
  const keys = Object.keys(descriptors).sort().join(',')
  if (raw['kind'] === 'none' && keys === 'kind') return Object.freeze({ kind: 'none' })
  if ((raw['kind'] === 'terminal' || raw['kind'] === 'continuation') &&
    keys === 'bindingHash,kind' && typeof raw['bindingHash'] === 'string' &&
    HASH.test(raw['bindingHash'])) {
    return Object.freeze({ kind: raw['kind'], bindingHash: raw['bindingHash'] })
  }
  if (raw['kind'] === 'denied' && keys === 'code,kind' &&
    typeof raw['code'] === 'string' && CODE.test(raw['code'])) {
    return Object.freeze({ kind: 'denied', code: raw['code'] })
  }
  fail('EXECUTION_RECOVERY_STEP_FAILED')
}

function safeEmit(
  emit: ((event: ExecutionStartupRecoveryEventV1) => void) | undefined,
  event: ExecutionStartupRecoveryEventV1,
): void {
  try { emit?.(Object.freeze({ ...event })) } catch { /* non-load-bearing */ }
}

const continuationControllers = new WeakSet<object>()

/**
 * Runs the three recovery subsystems under one genuine supervisor lease. A
 * denied or malformed step leaves the lease unreleased so the child can exit
 * and the parent can issue the same durable authority to a replacement.
 */
export async function runExecutionStartupRecoveryEnvelope(input: Readonly<{
  lease: ExecutionSupervisorLease
  telegram: ExecutionStartupRecoveryPortV1
  approvalStop: ExecutionStartupRecoveryPortV1
  delegation: ExecutionStartupRecoveryPortV1
  emit?: (event: ExecutionStartupRecoveryEventV1) => void
}>): Promise<ExecutionStartupRecoveryResultV1> {
  if (typeof input !== 'object' || input === null || utilTypes.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.getOwnPropertySymbols(input).length !== 0) {
    fail('EXECUTION_RECOVERY_CONFIG_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const keys = Object.keys(descriptors)
  if (['lease', 'telegram', 'approvalStop', 'delegation'].some(key => !keys.includes(key)) ||
    keys.some(key => !['lease', 'telegram', 'approvalStop', 'delegation', 'emit'].includes(key)) ||
    Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail('EXECUTION_RECOVERY_CONFIG_INVALID')
  }
  const lease = descriptors['lease']!.value as unknown
  const telegram = descriptors['telegram']!.value as unknown
  const approvalStop = descriptors['approvalStop']!.value as unknown
  const delegation = descriptors['delegation']!.value as unknown
  const emit = captureEmitter(descriptors['emit']?.value)
  if (!isGenuineExecutionSupervisorLease(lease) ||
    !HASH.test(lease.bindingHash) || !lease.isHeld()) {
    fail('EXECUTION_RECOVERY_AUTHORITY_INVALID')
  }
  const steps = Object.freeze([
    Object.freeze({
      name: 'telegram' as const,
      owner: telegram,
      recover: captureMethod(telegram, 'recover'),
    }),
    Object.freeze({
      name: 'approval-stop' as const,
      owner: approvalStop,
      recover: captureMethod(approvalStop, 'recover'),
    }),
    Object.freeze({
      name: 'delegation' as const,
      owner: delegation,
      recover: captureMethod(delegation, 'recover'),
    }),
  ])
  const rawContext = makeExecutionSupervisorRecoveryContextV1(lease)
  if (rawContext === null) fail('EXECUTION_RECOVERY_AUTHORITY_INVALID')
  const context = rawContext as ExecutionStartupRecoveryContextV1

  const runPass = async (): Promise<'clean' | 'continuation'> => {
    let nonEmpty = false
    let continuation = false
    for (const step of steps) {
      if (!lease.isHeld()) fail('EXECUTION_RECOVERY_AUTHORITY_LOST')
      let result: ExecutionStartupRecoveryStepResultV1
      try {
        result = captureResult(await step.recover.call(step.owner, context))
      } catch (error) {
        if (error instanceof ExecutionStartupRecoveryCoordinatorError) throw error
        fail('EXECUTION_RECOVERY_STEP_FAILED')
      }
      if (!lease.isHeld()) fail('EXECUTION_RECOVERY_AUTHORITY_LOST')
      safeEmit(emit, {
        kind: 'execution.startup-recovery.step',
        step: step.name,
        status: result.kind,
      })
      if (result.kind === 'denied') fail('EXECUTION_RECOVERY_STEP_DENIED')
      if (result.kind === 'none') continue
      nonEmpty = true
      if (result.bindingHash !== lease.bindingHash) {
        fail('EXECUTION_RECOVERY_AUTHORITY_INVALID')
      }
      if (result.kind === 'continuation') continuation = true
    }
    if (!nonEmpty && lease.authorityPhase === 'checkpoint-bound') {
      fail('EXECUTION_RECOVERY_STATE_MISSING')
    }
    return continuation ? 'continuation' : 'clean'
  }

  const release = async (): Promise<ExecutionStartupRecoveryReadyV1> => {
    if (!lease.isHeld()) fail('EXECUTION_RECOVERY_AUTHORITY_LOST')
    try { await lease.release() } catch { fail('EXECUTION_RECOVERY_RELEASE_FAILED') }
    if (lease.isHeld()) fail('EXECUTION_RECOVERY_RELEASE_FAILED')
    safeEmit(emit, { kind: 'execution.startup-recovery.ready' })
    return Object.freeze({ kind: 'ready' as const, bindingHash: lease.bindingHash })
  }

  if (await runPass() === 'clean') return release()

  let reconciling = false
  let completed = false
  const controller: ExecutionStartupRecoveryContinuationV1 = Object.freeze({
    kind: 'continuation-required' as const,
    bindingHash: lease.bindingHash,
    async reconcile() {
      if (!continuationControllers.has(this) || completed || reconciling) {
        fail('EXECUTION_RECOVERY_RECONCILE_BUSY')
      }
      reconciling = true
      try {
        if (await runPass() === 'continuation') return this
        const ready = await release()
        completed = true
        return ready
      } finally {
        reconciling = false
      }
    },
  })
  continuationControllers.add(controller)
  return controller
}

// Durable dormant backend for ADR-0092. It records research evidence and exact
// planned call hashes without persisting raw arguments. LIVE provider/tool
// composition is a separate gate.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { types as utilTypes } from 'node:util'

const HASH = /^[a-f0-9]{64}$/
const MAX_TASKS = 64
const MAX_RESEARCH_OBSERVATIONS = 64
const MAX_STEPS = 32
const MAX_PLAN_BYTES = 256 * 1024
const MAX_STATE_BYTES = 1024 * 1024
const MAX_JSON_NODES = 4096
const MAX_JSON_DEPTH = 16
const MAX_TEXT_BYTES = 64 * 1024
const TASK_DOMAIN = 'aisy.plan-execution.task.v1\0'
const ARGS_DOMAIN = 'aisy.plan-execution.args.v1\0'
const PLAN_DOMAIN = 'aisy.plan-execution.plan.v1\0'

export type PlanExecutionToolEffect = 'read' | 'write' | 'execute' | 'delegate'
/**
 * `submitted` — план подан и ждёт решения оператора; `approved` — решение
 * получено, шаги можно исполнять. Разделение несущее: без него «показал план»
 * и «выполняю план» — одно состояние, и согласие человека нигде не хранится.
 */
export type PlanExecutionPhase =
  | 'research'
  | 'submitted'
  | 'approved'
  | 'attempted'
  | 'completed'
  | 'ambiguous'

export type PlanExecutionErrorCode =
  | 'PLAN_EXECUTION_INPUT_INVALID'
  | 'PLAN_EXECUTION_STATE_CORRUPT'
  | 'PLAN_EXECUTION_STATE_UNAVAILABLE'
  | 'PLAN_EXECUTION_RESEARCH_REQUIRED'
  | 'PLAN_EXECUTION_PLAN_INVALID'
  | 'PLAN_EXECUTION_PLAN_DRIFT'
  | 'PLAN_EXECUTION_ACTION_AMBIGUOUS'
  | 'PLAN_EXECUTION_ALREADY_COMPLETED'
  | 'PLAN_EXECUTION_APPROVAL_REQUIRED'
  | 'PLAN_EXECUTION_CAPACITY_EXCEEDED'
  | 'PLAN_EXECUTION_PERMIT_INVALID'

export class PlanExecutionStateError extends Error {
  constructor(readonly code: PlanExecutionErrorCode) {
    super(code)
    this.name = 'PlanExecutionStateError'
  }
}

export interface PlanExecutionIdentityV1 {
  readonly version: 1
  readonly sessionId: string
  readonly turnId: string
  readonly workBindingHash: string
  readonly policyRevision: string
}

export interface PlanExecutionCallV1 {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface PlanExecutionPersistencePort {
  load(): unknown
  save(state: PlanExecutionPersistedStateV1): void
}

export interface PlanExecutionPersistedStepV1 {
  readonly tool: string
  readonly argsHash: string
}

export interface PlanExecutionPersistedTaskV1 {
  readonly taskBindingHash: string
  readonly revision: number
  readonly phase: PlanExecutionPhase
  readonly researchObservations: number
  readonly planHash: string | null
  readonly steps: readonly PlanExecutionPersistedStepV1[]
  readonly nextStep: number
  readonly updatedAtMs: number
}

export interface PlanExecutionPersistedStateV1 {
  readonly schemaVersion: 1
  readonly tasks: readonly PlanExecutionPersistedTaskV1[]
}

const permitBrand: unique symbol = Symbol('aisy.plan-execution-permit')

export interface PlanExecutionPermitV1 {
  readonly [permitBrand]: true
  readonly kind: 'plan-execution-permit-v1'
}

interface PermitState {
  controller: object
  taskBindingHash: string
  revision: number
  stepIndex: number
}

const permitStates = new WeakMap<object, PermitState>()
const consumedPermits = new WeakSet<object>()

export interface PlanExecutionStateController {
  observeResearch(
    identity: PlanExecutionIdentityV1,
    call: PlanExecutionCallV1,
    succeeded: boolean,
  ): Readonly<{ kind: 'recorded' | 'ignored'; observations: number }>
  submitPlan(
    identity: PlanExecutionIdentityV1,
    planJson: string,
  ): Readonly<{ kind: 'accepted' | 'already-accepted' | 'already-completed'; planHash: string; nextStep: number; totalSteps: number }>
  /**
   * Решение оператора по поданному плану. Принимается только для точного
   * `planHash`: одобрение относится к тому плану, который человек прочитал, а
   * не к тому, который модель подала следом.
   */
  approvePlan(
    identity: PlanExecutionIdentityV1,
    planHash: string,
  ): Readonly<{ kind: 'approved' | 'already-approved'; totalSteps: number }>
  /** Отказ оператора: задача возвращается к исследованию, план забывается. */
  rejectPlan(identity: PlanExecutionIdentityV1): Readonly<{ kind: 'rejected' | 'nothing-to-reject' }>
  preflightPlannedCall(
    identity: PlanExecutionIdentityV1,
    call: PlanExecutionCallV1,
  ): Readonly<{ kind: 'matched'; nextStep: number; totalSteps: number }>
  admitPlannedCall(
    identity: PlanExecutionIdentityV1,
    call: PlanExecutionCallV1,
  ): PlanExecutionPermitV1
  settlePlannedCall(
    permit: PlanExecutionPermitV1,
    outcome: Readonly<{ succeeded: boolean }>,
  ): Readonly<{ kind: 'advanced' | 'completed' | 'research-required'; nextStep: number }>
  status(identity: PlanExecutionIdentityV1): Readonly<{
    phase: PlanExecutionPhase
    revision: number
    researchObservations: number
    nextStep: number
    totalSteps: number
  }> | null
}

interface CapturedControllerOptions {
  persistence: PlanExecutionPersistencePort
  toolEffect(name: string): PlanExecutionToolEffect | null
  nowMs(): number
}

function fail(code: PlanExecutionErrorCode): PlanExecutionStateError {
  return new PlanExecutionStateError(code)
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    throw fail('PLAN_EXECUTION_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value as object) as Record<string, PropertyDescriptor>
  const own = Object.keys(descriptors)
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) {
    throw fail('PLAN_EXECUTION_INPUT_INVALID')
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined) {
      throw fail('PLAN_EXECUTION_INPUT_INVALID')
    }
    out[key] = descriptor.value
  }
  return out
}

function exactArray(
  value: unknown,
  maximum: number,
  errorCode: 'PLAN_EXECUTION_PLAN_INVALID' | 'PLAN_EXECUTION_STATE_CORRUPT',
): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) throw fail(errorCode)
  const descriptors = Object.getOwnPropertyDescriptors(value as object) as Record<string, PropertyDescriptor>
  const lengthDescriptor = descriptors['length']
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum) throw fail(errorCode)
  const length = Number(lengthDescriptor.value)
  const keys = Object.keys(descriptors).filter(key => key !== 'length')
  if (keys.length !== length) throw fail(errorCode)
  const snapshot: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined) throw fail(errorCode)
    snapshot.push(descriptor.value)
  }
  return snapshot
}

function captureControllerOptions(value: unknown): CapturedControllerOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) throw fail('PLAN_EXECUTION_INPUT_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (!keys.includes('persistence') || !keys.includes('toolEffect') ||
    keys.some(key => !['persistence', 'toolEffect', 'nowMs'].includes(key))) {
    throw fail('PLAN_EXECUTION_INPUT_INVALID')
  }
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) throw fail('PLAN_EXECUTION_INPUT_INVALID')
  }
  const persistenceSource = descriptors['persistence']!.value
  const persistence = exactRecord(persistenceSource, ['load', 'save'])
  const load = persistence['load']
  const save = persistence['save']
  const toolEffect = descriptors['toolEffect']!.value
  const nowMs = descriptors['nowMs']?.value ?? Date.now
  for (const method of [load, save, toolEffect, nowMs]) {
    if (typeof method !== 'function' || utilTypes.isProxy(method)) {
      throw fail('PLAN_EXECUTION_INPUT_INVALID')
    }
  }
  const capturedPersistence: PlanExecutionPersistencePort = Object.freeze({
    load: (): unknown => Reflect.apply(load as (...args: never[]) => unknown, persistenceSource, []),
    save: (state: PlanExecutionPersistedStateV1): void => {
      Reflect.apply(save as (...args: unknown[]) => unknown, persistenceSource, [state])
    },
  })
  return Object.freeze({
    persistence: capturedPersistence,
    toolEffect: (name: string): PlanExecutionToolEffect | null => {
      let result: unknown
      try { result = Reflect.apply(toolEffect as (...args: unknown[]) => unknown, undefined, [name]) } catch {
        throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
      }
      if (result !== null && (typeof result !== 'string' ||
        !['read', 'write', 'execute', 'delegate'].includes(result))) {
        throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
      }
      return result as PlanExecutionToolEffect | null
    },
    nowMs: (): number => Reflect.apply(nowMs as (...args: never[]) => number, undefined, []),
  })
}

function boundedText(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
    value.includes('\0')) throw fail('PLAN_EXECUTION_INPUT_INVALID')
  return value
}

function sha256(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update(value, 'utf8').digest('hex')
}

function identityHash(value: unknown): string {
  const input = exactRecord(value, [
    'version', 'sessionId', 'turnId', 'workBindingHash', 'policyRevision',
  ])
  if (input['version'] !== 1 || typeof input['workBindingHash'] !== 'string' ||
    !HASH.test(input['workBindingHash'])) throw fail('PLAN_EXECUTION_INPUT_INVALID')
  const tuple = [
    boundedText(input['sessionId']),
    boundedText(input['turnId']),
    input['workBindingHash'],
    boundedText(input['policyRevision']),
  ]
  return sha256(TASK_DOMAIN, JSON.stringify(tuple))
}

function canonicalJson(value: unknown): string {
  let nodes = 0
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes++
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw fail('PLAN_EXECUTION_PLAN_INVALID')
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'string') {
      if (Buffer.byteLength(candidate, 'utf8') > MAX_TEXT_BYTES || candidate.includes('\0')) {
        throw fail('PLAN_EXECUTION_PLAN_INVALID')
      }
      return candidate
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw fail('PLAN_EXECUTION_PLAN_INVALID')
      return candidate
    }
    if (Array.isArray(candidate)) {
      return exactArray(candidate, MAX_JSON_NODES, 'PLAN_EXECUTION_PLAN_INVALID')
        .map(item => visit(item, depth + 1))
    }
    if (typeof candidate !== 'object' || candidate === null || utilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      Object.getOwnPropertySymbols(candidate).length !== 0) {
      throw fail('PLAN_EXECUTION_PLAN_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!
      if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
        descriptor.set !== undefined) throw fail('PLAN_EXECUTION_PLAN_INVALID')
      Object.defineProperty(out, key, {
        value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true,
      })
    }
    return out
  }
  const encoded = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PLAN_BYTES) {
    throw fail('PLAN_EXECUTION_PLAN_INVALID')
  }
  return encoded
}

function snapshotCall(value: unknown): { tool: string; argsHash: string; canonicalArgs: string } {
  const call = exactRecord(value, ['name', 'args'])
  const tool = boundedText(call['name'], 200)
  if (tool === 'submit_plan') throw fail('PLAN_EXECUTION_PLAN_INVALID')
  const argsRecord = exactRecordRoot(call['args'])
  const canonicalArgs = canonicalJson(argsRecord)
  return { tool, argsHash: sha256(ARGS_DOMAIN, canonicalArgs), canonicalArgs }
}

/** Returns a caller-detached JSON snapshot whose bytes are exactly the ones
 * hashed by the durable Plan Mode controller. */
export function snapshotPlanExecutionCallV1(value: unknown): PlanExecutionCallV1 {
  const captured = snapshotCall(value)
  const args = JSON.parse(captured.canonicalArgs) as Record<string, unknown>
  return Object.freeze({ name: captured.tool, args: Object.freeze(args) })
}

function exactRecordRoot(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    throw fail('PLAN_EXECUTION_PLAN_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const out: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) throw fail('PLAN_EXECUTION_PLAN_INVALID')
    Object.defineProperty(out, key, {
      value: descriptor.value, enumerable: true, configurable: true,
    })
  }
  return out
}

function parsePlan(
  raw: string,
  toolEffect: (name: string) => PlanExecutionToolEffect | null,
): { planHash: string; steps: PlanExecutionPersistedStepV1[] } {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw, 'utf8') > MAX_PLAN_BYTES) {
    throw fail('PLAN_EXECUTION_PLAN_INVALID')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw fail('PLAN_EXECUTION_PLAN_INVALID') }
  let plan: Record<string, unknown>
  try { plan = exactRecord(parsed, ['version', 'steps']) } catch {
    throw fail('PLAN_EXECUTION_PLAN_INVALID')
  }
  const rawSteps = exactArray(plan['steps'], MAX_STEPS, 'PLAN_EXECUTION_PLAN_INVALID')
  if (plan['version'] !== 1 || rawSteps.length === 0) throw fail('PLAN_EXECUTION_PLAN_INVALID')
  const steps = rawSteps.map((value) => {
    let step: Record<string, unknown>
    try { step = exactRecord(value, ['intent', 'call']) } catch {
      throw fail('PLAN_EXECUTION_PLAN_INVALID')
    }
    let call: ReturnType<typeof snapshotCall>
    try {
      boundedText(step['intent'], 1000)
      call = snapshotCall(step['call'])
    } catch {
      throw fail('PLAN_EXECUTION_PLAN_INVALID')
    }
    if (toolEffect(call.tool) === null) throw fail('PLAN_EXECUTION_PLAN_INVALID')
    return Object.freeze({ tool: call.tool, argsHash: call.argsHash })
  })
  return { planHash: planHashForSteps(steps), steps }
}

function planHashForSteps(steps: readonly PlanExecutionPersistedStepV1[]): string {
  return sha256(PLAN_DOMAIN, canonicalJson(steps.map(step => [step.tool, step.argsHash])))
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw fail('PLAN_EXECUTION_STATE_CORRUPT')
  }
  return value
}

function parseState(value: unknown): Map<string, PlanExecutionPersistedTaskV1> {
  if (value === undefined) return new Map()
  let state: Record<string, unknown>
  try { state = exactRecord(value, ['schemaVersion', 'tasks']) } catch {
    throw fail('PLAN_EXECUTION_STATE_CORRUPT')
  }
  const rawTasks = exactArray(state['tasks'], MAX_TASKS, 'PLAN_EXECUTION_STATE_CORRUPT')
  if (state['schemaVersion'] !== 1) throw fail('PLAN_EXECUTION_STATE_CORRUPT')
  const tasks = new Map<string, PlanExecutionPersistedTaskV1>()
  for (const raw of rawTasks) {
    let item: Record<string, unknown>
    try {
      item = exactRecord(raw, [
        'taskBindingHash', 'revision', 'phase', 'researchObservations', 'planHash',
        'steps', 'nextStep', 'updatedAtMs',
      ])
    } catch { throw fail('PLAN_EXECUTION_STATE_CORRUPT') }
    if (typeof item['taskBindingHash'] !== 'string' || !HASH.test(item['taskBindingHash']) ||
      typeof item['phase'] !== 'string' ||
      !['research', 'submitted', 'approved', 'attempted', 'completed', 'ambiguous'].includes(item['phase']) ||
      (item['planHash'] !== null && (typeof item['planHash'] !== 'string' || !HASH.test(item['planHash']))) ||
      !Array.isArray(item['steps'])) {
      throw fail('PLAN_EXECUTION_STATE_CORRUPT')
    }
    const rawSteps = exactArray(item['steps'], MAX_STEPS, 'PLAN_EXECUTION_STATE_CORRUPT')
    const steps = rawSteps.map(rawStep => {
      let step: Record<string, unknown>
      try { step = exactRecord(rawStep, ['tool', 'argsHash']) } catch {
        throw fail('PLAN_EXECUTION_STATE_CORRUPT')
      }
      if (typeof step['tool'] !== 'string' || step['tool'].length === 0 || step['tool'].length > 200 ||
        typeof step['argsHash'] !== 'string' || !HASH.test(step['argsHash'])) {
        throw fail('PLAN_EXECUTION_STATE_CORRUPT')
      }
      return Object.freeze({ tool: step['tool'], argsHash: step['argsHash'] })
    })
    const phase = item['phase'] as PlanExecutionPhase
    const researchObservations = integer(item['researchObservations'], 0, MAX_RESEARCH_OBSERVATIONS)
    const nextStep = integer(item['nextStep'], 0, steps.length)
    if ((phase === 'research' && (item['planHash'] !== null || steps.length !== 0 || nextStep !== 0)) ||
      (phase !== 'research' && (item['planHash'] === null || steps.length === 0)) ||
      (phase !== 'research' && researchObservations === 0) ||
      (phase !== 'research' && item['planHash'] !== planHashForSteps(steps)) ||
      (phase === 'completed' && nextStep !== steps.length) ||
      ((phase === 'submitted' || phase === 'approved' || phase === 'attempted' ||
        phase === 'ambiguous') && nextStep >= steps.length)) {
      throw fail('PLAN_EXECUTION_STATE_CORRUPT')
    }
    const task: PlanExecutionPersistedTaskV1 = Object.freeze({
      taskBindingHash: item['taskBindingHash'],
      revision: integer(item['revision'], 1),
      phase,
      researchObservations,
      planHash: item['planHash'] as string | null,
      steps: Object.freeze(steps),
      nextStep,
      updatedAtMs: integer(item['updatedAtMs'], 0),
    })
    if (tasks.has(task.taskBindingHash)) throw fail('PLAN_EXECUTION_STATE_CORRUPT')
    tasks.set(task.taskBindingHash, task)
  }
  return tasks
}

function persisted(tasks: Map<string, PlanExecutionPersistedTaskV1>): PlanExecutionPersistedStateV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    tasks: Object.freeze([...tasks.values()].sort((a, b) =>
      a.taskBindingHash.localeCompare(b.taskBindingHash))),
  })
}

function replaceTask(
  tasks: Map<string, PlanExecutionPersistedTaskV1>,
  task: PlanExecutionPersistedTaskV1,
): Map<string, PlanExecutionPersistedTaskV1> {
  const next = new Map(tasks)
  next.set(task.taskBindingHash, Object.freeze({ ...task, steps: Object.freeze([...task.steps]) }))
  return next
}

export function makePlanExecutionStateController(options: {
  persistence: PlanExecutionPersistencePort
  toolEffect(name: string): PlanExecutionToolEffect | null
  nowMs?: () => number
}): PlanExecutionStateController {
  const captured = captureControllerOptions(options)
  const persistence = captured.persistence
  const toolEffect = captured.toolEffect
  const nowMs = captured.nowMs
  let loaded: unknown
  try { loaded = persistence.load() } catch (error) {
    if (error instanceof PlanExecutionStateError) throw error
    throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
  }
  let tasks = parseState(loaded)
  const controllerAuthority = Object.freeze({})

  const publish = (next: Map<string, PlanExecutionPersistedTaskV1>): void => {
    try { persistence.save(persisted(next)) } catch {
      throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
    }
    tasks = next
  }

  const now = (): number => {
    let value: number
    try { value = nowMs() } catch { throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE') }
    if (!Number.isSafeInteger(value) || value < 0) throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
    return value
  }

  const recovered = new Map(tasks)
  let changed = false
  for (const [key, task] of recovered) {
    if (task.phase !== 'attempted') continue
    recovered.set(key, Object.freeze({ ...task, phase: 'ambiguous', updatedAtMs: now() }))
    changed = true
  }
  if (changed) publish(recovered)

  const newResearch = (taskBindingHash: string, revision = 1): PlanExecutionPersistedTaskV1 =>
    Object.freeze({
      taskBindingHash,
      revision,
      phase: 'research' as const,
      researchObservations: 0,
      planHash: null,
      steps: Object.freeze([]),
      nextStep: 0,
      updatedAtMs: now(),
    })

  const ensureCapacity = (): void => {
    if (tasks.size < MAX_TASKS) return
    // A user may inspect and abandon many turns without submitting a plan.
    // Research, submitted and completed rows carry no attempted side effect,
    // so the oldest one is safe to evict. Attempted/ambiguous rows are kept.
    const recyclable = [...tasks.values()]
      .filter(task => task.phase === 'completed' || task.phase === 'research' || task.phase === 'submitted')
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
    if (recyclable.length === 0) throw fail('PLAN_EXECUTION_CAPACITY_EXCEEDED')
    const next = new Map(tasks)
    next.delete(recyclable[0]!.taskBindingHash)
    publish(next)
  }

  const matchingSubmittedCall = (
    identity: PlanExecutionIdentityV1,
    call: PlanExecutionCallV1,
  ): { key: string; current: PlanExecutionPersistedTaskV1 } => {
    const key = identityHash(identity)
    const current = tasks.get(key)
    if (current === undefined || current.phase === 'research') {
      throw fail('PLAN_EXECUTION_RESEARCH_REQUIRED')
    }
    if (current.phase === 'attempted' || current.phase === 'ambiguous') {
      throw fail('PLAN_EXECUTION_ACTION_AMBIGUOUS')
    }
    if (current.phase === 'completed') throw fail('PLAN_EXECUTION_ALREADY_COMPLETED')
    // Показанный план — ещё не разрешённый. Пока оператор не ответил, шаг не
    // начинается: это вся разница между «вот что я собираюсь сделать» и «делаю».
    if (current.phase === 'submitted') throw fail('PLAN_EXECUTION_APPROVAL_REQUIRED')
    const candidate = snapshotCall(call)
    const expected = current.steps[current.nextStep]!
    if (candidate.tool !== expected.tool || candidate.argsHash !== expected.argsHash) {
      const reset = newResearch(key, current.revision + 1)
      publish(replaceTask(tasks, reset))
      throw fail('PLAN_EXECUTION_PLAN_DRIFT')
    }
    return { key, current }
  }

  const controller: PlanExecutionStateController = Object.freeze({
    observeResearch(
      identity: PlanExecutionIdentityV1,
      call: PlanExecutionCallV1,
      succeeded: boolean,
    ) {
      const key = identityHash(identity)
      const captured = snapshotCall(call)
      if (toolEffect(captured.tool) !== 'read' || succeeded !== true) {
        return Object.freeze({ kind: 'ignored' as const, observations: tasks.get(key)?.researchObservations ?? 0 })
      }
      let task = tasks.get(key)
      if (task === undefined) {
        ensureCapacity()
        task = newResearch(key)
      }
      if (task.phase !== 'research') {
        return Object.freeze({ kind: 'ignored' as const, observations: task.researchObservations })
      }
      const observations = Math.min(task.researchObservations + 1, MAX_RESEARCH_OBSERVATIONS)
      publish(replaceTask(tasks, Object.freeze({ ...task, researchObservations: observations, updatedAtMs: now() })))
      return Object.freeze({ kind: 'recorded' as const, observations })
    },

    submitPlan(identity: PlanExecutionIdentityV1, planJson: string) {
      const key = identityHash(identity)
      const normalized = parsePlan(planJson, toolEffect)
      const current = tasks.get(key)
      if (current === undefined || current.researchObservations === 0) {
        throw fail('PLAN_EXECUTION_RESEARCH_REQUIRED')
      }
      if (current.phase === 'attempted' || current.phase === 'ambiguous') {
        throw fail('PLAN_EXECUTION_ACTION_AMBIGUOUS')
      }
      if (current.planHash === normalized.planHash &&
        (current.phase === 'submitted' || current.phase === 'approved' ||
          current.phase === 'completed')) {
        return Object.freeze({
          kind: current.phase === 'completed' ? 'already-completed' as const : 'already-accepted' as const,
          planHash: normalized.planHash,
          nextStep: current.nextStep,
          totalSteps: current.steps.length,
        })
      }
      if (current.phase !== 'research') throw fail('PLAN_EXECUTION_PLAN_DRIFT')
      const task: PlanExecutionPersistedTaskV1 = Object.freeze({
        ...current,
        phase: 'submitted',
        planHash: normalized.planHash,
        steps: Object.freeze(normalized.steps),
        nextStep: 0,
        updatedAtMs: now(),
      })
      publish(replaceTask(tasks, task))
      return Object.freeze({
        kind: 'accepted' as const,
        planHash: normalized.planHash,
        nextStep: 0,
        totalSteps: normalized.steps.length,
      })
    },

    approvePlan(identity: PlanExecutionIdentityV1, planHash: string) {
      const key = identityHash(identity)
      const current = tasks.get(key)
      if (typeof planHash !== 'string' || !HASH.test(planHash)) {
        throw fail('PLAN_EXECUTION_INPUT_INVALID')
      }
      if (current === undefined || current.phase === 'research') {
        throw fail('PLAN_EXECUTION_RESEARCH_REQUIRED')
      }
      // Одобрение привязано к точному плану: если модель успела подать другой,
      // согласие человека к нему не относится.
      if (current.planHash !== planHash) throw fail('PLAN_EXECUTION_PLAN_DRIFT')
      if (current.phase === 'attempted' || current.phase === 'ambiguous') {
        throw fail('PLAN_EXECUTION_ACTION_AMBIGUOUS')
      }
      if (current.phase === 'completed') throw fail('PLAN_EXECUTION_ALREADY_COMPLETED')
      if (current.phase === 'approved') {
        return Object.freeze({ kind: 'already-approved' as const, totalSteps: current.steps.length })
      }
      publish(replaceTask(tasks, Object.freeze({
        ...current, phase: 'approved' as const, updatedAtMs: now(),
      })))
      return Object.freeze({ kind: 'approved' as const, totalSteps: current.steps.length })
    },

    rejectPlan(identity: PlanExecutionIdentityV1) {
      const key = identityHash(identity)
      const current = tasks.get(key)
      if (current === undefined || current.phase === 'research') {
        return Object.freeze({ kind: 'nothing-to-reject' as const })
      }
      // Отказ сужает полномочия, поэтому проходит всегда — кроме уже начатого
      // действия, где отменять нечего: мир мог измениться.
      if (current.phase === 'attempted' || current.phase === 'ambiguous') {
        throw fail('PLAN_EXECUTION_ACTION_AMBIGUOUS')
      }
      publish(replaceTask(tasks, newResearch(key, current.revision + 1)))
      return Object.freeze({ kind: 'rejected' as const })
    },

    preflightPlannedCall(identity: PlanExecutionIdentityV1, call: PlanExecutionCallV1) {
      const { current } = matchingSubmittedCall(identity, call)
      return Object.freeze({
        kind: 'matched' as const,
        nextStep: current.nextStep,
        totalSteps: current.steps.length,
      })
    },

    admitPlannedCall(identity: PlanExecutionIdentityV1, call: PlanExecutionCallV1) {
      const { key, current } = matchingSubmittedCall(identity, call)
      const attempted = Object.freeze({ ...current, phase: 'attempted' as const, updatedAtMs: now() })
      publish(replaceTask(tasks, attempted))
      const permit: PlanExecutionPermitV1 = Object.freeze({
        [permitBrand]: true as const,
        kind: 'plan-execution-permit-v1' as const,
      })
      permitStates.set(permit, {
        controller: controllerAuthority,
        taskBindingHash: key,
        revision: current.revision,
        stepIndex: current.nextStep,
      })
      return permit
    },

    settlePlannedCall(
      permit: PlanExecutionPermitV1,
      outcome: Readonly<{ succeeded: boolean }>,
    ) {
      if (typeof permit !== 'object' || permit === null || utilTypes.isProxy(permit) ||
        consumedPermits.has(permit)) throw fail('PLAN_EXECUTION_PERMIT_INVALID')
      const authority = permitStates.get(permit)
      let capturedOutcome: Record<string, unknown>
      try { capturedOutcome = exactRecord(outcome, ['succeeded']) } catch {
        throw fail('PLAN_EXECUTION_PERMIT_INVALID')
      }
      if (authority === undefined || authority.controller !== controllerAuthority ||
        typeof capturedOutcome['succeeded'] !== 'boolean') throw fail('PLAN_EXECUTION_PERMIT_INVALID')
      const current = tasks.get(authority.taskBindingHash)
      if (current === undefined || current.phase !== 'attempted' ||
        current.revision !== authority.revision || current.nextStep !== authority.stepIndex) {
        throw fail('PLAN_EXECUTION_PERMIT_INVALID')
      }
      if (!capturedOutcome['succeeded']) {
        const reset = newResearch(current.taskBindingHash, current.revision + 1)
        publish(replaceTask(tasks, reset))
        consumedPermits.add(permit)
        return Object.freeze({ kind: 'research-required' as const, nextStep: 0 })
      }
      const nextStep = current.nextStep + 1
      const completed = nextStep === current.steps.length
      // Одобрен план целиком, а не отдельный шаг: следующий шаг того же плана
      // возвращается в `approved`, иначе оператора спрашивали бы на каждом.
      const next = Object.freeze({
        ...current,
        phase: completed ? 'completed' as const : 'approved' as const,
        nextStep,
        updatedAtMs: now(),
      })
      publish(replaceTask(tasks, next))
      consumedPermits.add(permit)
      return Object.freeze({
        kind: completed ? 'completed' as const : 'advanced' as const,
        nextStep,
      })
    },

    status(identity: PlanExecutionIdentityV1) {
      const task = tasks.get(identityHash(identity))
      return task === undefined ? null : Object.freeze({
        phase: task.phase,
        revision: task.revision,
        researchObservations: task.researchObservations,
        nextStep: task.nextStep,
        totalSteps: task.steps.length,
      })
    },
  })
  return controller
}

export function makeNodePlanExecutionPersistence(input: {
  path: string
}): PlanExecutionPersistencePort {
  let capturedInput: Record<string, unknown>
  try { capturedInput = exactRecord(input, ['path']) } catch {
    throw fail('PLAN_EXECUTION_INPUT_INVALID')
  }
  const path = capturedInput['path']
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path ||
    path.includes('\0')) throw fail('PLAN_EXECUTION_INPUT_INVALID')
  const parent = dirname(path)
  let parentStat: ReturnType<typeof lstatSync>
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    parentStat = lstatSync(parent)
    const owner = typeof process.getuid !== 'function' || parentStat.uid === process.getuid()
    if (realpathSync(parent) !== parent || !parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      !owner || (parentStat.mode & 0o077) !== 0) throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
  } catch (error) {
    if (error instanceof PlanExecutionStateError) throw error
    throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
  }

  const assertParent = (): void => {
    try {
      const current = lstatSync(parent)
      const currentOwner = typeof process.getuid !== 'function' || current.uid === process.getuid()
      if (realpathSync(parent) !== parent || !current.isDirectory() || current.isSymbolicLink() ||
        !currentOwner || (current.mode & 0o077) !== 0 || current.dev !== parentStat.dev ||
        current.ino !== parentStat.ino) throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
    } catch (error) {
      if (error instanceof PlanExecutionStateError) throw error
      throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
    }
  }

  const syncParent = (): void => {
    const descriptor = openSync(parent, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }

  return Object.freeze({
    load(): unknown {
      assertParent()
      let descriptor: number
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
      }
      try {
        assertParent()
        const stat = fstatSync(descriptor)
        const fileOwner = typeof process.getuid !== 'function' || stat.uid === process.getuid()
        if (!stat.isFile() || stat.nlink !== 1 || !fileOwner || (stat.mode & 0o077) !== 0 ||
          stat.size < 1 || stat.size > MAX_STATE_BYTES) throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
        return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
      } catch (error) {
        if (error instanceof PlanExecutionStateError) throw error
        throw fail('PLAN_EXECUTION_STATE_CORRUPT')
      } finally {
        closeSync(descriptor)
      }
    },
    save(state: PlanExecutionPersistedStateV1): void {
      assertParent()
      let normalized: PlanExecutionPersistedStateV1
      try { normalized = persisted(parseState(state)) } catch {
        throw fail('PLAN_EXECUTION_STATE_CORRUPT')
      }
      const encoded = `${JSON.stringify(normalized)}\n`
      if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) {
        throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      let descriptor: number | null = null
      try {
        descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        fchmodSync(descriptor, 0o600)
        writeFileSync(descriptor, encoded, 'utf8')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = null
        assertParent()
        renameSync(temporary, path)
        assertParent()
        syncParent()
      } catch (error) {
        if (descriptor !== null) try { closeSync(descriptor) } catch { /* owned fd */ }
        try { unlinkSync(temporary) } catch { /* not published or already renamed */ }
        if (error instanceof PlanExecutionStateError) throw error
        throw fail('PLAN_EXECUTION_STATE_UNAVAILABLE')
      }
    },
  })
}

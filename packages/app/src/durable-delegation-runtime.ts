import { isAbsolute, normalize } from 'node:path'
import {
  canonicalizeIterationCost,
  iterationCostSpendNanos,
  makeDelegationManager,
  runBoundedDelegation,
  type AgentCard,
  type BoundedDelegationOutcome,
  type DelegationAuthorityJournal,
  type DelegationHandle,
  type DelegationManager,
  type DelegationPersistencePort,
  type DelegationRecoveryPreflight,
  type DelegationTask,
  type IterationCost,
  type OrchestrationEvent,
  type PlanDAG,
  type ResolvedWorkBinding,
  type ShardEntry,
  type TaskObservation,
} from '@aisy/core'
import {
  makeNodeDelegationPersistence,
  makeNodeDelegationRunLock,
} from './delegation-persistence.js'

export type DurableDelegationRuntimeErrorCode =
  | 'DELEGATION_RUNTIME_CONFIG_INVALID'
  | 'DELEGATION_RUNTIME_ALREADY_USED'
  | 'DELEGATION_RECOVERY_DENIED'
  | 'DELEGATION_PERSISTENCE_FAILED'
  | 'DELEGATION_CANCELLATION_UNCONFIRMED'
  | 'DELEGATION_OPERATION_AMBIGUOUS'
  | 'DELEGATION_MANUAL_RECOVERY_REQUIRED'
  | 'DELEGATION_BUDGET_METER_FAILED'
  | 'DELEGATION_RUN_LOCK_HELD'

export class DurableDelegationRuntimeError extends Error {
  constructor(public readonly code: DurableDelegationRuntimeErrorCode) {
    super(code)
    this.name = 'DurableDelegationRuntimeError'
  }
}

const genuineRuntimeErrors = new WeakMap<object, DurableDelegationRuntimeErrorCode>()

/** Structural copies and caller-constructed errors cannot pause a parent turn. */
export function durableDelegationRecoverableRuntimeErrorCode(
  value: unknown,
): DurableDelegationRecoverableInterruptionCode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = genuineRuntimeErrors.get(value)
  return code === 'DELEGATION_OPERATION_AMBIGUOUS' ||
    code === 'DELEGATION_MANUAL_RECOVERY_REQUIRED' ? code : undefined
}

export type DurableDelegationRecoverableInterruptionCode =
  | 'DELEGATION_OPERATION_AMBIGUOUS'
  | 'DELEGATION_MANUAL_RECOVERY_REQUIRED'

export interface DurableDelegationRecoverableInterruption {
  readonly kind: 'durable-delegation-recoverable-interruption'
  readonly code: DurableDelegationRecoverableInterruptionCode
}

export type DurableDelegationFailureCode =
  | 'CANCELLED'
  | 'TASK_EXECUTION_FAILED'
  | 'TASK_RESULT_INVALID'
  | 'TASK_BUDGET_EXCEEDED'
  | 'VERIFICATION_FAILED'
  | 'UNVERIFIED_RESULT'

export interface DurableDelegationCandidate {
  readonly summary: string
  readonly result: unknown
}

export interface DurableDelegationOperation<T> {
  /** Resolves only after the operation has no retained/background effects. */
  readonly result: Promise<T>
  /** Resolves only after the operation and all of its external effects stopped. */
  cancel(): Promise<void>
}

export type DurableDelegationVerification =
  | {
      readonly verified: true
      readonly evidenceId: string
      readonly summary: string
      readonly result: unknown
    }
  | {
      readonly verified: false
      readonly reasonCode: 'EVIDENCE_MISSING' | 'POSTCONDITION_FAILED' | 'SCOPE_NOT_PROVEN'
    }

export type DurableDelegationExecutionHandle = Pick<
  DelegationHandle,
  | 'delegationId'
  | 'taskId'
  | 'binding'
  | 'card'
  | 'owns'
  | 'writableMcp'
  | 'permitsTool'
  | 'permitsMcp'
  | 'append'
  | 'shard'
  | 'guardian'
> & {
  /** Manager-owned narrow port used to seal a bound child before provider I/O. */
  readonly authorityJournal: DelegationAuthorityJournal
}

export interface DurableDelegationRuntimeEvent {
  readonly kind:
    | 'delegation.runtime.started'
    | 'delegation.runtime.replayed'
    | 'delegation.runtime.resumed'
    | 'delegation.runtime.verified'
    | 'delegation.runtime.denied'
    | 'delegation.runtime.cancelled'
    | 'delegation.runtime.completed'
  readonly delegationId?: string
  readonly taskId?: string
  readonly code?: DurableDelegationFailureCode
}

export interface DurableDelegationRuntime {
  execute(signal?: AbortSignal): Promise<TaskObservation[]>
  cancel(): void
}

export interface DurableDelegationRecoveryInspectionInput {
  runRoot: string
  binding: ResolvedWorkBinding
  plan: PlanDAG
  resolveCard(name: string): AgentCard | undefined
  skillTouchedPaths(skill: string): string[]
  mcpWritable(server: string): boolean
  isBindingActive(binding: ResolvedWorkBinding): boolean
}

interface DurableDelegationRecoveryState {
  readonly preflight: DelegationRecoveryPreflight
  readonly runSnapshot: unknown
  readonly activeTaskIds: readonly string[]
  readonly terminalTaskIds: ReadonlySet<string>
  readonly storedByTaskId: ReadonlyMap<string, unknown>
}

const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_SUMMARY_BYTES = 8 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_WALL_MS = 24 * 60 * 60 * 1000
const MAX_PLAN_TASKS = 256
const MAX_PLAN_EDGES = 2048
const MAX_TASK_DEPENDENCIES = 64
const ZERO_COST: IterationCost = Object.freeze({ iterations: 0, spendUsd: 0, wallMs: 0 })
const RESERVED_KIND_PREFIX = 'runtime.'
const AUTHORITY_SEAL_KIND = 'runtime.agent-authority.v1'
const SHA256_HEX = /^[a-f0-9]{64}$/
const recoverableInterruptionCodes = new WeakMap<
  object,
  DurableDelegationRecoverableInterruptionCode
>()

interface CanonicalCost {
  readonly iterations: number
  readonly spendUsdNanos: number
  readonly wallMs: number
}

type TerminalDraft =
  | {
      kind: 'verified'
      evidenceId: string
      summary: string
      result: unknown
      cost: IterationCost
    }
  | {
      kind: 'failed'
      code: DurableDelegationFailureCode
      cost: IterationCost
    }

function runtimeError(code: DurableDelegationRuntimeErrorCode): never {
  const error = new DurableDelegationRuntimeError(code)
  genuineRuntimeErrors.set(error, code)
  throw error
}

/**
 * Manager-side constructor for an interruption whose external effects cannot
 * safely be rewritten as a terminal task result. Structural copies are not
 * trusted as runtime control signals.
 */
export function makeDurableDelegationRecoverableInterruption(
  code: DurableDelegationRecoverableInterruptionCode,
): DurableDelegationRecoverableInterruption {
  if (code !== 'DELEGATION_OPERATION_AMBIGUOUS' &&
    code !== 'DELEGATION_MANUAL_RECOVERY_REQUIRED') {
    runtimeError('DELEGATION_RUNTIME_CONFIG_INVALID')
  }
  const interruption = Object.freeze({
    kind: 'durable-delegation-recoverable-interruption' as const,
    code,
  })
  recoverableInterruptionCodes.set(interruption, code)
  return interruption
}

export function durableDelegationRecoverableInterruptionCode(
  value: unknown,
): DurableDelegationRecoverableInterruptionCode | undefined {
  return typeof value === 'object' && value !== null
    ? recoverableInterruptionCodes.get(value)
    : undefined
}

function validRunRoot(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && value !== '/' &&
    !value.includes('\0') && !value.includes('\n') && !value.includes('\r')
}

function validPlan(plan: PlanDAG): boolean {
  if (plan.nodes.length > MAX_PLAN_TASKS || plan.edges.length > MAX_PLAN_EDGES) return false
  const ids = plan.nodes.map(task => task.taskId)
  const idSet = new Set(ids)
  if (ids.length !== idSet.size || ids.some(id => !SAFE_TASK_ID.test(id))) return false
  if (ids.some(id => idSet.has(`${id}.jsonl`))) return false

  const expectedEdges = new Set<string>()
  for (const task of plan.nodes) {
    if (task.dependsOn.length > MAX_TASK_DEPENDENCIES ||
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.some(id => id === task.taskId || !idSet.has(id))) return false
    for (const dependency of task.dependsOn) expectedEdges.add(`${dependency}\0${task.taskId}`)
  }
  const actualEdges = new Set<string>()
  for (const edge of plan.edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to) || edge.from === edge.to) return false
    actualEdges.add(`${edge.from}\0${edge.to}`)
  }
  if (actualEdges.size !== plan.edges.length || actualEdges.size !== expectedEdges.size ||
    [...actualEdges].some(edge => !expectedEdges.has(edge))) return false

  const remaining = new Map(plan.nodes.map(task => [task.taskId, task.dependsOn.length] as const))
  const dependents = new Map<string, string[]>()
  for (const task of plan.nodes) {
    for (const dependency of task.dependsOn) {
      const targets = dependents.get(dependency) ?? []
      targets.push(task.taskId)
      dependents.set(dependency, targets)
    }
  }
  const ready = ids.filter(id => remaining.get(id) === 0)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.pop()!
    visited += 1
    for (const dependent of dependents.get(id) ?? []) {
      const next = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  return visited === ids.length
}

function boundedSummary(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_SUMMARY_BYTES
}

function jsonClone(value: unknown): unknown {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new Error('invalid result')
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('invalid result')
  }
  return JSON.parse(encoded) as unknown
}

function validCost(cost: unknown): cost is IterationCost {
  if (typeof cost !== 'object' || cost === null) return false
  const value = cost as Partial<IterationCost>
  return Number.isSafeInteger(value.iterations) && (value.iterations ?? -1) >= 0 &&
    typeof value.spendUsd === 'number' && Number.isFinite(value.spendUsd) &&
    value.spendUsd >= 0 &&
    Number.isSafeInteger(value.wallMs) && (value.wallMs ?? -1) >= 0 &&
    (value.wallMs ?? Infinity) <= MAX_WALL_MS
}

function withinTaskBudget(cost: IterationCost, task: DelegationTask, card?: AgentCard): boolean {
  const costNanos = iterationCostSpendNanos(cost.spendUsd)
  const sliceNanos = iterationCostSpendNanos(task.budgetSlice.spendUsd)
  return cost.iterations <= task.budgetSlice.iterations &&
    cost.iterations <= task.retryPolicy.maxIterations &&
    (card === undefined || cost.iterations <= card.maxIterations) &&
    costNanos !== undefined && sliceNanos !== undefined && costNanos <= sliceNanos
}

function copyCost(cost: IterationCost): IterationCost {
  return { iterations: cost.iterations, spendUsd: cost.spendUsd, wallMs: cost.wallMs }
}

function cumulativeCostAtLeast(current: IterationCost, prior: IterationCost): boolean {
  const currentNanos = iterationCostSpendNanos(current.spendUsd)
  const priorNanos = iterationCostSpendNanos(prior.spendUsd)
  return currentNanos !== undefined && priorNanos !== undefined &&
    current.iterations >= prior.iterations && currentNanos >= priorNanos &&
    current.wallMs >= prior.wallMs
}

function canonicalCostAggregate(costs: readonly IterationCost[]): CanonicalCost | undefined {
  let iterations = 0
  let spendUsdNanos = 0
  let wallMs = 0
  for (const cost of costs) {
    const canonical = canonicalizeIterationCost(cost)
    if (canonical === undefined ||
      iterations > Number.MAX_SAFE_INTEGER - canonical.iterations ||
      wallMs > Number.MAX_SAFE_INTEGER - canonical.wallMs) return undefined
    const nanos = iterationCostSpendNanos(canonical.spendUsd)
    if (nanos === undefined || spendUsdNanos > Number.MAX_SAFE_INTEGER - nanos) return undefined
    iterations += canonical.iterations
    spendUsdNanos += nanos
    wallMs += canonical.wallMs
  }
  return { iterations, spendUsdNanos, wallMs }
}

function parseTerminalDraft(
  entries: ShardEntry[],
  task: DelegationTask,
  card?: AgentCard,
): TerminalDraft | undefined {
  const entry = entries.at(-1)
  if (entry === undefined || !entry.kind.startsWith(RESERVED_KIND_PREFIX) ||
    typeof entry.payload !== 'object' || entry.payload === null) return undefined
  const payload = entry.payload as Record<string, unknown>
  if (entry.kind === 'runtime.verified-result' &&
    typeof payload['evidenceId'] === 'string' && EVIDENCE_ID.test(payload['evidenceId']) &&
    boundedSummary(payload['summary']) && validCost(payload['cost']) &&
    withinTaskBudget(payload['cost'], task, card)) {
    const cost = canonicalizeIterationCost(payload['cost'])
    if (cost === undefined) return undefined
    try {
      return {
        kind: 'verified',
        evidenceId: payload['evidenceId'],
        summary: payload['summary'],
        result: jsonClone(payload['result']),
        cost: copyCost(cost),
      }
    } catch {
      return undefined
    }
  }
  if ((entry.kind === 'runtime.denied' || entry.kind === 'runtime.cancelled') &&
    typeof payload['code'] === 'string' && validFailureCode(payload['code']) &&
    validCost(payload['cost'])) {
    const cost = canonicalizeIterationCost(payload['cost'])
    return cost === undefined
      ? undefined
      : { kind: 'failed', code: payload['code'], cost: copyCost(cost) }
  }
  return undefined
}

function terminalSnapshotMatchesRuntimeDraft(
  value: unknown,
  task: DelegationTask,
  card: AgentCard | undefined,
): boolean {
  if (typeof value !== 'object' || value === null) return false
  const state = value as { status?: unknown; entries?: unknown; terminalObservation?: unknown }
  if (state.status !== 'completed' && state.status !== 'failed') return true
  if (!Array.isArray(state.entries) || typeof state.terminalObservation !== 'object' ||
    state.terminalObservation === null) return false
  const draft = parseTerminalDraft(state.entries as ShardEntry[], task, card)
  const observation = state.terminalObservation as Record<string, unknown>
  try {
    if (state.status === 'completed' && draft?.kind === 'verified') {
      if (!boundedSummary(observation['summary']) || observation['summary'] !== draft.summary ||
        !validCost(observation['cost']) || !withinTaskBudget(observation['cost'], task, card)) return false
      const observationCost = canonicalizeIterationCost(observation['cost'])
      if (observationCost === undefined) return false
      const result = jsonClone(observation['result'])
      return observation['status'] === 'completed' &&
        JSON.stringify(result) === JSON.stringify(draft.result) &&
        observationCost.iterations === draft.cost.iterations &&
        observationCost.spendUsd === draft.cost.spendUsd &&
        observationCost.wallMs === draft.cost.wallMs
    }
    if (state.status === 'failed' && draft?.kind === 'failed') {
      if (!boundedSummary(observation['summary']) || !validCost(observation['cost'])) return false
      const observationCost = canonicalizeIterationCost(observation['cost'])
      if (observationCost === undefined) return false
      return observation['status'] === 'failed' && observation['summary'] === draft.code &&
        observation['result'] === undefined &&
        observationCost.iterations === draft.cost.iterations &&
        observationCost.spendUsd === draft.cost.spendUsd &&
        observationCost.wallMs === draft.cost.wallMs
    }
  } catch {
    return false
  }
  return false
}

function validFailureCode(value: string): value is DurableDelegationFailureCode {
  return value === 'CANCELLED' || value === 'TASK_EXECUTION_FAILED' ||
    value === 'TASK_RESULT_INVALID' || value === 'TASK_BUDGET_EXCEEDED' ||
    value === 'VERIFICATION_FAILED' ||
    value === 'UNVERIFIED_RESULT'
}

function linkedSignal(
  internal: AbortSignal,
  external?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  internal.addEventListener('abort', abort, { once: true })
  external?.addEventListener('abort', abort, { once: true })
  if (internal.aborted || external?.aborted === true) controller.abort()
  return {
    signal: controller.signal,
    dispose() {
      internal.removeEventListener('abort', abort)
      external?.removeEventListener('abort', abort)
    },
  }
}

class CancellationUnconfirmedError extends Error {}

async function awaitOperation<T>(
  operation: DurableDelegationOperation<T>,
  signal: AbortSignal,
): Promise<T> {
  let cancellation: Promise<void> | undefined
  const requestCancellation = (): Promise<void> => {
    cancellation ??= Promise.resolve().then(() => operation.cancel())
    return cancellation
  }
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void requestCancellation().then(
        () => reject(new Error('cancelled')),
        () => reject(new CancellationUnconfirmedError()),
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    if (signal.aborted) {
      try { await requestCancellation() } catch { throw new CancellationUnconfirmedError() }
      throw new Error('cancelled')
    }
    const result = await Promise.race([operation.result, cancelled])
    if (signal.aborted) {
      try { await requestCancellation() } catch { throw new CancellationUnconfirmedError() }
      throw new Error('cancelled')
    }
    return result
  } catch (error) {
    if (signal.aborted) {
      try { await requestCancellation() } catch { throw new CancellationUnconfirmedError() }
      throw new Error('cancelled')
    }
    throw error
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function safeEvent(
  emit: ((event: DurableDelegationRuntimeEvent) => void) | undefined,
  event: DurableDelegationRuntimeEvent,
): void {
  try { emit?.(event) } catch { /* observability is non-load-bearing */ }
}

function inspectDurableDelegationRecoveryState(input: {
  readonly config: DurableDelegationRecoveryInspectionInput
  readonly persistence: DelegationPersistencePort
  readonly manager: DelegationManager
}): DurableDelegationRecoveryState {
  let runSnapshot: unknown
  try { runSnapshot = input.persistence.loadRun() } catch {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  if (runSnapshot !== undefined &&
    (typeof runSnapshot !== 'object' || runSnapshot === null || Array.isArray(runSnapshot))) {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  const runState = runSnapshot as {
    activeTaskIds?: unknown
    completedTaskIds?: unknown
    failedTaskIds?: unknown
    skippedTaskIds?: unknown
  } | undefined
  const stateLists = runState === undefined ? undefined : [
    runState.activeTaskIds,
    runState.completedTaskIds,
    runState.failedTaskIds,
    runState.skippedTaskIds,
  ]
  if (stateLists !== undefined && stateLists.some(list => !Array.isArray(list))) {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  const listedTaskIds = (stateLists ?? []).flatMap(list => list as unknown[])
  const knownTaskIds = new Set(input.config.plan.nodes.map(task => task.taskId))
  if (listedTaskIds.some(id => typeof id !== 'string')) {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  const exactTaskIds = listedTaskIds as string[]
  if (new Set(exactTaskIds).size !== exactTaskIds.length ||
    exactTaskIds.some(id => !knownTaskIds.has(id))) {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  const activeTaskIds = (runState?.activeTaskIds ?? []) as string[]
  const terminalTaskIds = new Set([
    ...((runState?.completedTaskIds ?? []) as string[]),
    ...((runState?.failedTaskIds ?? []) as string[]),
  ])
  const durableTaskIds = new Set([...activeTaskIds, ...terminalTaskIds])
  let foundStored = false
  const storedByTaskId = new Map<string, unknown>()

  // App-owned draft validation complements Core's full snapshot validation.
  for (const task of input.config.plan.nodes) {
    const delegationId = `d-${task.taskId}`
    let stored: unknown
    try { stored = input.persistence.load(delegationId) } catch {
      runtimeError('DELEGATION_RECOVERY_DENIED')
    }
    if (stored === undefined) {
      if (durableTaskIds.has(task.taskId)) runtimeError('DELEGATION_RECOVERY_DENIED')
      continue
    }
    foundStored = true
    if (!durableTaskIds.has(task.taskId)) runtimeError('DELEGATION_RECOVERY_DENIED')
    const card = task.assignedTo === null
      ? undefined
      : input.config.resolveCard(task.assignedTo)
    if (!terminalSnapshotMatchesRuntimeDraft(stored, task, card)) {
      runtimeError('DELEGATION_RECOVERY_DENIED')
    }
    storedByTaskId.set(task.taskId, stored)
  }
  if (runSnapshot !== undefined && !foundStored) runtimeError('DELEGATION_RECOVERY_DENIED')

  let preflight: DelegationRecoveryPreflight
  try { preflight = input.manager.preflightRecovery() } catch {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  if (runSnapshot === undefined) {
    if (preflight.status !== 'none') runtimeError('DELEGATION_RECOVERY_DENIED')
  } else {
    if (preflight.status === 'none' ||
      preflight.status !== (activeTaskIds.length === 0 ? 'terminal' : 'continuation') ||
      JSON.stringify(preflight.activeDelegationIds) !==
        JSON.stringify(activeTaskIds.map(taskId => `d-${taskId}`))) {
      runtimeError('DELEGATION_RECOVERY_DENIED')
    }
    const expectedTerminalIds = new Set([...terminalTaskIds].map(taskId => `d-${taskId}`))
    const observedTerminalIds = preflight.terminalObservations.map(
      observation => observation.delegationId,
    )
    if (new Set(observedTerminalIds).size !== observedTerminalIds.length ||
      observedTerminalIds.length !== expectedTerminalIds.size ||
      observedTerminalIds.some(id => !expectedTerminalIds.has(id))) {
      runtimeError('DELEGATION_RECOVERY_DENIED')
    }
  }
  return Object.freeze({
    preflight,
    runSnapshot,
    activeTaskIds: Object.freeze([...activeTaskIds]),
    terminalTaskIds,
    storedByTaskId,
  })
}

/**
 * Read-only inspection for one exact, already-registered durable run. The
 * transient run lock prevents concurrent runtime recovery; no handle or child
 * port is created.
 */
export function inspectNodeDurableDelegationRecovery(
  input: DurableDelegationRecoveryInspectionInput,
): DelegationRecoveryPreflight {
  if (!validRunRoot(input.runRoot) || !validPlan(input.plan)) {
    runtimeError('DELEGATION_RUNTIME_CONFIG_INVALID')
  }
  let persistence: DelegationPersistencePort
  try {
    persistence = makeNodeDelegationPersistence({
      runRoot: input.runRoot,
      createIfMissing: false,
    })
  } catch {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  let runLock: ReturnType<typeof makeNodeDelegationRunLock>
  try { runLock = makeNodeDelegationRunLock(input.runRoot) } catch {
    runtimeError('DELEGATION_RECOVERY_DENIED')
  }
  let releaseLock: (() => void) | undefined
  try { releaseLock = runLock.acquire() } catch {
    runtimeError('DELEGATION_RUN_LOCK_HELD')
  }
  try {
    let manager: DelegationManager
    try {
      manager = makeDelegationManager(input.plan, {
        binding: input.binding,
        resolveCard: input.resolveCard,
        skillTouchedPaths: input.skillTouchedPaths,
        mcpWritable: input.mcpWritable,
        isBindingActive: input.isBindingActive,
        persistence,
        emit: () => { /* preflight emits nothing */ },
      })
    } catch {
      runtimeError('DELEGATION_RUNTIME_CONFIG_INVALID')
    }
    return inspectDurableDelegationRecoveryState({
      config: input,
      persistence,
      manager,
    }).preflight
  } finally {
    try { releaseLock() } catch { runtimeError('DELEGATION_PERSISTENCE_FAILED') }
  }
}

/**
 * Disabled-by-default production-preview composition. The caller must opt into
 * recovery explicitly; construction creates only the protected run directory.
 */
export function makeNodeDurableDelegationRuntime(input: {
  runRoot: string
  recoveryPolicy: 'resume-active-replay-terminal'
  /** Required code-owned ceiling; no model/provider default is accepted. */
  maxConcurrency: number
  binding: ResolvedWorkBinding
  plan: PlanDAG
  resolveCard(name: string): AgentCard | undefined
  skillTouchedPaths(skill: string): string[]
  mcpWritable(server: string): boolean
  isBindingActive(binding: ResolvedWorkBinding): boolean
  runTask(
    handle: DurableDelegationExecutionHandle,
    task: DelegationTask,
    signal: AbortSignal,
  ): DurableDelegationOperation<DurableDelegationCandidate>
  verify(input: {
    binding: ResolvedWorkBinding
    task: DelegationTask
    candidate: DurableDelegationCandidate
    shard: ShardEntry[]
    signal: AbortSignal
  }): DurableDelegationOperation<DurableDelegationVerification>
  /** Code-owned cumulative meter for child + verifier work, never model output. */
  readCost(input: {
    delegationId: string
    task: DelegationTask
    phase: 'child' | 'verifier' | 'terminal'
  }): Promise<IterationCost>
  emit?: (event: DurableDelegationRuntimeEvent) => void
  emitOrchestration?: (event: OrchestrationEvent) => void
  nowIso?: () => string
}): DurableDelegationRuntime {
  if (!validRunRoot(input.runRoot) || input.recoveryPolicy !== 'resume-active-replay-terminal' ||
    !Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 ||
    input.maxConcurrency > 64 || !validPlan(input.plan)) {
    runtimeError('DELEGATION_RUNTIME_CONFIG_INVALID')
  }
  const persistence = makeNodeDelegationPersistence({
    runRoot: input.runRoot,
    ...(input.nowIso === undefined ? {} : { nowIso: input.nowIso }),
  })
  const runLock = makeNodeDelegationRunLock(input.runRoot)
  const manager = makeDelegationManager(input.plan, {
    binding: input.binding,
    resolveCard: input.resolveCard,
    skillTouchedPaths: input.skillTouchedPaths,
    mcpWritable: input.mcpWritable,
    isBindingActive: input.isBindingActive,
    persistence,
    emit: event => {
      try { input.emitOrchestration?.(event) } catch { /* non-load-bearing */ }
    },
  })
  const internal = new AbortController()
  let used = false

  const measuredCost = async (
    handle: DelegationHandle,
    task: DelegationTask,
    phase: 'child' | 'verifier' | 'terminal',
  ): Promise<IterationCost> => {
    let cost: IterationCost
    try {
      cost = await input.readCost({ delegationId: handle.delegationId, task, phase })
    } catch {
      runtimeError('DELEGATION_BUDGET_METER_FAILED')
    }
    if (!validCost(cost)) runtimeError('DELEGATION_BUDGET_METER_FAILED')
    const canonical = canonicalizeIterationCost(cost)
    if (canonical === undefined) runtimeError('DELEGATION_BUDGET_METER_FAILED')
    return copyCost(canonical)
  }

  const finishFailure = (
    handle: DelegationHandle,
    task: DelegationTask,
    code: DurableDelegationFailureCode,
    cost: IterationCost,
    reasonCode?: string,
  ): TaskObservation => {
    const cancelled = code === 'CANCELLED'
    handle.append(cancelled ? 'runtime.cancelled' : 'runtime.denied', {
      code,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      cost: copyCost(cost),
    })
    safeEvent(input.emit, {
      kind: cancelled ? 'delegation.runtime.cancelled' : 'delegation.runtime.denied',
      delegationId: handle.delegationId,
      taskId: task.taskId,
      code,
    })
    return handle.fail(code, cost)
  }

  const runHandle = async (
    handle: DelegationHandle,
    task: DelegationTask,
    signal: AbortSignal,
  ): Promise<TaskObservation> => {
    const prior = parseTerminalDraft(handle.shard(), task, handle.card)
    if (prior?.kind === 'verified') {
      safeEvent(input.emit, {
        kind: 'delegation.runtime.verified',
        delegationId: handle.delegationId,
        taskId: task.taskId,
      })
      return handle.complete(prior.summary, prior.result, prior.cost)
    }
    if (prior?.kind === 'failed') return handle.fail(prior.code, prior.cost)

    if (signal.aborted) {
      return finishFailure(handle, task, 'CANCELLED', await measuredCost(handle, task, 'child'))
    }

    let childActive = true
    const assertManagerAuthorityActive = (): void => {
      if (!childActive || signal.aborted) throw new Error('child authority revoked')
    }
    const authorityJournal = Object.freeze<DelegationAuthorityJournal>({
      appendAuthoritySeal: authorityHash => {
        assertManagerAuthorityActive()
        if (!SHA256_HEX.test(authorityHash)) throw new Error('invalid authority hash')
        return handle.append(AUTHORITY_SEAL_KIND, { schemaVersion: 1, authorityHash })
      },
      shard: () => handle.shard(),
      verifyShardChain: () => manager.verifyShardChain(handle.delegationId),
    })
    const executionHandle: DurableDelegationExecutionHandle = Object.freeze({
      delegationId: handle.delegationId,
      taskId: handle.taskId,
      binding: handle.binding,
      card: handle.card,
      owns: Object.freeze([...handle.owns]) as unknown as string[],
      writableMcp: Object.freeze([...handle.writableMcp]) as unknown as string[],
      permitsTool: name => childActive && !signal.aborted && handle.permitsTool(name),
      permitsMcp: server => childActive && !signal.aborted && handle.permitsMcp(server),
      append: (kind, payload) => {
        if (!childActive || signal.aborted) throw new Error('child authority revoked')
        if (kind.startsWith(RESERVED_KIND_PREFIX)) throw new Error('reserved shard kind')
        return handle.append(kind, payload)
      },
      shard: handle.shard,
      get guardian() {
        if (!childActive || signal.aborted) throw new Error('child authority revoked')
        return handle.guardian
      },
      authorityJournal,
    })

    let candidate: DurableDelegationCandidate
    try {
      candidate = await awaitOperation(input.runTask(executionHandle, task, signal), signal)
    } catch (error) {
      const interruptionCode = durableDelegationRecoverableInterruptionCode(error)
      if (interruptionCode !== undefined) runtimeError(interruptionCode)
      if (error instanceof CancellationUnconfirmedError) {
        runtimeError('DELEGATION_CANCELLATION_UNCONFIRMED')
      }
      const code: DurableDelegationFailureCode = signal.aborted
        ? 'CANCELLED'
        : 'TASK_EXECUTION_FAILED'
      return finishFailure(handle, task, code, await measuredCost(handle, task, 'child'))
    } finally {
      childActive = false
    }
    const childCost = await measuredCost(handle, task, 'child')
    if (!withinTaskBudget(childCost, task)) {
      return finishFailure(handle, task, 'TASK_BUDGET_EXCEEDED', childCost)
    }
    if (typeof candidate !== 'object' || candidate === null || !boundedSummary(candidate.summary)) {
      return finishFailure(handle, task, 'TASK_RESULT_INVALID', childCost)
    }
    try { jsonClone(candidate.result) } catch {
      return finishFailure(handle, task, 'TASK_RESULT_INVALID', childCost)
    }

    let verification: DurableDelegationVerification
    try {
      verification = await awaitOperation(input.verify({
        binding: handle.binding,
        task,
        candidate: {
          summary: candidate.summary,
          result: jsonClone(candidate.result),
        },
        shard: handle.shard(),
        signal,
      }), signal)
    } catch (error) {
      if (error instanceof CancellationUnconfirmedError) {
        runtimeError('DELEGATION_CANCELLATION_UNCONFIRMED')
      }
      const code: DurableDelegationFailureCode = signal.aborted ? 'CANCELLED' : 'VERIFICATION_FAILED'
      const verifierCost = await measuredCost(handle, task, 'verifier')
      if (!cumulativeCostAtLeast(verifierCost, childCost)) {
        runtimeError('DELEGATION_BUDGET_METER_FAILED')
      }
      return finishFailure(handle, task, code, verifierCost)
    }
    const finalCost = await measuredCost(handle, task, 'terminal')
    if (!cumulativeCostAtLeast(finalCost, childCost)) {
      runtimeError('DELEGATION_BUDGET_METER_FAILED')
    }
    if (!withinTaskBudget(finalCost, task)) {
      return finishFailure(handle, task, 'TASK_BUDGET_EXCEEDED', finalCost)
    }
    if (typeof verification !== 'object' || verification === null ||
      (verification.verified !== true && verification.verified !== false)) {
      return finishFailure(handle, task, 'VERIFICATION_FAILED', finalCost)
    }
    if (verification.verified === false) {
      const reason = verification.reasonCode
      if (reason !== 'EVIDENCE_MISSING' && reason !== 'POSTCONDITION_FAILED' &&
        reason !== 'SCOPE_NOT_PROVEN') {
        return finishFailure(handle, task, 'VERIFICATION_FAILED', finalCost)
      }
      return finishFailure(handle, task, 'UNVERIFIED_RESULT', finalCost, reason)
    }
    let verifiedResult: unknown
    if (!EVIDENCE_ID.test(verification.evidenceId) || !boundedSummary(verification.summary)) {
      return finishFailure(handle, task, 'VERIFICATION_FAILED', finalCost)
    }
    try { verifiedResult = jsonClone(verification.result) } catch {
      return finishFailure(handle, task, 'VERIFICATION_FAILED', finalCost)
    }
    handle.append('runtime.verified-result', {
      evidenceId: verification.evidenceId,
      summary: verification.summary,
      result: verifiedResult,
      cost: copyCost(finalCost),
    })
    safeEvent(input.emit, {
      kind: 'delegation.runtime.verified',
      delegationId: handle.delegationId,
      taskId: task.taskId,
    })
    return handle.complete(verification.summary, verifiedResult, finalCost)
  }

  return Object.freeze<DurableDelegationRuntime>({
    async execute(externalSignal) {
      if (used) runtimeError('DELEGATION_RUNTIME_ALREADY_USED')
      used = true
      let releaseLock: (() => void) | undefined
      try {
        releaseLock = runLock.acquire()
      } catch {
        runtimeError('DELEGATION_RUN_LOCK_HELD')
      }
      const linked = linkedSignal(internal.signal, externalSignal)
      const observations: TaskObservation[] = []
      let retainUnsafeLock = false
      safeEvent(input.emit, { kind: 'delegation.runtime.started' })
      try {
        const recovery = inspectDurableDelegationRecoveryState({
          config: input,
          persistence,
          manager,
        })
        const {
          preflight: recoveryPreflight,
          runSnapshot,
          activeTaskIds,
          terminalTaskIds,
          storedByTaskId,
        } = recovery

        const resumed: Array<{ handle: DelegationHandle; task: DelegationTask }> = []
        const replayed: Array<{ observation: TaskObservation; task: DelegationTask }> = []
        if (runSnapshot !== undefined) {
          const taskById = new Map(input.plan.nodes.map(task => [task.taskId, task] as const))
          const preflightTerminalById = new Map(
            recoveryPreflight.status === 'none'
              ? []
              : recoveryPreflight.terminalObservations.map(observation =>
                [observation.delegationId, observation] as const),
          )
          try {
            // Recover every terminal first. Cold terminal recovery validates
            // the complete active sibling set without issuing active handles,
            // so a later terminal failure cannot leave authority exposed.
            for (const task of input.plan.nodes) {
              if (!terminalTaskIds.has(task.taskId)) continue
              const recovered = manager.recover(`d-${task.taskId}`)
              if (recovered.status !== 'terminal' ||
                JSON.stringify(recovered.observation) !==
                  JSON.stringify(preflightTerminalById.get(`d-${task.taskId}`))) {
                runtimeError('DELEGATION_RECOVERY_DENIED')
              }
              replayed.push({ observation: recovered.observation, task })
            }
            const handles = manager.recoverActive(activeTaskIds.map(taskId => `d-${taskId}`))
            if (handles.length !== activeTaskIds.length) runtimeError('DELEGATION_RECOVERY_DENIED')
            for (let index = 0; index < handles.length; index++) {
              const handle = handles[index]!
              const taskId = activeTaskIds[index]!
              const task = taskById.get(taskId)
              if (task === undefined || handle.taskId !== taskId ||
                !storedByTaskId.has(taskId)) runtimeError('DELEGATION_RECOVERY_DENIED')
              resumed.push({ handle, task })
            }
          } catch (error) {
            if (error instanceof DurableDelegationRuntimeError) throw error
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
          observations.push(...replayed.map(item => item.observation))
          for (const item of replayed) {
            safeEvent(input.emit, {
              kind: 'delegation.runtime.replayed',
              delegationId: item.observation.delegationId,
              taskId: item.task.taskId,
            })
          }
          for (const item of resumed) {
            safeEvent(input.emit, {
              kind: 'delegation.runtime.resumed',
              delegationId: item.handle.delegationId,
              taskId: item.task.taskId,
            })
          }
        }
        const verifyRecoveredAggregate = (): void => {
          const terminalCost = canonicalCostAggregate(observations.map(observation => observation.cost))
          const managerCost = canonicalCostAggregate([manager.runBudgetSpent()])
          let currentRun: unknown
          try { currentRun = persistence.loadRun() } catch {
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
          if (typeof currentRun !== 'object' || currentRun === null || Array.isArray(currentRun)) {
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
          const persistedCost = (currentRun as { runBudget?: unknown }).runBudget
          if (typeof persistedCost !== 'object' || persistedCost === null ||
            Array.isArray(persistedCost)) {
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
          const ledger = persistedCost as Partial<IterationCost>
          if (typeof ledger.iterations !== 'number' || typeof ledger.spendUsd !== 'number' ||
            typeof ledger.wallMs !== 'number') {
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
          const ledgerCost = canonicalCostAggregate([ledger as IterationCost])
          if (terminalCost === undefined || managerCost === undefined || ledgerCost === undefined ||
            managerCost.iterations !== ledgerCost.iterations ||
            managerCost.spendUsdNanos !== ledgerCost.spendUsdNanos ||
            managerCost.wallMs !== ledgerCost.wallMs ||
            terminalCost.iterations !== ledgerCost.iterations ||
            terminalCost.spendUsdNanos !== ledgerCost.spendUsdNanos ||
            terminalCost.wallMs !== ledgerCost.wallMs) {
            runtimeError('DELEGATION_RECOVERY_DENIED')
          }
        }
        if (runSnapshot !== undefined) verifyRecoveredAggregate()
        for (const recovered of resumed) {
          observations.push(await runHandle(recovered.handle, recovered.task, linked.signal))
          verifyRecoveredAggregate()
        }
        const driverAbort = new AbortController()
        const abortDriver = (): void => driverAbort.abort()
        linked.signal.addEventListener('abort', abortDriver, { once: true })
        if (linked.signal.aborted) driverAbort.abort()
        let driverError: DurableDelegationRuntimeError | undefined
        let bounded: BoundedDelegationOutcome
        try {
          bounded = await runBoundedDelegation({
            manager,
            maxConcurrency: input.maxConcurrency,
            signal: driverAbort.signal,
            runTask: async (handle, task, signal) => {
              try {
                return await runHandle(handle, task, signal)
              } catch (error) {
                if (error instanceof DurableDelegationRuntimeError) {
                  driverError ??= error
                  // The bounded driver preserves active state on abort. This
                  // keeps persistence/meter uncertainty recoverable instead of
                  // rewriting it as a synthetic terminal task failure.
                  driverAbort.abort()
                }
                throw error
              }
            },
          })
        } finally {
          linked.signal.removeEventListener('abort', abortDriver)
        }
        if (driverError !== undefined) throw driverError
        if (bounded.status === 'interrupted') {
          const exactTerminalOnly = bounded.pendingTaskIds.length === 0 &&
            bounded.observations.every(observation => {
              const terminal = manager.terminalObservation(observation.delegationId)
              return terminal !== undefined &&
                JSON.stringify(observation) === JSON.stringify(terminal)
            })
          if (!exactTerminalOnly) {
            // Pending/active manager state is durable and recoverable, but this
            // call must never turn a partial schedule into a successful result.
            runtimeError('DELEGATION_PERSISTENCE_FAILED')
          }
        }
        if (bounded.status === 'failed') {
          const exactTerminal = bounded.observations.find(observation =>
            observation.delegationId === `d-${bounded.taskId}` &&
            observation.status === 'failed')
          const managerTerminal = manager.terminalObservation(`d-${bounded.taskId}`)
          if (exactTerminal === undefined || managerTerminal?.status !== 'failed' ||
            JSON.stringify(exactTerminal) !== JSON.stringify(managerTerminal)) {
            runtimeError('DELEGATION_PERSISTENCE_FAILED')
          }
        }
        observations.splice(0, observations.length, ...bounded.observations)
        if (bounded.status === 'completed') {
          safeEvent(input.emit, { kind: 'delegation.runtime.completed' })
        }
        return observations
      } catch (error) {
        if (error instanceof DurableDelegationRuntimeError) {
          if (error.code === 'DELEGATION_CANCELLATION_UNCONFIRMED') retainUnsafeLock = true
          throw error
        }
        runtimeError('DELEGATION_PERSISTENCE_FAILED')
      } finally {
        linked.dispose()
        if (!retainUnsafeLock) {
          try { releaseLock() } catch { runtimeError('DELEGATION_PERSISTENCE_FAILED') }
        }
      }
    },
    cancel() { internal.abort() },
  })
}

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { PlanDAG, ResolvedWorkBinding } from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/
const RUN_ID = /^inv-[a-f0-9]{64}$/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ID_BYTES = 1024
const MAX_RECORDS = 64
const MAX_STATE_BYTES = 4 * 1024 * 1024
const MAX_PLAN_BYTES = 1024 * 1024
const MAX_PLAN_TASKS = 128
const MAX_PLAN_EDGES = 4096

export type DurableDelegationRunRegistryErrorCode =
  | 'DELEGATION_RUN_REGISTRY_CONFIG_INVALID'
  | 'DELEGATION_RUN_REGISTRY_STATE_INVALID'
  | 'DELEGATION_RUN_REGISTRY_FULL'
  | 'DELEGATION_RUN_REGISTRY_CONFLICT'
  | 'DELEGATION_RUN_REGISTRY_WRITE_FAILED'

export class DurableDelegationRunRegistryError extends Error {
  constructor(readonly code: DurableDelegationRunRegistryErrorCode) {
    super(code)
    this.name = 'DurableDelegationRunRegistryError'
  }
}

export type DurableDelegationRunRegistryPhaseV1 = 'registered' | 'active'

export interface DurableDelegationRunRegistryRecordV1 {
  readonly runId: string
  readonly bindingHash: string
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly plan: PlanDAG
  readonly phase: DurableDelegationRunRegistryPhaseV1
}

export interface DurableDelegationRunRegistrationV1 {
  readonly runRoot: string
  /** Publishes permission for runtime execution immediately before execute(). */
  activate(): void
  /** Removes only the exact terminal inventory entry; private run evidence remains on disk. */
  retire(): void
}

export interface DurableDelegationRunRegistryV1 {
  register(input: DurableDelegationRunRegistrationInputV1): DurableDelegationRunRegistrationV1
  listExact(bindingHash: string): readonly Readonly<DurableDelegationRunRegistryRecordV1>[]
  runRoot(record: Readonly<DurableDelegationRunRegistryRecordV1>): string
}

export type DurableDelegationRunRegistrationInputV1 = Readonly<{
  runRoot: string
  bindingHash: string
  binding: ResolvedWorkBinding
  plan: PlanDAG
}>

interface RegistryPayloadV1 {
  readonly schemaVersion: 1
  readonly generation: number
  readonly records: readonly DurableDelegationRunRegistryRecordV1[]
}

interface RegistryStateV1 extends RegistryPayloadV1 {
  readonly payloadSha256: string
}

function fail(code: DurableDelegationRunRegistryErrorCode): never {
  throw new DurableDelegationRunRegistryError(code)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
}

function bindingSnapshot(value: unknown): Readonly<ResolvedWorkBinding> {
  const raw = plainRecord(value)
  if (raw === null || !exactKeys(raw, [
    ...(raw['botId'] === undefined ? [] : ['botId']),
    'operatorId', 'profileId', 'projectId', 'sessionId', 'scope',
  ]) || !boundedId(raw['operatorId']) || !boundedId(raw['profileId']) ||
    !boundedId(raw['projectId']) || !boundedId(raw['sessionId']) ||
    (raw['botId'] !== undefined && !boundedId(raw['botId'])) ||
    (raw['scope'] !== 'workspace' && raw['scope'] !== 'project' && raw['scope'] !== 'session')) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  return Object.freeze({
    ...(raw['botId'] === undefined ? {} : { botId: raw['botId'] }),
    operatorId: raw['operatorId'],
    profileId: raw['profileId'],
    projectId: raw['projectId'],
    sessionId: raw['sessionId'],
    scope: raw['scope'],
  }) as Readonly<ResolvedWorkBinding>
}

function planSnapshot(value: unknown): PlanDAG {
  const raw = plainRecord(value)
  if (raw === null || !exactKeys(raw, ['edges', 'nodes']) ||
    !Array.isArray(raw['nodes']) || !Array.isArray(raw['edges']) ||
    raw['nodes'].length === 0 || raw['nodes'].length > MAX_PLAN_TASKS ||
    raw['edges'].length > MAX_PLAN_EDGES) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  let encoded: string
  try { encoded = JSON.stringify(raw) } catch {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PLAN_BYTES) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  const cloned = JSON.parse(encoded) as { nodes: unknown[]; edges: unknown[] }
  const nodes = cloned.nodes.map(rawTask => {
    const task = plainRecord(rawTask)
    if (task === null || !exactKeys(task, [
      'assignedTo', 'budgetSlice', 'dependsOn', 'intent', 'outputContract',
      'retryPolicy', 'scope', 'taskId',
    ]) || typeof task['taskId'] !== 'string' || !TASK_ID.test(task['taskId']) ||
      typeof task['intent'] !== 'string' || typeof task['outputContract'] !== 'string' ||
      (task['assignedTo'] !== null && !boundedId(task['assignedTo'])) ||
      !Array.isArray(task['dependsOn']) ||
      task['dependsOn'].some(dependency => typeof dependency !== 'string')) {
      fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
    const scope = plainRecord(task['scope'])
    const budget = plainRecord(task['budgetSlice'])
    const retry = plainRecord(task['retryPolicy'])
    if (scope === null || !exactKeys(scope, ['doNotTouch', 'owns', 'taskClass']) ||
      !Array.isArray(scope['owns']) || !Array.isArray(scope['doNotTouch']) ||
      scope['owns'].some(path => typeof path !== 'string') ||
      scope['doNotTouch'].some(path => typeof path !== 'string') ||
      (scope['taskClass'] !== 'reasoning' && scope['taskClass'] !== 'critique' &&
        scope['taskClass'] !== 'routine') ||
      budget === null || !exactKeys(budget, ['iterations', 'spendUsd']) ||
      !Number.isSafeInteger(budget['iterations']) || (budget['iterations'] as number) < 0 ||
      typeof budget['spendUsd'] !== 'number' || !Number.isFinite(budget['spendUsd']) ||
      budget['spendUsd'] < 0 ||
      retry === null || !exactKeys(retry, ['maxIterations', 'maxReplans']) ||
      !Number.isSafeInteger(retry['maxIterations']) || (retry['maxIterations'] as number) < 0 ||
      !Number.isSafeInteger(retry['maxReplans']) || (retry['maxReplans'] as number) < 0) {
      fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
    return Object.freeze({
      taskId: task['taskId'],
      intent: task['intent'],
      assignedTo: task['assignedTo'],
      dependsOn: Object.freeze([...task['dependsOn']]),
      scope: Object.freeze({
        owns: Object.freeze([...scope['owns']]),
        doNotTouch: Object.freeze([...scope['doNotTouch']]),
        taskClass: scope['taskClass'],
      }),
      budgetSlice: Object.freeze({
        iterations: budget['iterations'],
        spendUsd: budget['spendUsd'],
      }),
      outputContract: task['outputContract'],
      retryPolicy: Object.freeze({
        maxReplans: retry['maxReplans'],
        maxIterations: retry['maxIterations'],
      }),
    })
  })
  const edges = cloned.edges.map(rawEdge => {
    const edge = plainRecord(rawEdge)
    if (edge === null || !exactKeys(edge, ['from', 'to']) ||
      typeof edge['from'] !== 'string' || typeof edge['to'] !== 'string') {
      fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
    return Object.freeze({ from: edge['from'], to: edge['to'] })
  })
  const taskIds = nodes.map(task => task.taskId)
  const taskIdSet = new Set(taskIds)
  if (taskIdSet.size !== taskIds.length) fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  const expectedEdges = new Set<string>()
  for (const task of nodes) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.some(dependency => dependency === task.taskId || !taskIdSet.has(dependency))) {
      fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
    for (const dependency of task.dependsOn) expectedEdges.add(`${dependency}\0${task.taskId}`)
  }
  const actualEdges = new Set(edges.map(edge => `${edge.from}\0${edge.to}`))
  if (actualEdges.size !== edges.length || actualEdges.size !== expectedEdges.size ||
    [...actualEdges].some(edge => !expectedEdges.has(edge))) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  const remaining = new Map(nodes.map(task => [task.taskId, task.dependsOn.length] as const))
  const dependents = new Map<string, string[]>()
  for (const task of nodes) {
    for (const dependency of task.dependsOn) {
      const targets = dependents.get(dependency) ?? []
      targets.push(task.taskId)
      dependents.set(dependency, targets)
    }
  }
  const ready = taskIds.filter(taskId => remaining.get(taskId) === 0)
  let visited = 0
  while (ready.length > 0) {
    const taskId = ready.pop()!
    visited += 1
    for (const dependent of dependents.get(taskId) ?? []) {
      const next = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (visited !== taskIds.length) fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  }) as unknown as PlanDAG
}

function recordSnapshot(value: unknown): Readonly<DurableDelegationRunRegistryRecordV1> {
  const raw = plainRecord(value)
  if (raw === null || !exactKeys(raw, ['binding', 'bindingHash', 'phase', 'plan', 'runId']) ||
    typeof raw['runId'] !== 'string' || !RUN_ID.test(raw['runId']) ||
    typeof raw['bindingHash'] !== 'string' || !HASH.test(raw['bindingHash']) ||
    (raw['phase'] !== 'registered' && raw['phase'] !== 'active')) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  return Object.freeze({
    runId: raw['runId'],
    bindingHash: raw['bindingHash'],
    binding: bindingSnapshot(raw['binding']),
    plan: planSnapshot(raw['plan']),
    phase: raw['phase'],
  })
}

function stateSnapshot(value: unknown): RegistryStateV1 {
  const raw = plainRecord(value)
  if (raw === null || !exactKeys(raw, [
    'generation', 'payloadSha256', 'records', 'schemaVersion',
  ]) || raw['schemaVersion'] !== 1 || !Number.isSafeInteger(raw['generation']) ||
    (raw['generation'] as number) < 1 || !Array.isArray(raw['records']) ||
    raw['records'].length > MAX_RECORDS || typeof raw['payloadSha256'] !== 'string' ||
    !HASH.test(raw['payloadSha256'])) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  const records = raw['records'].map(recordSnapshot)
  const runIds = records.map(record => record.runId)
  if (new Set(runIds).size !== runIds.length ||
    runIds.some((runId, index) => index > 0 && runId <= runIds[index - 1]!)) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  const payload: RegistryPayloadV1 = Object.freeze({
    schemaVersion: 1,
    generation: raw['generation'] as number,
    records: Object.freeze(records),
  })
  if (digest(payload) !== raw['payloadSha256']) {
    fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
  }
  return Object.freeze({ ...payload, payloadSha256: raw['payloadSha256'] })
}

function emptyState(): RegistryStateV1 {
  const payload: RegistryPayloadV1 = Object.freeze({
    schemaVersion: 1,
    generation: 0,
    records: Object.freeze([]),
  })
  return Object.freeze({ ...payload, payloadSha256: digest(payload) })
}

function assertPrivateDirectory(path: string): void {
  const canonical = resolve(path)
  const info = lstatSync(canonical)
  const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(canonical) !== canonical ||
    info.uid !== owner || (info.mode & 0o077) !== 0) {
    fail('DELEGATION_RUN_REGISTRY_CONFIG_INVALID')
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function readPrivateFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.nlink !== 1 || info.uid !== owner ||
      (info.mode & 0o077) !== 0 || info.size > MAX_STATE_BYTES) {
      fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
    return readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function immutableState(records: readonly DurableDelegationRunRegistryRecordV1[], generation: number) {
  const sorted = [...records].sort((left, right) => left.runId < right.runId ? -1 : 1)
  const payload: RegistryPayloadV1 = Object.freeze({
    schemaVersion: 1,
    generation,
    records: Object.freeze(sorted),
  })
  return Object.freeze({ ...payload, payloadSha256: digest(payload) })
}

function sameRecord(
  left: Readonly<DurableDelegationRunRegistryRecordV1>,
  right: Readonly<DurableDelegationRunRegistryRecordV1>,
): boolean {
  return left.runId === right.runId && left.bindingHash === right.bindingHash &&
    digest(left.binding) === digest(right.binding) && digest(left.plan) === digest(right.plan)
}

/**
 * Bounded code-owned inventory. It never discovers runs from directory names;
 * the only durable inventory is the exact checksummed registry file.
 */
export function makeNodeDurableDelegationRunRegistry(input: Readonly<{
  stateRoot: string
}>): DurableDelegationRunRegistryV1 {
  if (typeof input !== 'object' || input === null ||
    !isAbsolute(input.stateRoot) || normalize(input.stateRoot) !== input.stateRoot ||
    input.stateRoot === '/' || input.stateRoot.includes('\0')) {
    fail('DELEGATION_RUN_REGISTRY_CONFIG_INVALID')
  }
  const stateRoot = resolve(input.stateRoot)
  assertPrivateDirectory(stateRoot)
  const registryPath = join(stateRoot, '.run-registry-v1.json')

  const read = (): RegistryStateV1 => {
    if (!existsSync(registryPath)) return emptyState()
    try { return stateSnapshot(JSON.parse(readPrivateFile(registryPath)) as unknown) } catch (error) {
      if (error instanceof DurableDelegationRunRegistryError) throw error
      return fail('DELEGATION_RUN_REGISTRY_STATE_INVALID')
    }
  }

  const save = (state: RegistryStateV1): void => {
    const content = JSON.stringify(state, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
      fail('DELEGATION_RUN_REGISTRY_FULL')
    }
    const temporary = `${registryPath}.tmp-${process.pid}-${randomUUID()}`
    let descriptor: number | undefined
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      writeFileSync(descriptor, content, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, registryPath)
      const published = lstatSync(registryPath)
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 ||
        (published.mode & 0o077) !== 0) {
        fail('DELEGATION_RUN_REGISTRY_WRITE_FAILED')
      }
      syncPath(stateRoot)
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor) } catch { /* best effort */ }
      try { unlinkSync(temporary) } catch { /* best effort */ }
      if (error instanceof DurableDelegationRunRegistryError) throw error
      fail('DELEGATION_RUN_REGISTRY_WRITE_FAILED')
    }
  }

  const exactRunRoot = (runId: string): string => join(stateRoot, runId)

  return Object.freeze({
    register(rawInput: DurableDelegationRunRegistrationInputV1) {
      if (typeof rawInput !== 'object' || rawInput === null ||
        typeof rawInput.runRoot !== 'string' ||
        dirname(rawInput.runRoot) !== stateRoot || basename(rawInput.runRoot) === rawInput.runRoot ||
        normalize(rawInput.runRoot) !== rawInput.runRoot || !RUN_ID.test(basename(rawInput.runRoot)) ||
        typeof rawInput.bindingHash !== 'string' || !HASH.test(rawInput.bindingHash)) {
        fail('DELEGATION_RUN_REGISTRY_CONFIG_INVALID')
      }
      const candidate = recordSnapshot({
        runId: basename(rawInput.runRoot),
        bindingHash: rawInput.bindingHash,
        binding: rawInput.binding,
        plan: rawInput.plan,
        phase: 'registered',
      })
      const state = read()
      const existing = state.records.find(record => record.runId === candidate.runId)
      if (existing !== undefined && !sameRecord(existing, candidate)) {
        fail('DELEGATION_RUN_REGISTRY_CONFLICT')
      }
      if (existing === undefined) {
        if (state.records.length >= MAX_RECORDS) fail('DELEGATION_RUN_REGISTRY_FULL')
        save(immutableState([...state.records, candidate], state.generation + 1))
      }
      let activated = existing?.phase === 'active'
      let retired = false
      return Object.freeze({
        runRoot: exactRunRoot(candidate.runId),
        activate() {
          if (retired) fail('DELEGATION_RUN_REGISTRY_CONFLICT')
          if (activated) return
          const current = read()
          const index = current.records.findIndex(record => record.runId === candidate.runId)
          if (index < 0 || !sameRecord(current.records[index]!, candidate)) {
            fail('DELEGATION_RUN_REGISTRY_CONFLICT')
          }
          if (current.records[index]!.phase === 'active') {
            activated = true
            return
          }
          const records = [...current.records]
          records[index] = Object.freeze({ ...current.records[index]!, phase: 'active' })
          save(immutableState(records, current.generation + 1))
          activated = true
        },
        retire() {
          if (retired) return
          if (!activated) fail('DELEGATION_RUN_REGISTRY_CONFLICT')
          const current = read()
          const index = current.records.findIndex(record => record.runId === candidate.runId)
          if (index < 0) {
            retired = true
            return
          }
          const active = current.records[index]!
          if (!sameRecord(active, candidate) || active.phase !== 'active') {
            fail('DELEGATION_RUN_REGISTRY_CONFLICT')
          }
          save(immutableState(
            current.records.filter((_record, recordIndex) => recordIndex !== index),
            current.generation + 1,
          ))
          retired = true
        },
      })
    },

    listExact(bindingHash: string) {
      if (!HASH.test(bindingHash)) fail('DELEGATION_RUN_REGISTRY_CONFIG_INVALID')
      return Object.freeze(read().records.filter(record => record.bindingHash === bindingHash))
    },

    runRoot(record: Readonly<DurableDelegationRunRegistryRecordV1>) {
      const snapshot = recordSnapshot(record)
      return exactRunRoot(snapshot.runId)
    },
  })
}

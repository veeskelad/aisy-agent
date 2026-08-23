import { createHash } from 'node:crypto'
import { isAbsolute, join, normalize } from 'node:path'
import {
  isGenuineToolExecutionContextFor,
  normalizeSpawnPlan,
  type PlanDAG,
  type ResolvedWorkBinding,
  type TaskObservation,
  type ToolExecutionContext,
} from '@aisy/core'
import {
  DurableDelegationRuntimeError,
  type DurableDelegationRuntime,
} from './durable-delegation-runtime.js'
import type { DurableDelegationRunRegistryV1 } from './durable-delegation-run-registry.js'
import {
  isGenuineExecutionSupervisorLease,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

export type DurableDelegationInvocationErrorCode =
  | 'DURABLE_DELEGATION_CONFIG_INVALID'
  | 'DURABLE_DELEGATION_IDENTITY_UNAVAILABLE'
  | 'DURABLE_DELEGATION_PLAN_INVALID'
  | 'DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE'
  | 'DURABLE_DELEGATION_REGISTRY_FAILED'

export class DurableDelegationInvocationError extends Error {
  constructor(public readonly code: DurableDelegationInvocationErrorCode) {
    super(code)
    this.name = 'DurableDelegationInvocationError'
  }
}

export interface DurableDelegationInvocationRuntimeInput {
  readonly runRoot: string
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly plan: PlanDAG
}

export interface DurableDelegationInvocationDeps {
  /** Existing private parent; the durable runtime verifies it before writes. */
  stateRoot: string
  /** Genuine opaque authority captured by the parent supervisor for this turn. */
  executionAuthority: ExecutionSupervisorLease
  binding: ResolvedWorkBinding
  defaultCardName: string
  registry: Pick<DurableDelegationRunRegistryV1, 'register'>
  createRuntime(input: DurableDelegationInvocationRuntimeInput): DurableDelegationRuntime
}

const MAX_ID_BYTES = 1024
const MAX_PLAN_BYTES = 1024 * 1024
const SAFE_CARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/

function fail(code: DurableDelegationInvocationErrorCode): never {
  throw new DurableDelegationInvocationError(code)
}

function authorityHeld(authority: ExecutionSupervisorLease): boolean {
  try { return authority.isHeld() === true } catch { return false }
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
}

function bindingSnapshot(value: ResolvedWorkBinding): Readonly<ResolvedWorkBinding> {
  if (!boundedId(value.operatorId) || !boundedId(value.profileId) ||
    !boundedId(value.projectId) || !boundedId(value.sessionId) ||
    (value.scope !== 'workspace' && value.scope !== 'project' && value.scope !== 'session') ||
    (value.botId !== undefined && !boundedId(value.botId))) {
    return fail('DURABLE_DELEGATION_CONFIG_INVALID')
  }
  return Object.freeze({
    ...(value.botId === undefined ? {} : { botId: value.botId }),
    operatorId: value.operatorId,
    profileId: value.profileId,
    projectId: value.projectId,
    sessionId: value.sessionId,
    scope: value.scope,
  })
}

function immutablePlan(value: PlanDAG): PlanDAG {
  const nodes = value.nodes.map(task => Object.freeze({
    ...task,
    dependsOn: Object.freeze([...task.dependsOn]) as unknown as string[],
    scope: Object.freeze({
      ...task.scope,
      owns: Object.freeze([...task.scope.owns]) as unknown as string[],
      doNotTouch: Object.freeze([...task.scope.doNotTouch]) as unknown as string[],
    }),
    budgetSlice: Object.freeze({ ...task.budgetSlice }),
    retryPolicy: Object.freeze({ ...task.retryPolicy }),
  }))
  const edges = value.edges.map(edge => Object.freeze({ ...edge }))
  return Object.freeze({
    nodes: Object.freeze(nodes) as unknown as PlanDAG['nodes'],
    edges: Object.freeze(edges) as unknown as PlanDAG['edges'],
  })
}

function invocationDigest(
  binding: Readonly<ResolvedWorkBinding>,
  context: ToolExecutionContext & { turnId: string },
): string {
  return createHash('sha256')
    .update('aisy:durable-delegation-invocation:v1\0', 'utf8')
    .update(JSON.stringify({
      binding,
      sessionId: context.sessionId,
      turnId: context.turnId,
      ordinal: context.ordinal,
    }), 'utf8')
    .digest('hex')
}

/**
 * Converts a genuine parent tool position into one opaque durable run root.
 * The model supplies only the plan; it never supplies a path or recovery ID.
 */
export function makeDurableDelegationInvocationDispatcher(
  deps: DurableDelegationInvocationDeps,
): (
  planJson: string,
  context?: ToolExecutionContext,
) => Promise<TaskObservation[]> {
  if (!isAbsolute(deps.stateRoot) || normalize(deps.stateRoot) !== deps.stateRoot ||
    deps.stateRoot === '/' || deps.stateRoot.includes('\0') ||
    !isGenuineExecutionSupervisorLease(deps.executionAuthority) ||
    !HASH.test(deps.executionAuthority.bindingHash) || !authorityHeld(deps.executionAuthority) ||
    !SAFE_CARD.test(deps.defaultCardName) ||
    typeof deps.registry !== 'object' || deps.registry === null ||
    typeof deps.registry.register !== 'function' || typeof deps.createRuntime !== 'function') {
    return fail('DURABLE_DELEGATION_CONFIG_INVALID')
  }
  const stateRoot = deps.stateRoot
  const executionAuthority = deps.executionAuthority
  const binding = bindingSnapshot(deps.binding)
  const defaultCardName = deps.defaultCardName
  const registry = deps.registry
  const createRuntime = deps.createRuntime

  return async (planJson, context): Promise<TaskObservation[]> => {
    if (!isGenuineToolExecutionContextFor(context, 'spawn_subagent') ||
      !boundedId(context.turnId) || context.sessionId !== binding.sessionId ||
      !Number.isSafeInteger(context.ordinal) || context.ordinal < 1) {
      return fail('DURABLE_DELEGATION_IDENTITY_UNAVAILABLE')
    }
    if (typeof planJson !== 'string' || planJson.length === 0 ||
      Buffer.byteLength(planJson, 'utf8') > MAX_PLAN_BYTES) {
      return fail('DURABLE_DELEGATION_PLAN_INVALID')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(planJson)
    } catch {
      return fail('DURABLE_DELEGATION_PLAN_INVALID')
    }
    const plan = immutablePlan(normalizeSpawnPlan(parsed, defaultCardName))
    if (plan.nodes.length === 0) return fail('DURABLE_DELEGATION_PLAN_INVALID')
    const runRoot = join(stateRoot, `inv-${invocationDigest(binding, {
      ...context,
      turnId: context.turnId,
    })}`)
    if (!authorityHeld(executionAuthority)) {
      return fail('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE')
    }
    let registration: ReturnType<DurableDelegationRunRegistryV1['register']>
    try {
      registration = registry.register({
        runRoot,
        bindingHash: executionAuthority.bindingHash,
        binding,
        plan,
      })
    } catch {
      return fail('DURABLE_DELEGATION_REGISTRY_FAILED')
    }
    if (registration.runRoot !== runRoot || typeof registration.activate !== 'function' ||
      typeof registration.retire !== 'function') {
      return fail('DURABLE_DELEGATION_REGISTRY_FAILED')
    }
    if (!authorityHeld(executionAuthority)) {
      return fail('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE')
    }
    const runtime = createRuntime({ runRoot, binding, plan })
    try { registration.activate() } catch {
      return fail('DURABLE_DELEGATION_REGISTRY_FAILED')
    }
    if (!authorityHeld(executionAuthority)) {
      return fail('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE')
    }
    let observations: TaskObservation[]
    try {
      observations = await runtime.execute(context.signal)
    } catch (error) {
      if (error instanceof DurableDelegationRuntimeError &&
        error.code === 'DELEGATION_MANUAL_RECOVERY_REQUIRED') {
        try { registration.retire() } catch {
          return fail('DURABLE_DELEGATION_REGISTRY_FAILED')
        }
      }
      throw error
    }
    if (!authorityHeld(executionAuthority)) {
      return fail('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE')
    }
    try { registration.retire() } catch {
      return fail('DURABLE_DELEGATION_REGISTRY_FAILED')
    }
    return observations
  }
}

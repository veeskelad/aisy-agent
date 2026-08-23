import {
  makeAgentRunner,
  makeGrantStore,
  type LoopGuardian,
  type MemoryPort,
  type ModelResponse,
  type SessionLog,
  type ToolCall,
  type ToolExecutionContext,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'
import {
  DurableDelegationInvocationError,
  makeDurableDelegationInvocationDispatcher,
  type DurableDelegationInvocationRuntimeInput,
} from './durable-delegation-invocation.js'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'

const BINDING = {
  botId: 'bot-a',
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session' as const,
}
const EXECUTION_BINDING_HASH = 'a'.repeat(64)
const LIVENESS = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SUPERVISOR_SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)

function supervisorFrame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineExecutionAuthority(): Promise<ExecutionSupervisorLease> {
  const replies = [
    supervisorFrame({
      version: 3,
      type: 'hello-challenge',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      parentNonce: PARENT,
    }),
    supervisorFrame({
      version: 3,
      type: 'hello-ack',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1',
        parentNonce: PARENT,
        childNonce: CHILD,
        sessionId: SUPERVISOR_SESSION,
        livenessDescriptorHash: LIVENESS,
      }),
    }),
    supervisorFrame({
      version: 3,
      type: 'capture-ack',
      requestId: 'capture-1',
      deadlineAtMs: 3_000,
      sessionId: SUPERVISOR_SESSION,
      bindingHash: EXECUTION_BINDING_HASH,
      leaseId: LEASE,
    }),
  ]
  const channel: ExecutionSupervisorChannel = {
    send: () => {},
    async receive() {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect: () => () => {},
    close: () => {},
  }
  const ids = ['capture-1']
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => ids.shift() ?? 'unexpected-id',
    randomNonce: () => CHILD,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS,
  })
  return session.captureTurn(EXECUTION_BINDING_HASH)
}

const memory: MemoryPort = {
  snapshot: async () => ({
    prefixBytes: new Uint8Array(),
    prefixHash: 'prefix',
    breakpoints: [],
    takenAt: '2026-08-08T00:00:00.000Z',
  }),
  forget: async () => {},
}
const guardian: LoopGuardian = { observe: () => ({ trip: false }), note: () => {} }
const sessionLog: SessionLog = { append: () => {}, resume: () => null }

async function genuineContext(
  call: ToolCall,
  turnId: string,
  signal?: AbortSignal,
  sessionId = BINDING.sessionId,
): Promise<ToolExecutionContext> {
  let seen: ToolExecutionContext | undefined
  let modelCall = 0
  const runner = makeAgentRunner({
    provider: {
      complete: async (): Promise<ModelResponse> => {
        modelCall += 1
        return modelCall === 1
          ? { reply: '', toolCalls: [call] }
          : { reply: 'done', toolCalls: [] }
      },
    },
    memory,
    grants: makeGrantStore(),
    grantBinding: { ...BINDING, sessionId },
    executeTool: async (_call, context) => {
      seen = context
      return { ok: true, output: 'captured' }
    },
    approve: async () => ({ decision: 'confirmed' }),
    guardian,
    sessionLog,
  })
  await runner.handle({
    sessionId,
    turnId,
    spans: [{ role: 'user', provenance: 'operator', text: 'delegate' }],
    ...(signal === undefined ? {} : { signal }),
  })
  if (seen === undefined) throw new Error('context was not captured')
  return seen
}

function factory(records: {
  inputs: DurableDelegationInvocationRuntimeInput[]
  signals: Array<AbortSignal | undefined>
  events: string[]
}) {
  return (input: DurableDelegationInvocationRuntimeInput) => {
    records.events.push('create-runtime')
    records.inputs.push(input)
    return {
      execute: async (signal?: AbortSignal) => {
        records.events.push('execute')
        records.signals.push(signal)
        return [{
          delegationId: 'd-s1',
          status: 'completed' as const,
          summary: 'done',
          touched: [],
          result: null,
          cost: { iterations: 1, spendUsd: 0, wallMs: 1 },
        }]
      },
      cancel: () => {},
    }
  }
}

async function dispatcher(records = {
  inputs: [] as DurableDelegationInvocationRuntimeInput[],
  signals: [] as Array<AbortSignal | undefined>,
  events: [] as string[],
  registrations: [] as Array<{ runRoot: string; bindingHash: string }>,
}) {
  const executionAuthority = await genuineExecutionAuthority()
  return {
    records,
    dispatch: makeDurableDelegationInvocationDispatcher({
      stateRoot: '/private/state/delegation-runs',
      executionAuthority,
      binding: BINDING,
      defaultCardName: 'general',
      registry: {
        register(input) {
          records.events.push('register')
          records.registrations.push({
            runRoot: input.runRoot,
            bindingHash: input.bindingHash,
          })
          return {
            runRoot: input.runRoot,
            activate() { records.events.push('activate') },
            retire() { records.events.push('retire') },
          }
        },
      },
      createRuntime: factory(records),
    }),
  }
}

describe('durable delegation invocation binding', () => {
  it('maps replay of one genuine parent position to one opaque run root', async () => {
    const first = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'telegram-update-7',
    )
    const replay = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'telegram-update-7',
    )
    const next = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'telegram-update-8',
    )
    const { dispatch, records } = await dispatcher()
    const plan = JSON.stringify({
      intent: 'inspect state',
      runRoot: '/model/chosen/path',
      turnId: 'model-chosen-turn',
    })

    await dispatch(plan, first)
    await dispatch(plan, replay)
    await dispatch(plan, next)

    expect(records.inputs[0]?.runRoot).toBe(records.inputs[1]?.runRoot)
    expect(records.inputs[2]?.runRoot).not.toBe(records.inputs[0]?.runRoot)
    expect(records.inputs[0]?.runRoot).toMatch(
      /^\/private\/state\/delegation-runs\/inv-[a-f0-9]{64}$/,
    )
    expect(records.inputs[0]?.runRoot).not.toContain('telegram-update-7')
    expect(records.inputs[0]?.runRoot).not.toContain('/model/chosen/path')
    expect(records.inputs[0]?.binding).toEqual(BINDING)
    expect(Object.isFrozen(records.inputs[0]?.binding)).toBe(true)
    expect(Object.isFrozen(records.inputs[0]?.plan)).toBe(true)
    expect(Object.isFrozen(records.inputs[0]?.plan.nodes)).toBe(true)
    expect(records.registrations).toHaveLength(3)
    expect(records.registrations.every(record =>
      record.bindingHash === EXECUTION_BINDING_HASH)).toBe(true)
    expect(records.events).toEqual([
      'register', 'create-runtime', 'activate', 'execute', 'retire',
      'register', 'create-runtime', 'activate', 'execute', 'retire',
      'register', 'create-runtime', 'activate', 'execute', 'retire',
    ])
  })

  it('forwards turn cancellation without including it in the durable identity', async () => {
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-with-stop',
      firstController.signal,
    )
    const replay = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-with-stop',
      secondController.signal,
    )
    const { dispatch, records } = await dispatcher()

    await dispatch('{"intent":"work"}', first)
    await dispatch('{"intent":"work"}', replay)

    expect(records.inputs[0]?.runRoot).toBe(records.inputs[1]?.runRoot)
    expect(records.signals).toEqual([firstController.signal, secondController.signal])
  })

  it('rejects missing, copied, wrong-tool and cross-session identities before runtime creation', async () => {
    const spawn = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-a',
    )
    const read = await genuineContext(
      { name: 'read_file', args: { path: 'a' } },
      'turn-a',
    )
    const { dispatch, records } = await dispatcher()
    const expectIdentityDenial = async (context?: ToolExecutionContext): Promise<void> => {
      await expect(dispatch('{"intent":"work"}', context)).rejects.toEqual(
        new DurableDelegationInvocationError('DURABLE_DELEGATION_IDENTITY_UNAVAILABLE'),
      )
    }

    await expectIdentityDenial()
    await expectIdentityDenial({ ...spawn })
    await expectIdentityDenial(read)
    const otherSession = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-b',
      undefined,
      'other-session',
    )
    await expectIdentityDenial(otherSession)
    expect(records.inputs).toHaveLength(0)
  })

  it('rejects invalid plans and configuration before runtime I/O', async () => {
    expect(() => makeDurableDelegationInvocationDispatcher({
      stateRoot: 'relative/runs',
      executionAuthority: {} as never,
      binding: BINDING,
      defaultCardName: 'general',
      registry: { register: () => { throw new Error('must not run') } },
      createRuntime: () => { throw new Error('must not run') },
    })).toThrow(new DurableDelegationInvocationError('DURABLE_DELEGATION_CONFIG_INVALID'))
    const genuine = await genuineExecutionAuthority()
    expect(() => makeDurableDelegationInvocationDispatcher({
      stateRoot: '/private/state/delegation-runs',
      executionAuthority: { ...genuine } as never,
      binding: BINDING,
      defaultCardName: 'general',
      registry: { register: () => { throw new Error('must not run') } },
      createRuntime: () => { throw new Error('must not run') },
    })).toThrow(new DurableDelegationInvocationError('DURABLE_DELEGATION_CONFIG_INVALID'))

    const context = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-a',
    )
    const { dispatch, records } = await dispatcher()
    await expect(dispatch('{', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_PLAN_INVALID'),
    )
    await expect(dispatch('{}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_PLAN_INVALID'),
    )
    expect(records.inputs).toHaveLength(0)
  })

  it('fails closed around registry publication without executing the runtime', async () => {
    const context = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-registry-failure',
    )
    let created = 0
    let executed = 0
    const executionAuthority = await genuineExecutionAuthority()
    const base = {
      stateRoot: '/private/state/delegation-runs',
      executionAuthority,
      binding: BINDING,
      defaultCardName: 'general',
    }
    const registerFailure = makeDurableDelegationInvocationDispatcher({
      ...base,
      registry: { register: () => { throw new Error('unavailable') } },
      createRuntime: () => {
        created += 1
        throw new Error('must not create')
      },
    })
    await expect(registerFailure('{"intent":"work"}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_REGISTRY_FAILED'),
    )
    expect(created).toBe(0)

    const activationFailure = makeDurableDelegationInvocationDispatcher({
      ...base,
      registry: {
        register: input => ({
          runRoot: input.runRoot,
          activate() { throw new Error('unavailable') },
          retire() {},
        }),
      },
      createRuntime: () => {
        created += 1
        return {
          execute: async () => {
            executed += 1
            return []
          },
          cancel: () => {},
        }
      },
    })
    await expect(activationFailure('{"intent":"work"}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_REGISTRY_FAILED'),
    )
    expect(created).toBe(1)
    expect(executed).toBe(0)
  })

  it('rechecks genuine supervisor authority at registry and activation boundaries', async () => {
    const context = await genuineContext(
      { name: 'spawn_subagent', args: { plan: '{}' } },
      'turn-authority-loss',
    )
    let created = 0
    let executed = 0
    const lostDuringRegister = await genuineExecutionAuthority()
    const afterRegister = makeDurableDelegationInvocationDispatcher({
      stateRoot: '/private/state/delegation-runs',
      executionAuthority: lostDuringRegister,
      binding: BINDING,
      defaultCardName: 'general',
      registry: {
        register: input => {
          try { lostDuringRegister.failClosed() } catch { /* expected authority loss */ }
          return { runRoot: input.runRoot, activate: () => {}, retire: () => {} }
        },
      },
      createRuntime: () => {
        created += 1
        throw new Error('must not create')
      },
    })
    await expect(afterRegister('{"intent":"work"}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE'),
    )
    expect(created).toBe(0)

    const lostDuringActivation = await genuineExecutionAuthority()
    const afterActivation = makeDurableDelegationInvocationDispatcher({
      stateRoot: '/private/state/delegation-runs',
      executionAuthority: lostDuringActivation,
      binding: BINDING,
      defaultCardName: 'general',
      registry: {
        register: input => ({
          runRoot: input.runRoot,
          activate() {
            try { lostDuringActivation.failClosed() } catch { /* expected authority loss */ }
          },
          retire() {},
        }),
      },
      createRuntime: () => {
        created += 1
        return {
          execute: async () => {
            executed += 1
            return []
          },
          cancel: () => {},
        }
      },
    })
    await expect(afterActivation('{"intent":"work"}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE'),
    )
    expect(created).toBe(1)
    expect(executed).toBe(0)

    const lostDuringExecution = await genuineExecutionAuthority()
    let retired = 0
    const afterExecution = makeDurableDelegationInvocationDispatcher({
      stateRoot: '/private/state/delegation-runs',
      executionAuthority: lostDuringExecution,
      binding: BINDING,
      defaultCardName: 'general',
      registry: {
        register: input => ({
          runRoot: input.runRoot,
          activate() {},
          retire() { retired += 1 },
        }),
      },
      createRuntime: () => ({
        execute: async () => {
          try { lostDuringExecution.failClosed() } catch { /* expected authority loss */ }
          return []
        },
        cancel: () => {},
      }),
    })
    await expect(afterExecution('{"intent":"work"}', context)).rejects.toEqual(
      new DurableDelegationInvocationError('DURABLE_DELEGATION_AUTHORITY_UNAVAILABLE'),
    )
    expect(retired).toBe(0)
  })
})

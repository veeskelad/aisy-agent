/**
 * delegation-driver.spec.ts — Tests for runDelegation (Tier-3, ADR-0039 C1).
 *
 * All tests build real DelegationManagers via makeDelegationManager over small
 * PlanDAGs. The `runTask` seam is injected so we can probe concurrency without
 * involving a real sub-agent.
 */

import { describe, it, expect } from 'vitest'
import { makeDelegationManager } from '../orchestration/index.js'
import { DEFAULT_GENERAL_CARD } from './agent-cards.js'
import { runBoundedDelegation, runDelegation } from './delegation-driver.js'
import type {
  DelegationHandle,
  DelegationTask,
  DelegationDeps,
  PlanDAG,
  OrchestrationEvent,
  TaskObservation,
  DelegationPersistencePort,
} from '../orchestration/index.js'
import type { DelegationDriverDeps } from './delegation-driver.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COST = { iterations: 1, spendUsd: 0.01, wallMs: 10 }
const DELEGATION_BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
}

function makeDeps(overrides: Partial<DelegationDeps> = {}): DelegationDeps & { events: OrchestrationEvent[] } {
  const events: OrchestrationEvent[] = []
  return {
    events,
    binding: DELEGATION_BINDING,
    resolveCard: (_name: string) => DEFAULT_GENERAL_CARD,
    skillTouchedPaths: (_skill: string) => [],
    mcpWritable: (_server: string) => false,
    emit: (e: OrchestrationEvent) => { events.push(e) },
    ...overrides,
  }
}

function makeTask(overrides: Partial<DelegationTask>): DelegationTask {
  return {
    taskId: 't1',
    intent: 'do something',
    assignedTo: 'general',
    dependsOn: [],
    scope: { owns: [], doNotTouch: [], taskClass: 'reasoning' },
    budgetSlice: { iterations: 40, spendUsd: 0.5 },
    outputContract: 'summary',
    retryPolicy: { maxReplans: 0, maxIterations: 20 },
    ...overrides,
  }
}

/** A microtask barrier that lets other concurrent microtasks run before resolving. */
function barrier(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runDelegation', () => {

  // Scenario 1: linear A→B — A must complete before B is even eligible.
  it('runs a linear A→B plan in order (A completes before B starts)', async () => {
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 'A', scope: { owns: ['a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'B', dependsOn: ['A'], scope: { owns: ['b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [{ from: 'A', to: 'B' }],
    }

    const manager = makeDelegationManager(dag, makeDeps())
    const callOrder: string[] = []

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle: DelegationHandle, task: DelegationTask) => {
        callOrder.push(task.taskId)
        await barrier()
        return handle.complete(`done ${task.taskId}`, {}, COST)
      },
    }

    const observations = await runDelegation(deps)

    expect(callOrder).toEqual(['A', 'B'])
    expect(observations).toHaveLength(2)
    expect(observations.map(o => o.status)).toEqual(['completed', 'completed'])
  })

  // Scenario 2: two independent write-disjoint tasks → max concurrent == 2.
  it('runs two write-disjoint independent tasks concurrently (max-concurrent == 2)', async () => {
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 'X', scope: { owns: ['a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'Y', scope: { owns: ['b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }

    const manager = makeDelegationManager(dag, makeDeps())

    let inFlight = 0
    let maxInFlight = 0

    // A shared promise that lets us hold both tasks in-flight at once.
    let releaseAll: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseAll = resolve })

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle: DelegationHandle, task: DelegationTask) => {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        // Both tasks wait on the same gate before completing.
        await gate
        inFlight--
        return handle.complete(`done ${task.taskId}`, {}, COST)
      },
    }

    const resultPromise = runDelegation(deps)

    // Yield to let both tasks enter runTask (increment inFlight) before the gate opens.
    await barrier()
    await barrier()

    // Release the gate so both tasks can complete.
    releaseAll!()

    await resultPromise

    expect(maxInFlight).toBe(2)
  })

  // Scenario 3: two independent write-OVERLAPPING tasks → serialized (max-concurrent == 1).
  it('serializes two write-overlapping independent tasks (max-concurrent == 1)', async () => {
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 'P', scope: { owns: ['shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'Q', scope: { owns: ['shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }

    const manager = makeDelegationManager(dag, makeDeps())

    let inFlight = 0
    let maxInFlight = 0

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle: DelegationHandle, task: DelegationTask) => {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        await barrier()
        inFlight--
        return handle.complete(`done ${task.taskId}`, {}, COST)
      },
    }

    await runDelegation(deps)

    expect(maxInFlight).toBe(1)
  })

  // Scenario 4: a failed task cascade-skips its downstream — downstream runTask never invoked.
  it('cascade-skips downstream of a failed task; downstream runTask is never invoked', async () => {
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 'ROOT', scope: { owns: ['root/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'CHILD', dependsOn: ['ROOT'], scope: { owns: ['child/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [{ from: 'ROOT', to: 'CHILD' }],
    }

    const manager = makeDelegationManager(dag, makeDeps())
    const invoked = new Set<string>()

    const cascadeEvents: unknown[] = []

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle: DelegationHandle, task: DelegationTask) => {
        invoked.add(task.taskId)
        await barrier()
        // ROOT fails.
        return handle.fail(`failed ${task.taskId}`, COST)
      },
      onEvent: (e) => {
        if (e.kind === 'cascade-skip') cascadeEvents.push(e)
      },
    }

    const observations = await runDelegation(deps)

    // ROOT was attempted.
    expect(invoked.has('ROOT')).toBe(true)
    // CHILD was never invoked (cascade-skipped).
    expect(invoked.has('CHILD')).toBe(false)

    // Observations only contain ROOT's result (failed), not CHILD (skipped, never ran).
    expect(observations).toHaveLength(1)
    expect(observations[0]!.status).toBe('failed')

    // A cascade-skip event was emitted.
    expect(cascadeEvents.length).toBeGreaterThan(0)
  })

  // Scenario 5: a throwing runTask degrades to a failure, emits task-error, and cascade-skips downstream.
  it('degrades a throwing runTask to a failure, emits task-error, and cascade-skips downstream', async () => {
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 'THROW', scope: { owns: ['throw/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'CHILD', dependsOn: ['THROW'], scope: { owns: ['child/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [{ from: 'THROW', to: 'CHILD' }],
    }

    const manager = makeDelegationManager(dag, makeDeps())
    const invoked = new Set<string>()
    const errorEvents: unknown[] = []
    const cascadeEvents: unknown[] = []

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (_handle: DelegationHandle, task: DelegationTask) => {
        invoked.add(task.taskId)
        await barrier()
        // THROW's runTask rejects instead of calling handle.fail/complete.
        throw new Error(`runTask exploded for ${task.taskId}`)
      },
      onEvent: (e) => {
        if (e.kind === 'task-error') errorEvents.push(e)
        if (e.kind === 'cascade-skip') cascadeEvents.push(e)
      },
    }

    // Must NOT reject — degraded to partial results.
    const observations = await runDelegation(deps)

    // THROW was attempted; CHILD was never invoked (cascade-skipped).
    expect(invoked.has('THROW')).toBe(true)
    expect(invoked.has('CHILD')).toBe(false)

    // The driver emitted a task-error event for THROW.
    expect(errorEvents).toHaveLength(1)
    const ev = errorEvents[0] as { kind: string; detail: { taskId: string; error: string } }
    expect(ev.detail.taskId).toBe('THROW')
    expect(ev.detail.error).toContain('runTask exploded')

    // The failed task produces a 'failed' observation (from handle.fail inside the driver).
    expect(observations).toHaveLength(1)
    expect(observations[0]!.status).toBe('failed')

    // A cascade-skip event was emitted for CHILD.
    expect(cascadeEvents.length).toBeGreaterThan(0)
  })

  // Bonus: returns empty array when plan has no tasks.
  it('returns empty observations for an empty plan', async () => {
    const dag: PlanDAG = { nodes: [], edges: [] }
    const manager = makeDelegationManager(dag, makeDeps())
    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle, task) => handle.complete('done', {}, COST),
    }
    const observations = await runDelegation(deps)
    expect(observations).toHaveLength(0)
  })

  // FIX B: a spawn-failing task (null assignedTo) surfaces as ONE failed observation
  // instead of being silently discarded as a Promise.allSettled 'rejected' result.
  it('surfaces a spawn failure as a failed observation (null assignedTo → spawn throws)', async () => {
    // Build a manager with a task that has null assignedTo so spawn() throws.
    const dag: PlanDAG = {
      nodes: [
        makeTask({ taskId: 't1', intent: 'x', assignedTo: null as unknown as string }),
      ],
      edges: [],
    }
    const manager = makeDelegationManager(dag, makeDeps())
    const errorEvents: unknown[] = []

    const deps: DelegationDriverDeps = {
      manager,
      runTask: async (handle, task) => handle.complete('done', {}, COST),
      onEvent: (e) => {
        if (e.kind === 'task-error') errorEvents.push(e)
      },
    }

    // Must NOT reject — spawn failure is degraded to a failed observation.
    const observations = await runDelegation(deps)

    // One observation, status 'failed' — not empty (the silent-discard bug).
    expect(observations).toHaveLength(1)
    expect(observations[0]!.status).toBe('failed')

    // A task-error event was emitted for the spawn failure.
    expect(errorEvents).toHaveLength(1)
    const ev = errorEvents[0] as { kind: string; detail: { taskId: string; error: string } }
    expect(ev.detail.taskId).toBe('t1')
    expect(ev.detail.error).toContain('no assigned AgentCard')
  })

  it('does not spawn a ready task after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'cancelled' })], edges: [],
    }, makeDeps())
    let invoked = false

    await expect(runDelegation({
      manager,
      signal: controller.signal,
      runTask: async (handle) => {
        invoked = true
        return handle.complete('done', {}, COST)
      },
    })).resolves.toEqual([])
    expect(invoked).toBe(false)
    expect(manager.readySet().map(task => task.taskId)).toEqual(['cancelled'])
  })

  it('propagates a terminal persistence failure instead of dropping the task result', async () => {
    const persistence: DelegationPersistencePort = {
      loadRun: () => undefined,
      load: () => undefined,
      saveRun: () => {},
      save: state => {
        if (state.status === 'failed') throw new Error('durable terminal write failed')
      },
      quarantine: () => {},
    }
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'write-failure' })], edges: [],
    }, makeDeps({ persistence }))

    await expect(runDelegation({
      manager,
      runTask: async () => { throw new Error('child failed') },
    })).rejects.toThrow('durable terminal write failed')
  })

  it('propagates spawn and run errors in fail-closed production mode', async () => {
    const spawnManager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'spawn-error', assignedTo: null })], edges: [],
    }, makeDeps())
    await expect(runDelegation({
      manager: spawnManager,
      failClosed: true,
      runTask: async handle => handle.complete('unreachable', {}, COST),
    })).rejects.toThrow(/no assigned AgentCard/)

    const runManager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'run-error' })], edges: [],
    }, makeDeps())
    await expect(runDelegation({
      manager: runManager,
      failClosed: true,
      runTask: async () => { throw new Error('private adapter path') },
    })).rejects.toThrow('private adapter path')
    expect(runManager.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
  })
})

describe('runBoundedDelegation', () => {
  it.each([0, 65, 1.5])('rejects invalid maxConcurrency %s before spawn', async maxConcurrency => {
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'never' })], edges: [],
    }, makeDeps())
    let invoked = false
    await expect(runBoundedDelegation({
      manager,
      maxConcurrency,
      runTask: async handle => {
        invoked = true
        return handle.complete('done', {}, COST)
      },
    })).rejects.toMatchObject({ code: 'POLICY_INVALID' })
    expect(invoked).toBe(false)
    expect(manager.readySet().map(task => task.taskId)).toEqual(['never'])
  })

  it('chunks a write-disjoint ready batch at the exact concurrency ceiling', async () => {
    const nodes = Array.from({ length: 10 }, (_, index) => makeTask({
      taskId: `task-${index}`,
      scope: { owns: [`root-${index}/**`], doNotTouch: [], taskClass: 'reasoning' },
    }))
    const manager = makeDelegationManager({ nodes, edges: [] }, makeDeps())
    let inFlight = 0
    let maxInFlight = 0

    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 3,
      runTask: async (handle, task) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await barrier()
        inFlight--
        return handle.complete(`done ${task.taskId}`, {}, COST)
      },
    })

    expect(outcome.status).toBe('completed')
    expect(outcome.observations).toHaveLength(10)
    expect(maxInFlight).toBe(3)
    expect(Object.isFrozen(outcome.observations)).toBe(true)
  })

  it('keeps overlapping scopes serialized even when the ceiling is higher', async () => {
    const manager = makeDelegationManager({
      nodes: [
        makeTask({ taskId: 'A', scope: { owns: ['shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'B', scope: { owns: ['shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }, makeDeps())
    let inFlight = 0
    let maxInFlight = 0
    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 4,
      runTask: async (handle, task) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await barrier()
        inFlight--
        return handle.complete(`done ${task.taskId}`, {}, COST)
      },
    })
    expect(outcome.status).toBe('completed')
    expect(maxInFlight).toBe(1)
  })

  it('observes AbortSignal between chunks and leaves unstarted work pending', async () => {
    const manager = makeDelegationManager({
      nodes: [
        makeTask({ taskId: 'A', scope: { owns: ['a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'B', scope: { owns: ['b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }, makeDeps())
    const controller = new AbortController()
    const invoked: string[] = []
    const events: unknown[] = []
    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 1,
      signal: controller.signal,
      onEvent: event => events.push(event),
      runTask: async (handle, task, signal) => {
        expect(signal).toBe(controller.signal)
        invoked.push(task.taskId)
        const observation = handle.complete(`done ${task.taskId}`, {}, COST)
        controller.abort()
        return observation
      },
    })

    expect(outcome).toMatchObject({
      status: 'interrupted', pendingTaskIds: ['B'],
      observations: [expect.objectContaining({ delegationId: 'd-A' })],
    })
    expect(invoked).toEqual(['A'])
    expect(events).toEqual([{ kind: 'interrupted' }])
  })

  it('returns stable code-only spawn/task failures and never exposes raw Error.message', async () => {
    const spawnManager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'spawn', assignedTo: null })], edges: [],
    }, makeDeps())
    const spawnEvents: unknown[] = []
    const spawn = await runBoundedDelegation({
      manager: spawnManager,
      maxConcurrency: 1,
      onEvent: event => spawnEvents.push(event),
      runTask: async handle => handle.complete('unreachable', {}, COST),
    })
    expect(spawn).toEqual({
      status: 'failed', observations: [], taskId: 'spawn', code: 'SPAWN_DENIED',
    })
    expect(spawnEvents).toEqual([{
      kind: 'task-denied', taskId: 'spawn', code: 'SPAWN_DENIED',
    }])

    const runManager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'run' })], edges: [],
    }, makeDeps())
    const runEvents: unknown[] = []
    const run = await runBoundedDelegation({
      manager: runManager,
      maxConcurrency: 1,
      onEvent: event => runEvents.push(event),
      runTask: async () => { throw new Error('private adapter path /secret/token') },
    })
    expect(run).toMatchObject({
      status: 'failed', taskId: 'run', code: 'TASK_FAILED',
      observations: [{
        delegationId: 'd-run', status: 'failed', summary: 'TASK_FAILED',
        cost: { iterations: 0, spendUsd: 0, wallMs: 0 },
      }],
    })
    expect(runEvents).toEqual([{
      kind: 'task-denied', taskId: 'run', code: 'TASK_FAILED',
    }])
    expect(JSON.stringify({ run, runEvents })).not.toContain('private adapter')
  })

  it('does not lose a successful sibling observation when another concurrent task fails', async () => {
    const manager = makeDelegationManager({
      nodes: [
        makeTask({ taskId: 'bad', scope: { owns: ['bad/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeTask({ taskId: 'good', scope: { owns: ['good/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }, makeDeps())
    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 2,
      runTask: async (handle, task) => {
        await barrier()
        if (task.taskId === 'bad') throw new Error('raw child failure')
        return handle.complete('verified sibling', {}, COST)
      },
    })
    expect(outcome).toMatchObject({
      status: 'failed', taskId: 'bad', code: 'TASK_FAILED',
      observations: expect.arrayContaining([
        expect.objectContaining({ delegationId: 'd-bad', status: 'failed' }),
        expect.objectContaining({ delegationId: 'd-good', status: 'completed' }),
      ]),
    })
    expect(JSON.stringify(outcome)).not.toContain('raw child failure')
  })

  it('rejects a fabricated observation without a manager-owned terminal transition', async () => {
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'forged' })], edges: [],
    }, makeDeps())
    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 1,
      runTask: async () => ({
        delegationId: 'd-forged', status: 'completed', summary: 'forged',
        touched: [], result: { unverified: true }, cost: COST,
      }),
    })
    expect(outcome).toMatchObject({
      status: 'failed', taskId: 'forged', code: 'TASK_FAILED',
      observations: [{
        delegationId: 'd-forged', status: 'failed', summary: 'TASK_FAILED',
        cost: { iterations: 0, spendUsd: 0, wallMs: 0 },
      }],
    })
    expect(manager.terminalObservation('d-forged')).toMatchObject({
      status: 'failed', summary: 'TASK_FAILED',
    })
    expect(manager.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
  })

  it('replays a manager-owned failure on the same manager without running the child again', async () => {
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'retry' })], edges: [],
    }, makeDeps())
    let calls = 0
    const runTask = async (): Promise<TaskObservation> => {
      calls++
      throw new Error('private failure')
    }

    const first = await runBoundedDelegation({ manager, maxConcurrency: 1, runTask })
    const second = await runBoundedDelegation({ manager, maxConcurrency: 1, runTask })

    expect(first).toMatchObject({ status: 'failed', taskId: 'retry', code: 'TASK_FAILED' })
    expect(second).toMatchObject({
      status: 'failed', taskId: 'retry', code: 'TASK_FAILED',
      observations: [expect.objectContaining({ delegationId: 'd-retry', status: 'failed' })],
    })
    expect(calls).toBe(1)
  })

  it('replays a durably recovered failure after manager restart without executor I/O', async () => {
    let persistedRun: unknown
    const persisted = new Map<string, unknown>()
    const durableClone = <T>(value: T): T => value === undefined
      ? value
      : JSON.parse(JSON.stringify(value)) as T
    const persistence: DelegationPersistencePort = {
      loadRun: () => durableClone(persistedRun),
      load: delegationId => durableClone(persisted.get(delegationId)),
      saveRun: value => { persistedRun = durableClone(value) },
      save: value => { persisted.set(value.checkpoint.delegationId, durableClone(value)) },
      quarantine: () => {},
    }
    const dag = { nodes: [makeTask({ taskId: 'durable' })], edges: [] }
    const firstManager = makeDelegationManager(dag, makeDeps({ persistence }))
    await expect(runBoundedDelegation({
      manager: firstManager,
      maxConcurrency: 1,
      runTask: async () => { throw new Error('private durable failure') },
    })).resolves.toMatchObject({ status: 'failed', taskId: 'durable' })

    const restarted = makeDelegationManager(dag, makeDeps({ persistence }))
    expect(restarted.recover('d-durable')).toMatchObject({
      status: 'terminal',
      observation: { delegationId: 'd-durable', status: 'failed', summary: 'TASK_FAILED' },
    })
    let executorCalls = 0
    const replay = await runBoundedDelegation({
      manager: restarted,
      maxConcurrency: 1,
      runTask: async handle => {
        executorCalls++
        return handle.complete('unreachable', {}, COST)
      },
    })
    expect(replay).toMatchObject({
      status: 'failed', taskId: 'durable', code: 'TASK_FAILED',
      observations: [expect.objectContaining({ delegationId: 'd-durable', status: 'failed' })],
    })
    expect(executorCalls).toBe(0)
  })

  it('returns interrupted and preserves pending recovery when terminal persistence fails', async () => {
    const persistence: DelegationPersistencePort = {
      loadRun: () => undefined,
      load: () => undefined,
      saveRun: () => {},
      save: value => {
        if (value.status === 'failed') throw new Error('terminal store unavailable')
      },
      quarantine: () => {},
    }
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'uncertain' })], edges: [],
    }, makeDeps({ persistence }))
    const outcome = await runBoundedDelegation({
      manager,
      maxConcurrency: 1,
      runTask: async () => { throw new Error('private executor failure') },
    })

    expect(outcome).toEqual({
      status: 'interrupted', observations: [], pendingTaskIds: ['uncertain'],
    })
    expect(manager.terminalObservation('d-uncertain')).toBeUndefined()
    expect(manager.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
  })

  it('observes cancellation during an active child and leaves it pending for recovery', async () => {
    const manager = makeDelegationManager({
      nodes: [makeTask({ taskId: 'in-flight' })], edges: [],
    }, makeDeps())
    const controller = new AbortController()
    let entered!: () => void
    const active = new Promise<void>(resolve => { entered = resolve })
    const running = runBoundedDelegation({
      manager,
      maxConcurrency: 1,
      signal: controller.signal,
      runTask: async (_handle, _task, signal): Promise<TaskObservation> => {
        entered()
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('private abort')), { once: true })
        })
        throw new Error('unreachable')
      },
    })

    await active
    controller.abort()
    await expect(running).resolves.toEqual({
      status: 'interrupted', observations: [], pendingTaskIds: ['in-flight'],
    })
    expect(manager.terminalObservation('d-in-flight')).toBeUndefined()
    expect(manager.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })

    let rerunCalls = 0
    await expect(runBoundedDelegation({
      manager,
      maxConcurrency: 1,
      runTask: async handle => {
        rerunCalls++
        return handle.complete('unreachable', {}, COST)
      },
    })).resolves.toEqual({
      status: 'interrupted', observations: [], pendingTaskIds: ['in-flight'],
    })
    expect(rerunCalls).toBe(0)
  })
})

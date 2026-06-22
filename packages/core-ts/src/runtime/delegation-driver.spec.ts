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
import { runDelegation } from './delegation-driver.js'
import type {
  DelegationHandle,
  DelegationTask,
  DelegationDeps,
  PlanDAG,
  OrchestrationEvent,
  TaskObservation,
} from '../orchestration/index.js'
import type { DelegationDriverDeps } from './delegation-driver.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COST = { iterations: 1, spendUsd: 0.01, wallMs: 10 }

function makeDeps(overrides: Partial<DelegationDeps> = {}): DelegationDeps & { events: OrchestrationEvent[] } {
  const events: OrchestrationEvent[] = []
  return {
    events,
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
})

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeDelegationManager,
  makeBoundSubAgentRunner,
  resolveChildAgentCapabilityMatrix,
  resolveDelegationExecutionAuthority,
  runtimeProviderTools,
  type AgentCard,
  type DelegationDeps,
  type DelegationTask,
  type PlanDAG,
  type ResolvedWorkBinding,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  inspectNodeDurableDelegationRecovery,
  makeDurableDelegationRecoverableInterruption,
  makeNodeDurableDelegationRuntime,
  type DurableDelegationExecutionHandle,
  type DurableDelegationOperation,
  type DurableDelegationRecoverableInterruptionCode,
  type DurableDelegationVerification,
  type DurableDelegationRuntimeEvent,
} from './durable-delegation-runtime.js'
import { makeNodeDelegationPersistence } from './delegation-persistence.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-durable-delegation-')))
  roots.push(root)
  return join(root, 'run-a')
}

function operation<T>(result: Promise<T> | T): DurableDelegationOperation<T> {
  return { result: Promise.resolve(result), cancel: async () => {} }
}

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

const CARD: AgentCard = {
  name: 'reviewer',
  instructions: 'Verify the assigned result.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 0 },
  maxIterations: 5,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

const TASK: DelegationTask = {
  taskId: 'review',
  intent: 'review the exact Project result',
  assignedTo: CARD.name,
  dependsOn: [],
  scope: { owns: ['src/**'], doNotTouch: [], taskClass: 'reasoning' },
  budgetSlice: { iterations: 5, spendUsd: 0.5 },
  outputContract: 'verified summary',
  retryPolicy: { maxReplans: 0, maxIterations: 5 },
}

const PLAN: PlanDAG = { nodes: [TASK], edges: [] }
const COST = { iterations: 1, spendUsd: 0.1, wallMs: 25 }

function common(root: string) {
  return {
    runRoot: root,
    recoveryPolicy: 'resume-active-replay-terminal' as const,
    maxConcurrency: 2,
    binding: BINDING,
    plan: PLAN,
    resolveCard: (name: string) => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    readCost: async () => COST,
    isBindingActive: (binding: ResolvedWorkBinding) => binding.projectId === BINDING.projectId &&
      binding.sessionId === BINDING.sessionId,
  }
}

function managerDeps(root: string): DelegationDeps {
  return {
    binding: BINDING,
    resolveCard: name => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    emit: () => {},
    persistence: makeNodeDelegationPersistence({ runRoot: root }),
    isBindingActive: () => true,
  }
}

function inspection(root: string, plan: PlanDAG = PLAN) {
  return {
    runRoot: root,
    binding: BINDING,
    plan,
    resolveCard: (name: string) => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    isBindingActive: (binding: ResolvedWorkBinding) =>
      binding.projectId === BINDING.projectId && binding.sessionId === BINDING.sessionId,
  }
}

function persistCoreTerminal(
  root: string,
  terminal: { summary: string; result: unknown; cost: typeof COST },
): void {
  const manager = makeDelegationManager(PLAN, managerDeps(root))
  const handle = manager.spawn(TASK.taskId)
  handle.append('runtime.verified-result', {
    evidenceId: 'evidence-core-only',
    summary: terminal.summary,
    result: terminal.result,
    cost: terminal.cost,
  })
  handle.complete(terminal.summary, terminal.result, terminal.cost)
}

function recoveryTask(taskId: string): DelegationTask {
  return {
    ...TASK,
    taskId,
    scope: { ...TASK.scope, owns: [`src/${taskId}/**`] },
  }
}

function persistVerified(
  manager: ReturnType<typeof makeDelegationManager>,
  task: DelegationTask,
  cost: typeof COST,
): void {
  const handle = manager.spawn(task.taskId)
  const summary = `verified ${task.taskId}`
  const result = { taskId: task.taskId }
  handle.append('runtime.verified-result', {
    evidenceId: `evidence-${task.taskId}`,
    summary,
    result,
    cost,
  })
  handle.complete(summary, result, cost)
}

function overwriteRunBudget(root: string, cost: typeof COST): void {
  const path = join(root, 'run-state.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  state['runBudget'] = cost
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function overwriteRunBudgetSpendLiteral(root: string, literal: 'NaN' | '1e400'): void {
  const path = join(root, 'run-state.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    runBudget: { spendUsd: unknown }
  }
  state.runBudget.spendUsd = '__invalid_spend__'
  const encoded = JSON.stringify(state, null, 2).replace('"__invalid_spend__"', literal)
  writeFileSync(path, `${encoded}\n`, { mode: 0o600 })
}

describe('durable delegation production-preview runtime', () => {
  it('inspects only an existing exact run without handles, child ports or root creation', () => {
    const missing = runRoot()
    expect(existsSync(missing)).toBe(false)
    expect(() => inspectNodeDurableDelegationRecovery(inspection(missing))).toThrowError(
      expect.objectContaining({ code: 'DELEGATION_RECOVERY_DENIED' }),
    )
    expect(existsSync(missing)).toBe(false)

    const terminalRoot = runRoot()
    persistCoreTerminal(terminalRoot, {
      summary: 'terminal result', result: { ok: true }, cost: COST,
    })
    expect(inspectNodeDurableDelegationRecovery(inspection(terminalRoot))).toMatchObject({
      status: 'terminal',
      activeDelegationIds: [],
      terminalObservations: [{ delegationId: 'd-review', status: 'completed' }],
      runBudget: COST,
    })

    const activeRoot = runRoot()
    makeDelegationManager(PLAN, managerDeps(activeRoot)).spawn(TASK.taskId)
    expect(inspectNodeDurableDelegationRecovery(inspection(activeRoot))).toMatchObject({
      status: 'continuation',
      activeDelegationIds: ['d-review'],
      terminalObservations: [],
      runBudget: { iterations: 0, spendUsd: 0, wallMs: 0 },
    })
  })

  it('enforces the code-owned ceiling for real overlapping fresh work', async () => {
    const root = runRoot()
    const tasks = Array.from({ length: 5 }, (_value, index): DelegationTask => ({
      ...TASK,
      taskId: `parallel-${index}`,
      scope: { ...TASK.scope, owns: [`src/parallel-${index}/**`] },
    }))
    let active = 0
    let maximumActive = 0
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      maxConcurrency: 2,
      plan: { nodes: tasks, edges: [] },
      runTask: (_handle, task) => operation((async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>(resolve => setImmediate(resolve))
        active -= 1
        return { summary: `candidate ${task.taskId}`, result: { taskId: task.taskId } }
      })()),
      verify: ({ task }) => operation({
        verified: true,
        evidenceId: `evidence-${task.taskId}`,
        summary: `verified ${task.taskId}`,
        result: { taskId: task.taskId },
      }),
    })

    await expect(runtime.execute()).resolves.toHaveLength(tasks.length)
    expect(maximumActive).toBe(2)
  })

  it('serializes overlapping write scopes even when the ceiling permits concurrency', async () => {
    const root = runRoot()
    const tasks: DelegationTask[] = [
      { ...TASK, taskId: 'overlap-a', scope: { ...TASK.scope, owns: ['src/shared/**'] } },
      { ...TASK, taskId: 'overlap-b', scope: { ...TASK.scope, owns: ['src/shared/child/**'] } },
    ]
    let active = 0
    let maximumActive = 0
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      maxConcurrency: 2,
      plan: { nodes: tasks, edges: [] },
      runTask: (_handle, task) => operation((async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>(resolve => setImmediate(resolve))
        active -= 1
        return { summary: `candidate ${task.taskId}`, result: { taskId: task.taskId } }
      })()),
      verify: ({ task }) => operation({
        verified: true,
        evidenceId: `evidence-${task.taskId}`,
        summary: `verified ${task.taskId}`,
        result: { taskId: task.taskId },
      }),
    })

    await expect(runtime.execute()).resolves.toHaveLength(tasks.length)
    expect(maximumActive).toBe(1)
  })

  it('keeps recovered active work within the same code-owned ceiling', async () => {
    const root = runRoot()
    const tasks: DelegationTask[] = [
      { ...TASK, taskId: 'resume-a', scope: { ...TASK.scope, owns: ['src/resume-a/**'] } },
      {
        ...TASK,
        taskId: 'after-resume',
        dependsOn: ['resume-a'],
        scope: { ...TASK.scope, owns: ['src/after-resume/**'] },
      },
    ]
    const plan: PlanDAG = { nodes: tasks, edges: [{ from: 'resume-a', to: 'after-resume' }] }
    const beforeCrash = makeDelegationManager(plan, managerDeps(root))
    beforeCrash.spawn(tasks[0]!.taskId)

    let active = 0
    let maximumActive = 0
    const events: DurableDelegationRuntimeEvent[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      maxConcurrency: 1,
      plan,
      runTask: (_handle, task) => operation((async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>(resolve => setImmediate(resolve))
        active -= 1
        return { summary: `resumed ${task.taskId}`, result: { taskId: task.taskId } }
      })()),
      verify: ({ task }) => operation({
        verified: true,
        evidenceId: `evidence-${task.taskId}`,
        summary: `verified ${task.taskId}`,
        result: { taskId: task.taskId },
      }),
      emit: event => events.push(event),
    })

    await expect(restarted.execute()).resolves.toHaveLength(tasks.length)
    expect(maximumActive).toBe(1)
    expect(events.filter(event => event.kind === 'delegation.runtime.resumed')).toHaveLength(1)
  })

  it('atomically recovers two active handles, replays terminals, and keeps the ceiling', async () => {
    const root = runRoot()
    const terminal = recoveryTask('restart-terminal')
    const activeA = recoveryTask('restart-active-a')
    const activeB = recoveryTask('restart-active-b')
    const plan: PlanDAG = { nodes: [terminal, activeA, activeB], edges: [] }
    const beforeCrash = makeDelegationManager(plan, managerDeps(root))
    persistVerified(beforeCrash, terminal, { iterations: 1, spendUsd: 0.1, wallMs: 10 })
    beforeCrash.spawn(activeA.taskId)
    beforeCrash.spawn(activeB.taskId)

    let active = 0
    let maximumActive = 0
    const calls = new Map<string, number>()
    const runtimeEvents: DurableDelegationRuntimeEvent[] = []
    const orchestrationEvents: string[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      maxConcurrency: 1,
      plan,
      runTask: (_handle, task) => operation((async () => {
        calls.set(task.taskId, (calls.get(task.taskId) ?? 0) + 1)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>(resolve => setImmediate(resolve))
        active -= 1
        return { summary: `candidate ${task.taskId}`, result: { taskId: task.taskId } }
      })()),
      verify: ({ task }) => operation({
        verified: true,
        evidenceId: `evidence-${task.taskId}`,
        summary: `verified ${task.taskId}`,
        result: { taskId: task.taskId },
      }),
      emit: event => runtimeEvents.push(event),
      emitOrchestration: event => orchestrationEvents.push(event.kind),
    })

    await expect(restarted.execute()).resolves.toHaveLength(3)
    expect(maximumActive).toBe(1)
    expect([...calls.entries()].sort()).toEqual([
      [activeA.taskId, 1],
      [activeB.taskId, 1],
    ])
    expect(runtimeEvents.filter(event => event.kind === 'delegation.runtime.resumed')).toHaveLength(2)
    expect(runtimeEvents.filter(event => event.kind === 'delegation.runtime.replayed')).toHaveLength(1)
    expect(orchestrationEvents).not.toContain('delegation.quarantined')
  })

  it('exposes no recovered handle or recovery event when one active sibling is corrupt', async () => {
    const root = runRoot()
    const activeA = recoveryTask('atomic-active-a')
    const activeB = recoveryTask('atomic-active-b')
    const plan: PlanDAG = { nodes: [activeA, activeB], edges: [] }
    const beforeCrash = makeDelegationManager(plan, managerDeps(root))
    beforeCrash.spawn(activeA.taskId)
    beforeCrash.spawn(activeB.taskId)
    const checkpointPath = join(root, 'delegations', `d-${activeB.taskId}`, 'checkpoint.json')
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    checkpoint.lastSeq = 1
    writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 })

    let childCalls = 0
    const runtimeEvents: DurableDelegationRuntimeEvent[] = []
    const orchestrationEvents: string[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not expose either recovered handle')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
      emit: event => runtimeEvents.push(event),
      emitOrchestration: event => orchestrationEvents.push(event.kind),
    })

    await expect(restarted.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
    expect(childCalls).toBe(0)
    expect(runtimeEvents.map(event => event.kind)).toEqual(['delegation.runtime.started'])
    expect(orchestrationEvents).not.toContain('delegation.quarantined')
  })

  it('preflights Core-invalid terminal state without quarantine or active authority', async () => {
    const root = runRoot()
    const terminal = recoveryTask('core-invalid-terminal')
    const active = recoveryTask('authority-must-not-issue')
    const plan: PlanDAG = { nodes: [terminal, active], edges: [] }
    const beforeCrash = makeDelegationManager(plan, managerDeps(root))
    persistVerified(beforeCrash, terminal, { iterations: 1, spendUsd: 0.1, wallMs: 10 })
    beforeCrash.spawn(active.taskId)
    const manifestPath = join(root, 'delegations', `d-${terminal.taskId}`, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.state.binding.projectId = 'forged-project'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })

    let childCalls = 0
    const runtimeEvents: DurableDelegationRuntimeEvent[] = []
    const orchestrationEvents: string[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('active authority must not be issued')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
      emit: event => runtimeEvents.push(event),
      emitOrchestration: event => orchestrationEvents.push(event.kind),
    })

    await expect(restarted.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
    expect(childCalls).toBe(0)
    expect(runtimeEvents.map(event => event.kind)).toEqual(['delegation.runtime.started'])
    expect(orchestrationEvents).not.toContain('delegation.quarantined')
  })

  it('replays a cost that is raw-above its cap but equal in canonical nanos', async () => {
    const root = runRoot()
    const task: DelegationTask = {
      ...recoveryTask('canonical-cap-replay'),
      budgetSlice: { iterations: 5, spendUsd: 5e-10 },
    }
    const plan: PlanDAG = { nodes: [task], edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    persistVerified(manager, task, { iterations: 1, spendUsd: 5.4e-10, wallMs: 10 })

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('canonical terminal must replay')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })

    await expect(restarted.execute()).resolves.toEqual([
      expect.objectContaining({ cost: { iterations: 1, spendUsd: 1e-9, wallMs: 10 } }),
    ])
    expect(childCalls).toBe(0)
  })

  it('preflights aggregate terminal cost above the ledger before recovery events or child I/O', async () => {
    const root = runRoot()
    const terminalA = recoveryTask('terminal-a')
    const terminalB = recoveryTask('terminal-b')
    const active = recoveryTask('active-after-corruption')
    const plan: PlanDAG = { nodes: [terminalA, terminalB, active], edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    persistVerified(manager, terminalA, { iterations: 2, spendUsd: 0, wallMs: 20 })
    persistVerified(manager, terminalB, { iterations: 2, spendUsd: 0, wallMs: 20 })
    manager.spawn(active.taskId)
    // Each terminal observation still fits this forged ledger individually;
    // only the aggregate pre-I/O check can reject 2 + 2 > 3.
    overwriteRunBudget(root, { iterations: 3, spendUsd: 0, wallMs: 30 })

    let childCalls = 0
    const events: DurableDelegationRuntimeEvent[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not reach provider/tool I/O')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
      emit: event => events.push(event),
    })

    await expect(restarted.execute()).rejects.toMatchObject({
      code: 'DELEGATION_RECOVERY_DENIED',
    })
    expect(childCalls).toBe(0)
    expect(events.map(event => event.kind)).toEqual(['delegation.runtime.started'])
  })

  it('rejects an aggregate terminal cost below the persisted ledger before resumed child I/O', async () => {
    const root = runRoot()
    const terminalA = recoveryTask('below-a')
    const terminalB = recoveryTask('below-b')
    const active = recoveryTask('active-after-underflow')
    const plan: PlanDAG = { nodes: [terminalA, terminalB, active], edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    persistVerified(manager, terminalA, { iterations: 1, spendUsd: 0, wallMs: 10 })
    persistVerified(manager, terminalB, { iterations: 1, spendUsd: 0, wallMs: 10 })
    manager.spawn(active.taskId)
    overwriteRunBudget(root, { iterations: 3, spendUsd: 0, wallMs: 30 })

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not reach provider/tool I/O')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })

    await expect(restarted.execute()).rejects.toMatchObject({
      code: 'DELEGATION_RECOVERY_DENIED',
    })
    expect(childCalls).toBe(0)
  })

  it('accepts terminal observations whose aggregate exactly equals the persisted ledger', async () => {
    const root = runRoot()
    const terminalA = recoveryTask('exact-a')
    const terminalB = recoveryTask('exact-b')
    const plan: PlanDAG = { nodes: [terminalA, terminalB], edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    persistVerified(manager, terminalA, { iterations: 1, spendUsd: 0, wallMs: 10 })
    persistVerified(manager, terminalB, { iterations: 2, spendUsd: 0, wallMs: 20 })

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('terminal work must replay')))
      },
      verify: () => operation(Promise.reject(new Error('terminal work must not verify'))),
    })

    await expect(restarted.execute()).resolves.toEqual([
      expect.objectContaining({ delegationId: 'd-exact-a', status: 'completed' }),
      expect.objectContaining({ delegationId: 'd-exact-b', status: 'completed' }),
    ])
    expect(childCalls).toBe(0)
  })

  it.each([
    ['forward plan / reverse completion', [0.1, 0.2, 0.3], [2, 1, 0]],
    ['reverse plan / forward completion', [0.3, 0.2, 0.1], [0, 1, 2]],
  ] as const)(
    'accepts semantically exact 0.1/0.2/0.3 money with %s',
    async (_ordering, spendValues, completionOrder) => {
      const root = runRoot()
      const tasks = spendValues.map((_spend, index) => recoveryTask(`money-${index}`))
      const plan: PlanDAG = { nodes: tasks, edges: [] }
      const manager = makeDelegationManager(plan, managerDeps(root))
      completionOrder.forEach(index => {
        const task = tasks[index]!
        persistVerified(manager, task, {
          iterations: 0,
          spendUsd: spendValues[index]!,
          wallMs: 0,
        })
      })

      let childCalls = 0
      const restarted = makeNodeDurableDelegationRuntime({
        ...common(root),
        plan,
        runTask: () => {
          childCalls += 1
          return operation(Promise.reject(new Error('terminal work must replay')))
        },
        verify: () => operation(Promise.reject(new Error('terminal work must not verify'))),
      })

      await expect(restarted.execute()).resolves.toHaveLength(3)
      expect(childCalls).toBe(0)
    },
  )

  it.each([
    ['2 x 4e-10 rounds each charge to zero nanos', 4e-10, 0],
    ['2 x 6e-10 rounds each charge to one nano', 6e-10, 2e-9],
  ] as const)('replays honest restart ledger when %s', async (_case, spendUsd, ledgerUsd) => {
    const root = runRoot()
    const tasks = [recoveryTask('nano-a'), recoveryTask('nano-b')]
    const plan: PlanDAG = { nodes: tasks, edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    tasks.forEach(task => {
      persistVerified(manager, task, { iterations: 0, spendUsd, wallMs: 0 })
    })
    expect(JSON.parse(readFileSync(join(root, 'run-state.json'), 'utf8')).runBudget.spendUsd)
      .toBe(ledgerUsd)

    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => operation(Promise.reject(new Error('terminal work must replay'))),
      verify: () => operation(Promise.reject(new Error('terminal work must not verify'))),
    })
    await expect(restarted.execute()).resolves.toHaveLength(2)
  })

  it('refuses a MAX_SAFE_INTEGER aggregate overflow without committing terminal state', () => {
    const root = runRoot()
    const hugeCard: AgentCard = { ...CARD, maxIterations: Number.MAX_SAFE_INTEGER }
    const hugeTask = (taskId: string): DelegationTask => ({
      ...recoveryTask(taskId),
      budgetSlice: { iterations: Number.MAX_SAFE_INTEGER, spendUsd: 0 },
      retryPolicy: { maxReplans: 0, maxIterations: Number.MAX_SAFE_INTEGER },
    })
    const terminalA = hugeTask('overflow-a')
    const terminalB = hugeTask('overflow-b')
    const plan: PlanDAG = { nodes: [terminalA, terminalB], edges: [] }
    const manager = makeDelegationManager(plan, {
      ...managerDeps(root),
      resolveCard: name => name === hugeCard.name ? hugeCard : undefined,
    })
    persistVerified(manager, terminalA, {
      iterations: Number.MAX_SAFE_INTEGER,
      spendUsd: 0,
      wallMs: 0,
    })
    const overflow = manager.spawn(terminalB.taskId)
    const cost = { iterations: 1, spendUsd: 0, wallMs: 0 }
    overflow.append('runtime.verified-result', {
      evidenceId: 'evidence-overflow-b',
      summary: 'verified overflow-b',
      result: { taskId: terminalB.taskId },
      cost,
    })
    expect(() => overflow.complete('verified overflow-b', { taskId: terminalB.taskId }, cost))
      .toThrow(/invalid delegation cost/)

    const runState = JSON.parse(readFileSync(join(root, 'run-state.json'), 'utf8'))
    expect(runState.runBudget).toEqual({
      iterations: Number.MAX_SAFE_INTEGER,
      spendUsd: 0,
      wallMs: 0,
    })
    expect(runState.completedTaskIds).toEqual([terminalA.taskId])
    expect(runState.activeTaskIds).toEqual([terminalB.taskId])
    const manifest = JSON.parse(readFileSync(
      join(root, 'delegations', `d-${terminalB.taskId}`, 'manifest.json'),
      'utf8',
    ))
    expect(manifest.state.status).toBe('active')
    expect(manifest.state.terminalObservation).toBeUndefined()
  })

  it.each([
    ['NaN', 'NaN'],
    ['Infinity', '1e400'],
  ] as const)('rejects %s persisted money before child I/O', async (_label, literal) => {
    const root = runRoot()
    const terminal = recoveryTask(`invalid-money-${_label.toLowerCase()}`)
    const plan: PlanDAG = { nodes: [terminal], edges: [] }
    const manager = makeDelegationManager(plan, managerDeps(root))
    persistVerified(manager, terminal, { iterations: 1, spendUsd: 0.1, wallMs: 10 })
    overwriteRunBudgetSpendLiteral(root, literal)

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan,
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not run with invalid money')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    await expect(restarted.execute()).rejects.toMatchObject({
      code: 'DELEGATION_RECOVERY_DENIED',
    })
    expect(childCalls).toBe(0)
  })

  it.each([
    ['behind', { iterations: 2, spendUsd: 0, wallMs: 20 }],
    ['ahead', { iterations: 4, spendUsd: 0.2, wallMs: 60 }],
  ] as const)(
    'fails closed when persisted ledger drifts %s after a newly resumed terminal result',
    async (_direction, driftedCost) => {
      const root = runRoot()
      const terminal = recoveryTask('prior-terminal')
      const active = recoveryTask('resumed-ledger-drift')
      const plan: PlanDAG = { nodes: [terminal, active], edges: [] }
      const manager = makeDelegationManager(plan, managerDeps(root))
      const priorCost = { iterations: 2, spendUsd: 0, wallMs: 20 }
      persistVerified(manager, terminal, priorCost)
      manager.spawn(active.taskId)

      let childCalls = 0
      const events: DurableDelegationRuntimeEvent[] = []
      const restarted = makeNodeDurableDelegationRuntime({
        ...common(root),
        plan,
        runTask: (_handle, task) => {
          childCalls += 1
          return operation({ summary: `candidate ${task.taskId}`, result: { taskId: task.taskId } })
        },
        verify: ({ task }) => operation({
          verified: true,
          evidenceId: `evidence-${task.taskId}`,
          summary: `verified ${task.taskId}`,
          result: { taskId: task.taskId },
        }),
        emit: event => events.push(event),
        emitOrchestration: event => {
          if (event.kind === 'delegation.completed') {
            overwriteRunBudget(root, driftedCost)
          }
        },
      })

      await expect(restarted.execute()).rejects.toMatchObject({
        code: 'DELEGATION_RECOVERY_DENIED',
      })
      expect(childCalls).toBe(1)
      expect(events.map(event => event.kind)).not.toContain('delegation.runtime.completed')
    },
  )

  it('fails closed without a completed event when the bounded schedule is interrupted', async () => {
    const root = runRoot()
    const events: DurableDelegationRuntimeEvent[] = []
    let childCalls = 0
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not start after cancellation')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
      emit: event => events.push(event),
    })
    runtime.cancel()

    await expect(runtime.execute()).rejects.toMatchObject({
      code: 'DELEGATION_PERSISTENCE_FAILED',
    })
    expect(childCalls).toBe(0)
    expect(events.map(event => event.kind)).toEqual(['delegation.runtime.started'])
  })

  it.each([0, -1, 65, 1.5, Number.NaN])(
    'rejects invalid code-owned concurrency ceiling %s before child I/O',
    maxConcurrency => {
      expect(() => makeNodeDurableDelegationRuntime({
        ...common(runRoot()),
        maxConcurrency,
        runTask: () => operation(Promise.reject(new Error('must not run'))),
        verify: () => operation(Promise.reject(new Error('must not verify'))),
      })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))
    },
  )

  it('provides a narrow manager authority journal that seals before provider I/O and replays', async () => {
    const root = runRoot()
    const order: string[] = []
    let reservedKindRejected = false
    const boundCard: AgentCard = { ...CARD, toolTiers: { read_file: 1 } }
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      resolveCard: name => name === CARD.name ? boundCard : undefined,
      runTask: (handle, task) => operation((async () => {
        try {
          handle.append('runtime.agent-authority.v1', { forged: true })
        } catch {
          reservedKindRejected = true
        }
        const readFileTool = runtimeProviderTools().find(tool => tool.name === 'read_file')!
        const matrix = resolveChildAgentCapabilityMatrix({
          card: handle.card,
          toolCatalog: [readFileTool],
          activeSkills: new Set(),
          activeMcpServers: new Set(),
        })
        const authority = resolveDelegationExecutionAuthority({
          handle,
          task,
          matrix,
          maxConcurrency: 2,
        })
        order.push('seal')
        handle.authorityJournal.appendAuthoritySeal(authority.authorityHash)
        const runner = makeBoundSubAgentRunner({
          authority,
          authorityJournal: handle.authorityJournal,
          permitsTool: handle.permitsTool,
          providerFactory: () => {
            order.push('provider')
            return { async complete() { return { reply: 'bound child completed' } } }
          },
          baseExecuteTool: async () => ({ ok: true, output: '' }),
          approve: async () => ({ decision: 'rejected' }),
          memory: {
            snapshot: async () => ({
              prefixBytes: new Uint8Array(0), prefixHash: 'h', breakpoints: [],
              takenAt: '2026-08-09T00:00:00.000Z',
            }),
            forget: async () => {},
          },
          sessionLog: { append() {}, resume: () => null },
          parentNarrowed: false,
          budgetCheck: () => false,
        })
        expect(order).toEqual(['seal'])
        expect(handle.authorityJournal.verifyShardChain()).toBe(true)
        expect(handle.authorityJournal.shard()[0]).toMatchObject({
          kind: 'runtime.agent-authority.v1',
          payload: { schemaVersion: 1, authorityHash: authority.authorityHash },
        })
        const result = await runner.handle({
          sessionId: handle.delegationId,
          spans: [{ role: 'user', provenance: 'operator', text: 'perform exact task' }],
        })
        return { summary: result.reply, result: { state: result.state } }
      })()),
      verify: ({ candidate }) => operation({
        verified: true,
        evidenceId: 'evidence-bound-child',
        summary: candidate.summary,
        result: candidate.result,
      }),
    })
    const completed = await runtime.execute()
    expect(completed).toEqual([expect.objectContaining({
      status: 'completed', summary: 'bound child completed',
    })])
    expect(reservedKindRejected).toBe(true)
    expect(order).toEqual(['seal', 'provider'])

    let restartedChildCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      resolveCard: name => name === CARD.name ? boundCard : undefined,
      runTask: () => {
        restartedChildCalls += 1
        return operation(Promise.reject(new Error('terminal child must replay')))
      },
      verify: () => operation(Promise.reject(new Error('terminal verifier must replay'))),
    })
    await expect(restarted.execute()).resolves.toEqual(completed)
    expect(restartedChildCalls).toBe(0)
  })

  it('persists a verified compact result and replays it after restart without child I/O', async () => {
    const root = runRoot()
    const firstEvents: DurableDelegationRuntimeEvent[] = []
    const first = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true,
        evidenceId: 'evidence-1',
        summary: 'verified summary',
        result: { verified: true },
      }),
      emit: event => firstEvents.push(event),
    })
    const completed = await first.execute()
    expect(completed).toEqual([expect.objectContaining({
      delegationId: 'd-review',
      status: 'completed',
      summary: 'verified summary',
      result: { verified: true },
      cost: COST,
    })])
    expect(firstEvents.map(event => event.kind)).toContain('delegation.runtime.verified')

    let childCalls = 0
    let verifierCalls = 0
    const restartedEvents: DurableDelegationRuntimeEvent[] = []
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not run')))
      },
      verify: () => {
        verifierCalls += 1
        return operation(Promise.reject(new Error('must not verify')))
      },
      emit: event => restartedEvents.push(event),
    })
    await expect(restarted.execute()).resolves.toEqual(completed)
    expect(childCalls).toBe(0)
    expect(verifierCalls).toBe(0)
    expect(restartedEvents.map(event => event.kind)).toContain('delegation.runtime.replayed')
  })

  it('refuses a changed semantic plan at the same durable run root before child I/O', async () => {
    const root = runRoot()
    const first = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true,
        evidenceId: 'evidence-original',
        summary: 'verified original',
        result: { verified: true },
      }),
    })
    await first.execute()

    let childCalls = 0
    const changedTask: DelegationTask = { ...TASK, intent: 'different work after restart' }
    const changed = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan: { nodes: [changedTask], edges: [] },
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not execute changed work')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify changed work'))),
    })

    await expect(changed.execute()).rejects.toMatchObject({
      code: 'DELEGATION_RECOVERY_DENIED',
    })
    expect(childCalls).toBe(0)
  })

  it('finalizes a durable verified-result draft after a crash without rerunning the child', async () => {
    const root = runRoot()
    const beforeCrash = makeDelegationManager(PLAN, managerDeps(root))
    const handle = beforeCrash.spawn(TASK.taskId)
    handle.append('runtime.verified-result', {
      evidenceId: 'evidence-before-crash',
      summary: 'durable verified result',
      result: { proof: 7 },
      cost: COST,
    })

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not rerun after durable verification')))
      },
      verify: () => operation(Promise.reject(new Error('must not reverify'))),
    })
    await expect(restarted.execute()).resolves.toEqual([expect.objectContaining({
      status: 'completed',
      summary: 'durable verified result',
      result: { proof: 7 },
      cost: COST,
    })])
    expect(childCalls).toBe(0)

    const afterSecondRestart = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation(Promise.reject(new Error('must replay terminal state'))),
      verify: () => operation(Promise.reject(new Error('must replay terminal state'))),
    })
    await expect(afterSecondRestart.execute()).resolves.toEqual([expect.objectContaining({
      status: 'completed', summary: 'durable verified result', cost: COST,
    })])
  })

  it('cancels an active child, persists a code-only terminal result and replays it', async () => {
    const root = runRoot()
    let started!: () => void
    const childStarted = new Promise<void>(resolve => { started = resolve })
    let verifierCalls = 0
    const events: DurableDelegationRuntimeEvent[] = []
    let stopChild!: () => void
    const childResult = new Promise<never>((_resolve, reject) => {
      stopChild = () => reject(new Error('private child failure'))
    })
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async () => ({ iterations: 0, spendUsd: 0, wallMs: 0 }),
      runTask: () => {
        started()
        return {
          result: childResult,
          cancel: async () => {
            stopChild()
            await childResult.catch(() => undefined)
          },
        }
      },
      verify: () => {
        verifierCalls += 1
        return operation({ verified: false, reasonCode: 'EVIDENCE_MISSING' })
      },
      emit: event => events.push(event),
    })
    const execution = runtime.execute()
    await childStarted
    runtime.cancel()
    const cancelled = await execution
    expect(cancelled).toEqual([expect.objectContaining({
      status: 'failed', summary: 'CANCELLED', result: undefined, cost: {
        iterations: 0, spendUsd: 0, wallMs: 0,
      },
    })])
    expect(verifierCalls).toBe(0)
    expect(JSON.stringify(events)).not.toContain('private child failure')

    let restartedCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        restartedCalls += 1
        return operation(Promise.reject(new Error('must not rerun cancelled terminal state')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    await expect(restarted.execute()).resolves.toEqual(cancelled)
    expect(restartedCalls).toBe(0)
  })

  it('fails unverified or over-budget child output closed without returning raw result', async () => {
    const unverifiedRoot = runRoot()
    const unverifiedEvents: DurableDelegationRuntimeEvent[] = []
    const unverified = makeNodeDurableDelegationRuntime({
      ...common(unverifiedRoot),
      runTask: () => operation({
        summary: 'candidate', result: { private: 'raw-child-result' },
      }),
      verify: () => operation({ verified: false, reasonCode: 'POSTCONDITION_FAILED' }),
      emit: event => unverifiedEvents.push(event),
    })
    const denied = await unverified.execute()
    expect(denied).toEqual([expect.objectContaining({
      status: 'failed', summary: 'UNVERIFIED_RESULT', result: undefined, cost: COST,
    })])
    expect(JSON.stringify(denied)).not.toContain('raw-child-result')
    expect(unverifiedEvents.map(event => event.kind)).not.toContain('delegation.runtime.completed')

    const overBudgetRoot = runRoot()
    let verifierCalls = 0
    const overBudget = makeNodeDurableDelegationRuntime({
      ...common(overBudgetRoot),
      readCost: async () => ({ iterations: 6, spendUsd: 0.1, wallMs: 25 }),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => {
        verifierCalls += 1
        return operation({ verified: true, evidenceId: 'never', summary: 'never', result: null })
      },
    })
    await expect(overBudget.execute()).resolves.toEqual([expect.objectContaining({
      status: 'failed', summary: 'TASK_BUDGET_EXCEEDED', result: undefined,
    })])
    expect(verifierCalls).toBe(0)
  })

  it('withholds terminal authority and reserved runtime shard kinds from the child', async () => {
    const root = runRoot()
    let reservedKindRejected = false
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: (handle) => operation((() => {
          expect('complete' in handle).toBe(false)
          expect('fail' in handle).toBe(false)
          try {
            handle.append('runtime.verified-result', { forged: true })
          } catch {
            reservedKindRejected = true
          }
          handle.append('candidate.evidence', { id: 'child-evidence' })
          return { summary: 'candidate', result: { raw: true } }
        })()),
      verify: ({ shard }) => {
        expect(shard.some(entry => entry.kind === 'candidate.evidence')).toBe(true)
        return operation({
          verified: true,
          evidenceId: 'evidence-authority',
          summary: 'verified by parent-owned verifier',
          result: { verified: true },
        })
      },
    })

    await expect(runtime.execute()).resolves.toEqual([expect.objectContaining({
      status: 'completed', summary: 'verified by parent-owned verifier',
    })])
    expect(reservedKindRejected).toBe(true)
  })

  it('requires acknowledged cancellation and keeps unconfirmed work non-terminal', async () => {
    const root = runRoot()
    let started!: () => void
    const childStarted = new Promise<void>(resolve => { started = resolve })
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async () => ({ iterations: 0, spendUsd: 0, wallMs: 0 }),
      runTask: () => {
        started()
        return {
          result: new Promise(() => {}),
          cancel: async () => { throw new Error('process still running') },
        }
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    const execution = runtime.execute()
    await childStarted
    runtime.cancel()
    await expect(execution).rejects.toMatchObject({
      code: 'DELEGATION_CANCELLATION_UNCONFIRMED',
    })
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('active')
    const competing = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    await expect(competing.execute()).rejects.toMatchObject({ code: 'DELEGATION_RUN_LOCK_HELD' })
  })

  it.each<DurableDelegationRecoverableInterruptionCode>([
    'DELEGATION_OPERATION_AMBIGUOUS',
    'DELEGATION_MANUAL_RECOVERY_REQUIRED',
  ])('keeps a factory-issued %s interruption active across fresh and resumed work', async code => {
    const root = runRoot()
    const events: DurableDelegationRuntimeEvent[] = []
    let verifierCalls = 0
    const interrupted = makeNodeDurableDelegationRuntime({
      ...common(root),
      emit: event => events.push(event),
      runTask: () => operation(Promise.reject(
        makeDurableDelegationRecoverableInterruption(code),
      )),
      verify: () => {
        verifierCalls += 1
        return operation(Promise.reject(new Error('must not verify an ambiguous operation')))
      },
    })

    await expect(interrupted.execute()).rejects.toMatchObject({ code })
    expect(verifierCalls).toBe(0)
    expect(events.map(event => event.kind)).not.toEqual(expect.arrayContaining([
      'delegation.runtime.verified',
      'delegation.runtime.denied',
      'delegation.runtime.cancelled',
      'delegation.runtime.completed',
    ]))
    const runState = JSON.parse(readFileSync(join(root, 'run-state.json'), 'utf8'))
    expect(runState).toMatchObject({
      activeTaskIds: [TASK.taskId],
      completedTaskIds: [],
      failedTaskIds: [],
    })
    const interruptedManifest = JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    ))
    expect(interruptedManifest.state.status).toBe('active')
    expect(interruptedManifest.state).not.toHaveProperty('terminalObservation')

    const resumedEvents: DurableDelegationRuntimeEvent[] = []
    let resumedVerifierCalls = 0
    const resumedInterruption = makeNodeDurableDelegationRuntime({
      ...common(root),
      emit: event => resumedEvents.push(event),
      runTask: () => operation(Promise.reject(
        makeDurableDelegationRecoverableInterruption(code),
      )),
      verify: () => {
        resumedVerifierCalls += 1
        return operation(Promise.reject(new Error('must not verify resumed ambiguous work')))
      },
    })

    await expect(resumedInterruption.execute()).rejects.toMatchObject({ code })
    expect(resumedVerifierCalls).toBe(0)
    expect(resumedEvents.map(event => event.kind)).toContain('delegation.runtime.resumed')
    expect(resumedEvents.map(event => event.kind)).not.toEqual(expect.arrayContaining([
      'delegation.runtime.verified',
      'delegation.runtime.denied',
      'delegation.runtime.cancelled',
      'delegation.runtime.completed',
    ]))
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('active')

    let resumedCalls = 0
    const recovered = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        resumedCalls += 1
        return operation({ summary: 'candidate after recovery', result: { recovered: true } })
      },
      verify: () => operation({
        verified: true,
        evidenceId: 'evidence-after-recovery',
        summary: 'verified after recovery',
        result: { recovered: true },
      }),
    })

    await expect(recovered.execute()).resolves.toEqual([expect.objectContaining({
      status: 'completed',
      summary: 'verified after recovery',
      result: { recovered: true },
    })])
    expect(resumedCalls).toBe(1)
  })

  it('does not grant recoverable control authority to a structural copy', async () => {
    const root = runRoot()
    const issued = makeDurableDelegationRecoverableInterruption(
      'DELEGATION_OPERATION_AMBIGUOUS',
    )
    let verifierCalls = 0
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation(Promise.reject({ ...issued })),
      verify: () => {
        verifierCalls += 1
        return operation(Promise.reject(new Error('must not verify a failed child')))
      },
    })

    await expect(runtime.execute()).resolves.toEqual([expect.objectContaining({
      status: 'failed',
      summary: 'TASK_EXECUTION_FAILED',
    })])
    expect(verifierCalls).toBe(0)
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('failed')
  })

  it('revokes child append after candidate and rejects malformed verifier truthiness', async () => {
    const root = runRoot()
    let lateAppendRejected = false
    let childTaskId: string | undefined
    let executionHandle!: DurableDelegationExecutionHandle
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: handle => {
        executionHandle = handle
        childTaskId = handle.taskId
        return operation({ summary: 'candidate', result: { raw: true } })
      },
      verify: () => {
        expect(childTaskId).toBe(TASK.taskId)
        try { executionHandle.append('late.evidence', { forged: true }) } catch {
          lateAppendRejected = true
        }
        expect(executionHandle.permitsTool('read_file')).toBe(false)
        expect(executionHandle.permitsMcp('tracker')).toBe(false)
        expect(() => executionHandle.guardian).toThrow(/authority revoked/)
        return operation({
          verified: 'false',
          evidenceId: 'forged',
          summary: 'must not pass',
          result: { forged: true },
        } as unknown as DurableDelegationVerification)
      },
    })
    await expect(runtime.execute()).resolves.toEqual([expect.objectContaining({
      status: 'failed', summary: 'VERIFICATION_FAILED', result: undefined,
    })])
    expect(lateAppendRejected).toBe(true)
  })

  it('waits for cancellation acknowledgement even when the child rejects first', async () => {
    const root = runRoot()
    let releaseCancel!: () => void
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve })
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async () => ({ iterations: 0, spendUsd: 0, wallMs: 0 }),
      runTask: (_handle, _task, signal) => ({
        result: new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stopped early')), { once: true })
        }),
        cancel: () => cancelGate,
      }),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    const execution = runtime.execute()
    runtime.cancel()
    const early = await Promise.race([
      execution.then(() => 'settled', () => 'settled'),
      new Promise<'waiting'>(resolve => setImmediate(() => resolve('waiting'))),
    ])
    expect(early).toBe('waiting')
    releaseCancel()
    await expect(execution).resolves.toEqual([expect.objectContaining({
      status: 'failed', summary: 'CANCELLED',
    })])
  })

  it('accepts raw float ordering inside one nano and persists only canonical cost', async () => {
    const root = runRoot()
    const task: DelegationTask = {
      ...TASK,
      budgetSlice: { ...TASK.budgetSlice, spendUsd: 0.3 },
    }
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan: { nodes: [task], edges: [] },
      readCost: async ({ phase }) => ({
        iterations: 1,
        spendUsd: phase === 'child' ? 0.30000000000000004 : 0.3,
        wallMs: 25,
      }),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true,
        evidenceId: 'canonical-float-evidence',
        summary: 'canonical float result',
        result: { ok: true },
      }),
    })

    await expect(runtime.execute()).resolves.toEqual([
      expect.objectContaining({
        status: 'completed',
        cost: { iterations: 1, spendUsd: 0.3, wallMs: 25 },
      }),
    ])
    const manifest = JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    ))
    expect(manifest.state.terminalObservation.cost.spendUsd).toBe(0.3)
    const shard = readFileSync(join(root, 'delegations', 'd-review.jsonl'), 'utf8')
      .trimEnd().split('\n').map(line => JSON.parse(line))
    expect(shard.at(-1).payload.cost.spendUsd).toBe(0.3)
  })

  it('rejects a cumulative spend decrease of one canonical nano', async () => {
    const root = runRoot()
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async ({ phase }) => ({
        iterations: 1,
        spendUsd: phase === 'child' ? 0.300000002 : 0.300000001,
        wallMs: 25,
      }),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true,
        evidenceId: 'decreasing-nano-evidence',
        summary: 'must not commit',
        result: { ok: true },
      }),
    })

    await expect(runtime.execute()).rejects.toMatchObject({
      code: 'DELEGATION_BUDGET_METER_FAILED',
    })
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('active')
  })

  it('rejects a decreasing cumulative cost meter without committing terminal state', async () => {
    const root = runRoot()
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async ({ phase }) => phase === 'child'
        ? COST
        : { iterations: 0, spendUsd: 0, wallMs: 0 },
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true, evidenceId: 'evidence', summary: 'verified', result: { ok: true },
      }),
    })
    await expect(runtime.execute()).rejects.toMatchObject({ code: 'DELEGATION_BUDGET_METER_FAILED' })
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('active')

    const verifierFailureRoot = runRoot()
    const verifierFailure = makeNodeDurableDelegationRuntime({
      ...common(verifierFailureRoot),
      readCost: async ({ phase }) => phase === 'child'
        ? COST
        : { iterations: 0, spendUsd: 0, wallMs: 0 },
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation(Promise.reject(new Error('verifier failed'))),
    })
    await expect(verifierFailure.execute()).rejects.toMatchObject({
      code: 'DELEGATION_BUDGET_METER_FAILED',
    })
  })

  it('rejects a decreasing cumulative verifier cost after acknowledged cancellation', async () => {
    const root = runRoot()
    let verifierStarted!: () => void
    const started = new Promise<void>(resolve => { verifierStarted = resolve })
    let stopVerifier!: () => void
    const verifierResult = new Promise<never>((_resolve, reject) => {
      stopVerifier = () => reject(new Error('stopped'))
    })
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async ({ phase }) => phase === 'child'
        ? COST
        : { iterations: 0, spendUsd: 0, wallMs: 0 },
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => {
        verifierStarted()
        return {
          result: verifierResult,
          cancel: async () => {
            stopVerifier()
            await verifierResult.catch(() => undefined)
          },
        }
      },
    })
    const execution = runtime.execute()
    await started
    runtime.cancel()
    await expect(execution).rejects.toMatchObject({ code: 'DELEGATION_BUDGET_METER_FAILED' })
    expect(JSON.parse(readFileSync(
      join(root, 'delegations', 'd-review', 'manifest.json'),
      'utf8',
    )).state.status).toBe('active')
  })

  it('rejects a terminal observation that does not match its verifier-owned draft', async () => {
    const root = runRoot()
    const first = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true, evidenceId: 'evidence', summary: 'verified', result: { ok: true },
      }),
    })
    await first.execute()
    const manifestPath = join(root, 'delegations', 'd-review', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.state.terminalObservation.result = { forged: true }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })

    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    await expect(restarted.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
  })

  it('applies live summary, result and cumulative-cost caps to recovered terminal observations', async () => {
    const cases = [
      {
        summary: 'valid summary',
        result: { text: 'x'.repeat(70 * 1024) },
        cost: COST,
      },
      {
        summary: 'invalid\0summary',
        result: { ok: true },
        cost: COST,
      },
      {
        summary: 'valid summary',
        result: { ok: true },
        cost: { ...COST, wallMs: 24 * 60 * 60 * 1000 + 1 },
      },
    ]

    for (const terminal of cases) {
      const root = runRoot()
      persistCoreTerminal(root, terminal)
      let childCalls = 0
      let verifierCalls = 0
      const restarted = makeNodeDurableDelegationRuntime({
        ...common(root),
        runTask: () => {
          childCalls += 1
          return operation(Promise.reject(new Error('must not rerun invalid terminal state')))
        },
        verify: () => {
          verifierCalls += 1
          return operation(Promise.reject(new Error('must not verify invalid terminal state')))
        },
      })
      await expect(restarted.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
      expect(childCalls).toBe(0)
      expect(verifierCalls).toBe(0)
    }
  })

  it('does not respawn a task referenced by run-state when its child snapshot is missing', async () => {
    const root = runRoot()
    const first = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation({ summary: 'candidate', result: { raw: true } }),
      verify: () => operation({
        verified: true, evidenceId: 'evidence', summary: 'verified', result: { ok: true },
      }),
    })
    await first.execute()
    unlinkSync(join(root, 'delegations', 'd-review.jsonl'))
    unlinkSync(join(root, 'delegations', 'd-review', 'checkpoint.json'))
    unlinkSync(join(root, 'delegations', 'd-review', 'manifest.json'))

    let childCalls = 0
    const restarted = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => {
        childCalls += 1
        return operation(Promise.reject(new Error('must not rerun')))
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    await expect(restarted.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
    expect(childCalls).toBe(0)
  })

  it.each([
    ['non-string id', { activeTaskIds: [7], completedTaskIds: [], failedTaskIds: [], skippedTaskIds: [] }],
    ['duplicate id', { activeTaskIds: ['ghost', 'ghost'], completedTaskIds: [], failedTaskIds: [], skippedTaskIds: [] }],
    ['cross-list id', { activeTaskIds: ['ghost'], completedTaskIds: ['ghost'], failedTaskIds: [], skippedTaskIds: [] }],
    ['unknown id', { activeTaskIds: ['ghost'], completedTaskIds: [], failedTaskIds: [], skippedTaskIds: [] }],
  ])('rejects exact-recovery run-state with %s even for an empty plan', async (_case, lists) => {
    const root = runRoot()
    const runtime = makeNodeDurableDelegationRuntime({
      ...common(root),
      plan: { nodes: [], edges: [] },
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    writeFileSync(join(root, 'run-state.json'), JSON.stringify({
      schemaVersion: 1,
      runId: 'r-malformed',
      binding: BINDING,
      runBudget: { iterations: 0, spendUsd: 0, wallMs: 0 },
      ...lists,
    }, null, 2) + '\n', { mode: 0o600 })

    await expect(runtime.execute()).rejects.toMatchObject({ code: 'DELEGATION_RECOVERY_DENIED' })
  })

  it('holds an exclusive run lock and rejects duplicate or colliding task ids', async () => {
    const root = runRoot()
    let started!: () => void
    let stop!: () => void
    const childStarted = new Promise<void>(resolve => { started = resolve })
    const result = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error('stopped'))
    })
    const first = makeNodeDurableDelegationRuntime({
      ...common(root),
      readCost: async () => ({ iterations: 0, spendUsd: 0, wallMs: 0 }),
      runTask: () => {
        started()
        return {
          result,
          cancel: async () => {
            stop()
            await result.catch(() => undefined)
          },
        }
      },
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    const competing = makeNodeDurableDelegationRuntime({
      ...common(root),
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })
    const firstExecution = first.execute()
    await childStarted
    await expect(competing.execute()).rejects.toMatchObject({ code: 'DELEGATION_RUN_LOCK_HELD' })
    first.cancel()
    await firstExecution

    const invalidRoot = runRoot()
    const colliding: PlanDAG = {
      nodes: [TASK, { ...TASK, taskId: `${TASK.taskId}.jsonl` }],
      edges: [],
    }
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(invalidRoot),
      plan: colliding,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))

    const cyclic: PlanDAG = {
      nodes: [
        { ...TASK, taskId: 'a', dependsOn: ['b'] },
        { ...TASK, taskId: 'b', dependsOn: ['a'] },
      ],
      edges: [{ from: 'b', to: 'a' }, { from: 'a', to: 'b' }],
    }
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(runRoot()), plan: cyclic,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))

    const unknownDependency: PlanDAG = {
      nodes: [{ ...TASK, taskId: 'unknown-target', dependsOn: ['missing'] }],
      edges: [{ from: 'missing', to: 'unknown-target' }],
    }
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(runRoot()), plan: unknownDependency,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))

    const oversized: PlanDAG = {
      nodes: Array.from({ length: 257 }, (_value, index) => ({
        ...TASK, taskId: `task-${index}`,
      })),
      edges: [],
    }
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(runRoot()), plan: oversized,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))

    const dependencySources = Array.from({ length: 65 }, (_value, index) => ({
      ...TASK, taskId: `dependency-${index}`, dependsOn: [],
    }))
    const dependent = {
      ...TASK,
      taskId: 'dependency-target',
      dependsOn: dependencySources.map(task => task.taskId),
    }
    const dependencyOverflow: PlanDAG = {
      nodes: [...dependencySources, dependent],
      edges: dependent.dependsOn.map(from => ({ from, to: dependent.taskId })),
    }
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(runRoot()), plan: dependencyOverflow,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))

    const edgeNodes = Array.from({ length: 256 }, (_value, index) => {
      const dependsOn = Array.from({ length: Math.min(index, 9) }, (_unused, offset) =>
        `edge-${index - offset - 1}`)
      return { ...TASK, taskId: `edge-${index}`, dependsOn }
    })
    const edgeOverflow: PlanDAG = {
      nodes: edgeNodes,
      edges: edgeNodes.flatMap(task => task.dependsOn.map(from => ({ from, to: task.taskId }))),
    }
    expect(edgeOverflow.edges.length).toBeGreaterThan(2048)
    expect(() => makeNodeDurableDelegationRuntime({
      ...common(runRoot()), plan: edgeOverflow,
      runTask: () => operation(Promise.reject(new Error('must not run'))),
      verify: () => operation(Promise.reject(new Error('must not verify'))),
    })).toThrowError(expect.objectContaining({ code: 'DELEGATION_RUNTIME_CONFIG_INVALID' }))
  })
})

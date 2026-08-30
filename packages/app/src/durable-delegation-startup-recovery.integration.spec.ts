import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  makeDelegationManager,
  type AgentCard,
  type PlanDAG,
  type ResolvedWorkBinding,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorRecoveryContextV1,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
} from './execution-supervisor-ipc.js'
import { makeNodeDelegationPersistence } from './delegation-persistence.js'
import { makeNodeDurableDelegationRunRegistry } from './durable-delegation-run-registry.js'
import { makeDurableDelegationStartupRecoveryPortV1 } from './durable-delegation-startup-recovery.js'

const BINDING_HASH = 'a'.repeat(64)
const LIVENESS = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)
const roots: string[] = []
const processes = new Set<ChildProcess>()

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

const CARD: AgentCard = {
  name: 'reviewer',
  instructions: 'Verify exact state.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 0 },
  maxIterations: 5,
  contextStrategy: 'compact',
  provenance: 'builtin',
}

const PLAN: PlanDAG = {
  nodes: [{
    taskId: 'review',
    intent: 'review exact state',
    assignedTo: CARD.name,
    dependsOn: [],
    scope: { owns: ['src/**'], doNotTouch: [], taskClass: 'reasoning' },
    budgetSlice: { iterations: 5, spendUsd: 0.5 },
    outputContract: 'verified summary',
    retryPolicy: { maxReplans: 0, maxIterations: 5 },
  }],
  edges: [],
}

function fixture(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', name)
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

async function genuineRecoveryContext() {
  const replies = [
    frame({
      version: 3,
      type: 'hello-challenge',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      parentNonce: PARENT,
    }),
    frame({
      version: 3,
      type: 'hello-ack',
      requestId: 'hello-1',
      deadlineAtMs: 3_000,
      sessionId: SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1',
        parentNonce: PARENT,
        childNonce: CHILD,
        sessionId: SESSION,
        livenessDescriptorHash: LIVENESS,
      }),
    }),
    frame({
      version: 3,
      type: 'recovery-lease',
      requestId: 'recovery-1',
      deadlineAtMs: 3_000,
      sessionId: SESSION,
      bindingHash: BINDING_HASH,
      leaseId: LEASE,
      authorityPhase: 'checkpoint-bound',
      releaseReceipt: null,
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
  const ids = ['recovery-1']
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => ids.shift() ?? 'unexpected-id',
    randomNonce: () => CHILD,
    nowMs: () => 1_000,
    livenessDescriptorHash: LIVENESS,
  })
  const recovery = await session.requestRecoveryState()
  if (recovery.kind !== 'lease') throw new Error('expected recovery lease')
  const lease = recovery.lease
  const context = makeExecutionSupervisorRecoveryContextV1(lease)
  if (context === null) throw new Error('expected recovery context')
  return { context, lease }
}

function lines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('fixture timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('process exit timeout')), timeoutMs)),
  ])
}

afterEach(async () => {
  const tracked = [...processes]
  for (const child of tracked) try { child.kill('SIGKILL') } catch { /* already gone */ }
  await Promise.all(tracked.map(child => waitExit(child, 1_000).catch(() => undefined)))
  processes.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('durable delegation stale run-lock recovery', () => {
  it('recovers an exact active run after the real lock holder is SIGKILLed', async () => {
    if (process.platform === 'win32') return
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-delegation-lock-recovery-')))
    roots.push(root)
    const runRoot = join(root, `inv-${'1'.repeat(64)}`)
    const trace = join(root, 'lock-holder.trace')
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const registration = registry.register({
      runRoot,
      bindingHash: BINDING_HASH,
      binding: BINDING,
      plan: PLAN,
    })
    makeDelegationManager(PLAN, {
      binding: BINDING,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      emit: () => {},
      persistence: makeNodeDelegationPersistence({ runRoot }),
      isBindingActive: () => true,
    }).spawn('review')
    registration.activate()

    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--experimental-loader', fixture('typescript-source-loader.mjs'),
      fixture('durable-delegation-lock-holder.mts'),
    ], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        TMPDIR: tmpdir(),
        TZ: process.env['TZ'] ?? 'UTC',
        AISY_DELEGATION_LOCK_FIXTURE_RUN_ROOT: runRoot,
        AISY_DELEGATION_LOCK_FIXTURE_TRACE: trace,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    processes.add(child)
    child.once('exit', () => processes.delete(child))
    await waitUntil(() => lines(trace).some(line => line.startsWith('ready ')))
    const lockPath = join(runRoot, '.runtime.lock')
    expect(existsSync(lockPath)).toBe(true)

    child.kill('SIGKILL')
    await waitExit(child)
    expect(existsSync(lockPath)).toBe(true)

    const { context, lease } = await genuineRecoveryContext()
    const port = makeDurableDelegationStartupRecoveryPortV1({
      registry: makeNodeDurableDelegationRunRegistry({ stateRoot: root }),
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: () => true,
    })
    await expect(port.recover(context as never)).resolves.toEqual({
      kind: 'continuation',
      bindingHash: BINDING_HASH,
    })
    expect(lease.isHeld()).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  }, 20_000)
})

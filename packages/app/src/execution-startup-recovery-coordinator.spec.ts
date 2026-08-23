import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeDelegationManager,
  type AgentCard,
  type PlanDAG,
  type ResolvedWorkBinding,
} from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  makeDurableTurnStartupRecoveryPortV1,
  type DurableTurnActorManagerV1,
} from './durable-turn-actor.js'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  isGenuineExecutionSupervisorRecoveryContextV1,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'
import {
  ExecutionStartupRecoveryCoordinatorError,
  runExecutionStartupRecoveryEnvelope,
  type ExecutionStartupRecoveryPortV1,
  type ExecutionStartupRecoveryStepResultV1,
} from './execution-startup-recovery-coordinator.js'
import {
  makeNodeDelegationPersistence,
  makeNodeDelegationRunLock,
} from './delegation-persistence.js'
import { makeNodeDurableDelegationRunRegistry } from './durable-delegation-run-registry.js'
import { makeDurableDelegationStartupRecoveryPortV1 } from './durable-delegation-startup-recovery.js'
import { makeTelegramExecutionStartupRecoveryPortV1 } from './telegram-execution-startup-recovery.js'

const BINDING = 'a'.repeat(64)
const FOREIGN = 'f'.repeat(64)
const LIVENESS = 'b'.repeat(64)
const PARENT = 'p'.repeat(43)
const CHILD = 'c'.repeat(43)
const SESSION = 's'.repeat(43)
const LEASE = 'l'.repeat(43)
const NOW = 1_000
const DEADLINE = 3_000
const roots: string[] = []

const WORK_BINDING: ResolvedWorkBinding = {
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function delegationRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-startup-delegation-')))
  roots.push(root)
  return root
}

function delegationPort(root: string) {
  return makeDurableDelegationStartupRecoveryPortV1({
    registry: makeNodeDurableDelegationRunRegistry({ stateRoot: root }),
    resolveCard: name => name === CARD.name ? CARD : undefined,
    skillTouchedPaths: () => [],
    mcpWritable: () => false,
    isBindingActive: binding => binding.projectId === WORK_BINDING.projectId &&
      binding.sessionId === WORK_BINDING.sessionId,
  })
}

function frame(value: ExecutionSupervisorFrame): string {
  return encodeExecutionSupervisorFrame(value)
}

function channel(replies: string[]): ExecutionSupervisorChannel & {
  readonly sent: string[]
  disconnect(): void
} {
  const listeners = new Set<() => void>()
  let closed = false
  return {
    sent: [],
    send(line) {
      if (closed) throw new Error('closed')
      this.sent.push(line)
    },
    async receive() {
      const next = replies.shift()
      if (next === undefined) throw new Error('disconnected')
      return next
    },
    onDisconnect(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close() { closed = true },
    disconnect() {
      closed = true
      for (const listener of listeners) listener()
    },
  }
}

async function genuineLease(
  authorityPhase: 'captured-unbound' | 'checkpoint-bound' = 'captured-unbound',
): Promise<Readonly<{
  lease: ExecutionSupervisorLease
  transport: ReturnType<typeof channel>
}>> {
  const helloRequestId = 'hello-1'
  const transport = channel([
    frame({
      version: 3,
      type: 'hello-challenge',
      requestId: helloRequestId,
      deadlineAtMs: DEADLINE,
      parentNonce: PARENT,
    }),
    frame({
      version: 3,
      type: 'hello-ack',
      requestId: helloRequestId,
      deadlineAtMs: DEADLINE,
      sessionId: SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: helloRequestId,
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
      deadlineAtMs: DEADLINE,
      sessionId: SESSION,
      bindingHash: BINDING,
      leaseId: LEASE,
      authorityPhase,
      releaseReceipt: null,
    }),
    frame({
      version: 3,
      type: 'release-ack',
      requestId: 'release-1',
      deadlineAtMs: DEADLINE,
      sessionId: SESSION,
      bindingHash: BINDING,
      leaseId: LEASE,
    }),
  ])
  const ids = ['recovery-1', 'release-1']
  const session = await authenticateExecutionSupervisorChild({
    channel: transport,
    newRequestId: () => ids.shift() ?? 'unexpected-id',
    randomNonce: () => CHILD,
    nowMs: () => NOW,
    livenessDescriptorHash: LIVENESS,
  })
  const recovery = await session.requestRecoveryState()
  if (recovery.kind !== 'lease') throw new Error('expected genuine recovery lease')
  const lease = recovery.lease
  return Object.freeze({ lease, transport })
}

function port(
  implementation: ExecutionStartupRecoveryPortV1['recover'],
): ExecutionStartupRecoveryPortV1 {
  return Object.freeze({ recover: implementation })
}

function sentTypes(transport: ReturnType<typeof channel>): string[] {
  return transport.sent.map(raw => (JSON.parse(raw) as { type: string }).type)
}

async function expectCode(
  promise: Promise<unknown>,
  code: ExecutionStartupRecoveryCoordinatorError['code'],
): Promise<void> {
  await expect(promise).rejects.toEqual(new ExecutionStartupRecoveryCoordinatorError(code))
}

describe('dormant unified execution startup recovery envelope', () => {
  it('runs Telegram, approval/stop and delegation in order, then releases once', async () => {
    const { lease, transport } = await genuineLease()
    const order: string[] = []
    let sharedContext: unknown
    const step = (name: string, result: ExecutionStartupRecoveryStepResultV1) => port(async context => {
      order.push(name)
      sharedContext ??= context
      expect(context).toBe(sharedContext)
      expect(Object.isFrozen(context)).toBe(true)
      expect(isGenuineExecutionSupervisorRecoveryContextV1(context)).toBe(true)
      expect(isGenuineExecutionSupervisorRecoveryContextV1({ ...context })).toBe(false)
      expect(context).toMatchObject({
        schemaVersion: 1,
        bindingHash: BINDING,
        authorityPhase: 'captured-unbound',
      })
      expect(context.isHeld()).toBe(true)
      return result
    })

    await expect(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: step('telegram', { kind: 'terminal', bindingHash: BINDING }),
      approvalStop: step('approval-stop', { kind: 'none' }),
      delegation: step('delegation', { kind: 'terminal', bindingHash: BINDING }),
    })).resolves.toEqual({ kind: 'ready', bindingHash: BINDING })

    expect(order).toEqual(['telegram', 'approval-stop', 'delegation'])
    expect(lease.isHeld()).toBe(false)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request', 'release'])
  })

  it('admits concrete adapters only under the genuine coordinator context', async () => {
    const { lease } = await genuineLease()
    const load = vi.fn(() => ({
      status: 'ready' as const,
      checkpoint: {
        bindingHash: BINDING,
        phase: 'terminal' as const,
        delivery: 'delivered' as const,
      },
    }))
    const telegram = makeTelegramExecutionStartupRecoveryPortV1({
      store: {
        load,
        begin: vi.fn(),
        replace: vi.fn(),
      } as never,
      output: { sendText: vi.fn(), editText: vi.fn() },
      newOwnerId: () => 'unused',
    })
    const recover = vi.fn(() => ({ kind: 'none' as const }))
    const approvalStop = makeDurableTurnStartupRecoveryPortV1({ recover } as unknown as
      DurableTurnActorManagerV1)

    await expect(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram,
      approvalStop,
      delegation: port(async () => ({ kind: 'terminal', bindingHash: BINDING })),
    })).resolves.toEqual({ kind: 'ready', bindingHash: BINDING })
    expect(load).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalledOnce()
  })

  it('uses only registered delegation runs and keeps the pre-runtime crash window terminal', async () => {
    const root = delegationRoot()
    const runRoot = join(root, `inv-${'1'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    registry.register({
      runRoot,
      bindingHash: BINDING,
      binding: WORK_BINDING,
      plan: PLAN,
    })
    const { lease } = await genuineLease()
    const none = port(async () => ({ kind: 'none' }))

    await expect(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: none,
      approvalStop: none,
      delegation: delegationPort(root),
    })).resolves.toEqual({ kind: 'ready', bindingHash: BINDING })
    expect(existsSync(runRoot)).toBe(false)
  })

  it('does not read the delegation registry for a structural recovery context', async () => {
    const listExact = vi.fn(() => [])
    const recovery = makeDurableDelegationStartupRecoveryPortV1({
      registry: {
        register: vi.fn() as never,
        listExact,
        runRoot: vi.fn(),
      },
      resolveCard: () => undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      isBindingActive: () => true,
    })

    await expect(recovery.recover({
      schemaVersion: 1,
      bindingHash: BINDING,
      authorityPhase: 'captured-unbound',
      isHeld: () => true,
    } as never)).resolves.toEqual({
      kind: 'denied',
      code: 'DELEGATION_RECOVERY_AUTHORITY_INVALID',
    })
    expect(listExact).not.toHaveBeenCalled()
  })

  it('returns continuation only for an active exact run under the same binding', async () => {
    const root = delegationRoot()
    const runRoot = join(root, `inv-${'2'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const registration = registry.register({
      runRoot,
      bindingHash: BINDING,
      binding: WORK_BINDING,
      plan: PLAN,
    })
    makeDelegationManager(PLAN, {
      binding: WORK_BINDING,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      emit: () => {},
      persistence: makeNodeDelegationPersistence({ runRoot }),
      isBindingActive: () => true,
    }).spawn('review')
    registration.activate()
    makeNodeDelegationRunLock(runRoot).acquire()
    expect(existsSync(join(runRoot, '.runtime.lock'))).toBe(true)

    const { lease, transport } = await genuineLease('checkpoint-bound')
    const none = port(async () => ({ kind: 'none' }))
    const result = await runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: none,
      approvalStop: none,
      delegation: delegationPort(root),
    })

    expect(result).toMatchObject({
      kind: 'continuation-required',
      bindingHash: BINDING,
    })
    expect(lease.isHeld()).toBe(true)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request'])
    expect(existsSync(join(runRoot, '.runtime.lock'))).toBe(false)
  })

  it('does not unlink a malformed active run lock under recovery authority', async () => {
    const root = delegationRoot()
    const runRoot = join(root, `inv-${'4'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    const registration = registry.register({
      runRoot,
      bindingHash: BINDING,
      binding: WORK_BINDING,
      plan: PLAN,
    })
    makeDelegationManager(PLAN, {
      binding: WORK_BINDING,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      emit: () => {},
      persistence: makeNodeDelegationPersistence({ runRoot }),
      isBindingActive: () => true,
    }).spawn('review')
    registration.activate()
    const lockPath = join(runRoot, '.runtime.lock')
    writeFileSync(lockPath, 'not-a-runtime-token', { mode: 0o600, flag: 'wx' })

    const { lease } = await genuineLease('checkpoint-bound')
    const none = port(async () => ({ kind: 'none' }))
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: none,
      approvalStop: none,
      delegation: delegationPort(root),
    }), 'EXECUTION_RECOVERY_STEP_DENIED')
    expect(existsSync(lockPath)).toBe(true)
    expect(lease.isHeld()).toBe(true)
  })

  it.each(['public', 'symlink'] as const)(
    'does not unlink a %s active run lock under recovery authority',
    async (kind) => {
      if (kind === 'symlink' && process.platform === 'win32') return
      const root = delegationRoot()
      const runRoot = join(root, `inv-${kind === 'public' ? '5' : '6'}`.padEnd(68, kind === 'public' ? '5' : '6'))
      const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
      const registration = registry.register({
        runRoot,
        bindingHash: BINDING,
        binding: WORK_BINDING,
        plan: PLAN,
      })
      makeDelegationManager(PLAN, {
        binding: WORK_BINDING,
        resolveCard: name => name === CARD.name ? CARD : undefined,
        skillTouchedPaths: () => [],
        mcpWritable: () => false,
        emit: () => {},
        persistence: makeNodeDelegationPersistence({ runRoot }),
        isBindingActive: () => true,
      }).spawn('review')
      registration.activate()
      const lockPath = join(runRoot, '.runtime.lock')
      const token = '123:123e4567-e89b-42d3-a456-426614174000'
      if (kind === 'public') {
        writeFileSync(lockPath, token, { mode: 0o600, flag: 'wx' })
        chmodSync(lockPath, 0o644)
      } else {
        const target = join(runRoot, 'foreign-lock-target')
        writeFileSync(target, token, { mode: 0o600, flag: 'wx' })
        symlinkSync(target, lockPath)
      }

      const { lease } = await genuineLease('checkpoint-bound')
      const none = port(async () => ({ kind: 'none' }))
      await expectCode(runExecutionStartupRecoveryEnvelope({
        lease,
        telegram: none,
        approvalStop: none,
        delegation: delegationPort(root),
      }), 'EXECUTION_RECOVERY_STEP_DENIED')
      expect(existsSync(lockPath)).toBe(true)
      expect(lease.isHeld()).toBe(true)
    },
  )

  it('rejects durable child state written before registry activation', async () => {
    const root = delegationRoot()
    const runRoot = join(root, `inv-${'3'.repeat(64)}`)
    const registry = makeNodeDurableDelegationRunRegistry({ stateRoot: root })
    registry.register({
      runRoot,
      bindingHash: BINDING,
      binding: WORK_BINDING,
      plan: PLAN,
    })
    makeDelegationManager(PLAN, {
      binding: WORK_BINDING,
      resolveCard: name => name === CARD.name ? CARD : undefined,
      skillTouchedPaths: () => [],
      mcpWritable: () => false,
      emit: () => {},
      persistence: makeNodeDelegationPersistence({ runRoot }),
      isBindingActive: () => true,
    }).spawn('review')

    const { lease } = await genuineLease()
    const none = port(async () => ({ kind: 'none' }))
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: none,
      approvalStop: none,
      delegation: delegationPort(root),
    }), 'EXECUTION_RECOVERY_STEP_DENIED')
    expect(lease.isHeld()).toBe(true)
  })

  it('keeps a genuine checkpoint-bound Telegram miss fail-closed', async () => {
    const { lease, transport } = await genuineLease('checkpoint-bound')
    const telegram = makeTelegramExecutionStartupRecoveryPortV1({
      store: {
        load: vi.fn(() => ({ status: 'missing' as const })),
        begin: vi.fn(),
        replace: vi.fn(),
      },
      output: { sendText: vi.fn(), editText: vi.fn() },
      newOwnerId: () => 'unused',
    })
    const downstream = vi.fn(async () => ({ kind: 'none' as const }))

    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram,
      approvalStop: port(downstream),
      delegation: port(downstream),
    }), 'EXECUTION_RECOVERY_STEP_DENIED')
    expect(downstream).not.toHaveBeenCalled()
    expect(lease.isHeld()).toBe(true)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request'])
  })

  it('holds the same lease for continuation and rechecks the whole envelope', async () => {
    const { lease, transport } = await genuineLease('checkpoint-bound')
    const order: string[] = []
    let pass = 0
    const telegram = port(async () => {
      order.push(`telegram-${pass}`)
      return { kind: 'terminal', bindingHash: BINDING }
    })
    const approvalStop = port(async () => {
      order.push(`approval-${pass}`)
      return pass === 0
        ? { kind: 'continuation', bindingHash: BINDING }
        : { kind: 'terminal', bindingHash: BINDING }
    })
    const delegation = port(async () => {
      order.push(`delegation-${pass}`)
      return pass === 0
        ? { kind: 'continuation', bindingHash: BINDING }
        : { kind: 'terminal', bindingHash: BINDING }
    })

    const continuation = await runExecutionStartupRecoveryEnvelope({
      lease,
      telegram,
      approvalStop,
      delegation,
    })
    expect(continuation).toMatchObject({
      kind: 'continuation-required',
      bindingHash: BINDING,
    })
    expect(lease.isHeld()).toBe(true)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request'])

    pass = 1
    if (continuation.kind !== 'continuation-required') throw new Error('expected continuation')
    await expect(continuation.reconcile()).resolves.toEqual({
      kind: 'ready',
      bindingHash: BINDING,
    })
    expect(order).toEqual([
      'telegram-0', 'approval-0', 'delegation-0',
      'telegram-1', 'approval-1', 'delegation-1',
    ])
    expect(lease.isHeld()).toBe(false)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request', 'release'])
    await expectCode(
      continuation.reconcile(),
      'EXECUTION_RECOVERY_RECONCILE_BUSY',
    )
  })

  it('keeps checkpoint-bound missing state fail-closed without release', async () => {
    const { lease, transport } = await genuineLease('checkpoint-bound')
    const none = port(async () => ({ kind: 'none' }))
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: none,
      approvalStop: none,
      delegation: none,
    }), 'EXECUTION_RECOVERY_STATE_MISSING')
    expect(lease.isHeld()).toBe(true)
    expect(sentTypes(transport)).toEqual(['hello', 'recovery-request'])
  })

  it('stops at denial or binding drift and never runs a downstream subsystem', async () => {
    for (const result of [
      { kind: 'denied' as const, code: 'APPROVAL_STATE_CORRUPT' },
      { kind: 'terminal' as const, bindingHash: FOREIGN },
    ]) {
      const { lease, transport } = await genuineLease()
      const delegation = vi.fn(async () => ({ kind: 'none' as const }))
      await expect(runExecutionStartupRecoveryEnvelope({
        lease,
        telegram: port(async () => ({ kind: 'none' })),
        approvalStop: port(async () => result),
        delegation: port(delegation),
      })).rejects.toBeInstanceOf(ExecutionStartupRecoveryCoordinatorError)
      expect(delegation).not.toHaveBeenCalled()
      expect(lease.isHeld()).toBe(true)
      expect(sentTypes(transport)).toEqual(['hello', 'recovery-request'])
    }
  })

  it('detects authority loss after an await before the next subsystem', async () => {
    const { lease, transport } = await genuineLease()
    const approval = vi.fn(async () => ({ kind: 'none' as const }))
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease,
      telegram: port(async () => {
        transport.disconnect()
        return { kind: 'none' }
      }),
      approvalStop: port(approval),
      delegation: port(async () => ({ kind: 'none' })),
    }), 'EXECUTION_RECOVERY_AUTHORITY_LOST')
    expect(approval).not.toHaveBeenCalled()
    expect(lease.isHeld()).toBe(false)
  })

  it('rejects structural lease copies and redacts step exceptions', async () => {
    const first = await genuineLease()
    const touched = vi.fn(async () => ({ kind: 'none' as const }))
    const leaseGetter = vi.fn(() => first.lease)
    const accessorInput = {
      get lease() { return leaseGetter() },
      telegram: port(touched),
      approvalStop: port(touched),
      delegation: port(touched),
    }
    await expectCode(
      runExecutionStartupRecoveryEnvelope(accessorInput as never),
      'EXECUTION_RECOVERY_CONFIG_INVALID',
    )
    expect(leaseGetter).not.toHaveBeenCalled()
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease: { ...first.lease } as never,
      telegram: port(touched),
      approvalStop: port(touched),
      delegation: port(touched),
    }), 'EXECUTION_RECOVERY_AUTHORITY_INVALID')
    expect(touched).not.toHaveBeenCalled()

    const second = await genuineLease()
    try {
      await runExecutionStartupRecoveryEnvelope({
        lease: second.lease,
        telegram: port(async () => { throw new Error('credential=private-value') }),
        approvalStop: port(touched),
        delegation: port(touched),
      })
      throw new Error('expected code-only refusal')
    } catch (error) {
      expect(error).toEqual(new ExecutionStartupRecoveryCoordinatorError(
        'EXECUTION_RECOVERY_STEP_FAILED',
      ))
      expect(String(error)).not.toContain('credential=private-value')
    }
    expect(second.lease.isHeld()).toBe(true)

    const third = await genuineLease()
    const smuggled = Object.defineProperty({ kind: 'none' }, 'payload', {
      value: 'private',
      enumerable: false,
    })
    await expectCode(runExecutionStartupRecoveryEnvelope({
      lease: third.lease,
      telegram: port(async () => smuggled as never),
      approvalStop: port(touched),
      delegation: port(touched),
    }), 'EXECUTION_RECOVERY_STEP_FAILED')
    expect(third.lease.isHeld()).toBe(true)
  })
})

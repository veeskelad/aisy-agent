import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionState } from '@aisy/telegram-gw'
import {
  authenticateExecutionSupervisorChild,
  encodeExecutionSupervisorFrame,
  makeExecutionSupervisorSessionProof,
  type ExecutionSupervisorChannel,
  type ExecutionSupervisorFrame,
  type ExecutionSupervisorLease,
} from './execution-supervisor-ipc.js'
import {
  confirmTelegramExecutionCheckpointDelivery,
  makeTelegramExecutionDeliveryReceipt,
  makeJsonTelegramExecutionCheckpointStore,
  makeNodeTelegramExecutionCheckpointStore,
  makeTelegramExecutionBindingHash,
  makeTelegramExecutionCheckpoint,
} from './telegram-execution-checkpoint.js'
import {
  makeTelegramExecutionStartupRecoveryPortV1,
  recoverTelegramExecutionAtStartup,
  recoverTelegramExecutionWithHeldLease,
  type TelegramExecutionServiceManagerPort,
} from './telegram-execution-startup-recovery.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const BINDING = makeTelegramExecutionBindingHash({
  chatId: 42,
  sessionId: 'session-a',
  turnId: 'telegram:42:turn-a',
})

const SUPERVISOR_SESSION = 's'.repeat(43)
const SUPERVISOR_LEASE = 'l'.repeat(43)
const SUPERVISOR_PARENT_NONCE = 'p'.repeat(43)
const SUPERVISOR_CHILD_NONCE = 'c'.repeat(43)
const SUPERVISOR_LIVENESS = 'd'.repeat(64)
const SUPERVISOR_DEADLINE = 3_000

function runningState(): ExecutionState {
  return {
    scope: 'проект «A»',
    steps: [],
    thinking: true,
    status: 'running',
  }
}

function boundCheckpoint() {
  return makeTelegramExecutionCheckpoint({
    bindingHash: BINDING,
    ownerId: 'runtime-before-crash',
    revision: 2,
    phase: 'bound',
    delivery: 'delivered',
    messageId: 91,
    locked: false,
    state: runningState(),
    updatedAt: '2026-07-28T09:00:00.000Z',
  })
}

function preparedCheckpoint() {
  return makeTelegramExecutionCheckpoint({
    bindingHash: BINDING,
    ownerId: 'runtime-before-crash',
    revision: 1,
    phase: 'prepared',
    delivery: 'pending',
    locked: false,
    state: runningState(),
    updatedAt: '2026-07-28T09:00:00.000Z',
  })
}

function terminalCheckpoint(delivery: 'pending' | 'delivered') {
  return makeTelegramExecutionCheckpoint({
    bindingHash: BINDING,
    ownerId: 'runtime-before-crash',
    revision: 3,
    phase: 'terminal',
    delivery,
    messageId: 91,
    locked: false,
    state: {
      ...runningState(),
      thinking: false,
      status: delivery === 'pending' ? 'interrupted' : 'completed',
    },
    updatedAt: '2026-07-28T09:00:00.000Z',
  })
}

function serviceManager(input?: {
  bindingHash?: string
  authorityPhase?: 'captured-unbound' | 'checkpoint-bound'
  states?: boolean[]
  releaseFails?: boolean
}) {
  const states = [...(input?.states ?? [true, true, true])]
  const release = vi.fn(async () => {
    if (input?.releaseFails === true) throw new Error('private service-manager detail')
  })
  const port: TelegramExecutionServiceManagerPort = {
    acquireRecoveryLease: vi.fn(async () => ({
      bindingHash: input?.bindingHash ?? BINDING,
      authorityPhase: input?.authorityPhase ?? 'checkpoint-bound',
      isHeld: vi.fn(() => states.shift() ?? true),
      bindCheckpoint: vi.fn(async () => undefined),
      release,
      failClosed(): never { throw new Error('EXECUTION_AUTHORITY_UNAVAILABLE') },
    })),
  }
  return { port, release }
}

async function genuineRecoveryLease(): Promise<Readonly<{
  lease: ExecutionSupervisorLease
  disconnect(): void
}>> {
  const encode = (value: ExecutionSupervisorFrame): string => encodeExecutionSupervisorFrame(value)
  const replies = [
    encode({
      version: 3,
      type: 'hello-challenge',
      requestId: 'hello-1',
      deadlineAtMs: SUPERVISOR_DEADLINE,
      parentNonce: SUPERVISOR_PARENT_NONCE,
    }),
    encode({
      version: 3,
      type: 'hello-ack',
      requestId: 'hello-1',
      deadlineAtMs: SUPERVISOR_DEADLINE,
      sessionId: SUPERVISOR_SESSION,
      sessionProof: makeExecutionSupervisorSessionProof({
        requestId: 'hello-1',
        parentNonce: SUPERVISOR_PARENT_NONCE,
        childNonce: SUPERVISOR_CHILD_NONCE,
        sessionId: SUPERVISOR_SESSION,
        livenessDescriptorHash: SUPERVISOR_LIVENESS,
      }),
    }),
    encode({
      version: 3,
      type: 'recovery-lease',
      requestId: 'recovery-1',
      deadlineAtMs: SUPERVISOR_DEADLINE,
      sessionId: SUPERVISOR_SESSION,
      bindingHash: BINDING,
      leaseId: SUPERVISOR_LEASE,
      authorityPhase: 'checkpoint-bound',
      releaseReceipt: null,
    }),
  ]
  const listeners = new Set<() => void>()
  const channel: ExecutionSupervisorChannel = {
    send: vi.fn(),
    async receive() {
      const next = replies.shift()
      if (next === undefined) throw new Error('unexpected receive')
      return next
    },
    onDisconnect(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close() { for (const listener of listeners) listener() },
  }
  const requestIds = ['recovery-1']
  const session = await authenticateExecutionSupervisorChild({
    channel,
    newRequestId: () => requestIds.shift() ?? 'unexpected-request',
    randomNonce: () => SUPERVISOR_CHILD_NONCE,
    nowMs: () => 1_000,
    livenessDescriptorHash: SUPERVISOR_LIVENESS,
  })
  const recovery = await session.requestRecoveryState()
  if (recovery.kind !== 'lease') throw new Error('expected recovery lease')
  return Object.freeze({
    lease: recovery.lease,
    disconnect() { for (const listener of listeners) listener() },
  })
}

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-execution-startup-')))
  roots.push(value)
  return value
}

describe('Telegram execution startup recovery coordinator', () => {
  it('rejects a structurally forged unified recovery context before state read', async () => {
    const read = vi.fn(() => JSON.stringify(boundCheckpoint()))
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => true,
      read,
      saveAtomic: () => { throw new Error('must not write') },
    })
    const port = makeTelegramExecutionStartupRecoveryPortV1({
      store,
      output: { sendText: vi.fn(), editText: vi.fn() },
      newOwnerId: () => 'unused',
    })
    const context = Object.freeze({
      schemaVersion: 1 as const,
      bindingHash: BINDING,
      authorityPhase: 'checkpoint-bound' as const,
      isHeld: () => true,
    })

    await expect(port.recover(context as never)).resolves.toEqual({
      kind: 'denied',
      code: 'TELEGRAM_RECOVERY_AUTHORITY_INVALID',
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps a checkpoint-bound recovery lease when the checkpoint is unexpectedly missing', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const manager = serviceManager()
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'incomplete', code: 'RECOVERY_FAILED' })
    expect(manager.release).not.toHaveBeenCalled()
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('releases captured-unbound recovery authority when no checkpoint was published', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const manager = serviceManager({ authorityPhase: 'captured-unbound' })
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'none' })
    expect(manager.release).toHaveBeenCalledOnce()
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('keeps a non-null recovery lease for quarantined checkpoint bytes', async () => {
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => true,
      read: () => '{"corrupt":true}',
      saveAtomic: vi.fn(),
    })
    const manager = serviceManager()
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'quarantined', code: 'CHECKPOINT_QUARANTINED' })
    expect(manager.release).not.toHaveBeenCalled()
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('releases a terminal-delivered checkpoint only for the exact binding', async () => {
    const exactStore = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    exactStore.begin(preparedCheckpoint())
    exactStore.replace(boundCheckpoint(), {
      ownerId: 'runtime-before-crash',
      revision: 1,
      bindingHash: BINDING,
    })
    exactStore.replace(terminalCheckpoint('delivered'), {
      ownerId: 'runtime-before-crash',
      revision: 2,
      bindingHash: BINDING,
    })
    const foreign = serviceManager({ bindingHash: 'b'.repeat(64) })
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store: exactStore,
      serviceManager: foreign.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'FOREIGN_BINDING' })
    expect(foreign.release).not.toHaveBeenCalled()

    const exact = serviceManager()
    await expect(recoverTelegramExecutionAtStartup({
      store: exactStore,
      serviceManager: exact.port,
      output,
      newOwnerId: () => 'recovery-b',
    })).resolves.toEqual({ kind: 'none' })
    expect(exact.release).toHaveBeenCalledOnce()
  })

  it('requires an external service-manager lease and exact opaque authority', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    store.begin(preparedCheckpoint())
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: { acquireRecoveryLease: async () => null },
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'SERVICE_MANAGER_REQUIRED' })

    const invalid = serviceManager({ bindingHash: 'not-a-hash' })
    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: invalid.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'SERVICE_MANAGER_AUTHORITY_INVALID' })
    expect(invalid.release).not.toHaveBeenCalled()
    expect(output.sendText).not.toHaveBeenCalled()
    expect(output.editText).not.toHaveBeenCalled()
  })

  it('rechecks quiescence immediately before Telegram I/O', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const prepared = preparedCheckpoint()
    store.begin(prepared)
    const bound = boundCheckpoint()
    store.replace(bound, {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const manager = serviceManager({ states: [true, true, false] })
    const output = { sendText: vi.fn(), editText: vi.fn() }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED' })
    expect(output.editText).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'pending', ownerId: 'recovery-a' },
    })
    expect(manager.release).not.toHaveBeenCalled()
  })

  it('rechecks quiescence after Telegram await before durable delivered and release', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const prepared = preparedCheckpoint()
    store.begin(prepared)
    store.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const manager = serviceManager({ states: [true, true, true, false] })
    const output = { sendText: vi.fn(), editText: vi.fn(async () => undefined) }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED' })
    expect(output.editText).toHaveBeenCalledOnce()
    expect(manager.release).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'terminal', delivery: 'pending' },
    })
  })

  it('surfaces a release failure without leaking it or undoing delivered recovery', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const prepared = preparedCheckpoint()
    store.begin(prepared)
    store.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const manager = serviceManager({ releaseFails: true })
    const output = { sendText: vi.fn(), editText: vi.fn(async () => undefined) }

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'incomplete', code: 'QUIESCENCE_RELEASE_FAILED' })
    expect(output.editText).toHaveBeenCalledWith(
      91,
      'Снова на связи.',
    )
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'delivered', ownerId: 'recovery-a' },
    })
    expect(JSON.stringify(store.load())).not.toContain('private service-manager detail')
  })

  it('keeps recovery authority when terminal delivery is still pending', async () => {
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(root(), 'telegram', 'execution-card.json'),
    })
    const prepared = preparedCheckpoint()
    store.begin(prepared)
    store.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const manager = serviceManager()

    await expect(recoverTelegramExecutionAtStartup({
      store,
      serviceManager: manager.port,
      output: {
        sendText: vi.fn(),
        editText: vi.fn(async () => { throw new Error('private Telegram failure') }),
      },
      newOwnerId: () => 'recovery-a',
    })).resolves.toEqual({ kind: 'delivery-pending', code: 'TELEGRAM_DELIVERY_FAILED' })

    expect(manager.release).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'pending' },
    })
  })

  it.each([
    {
      state: 'prepared-pending',
      checkpoint: preparedCheckpoint(),
      expected: { kind: 'recovered', delivery: 'replacement-sent', messageId: 92 },
      sends: 1,
      edits: 0,
    },
    {
      state: 'bound-delivered',
      checkpoint: boundCheckpoint(),
      expected: { kind: 'recovered', delivery: 'edited', messageId: 91 },
      sends: 0,
      edits: 1,
    },
    {
      state: 'terminal-pending',
      checkpoint: terminalCheckpoint('pending'),
      expected: { kind: 'recovered', delivery: 'edited', messageId: 91 },
      sends: 0,
      edits: 1,
    },
    {
      state: 'terminal-delivered',
      checkpoint: terminalCheckpoint('delivered'),
      expected: { kind: 'none' },
      sends: 0,
      edits: 0,
    },
  ])('handles $state after abrupt child-process death and fresh store composition', async ({
    checkpoint: crashedCheckpoint,
    expected,
    sends,
    edits,
  }) => {
    if (process.platform === 'win32') return
    const directory = root()
    const path = join(directory, 'telegram', 'execution-card.json')
    const encoded = Buffer.from(JSON.stringify(crashedCheckpoint) + '\n').toString('base64')
    const child = spawn(process.execPath, [
      '-e',
      [
        "const fs=require('node:fs')",
        "const path=require('node:path')",
        'const target=process.argv[1]',
        "fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700})",
        "fs.writeFileSync(target,Buffer.from(process.argv[2],'base64'),{mode:0o600})",
        "process.stdout.write('ready\\n')",
        'setInterval(()=>{},1000)',
      ].join(';'),
      path,
      encoded,
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    await once(child.stdout!, 'data')
    expect(child.kill('SIGKILL')).toBe(true)
    await once(child, 'exit')

    const restartedStore = makeNodeTelegramExecutionCheckpointStore({ path })
    const manager = serviceManager()
    const output = {
      sendText: vi.fn(async () => 92),
      editText: vi.fn(async () => undefined),
    }
    await expect(recoverTelegramExecutionAtStartup({
      store: restartedStore,
      serviceManager: manager.port,
      output,
      newOwnerId: () => 'runtime-after-restart',
      nowIso: () => '2026-07-28T09:10:00.000Z',
    })).resolves.toEqual(expected)

    expect(output.sendText).toHaveBeenCalledTimes(sends)
    expect(output.editText).toHaveBeenCalledTimes(edits)
    if (edits === 1) {
      expect(output.editText).toHaveBeenCalledWith(
        91,
        'Снова на связи.',
      )
    }
    expect(readFileSync(path, 'utf8')).not.toContain('telegram:42:turn-a')
    const loaded = restartedStore.load()
    expect(loaded).toMatchObject({
      status: 'ready',
      checkpoint: { phase: 'terminal', delivery: 'delivered' },
    })
    if (expected.kind === 'recovered') {
      expect(loaded).toMatchObject({
        status: 'ready',
        checkpoint: { ownerId: 'runtime-after-restart' },
      })
    }
    expect(manager.release).toHaveBeenCalledOnce()
  })

  it('recovers with an already-held lease, mints exact evidence, and never releases authority', async () => {
    const trustedRoot = root()
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(trustedRoot, 'telegram', 'execution-card.json'),
      trustedRoot,
    })
    const prepared = preparedCheckpoint()
    store.begin(prepared)
    store.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const supervisor = await genuineRecoveryLease()
    const output = { sendText: vi.fn(), editText: vi.fn(async () => undefined) }

    const result = await recoverTelegramExecutionWithHeldLease({
      store,
      lease: supervisor.lease,
      output,
      newOwnerId: () => 'recovery-held',
      nowIso: () => '2026-07-28T09:10:00.000Z',
    })

    expect(result).toMatchObject({
      kind: 'recovered', delivery: 'edited', messageId: 91,
      evidence: {
        bindingHash: BINDING,
        revision: 4,
        delivery: 'delivered',
        messageId: 91,
        checkpointHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.evidence)).toBe(true)
    expect(Object.keys(result.evidence!).sort()).toEqual([
      'bindingHash', 'checkpointHash', 'delivery', 'messageId', 'revision',
    ])
    expect(output.editText).toHaveBeenCalledOnce()
    expect(supervisor.lease.isHeld()).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/telegram|execution-card|проект|recovery-held/u)
  })

  it('replays already-delivered evidence after restart with zero Telegram I/O', async () => {
    const trustedRoot = root()
    const path = join(trustedRoot, 'telegram', 'execution-card.json')
    const firstStore = makeNodeTelegramExecutionCheckpointStore({ path, trustedRoot })
    const prepared = preparedCheckpoint()
    firstStore.begin(prepared)
    firstStore.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const firstSupervisor = await genuineRecoveryLease()
    const firstOutput = { sendText: vi.fn(), editText: vi.fn(async () => undefined) }
    const first = await recoverTelegramExecutionWithHeldLease({
      store: firstStore,
      lease: firstSupervisor.lease,
      output: firstOutput,
      newOwnerId: () => 'recovery-before-crash',
      nowIso: () => '2026-07-28T09:10:00.000Z',
    })
    expect(first.kind).toBe('recovered')
    expect(firstSupervisor.lease.isHeld()).toBe(true)

    const restartedStore = makeNodeTelegramExecutionCheckpointStore({ path, trustedRoot })
    const restartedSupervisor = await genuineRecoveryLease()
    const restartedOutput = { sendText: vi.fn(), editText: vi.fn() }
    const replayed = await recoverTelegramExecutionWithHeldLease({
      store: restartedStore,
      lease: restartedSupervisor.lease,
      output: restartedOutput,
      newOwnerId: () => 'must-not-be-used',
    })

    expect(replayed).toEqual({
      ...(first as Extract<typeof first, { kind: 'recovered' }>),
      delivery: 'already-delivered',
    })
    expect(restartedOutput.sendText).not.toHaveBeenCalled()
    expect(restartedOutput.editText).not.toHaveBeenCalled()
    expect(restartedSupervisor.lease.isHeld()).toBe(true)
  })

  it('keeps the lease and emits no evidence after Telegram or authority loss', async () => {
    const trustedRoot = root()
    const path = join(trustedRoot, 'telegram', 'execution-card.json')
    const failedStore = makeNodeTelegramExecutionCheckpointStore({ path, trustedRoot })
    const prepared = preparedCheckpoint()
    failedStore.begin(prepared)
    failedStore.replace(boundCheckpoint(), {
      ownerId: prepared.ownerId,
      revision: prepared.revision,
      bindingHash: prepared.bindingHash,
    })
    const telegramFailure = await genuineRecoveryLease()
    await expect(recoverTelegramExecutionWithHeldLease({
      store: failedStore,
      lease: telegramFailure.lease,
      output: { sendText: vi.fn(), editText: vi.fn(async () => { throw new Error('secret') }) },
      newOwnerId: () => 'failed-recovery',
    })).resolves.toEqual({
      kind: 'delivery-pending', code: 'TELEGRAM_DELIVERY_FAILED', evidence: null,
    })
    expect(telegramFailure.lease.isHeld()).toBe(true)

    const authorityStore = makeNodeTelegramExecutionCheckpointStore({ path, trustedRoot })
    const authorityLoss = await genuineRecoveryLease()
    const output = {
      sendText: vi.fn(),
      editText: vi.fn(async () => { authorityLoss.disconnect() }),
    }
    await expect(recoverTelegramExecutionWithHeldLease({
      store: authorityStore,
      lease: authorityLoss.lease,
      output,
      newOwnerId: () => 'authority-loss',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED', evidence: null })
    expect(output.editText).toHaveBeenCalledOnce()
    expect(authorityLoss.lease.isHeld()).toBe(false)
    expect(authorityStore.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'terminal', delivery: 'pending' },
    })
  })

  it('treats authority loss after a first send as ambiguous and keeps recovery pending', async () => {
    const trustedRoot = root()
    const store = makeNodeTelegramExecutionCheckpointStore({
      path: join(trustedRoot, 'telegram', 'execution-card.json'),
      trustedRoot,
    })
    store.begin(preparedCheckpoint())
    const supervisor = await genuineRecoveryLease()
    const output = {
      sendText: vi.fn(async () => {
        supervisor.disconnect()
        return 92
      }),
      editText: vi.fn(),
    }

    await expect(recoverTelegramExecutionWithHeldLease({
      store,
      lease: supervisor.lease,
      output,
      newOwnerId: () => 'send-loss',
    })).resolves.toEqual({ kind: 'denied', code: 'QUIESCENCE_REQUIRED', evidence: null })
    expect(output.sendText).toHaveBeenCalledOnce()
    expect(output.editText).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({
      status: 'ready', checkpoint: { phase: 'prepared', delivery: 'pending' },
    })
    expect(JSON.stringify(store.load())).not.toContain('messageId')
    expect(supervisor.lease.isHeld()).toBe(false)
  })

  it.each(['fake', 'copy', 'proxy'] as const)(
    'rejects %s lease provenance before checkpoint reads or Telegram I/O',
    async (kind) => {
      const supervisor = await genuineRecoveryLease()
      const fake = Object.freeze({
        bindingHash: BINDING,
        authorityPhase: 'checkpoint-bound' as const,
        isHeld: () => true,
        bindCheckpoint: async () => undefined,
        release: async () => undefined,
        failClosed(): never { throw new Error('unused') },
      })
      const lease = kind === 'fake'
        ? fake
        : kind === 'copy'
          ? { ...supervisor.lease }
          : new Proxy(supervisor.lease, {})
      const load = vi.fn(() => ({ status: 'missing' as const }))
      const store = { load, begin: vi.fn(), replace: vi.fn() }
      const output = { sendText: vi.fn(), editText: vi.fn() }

      await expect(recoverTelegramExecutionWithHeldLease({
        store,
        lease,
        output,
        newOwnerId: () => 'must-not-run',
      })).resolves.toEqual({
        kind: 'denied', code: 'SERVICE_MANAGER_AUTHORITY_INVALID', evidence: null,
      })
      expect(load).not.toHaveBeenCalled()
      expect(store.begin).not.toHaveBeenCalled()
      expect(store.replace).not.toHaveBeenCalled()
      expect(output.sendText).not.toHaveBeenCalled()
      expect(output.editText).not.toHaveBeenCalled()
      expect(supervisor.lease.isHeld()).toBe(true)
    },
  )

  it('refuses durable evidence from an unbranded checkpoint store', async () => {
    const terminal = terminalCheckpoint('delivered')
    const store = makeJsonTelegramExecutionCheckpointStore({
      exists: () => true,
      read: () => JSON.stringify(terminal),
      saveAtomic: vi.fn(),
    })
    const supervisor = await genuineRecoveryLease()
    await expect(recoverTelegramExecutionWithHeldLease({
      store,
      lease: supervisor.lease,
      output: { sendText: vi.fn(), editText: vi.fn() },
      newOwnerId: () => 'unused',
    })).resolves.toEqual({
      kind: 'incomplete', code: 'DELIVERY_EVIDENCE_UNAVAILABLE', evidence: null,
    })
    expect(supervisor.lease.isHeld()).toBe(true)
    const receipt = makeTelegramExecutionDeliveryReceipt(terminal)
    expect(receipt).not.toBeNull()
    expect(confirmTelegramExecutionCheckpointDelivery({
      store,
      bindingHash: BINDING,
      expectedReceipt: receipt!,
    })).toEqual({ kind: 'unavailable' })
  })
})

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  recoverExecutionSupervisorRestartBudget,
  runExecutionSupervisorRecoveryCli,
} from './execution-supervisor-recovery.js'
import {
  withExecutionSupervisorStateChecksum,
  makeNodeExecutionSupervisorStateStore,
  type ExecutionSupervisorState,
  type ExecutionSupervisorStateV2,
  type ExecutionSupervisorStateStore,
} from './supervisor-state.js'
import {
  acquireExecutionSupervisorChildLivenessLease,
  resolveExecutionSupervisorChildLivenessRoot,
} from './execution-supervisor-liveness.js'

const epoch = 'epoch_abcdefghijklmnop'
const hash = 'a'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function state(
  overrides: Partial<ExecutionSupervisorState['restart']> = {},
): ExecutionSupervisorStateV2 {
  return withExecutionSupervisorStateChecksum({
    schemaVersion: 2,
    revision: 7,
    manager: { epoch, cleanShutdown: false, startedAtMs: 100 },
    authority: {
      phase: 'captured-unbound',
      bindingHash: hash,
      leaseId: 'lease_abcdefghijklmnop',
      capturedAtMs: 101,
    },
    releaseReceipt: null,
    restart: {
      unexpectedExitMs: [1, 2, 3, 4, 5],
      consecutiveUnexpectedExits: 5,
      quarantine: { code: 'RESTART_BUDGET_EXHAUSTED', atMs: 5 },
      ...overrides,
    },
  })
}

function harness(current: ExecutionSupervisorState | 'missing' | 'refused' = state()) {
  const audit: string[] = []
  const manager = {
    isHeld: vi.fn(() => true),
    release: vi.fn(() => { audit.push('manager.release') }),
  }
  const runtime = {
    descriptor: { version: 1 as const, path: '/private/runtime.sqlite3', dev: '1', ino: '2' },
    descriptorHash: hash,
    isHeld: vi.fn(() => true),
    onLost: vi.fn(() => () => {}),
    release: vi.fn(() => { audit.push('runtime.release') }),
  }
  let published: ExecutionSupervisorState | null = null
  const store: ExecutionSupervisorStateStore = {
    acquireManagerLease: vi.fn(() => { audit.push('manager.acquire'); return manager }),
    acquireChildLivenessFence: vi.fn(async () => { audit.push('runtime.acquire'); return runtime }),
    load: vi.fn(() => {
      audit.push('state.load')
      if (current === 'missing') return { kind: 'missing' as const }
      if (current === 'refused') return { kind: 'refused' as const, code: 'CORRUPT_STATE' as const }
      return { kind: 'ready' as const, state: current }
    }),
    publish: vi.fn((candidate) => { audit.push('state.publish'); published = candidate }),
  }
  return { store, manager, runtime, audit, published: () => published }
}

describe('execution supervisor restart-budget recovery', () => {
  it('clears only restart-budget evidence after manager and runtime quiescence', async () => {
    const original = state()
    const h = harness(original)

    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'recovered', revision: 8 })

    expect(h.audit).toEqual([
      'manager.acquire', 'runtime.acquire', 'state.load', 'state.publish',
      'runtime.release', 'manager.release',
    ])
    expect(h.published()).toMatchObject({
      revision: 8,
      manager: { ...original.manager, cleanShutdown: true },
      authority: original.authority,
      releaseReceipt: original.releaseReceipt,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
  })

  it.each([
    ['missing', 'SUPERVISOR_RECOVERY_STATE_MISSING'],
    ['refused', 'SUPERVISOR_RECOVERY_STATE_UNAVAILABLE'],
  ] as const)('refuses %s state without publication', async (current, code) => {
    const h = harness(current)
    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'refused', code })
    expect(h.store.publish).not.toHaveBeenCalled()
    expect(h.runtime.release).toHaveBeenCalledOnce()
    expect(h.manager.release).toHaveBeenCalledOnce()
  })

  it('refuses every quarantine code except restart-budget exhaustion', async () => {
    const h = harness(state({ quarantine: { code: 'SUPERVISOR_PREVIOUS_EXIT_UNCLEAN', atMs: 5 } }))
    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_QUARANTINE_NOT_RECOVERABLE',
    })
    expect(h.store.publish).not.toHaveBeenCalled()
  })

  it('refuses an ordinary clean state and a repeat after success without mutation', async () => {
    let current = withExecutionSupervisorStateChecksum({
      schemaVersion: 2,
      revision: 7,
      manager: { epoch, cleanShutdown: true, startedAtMs: 100 },
      authority: null,
      releaseReceipt: null,
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    let publishes = 0
    const manager = { isHeld: () => true, release: vi.fn() }
    const runtime = {
      descriptor: { version: 1 as const, path: '/private/runtime.sqlite3', dev: '1', ino: '2' },
      descriptorHash: hash,
      isHeld: () => true,
      onLost: () => () => {},
      release: vi.fn(),
    }
    const store: ExecutionSupervisorStateStore = {
      acquireManagerLease: () => manager,
      acquireChildLivenessFence: async () => runtime,
      load: () => ({ kind: 'ready', state: current }),
      publish: (candidate) => { publishes += 1; current = candidate },
    }
    await expect(recoverExecutionSupervisorRestartBudget({
      state: store, signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_QUARANTINE_NOT_RECOVERABLE',
    })
    expect(publishes).toBe(0)

    current = state()
    await expect(recoverExecutionSupervisorRestartBudget({
      state: store, signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'recovered', revision: 8 })
    expect(publishes).toBe(1)
    await expect(recoverExecutionSupervisorRestartBudget({
      state: store, signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_QUARANTINE_NOT_RECOVERABLE',
    })
    expect(publishes).toBe(1)
    expect(current.revision).toBe(8)
  })

  it('does not read state when the manager lease is unavailable', async () => {
    const h = harness()
    vi.mocked(h.store.acquireManagerLease).mockImplementation(() => { throw new Error('busy') })
    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_MANAGER_NOT_QUIESCENT',
    })
    expect(h.store.acquireChildLivenessFence).not.toHaveBeenCalled()
    expect(h.store.load).not.toHaveBeenCalled()
  })

  it('does not read state when runtime quiescence cannot be proven', async () => {
    const h = harness()
    vi.mocked(h.store.acquireChildLivenessFence).mockRejectedValue(new Error('busy'))
    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT',
    })
    expect(h.store.load).not.toHaveBeenCalled()
    expect(h.manager.release).toHaveBeenCalledOnce()
  })

  it('returns a code-only refusal when atomic publication fails', async () => {
    const h = harness()
    vi.mocked(h.store.publish).mockImplementation(() => { throw new Error('disk detail') })
    await expect(recoverExecutionSupervisorRestartBudget({
      state: h.store,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'refused', code: 'SUPERVISOR_RECOVERY_STATE_UNAVAILABLE',
    })
    expect(h.runtime.release).toHaveBeenCalledOnce()
    expect(h.manager.release).toHaveBeenCalledOnce()
  })

  it('seals an exact post-rename ambiguous candidate with one new revision', async () => {
    let current: ExecutionSupervisorState = state()
    let publishes = 0
    const manager = { isHeld: () => true, release: vi.fn() }
    const runtime = {
      descriptor: { version: 1 as const, path: '/private/runtime.sqlite3', dev: '1', ino: '2' },
      descriptorHash: hash,
      isHeld: () => true,
      onLost: () => () => {},
      release: vi.fn(),
    }
    const store: ExecutionSupervisorStateStore = {
      acquireManagerLease: () => manager,
      acquireChildLivenessFence: async () => runtime,
      load: () => ({ kind: 'ready', state: current }),
      publish: (candidate) => {
        current = candidate
        publishes += 1
        if (publishes === 1) throw new Error('after-rename')
      },
    }

    await expect(recoverExecutionSupervisorRestartBudget({
      state: store,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: 'recovered', revision: 9 })
    expect(current).toMatchObject({
      revision: 9,
      manager: { cleanShutdown: true },
      restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
    })
    expect(publishes).toBe(2)
  })

  it('requires the exact operator acknowledgement in the CLI', async () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    const recover = vi.fn(async () => ({ kind: 'recovered' as const, revision: 8 }))
    await expect(runExecutionSupervisorRecoveryCli(['recover-restart-budget'], {
      recover, stdout, stderr,
    })).resolves.toBe(64)
    expect(recover).not.toHaveBeenCalled()
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--ack=RESTART_BUDGET_EXHAUSTED'))
  })

  it('renders only stable recovery codes and the new revision', async () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    await expect(runExecutionSupervisorRecoveryCli([
      'recover-restart-budget', '--ack=RESTART_BUDGET_EXHAUSTED',
    ], {
      recover: async () => ({ kind: 'recovered', revision: 8 }), stdout, stderr,
    })).resolves.toBe(0)
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('revision=8'))
    expect(stderr).not.toHaveBeenCalled()

    stdout.mockClear()
    await expect(runExecutionSupervisorRecoveryCli([
      'recover-restart-budget', '--ack=RESTART_BUDGET_EXHAUSTED',
    ], {
      recover: async () => ({
        kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT',
      }), stdout, stderr,
    })).resolves.toBe(70)
    expect(stderr).toHaveBeenLastCalledWith('aisy: SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT\n')
    expect(stdout).not.toHaveBeenCalled()
  })

  it('turns an unexpected state-root failure into one code-only refusal', async () => {
    const stdout = vi.fn()
    const stderr = vi.fn()
    await expect(runExecutionSupervisorRecoveryCli([
      'recover-restart-budget', '--ack=RESTART_BUDGET_EXHAUSTED',
    ], {
      recover: async () => { throw new Error('/private/operator/state-root') },
      stdout,
      stderr,
    })).resolves.toBe(70)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith('aisy: SUPERVISOR_RECOVERY_STATE_UNAVAILABLE\n')
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('/private/operator/state-root')
  })
})

describe('execution supervisor recovery with the production state store', () => {
  function seededRoot(seed: ExecutionSupervisorStateV2): string {
    const outer = mkdtempSync(join(tmpdir(), 'aisy-supervisor-recovery-'))
    roots.push(outer)
    const root = join(outer, 'state')
    const store = makeNodeExecutionSupervisorStateStore({ root })
    const manager = store.acquireManagerLease()
    store.publish(seed)
    manager.release()
    return root
  }

  async function load(root: string): Promise<ExecutionSupervisorState> {
    const store = makeNodeExecutionSupervisorStateStore({ root })
    const manager = store.acquireManagerLease()
    try {
      const loaded = store.load()
      if (loaded.kind !== 'ready') throw new Error('state unavailable')
      return loaded.state
    } finally {
      manager.release()
    }
  }

  it.each(['authority', 'release-receipt'] as const)(
    'durably reopens the recovered revision while preserving %s',
    async (variant) => {
      const original = variant === 'authority'
        ? state()
        : withExecutionSupervisorStateChecksum({
            schemaVersion: 2,
            revision: 7,
            manager: { epoch, cleanShutdown: false, startedAtMs: 100 },
            authority: null,
            releaseReceipt: {
              releaseIntentHash: 'b'.repeat(64),
              envelopeHash: 'c'.repeat(64),
              receiptHash: 'd'.repeat(64),
              bindingHash: 'e'.repeat(64),
              runLivenessHash: 'f'.repeat(64),
              authorityPhase: 'checkpoint-bound' as const,
              releasedAtMs: 102,
            },
            restart: {
              unexpectedExitMs: [1, 2, 3, 4, 5],
              consecutiveUnexpectedExits: 5,
              quarantine: { code: 'RESTART_BUDGET_EXHAUSTED' as const, atMs: 5 },
            },
          })
      const root = seededRoot(original)
      const store = makeNodeExecutionSupervisorStateStore({ root })

      await expect(recoverExecutionSupervisorRestartBudget({
        state: store,
        signal: new AbortController().signal,
      })).resolves.toEqual({ kind: 'recovered', revision: 8 })

      const reopened = await load(root)
      expect(reopened).toMatchObject({
        schemaVersion: 2,
        revision: 8,
        manager: { ...original.manager, cleanShutdown: true },
        authority: original.authority,
        restart: { unexpectedExitMs: [], consecutiveUnexpectedExits: 0, quarantine: null },
      })
      if (reopened.schemaVersion !== 2) throw new Error('legacy state after recovery')
      expect(reopened.releaseReceipt).toEqual(original.releaseReceipt)
    },
  )

  it('keeps bytes unchanged while a real manager lease is busy', async () => {
    const root = seededRoot(state())
    const before = readFileSync(join(root, 'state.json'), 'utf8')
    const owner = makeNodeExecutionSupervisorStateStore({ root })
    const ownerLease = owner.acquireManagerLease()
    try {
      await expect(recoverExecutionSupervisorRestartBudget({
        state: makeNodeExecutionSupervisorStateStore({ root }),
        signal: new AbortController().signal,
      })).resolves.toEqual({
        kind: 'refused', code: 'SUPERVISOR_RECOVERY_MANAGER_NOT_QUIESCENT',
      })
      expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(before)
    } finally {
      ownerLease.release()
    }
  })

  it('keeps bytes unchanged while a real runtime-liveness lease is busy', async () => {
    const root = seededRoot(state())
    const before = readFileSync(join(root, 'state.json'), 'utf8')
    const runtime = acquireExecutionSupervisorChildLivenessLease({
      root: resolveExecutionSupervisorChildLivenessRoot(root),
    })
    try {
      await expect(recoverExecutionSupervisorRestartBudget({
        state: makeNodeExecutionSupervisorStateStore({ root }),
        signal: AbortSignal.timeout(25),
      })).resolves.toEqual({
        kind: 'refused', code: 'SUPERVISOR_RECOVERY_RUNTIME_NOT_QUIESCENT',
      })
      expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(before)
    } finally {
      runtime.release()
    }
  })
})

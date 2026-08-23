import { describe, expect, it } from 'vitest'

import {
  CorruptBrainBootstrapState,
  InvalidBrainBootstrapTransition,
  makeBrainBootstrap,
  type BrainBootstrapState,
  type BrainBootstrapStore,
} from './brain-bootstrap.js'

function makeStore(initial: BrainBootstrapState | null = null): BrainBootstrapStore & {
  saved: BrainBootstrapState[]
  failNext: boolean
} {
  let current = initial
  const saved: BrainBootstrapState[] = []
  return {
    saved,
    failNext: false,
    async load() {
      return current === null ? null : structuredClone(current)
    },
    async save(state) {
      if (this.failNext) {
        this.failNext = false
        throw new Error('persistence unavailable')
      }
      current = structuredClone(state)
      saved.push(structuredClone(state))
    },
  }
}

function clock() {
  let tick = 0
  return () => `2026-07-26T12:00:${String(tick++).padStart(2, '0')}.000Z`
}

async function pairAndSelectApi(store = makeStore()) {
  const flow = makeBrainBootstrap({ store, nowIso: clock() })
  await flow.dispatch({ type: 'telegram-paired' })
  await flow.dispatch({
    type: 'brain-selected',
    connectionId: 'brain-openai-1',
    provider: 'openai',
    authMode: 'api-key',
    runtime: 'native-api',
    requiresInstall: false,
  })
  return { flow, store }
}

describe('brain bootstrap state machine (ADR-0058)', () => {
  it('AC-16-1: starts without a brain and does not persist merely by reading state', async () => {
    const store = makeStore()
    const flow = makeBrainBootstrap({ store, nowIso: clock() })

    expect(await flow.state()).toMatchObject({ version: 1, phase: 'NO_BRAIN', revision: 0 })
    expect(store.saved).toHaveLength(0)
  })

  it('AC-16-2: API selection skips runtime installation and waits for auth', async () => {
    const { flow } = await pairAndSelectApi()

    expect(await flow.state()).toMatchObject({
      phase: 'AWAITING_AUTH',
      selectedBrain: {
        provider: 'openai',
        authMode: 'api-key',
        runtime: 'native-api',
        status: 'auth-required',
      },
    })
  })

  it('AC-16-3: subscription runtime must install before auth can continue', async () => {
    const store = makeStore()
    const flow = makeBrainBootstrap({ store, nowIso: clock() })
    await flow.dispatch({ type: 'telegram-paired' })
    await flow.dispatch({
      type: 'brain-selected',
      connectionId: 'brain-codex-1',
      provider: 'codex',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      requiresInstall: true,
    })

    expect((await flow.state()).phase).toBe('INSTALLING_RUNTIME')
    await expect(flow.dispatch({ type: 'auth-completed' })).rejects.toBeInstanceOf(InvalidBrainBootstrapTransition)

    const installed = await flow.dispatch({ type: 'runtime-installed' })
    expect(installed).toMatchObject({
      phase: 'AWAITING_AUTH',
      selectedBrain: { status: 'auth-required' },
    })
  })

  it('keeps runtime installation failure retryable with a stable code', async () => {
    const store = makeStore()
    const flow = makeBrainBootstrap({ store, nowIso: clock() })
    await flow.dispatch({ type: 'telegram-paired' })
    await flow.dispatch({
      type: 'brain-selected',
      connectionId: 'brain-codex-1',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      requiresInstall: true,
    })

    const failed = await flow.dispatch({
      type: 'runtime-install-failed',
      errorCode: 'RUNTIME_INSTALL_FAILED',
    })
    expect(failed).toMatchObject({
      phase: 'INSTALLING_RUNTIME',
      lastErrorCode: 'RUNTIME_INSTALL_FAILED',
      selectedBrain: { status: 'failed' },
    })
    expect((await flow.dispatch({ type: 'runtime-installed' })).phase).toBe('AWAITING_AUTH')
  })

  it('AC-16-4: a validated brain advances through deterministic personal onboarding', async () => {
    const { flow } = await pairAndSelectApi()

    expect((await flow.dispatch({ type: 'auth-completed' })).phase).toBe('VALIDATING_AUTH')
    expect((await flow.dispatch({ type: 'validation-succeeded' })).phase).toBe('BRAIN_READY')
    expect((await flow.dispatch({ type: 'brain-ready-acknowledged' })).phase).toBe('INTRO_AGENT')
    expect((await flow.dispatch({ type: 'agent-intro-completed' })).phase).toBe('INTRO_OPERATOR')
    expect((await flow.dispatch({ type: 'operator-intro-completed' })).phase).toBe('FIRST_PROJECT')
    expect((await flow.dispatch({ type: 'first-project-completed' })).phase).toBe('INITIAL_AUTONOMY')
    expect((await flow.dispatch({ type: 'initial-autonomy-completed' })).phase).toBe('COMPLETE')
  })

  it('AC-16-5: validation failure is redaction-safe, retryable, and never marks the brain ready', async () => {
    const { flow, store } = await pairAndSelectApi()
    await flow.dispatch({ type: 'auth-completed' })

    const failed = await flow.dispatch({ type: 'validation-failed', errorCode: 'CREDENTIAL_REJECTED' })
    expect(failed).toMatchObject({
      phase: 'AWAITING_AUTH',
      lastErrorCode: 'CREDENTIAL_REJECTED',
      selectedBrain: { status: 'failed' },
    })
    expect(JSON.stringify(store.saved)).not.toContain('sk-')

    expect((await flow.dispatch({ type: 'auth-completed' })).phase).toBe('VALIDATING_AUTH')
    expect((await flow.dispatch({ type: 'validation-succeeded' })).phase).toBe('BRAIN_READY')
  })

  it('AC-16-6: a new instance resumes the exact persisted phase and revision', async () => {
    const { flow, store } = await pairAndSelectApi()
    await flow.dispatch({ type: 'auth-completed' })
    const before = await flow.state()

    const resumed = makeBrainBootstrap({ store, nowIso: clock() })
    expect(await resumed.state()).toEqual(before)
  })

  it('AC-16-7: failed persistence leaves the observable state unchanged', async () => {
    const store = makeStore()
    const flow = makeBrainBootstrap({ store, nowIso: clock() })
    store.failNext = true

    await expect(flow.dispatch({ type: 'telegram-paired' })).rejects.toThrow('persistence unavailable')
    expect((await flow.state()).phase).toBe('NO_BRAIN')
    expect(store.saved).toHaveLength(0)
  })

  it('AC-16-8: corrupt persisted state fails closed', async () => {
    const corrupt = {
      version: 1,
      phase: 'BRAIN_READY',
      revision: 3,
      updatedAt: '2026-07-26T12:00:00.000Z',
    } as BrainBootstrapState
    const flow = makeBrainBootstrap({ store: makeStore(corrupt), nowIso: clock() })

    await expect(flow.state()).rejects.toBeInstanceOf(CorruptBrainBootstrapState)
  })

  it('AC-16-9: transition events contain state metadata only, never auth material', async () => {
    const payloads: unknown[] = []
    const flow = makeBrainBootstrap({
      store: makeStore(),
      nowIso: clock(),
      events: { emit: (_event, payload) => payloads.push(payload) },
    })
    await flow.dispatch({ type: 'telegram-paired' })

    expect(payloads).toEqual([{
      from: 'NO_BRAIN',
      to: 'CHOOSE_BRAIN',
      eventType: 'telegram-paired',
      revision: 1,
    }])
    expect(JSON.stringify(payloads)).not.toMatch(/token|secret|credential/i)
  })
})

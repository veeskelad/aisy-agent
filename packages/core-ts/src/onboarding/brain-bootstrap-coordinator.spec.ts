import { describe, expect, it } from 'vitest'
import {
  makeBrainBootstrap,
  type BrainBootstrapState,
  type BrainBootstrapStore,
} from './brain-bootstrap.js'
import {
  BrainBootstrapCoordinatorError,
  makeBrainBootstrapCoordinator,
  type BrainConnectionSetupDriver,
} from './brain-bootstrap-coordinator.js'

const SELECTION = {
  connectionId: 'codex-subscription',
  provider: 'openai',
  authMode: 'subscription' as const,
  runtime: 'codex-app-server' as const,
  requiresInstall: true,
}

function store(initial: BrainBootstrapState | null = null): BrainBootstrapStore & {
  current(): BrainBootstrapState | null
  writes: BrainBootstrapState[]
} {
  let value = initial
  const writes: BrainBootstrapState[] = []
  return {
    writes,
    current: () => value === null ? null : structuredClone(value),
    load: async () => value === null ? null : structuredClone(value),
    save: async (next) => {
      value = structuredClone(next)
      writes.push(structuredClone(next))
    },
  }
}

function clock() {
  let tick = 0
  return () => `2026-07-27T10:00:${String(tick++).padStart(2, '0')}.000Z`
}

function setupDriver(overrides: Partial<BrainConnectionSetupDriver> = {}) {
  const calls: string[] = []
  const driver: BrainConnectionSetupDriver = {
    connectionId: SELECTION.connectionId,
    provider: SELECTION.provider,
    authMode: SELECTION.authMode,
    runtime: SELECTION.runtime,
    detect: async () => { calls.push('detect'); return { installed: false } },
    install: async () => {
      calls.push('install')
      return { installed: true, safeDetail: 'installed' }
    },
    beginAuth: async () => {
      calls.push('beginAuth')
      return {
        kind: 'device-code',
        verificationUri: 'https://auth.example/activate',
        userCode: 'ABCD-1234',
      }
    },
    validate: async () => {
      calls.push('validate')
      return { ok: true, safeDetail: 'ready' }
    },
    revoke: async () => {
      calls.push('revoke')
      return { ok: true, safeDetail: 'revoked' }
    },
    ...overrides,
  }
  return { calls, driver }
}

async function paired(inputStore = store()) {
  const bootstrap = makeBrainBootstrap({ store: inputStore, nowIso: clock() })
  await bootstrap.dispatch({ type: 'telegram-paired' })
  return { bootstrap, inputStore }
}

describe('brain bootstrap coordinator', () => {
  it('detects, installs and persists the selected runtime before auth', async () => {
    const { bootstrap } = await paired()
    const fixture = setupDriver()
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })

    const result = await coordinator.selectAndPrepare(SELECTION, 1)

    expect(result.state).toMatchObject({
      phase: 'AWAITING_AUTH', revision: 3,
      selectedBrain: { connectionId: SELECTION.connectionId, status: 'auth-required' },
    })
    expect(fixture.calls).toEqual(['detect', 'install'])
  })

  it('skips installation when the official runtime is already detected', async () => {
    const { bootstrap } = await paired()
    const fixture = setupDriver({ detect: async () => {
      fixture.calls.push('detect')
      return { installed: true, version: '1.0.0' }
    } })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })

    await coordinator.selectAndPrepare(SELECTION, 1)

    expect(fixture.calls).toEqual(['detect'])
  })

  it('stores only a stable installation error and allows an exact-revision retry', async () => {
    const { bootstrap, inputStore } = await paired()
    let succeeds = false
    const fixture = setupDriver({
      detect: async () => ({ installed: false }),
      install: async () => ({ installed: succeeds, safeDetail: 'local runtime output' }),
    })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const failed = await coordinator.selectAndPrepare(SELECTION, 1)
    expect(failed).toMatchObject({
      errorCode: 'RUNTIME_INSTALL_FAILED',
      state: { phase: 'INSTALLING_RUNTIME', revision: 3, lastErrorCode: 'RUNTIME_INSTALL_FAILED' },
    })
    expect(JSON.stringify(inputStore.writes)).not.toContain('local runtime output')

    succeeds = true
    await expect(coordinator.retryInstallation(3)).resolves.toMatchObject({
      state: { phase: 'AWAITING_AUTH', revision: 4 },
    })
  })

  it('returns a validated challenge once per revision without persisting it', async () => {
    const { bootstrap, inputStore } = await paired()
    const fixture = setupDriver()
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const prepared = await coordinator.selectAndPrepare(SELECTION, 1)

    const challenge = await coordinator.beginAuth(prepared.state.revision)

    expect(challenge.challenge).toEqual({
      kind: 'device-code',
      verificationUri: 'https://auth.example/activate',
      userCode: 'ABCD-1234',
    })
    expect(challenge.state.revision).toBe(prepared.state.revision)
    expect(JSON.stringify(inputStore.writes)).not.toContain('ABCD-1234')
    await expect(coordinator.beginAuth(prepared.state.revision)).rejects.toEqual(
      new BrainBootstrapCoordinatorError('AUTH_ALREADY_STARTED'),
    )
  })

  it('rejects an unsafe auth challenge and stores no driver material', async () => {
    const { bootstrap, inputStore } = await paired()
    const fixture = setupDriver({
      beginAuth: async () => ({
        kind: 'browser',
        authorizationUri: 'http://unsafe.example/login',
        safeInstructions: 'x'.repeat(60),
      }),
    })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const prepared = await coordinator.selectAndPrepare(SELECTION, 1)

    const failed = await coordinator.beginAuth(prepared.state.revision)

    expect(failed).toMatchObject({
      errorCode: 'BRAIN_AUTH_START_FAILED',
      state: { phase: 'AWAITING_AUTH', lastErrorCode: 'BRAIN_AUTH_START_FAILED' },
    })
    expect(JSON.stringify(inputStore.writes)).not.toContain('unsafe.example')
  })

  it('validates to BRAIN_READY and sanitizes a non-stable driver error code', async () => {
    const { bootstrap } = await paired()
    let ok = false
    const fixture = setupDriver({
      validate: async () => ok
        ? { ok: true, safeDetail: 'ready' }
        : { ok: false, safeDetail: 'raw provider body', errorCode: 'bad detail from provider' },
    })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const prepared = await coordinator.selectAndPrepare(SELECTION, 1)

    const failed = await coordinator.completeAuth(prepared.state.revision)
    expect(failed).toMatchObject({
      errorCode: 'BRAIN_VALIDATION_FAILED',
      state: { phase: 'AWAITING_AUTH', lastErrorCode: 'BRAIN_VALIDATION_FAILED' },
    })
    ok = true
    await expect(coordinator.completeAuth(failed.state.revision)).resolves.toMatchObject({
      state: { phase: 'BRAIN_READY' },
    })
  })

  it('resumes an interrupted validation after a fresh coordinator instance', async () => {
    const durable = store()
    const { bootstrap } = await paired(durable)
    const fixture = setupDriver()
    const first = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const prepared = await first.selectAndPrepare(SELECTION, 1)
    const validating = await bootstrap.dispatch({ type: 'auth-completed' })
    expect(validating.phase).toBe('VALIDATING_AUTH')

    const restartedBootstrap = makeBrainBootstrap({ store: durable, nowIso: clock() })
    const restarted = makeBrainBootstrapCoordinator({
      bootstrap: restartedBootstrap,
      drivers: [fixture.driver],
    })
    await expect(restarted.resume(validating.revision)).resolves.toMatchObject({
      state: { phase: 'BRAIN_READY', revision: validating.revision + 1 },
    })
    expect((await restartedBootstrap.state()).phase).toBe('BRAIN_READY')
    expect(prepared.state.phase).toBe('AWAITING_AUTH')
  })

  it('resumes no-op bootstrap phases without resolving a driver', async () => {
    const freshStore = store()
    const bootstrap = makeBrainBootstrap({ store: freshStore, nowIso: clock() })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [] })
    await expect(coordinator.resume(0)).resolves.toMatchObject({
      state: { phase: 'NO_BRAIN', revision: 0 },
    })
    await bootstrap.dispatch({ type: 'telegram-paired' })
    await expect(coordinator.resume(1)).resolves.toMatchObject({
      state: { phase: 'CHOOSE_BRAIN', revision: 1 },
    })
  })

  it('serializes stale concurrent selection and validates exact driver metadata', async () => {
    const { bootstrap } = await paired()
    const fixture = setupDriver()
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const [first, replay] = await Promise.allSettled([
      coordinator.selectAndPrepare(SELECTION, 1),
      coordinator.selectAndPrepare(SELECTION, 1),
    ])

    expect(first.status).toBe('fulfilled')
    expect(replay).toEqual(expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'STALE_REVISION' }),
    }))

    const another = await paired()
    const mismatched = makeBrainBootstrapCoordinator({
      bootstrap: another.bootstrap,
      drivers: [{ ...fixture.driver, provider: 'wrong-provider' }],
    })
    await expect(mismatched.selectAndPrepare(SELECTION, 1)).rejects.toEqual(
      new BrainBootstrapCoordinatorError('DRIVER_BINDING_MISMATCH'),
    )
    expect((await another.bootstrap.state()).phase).toBe('CHOOSE_BRAIN')
  })

  it('performs non-mutating health checks and resets metadata only after revoke succeeds', async () => {
    const { bootstrap } = await paired()
    let revokeOk = false
    const fixture = setupDriver({
      revoke: async () => revokeOk
        ? { ok: true, safeDetail: 'revoked' }
        : { ok: false, safeDetail: 'provider refusal', errorCode: 'REVOKE_REFUSED' },
    })
    const coordinator = makeBrainBootstrapCoordinator({ bootstrap, drivers: [fixture.driver] })
    const prepared = await coordinator.selectAndPrepare(SELECTION, 1)
    const ready = await coordinator.completeAuth(prepared.state.revision)

    await expect(coordinator.health(ready.state.revision)).resolves.toMatchObject({
      state: { revision: ready.state.revision }, healthy: true,
    })
    const refused = await coordinator.revoke(ready.state.revision)
    expect(refused).toMatchObject({
      state: { phase: 'BRAIN_READY', revision: ready.state.revision },
      errorCode: 'REVOKE_REFUSED',
    })
    revokeOk = true
    await expect(coordinator.revoke(ready.state.revision)).resolves.toMatchObject({
      state: { phase: 'CHOOSE_BRAIN', revision: ready.state.revision + 1 },
    })
  })
})

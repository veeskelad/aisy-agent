import type {
  AuthChallenge,
  BrainAuthMode,
  BrainDetectionResult,
  BrainInstallResult,
  BrainRuntime,
  BrainValidationResult,
} from './brain-connections.js'
import type {
  BrainBootstrap,
  BrainBootstrapState,
  SelectedBrain,
} from './brain-bootstrap.js'

export interface BrainConnectionSetupDriver {
  readonly connectionId: string
  readonly provider: string
  readonly authMode: BrainAuthMode
  readonly runtime: BrainRuntime
  detect(): Promise<BrainDetectionResult>
  install(): Promise<BrainInstallResult>
  beginAuth(): Promise<AuthChallenge>
  validate(): Promise<BrainValidationResult>
  revoke(): Promise<BrainValidationResult>
}

export interface BrainBootstrapCoordinatorResult {
  state: BrainBootstrapState
  challenge?: AuthChallenge
  errorCode?: string
  /**
   * The driver's own operator-safe explanation for `errorCode`. A stable code
   * tells the operator that something failed; only this tells them what, and
   * without it the card can offer nothing but "try again".
   */
  safeDetail?: string
  healthy?: boolean
}

export interface BrainBootstrapSelection {
  connectionId: string
  provider: string
  authMode: BrainAuthMode
  runtime: BrainRuntime
  requiresInstall: boolean
}

export interface BrainBootstrapCoordinator {
  selectAndPrepare(
    selection: BrainBootstrapSelection,
    expectedRevision: number,
  ): Promise<BrainBootstrapCoordinatorResult>
  retryInstallation(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
  beginAuth(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
  completeAuth(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
  resume(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
  health(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
  revoke(expectedRevision: number): Promise<BrainBootstrapCoordinatorResult>
}

export class BrainBootstrapCoordinatorError extends Error {
  constructor(public readonly code:
    | 'INVALID_CONFIGURATION'
    | 'STALE_REVISION'
    | 'INVALID_PHASE'
    | 'DRIVER_NOT_FOUND'
    | 'DRIVER_BINDING_MISMATCH'
    | 'AUTH_ALREADY_STARTED') {
    super(code)
    this.name = 'BrainBootstrapCoordinatorError'
  }
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const SAFE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]{1,500}$/u
const LONG_TOKENISH_VALUE = /\b[A-Za-z0-9._~-]{40,}\b/

function stableCode(value: string | undefined, fallback: string): string {
  return value !== undefined && CODE.test(value) ? value : fallback
}

function safeHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function safeInstruction(value: string): boolean {
  return SAFE_TEXT.test(value) && !LONG_TOKENISH_VALUE.test(value)
}

function validateChallenge(challenge: AuthChallenge): AuthChallenge {
  if ('verificationUri' in challenge) {
    if (!safeHttps(challenge.verificationUri) ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{3,31}$/.test(challenge.userCode) ||
      (challenge.expiresAt !== undefined && !Number.isFinite(Date.parse(challenge.expiresAt)))) {
      throw new Error('unsafe challenge')
    }
    return structuredClone(challenge)
  }
  if ('authorizationUri' in challenge) {
    if (!safeHttps(challenge.authorizationUri) || !safeInstruction(challenge.safeInstructions)) {
      throw new Error('unsafe challenge')
    }
    return structuredClone(challenge)
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(challenge.provider) ||
    !safeInstruction(challenge.safeInstructions) ||
    typeof challenge.secureEntryAvailable !== 'boolean') {
    throw new Error('unsafe challenge')
  }
  return structuredClone(challenge)
}

function sameDriver(driver: BrainConnectionSetupDriver, selected: SelectedBrain): boolean {
  return driver.connectionId === selected.connectionId &&
    driver.provider === selected.provider &&
    driver.authMode === selected.authMode &&
    driver.runtime === selected.runtime
}

export function makeBrainBootstrapCoordinator(input: {
  bootstrap: BrainBootstrap
  drivers: readonly BrainConnectionSetupDriver[]
}): BrainBootstrapCoordinator {
  const drivers = new Map<string, BrainConnectionSetupDriver>()
  for (const driver of input.drivers) {
    if (driver.connectionId.trim().length === 0 || driver.provider.trim().length === 0 ||
      drivers.has(driver.connectionId)) {
      throw new BrainBootstrapCoordinatorError('INVALID_CONFIGURATION')
    }
    drivers.set(driver.connectionId, driver)
  }
  let tail: Promise<void> = Promise.resolve()
  let authStartedAtRevision: number | null = null

  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run, run)
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  const current = async (expectedRevision: number): Promise<BrainBootstrapState> => {
    const state = await input.bootstrap.state()
    if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision) {
      throw new BrainBootstrapCoordinatorError('STALE_REVISION')
    }
    return state
  }

  const driverFor = (selected: SelectedBrain | undefined): BrainConnectionSetupDriver => {
    if (!selected) throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
    const driver = drivers.get(selected.connectionId)
    if (!driver) throw new BrainBootstrapCoordinatorError('DRIVER_NOT_FOUND')
    if (!sameDriver(driver, selected)) {
      throw new BrainBootstrapCoordinatorError('DRIVER_BINDING_MISMATCH')
    }
    return driver
  }

  const prepare = async (
    state: BrainBootstrapState,
    driver: BrainConnectionSetupDriver,
  ): Promise<BrainBootstrapCoordinatorResult> => {
    if (state.phase !== 'INSTALLING_RUNTIME') {
      throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
    }
    try {
      const detected = await driver.detect()
      if (!detected.installed) {
        const installed = await driver.install()
        if (!installed.installed) {
          const failed = await input.bootstrap.dispatch({
            type: 'runtime-install-failed', errorCode: 'RUNTIME_INSTALL_FAILED',
          })
          return {
            state: failed,
            errorCode: 'RUNTIME_INSTALL_FAILED',
            ...(installed.safeDetail === undefined ? {} : { safeDetail: installed.safeDetail }),
          }
        }
      }
      return { state: await input.bootstrap.dispatch({ type: 'runtime-installed' }) }
    } catch {
      const failed = await input.bootstrap.dispatch({
        type: 'runtime-install-failed', errorCode: 'RUNTIME_INSTALL_FAILED',
      })
      return { state: failed, errorCode: 'RUNTIME_INSTALL_FAILED' }
    }
  }

  const validate = async (
    state: BrainBootstrapState,
    driver: BrainConnectionSetupDriver,
  ): Promise<BrainBootstrapCoordinatorResult> => {
    if (state.phase !== 'VALIDATING_AUTH') {
      throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
    }
    try {
      const result = await driver.validate()
      if (result.ok) {
        return { state: await input.bootstrap.dispatch({ type: 'validation-succeeded' }) }
      }
      const errorCode = stableCode(result.errorCode, 'BRAIN_VALIDATION_FAILED')
      return {
        state: await input.bootstrap.dispatch({ type: 'validation-failed', errorCode }),
        errorCode,
      }
    } catch {
      const errorCode = 'BRAIN_VALIDATION_FAILED'
      return {
        state: await input.bootstrap.dispatch({ type: 'validation-failed', errorCode }),
        errorCode,
      }
    }
  }

  return Object.freeze<BrainBootstrapCoordinator>({
    selectAndPrepare(selection, expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        if (state.phase !== 'CHOOSE_BRAIN') {
          throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
        }
        const driver = drivers.get(selection.connectionId)
        if (!driver) throw new BrainBootstrapCoordinatorError('DRIVER_NOT_FOUND')
        if (driver.provider !== selection.provider || driver.authMode !== selection.authMode ||
          driver.runtime !== selection.runtime) {
          throw new BrainBootstrapCoordinatorError('DRIVER_BINDING_MISMATCH')
        }
        authStartedAtRevision = null
        const selected = await input.bootstrap.dispatch({ type: 'brain-selected', ...selection })
        return selected.phase === 'INSTALLING_RUNTIME'
          ? prepare(selected, driver)
          : { state: selected }
      })
    },

    retryInstallation(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        return prepare(state, driverFor(state.selectedBrain))
      })
    },

    beginAuth(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        if (state.phase !== 'AWAITING_AUTH') {
          throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
        }
        if (authStartedAtRevision === state.revision) {
          throw new BrainBootstrapCoordinatorError('AUTH_ALREADY_STARTED')
        }
        const driver = driverFor(state.selectedBrain)
        try {
          const challenge = validateChallenge(await driver.beginAuth())
          authStartedAtRevision = state.revision
          return { state, challenge }
        } catch {
          const errorCode = 'BRAIN_AUTH_START_FAILED'
          return {
            state: await input.bootstrap.dispatch({ type: 'auth-failed', errorCode }),
            errorCode,
          }
        }
      })
    },

    completeAuth(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        if (state.phase !== 'AWAITING_AUTH') {
          throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
        }
        authStartedAtRevision = null
        const driver = driverFor(state.selectedBrain)
        const validating = await input.bootstrap.dispatch({ type: 'auth-completed' })
        return validate(validating, driver)
      })
    },

    resume(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        if (state.phase === 'INSTALLING_RUNTIME') {
          return prepare(state, driverFor(state.selectedBrain))
        }
        if (state.phase === 'VALIDATING_AUTH') {
          return validate(state, driverFor(state.selectedBrain))
        }
        return { state }
      })
    },

    health(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        if (!['BRAIN_READY', 'INTRO_AGENT', 'INTRO_OPERATOR', 'FIRST_PROJECT',
          'INITIAL_AUTONOMY', 'COMPLETE'].includes(state.phase)) {
          throw new BrainBootstrapCoordinatorError('INVALID_PHASE')
        }
        const driver = driverFor(state.selectedBrain)
        try {
          const result = await driver.validate()
          return result.ok
            ? { state, healthy: true }
            : {
                state,
                healthy: false,
                errorCode: stableCode(result.errorCode, 'BRAIN_HEALTH_FAILED'),
              }
        } catch {
          return { state, healthy: false, errorCode: 'BRAIN_HEALTH_FAILED' }
        }
      })
    },

    revoke(expectedRevision) {
      return exclusive(async () => {
        const state = await current(expectedRevision)
        const driver = driverFor(state.selectedBrain)
        try {
          const result = await driver.revoke()
          if (!result.ok) {
            return {
              state,
              errorCode: stableCode(result.errorCode, 'BRAIN_REVOKE_FAILED'),
            }
          }
          authStartedAtRevision = null
          return { state: await input.bootstrap.dispatch({ type: 'reset-brain' }) }
        } catch {
          return { state, errorCode: 'BRAIN_REVOKE_FAILED' }
        }
      })
    },
  })
}

import type { BrainAuthMode, BrainConnectionStatus, BrainRuntime } from './brain-connections.js'

export const BRAIN_BOOTSTRAP_PHASES = [
  'NO_BRAIN',
  'CHOOSE_BRAIN',
  'INSTALLING_RUNTIME',
  'AWAITING_AUTH',
  'VALIDATING_AUTH',
  'BRAIN_READY',
  'INTRO_AGENT',
  'INTRO_OPERATOR',
  'FIRST_PROJECT',
  'INITIAL_AUTONOMY',
  'COMPLETE',
] as const

export type BrainBootstrapPhase = (typeof BRAIN_BOOTSTRAP_PHASES)[number]

export interface SelectedBrain {
  connectionId: string
  provider: string
  authMode: BrainAuthMode
  runtime: BrainRuntime
  status: BrainConnectionStatus
}

export interface BrainBootstrapState {
  version: 1
  phase: BrainBootstrapPhase
  revision: number
  updatedAt: string
  selectedBrain?: SelectedBrain
  /** Stable, redaction-safe code only. */
  lastErrorCode?: string
}

export type BrainBootstrapEvent =
  | { type: 'telegram-paired' }
  | {
      type: 'brain-selected'
      connectionId: string
      provider: string
      authMode: BrainAuthMode
      runtime: BrainRuntime
      requiresInstall: boolean
    }
  | { type: 'runtime-installed' }
  | { type: 'runtime-install-failed'; errorCode: string }
  | { type: 'auth-completed' }
  | { type: 'auth-failed'; errorCode: string }
  | { type: 'validation-succeeded' }
  | { type: 'validation-failed'; errorCode: string }
  | { type: 'brain-ready-acknowledged' }
  | { type: 'agent-intro-completed' }
  | { type: 'operator-intro-completed' }
  | { type: 'first-project-completed' }
  | { type: 'initial-autonomy-completed' }
  | { type: 'reset-brain' }

export interface BrainBootstrapStore {
  load(): Promise<BrainBootstrapState | null>
  save(state: BrainBootstrapState): Promise<void>
}

export interface BrainBootstrapEvents {
  emit(event: 'brain-bootstrap.transition', payload: {
    from: BrainBootstrapPhase
    to: BrainBootstrapPhase
    eventType: BrainBootstrapEvent['type']
    revision: number
  }): void
}

export interface BrainBootstrap {
  state(): Promise<BrainBootstrapState>
  dispatch(event: BrainBootstrapEvent): Promise<BrainBootstrapState>
}

export interface BrainBootstrapDeps {
  store: BrainBootstrapStore
  nowIso(): string
  events?: BrainBootstrapEvents
}

export class InvalidBrainBootstrapTransition extends Error {
  constructor(phase: BrainBootstrapPhase, eventType: BrainBootstrapEvent['type']) {
    super(`invalid brain bootstrap transition: ${phase} + ${eventType}`)
    this.name = 'InvalidBrainBootstrapTransition'
  }
}

export class CorruptBrainBootstrapState extends Error {
  constructor() {
    super('corrupt brain bootstrap state')
    this.name = 'CorruptBrainBootstrapState'
  }
}

function cloneState(state: BrainBootstrapState): BrainBootstrapState {
  return {
    ...state,
    ...(state.selectedBrain ? { selectedBrain: { ...state.selectedBrain } } : {}),
  }
}

function isPhase(value: unknown): value is BrainBootstrapPhase {
  return typeof value === 'string' && (BRAIN_BOOTSTRAP_PHASES as readonly string[]).includes(value)
}

const STATE_KEYS = new Set([
  'version',
  'phase',
  'revision',
  'updatedAt',
  'selectedBrain',
  'lastErrorCode',
])
const SELECTED_BRAIN_KEYS = new Set([
  'connectionId',
  'provider',
  'authMode',
  'runtime',
  'status',
])
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/

function hasExactKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isValidState(value: unknown): value is BrainBootstrapState {
  if (typeof value !== 'object' || value === null) return false
  if (!hasExactKeys(value, STATE_KEYS)) return false
  const candidate = value as Partial<BrainBootstrapState>
  if (candidate.version !== 1 || !isPhase(candidate.phase)) return false
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0) return false
  if (typeof candidate.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(candidate.updatedAt)) ||
    new Date(candidate.updatedAt).toISOString() !== candidate.updatedAt) return false

  const needsBrain = !['NO_BRAIN', 'CHOOSE_BRAIN'].includes(candidate.phase)
  if (needsBrain !== (candidate.selectedBrain !== undefined)) return false
  if (candidate.selectedBrain !== undefined) {
    const selected = candidate.selectedBrain
    if (!hasExactKeys(selected, SELECTED_BRAIN_KEYS)) return false
    if (
      typeof selected.connectionId !== 'string' || !IDENTIFIER.test(selected.connectionId) ||
      typeof selected.provider !== 'string' || !IDENTIFIER.test(selected.provider) ||
      !['subscription', 'api-key'].includes(selected.authMode) ||
      !['native-api', 'claude-code', 'codex-app-server'].includes(selected.runtime) ||
      !['installing', 'auth-required', 'validating', 'ready', 'failed'].includes(selected.status)
    ) return false

    const validStatuses: Partial<Record<BrainBootstrapPhase, readonly BrainConnectionStatus[]>> = {
      INSTALLING_RUNTIME: ['installing', 'failed'],
      AWAITING_AUTH: ['auth-required', 'failed'],
      VALIDATING_AUTH: ['validating'],
      BRAIN_READY: ['ready'],
      INTRO_AGENT: ['ready'],
      INTRO_OPERATOR: ['ready'],
      FIRST_PROJECT: ['ready'],
      INITIAL_AUTONOMY: ['ready'],
      COMPLETE: ['ready'],
    }
    if (!validStatuses[candidate.phase]?.includes(selected.status)) return false
  }
  const hasFailure = candidate.selectedBrain?.status === 'failed'
  return hasFailure
    ? typeof candidate.lastErrorCode === 'string' && ERROR_CODE.test(candidate.lastErrorCode)
    : candidate.lastErrorCode === undefined
}

export function validateBrainBootstrapState(value: unknown): BrainBootstrapState {
  if (!isValidState(value)) throw new CorruptBrainBootstrapState()
  return cloneState(value)
}

function initialState(nowIso: string): BrainBootstrapState {
  return { version: 1, phase: 'NO_BRAIN', revision: 0, updatedAt: nowIso }
}

function requirePhase(
  state: BrainBootstrapState,
  event: BrainBootstrapEvent,
  ...phases: BrainBootstrapPhase[]
): void {
  if (!phases.includes(state.phase)) throw new InvalidBrainBootstrapTransition(state.phase, event.type)
}

interface TransitionPatch {
  selectedBrain?: SelectedBrain
  lastErrorCode?: string
  clearSelectedBrain?: boolean
  clearError?: boolean
}

function withTransition(
  state: BrainBootstrapState,
  phase: BrainBootstrapPhase,
  nowIso: string,
  patch: TransitionPatch = {},
): BrainBootstrapState {
  const next: BrainBootstrapState = {
    ...state,
    phase,
    revision: state.revision + 1,
    updatedAt: nowIso,
  }
  if (patch.selectedBrain !== undefined) next.selectedBrain = patch.selectedBrain
  if (patch.lastErrorCode !== undefined) next.lastErrorCode = patch.lastErrorCode
  if (patch.clearSelectedBrain === true) delete next.selectedBrain
  if (patch.clearError === true) delete next.lastErrorCode
  return next
}

function reduce(
  state: BrainBootstrapState,
  event: BrainBootstrapEvent,
  nowIso: string,
): BrainBootstrapState {
  switch (event.type) {
    case 'telegram-paired':
      requirePhase(state, event, 'NO_BRAIN')
      return withTransition(state, 'CHOOSE_BRAIN', nowIso)

    case 'brain-selected': {
      requirePhase(state, event, 'CHOOSE_BRAIN')
      const selectedBrain: SelectedBrain = {
        connectionId: event.connectionId,
        provider: event.provider,
        authMode: event.authMode,
        runtime: event.runtime,
        status: event.requiresInstall ? 'installing' : 'auth-required',
      }
      return withTransition(
        state,
        event.requiresInstall ? 'INSTALLING_RUNTIME' : 'AWAITING_AUTH',
        nowIso,
        { selectedBrain, clearError: true },
      )
    }

    case 'runtime-installed':
      requirePhase(state, event, 'INSTALLING_RUNTIME')
      return withTransition(state, 'AWAITING_AUTH', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'auth-required' },
        clearError: true,
      })

    case 'runtime-install-failed':
      requirePhase(state, event, 'INSTALLING_RUNTIME')
      return withTransition(state, 'INSTALLING_RUNTIME', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'failed' },
        lastErrorCode: event.errorCode,
      })

    case 'auth-completed':
      requirePhase(state, event, 'AWAITING_AUTH')
      return withTransition(state, 'VALIDATING_AUTH', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'validating' },
        clearError: true,
      })

    case 'auth-failed':
      requirePhase(state, event, 'AWAITING_AUTH')
      return withTransition(state, 'AWAITING_AUTH', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'failed' },
        lastErrorCode: event.errorCode,
      })

    case 'validation-succeeded':
      requirePhase(state, event, 'VALIDATING_AUTH')
      return withTransition(state, 'BRAIN_READY', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'ready' },
        clearError: true,
      })

    case 'validation-failed':
      requirePhase(state, event, 'VALIDATING_AUTH')
      return withTransition(state, 'AWAITING_AUTH', nowIso, {
        selectedBrain: { ...state.selectedBrain!, status: 'failed' },
        lastErrorCode: event.errorCode,
      })

    case 'brain-ready-acknowledged':
      requirePhase(state, event, 'BRAIN_READY')
      return withTransition(state, 'INTRO_AGENT', nowIso)

    case 'agent-intro-completed':
      requirePhase(state, event, 'INTRO_AGENT')
      return withTransition(state, 'INTRO_OPERATOR', nowIso)

    case 'operator-intro-completed':
      requirePhase(state, event, 'INTRO_OPERATOR')
      return withTransition(state, 'FIRST_PROJECT', nowIso)

    case 'first-project-completed':
      requirePhase(state, event, 'FIRST_PROJECT')
      return withTransition(state, 'INITIAL_AUTONOMY', nowIso)

    case 'initial-autonomy-completed':
      requirePhase(state, event, 'INITIAL_AUTONOMY')
      return withTransition(state, 'COMPLETE', nowIso)

    case 'reset-brain':
      requirePhase(
        state,
        event,
        'INSTALLING_RUNTIME',
        'AWAITING_AUTH',
        'VALIDATING_AUTH',
        'BRAIN_READY',
        'INTRO_AGENT',
        'INTRO_OPERATOR',
        'FIRST_PROJECT',
        'INITIAL_AUTONOMY',
        'COMPLETE',
      )
      return withTransition(state, 'CHOOSE_BRAIN', nowIso, {
        clearSelectedBrain: true,
        clearError: true,
      })
  }
}

export function makeBrainBootstrap(deps: BrainBootstrapDeps): BrainBootstrap {
  let cached: BrainBootstrapState | null = null

  async function load(): Promise<BrainBootstrapState> {
    if (cached !== null) return cached
    const persisted = await deps.store.load()
    if (persisted === null) {
      cached = validateBrainBootstrapState(initialState(deps.nowIso()))
      return cached
    }
    cached = validateBrainBootstrapState(persisted)
    return cached
  }

  return {
    async state(): Promise<BrainBootstrapState> {
      return cloneState(await load())
    },

    async dispatch(event: BrainBootstrapEvent): Promise<BrainBootstrapState> {
      const previous = await load()
      const next = validateBrainBootstrapState(reduce(previous, event, deps.nowIso()))

      // Persist before publishing or updating the in-memory view. A failed save
      // leaves the observable state unchanged and the transition can be retried.
      await deps.store.save(cloneState(next))
      cached = next
      deps.events?.emit('brain-bootstrap.transition', {
        from: previous.phase,
        to: next.phase,
        eventType: event.type,
        revision: next.revision,
      })
      return cloneState(next)
    },
  }
}

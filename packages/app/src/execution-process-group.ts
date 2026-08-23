// Code-owned POSIX process-group lifecycle primitive.
//
// This proves absence only for processes that remain in the detached group.
// Descendants can escape with setsid(2)/setpgid(2). Pure Node also has no
// generation-bound group handle, so numeric PGID reuse has an unavoidable
// race between kernel calls. An observed ESRCH is latched to prevent later
// non-zero signals; timeout and operational failure remain unconfirmed.

import { spawn as nodeSpawn, type SpawnOptions, type StdioOptions } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export type ExecutionProcessGroupSignal = 'SIGTERM' | 'SIGKILL'

export interface ExecutionProcessGroupSpawnInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly environment: Readonly<NodeJS.ProcessEnv>
  readonly stdio?: StdioOptions
}

export interface ExecutionProcessGroupIdentity {
  readonly leaderPid: number
  readonly processGroupId: number
}

export type ExecutionProcessGroupStart =
  | ({ readonly kind: 'spawned' } & ExecutionProcessGroupIdentity)
  | { readonly kind: 'spawn-failed' }
  | { readonly kind: 'identity-unavailable' }

export interface ExecutionProcessGroupExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface ExecutionProcessGroupQuiescenceProof extends ExecutionProcessGroupIdentity {
  readonly kind: 'process-group-absent'
  readonly leaderProbe: 'ESRCH'
  readonly groupProbe: 'ESRCH'
  readonly exit: ExecutionProcessGroupExit
}

export interface ExecutionProcessGroupWaitInput {
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export type ExecutionProcessGroupErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PROCESS_GROUP_INPUT'
  | 'PROCESS_GROUP_SPAWN_FAILED'
  | 'PROCESS_GROUP_IDENTITY_UNAVAILABLE'
  | 'PROCESS_GROUP_SIGNAL_DENIED'
  | 'PROCESS_GROUP_SIGNAL_FAILED'
  | 'PROCESS_GROUP_PROBE_DENIED'
  | 'PROCESS_GROUP_PROBE_FAILED'
  | 'PROCESS_GROUP_QUIESCENCE_TIMEOUT'
  | 'PROCESS_GROUP_QUIESCENCE_ABORTED'

export class ExecutionProcessGroupError extends Error {
  constructor(readonly code: ExecutionProcessGroupErrorCode) {
    super(code)
    this.name = 'ExecutionProcessGroupError'
  }
}

export interface ExecutionProcessGroup {
  /** Spawn failure never fabricates a leader-exit event. */
  readonly started: Promise<ExecutionProcessGroupStart>
  /** Direct leader exit only; never a process-group proof. */
  readonly exited: Promise<ExecutionProcessGroupExit>
  /** Duplicate TERM/KILL is idempotent; KILL upgrades TERM once. */
  terminate(signal: ExecutionProcessGroupSignal): void
  /** Requires actual ESRCH observations for both PID and negative PGID. */
  waitForQuiescence(input: ExecutionProcessGroupWaitInput): Promise<ExecutionProcessGroupQuiescenceProof>
}

export interface ExecutionProcessGroupPort {
  spawn(input: ExecutionProcessGroupSpawnInput): ExecutionProcessGroup
}

export interface ExecutionProcessGroupSubprocess {
  readonly pid?: number | undefined
  kill(signal: ExecutionProcessGroupSignal): boolean
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
}

export interface ExecutionProcessGroupSystemPort {
  readonly platform: NodeJS.Platform
  readonly currentPid: number
  spawn(input: ExecutionProcessGroupSpawnInput & { readonly detached: true }): ExecutionProcessGroupSubprocess
  signal(target: number, signal: ExecutionProcessGroupSignal | 0): void
  /** Monotonic elapsed-time source; never wall-clock time. */
  monotonicMs(): number
  wait(ms: number, signal: AbortSignal): Promise<void>
}

const POSIX_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  'aix',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
])
const MIN_PID = 2
const MAX_WAIT_MS = 60_000
const PROBE_INTERVAL_MS = 10

function codeOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null
}

function fail(code: ExecutionProcessGroupErrorCode): ExecutionProcessGroupError {
  return new ExecutionProcessGroupError(code)
}

function validateSpawnInput(input: ExecutionProcessGroupSpawnInput): void {
  if (typeof input.command !== 'string' || input.command.length === 0 ||
    !Array.isArray(input.args) || input.args.some((entry) => typeof entry !== 'string')) {
    throw fail('INVALID_PROCESS_GROUP_INPUT')
  }
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(fail('PROCESS_GROUP_QUIESCENCE_ABORTED'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(fail('PROCESS_GROUP_QUIESCENCE_ABORTED'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function makeNodeExecutionProcessGroupSystemPort(): ExecutionProcessGroupSystemPort {
  return {
    platform: process.platform,
    currentPid: process.pid,
    spawn(input) {
      const options: SpawnOptions = {
        detached: true,
        env: { ...input.environment },
        stdio: input.stdio ?? ['ignore', 'inherit', 'inherit'],
      }
      if (input.cwd !== undefined) options.cwd = input.cwd
      return nodeSpawn(input.command, [...input.args], options)
    },
    signal(target, signal) {
      process.kill(target, signal)
    },
    monotonicMs: () => performance.now(),
    wait: waitWithAbort,
  }
}

export function makeExecutionProcessGroupPort(
  system: ExecutionProcessGroupSystemPort,
): ExecutionProcessGroupPort {
  if (!POSIX_PLATFORMS.has(system.platform)) throw fail('UNSUPPORTED_PLATFORM')
  if (!Number.isSafeInteger(system.currentPid) || system.currentPid < MIN_PID) {
    throw fail('INVALID_PROCESS_GROUP_INPUT')
  }

  return {
    spawn(input) {
      validateSpawnInput(input)

      let subprocess: ExecutionProcessGroupSubprocess
      try {
        subprocess = system.spawn({ ...input, detached: true })
      } catch {
        throw fail('PROCESS_GROUP_SPAWN_FAILED')
      }

      let startState: ExecutionProcessGroupStart | null = null
      let exitState: ExecutionProcessGroupExit | null = null
      let identity: ExecutionProcessGroupIdentity | null = null
      let leaderAbsent = false
      let groupAbsent = false
      let terminalError: ExecutionProcessGroupError | null = null
      let requestedSignal: ExecutionProcessGroupSignal | null = null
      let deliveredSignal: ExecutionProcessGroupSignal | null = null

      let resolveStarted!: (value: ExecutionProcessGroupStart) => void
      const started = new Promise<ExecutionProcessGroupStart>((resolve) => { resolveStarted = resolve })
      let resolveExited!: (value: ExecutionProcessGroupExit) => void
      const exited = new Promise<ExecutionProcessGroupExit>((resolve) => { resolveExited = resolve })

      const latchError = (code: ExecutionProcessGroupErrorCode): void => {
        if (terminalError === null) terminalError = fail(code)
      }

      const deliverRequestedSignal = (): void => {
        if (identity === null || requestedSignal === null || groupAbsent || terminalError !== null) return
        if (deliveredSignal === 'SIGKILL' || deliveredSignal === requestedSignal) return
        const signal = requestedSignal
        try {
          system.signal(-identity.processGroupId, signal)
          deliveredSignal = signal
        } catch (error) {
          const code = codeOf(error)
          if (code === 'ESRCH') {
            groupAbsent = true
            return
          }
          latchError(code === 'EPERM' || code === 'EACCES'
            ? 'PROCESS_GROUP_SIGNAL_DENIED'
            : 'PROCESS_GROUP_SIGNAL_FAILED')
        }
      }

      subprocess.once('spawn', () => {
        if (startState !== null) return
        const pid = subprocess.pid
        if (!Number.isSafeInteger(pid) || pid === undefined || pid < MIN_PID || pid === system.currentPid) {
          startState = { kind: 'identity-unavailable' }
          latchError('PROCESS_GROUP_IDENTITY_UNAVAILABLE')
          try { subprocess.kill('SIGKILL') } catch { /* owned handle is already untrusted */ }
          resolveStarted(startState)
          return
        }
        identity = { leaderPid: pid, processGroupId: pid }
        startState = { kind: 'spawned', ...identity }
        resolveStarted(startState)
        deliverRequestedSignal()
      })
      subprocess.once('error', () => {
        if (startState !== null) return
        startState = { kind: 'spawn-failed' }
        resolveStarted(startState)
      })
      subprocess.once('exit', (code, signal) => {
        if (exitState !== null) return
        exitState = { code, signal }
        resolveExited(exitState)
      })

      const probe = (target: number): boolean => {
        try {
          system.signal(target, 0)
          return false
        } catch (error) {
          const code = codeOf(error)
          if (code === 'ESRCH') return true
          latchError(code === 'EPERM' || code === 'EACCES'
            ? 'PROCESS_GROUP_PROBE_DENIED'
            : 'PROCESS_GROUP_PROBE_FAILED')
          return false
        }
      }

      return {
        started,
        exited,
        terminate(signal) {
          if (startState?.kind === 'spawn-failed' || groupAbsent || terminalError !== null) return
          if (requestedSignal === 'SIGKILL') return
          if (requestedSignal === 'SIGTERM' && signal === 'SIGTERM') return
          requestedSignal = signal
          deliverRequestedSignal()
        },
        async waitForQuiescence(waitInput) {
          if (!Number.isInteger(waitInput.timeoutMs) || waitInput.timeoutMs < 1 ||
            waitInput.timeoutMs > MAX_WAIT_MS) throw fail('INVALID_PROCESS_GROUP_INPUT')
          if (waitInput.signal.aborted) throw fail('PROCESS_GROUP_QUIESCENCE_ABORTED')
          const deadlineAtMs = system.monotonicMs() + waitInput.timeoutMs

          while (true) {
            if (waitInput.signal.aborted) throw fail('PROCESS_GROUP_QUIESCENCE_ABORTED')
            if (terminalError !== null) throw terminalError
            if (startState?.kind === 'spawn-failed') throw fail('PROCESS_GROUP_SPAWN_FAILED')

            if (identity !== null) {
              if (!leaderAbsent) leaderAbsent = probe(identity.leaderPid)
              if (!groupAbsent) groupAbsent = probe(-identity.processGroupId)
              if (terminalError !== null) throw terminalError
              if (leaderAbsent && groupAbsent && exitState !== null) {
                return {
                  kind: 'process-group-absent',
                  ...identity,
                  leaderProbe: 'ESRCH',
                  groupProbe: 'ESRCH',
                  exit: exitState,
                }
              }
            }

            const remaining = deadlineAtMs - system.monotonicMs()
            if (remaining <= 0) throw fail('PROCESS_GROUP_QUIESCENCE_TIMEOUT')
            try {
              await system.wait(Math.min(PROBE_INTERVAL_MS, remaining), waitInput.signal)
            } catch (error) {
              if (error instanceof ExecutionProcessGroupError &&
                error.code === 'PROCESS_GROUP_QUIESCENCE_ABORTED') throw error
              if (waitInput.signal.aborted) throw fail('PROCESS_GROUP_QUIESCENCE_ABORTED')
              throw fail('PROCESS_GROUP_PROBE_FAILED')
            }
          }
        },
      }
    },
  }
}

/** Offline evidence only; production wiring requires an OS scope authority. */
export function makeDormantNodeExecutionProcessGroupPort(): ExecutionProcessGroupPort {
  return makeExecutionProcessGroupPort(makeNodeExecutionProcessGroupSystemPort())
}

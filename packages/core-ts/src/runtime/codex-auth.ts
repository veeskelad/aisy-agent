import { execFile, spawn } from 'node:child_process'
import type {
  AuthChallenge,
  BrainDetectionResult,
  BrainValidationResult,
} from '../onboarding/brain-connections.js'
import { canonicalCodexExecutable, safeCodexEnvironment } from './codex-process-security.js'

export interface CodexCommandResult {
  exitCode: number
  output: string
}

export interface CodexStreamingCommand {
  completed: Promise<{ exitCode: number }>
  stop(): void
}

export interface CodexAuthProcessPort {
  run(command: string, args: string[]): Promise<CodexCommandResult>
  start(
    command: string,
    args: string[],
    onChunk: (chunk: string) => void,
  ): CodexStreamingCommand
}

export interface CodexSubscriptionAuth {
  detect(): Promise<BrainDetectionResult>
  beginAuth(): Promise<AuthChallenge>
  validate(): Promise<BrainValidationResult>
  revoke(): Promise<BrainValidationResult>
}

export class CodexAuthDriverError extends Error {
  constructor(public readonly code:
    | 'DEVICE_AUTH_CHALLENGE_UNAVAILABLE'
    | 'DEVICE_AUTH_START_FAILED'
    | 'INVALID_AUTH_CONFIG',
  ) {
    super(code)
    this.name = 'CodexAuthDriverError'
  }
}

const MAX_CAPTURE = 16 * 1024
const CODEX_VERSION = /(?:^|\s)(codex-cli\s+\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk
  return next.length <= MAX_CAPTURE ? next : next.slice(-MAX_CAPTURE)
}

/** Parse only the two operator-safe fields documented by the device flow. */
export function parseCodexDeviceChallenge(output: string): Extract<AuthChallenge, { kind: 'device-code' }> | null {
  const cleaned = output.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
  const uriMatch = cleaned.match(/https:\/\/[^\s<>"']+/i)
  const codeMatch = cleaned.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/i)
    ?? cleaned.match(/(?:code|enter)\D{0,24}([A-Z0-9]{6,})\b/i)
  const rawUri = uriMatch?.[0]?.replace(/[),.;]+$/, '')
  const userCode = codeMatch?.[1] ?? codeMatch?.[0]
  if (!rawUri || !userCode) return null
  try {
    const parsed = new URL(rawUri)
    if (parsed.protocol !== 'https:') return null
  } catch {
    return null
  }
  return { kind: 'device-code', verificationUri: rawUri, userCode }
}

function exactArgs(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

export function makeNodeCodexAuthProcessPort(input: {
  codexExecutable: string
  timeoutMs?: number
  environment?: NodeJS.ProcessEnv
}): CodexAuthProcessPort {
  const executable = canonicalCodexExecutable(input.codexExecutable)
  const timeoutMs = input.timeoutMs ?? 10_000
  if (executable === null || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new CodexAuthDriverError('INVALID_AUTH_CONFIG')
  }
  const environment = safeCodexEnvironment(input.environment ?? process.env)
  return {
    run(command, args) {
      const allowed = command === 'codex' && (
        exactArgs(args, ['--version']) ||
        exactArgs(args, ['login', 'status']) ||
        exactArgs(args, ['logout'])
      )
      if (!allowed) return Promise.resolve({ exitCode: 1, output: '' })
      return new Promise((resolve) => {
        execFile(
          executable,
          args,
          { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_CAPTURE, env: environment },
          (error, stdout, stderr) => {
            const numericCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0
            resolve({
              exitCode: numericCode,
              output: appendCapped(String(stdout), String(stderr)),
            })
          },
        )
      })
    },

    start(command, args, onChunk) {
      if (command !== 'codex' || !exactArgs(args, ['login', '--device-auth'])) {
        return { completed: Promise.resolve({ exitCode: 1 }), stop: () => {} }
      }
      const child = spawn(executable, args, {
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (chunk) => { onChunk(String(chunk)) })
      child.stderr.on('data', (chunk) => { onChunk(String(chunk)) })
      const completed = new Promise<{ exitCode: number }>((resolve) => {
        child.on('error', () => { resolve({ exitCode: 1 }) })
        child.on('close', (code) => { resolve({ exitCode: code ?? 1 }) })
      })
      return {
        completed,
        stop: () => { child.kill() },
      }
    },
  }
}

export function makeCodexSubscriptionAuth(
  processPort: CodexAuthProcessPort,
): CodexSubscriptionAuth {
  let active: CodexStreamingCommand | null = null

  return {
    async detect(): Promise<BrainDetectionResult> {
      const result = await processPort.run('codex', ['--version'])
      if (result.exitCode !== 0) return { installed: false }
      const version = result.output.match(CODEX_VERSION)?.[1]
      return { installed: true, ...(version ? { version } : {}) }
    },

    beginAuth(): Promise<AuthChallenge> {
      active?.stop()
      active = null
      return new Promise<AuthChallenge>((resolve, reject) => {
        let captured = ''
        let settled = false
        let command: CodexStreamingCommand
        try {
          command = processPort.start('codex', ['login', '--device-auth'], (chunk) => {
            captured = appendCapped(captured, chunk)
            const challenge = parseCodexDeviceChallenge(captured)
            if (challenge && !settled) {
              settled = true
              resolve(challenge)
            }
          })
        } catch {
          reject(new CodexAuthDriverError('DEVICE_AUTH_START_FAILED'))
          return
        }
        active = command
        void command.completed.then(() => {
          if (!settled) {
            settled = true
            reject(new CodexAuthDriverError('DEVICE_AUTH_CHALLENGE_UNAVAILABLE'))
          }
        })
      })
    },

    async validate(): Promise<BrainValidationResult> {
      if (active) {
        const completed = await active.completed
        active = null
        if (completed.exitCode !== 0) {
          return {
            ok: false,
            safeDetail: 'Codex device authentication did not complete.',
            errorCode: 'CODEX_DEVICE_AUTH_FAILED',
          }
        }
      }
      const status = await processPort.run('codex', ['login', 'status'])
      if (status.exitCode !== 0) {
        return {
          ok: false,
          safeDetail: 'Codex is not authenticated.',
          errorCode: 'CODEX_NOT_AUTHENTICATED',
        }
      }
      return { ok: true, safeDetail: 'Codex authentication is active.' }
    },

    async revoke(): Promise<BrainValidationResult> {
      active?.stop()
      active = null
      const result = await processPort.run('codex', ['logout'])
      return result.exitCode === 0
        ? { ok: true, safeDetail: 'Codex authentication was revoked.' }
        : {
            ok: false,
            safeDetail: 'Codex authentication could not be revoked.',
            errorCode: 'CODEX_LOGOUT_FAILED',
          }
    },
  }
}

import { execFile } from 'node:child_process'

import { withNodeBinOnPath } from './node-tool-path.js'

import type { BrainConnectionSetupDriver } from '../onboarding/brain-bootstrap-coordinator.js'
import type { BrainInstallResult, BrainValidationResult } from '../onboarding/brain-connections.js'
import type { ClaudeAuthProcessPort, ClaudeSubscriptionAuth } from './claude-auth.js'

const MAX_AUTH_CAPTURE = 16 * 1024
const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL',
  'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TERM', 'NO_COLOR',
] as const

/**
 * Narrow process boundary for the three non-secret lifecycle commands. Anything
 * else is refused before spawn, so this port can never become a general shell,
 * and the environment is an allowlist so no credential of the agent leaks into
 * the CLI it starts.
 */
export function makeNodeClaudeAuthProcessPort(input: {
  executable?: string
  timeoutMs?: number
  environment?: NodeJS.ProcessEnv
} = {}): ClaudeAuthProcessPort {
  const executable = input.executable ?? 'claude'
  const timeoutMs = input.timeoutMs ?? 30_000
  const source = input.environment ?? process.env
  const environment: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) {
      environment[key] = value
    }
  }

  // The allowlisted PATH is copied verbatim from a process that a service
  // manager started, so it can be missing Node entirely — and `claude` is a
  // shebang script that needs it.
  const childEnvironment = withNodeBinOnPath(environment)

  const exact = (args: string[], expected: readonly string[]): boolean =>
    args.length === expected.length && args.every((value, index) => value === expected[index])

  return Object.freeze<ClaudeAuthProcessPort>({
    run(command, args) {
      const allowed = command === 'claude' && (
        exact(args, ['--version']) ||
        exact(args, ['auth', 'status']) ||
        exact(args, ['auth', 'logout'])
      )
      if (!allowed) return Promise.resolve({ exitCode: 1, output: '' })
      return new Promise((resolve) => {
        execFile(
          executable,
          args,
          { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_AUTH_CAPTURE, env: childEnvironment },
          (error, stdout, stderr) => {
            const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
            resolve({
              exitCode: code,
              output: `${String(stdout)}${String(stderr)}`.slice(0, MAX_AUTH_CAPTURE),
            })
          },
        )
      })
    },
  })
}

/**
 * Adapts the Claude subscription login lifecycle to bootstrap orchestration,
 * mirroring the Codex driver. Login itself stays with the operator: Claude Code
 * owns the credential and opens its own browser flow, so Aisy only detects the
 * binary, points at the flow, checks the status and can sign out.
 *
 * Installation is an injected port: Aisy never invents an installer command.
 */
export function makeClaudeSubscriptionSetupDriver(input: {
  auth: ClaudeSubscriptionAuth
  processPort: ClaudeAuthProcessPort
  install(): Promise<BrainInstallResult>
}): BrainConnectionSetupDriver {
  return Object.freeze({
    connectionId: 'claude-subscription',
    provider: 'anthropic',
    authMode: 'subscription' as const,
    runtime: 'claude-code' as const,
    detect: () => input.auth.detect(),
    install: () => input.install(),
    beginAuth: async () => input.auth.beginAuth(),
    validate: () => input.auth.validate(),
    async revoke(): Promise<BrainValidationResult> {
      let result
      try {
        result = await input.processPort.run('claude', ['auth', 'logout'])
      } catch {
        return {
          ok: false,
          safeDetail: 'Не удалось выйти из аккаунта Claude.',
          errorCode: 'CLAUDE_LOGOUT_FAILED',
        }
      }
      // A revoke that only *seems* to have happened is worse than a refusal:
      // the operator would believe the connection is closed while it is live.
      return result.exitCode === 0
        ? { ok: true, safeDetail: 'Подключение Claude отозвано.' }
        : {
            ok: false,
            safeDetail: 'Claude не подтвердил выход из аккаунта.',
            errorCode: 'CLAUDE_LOGOUT_REJECTED',
          }
    },
  })
}

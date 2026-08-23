import type {
  AuthChallenge,
  BrainDetectionResult,
  BrainValidationResult,
} from '../onboarding/brain-connections.js'

export const CLAUDE_CODE_SUPPORTED_VERSION = '2.1.220 (Claude Code)'
export const CLAUDE_CODE_PROTOCOL_PROFILE = 'claude-code-stream-json-v1@2.1.220'

const MAX_AUTH_OUTPUT_BYTES = 16 * 1024
const SMOKE_MARKER = 'AISY_CLAUDE_AUTH_OK'

export interface ClaudeCommandResult {
  exitCode: number
  output: string
}

export interface ClaudeAuthProcessPort {
  run(command: string, args: string[]): Promise<ClaudeCommandResult>
}

/**
 * Dormant subscription-auth contract. The operator owns the interactive login;
 * Aisy only detects the pinned binary and checks the documented status command.
 */
export interface ClaudeSubscriptionAuth {
  detect(): Promise<BrainDetectionResult>
  beginAuth(): AuthChallenge
  validate(): Promise<BrainValidationResult>
}

/** Backward-compatible spike surface retained for the existing offline tests. */
export interface ClaudeSubscriptionAuthSpike extends ClaudeSubscriptionAuth {
  smokeCommand(): readonly string[]
  validateSmoke(result: ClaudeCommandResult): BrainValidationResult
}

function boundedOutput(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MAX_AUTH_OUTPUT_BYTES && !value.includes('\0')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validStatusEnvelope(value: unknown): boolean {
  // The documented contract is JSON plus the process exit status. Claude Code
  // owns the payload schema, so Aisy validates the envelope and discards it.
  return record(value)
}

/**
 * Login is deliberately manual. CLAUDE_CONFIG_DIR is a code-owned placeholder,
 * not a credential path read by Aisy; Claude Code remains the credential owner.
 */
export const CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS =
  'In a trusted local terminal, set CLAUDE_CONFIG_DIR to the private Aisy Claude profile and run the approved canonical Claude Code executable with `auth login`. Return to Aisy after the official flow completes.'

/** Build an isolated, toolless one-turn validation command. Execution stays dormant. */
export function buildClaudeAuthSmokeCommand(): readonly string[] {
  return Object.freeze([
    'claude',
    '--safe-mode',
    '-p',
    `Reply with exactly ${SMOKE_MARKER}. Do not inspect files and do not call tools.`,
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--permission-mode',
    'plan',
    '--tools',
    '',
    '--disallowed-tools',
    'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent,Skill',
    '--disable-slash-commands',
    '--no-chrome',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
  ])
}

export function parseClaudeAuthSmoke(result: ClaudeCommandResult): BrainValidationResult {
  if (result.exitCode !== 0) {
    return {
      ok: false,
      safeDetail: 'Claude Code authentication smoke did not complete.',
      errorCode: 'CLAUDE_SMOKE_FAILED',
    }
  }
  if (!boundedOutput(result.output)) {
    return {
      ok: false,
      safeDetail: 'Claude Code returned an invalid structured smoke result.',
      errorCode: 'CLAUDE_SMOKE_OUTPUT_REJECTED',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.output)
  } catch {
    return {
      ok: false,
      safeDetail: 'Claude Code returned an invalid structured smoke result.',
      errorCode: 'CLAUDE_SMOKE_INVALID_JSON',
    }
  }
  if (!record(parsed)) {
    return {
      ok: false,
      safeDetail: 'Claude Code returned an invalid structured smoke result.',
      errorCode: 'CLAUDE_SMOKE_INVALID_RESULT',
    }
  }

  const valid = parsed.type === 'result' && parsed.subtype === 'success' &&
    parsed.is_error === false && parsed.result === SMOKE_MARKER && parsed.num_turns === 1 &&
    typeof parsed.session_id === 'string' && parsed.session_id.length > 0 &&
    parsed.session_id.length <= 128 && !parsed.session_id.includes('\0')
  return valid
    ? { ok: true, safeDetail: 'Claude Code subscription authentication is active.' }
    : {
        ok: false,
        safeDetail: 'Claude Code structured smoke did not confirm authentication.',
        errorCode: 'CLAUDE_NOT_AUTHENTICATED',
      }
}

export function makeClaudeSubscriptionAuthSpike(
  processPort: ClaudeAuthProcessPort,
): ClaudeSubscriptionAuthSpike {
  return Object.freeze({
    async detect(): Promise<BrainDetectionResult> {
      let result: ClaudeCommandResult
      try {
        result = await processPort.run('claude', ['--version'])
      } catch {
        return { installed: false }
      }
      if (result.exitCode !== 0 || !boundedOutput(result.output)) return { installed: false }
      const version = result.output.trim()
      return version === CLAUDE_CODE_SUPPORTED_VERSION
        ? { installed: true, version }
        : { installed: true, ...(version ? { version: version.slice(0, 80) } : {}) }
    },

    beginAuth(): AuthChallenge {
      return {
        kind: 'browser',
        authorizationUri: 'https://claude.ai/',
        safeInstructions: CLAUDE_SUBSCRIPTION_AUTH_INSTRUCTIONS,
      }
    },

    async validate(): Promise<BrainValidationResult> {
      let status: ClaudeCommandResult
      try {
        status = await processPort.run('claude', ['auth', 'status'])
      } catch {
        return {
          ok: false,
          safeDetail: 'Claude Code authentication status is unavailable.',
          errorCode: 'CLAUDE_AUTH_STATUS_FAILED',
        }
      }
      if (status.exitCode !== 0) {
        return {
          ok: false,
          safeDetail: 'Claude Code is not authenticated.',
          errorCode: 'CLAUDE_NOT_AUTHENTICATED',
        }
      }
      if (!boundedOutput(status.output)) {
        return {
          ok: false,
          safeDetail: 'Claude Code returned an invalid authentication status.',
          errorCode: 'CLAUDE_AUTH_STATUS_INVALID',
        }
      }
      let parsed: unknown
      try { parsed = JSON.parse(status.output) } catch { parsed = null }
      if (!validStatusEnvelope(parsed)) {
        return {
          ok: false,
          safeDetail: 'Claude Code returned an invalid authentication status.',
          errorCode: 'CLAUDE_AUTH_STATUS_INVALID',
        }
      }
      return { ok: true, safeDetail: 'Claude Code authentication is active.' }
    },

    smokeCommand: buildClaudeAuthSmokeCommand,
    validateSmoke: parseClaudeAuthSmoke,
  })
}

// Connecting a Claude Pro/Max subscription from a phone.
//
// `claude setup-token` exists so Claude Code can authenticate where no browser
// can open — the operator runs it once on their own laptop and sends the
// resulting token here. Aisy stores it as CLAUDE_CODE_OAUTH_TOKEN and the same
// CLI runs headless on the agent's host, driven over the local MCP bridge
// (ADR-0090). No browser on the server, no key pretending to be something else.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { withNodeBinOnPath } from '@aisy/core'

import { resolveExecutable } from './resolve-executable.js'

/**
 * A service manager gives the process a minimal PATH, which usually does not
 * include the npm global bin — and that is where `claude` and `npm` live. Look
 * there too, and resolve at call time: the CLI appears mid-session, right after
 * the operator taps "install".
 */
export function resolveNodeToolPath(name: string): string {
  return resolveExecutable(name) ?? join(dirname(process.execPath), name)
}

export type ClaudeTokenErrorCode =
  | 'TOKEN_EMPTY'
  | 'TOKEN_MALFORMED'
  | 'CLAUDE_NOT_INSTALLED'
  | 'TOKEN_REJECTED'
  | 'VAULT_CORRUPT'
  | 'CONFIG_CORRUPT'
  | 'PERSISTENCE_FAILED'

export type ClaudeTokenResult =
  | { ok: true; version?: string }
  | { ok: false; errorCode: ClaudeTokenErrorCode }

export interface ClaudeTokenSetup {
  validateAndStore(token: string): Promise<ClaudeTokenResult>
}

export interface ClaudeSmokeTest {
  /** Runs one real turn with the token. `ok: false` means the CLI refused it. */
  (token: string): Promise<{ ok: boolean; installed: boolean }>
}

export interface ClaudeTokenSetupDeps {
  vaultPath: string
  providersPath: string
  exists(path: string): boolean
  readFile(path: string): string
  writePrivateFile(path: string, content: string): void
  renameFile(from: string, to: string): void
  smokeTest: ClaudeSmokeTest
}

/**
 * `claude setup-token` prints an OAuth token; anything else the operator may
 * paste (an API key, a URL, a whole terminal line) is rejected before it can be
 * written to the vault and blamed on the provider later.
 */
const TOKEN_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function atomicWrite(
  path: string,
  content: string,
  deps: Pick<ClaudeTokenSetupDeps, 'writePrivateFile' | 'renameFile'>,
): void {
  const temp = path + '.tmp'
  deps.writePrivateFile(temp, content)
  deps.renameFile(temp, path)
}

export function makeClaudeTokenSetup(deps: ClaudeTokenSetupDeps): ClaudeTokenSetup {
  return {
    async validateAndStore(rawToken: string): Promise<ClaudeTokenResult> {
      const token = rawToken.trim()
      if (token.length === 0) return { ok: false, errorCode: 'TOKEN_EMPTY' }
      if (!TOKEN_SHAPE.test(token)) return { ok: false, errorCode: 'TOKEN_MALFORMED' }

      // Prove the subscription answers before promising the operator a brain:
      // a token that only looks right produces a bot that fails on the first
      // real message, which is worse than a refusal here.
      const probe = await deps.smokeTest(token)
      if (!probe.installed) return { ok: false, errorCode: 'CLAUDE_NOT_INSTALLED' }
      if (!probe.ok) return { ok: false, errorCode: 'TOKEN_REJECTED' }

      const vault = deps.exists(deps.vaultPath) ? parseObject(deps.readFile(deps.vaultPath)) : {}
      if (vault === null) return { ok: false, errorCode: 'VAULT_CORRUPT' }
      const providers = deps.exists(deps.providersPath)
        ? parseObject(deps.readFile(deps.providersPath))
        : {}
      if (providers === null) return { ok: false, errorCode: 'CONFIG_CORRUPT' }

      try {
        atomicWrite(
          deps.vaultPath,
          JSON.stringify({ ...vault, CLAUDE_CODE_OAUTH_TOKEN: token }, null, 2) + '\n',
          deps,
        )
        atomicWrite(
          deps.providersPath,
          // 'default' means "let the CLI pick": the subscription tracks whatever
          // model Claude Code ships, and a pinned id goes stale on their side.
          JSON.stringify({
            ...providers,
            default: { provider: 'claude-subscription', model: 'default' },
          }, null, 2) + '\n',
          deps,
        )
      } catch {
        return { ok: false, errorCode: 'PERSISTENCE_FAILED' }
      }
      return { ok: true }
    },
  }
}

/** Environment for a Claude Code child: PATH/HOME plus the subscription token. */
export function claudeCodeEnvironment(
  source: NodeJS.ProcessEnv,
  token: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = withNodeBinOnPath(source)
  // An API key in the ambient environment wins over the subscription token and
  // would silently bill the operator's API account instead of their plan.
  delete env['ANTHROPIC_API_KEY']
  delete env['ANTHROPIC_AUTH_TOKEN']
  if (token !== undefined) env['CLAUDE_CODE_OAUTH_TOKEN'] = token
  return env
}

/** Real smoke test: one cheap turn through the CLI with the given token. */
export function makeNodeClaudeSmokeTest(input: {
  resolvePath?: () => string
  timeoutMs?: number
} = {}): ClaudeSmokeTest {
  const resolvePath = input.resolvePath ?? (() => resolveNodeToolPath('claude'))
  const timeoutMs = input.timeoutMs ?? 90_000
  return (token) => new Promise((resolve) => {
    const child = spawn(resolvePath(), ['-p', '--output-format', 'json', '--setting-sources', ''], {
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: timeoutMs,
      env: claudeCodeEnvironment(process.env, token),
    })
    child.on('error', () => { resolve({ ok: false, installed: false }) })
    child.on('close', (code) => { resolve({ ok: code === 0, installed: true }) })
    child.stdin.end('ping')
  })
}

/** The two brain runtimes, by the package name their vendor publishes. */
export const BRAIN_RUNTIME_PACKAGES = Object.freeze({
  'claude-code': '@anthropic-ai/claude-code',
  'codex': '@openai/codex',
})

/**
 * Installs an official CLI on the agent's host. The operator is on a phone —
 * "run npm yourself" is not an option they have, and this is the vendor's own
 * documented command, not an installer Aisy invented.
 */
export function makeNodeBrainRuntimeInstaller(input: {
  package: string
  resolveNpm?: () => string
  timeoutMs?: number
}): () => Promise<{ installed: boolean; safeDetail: string }> {
  const resolveNpm = input.resolveNpm ?? (() => resolveNodeToolPath('npm'))
  const timeoutMs = input.timeoutMs ?? 300_000
  return () => new Promise((resolve) => {
    const child = spawn(resolveNpm(), ['install', '-g', input.package], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      // npm itself is a `#!/usr/bin/env node` script: without Node on PATH the
      // spawn dies with a message about `node`, not about the install.
      env: withNodeBinOnPath(process.env),
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2048) })
    child.on('error', () => {
      resolve({ installed: false, safeDetail: 'npm недоступен на хосте агента.' })
    })
    child.on('close', (code) => {
      resolve(code === 0
        ? { installed: true, safeDetail: `${input.package} установлен.` }
        // The npm tail is the operator's only clue about a permission or
        // registry failure they have to fix on the host.
        : { installed: false, safeDetail: `npm вернул код ${code ?? -1}. ${stderr.trim().slice(-300)}` })
    })
  })
}

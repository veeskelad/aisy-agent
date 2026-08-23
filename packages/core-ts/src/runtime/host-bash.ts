// Host bash adapter (runtime).
//
// Runs a command directly on the machine the agent lives on. This is weaker than
// the container adapter (`sandbox-bash.ts`): there is no kernel boundary, so the
// real perimeter is the approval card — `bash` is a tier-2 tool and every call
// the operator has not granted stops for confirmation.
//
// What this layer does own: the working directory, a wall-clock cap, a bounded
// output, an environment stripped of every credential the agent process holds,
// and a refusal list for commands whose damage cannot be undone by an operator
// who tapped "allow" too fast.
//
// ponytail: host execution is the working default; the upgrade path is the
// container adapter once the parent Docker broker can bind sidecar recovery.
// ADR-0091 adds one explicit exception: `bypass` skips the adapter denylist,
// while liveness bounds and the filtered child environment stay unchanged.

import { execFile } from 'node:child_process'

export interface HostBashResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface HostBashDeps {
  /** Commands run here and may not be started elsewhere. */
  workspaceRoot: string
  /** Wall-clock cap per command. */
  timeoutMs?: number
  /** Cap on captured output; the rest is dropped with a marker. */
  maxOutputBytes?: number
  /** Injected for tests. */
  run?: (
    command: string,
    options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; maxBuffer: number },
  ) => Promise<HostBashResult>
  /** Environment to filter; defaults to the agent's own. */
  env?: NodeJS.ProcessEnv
  /** Live ADR-0091 operator switch. It must not be controlled by the model. */
  bypass?: () => boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Names whose values must never reach a command the model composed. */
const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API_?KEY|AUTH/i

/**
 * Commands refused before execution. This is a guard against a careless
 * approval, not a security boundary: it matches the leading command only, and
 * anyone determined can phrase around it. The boundary is the approval card.
 */
const REFUSED = [
  /^\s*sudo(\s|$)/,
  /^\s*doas(\s|$)/,
  /^\s*rm\s+(-\w*\s+)*-\w*[rR]\w*f|^\s*rm\s+(-\w*\s+)*-\w*f\w*[rR]/,
  /^\s*mkfs(\.|\s|$)/,
  /^\s*dd\s+.*\bif=/,
  /^\s*(shutdown|reboot|halt|poweroff)(\s|$)/,
  /^\s*(kill|pkill|killall)\s+(-9|-KILL|-SIGKILL)?\s*-?1(\s|$)/,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
] as const

export class HostBashRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'HostBashRefusal'
  }
}

/** True when the command is refused outright. Exported for tests and doctor. */
export function refusedHostCommand(cmd: string): boolean {
  return REFUSED.some((pattern) => pattern.test(cmd))
}

/**
 * Drops every credential-shaped variable. The agent may legitimately need PATH
 * and HOME, but a command it wrote must not be able to echo the bot token.
 */
export function hostBashEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SECRET_NAME.test(name)) continue
    safe[name] = value
  }
  return safe
}

function bounded(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  return `${Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8')}\n…(вывод обрезан)`
}

function defaultRun(
  command: string,
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; maxBuffer: number },
): Promise<HostBashResult> {
  return new Promise<HostBashResult>((resolve) => {
    execFile(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', command],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        env: options.env,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const killed = error !== null && (error as { killed?: boolean }).killed === true
        const code = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 1
        resolve({
          stdout: String(stdout),
          stderr: killed ? `${String(stderr)}\n(команда прервана по таймауту)`.trim() : String(stderr),
          exitCode: killed ? 124 : code,
        })
      },
    )
  })
}

export function makeHostBash(deps: HostBashDeps): (cmd: string) => Promise<HostBashResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const run = deps.run ?? defaultRun
  const env = hostBashEnvironment(deps.env ?? process.env)

  return async (cmd: string): Promise<HostBashResult> => {
    if (typeof cmd !== 'string' || cmd.trim().length === 0) {
      return { stdout: '', stderr: 'пустая команда', exitCode: 2 }
    }
    let bypass = false
    try { bypass = deps.bypass?.() === true } catch { /* fail closed */ }
    if (!bypass && refusedHostCommand(cmd)) {
      return {
        stdout: '',
        stderr: 'команда отклонена как необратимая; выполни её сам, если это правда нужно',
        exitCode: 126,
      }
    }
    const result = await run(cmd, {
      cwd: deps.workspaceRoot,
      timeoutMs,
      env,
      maxBuffer: maxOutputBytes * 2,
    })
    return {
      stdout: bounded(result.stdout, maxOutputBytes),
      stderr: bounded(result.stderr, maxOutputBytes),
      exitCode: result.exitCode,
    }
  }
}

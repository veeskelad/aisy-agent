// CLI subprocess provider adapter (runtime).
//
// Drives a local CLI (e.g. `claude -p`) as a model backend — no API key, uses
// the CLI's own auth/subscription. The assembled conversation is fed on stdin
// and stdout is taken as the reply. Reply-only: structured tool-calling is not
// available over a plain CLI, so the agent degrades to no-tools for this
// provider (documented limitation). The spawn is injected for tests.

import { spawn } from 'node:child_process'
import type {
  ProviderAdapter,
  ModelRequest,
  ModelResponse,
  ContextSpan,
  ProviderError,
} from '../agent-loop/types.js'

export interface CliRunResult {
  stdout: string
  exitCode: number
}

export interface CliProviderDeps {
  /** argv prefix, e.g. ['claude', '-p'] or ['gemini']. */
  command: string[]
  /** Optional model flag appended as `--model <model>` when set. */
  model?: string
  /** Run argv with `input` on stdin → stdout/exit. Injected for tests. */
  run?: (argv: string[], input: string) => Promise<CliRunResult>
  timeoutMs?: number
}

class CliError extends Error implements ProviderError {
  constructor(public readonly kind: ProviderError['kind'], message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Flatten spans into a plain-text transcript for a CLI prompt. */
export function promptFromSpans(spans: ContextSpan[], prefix: string): string {
  const parts: string[] = []
  if (prefix.length > 0) parts.push(prefix)
  for (const s of spans) {
    const label = s.role === 'system' ? 'System' : s.role === 'assistant' ? 'Assistant' : s.role === 'tool' ? 'Tool' : 'User'
    parts.push(`${label}: ${s.text}`)
  }
  return parts.join('\n\n')
}

function defaultRun(timeoutMs: number): (argv: string[], input: string) => Promise<CliRunResult> {
  return (argv, input) =>
    new Promise<CliRunResult>((resolve, reject) => {
      const [cmd, ...args] = argv
      if (!cmd) {
        reject(new CliError('server-error', 'empty CLI command'))
        return
      }
      const child = spawn(cmd, args, { timeout: timeoutMs })
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += String(d)))
      child.on('error', (e) => reject(new CliError('server-error', `CLI spawn failed: ${e.message}`)))
      child.on('close', (code) => resolve({ stdout, exitCode: code ?? 0 }))
      child.stdin.end(input)
    })
}

export function makeCliProvider(deps: CliProviderDeps): ProviderAdapter {
  const run = deps.run ?? defaultRun(deps.timeoutMs ?? 120_000)
  const argv = deps.model ? [...deps.command, '--model', deps.model] : [...deps.command]

  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const prefix = req.prefixBytes.byteLength > 0 ? Buffer.from(req.prefixBytes).toString('utf8') : ''
      const prompt = promptFromSpans(req.spans, prefix)
      const r = await run(argv, prompt)
      if (r.exitCode !== 0) {
        throw new CliError('server-error', `CLI exited ${r.exitCode}`)
      }
      return { reply: r.stdout.trim() }
    },
  }
}

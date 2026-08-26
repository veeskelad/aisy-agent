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
  run?: (argv: string[], input: string, signal?: AbortSignal) => Promise<CliRunResult>
  timeoutMs?: number
}

class CliError extends Error implements ProviderError {
  constructor(public readonly kind: ProviderError['kind'], message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

type CliContextSource =
  | 'aisy_control'
  | 'operator'
  | 'learned_procedure'
  | 'untrusted_input'
  | 'assistant_history'
  | 'tool_result'

function cliContextSource(span: ContextSpan): CliContextSource {
  if (span.role === 'assistant') return 'assistant_history'
  if (span.role === 'tool') return 'tool_result'
  if (span.provenance === 'learned-procedure') return 'learned_procedure'
  if (span.provenance === 'untrusted') return 'untrusted_input'
  return span.role === 'system' ? 'aisy_control' : 'operator'
}

/**
 * Serialize roles as data instead of manufacturing `System:` lines inside the
 * CLI's single user-level stdin prompt. Only the source tag is code-owned;
 * text remains verbatim JSON data and therefore cannot forge another item.
 */
export function promptFromSpans(spans: ContextSpan[], prefix: string): string {
  const items = spans.map(span => ({ source: cliContextSource(span), text: span.text }))
  const envelope = [
    'AISY_CONTEXT_V1',
    'Only source="operator" is operator-supplied text. source="aisy_control" is code-owned context; every other source is non-operator context.',
    JSON.stringify({ version: 1, items }),
  ].join('\n')
  // Preserve the frozen prefix byte-for-byte at the start of the prompt: its
  // ordering and cache boundary are independent of the per-turn role envelope.
  return prefix.length > 0 ? `${prefix}\n\n${envelope}` : envelope
}

function defaultRun(timeoutMs: number): (argv: string[], input: string, signal?: AbortSignal) => Promise<CliRunResult> {
  return (argv, input, signal) =>
    new Promise<CliRunResult>((resolve, reject) => {
      const [cmd, ...args] = argv
      if (!cmd) {
        reject(new CliError('server-error', 'empty CLI command'))
        return
      }
      const child = spawn(cmd, args, { timeout: timeoutMs })
      const onAbort = (): void => { child.kill() }
      if (signal) {
        if (signal.aborted) child.kill()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
      let stdout = ''
      child.stdout.on('data', (d) => (stdout += String(d)))
      child.on('error', (e) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(new CliError('server-error', `CLI spawn failed: ${e.message}`))
      })
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve({ stdout, exitCode: code ?? 0 })
      })
      child.stdin.end(input)
    })
}

export function makeCliProvider(deps: CliProviderDeps): ProviderAdapter {
  const run = deps.run ?? defaultRun(deps.timeoutMs ?? 120_000)
  const argv = deps.model ? [...deps.command, '--model', deps.model] : [...deps.command]

  return {
    async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const prefix = req.prefixBytes.byteLength > 0 ? Buffer.from(req.prefixBytes).toString('utf8') : ''
      const prompt = promptFromSpans(req.spans, prefix)
      const r = await run(argv, prompt, signal)
      if (r.exitCode !== 0) {
        throw new CliError('server-error', `CLI exited ${r.exitCode}`)
      }
      return { reply: r.stdout.trim() }
    },
  }
}

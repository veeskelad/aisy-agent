// Claude subscription as the agent brain, with Aisy keeping the hands.
//
// `claude -p` cannot accept foreign tool schemas, so the only way to give it the
// Aisy narrow waist is MCP. Every native capability is stripped (`--tools ''`),
// a per-call loopback bridge publishes the Aisy catalogue, and each tool the
// model calls is executed back here through the real approval path. The CLI owns
// its inner loop; Aisy owns every side effect, which is what ADR-0057 requires
// of a supervised brain runtime.

import { spawn } from 'node:child_process'

import {
  actionEvidence,
  attachProviderActionEvidence,
  promptFromSpans,
  type ActionEvidence,
  type ModelProgressSink,
  type ModelRequest,
  type ModelResponse,
  type ModelToolRuntimeContext,
  type ProviderAdapter,
  type ProviderError,
} from '@aisy/core'

import {
  startAisyMcpBridge,
  type McpBridgeResult,
  type McpBridgeToolDefinition,
} from './mcp-bridge-server.js'

/** Tool names reach the model namespaced by the MCP server they came from. */
const MCP_SERVER_NAME = 'aisy'
const DEFAULT_TIMEOUT_MS = 600_000

export class ClaudeSubscriptionError extends Error implements ProviderError {
  constructor(
    public readonly kind: ProviderError['kind'],
    message: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ClaudeSubscriptionRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ClaudeSubscriptionDeps {
  /** Model id passed to the CLI, e.g. `sonnet` or a full model name. */
  model?: string
  /** Catalogue published to the model; only these names can ever be called. */
  tools: readonly McpBridgeToolDefinition[]
  /** Executes one approved-or-refused tool call inside the live composition. */
  invokeTool(
    call: { name: string; args: Record<string, unknown> },
    signal: AbortSignal,
    context: ModelToolRuntimeContext,
  ): Promise<McpBridgeResult>
  /** Executable name; injected in tests. */
  executable?: string
  /**
   * Environment for the CLI child. The subscription token lives in Aisy's
   * vault, not in the process environment, so without this the CLI would find
   * no credential and ask for a browser login that a server cannot open.
   */
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seam replacing the real subprocess. */
  run?(
    argv: readonly string[],
    input: string,
    signal: AbortSignal,
  ): Promise<ClaudeSubscriptionRunResult>
}

interface StreamOutcome {
  reply: string
  // `dollars` is always present: a subscription turn costs nothing extra, and
  // reporting 0 keeps the spend ledger honest instead of leaving a hole.
  usage: { inputTokens: number; outputTokens: number; dollars: number } | undefined
  mcpConnected: boolean
  nativeToolsExposed: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the `stream-json` transcript. The init frame is the only proof that the
 * bridge actually loaded: an unreachable `--mcp-config` does not fail the run,
 * it silently drops the server, and the model would then answer without tools.
 */
export function parseClaudeStream(
  stdout: string,
  onProgress?: ModelProgressSink,
): StreamOutcome {
  let reply = ''
  let usage: StreamOutcome['usage']
  let mcpConnected = false
  let nativeToolsExposed: readonly string[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: unknown
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!isRecord(event)) continue

    if (event['type'] === 'system' && event['subtype'] === 'init') {
      const servers = event['mcp_servers']
      if (Array.isArray(servers)) {
        mcpConnected = servers.some((entry) => isRecord(entry) &&
          entry['name'] === MCP_SERVER_NAME && entry['status'] === 'connected')
      }
      const exposed = event['tools']
      if (Array.isArray(exposed)) {
        nativeToolsExposed = exposed.filter((name): name is string =>
          typeof name === 'string' && !name.startsWith(`mcp__${MCP_SERVER_NAME}__`))
      }
      continue
    }

    if (event['type'] === 'stream_event') {
      const payload = event['event']
      if (isRecord(payload) && payload['type'] === 'content_block_delta') {
        const delta = payload['delta']
        if (isRecord(delta) && delta['type'] === 'text_delta' &&
          typeof delta['text'] === 'string' && delta['text'].length > 0) {
          void onProgress?.({ type: 'text-delta', text: delta['text'] })
        }
      }
      continue
    }

    if (event['type'] === 'result') {
      if (typeof event['result'] === 'string') reply = event['result']
      const reported = event['usage']
      if (isRecord(reported)) {
        const input = reported['input_tokens']
        const output = reported['output_tokens']
        if (typeof input === 'number' && typeof output === 'number') {
          const cost = event['total_cost_usd']
          usage = {
            inputTokens: input,
            outputTokens: output,
            dollars: typeof cost === 'number' ? cost : 0,
          }
        }
      }
      if (event['is_error'] === true) {
        throw new ClaudeSubscriptionError('server-error', `claude reported: ${reply || 'error'}`)
      }
    }
  }
  return { reply, usage, mcpConnected, nativeToolsExposed }
}

function defaultRun(executable: string, timeoutMs: number, environment?: NodeJS.ProcessEnv) {
  return (
    argv: readonly string[],
    input: string,
    signal: AbortSignal,
  ): Promise<ClaudeSubscriptionRunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, [...argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        ...(environment === undefined ? {} : { env: environment }),
      })
      const onAbort = (): void => { child.kill('SIGTERM') }
      if (signal.aborted) child.kill('SIGTERM')
      else signal.addEventListener('abort', onAbort, { once: true })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(new ClaudeSubscriptionError('server-error', `claude spawn failed: ${error.message}`))
      })
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort)
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      })
      child.stdin.end(input)
    })
}

/**
 * Builds the argv that hands the CLI a brain and nothing else: no built-in
 * tools, no user MCP servers, no project settings, no slash commands.
 */
export function buildClaudeSubscriptionArgs(input: {
  mcpConfig: string
  model?: string
  allowedTools: readonly string[]
}): readonly string[] {
  return Object.freeze([
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Settings, CLAUDE.md, plugins and hooks of the host machine must not leak
    // into the agent: the operator configures Aisy, not Claude Code.
    // NOT `--safe-mode` — it disables MCP too, which would silently drop the
    // bridge and leave the model with no tools at all (verified on 2.1.220).
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', input.mcpConfig,
    // No native capability survives this pair: the model may call only tools
    // Aisy published and Aisy executes.
    '--tools', '',
    '--allowedTools', input.allowedTools.join(' '),
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
    '--no-session-persistence',
    ...(input.model === undefined ? [] : ['--model', input.model]),
  ])
}

export function makeClaudeSubscriptionProvider(deps: ClaudeSubscriptionDeps): ProviderAdapter {
  const executable = deps.executable ?? 'claude'
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const run = deps.run ?? defaultRun(executable, timeoutMs, deps.environment)
  const allowedTools = deps.tools.map((tool) => `mcp__${MCP_SERVER_NAME}__${tool.name}`)

  return {
    async complete(
      req: ModelRequest,
      signal?: AbortSignal,
      onProgress?: ModelProgressSink,
    ): Promise<ModelResponse> {
      const abort = signal ?? new AbortController().signal
      let sequence = 0
      const actionEvidenceLog: ActionEvidence[] = []
      const bridge = await startAisyMcpBridge({
        serverName: MCP_SERVER_NAME,
        tools: deps.tools,
        invoke: async (call) => {
          const toolCallId = `mcp-${++sequence}`
          void onProgress?.({
            type: 'tool-requested', toolCallId, name: call.name, args: call.args,
          })
          const result = await deps.invokeTool(call, abort, Object.freeze({
            sessionId: req.sessionId,
            ...(req.turnId === undefined ? {} : { turnId: req.turnId }),
          }))
          void onProgress?.({ type: 'tool-result', toolCallId, result: result.text })
          return result
        },
        onResult: (call, result) => {
          actionEvidenceLog.push(actionEvidence(
            { name: call.name, args: call.args },
            { ok: !result.isError, ...(result.receipt === true ? { verified: true } : {}) },
          ))
        },
      })

      try {
        const mcpConfig = JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: 'http',
              url: bridge.url,
              headers: { authorization: `Bearer ${bridge.token}` },
            },
          },
        })
        const argv = buildClaudeSubscriptionArgs({
          mcpConfig,
          allowedTools,
          ...(deps.model === undefined ? {} : { model: deps.model }),
        })
        const prefix = req.prefixBytes.byteLength > 0
          ? Buffer.from(req.prefixBytes).toString('utf8')
          : ''
        void onProgress?.({ type: 'started' })
        const outcome = await run(argv, promptFromSpans(req.spans, prefix), abort)
        if (outcome.exitCode !== 0) {
          throw new ClaudeSubscriptionError(
            'server-error',
            `claude exited ${outcome.exitCode}: ${outcome.stderr.trim().slice(0, 400)}`,
          )
        }
        const parsed = parseClaudeStream(outcome.stdout, onProgress)
        // Fail closed on a silently dropped bridge or a surviving native tool:
        // either one means the turn ran outside Aisy's control.
        if (!parsed.mcpConnected) {
          throw new ClaudeSubscriptionError('server-error', 'MCP_BRIDGE_NOT_CONNECTED')
        }
        if (parsed.nativeToolsExposed.length > 0) {
          throw new ClaudeSubscriptionError('server-error', 'NATIVE_TOOLS_EXPOSED')
        }
        if (parsed.usage !== undefined) void onProgress?.({ type: 'usage', ...parsed.usage })
        return attachProviderActionEvidence({
          reply: parsed.reply,
          ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        }, actionEvidenceLog)
      } finally {
        await bridge.close()
      }
    },
  }
}

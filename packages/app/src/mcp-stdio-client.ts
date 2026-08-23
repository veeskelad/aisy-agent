// The MCP client transport: JSON-RPC over a child process's stdin/stdout.
//
// Everything above this file is already written — `planMcpTransport` validates
// the argv before anything is spawned, and `openMcpWireSession` validates every
// byte that comes back. This is the missing middle: framing, era detection and
// process lifetime, and nothing else. It deliberately does not parse tool
// descriptors or decide which era is permitted; the wire adapter owns that.
//
// The 2026-07-28 revision made MCP stateless: there is no `initialize`
// handshake and no session, every request carries its protocol version and
// capabilities in `_meta`, and servers MUST implement `server/discover`. The
// probe below is exactly the stdio backward-compatibility procedure from that
// revision: `server/discover` first, a modern error means a modern server that
// refuses this version (never fall back), anything else — including silence —
// means a legacy server that still expects `initialize`.
//
// The same reasoning covers the dependency: the framing MCP needs over stdio is
// newline-delimited JSON-RPC, which the bridge server in this package already
// speaks in the other direction. An SDK would add a supply chain for four
// methods.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { McpSdkClientPlan, McpSdkClientPort } from '@aisy/core'

/** A server that has not answered in this long is not going to. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
/** One JSON-RPC frame. Past this the server is streaming, not answering. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024
/** Kept only to explain a failure to the operator; never fed to the model. */
const MAX_STDERR_BYTES = 8 * 1024
const CLIENT_INFO = Object.freeze({ name: 'aisy', version: '1' })
/** Reserved `_meta` keys of the modern era (spec 2026-07-28 §"General fields"). */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
/** UnsupportedProtocolVersionError — the one error that proves a modern server. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022

export type McpStdioFailure =
  | 'SPAWN_FAILED'
  | 'PROCESS_EXITED'
  | 'TIMEOUT'
  | 'FRAME_TOO_LARGE'
  | 'INVALID_FRAME'
  | 'RPC_ERROR'
  | 'CLOSED'

export class McpStdioError extends Error {
  constructor(readonly reason: McpStdioFailure, readonly detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`)
    this.name = 'McpStdioError'
  }
}

/** The port the wire adapter needs, plus the identity only the transport sees. */
export interface McpStdioClientPort extends McpSdkClientPort {
  serverIdentity(): McpServerIdentity | null
}

export interface McpStdioClientInput {
  /** Exact argv, already validated by `planMcpTransport`. */
  command: readonly string[]
  /** Only these variables reach the child. The parent environment does not. */
  env?: Record<string, string>
  /** Working directory for the server process. */
  cwd?: string
  requestTimeoutMs?: number
  /** Test seam: replaces the real spawn. */
  spawnProcess?: (command: readonly string[], env: Record<string, string>, cwd?: string)
    => ChildProcessWithoutNullStreams
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

class RpcError extends Error {
  constructor(readonly code: number, readonly detail: string, readonly data: unknown) {
    super(detail)
    this.name = 'RpcError'
  }
}

function isResponse(value: unknown): value is JsonRpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return frame['jsonrpc'] === '2.0' && typeof frame['id'] === 'number'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * What the server calls itself. Self-reported and unverified — the spec says so
 * outright — so it is bounded and stripped here before anything upstream turns
 * it into a pin. It answers "did this become a different build", never "is this
 * server trustworthy".
 */
export interface McpServerIdentity {
  readonly name: string
  readonly version: string
}

function readIdentity(value: unknown): McpServerIdentity | null {
  const record = asRecord(value)
  const name = record?.['name']
  const version = record?.['version']
  if (typeof name !== 'string' || typeof version !== 'string') return null
  const clean = (text: string): string => text.replace(/[\p{C}]/gu, '').trim().slice(0, 128)
  const [safeName, safeVersion] = [clean(name), clean(version)]
  return safeName.length === 0 || safeVersion.length === 0
    ? null
    : Object.freeze({ name: safeName, version: safeVersion })
}

function spawnServer(
  command: readonly string[],
  env: Record<string, string>,
  cwd?: string,
): ChildProcessWithoutNullStreams {
  const [binary, ...args] = command
  return spawn(binary!, args, {
    // No shell, ever: the argv was validated as argv, and a shell would give a
    // server name a second meaning.
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    ...(cwd === undefined ? {} : { cwd }),
  }) as ChildProcessWithoutNullStreams
}

/**
 * Opens one server process and speaks JSON-RPC to it. The port is single-use in
 * practice: the wire adapter allows one `listTools` and one `callTool` per
 * session, so a caller gets a fresh process per operation and a crashed server
 * can never leak state into the next one.
 */
export function makeMcpStdioClient(input: McpStdioClientInput): (plan: McpSdkClientPlan) => McpStdioClientPort {
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const startProcess = input.spawnProcess ?? spawnServer

  return (plan: McpSdkClientPlan): McpStdioClientPort => {
    let child: ChildProcessWithoutNullStreams | null = null
    let closed = false
    let exited: string | null = null
    let stdout = ''
    let stderr = ''
    let nextId = 1
    let negotiated: { era: 'legacy' | 'modern'; version: string } | null = null
    let identity: McpServerIdentity | null = null
    const pending = new Map<number, {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }>()

    const failAll = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error)
      pending.clear()
    }

    const consumeFrames = (): void => {
      for (;;) {
        const end = stdout.indexOf('\n')
        if (end < 0) {
          // A server that writes forever without a newline is not framing; stop
          // before its output becomes this process's memory problem.
          if (Buffer.byteLength(stdout, 'utf8') > MAX_FRAME_BYTES) {
            failAll(new McpStdioError('FRAME_TOO_LARGE'))
            void stop()
          }
          return
        }
        const line = stdout.slice(0, end).trim()
        stdout = stdout.slice(end + 1)
        if (line.length === 0) continue
        let frame: unknown
        try { frame = JSON.parse(line) } catch {
          failAll(new McpStdioError('INVALID_FRAME'))
          void stop()
          return
        }
        // Server-initiated notifications carry no id we are waiting on. Ignoring
        // them is correct: this client subscribes to nothing and advertises no
        // capabilities, so nothing it needs arrives unsolicited.
        if (!isResponse(frame)) continue
        const waiter = pending.get(frame.id)
        if (waiter === undefined) continue
        pending.delete(frame.id)
        if (frame.error !== undefined) {
          const message = typeof frame.error.message === 'string' ? frame.error.message : 'error'
          const code = typeof frame.error.code === 'number' ? frame.error.code : 0
          waiter.reject(new RpcError(code, message.slice(0, 200), frame.error.data))
        } else {
          waiter.resolve(frame.result)
        }
      }
    }

    const stop = async (): Promise<void> => {
      if (closed) return
      closed = true
      const running = child
      child = null
      failAll(new McpStdioError('CLOSED'))
      if (running === null) return
      // Closing stdin is the portable shutdown signal and the only one the spec
      // requires servers to honour; the signals below are the fallback.
      try { running.stdin.end() } catch { /* the process may already be gone */ }
      try { running.kill('SIGTERM') } catch { /* already exited */ }
      await new Promise<void>((resolve) => {
        if (running.exitCode !== null || running.signalCode !== null) { resolve(); return }
        const timer = setTimeout(() => {
          try { running.kill('SIGKILL') } catch { /* nothing left to kill */ }
          resolve()
        }, 2_000)
        timer.unref?.()
        running.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }

    const send = async (
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs?: number; fatal?: boolean },
    ): Promise<unknown> => {
      const running = child
      if (closed || running === null) throw new McpStdioError('CLOSED')
      if (exited !== null) throw new McpStdioError('PROCESS_EXITED', exited)
      const id = nextId++
      const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      const deadline = options?.timeoutMs ?? timeoutMs
      const fatal = options?.fatal ?? true
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new McpStdioError('TIMEOUT', method))
          // The era probe is allowed to time out — a legacy server that ignores
          // an unknown method is exactly what silence means there, and killing
          // the process would throw away the very server we are identifying.
          if (fatal) void stop()
        }, deadline)
        timer.unref?.()
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        })
        try {
          running.stdin.write(frame)
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new McpStdioError('PROCESS_EXITED', error instanceof Error ? error.message : undefined))
        }
      })
    }

    const notify = (method: string): void => {
      try { child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) } catch {
        /* a server that died before the notification will fail the next request */
      }
    }

    /** Modern requests are self-describing: no prior request establishes them. */
    const modernParams = (params: Record<string, unknown>): Record<string, unknown> => ({
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: negotiated?.version ?? plan.supportedProtocolVersions[0],
        [META_CLIENT_INFO]: { ...CLIENT_INFO },
        [META_CLIENT_CAPABILITIES]: {},
      },
    })

    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const wrapped = negotiated?.era === 'legacy' ? params : modernParams(params)
      try {
        return await send(method, wrapped)
      } catch (error) {
        if (error instanceof RpcError) {
          throw new McpStdioError('RPC_ERROR', `${String(error.code)} ${error.detail}`)
        }
        throw error
      }
    }

    /** `server/discover`: modern result, modern refusal, or "this is legacy". */
    const probe = async (version: string): Promise<
      | { kind: 'modern'; versions: string[] }
      | { kind: 'refused' }
      | { kind: 'legacy' }
    > => {
      negotiated = { era: 'modern', version }
      let result: unknown
      try {
        result = await send('server/discover', modernParams({}), {
          timeoutMs: plan.versionNegotiation.probe.timeoutMs,
          fatal: false,
        })
      } catch (error) {
        negotiated = null
        // Only a recognized modern error identifies a modern server. Every other
        // error — unknown method, malformed params, silence — is a legacy server
        // answering a question it was never taught, and the fallback must not be
        // keyed to any single code.
        if (error instanceof RpcError && error.code === UNSUPPORTED_PROTOCOL_VERSION) {
          return { kind: 'refused' }
        }
        if (error instanceof McpStdioError && error.reason === 'TIMEOUT') return { kind: 'legacy' }
        if (error instanceof RpcError) return { kind: 'legacy' }
        throw error
      }
      negotiated = null
      identity = readIdentity(asRecord(asRecord(result)?.['_meta'])?.[META_SERVER_INFO])
      const listed = asRecord(result)?.['supportedVersions']
      return {
        kind: 'modern',
        versions: Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string') : [],
      }
    }

    /** The legacy era, kept alive only for servers a human explicitly approved. */
    const legacyHandshake = async (version: string): Promise<void> => {
      const result = await send('initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { ...CLIENT_INFO },
      })
      const agreed = asRecord(result)?.['protocolVersion']
      if (agreed === version) {
        negotiated = { era: 'legacy', version }
        identity = readIdentity(asRecord(result)?.['serverInfo'])
        notify('notifications/initialized')
      }
    }

    return Object.freeze<McpStdioClientPort>({
      async connect(): Promise<void> {
        if (closed) throw new McpStdioError('CLOSED')
        try {
          child = startProcess(input.command, input.env ?? {}, input.cwd)
        } catch (error) {
          throw new McpStdioError('SPAWN_FAILED', error instanceof Error ? error.message : undefined)
        }
        const running = child
        running.stdout.setEncoding('utf8')
        running.stdout.on('data', (chunk: string) => { stdout += chunk; consumeFrames() })
        running.stderr.setEncoding('utf8')
        running.stderr.on('data', (chunk: string) => {
          // Drained on purpose: a full stderr pipe blocks the child forever. The
          // spec is explicit that stderr output does not mean failure.
          if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
        })
        running.once('error', (error: Error) => {
          exited = error.message
          failAll(new McpStdioError('SPAWN_FAILED', error.message))
        })
        running.once('exit', (code, signal) => {
          exited = `code ${String(code)} signal ${String(signal)}`
          failAll(new McpStdioError('PROCESS_EXITED', stderr.trim().slice(0, 200) || exited))
        })

        // The plan lists what this client supports, modern first. The pinned
        // mode offers exactly one version; auto additionally accepts the legacy
        // era, which the manifest only reaches after a human approved it.
        const preferred = plan.versionNegotiation.mode === 'auto'
          ? plan.supportedProtocolVersions[0]!
          : plan.versionNegotiation.mode.pin
        const legacyFallback = plan.supportedProtocolVersions.slice(1)

        const outcome = await probe(preferred)
        if (outcome.kind === 'modern') {
          // Era comes from the exchange, never from what the server says about
          // itself: the version has to be one we offered *and* one it listed.
          if (outcome.versions.includes(preferred)) negotiated = { era: 'modern', version: preferred }
          return
        }
        if (outcome.kind === 'refused') {
          // A modern server that will not speak our only modern version. There
          // is nothing to retry with, and the spec forbids falling back to
          // `initialize` here — a refusal is a refusal, not an older server.
          return
        }
        // Legacy: only for a plan that carries an approved legacy version.
        const legacyVersion = legacyFallback[0]
        if (legacyVersion === undefined) return
        await legacyHandshake(legacyVersion)
      },

      negotiatedProtocol: () => negotiated,

      serverIdentity: () => identity,

      listTools: async (cursor?: string) =>
        await request('tools/list', cursor === undefined ? {} : { cursor }),

      callTool: async (call: { name: string; arguments: Record<string, unknown> }) =>
        await request('tools/call', { name: call.name, arguments: call.arguments }),

      close: stop,
    })
  }
}

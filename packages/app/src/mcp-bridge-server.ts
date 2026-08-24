// Aisy as an MCP server (ADR: subscription brain over a local MCP bridge).
//
// A subscription CLI (Claude Code) cannot accept foreign tool schemas — it only
// reaches outside tools over MCP. This server publishes the Aisy narrow-waist
// catalogue so the CLI reasons while Aisy keeps the hands: every call comes back
// here and runs through the same lease/safety/approval path as a native turn.
//
// Transport is loopback HTTP rather than stdio on purpose: stdio would make the
// CLI spawn a second Aisy process, which would need its own memory locks and
// would execute outside the live composition. Here the bridge lives inside the
// running agent. The listener binds 127.0.0.1 only and every request must carry
// a bearer token minted per process start.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Canonical MCP revision Aisy speaks as a server; the client may ask for another. */
export const MCP_BRIDGE_PROTOCOL_VERSION = '2025-11-25'
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 1024 * 1024
const TOOL_PREFIX = 'aisy'

export interface McpBridgeToolDefinition {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

export interface McpBridgeInvocation {
  readonly name: string
  readonly args: Record<string, unknown>
}

export interface McpBridgeResult {
  readonly text: string
  readonly isError: boolean
  /** In-process verification metadata. Never serialized onto the MCP wire. */
  readonly receipt?: boolean
}

export interface AisyMcpBridge {
  /** Loopback URL the CLI must be pointed at. */
  readonly url: string
  /** Bearer token required on every request. Never logged. */
  readonly token: string
  /** MCP server name; tools appear to the model as `mcp__aisy__<tool>`. */
  readonly serverName: string
  /** Seals a Codex-only bridge to the exact app-server turn before tools run. */
  bindCodexTurn(threadId: string, turnId: string): void
  close(): Promise<void>
}

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRequest(value: unknown): JsonRpcRequest | null {
  if (!isRecord(value)) return null
  if (value['jsonrpc'] !== '2.0') return null
  const method = value['method']
  if (typeof method !== 'string' || method.length === 0) return null
  const id = value['id']
  if (id !== undefined && typeof id !== 'string' && typeof id !== 'number' && id !== null) {
    return null
  }
  return {
    jsonrpc: '2.0',
    method,
    ...(id === undefined ? {} : { id: id as JsonRpcId }),
    ...(value['params'] === undefined ? {} : { params: value['params'] }),
  }
}

function canonicalJson(value: unknown, depth = 0, state = { nodes: 0 }): string | null {
  state.nodes++
  if (state.nodes > 4096 || depth > 16) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null
  if (Array.isArray(value)) {
    const items: string[] = []
    for (const item of value) {
      const encoded = canonicalJson(item, depth + 1, state)
      if (encoded === null) return null
      items.push(encoded)
    }
    return `[${items.join(',')}]`
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length > 256) {
      return null
    }
    const encoded = canonicalJson(value[key], depth + 1, state)
    if (encoded === null) return null
    entries.push(`${JSON.stringify(key)}:${encoded}`)
  }
  return `{${entries.join(',')}}`
}

/** Constant-time compare so a wrong token cannot be discovered byte by byte. */
function sameToken(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers['authorization']
  if (typeof header !== 'string') return null
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match?.[1] ?? null
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  })
  response.end(body)
}

/**
 * Publishes the given tools over MCP and routes every call to `invoke`. The
 * caller owns safety: `invoke` is expected to run the same approval path a
 * native turn would, and its refusals come back to the model as tool errors so
 * the CLI loop can react instead of dying.
 */
export async function startAisyMcpBridge(input: {
  tools: readonly McpBridgeToolDefinition[]
  invoke(call: McpBridgeInvocation): Promise<McpBridgeResult>
  /** Runs only after the executor result passed the bridge's shape/size checks. */
  onResult?: (call: McpBridgeInvocation, result: McpBridgeResult) => void
  /** Test seam; production mints a fresh 256-bit token per process. */
  newToken?: () => string
  serverName?: string
  requireCodexTurnBinding?: boolean
}): Promise<AisyMcpBridge> {
  const token = input.newToken?.() ?? randomBytes(32).toString('hex')
  const serverName = input.serverName ?? TOOL_PREFIX
  const listed = input.tools.map((tool) => Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  }))
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]))
  let codexTurn: Readonly<{ threadId: string; turnId: string }> | null = null
  const calls = new Map<string, { hash: string; answer: Promise<unknown> }>()

  const exactCodexTurn = (params: Record<string, unknown>): boolean => {
    if (input.requireCodexTurnBinding !== true) return true
    if (codexTurn === null) return false
    const meta = params['_meta']
    if (!isRecord(meta)) return false
    const turn = meta['x-codex-turn-metadata']
    return isRecord(turn) && turn['session_id'] === codexTurn.threadId &&
      turn['thread_id'] === codexTurn.threadId && turn['turn_id'] === codexTurn.turnId
  }

  const handle = async (request: JsonRpcRequest): Promise<unknown | undefined> => {
    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {}
        const asked = params['protocolVersion']
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          result: {
            // Echo a version the client understands; it drives the handshake.
            protocolVersion: typeof asked === 'string' ? asked : MCP_BRIDGE_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: serverName, version: '1.0.0' },
          },
        }
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined
      case 'ping':
        return { jsonrpc: '2.0', id: request.id ?? null, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: listed } }
      case 'tools/call': {
        const params = isRecord(request.params) ? request.params : {}
        if (!exactCodexTurn(params)) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32001, message: 'capability context inactive' },
          }
        }
        const name = params['name']
        if (typeof name !== 'string' || !byName.has(name)) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32602, message: 'unknown tool' },
          }
        }
        const rawArgs = params['arguments']
        const args = isRecord(rawArgs) ? rawArgs : {}
        if (request.id === undefined || request.id === null) {
          return {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32600, message: 'invalid request' },
          }
        }
        const encoded = canonicalJson(params['_meta'] === undefined
          ? { name, args }
          : { name, args, _meta: params['_meta'] })
        if (encoded === null) {
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32602, message: 'invalid arguments' },
          }
        }
        const callId = `${typeof request.id}:${String(request.id)}`
        const hash = createHash('sha256').update(encoded).digest('hex')
        const prior = calls.get(callId)
        if (prior !== undefined) {
          if (prior.hash !== hash) {
            return {
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32002, message: 'capability replay mismatch' },
            }
          }
          return prior.answer
        }
        if (calls.size >= 128) {
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32003, message: 'capability budget exceeded' },
          }
        }
        // A thrown handler must not kill the CLI loop: MCP models a failed tool
        // as a result with isError, which the model can read and route around.
        const answer = (async (): Promise<unknown> => {
          let result: McpBridgeResult
          try {
            result = await input.invoke({ name, args })
          } catch {
            result = { text: 'TOOL_EXECUTION_FAILED', isError: true }
          }
          if (typeof result?.text !== 'string' || typeof result.isError !== 'boolean' ||
            (result.receipt !== undefined && typeof result.receipt !== 'boolean') ||
            Buffer.byteLength(result.text, 'utf8') > MAX_RESULT_BYTES) {
            result = { text: 'TOOL_EXECUTION_FAILED', isError: true }
          }
          try { input.onResult?.({ name, args }, result) } catch { /* evidence stays fail-closed */ }
          return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [{ type: 'text', text: result.text }],
              isError: result.isError,
            },
          }
        })()
        calls.set(callId, { hash, answer })
        return answer
      }
      default:
        if (request.id === undefined) return undefined
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32601, message: 'method not found' },
        }
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || (request.url ?? '') !== '/mcp') {
        send(response, 404, { error: 'not found' })
        return
      }
      const provided = bearer(request)
      if (provided === null || !sameToken(token, provided)) {
        send(response, 401, { error: 'unauthorized' })
        return
      }
      const body = await readBody(request)
      if (body === null) {
        send(response, 413, { error: 'payload too large' })
        return
      }
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch {
        send(response, 400, {
          jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' },
        })
        return
      }
      const rpc = parseRequest(parsed)
      if (rpc === null) {
        send(response, 400, {
          jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' },
        })
        return
      }
      const answer = await handle(rpc)
      // Notifications carry no id and must be acknowledged with an empty 202.
      if (answer === undefined) { send(response, 202, undefined); return }
      send(response, 200, answer)
    })().catch(() => {
      try { send(response, 500, { error: 'internal' }) } catch { /* already sent */ }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('MCP_BRIDGE_ADDRESS_UNAVAILABLE')
  }

  return Object.freeze<AisyMcpBridge>({
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    serverName,
    bindCodexTurn(threadId, turnId) {
      if (codexTurn !== null || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(threadId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(turnId)) {
        throw new Error('MCP_BRIDGE_TURN_BINDING_REJECTED')
      }
      codexTurn = Object.freeze({ threadId, turnId })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  })
}

import type { RawDescriptor } from './types.js'

export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25' as const
export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28' as const

export type McpProtocolEra = 'legacy' | 'modern'
export type McpWirePolicy = { mode: 'modern-only' } | { mode: 'dual-era' }

export interface McpSdkClientPlan {
  readonly supportedProtocolVersions: readonly string[]
  readonly versionNegotiation: {
    readonly mode: 'auto' | { readonly pin: typeof MCP_MODERN_PROTOCOL_VERSION }
    readonly probe: { readonly timeoutMs: number; readonly maxRetries: 0 }
  }
  /** Aisy deliberately supplies no cached era verdict to a new one-shot handle. */
  readonly usePriorDiscovery: false
}

export interface McpSdkClientPort {
  connect(): Promise<void>
  negotiatedProtocol(): { era: McpProtocolEra; version: string } | null
  listTools(cursor?: string): Promise<unknown>
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

export type McpWireEvent =
  | 'mcp.wire_negotiated'
  | 'mcp.wire_refused'
  | 'mcp.wire_closed'

export type McpWireErrorCode =
  | 'INVALID_POLICY'
  | 'NEGOTIATION_FAILED'
  | 'NEGOTIATION_EVIDENCE_MISSING'
  | 'ERA_NOT_ALLOWED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'SESSION_CLOSED'
  | 'LIST_ALREADY_USED'
  | 'CALL_ALREADY_USED'
  | 'INVALID_TOOLS_RESULT'
  | 'TOOLS_PAGE_LIMIT'
  | 'TOOLS_LIMIT'
  | 'PAGINATION_LOOP'
  | 'DUPLICATE_TOOL'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_CALL_ARGUMENTS'
  | 'RESULT_LIMIT'
  | 'INVALID_CALL_RESULT'
  | 'UNSUPPORTED_RESULT_CONTENT'
  | 'UNSUPPORTED_RESULT_TYPE'

export class McpWireError extends Error {
  constructor(readonly code: McpWireErrorCode) {
    super(code)
    this.name = 'McpWireError'
  }
}

export interface McpWireCallResult {
  readonly text: string
  readonly isError: boolean
  /** Kept out of prompt text; 2026-07-28 permits any bounded JSON value here. */
  readonly structuredContent?: unknown
}

export interface McpWireSession {
  readonly era: McpProtocolEra
  readonly version: typeof MCP_LEGACY_PROTOCOL_VERSION | typeof MCP_MODERN_PROTOCOL_VERSION
  listDescriptors(): Promise<RawDescriptor[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpWireCallResult>
  close(): Promise<void>
}

export interface OpenMcpWireSessionOptions {
  policy: McpWirePolicy
  createClient(plan: McpSdkClientPlan): McpSdkClientPort
  emit?(event: McpWireEvent, payload: Record<string, unknown>): void
  probeTimeoutMs?: number
  maxPages?: number
  maxTools?: number
  maxPageBytes?: number
  maxResultBytes?: number
  maxTextBytes?: number
}

const TOOL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TOOL_KEYS = new Set([
  'name', 'title', 'description', 'inputSchema', 'outputSchema',
  'annotations', 'execution', 'icons', '_meta',
])
const EXECUTION_KEYS = new Set(['taskSupport'])
const LIST_KEYS = new Set(['tools', 'nextCursor', '_meta', 'ttlMs', 'cacheScope', 'resultType'])
const CALL_KEYS = new Set(['content', 'structuredContent', 'isError', '_meta', 'resultType'])
const TEXT_BLOCK_KEYS = new Set(['type', 'text', 'annotations', '_meta'])

function record(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  } catch {
    return false
  }
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function validJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  budget.nodes += 1
  if (budget.nodes > 65_536 || depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1, budget))
  if (!record(value)) return false
  return Object.entries(value).every(([key, item]) =>
    key.length > 0 && key.length <= 256 && !key.includes('\0') && validJson(item, depth + 1, budget))
}

function jsonBytes(value: unknown): number | null {
  try {
    if (!validJson(value)) return null
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' ? Buffer.byteLength(encoded, 'utf8') : null
  } catch {
    return null
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function parseDescriptor(value: unknown): RawDescriptor {
  if (!record(value) || !exactKeys(value, TOOL_KEYS) ||
    typeof value.name !== 'string' || !TOOL_NAME.test(value.name) ||
    (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 8192 || value.description.includes('\0'))) ||
    !record(value.inputSchema) || value.inputSchema.type !== 'object' ||
    (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 256 || /[\r\n\0]/.test(value.title))) ||
    (value.outputSchema !== undefined && !record(value.outputSchema)) ||
    (value.annotations !== undefined && !record(value.annotations)) ||
    (value.execution !== undefined && (!record(value.execution) ||
      !exactKeys(value.execution, EXECUTION_KEYS) ||
      (value.execution.taskSupport !== undefined &&
        value.execution.taskSupport !== 'forbidden' &&
        value.execution.taskSupport !== 'optional' &&
        value.execution.taskSupport !== 'required'))) ||
    (value.icons !== undefined && (!Array.isArray(value.icons) || value.icons.length > 16 || !value.icons.every(record))) ||
    (value._meta !== undefined && !record(value._meta)) ||
    jsonBytes(value) === null || (jsonBytes(value) as number) > 128 * 1024) {
    throw new McpWireError('INVALID_DESCRIPTOR')
  }

  const descriptor: RawDescriptor = {
    name: value.name,
    description: value.description ?? '',
    inputSchema: cloneRecord(value.inputSchema),
  }
  if (typeof value.title === 'string') descriptor.title = value.title
  if (record(value.outputSchema)) descriptor.outputSchema = cloneRecord(value.outputSchema)
  if (record(value.annotations)) descriptor.annotations = cloneRecord(value.annotations)
  if (record(value.execution)) descriptor.execution = cloneRecord(value.execution)
  if (Array.isArray(value.icons)) descriptor.icons = value.icons.map(icon => cloneRecord(icon as Record<string, unknown>))
  if (record(value._meta)) descriptor._meta = cloneRecord(value._meta)
  return descriptor
}

/** 2026-07-28 tags every result. An absent tag means `complete` — that is how
 *  earlier revisions are read. `input_required` is the multi round-trip pattern,
 *  where the server asks the client for sampling, elicitation or roots before it
 *  will finish; answering it would let a server drive the agent, so a tagged
 *  result that is not `complete` ends the session instead. */
function assertComplete(raw: Record<string, unknown>): void {
  if (raw['resultType'] === undefined || raw['resultType'] === 'complete') return
  throw new McpWireError('UNSUPPORTED_RESULT_TYPE')
}

function makePlan(policy: McpWirePolicy, probeTimeoutMs: number): McpSdkClientPlan {
  if (!record(policy) || !exactKeys(policy, new Set(['mode'])) ||
    (policy.mode !== 'modern-only' && policy.mode !== 'dual-era') ||
    !Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 100 || probeTimeoutMs > 30_000) {
    throw new McpWireError('INVALID_POLICY')
  }
  if (policy.mode === 'modern-only') {
    return Object.freeze({
      supportedProtocolVersions: Object.freeze([MCP_MODERN_PROTOCOL_VERSION]),
      versionNegotiation: Object.freeze({
        mode: Object.freeze({ pin: MCP_MODERN_PROTOCOL_VERSION }),
        probe: Object.freeze({ timeoutMs: probeTimeoutMs, maxRetries: 0 as const }),
      }),
      usePriorDiscovery: false as const,
    })
  }
  return Object.freeze({
    supportedProtocolVersions: Object.freeze([MCP_MODERN_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION]),
    versionNegotiation: Object.freeze({
      mode: 'auto' as const,
      probe: Object.freeze({ timeoutMs: probeTimeoutMs, maxRetries: 0 as const }),
    }),
    usePriorDiscovery: false as const,
  })
}

export async function openMcpWireSession(options: OpenMcpWireSessionOptions): Promise<McpWireSession> {
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
  const maxPages = options.maxPages ?? 16
  const maxTools = options.maxTools ?? 256
  const maxPageBytes = options.maxPageBytes ?? 1024 * 1024
  const maxResultBytes = options.maxResultBytes ?? 1024 * 1024
  const maxTextBytes = options.maxTextBytes ?? 256 * 1024
  if (![maxPages, maxTools, maxPageBytes, maxResultBytes, maxTextBytes]
    .every(value => Number.isInteger(value) && value > 0) ||
    maxPages > 64 || maxTools > 1024 || maxPageBytes > 4 * 1024 * 1024 ||
    maxResultBytes > 4 * 1024 * 1024 || maxTextBytes > 1024 * 1024) {
    throw new McpWireError('INVALID_POLICY')
  }

  const plan = makePlan(options.policy, probeTimeoutMs)
  let client: McpSdkClientPort
  try {
    client = options.createClient(plan)
  } catch {
    options.emit?.('mcp.wire_refused', { reason: 'NEGOTIATION_FAILED' })
    throw new McpWireError('NEGOTIATION_FAILED')
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    try { await client.close() } catch { /* close is best-effort; session remains closed */ }
    options.emit?.('mcp.wire_closed', {})
  }
  const refuse = async (code: McpWireErrorCode): Promise<never> => {
    options.emit?.('mcp.wire_refused', { reason: code })
    await close()
    throw new McpWireError(code)
  }

  try {
    await client.connect()
  } catch {
    return refuse('NEGOTIATION_FAILED')
  }

  let negotiated: ReturnType<McpSdkClientPort['negotiatedProtocol']>
  try { negotiated = client.negotiatedProtocol() } catch {
    return refuse('NEGOTIATION_EVIDENCE_MISSING')
  }
  if (negotiated === null) return refuse('NEGOTIATION_EVIDENCE_MISSING')
  if (negotiated.era !== 'modern' && negotiated.era !== 'legacy') return refuse('ERA_NOT_ALLOWED')
  if (negotiated.era === 'modern' && negotiated.version !== MCP_MODERN_PROTOCOL_VERSION) {
    return refuse('PROTOCOL_VERSION_MISMATCH')
  }
  if (negotiated.era === 'legacy' && negotiated.version !== MCP_LEGACY_PROTOCOL_VERSION) {
    return refuse('PROTOCOL_VERSION_MISMATCH')
  }
  if (options.policy.mode === 'modern-only' && negotiated.era !== 'modern') {
    return refuse('ERA_NOT_ALLOWED')
  }

  const version = negotiated.era === 'modern' ? MCP_MODERN_PROTOCOL_VERSION : MCP_LEGACY_PROTOCOL_VERSION
  options.emit?.('mcp.wire_negotiated', { era: negotiated.era, version })
  let listUsed = false
  let callUsed = false

  return Object.freeze({
    era: negotiated.era,
    version,
    async listDescriptors(): Promise<RawDescriptor[]> {
      if (closed) throw new McpWireError('SESSION_CLOSED')
      if (listUsed) throw new McpWireError('LIST_ALREADY_USED')
      listUsed = true
      try {
        const descriptors: RawDescriptor[] = []
        const names = new Set<string>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < maxPages; page += 1) {
          let raw: unknown
          try { raw = await client.listTools(cursor) } catch { throw new McpWireError('INVALID_TOOLS_RESULT') }
          const size = jsonBytes(raw)
          if (size === null || size > maxPageBytes) throw new McpWireError('INVALID_TOOLS_RESULT')
          if (!record(raw) || !exactKeys(raw, LIST_KEYS) || !Array.isArray(raw.tools) ||
            (raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || raw.nextCursor.length === 0 || raw.nextCursor.length > 2048)) ||
            (raw.ttlMs !== undefined && (typeof raw.ttlMs !== 'number' || !Number.isFinite(raw.ttlMs) || raw.ttlMs < 0)) ||
            (raw.cacheScope !== undefined && raw.cacheScope !== 'public' && raw.cacheScope !== 'private')) {
            throw new McpWireError('INVALID_TOOLS_RESULT')
          }
          assertComplete(raw)
          for (const tool of raw.tools) {
            const descriptor = parseDescriptor(tool)
            if (names.has(descriptor.name)) throw new McpWireError('DUPLICATE_TOOL')
            names.add(descriptor.name)
            descriptors.push(descriptor)
            if (descriptors.length > maxTools) throw new McpWireError('TOOLS_LIMIT')
          }
          if (raw.nextCursor === undefined) return descriptors
          if (cursors.has(raw.nextCursor)) throw new McpWireError('PAGINATION_LOOP')
          cursors.add(raw.nextCursor)
          cursor = raw.nextCursor
        }
        throw new McpWireError('TOOLS_PAGE_LIMIT')
      } catch (error) {
        await close()
        if (error instanceof McpWireError) throw error
        throw new McpWireError('INVALID_TOOLS_RESULT')
      }
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpWireCallResult> {
      if (closed) throw new McpWireError('SESSION_CLOSED')
      if (callUsed) throw new McpWireError('CALL_ALREADY_USED')
      callUsed = true
      if (!TOOL_NAME.test(name) || !record(args) || jsonBytes(args) === null || (jsonBytes(args) as number) > 64 * 1024) {
        await close()
        throw new McpWireError('INVALID_CALL_ARGUMENTS')
      }
      try {
        let raw: unknown
        try { raw = await client.callTool({ name, arguments: cloneRecord(args) }) } catch {
          throw new McpWireError('INVALID_CALL_RESULT')
        }
        const resultSize = jsonBytes(raw)
        if (resultSize === null || resultSize > maxResultBytes) throw new McpWireError('RESULT_LIMIT')
        if (!record(raw) || !exactKeys(raw, CALL_KEYS) || !Array.isArray(raw.content) ||
          (raw.isError !== undefined && typeof raw.isError !== 'boolean') ||
          ('structuredContent' in raw && !validJson(raw.structuredContent))) {
          throw new McpWireError('INVALID_CALL_RESULT')
        }
        assertComplete(raw)
        let text = ''
        for (const block of raw.content) {
          if (!record(block) || !exactKeys(block, TEXT_BLOCK_KEYS) || block.type !== 'text' || typeof block.text !== 'string') {
            throw new McpWireError('UNSUPPORTED_RESULT_CONTENT')
          }
          text += block.text
          if (Buffer.byteLength(text, 'utf8') > maxTextBytes) throw new McpWireError('RESULT_LIMIT')
        }
        const result: { text: string; isError: boolean; structuredContent?: unknown } = {
          text,
          isError: raw.isError === true,
        }
        if ('structuredContent' in raw) result.structuredContent = cloneJson(raw.structuredContent)
        return Object.freeze(result)
      } catch (error) {
        await close()
        if (error instanceof McpWireError) throw error
        throw new McpWireError('INVALID_CALL_RESULT')
      }
    },
    close,
  })
}

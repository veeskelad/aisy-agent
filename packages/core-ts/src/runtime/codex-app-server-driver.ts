import { isAbsolute, normalize } from 'node:path'

import type {
  BrainDriver,
  BrainEvent,
  BrainInstallResult,
  BrainTurn,
} from '../onboarding/brain-connections.js'
import type { CodexSubscriptionAuth } from './codex-auth.js'

export const CODEX_APP_SERVER_PROTOCOL_PROFILE = 'codex-app-server-v2@0.144.5'
export const CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE =
  'codex-app-server-v2-mcp@0.144.5'
const SUPPORTED_CODEX_VERSION = 'codex-cli 0.144.5'

export type CodexAppServerProtocolProfile =
  | typeof CODEX_APP_SERVER_PROTOCOL_PROFILE
  | typeof CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE

export interface CodexAppServerThreadRecord {
  projectId: string
  sessionId: string
  threadId: string
  protocolProfile: CodexAppServerProtocolProfile
}

export interface CodexAppServerThreadStore {
  load(projectId: string, sessionId: string): Promise<CodexAppServerThreadRecord | null>
  saveNew(record: CodexAppServerThreadRecord): Promise<void>
}

export interface CodexAppServerSession {
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
  notify(method: string, params: Readonly<Record<string, unknown>>): Promise<void>
  events(): AsyncIterable<unknown>
  close(): Promise<void>
}

export interface CodexAppServerSessionFactory {
  open(): Promise<CodexAppServerSession>
}

/** Per-turn, loopback-only MCP authority owned by the Aisy composition. */
export interface CodexAppServerCapabilityBridge {
  readonly url: string
  readonly token: string
  readonly serverName: 'aisy'
  readonly toolNames: readonly string[]
  bindTurn(threadId: string, turnId: string): void
  close(): Promise<void>
}

export interface CodexAppServerCapabilityBridgeFactory {
  open(turn: BrainTurn, signal: AbortSignal): Promise<CodexAppServerCapabilityBridge>
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_TOKEN = /^[a-f0-9]{64}$/
const MAX_PROMPT_BYTES = 2 * 1024 * 1024
const MAX_REPLY_BYTES = 4 * 1024 * 1024
const TOOL_ITEM_TYPES = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'collabAgentToolCall', 'webSearch', 'imageGeneration',
])
const READ_ONLY_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'plan', 'reasoning'])
const READ_ONLY_NOTIFICATION_METHODS = new Set([
  'thread/started', 'turn/started', 'item/agentMessage/delta',
  'item/started', 'item/completed', 'turn/completed', 'error',
])
const OPTED_OUT_NOTIFICATION_METHODS = Object.freeze([
  'thread/tokenUsage/updated',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function exactRoot(value: string | null): value is string {
  return value !== null && value.length <= 4096 && isAbsolute(value) && normalize(value) === value
}

function safeThreadRecord(
  value: CodexAppServerThreadRecord,
  projectId: string,
  sessionId: string,
  protocolProfile: CodexAppServerProtocolProfile,
): boolean {
  return value.projectId === projectId && value.sessionId === sessionId &&
    value.protocolProfile === protocolProfile && safeId(value.threadId)
}

function safeCapabilityBridge(value: unknown): value is CodexAppServerCapabilityBridge {
  if (!record(value) || typeof value.url !== 'string') return false
  let url: URL
  try { url = new URL(value.url) } catch { return false }
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    url.pathname === '/mcp' && url.search === '' && url.hash === '' &&
    url.username === '' && url.password === '' && url.port.length > 0 &&
    Number(url.port) >= 1 && Number(url.port) <= 65_535 &&
    value.serverName === 'aisy' && typeof value.token === 'string' && SAFE_TOKEN.test(value.token) &&
    Array.isArray(value.toolNames) && value.toolNames.length <= 64 &&
    value.toolNames.every(safeId) && new Set(value.toolNames).size === value.toolNames.length &&
    typeof value.bindTurn === 'function' && typeof value.close === 'function'
}

function capabilityConfig(bridge: CodexAppServerCapabilityBridge): Readonly<Record<string, unknown>> {
  return Object.freeze({
    // The pinned Codex process is a brain, never a second executor. All effects
    // return through the one Aisy MCP server below.
    features: Object.freeze({
      shell_tool: false,
      unified_exec: false,
      shell_snapshot: false,
      apply_patch_freeform: false,
      web_search_cached: false,
      web_search_request: false,
      standalone_web_search: false,
      apps: false,
      plugins: false,
      computer_use: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      image_generation: false,
      in_app_browser: false,
      multi_agent: false,
      multi_agent_v2: false,
      enable_fanout: false,
      tool_suggest: false,
      memories: false,
      request_permissions_tool: false,
      hooks: false,
      code_mode: false,
      code_mode_host: false,
      enable_mcp_apps: false,
      remote_plugin: false,
      plugin_sharing: false,
      skill_mcp_dependency_install: false,
      workspace_dependencies: false,
      auth_elicitation: false,
      tool_call_mcp_elicitation: false,
      goals: false,
    }),
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: Object.freeze([]),
    mcp_servers: Object.freeze({
      [bridge.serverName]: Object.freeze({
        url: bridge.url,
        http_headers: Object.freeze({ authorization: `Bearer ${bridge.token}` }),
        enabled: true,
        required: true,
        enabled_tools: Object.freeze([...bridge.toolNames]),
        supports_parallel_tool_calls: false,
        startup_timeout_sec: 10,
        tool_timeout_sec: 600,
      }),
    }),
  })
}

function parseThreadResponse(value: unknown): string | null {
  if (!record(value) || !record(value.thread) || !safeId(value.thread.id)) return null
  return value.thread.id
}

function parseTurnResponse(value: unknown): string | null {
  if (!record(value) || !record(value.turn) || !safeId(value.turn.id)) return null
  return value.turn.id
}

function prompt(turn: BrainTurn): { developerInstructions: string; input: string } | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let prefix: string
  try {
    prefix = decoder.decode(turn.request.prefixBytes)
  } catch {
    return null
  }
  const developer: string[] = prefix ? [prefix] : []
  const input: string[] = []
  for (const span of turn.request.spans) {
    if (span.role === 'system') developer.push(span.text)
    else input.push(`${span.role}: ${span.text}`)
  }
  const developerInstructions = developer.join('\n\n')
  const text = input.join('\n\n')
  if (text.length === 0 || Buffer.byteLength(developerInstructions, 'utf8') > MAX_PROMPT_BYTES ||
    Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) return null
  return { developerInstructions, input: text }
}

function notification(value: unknown): { method: string; params: Record<string, unknown> } | null {
  if (!record(value) || typeof value.method !== 'string' || !record(value.params) ||
    value.id !== undefined) return null
  return { method: value.method, params: value.params }
}

function serverRequest(value: unknown): boolean {
  return record(value) && value.id !== undefined && typeof value.method === 'string'
}

function capabilityItem(
  value: Record<string, unknown>,
  bridge: CodexAppServerCapabilityBridge,
): { id: string; tool: string; arguments: Record<string, unknown>; status: string } | null {
  if (value.type !== 'mcpToolCall' || !safeId(value.id) ||
    value.server !== bridge.serverName || !safeId(value.tool) ||
    !bridge.toolNames.includes(value.tool) || !record(value.arguments) ||
    (value.status !== 'inProgress' && value.status !== 'completed' && value.status !== 'failed')) {
    return null
  }
  let encoded: string
  try { encoded = JSON.stringify(value.arguments) } catch { return null }
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) return null
  return {
    id: value.id,
    tool: value.tool,
    arguments: Object.freeze(structuredClone(value.arguments)),
    status: value.status,
  }
}

async function bestEffortInterrupt(
  session: CodexAppServerSession,
  threadId: string,
  turnId: string,
): Promise<void> {
  try { await session.request('turn/interrupt', { threadId, turnId }) } catch { /* fail closed */ }
}

function makeCodexAppServerDriver(input: {
  auth: CodexSubscriptionAuth
  sessions: CodexAppServerSessionFactory
  threads: CodexAppServerThreadStore
  model?: string
  projectRoot(projectId: string): string | null
  capabilityBridges?: CodexAppServerCapabilityBridgeFactory
}): BrainDriver {
  if (input.model !== undefined && !SAFE_ID.test(input.model)) {
    throw new Error('INVALID_CODEX_MODEL')
  }

  return Object.freeze<BrainDriver>({
    runtime: 'codex-app-server',
    detect: () => input.auth.detect(),
    async install(): Promise<BrainInstallResult> {
      const detected = await input.auth.detect()
      return detected.installed
        ? { installed: true, ...(detected.version ? { version: detected.version } : {}), safeDetail: 'Codex runtime is installed.' }
        : { installed: false, safeDetail: 'Codex runtime is not installed.' }
    },
    beginAuth: () => input.auth.beginAuth(),
    async validate() {
      const detected = await input.auth.detect()
      if (!detected.installed || detected.version !== SUPPORTED_CODEX_VERSION) {
        return {
          ok: false,
          safeDetail: 'Codex app-server protocol version is not supported.',
          errorCode: 'CODEX_PROTOCOL_UNSUPPORTED',
        }
      }
      return input.auth.validate()
    },

    async *run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent> {
      if (!safeId(turn.projectId) || !safeId(turn.sessionId) ||
        turn.request.sessionId !== turn.sessionId || signal.aborted) {
        yield { type: 'failed', errorCode: 'CODEX_TURN_REJECTED', safeDetail: 'Codex turn was rejected.' }
        return
      }
      let root: string | null = null
      let assembled: ReturnType<typeof prompt> = null
      try {
        root = input.projectRoot(turn.projectId)
        assembled = prompt(turn)
      } catch { /* rejected below without exposing adapter detail */ }
      if (!exactRoot(root) || assembled === null) {
        yield { type: 'failed', errorCode: 'CODEX_TURN_REJECTED', safeDetail: 'Codex turn was rejected.' }
        return
      }
      let detected
      try { detected = await input.auth.detect() } catch { detected = { installed: false } }
      if (signal.aborted) {
        yield { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
        return
      }
      if (!detected.installed || detected.version !== SUPPORTED_CODEX_VERSION) {
        yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_UNSUPPORTED', safeDetail: 'Codex app-server protocol version is not supported.' }
        return
      }
      let authenticated = false
      try { authenticated = (await input.auth.validate()).ok === true } catch { /* stable failure below */ }
      if (signal.aborted) {
        yield { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
        return
      }
      if (!authenticated) {
        yield { type: 'failed', errorCode: 'CODEX_AUTH_NOT_READY', safeDetail: 'Codex authentication is not ready.' }
        return
      }

      let bridge: CodexAppServerCapabilityBridge | null = null
      if (input.capabilityBridges !== undefined) {
        try { bridge = await input.capabilityBridges.open(turn, signal) } catch {
          yield { type: 'failed', errorCode: 'CODEX_CAPABILITY_BRIDGE_UNAVAILABLE', safeDetail: 'Codex tools are unavailable.' }
          return
        }
        if (signal.aborted || !safeCapabilityBridge(bridge)) {
          try { await bridge.close() } catch { /* redacted close */ }
          yield signal.aborted
            ? { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
            : { type: 'failed', errorCode: 'CODEX_CAPABILITY_BRIDGE_REJECTED', safeDetail: 'Codex tools were rejected.' }
          return
        }
      }

      let session: CodexAppServerSession
      try { session = await input.sessions.open() } catch {
        if (bridge !== null) try { await bridge.close() } catch { /* redacted close */ }
        yield signal.aborted
          ? { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
          : { type: 'failed', errorCode: 'CODEX_APP_SERVER_UNAVAILABLE', safeDetail: 'Codex runtime is unavailable.' }
        return
      }
      if (signal.aborted) {
        try { await session.close() } catch { /* no raw close detail */ }
        if (bridge !== null) try { await bridge.close() } catch { /* redacted close */ }
        yield { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
        return
      }

      let threadId: string | null = null
      let turnId: string | null = null
      let terminal = false
      let reply = ''
      const protocolProfile = bridge === null
        ? CODEX_APP_SERVER_PROTOCOL_PROFILE
        : CODEX_APP_SERVER_CAPABILITY_PROTOCOL_PROFILE
      const turnConfig = bridge === null ? null : capabilityConfig(bridge)
      const capabilityItems = new Map<string, { tool: string; arguments: unknown }>()
      let interruptRequested = false
      const interruptOnce = async (): Promise<void> => {
        if (interruptRequested || threadId === null || turnId === null) return
        interruptRequested = true
        await bestEffortInterrupt(session, threadId, turnId)
      }
      const abort = (): void => {
        void interruptOnce()
        void session.close().catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })

      try {
        const initialized = await session.request('initialize', {
          clientInfo: { name: 'aisy', title: 'Aisy', version: '0.1.14' },
          capabilities: { optOutNotificationMethods: OPTED_OUT_NOTIFICATION_METHODS },
        })
        if (!record(initialized)) throw new Error('INVALID_INITIALIZE')
        await session.notify('initialized', {})

        const prior = await input.threads.load(turn.projectId, turn.sessionId)
        if (prior !== null && !safeThreadRecord(
          prior,
          turn.projectId,
          turn.sessionId,
          protocolProfile,
        )) {
          throw new Error('INVALID_THREAD_BINDING')
        }
        if (prior) {
          const resumed = await session.request('thread/resume', {
            threadId: prior.threadId,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(turnConfig === null ? {} : { config: turnConfig }),
          })
          threadId = parseThreadResponse(resumed)
          if (threadId !== prior.threadId) throw new Error('INVALID_THREAD_RESUME')
        } else {
          const started = await session.request('thread/start', {
            ...(input.model === undefined ? {} : { model: input.model }),
            cwd: root,
            developerInstructions: assembled.developerInstructions,
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandbox: 'read-only',
            ...(turnConfig === null ? {} : { config: turnConfig }),
          })
          threadId = parseThreadResponse(started)
          if (threadId === null) throw new Error('INVALID_THREAD_START')
          await input.threads.saveNew({
            projectId: turn.projectId,
            sessionId: turn.sessionId,
            threadId,
            protocolProfile,
          })
        }

        const startedTurn = await session.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: assembled.input }],
        })
        turnId = parseTurnResponse(startedTurn)
        if (turnId === null) throw new Error('INVALID_TURN_START')
        if (bridge !== null) bridge.bindTurn(threadId, turnId)
        yield { type: 'started' }

        for await (const raw of session.events()) {
          if (signal.aborted) {
            await interruptOnce()
            yield { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
            terminal = true
            break
          }
          if (serverRequest(raw)) {
            await interruptOnce()
            yield { type: 'failed', errorCode: 'CODEX_UNSUPPORTED_SERVER_REQUEST', safeDetail: 'Codex requested a disabled capability.' }
            terminal = true
            break
          }
          const event = notification(raw)
          if (!event || !READ_ONLY_NOTIFICATION_METHODS.has(event.method)) {
            await interruptOnce()
            yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
            terminal = true
            break
          }
          if (event.method === 'thread/started') {
            if (!record(event.params.thread) || event.params.thread.id !== threadId) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH', safeDetail: 'Codex event binding was rejected.' }
              terminal = true
              break
            }
            continue
          }
          if (event.method === 'turn/started') {
            if (event.params.threadId !== threadId || !record(event.params.turn) ||
              event.params.turn.id !== turnId || event.params.turn.status !== 'inProgress') {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH', safeDetail: 'Codex event binding was rejected.' }
              terminal = true
              break
            }
            continue
          }
          const eventThread = event.params.threadId
          const eventTurn = record(event.params.turn) ? event.params.turn.id : event.params.turnId
          if (eventThread !== threadId || eventTurn !== turnId) {
            await interruptOnce()
            yield { type: 'failed', errorCode: 'CODEX_EVENT_BINDING_MISMATCH', safeDetail: 'Codex event binding was rejected.' }
            terminal = true
            break
          }
          if (event.method === 'error') {
            if (typeof event.params.willRetry !== 'boolean') {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
              terminal = true
              break
            }
            if (event.params.willRetry) continue
            await interruptOnce()
            yield { type: 'failed', errorCode: 'CODEX_TURN_FAILED', safeDetail: 'Codex turn failed.' }
            terminal = true
            break
          }
          if (event.method === 'item/agentMessage/delta') {
            const delta = event.params.delta
            if (typeof delta !== 'string' || Buffer.byteLength(reply + delta, 'utf8') > MAX_REPLY_BYTES) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_OUTPUT_REJECTED', safeDetail: 'Codex output was rejected.' }
              terminal = true
              break
            }
            reply += delta
            yield { type: 'text-delta', text: delta }
            continue
          }
          if (event.method === 'item/started' || event.method === 'item/completed') {
            if (!record(event.params.item)) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
              terminal = true
              break
            }
            const item = event.params.item
            const itemType = item.type
            if (typeof itemType !== 'string') {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
              terminal = true
              break
            }
            if (itemType === 'mcpToolCall' && bridge !== null) {
              const capability = capabilityItem(item, bridge)
              if (capability === null) {
                await interruptOnce()
                yield { type: 'failed', errorCode: 'CODEX_TOOL_POLICY_VIOLATION', safeDetail: 'Codex attempted a disabled capability.' }
                terminal = true
                break
              }
              if (event.method === 'item/started') {
                if (capability.status !== 'inProgress' || capabilityItems.has(capability.id)) {
                  await interruptOnce()
                  yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
                  terminal = true
                  break
                }
                capabilityItems.set(capability.id, {
                  tool: capability.tool,
                  arguments: capability.arguments,
                })
                yield {
                  type: 'tool-requested',
                  toolCallId: capability.id,
                  name: capability.tool,
                  args: capability.arguments,
                }
                continue
              }
              const started = capabilityItems.get(capability.id)
              if (started === undefined || capability.status === 'inProgress' ||
                started.tool !== capability.tool ||
                JSON.stringify(started.arguments) !== JSON.stringify(capability.arguments)) {
                await interruptOnce()
                yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
                terminal = true
                break
              }
              capabilityItems.delete(capability.id)
              yield {
                type: 'tool-result',
                toolCallId: capability.id,
                result: capability.status === 'completed'
                  ? 'CAPABILITY_COMPLETED'
                  : 'CAPABILITY_EXECUTION_FAILED',
              }
              continue
            }
            if (TOOL_ITEM_TYPES.has(itemType)) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_TOOL_POLICY_VIOLATION', safeDetail: 'Codex attempted a disabled capability.' }
              terminal = true
              break
            }
            if (!READ_ONLY_ITEM_TYPES.has(itemType)) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
              terminal = true
              break
            }
            if (event.method === 'item/completed' && item.type === 'agentMessage') {
              if (typeof item.text !== 'string') {
                await interruptOnce()
                yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
                terminal = true
                break
              }
              if (Buffer.byteLength(item.text, 'utf8') > MAX_REPLY_BYTES) {
                await interruptOnce()
                yield { type: 'failed', errorCode: 'CODEX_OUTPUT_REJECTED', safeDetail: 'Codex output was rejected.' }
                terminal = true
                break
              }
              reply = item.text
            }
            if (item.type === 'reasoning' && event.method === 'item/started') {
              yield { type: 'thinking' }
            }
            continue
          }
          if (event.method === 'turn/completed') {
            if (!record(event.params.turn) || capabilityItems.size !== 0) {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
              terminal = true
              break
            }
            const status = event.params.turn.status
            if (status === 'completed') {
              yield { type: 'completed', reply }
            } else if (status === 'interrupted' || status === 'failed') {
              yield {
                type: 'failed',
                errorCode: status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED',
                safeDetail: status === 'interrupted' ? 'Codex turn was interrupted.' : 'Codex turn failed.',
              }
            } else {
              await interruptOnce()
              yield { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
            }
            terminal = true
            break
          }
        }
        if (!terminal) {
          await interruptOnce()
          yield signal.aborted
            ? { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
            : { type: 'failed', errorCode: 'CODEX_STREAM_ENDED', safeDetail: 'Codex event stream ended unexpectedly.' }
        }
      } catch {
        await interruptOnce()
        yield signal.aborted
          ? { type: 'failed', errorCode: 'CODEX_TURN_INTERRUPTED', safeDetail: 'Codex turn was interrupted.' }
          : { type: 'failed', errorCode: 'CODEX_PROTOCOL_FAILED', safeDetail: 'Codex protocol failed.' }
      } finally {
        signal.removeEventListener('abort', abort)
        if (bridge !== null) try { await bridge.close() } catch { /* no raw close detail */ }
        try { await session.close() } catch { /* no raw close detail */ }
      }
    },
  })
}

/** Version-pinned stable app-server driver with every native action denied. */
export function makeCodexAppServerReadOnlyDriver(input: {
  auth: CodexSubscriptionAuth
  sessions: CodexAppServerSessionFactory
  threads: CodexAppServerThreadStore
  model?: string
  projectRoot(projectId: string): string | null
}): BrainDriver {
  return makeCodexAppServerDriver(input)
}

/**
 * Version-pinned subscription driver. Codex keeps the reasoning loop, while
 * every effect returns through a fresh, exact-turn Aisy MCP authority.
 */
export function makeCodexAppServerCapabilityDriver(input: {
  auth: CodexSubscriptionAuth
  sessions: CodexAppServerSessionFactory
  threads: CodexAppServerThreadStore
  model?: string
  projectRoot(projectId: string): string | null
  capabilityBridges: CodexAppServerCapabilityBridgeFactory
}): BrainDriver {
  return makeCodexAppServerDriver(input)
}

import { randomUUID } from 'node:crypto'

import type {
  BrainDriver,
  BrainEvent,
  BrainInstallResult,
  BrainTurn,
} from '../onboarding/brain-connections.js'
import {
  CLAUDE_CODE_PROTOCOL_PROFILE,
  CLAUDE_CODE_SUPPORTED_VERSION,
  type ClaudeSubscriptionAuth,
} from './claude-auth.js'

export type ClaudeCodeCapabilityProfileKind =
  | 'smoke-readonly'
  | 'confined-native'
  | 'aisy-bridge'

export interface ClaudeCodeRuntimePaths {
  cwd: string
  configDir: string
}

export interface ClaudeCodeTurnLease {
  projectId: string
  sessionId: string
  upstreamSessionId: string
  operationId: string
  protocolProfile: typeof CLAUDE_CODE_PROTOCOL_PROFILE
  capabilityProfile: ClaudeCodeCapabilityProfileKind
  cwd: string
  configDir: string
  resume: boolean
}

/**
 * Durable CAS boundary. beginTurn publishes a pending turn before process I/O;
 * a pending turn observed after restart is quarantined by the store.
 */
export interface ClaudeCodeSessionStore {
  beginTurn(input: {
    projectId: string
    sessionId: string
    proposedUpstreamSessionId: string
    proposedOperationId: string
    protocolProfile: typeof CLAUDE_CODE_PROTOCOL_PROFILE
    capabilityProfile: ClaudeCodeCapabilityProfileKind
    cwd: string
    configDir: string
  }): Promise<ClaudeCodeTurnLease>
  completeTurn(lease: ClaudeCodeTurnLease): Promise<void>
  quarantineTurn(lease: ClaudeCodeTurnLease): Promise<void>
}

export interface ClaudeCodeProcessCompletion {
  exitCode: number
  signal: NodeJS.Signals | null
}

export interface ClaudeCodeProcessSession {
  events(): AsyncIterable<unknown>
  readonly completion: Promise<ClaudeCodeProcessCompletion>
  terminate(): Promise<void>
}

export interface ClaudeCodeProcessPort {
  start(input: {
    args: readonly string[]
    stdin: string
    cwd: string
    configDir: string
  }): Promise<ClaudeCodeProcessSession>
}

export type ClaudeCodeStableErrorCode =
  | 'CLAUDE_ACTION_TURN_UNSUPPORTED'
  | 'CLAUDE_AUTH_NOT_READY'
  | 'CLAUDE_EVENT_SEQUENCE_REJECTED'
  | 'CLAUDE_INTERRUPTED'
  | 'CLAUDE_ISOLATION_FAILED'
  | 'CLAUDE_NATIVE_CAPABILITY_REJECTED'
  | 'CLAUDE_OUTPUT_REJECTED'
  | 'CLAUDE_PROCESS_FAILED'
  | 'CLAUDE_PROTOCOL_FAILED'
  | 'CLAUDE_RUNTIME_UNSUPPORTED'
  | 'CLAUDE_SESSION_RESUME_FAILED'
  | 'CLAUDE_TERMINATION_UNCONFIRMED'
  | 'CLAUDE_TIMEOUT'
  | 'CLAUDE_USAGE_REJECTED'

export class ClaudeCodeDriverError extends Error {
  constructor(public readonly code: ClaudeCodeStableErrorCode) {
    super(code)
    this.name = 'ClaudeCodeDriverError'
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PROMPT_BYTES = 2 * 1024 * 1024
const MAX_REPLY_BYTES = 4 * 1024 * 1024
const MAX_RETRIES = 3
const MAX_USAGE_TOKENS = 1_000_000_000
const MAX_USAGE_DOLLARS = 1_000_000
const CLAUDE_CODE_WIRE_VERSION = '2.1.220'
const CLAUDE_SUBSCRIPTION_KEY_SOURCE = 'none'
const SAFE_RETRY_ERRORS = new Set([
  'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit',
  'overloaded', 'invalid_request', 'model_not_found', 'server_error',
  'max_output_tokens', 'unknown',
])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function failure(code: ClaudeCodeStableErrorCode): Extract<BrainEvent, { type: 'failed' }> {
  const detail: Record<ClaudeCodeStableErrorCode, string> = {
    CLAUDE_ACTION_TURN_UNSUPPORTED: 'Claude action turns require an Aisy-owned capability bridge.',
    CLAUDE_AUTH_NOT_READY: 'Claude Code authentication is not ready.',
    CLAUDE_EVENT_SEQUENCE_REJECTED: 'Claude Code event sequence was rejected.',
    CLAUDE_INTERRUPTED: 'Claude Code turn was interrupted.',
    CLAUDE_ISOLATION_FAILED: 'Claude Code isolation could not be established.',
    CLAUDE_NATIVE_CAPABILITY_REJECTED: 'Claude Code attempted a disabled native capability.',
    CLAUDE_OUTPUT_REJECTED: 'Claude Code output was rejected.',
    CLAUDE_PROCESS_FAILED: 'Claude Code runtime failed.',
    CLAUDE_PROTOCOL_FAILED: 'Claude Code protocol failed.',
    CLAUDE_RUNTIME_UNSUPPORTED: 'Claude Code runtime version is not supported.',
    CLAUDE_SESSION_RESUME_FAILED: 'Claude Code session could not be resumed safely.',
    CLAUDE_TERMINATION_UNCONFIRMED: 'Claude Code process termination could not be confirmed.',
    CLAUDE_TIMEOUT: 'Claude Code turn timed out.',
    CLAUDE_USAGE_REJECTED: 'Claude Code usage was rejected.',
  }
  return { type: 'failed', errorCode: code, safeDetail: detail[code] }
}

export function buildClaudeCodeRunArgs(input: {
  capabilityProfile: ClaudeCodeCapabilityProfileKind
  model: string
  upstreamSessionId: string
  resume: boolean
}): readonly string[] | ClaudeCodeDriverError {
  if (input.capabilityProfile !== 'smoke-readonly') {
    return new ClaudeCodeDriverError('CLAUDE_ACTION_TURN_UNSUPPORTED')
  }
  if (!SAFE_ID.test(input.model) || !UUID.test(input.upstreamSessionId)) {
    return new ClaudeCodeDriverError('CLAUDE_ISOLATION_FAILED')
  }
  return Object.freeze([
    '--safe-mode',
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--max-turns', '1',
    '--permission-mode', 'plan',
    '--tools', '',
    '--disallowed-tools',
    'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent,Skill',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--model', input.model,
    input.resume ? '--resume' : '--session-id', input.upstreamSessionId,
  ])
}

/** Process adapters use this to reject argument drift before spawning. */
export function isClaudeCodeRunArgs(value: readonly string[]): boolean {
  const sessionFlag = value.at(-2)
  const sessionId = value.at(-1)
  if ((sessionFlag !== '--session-id' && sessionFlag !== '--resume') ||
    typeof sessionId !== 'string' || !UUID.test(sessionId)) return false
  const modelIndex = value.length - 4
  const model = value[modelIndex + 1]
  if (value[modelIndex] !== '--model' || typeof model !== 'string') return false
  const rebuilt = buildClaudeCodeRunArgs({
    capabilityProfile: 'smoke-readonly',
    model,
    upstreamSessionId: sessionId,
    resume: sessionFlag === '--resume',
  })
  return !(rebuilt instanceof ClaudeCodeDriverError) &&
    rebuilt.length === value.length && rebuilt.every((item, index) => item === value[index])
}

function prompt(turn: BrainTurn): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let prefix: string
  try { prefix = decoder.decode(turn.request.prefixBytes) } catch { return null }
  const chunks: string[] = []
  if (prefix) chunks.push(`System:\n${prefix}`)
  for (const span of turn.request.spans) chunks.push(`${span.role}:\n${span.text}`)
  const value = chunks.join('\n\n')
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES ? value : null
}

function validLease(
  lease: ClaudeCodeTurnLease,
  expected: Omit<ClaudeCodeTurnLease, 'upstreamSessionId' | 'resume'>,
): boolean {
  return lease.projectId === expected.projectId && lease.sessionId === expected.sessionId &&
    lease.operationId === expected.operationId && lease.protocolProfile === expected.protocolProfile &&
    lease.capabilityProfile === expected.capabilityProfile && lease.cwd === expected.cwd &&
    lease.configDir === expected.configDir && UUID.test(lease.upstreamSessionId) &&
    typeof lease.resume === 'boolean'
}

function validInit(
  value: Record<string, unknown>,
  lease: ClaudeCodeTurnLease,
  model: string,
  seen: Set<string>,
): boolean {
  if (value.type !== 'system' || value.subtype !== 'init' || value.session_id !== lease.upstreamSessionId ||
    value.cwd !== lease.cwd || value.model !== model || value.permissionMode !== 'plan' ||
    value.apiKeySource !== CLAUDE_SUBSCRIPTION_KEY_SOURCE ||
    value.claude_code_version !== CLAUDE_CODE_WIRE_VERSION || value.output_style !== 'default' ||
    !emptyArray(value.tools) || !emptyArray(value.mcp_servers) || !emptyArray(value.plugins) ||
    !emptyArray(value.skills) || !emptyArray(value.slash_commands) || !emptyArray(value.agents) ||
    (value.plugin_errors !== undefined && !emptyArray(value.plugin_errors)) ||
    typeof value.uuid !== 'string' || !UUID.test(value.uuid) || seen.has(value.uuid)) return false
  seen.add(value.uuid)
  return true
}

function validMessageUsage(value: unknown): boolean {
  if (!record(value)) return false
  for (const key of ['input_tokens', 'output_tokens'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 ||
      Number(value[key]) > MAX_USAGE_TOKENS) return false
  }
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const amount = value[key] ?? 0
    if (!Number.isSafeInteger(amount) || Number(amount) < 0 || Number(amount) > MAX_USAGE_TOKENS) return false
  }
  return true
}

function validMessageStart(value: Record<string, unknown>, model: string): value is Record<string, unknown> & {
  message: Record<string, unknown> & { id: string }
} {
  if (value.type !== 'message_start' || !exactKeys(value, ['type', 'message']) || !record(value.message)) return false
  const message = value.message
  return typeof message.id === 'string' && SAFE_ID.test(message.id) && message.type === 'message' &&
    message.role === 'assistant' && message.model === model && emptyArray(message.content) &&
    message.stop_reason === null && message.stop_sequence === null && validMessageUsage(message.usage) &&
    record(message.usage) && message.usage.output_tokens === 0
}

function validMessageDelta(value: Record<string, unknown>): boolean {
  return value.type === 'message_delta' && exactKeys(value, ['type', 'delta', 'usage']) && record(value.delta) &&
    exactKeys(value.delta, ['stop_reason', 'stop_sequence']) &&
    value.delta.stop_reason === 'end_turn' && value.delta.stop_sequence === null &&
    record(value.usage) && Number.isSafeInteger(value.usage.output_tokens) &&
    exactKeys(value.usage, ['output_tokens']) && Number(value.usage.output_tokens) >= 0 &&
    Number(value.usage.output_tokens) <= MAX_USAGE_TOKENS
}

function retryEvent(value: Record<string, unknown>, sessionId: string): boolean {
  return value.type === 'system' && value.subtype === 'api_retry' && value.session_id === sessionId &&
    Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 1 && Number(value.attempt) <= MAX_RETRIES &&
    Number.isSafeInteger(value.max_retries) && Number(value.max_retries) >= Number(value.attempt) &&
    Number(value.max_retries) <= MAX_RETRIES && Number.isSafeInteger(value.retry_delay_ms) &&
    Number(value.retry_delay_ms) >= 0 && typeof value.error === 'string' &&
    SAFE_RETRY_ERRORS.has(value.error) && typeof value.uuid === 'string' && UUID.test(value.uuid)
}

function eventIdentity(value: Record<string, unknown>, sessionId: string, seen: Set<string>): boolean {
  if (value.session_id !== sessionId || typeof value.uuid !== 'string' || !UUID.test(value.uuid) ||
    seen.has(value.uuid)) return false
  seen.add(value.uuid)
  return true
}

function nativeBlock(type: unknown): boolean {
  return typeof type === 'string' && (
    type.includes('tool') || type === 'web_search' || type === 'computer_use' ||
    type === 'bash_code_execution' || type === 'text_editor_code_execution'
  )
}

function parseUsage(value: unknown, dollars: unknown): Extract<BrainEvent, { type: 'usage' }> | null {
  if (!record(value) || !Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0 ||
    Number(value.input_tokens) > MAX_USAGE_TOKENS ||
    !Number.isSafeInteger(value.output_tokens) || Number(value.output_tokens) < 0 ||
    Number(value.output_tokens) > MAX_USAGE_TOKENS || typeof dollars !== 'number' ||
    !Number.isFinite(dollars) || dollars < 0 || dollars > MAX_USAGE_DOLLARS) return null
  const cacheCreation = value.cache_creation_input_tokens ?? 0
  const cacheRead = value.cache_read_input_tokens ?? 0
  if (!Number.isSafeInteger(cacheCreation) || Number(cacheCreation) < 0 ||
    Number(cacheCreation) > MAX_USAGE_TOKENS || !Number.isSafeInteger(cacheRead) ||
    Number(cacheRead) < 0 || Number(cacheRead) > MAX_USAGE_TOKENS) return null
  const inputTokens = Number(value.input_tokens) + Number(cacheCreation) + Number(cacheRead)
  if (!Number.isSafeInteger(inputTokens) || inputTokens > MAX_USAGE_TOKENS) return null
  return { type: 'usage', inputTokens, outputTokens: Number(value.output_tokens), dollars }
}

async function safeTerminate(
  session: ClaudeCodeProcessSession | null,
): Promise<'CLAUDE_TERMINATION_UNCONFIRMED' | null> {
  if (session === null) return null
  try {
    await session.terminate()
    return null
  } catch {
    return 'CLAUDE_TERMINATION_UNCONFIRMED'
  }
}

async function safeQuarantine(store: ClaudeCodeSessionStore, lease: ClaudeCodeTurnLease | null): Promise<void> {
  if (lease === null) return
  try { await store.quarantineTurn(lease) } catch { /* quarantine remains fail-closed */ }
}

/**
 * Dormant read-only preview. `confined-native` and `aisy-bridge` are explicit
 * future profiles; until their typed Aisy bridge exists they fail before I/O.
 */
export function makeClaudeCodePreviewDriver(input: {
  auth: ClaudeSubscriptionAuth
  processes: ClaudeCodeProcessPort
  sessions: ClaudeCodeSessionStore
  model: string
  capabilityProfile: ClaudeCodeCapabilityProfileKind
  runtimePaths(projectId: string, sessionId: string): ClaudeCodeRuntimePaths | null
  uuid?: () => string
}): BrainDriver {
  const makeUuid = input.uuid ?? randomUUID
  if (!SAFE_ID.test(input.model)) throw new Error('INVALID_CLAUDE_DRIVER_CONFIG')

  return Object.freeze<BrainDriver>({
    runtime: 'claude-code',
    detect: () => input.auth.detect(),
    async install(): Promise<BrainInstallResult> {
      const detected = await input.auth.detect()
      return detected.installed
        ? { installed: true, ...(detected.version ? { version: detected.version } : {}), safeDetail: 'Claude Code runtime is installed.' }
        : { installed: false, safeDetail: 'Claude Code runtime is not installed.' }
    },
    beginAuth: async () => input.auth.beginAuth(),
    async validate() {
      const detected = await input.auth.detect()
      if (!detected.installed || detected.version !== CLAUDE_CODE_SUPPORTED_VERSION) {
        return { ok: false, safeDetail: 'Claude Code runtime version is not supported.', errorCode: 'CLAUDE_RUNTIME_UNSUPPORTED' }
      }
      return input.auth.validate()
    },

    async *run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent> {
      if (input.capabilityProfile !== 'smoke-readonly') {
        yield failure('CLAUDE_ACTION_TURN_UNSUPPORTED')
        return
      }
      if (!SAFE_ID.test(turn.projectId) || !SAFE_ID.test(turn.sessionId) ||
        turn.request.sessionId !== turn.sessionId || signal.aborted) {
        yield failure(signal.aborted ? 'CLAUDE_INTERRUPTED' : 'CLAUDE_ISOLATION_FAILED')
        return
      }
      const assembled = prompt(turn)
      let paths: ClaudeCodeRuntimePaths | null = null
      try { paths = input.runtimePaths(turn.projectId, turn.sessionId) } catch { /* fail below */ }
      if (assembled === null || paths === null || typeof paths.cwd !== 'string' ||
        typeof paths.configDir !== 'string') {
        yield failure('CLAUDE_ISOLATION_FAILED')
        return
      }
      let detected
      try { detected = await input.auth.detect() } catch { detected = { installed: false } }
      if (!detected.installed || detected.version !== CLAUDE_CODE_SUPPORTED_VERSION) {
        yield failure('CLAUDE_RUNTIME_UNSUPPORTED')
        return
      }
      let authenticated = false
      try { authenticated = (await input.auth.validate()).ok === true } catch { /* stable failure */ }
      if (!authenticated) {
        yield failure('CLAUDE_AUTH_NOT_READY')
        return
      }

      const upstreamSessionId = makeUuid()
      const operationId = makeUuid()
      if (!UUID.test(upstreamSessionId) || !UUID.test(operationId)) {
        yield failure('CLAUDE_ISOLATION_FAILED')
        return
      }
      const expected = {
        projectId: turn.projectId,
        sessionId: turn.sessionId,
        operationId,
        protocolProfile: CLAUDE_CODE_PROTOCOL_PROFILE,
        capabilityProfile: input.capabilityProfile,
        cwd: paths.cwd,
        configDir: paths.configDir,
      } as const
      let lease: ClaudeCodeTurnLease | null = null
      try {
        lease = await input.sessions.beginTurn({
          projectId: expected.projectId,
          sessionId: expected.sessionId,
          proposedUpstreamSessionId: upstreamSessionId,
          proposedOperationId: operationId,
          protocolProfile: expected.protocolProfile,
          capabilityProfile: expected.capabilityProfile,
          cwd: expected.cwd,
          configDir: expected.configDir,
        })
      } catch {
        yield failure('CLAUDE_SESSION_RESUME_FAILED')
        return
      }
      if (!validLease(lease, expected)) {
        await safeQuarantine(input.sessions, lease)
        yield failure('CLAUDE_SESSION_RESUME_FAILED')
        return
      }
      const args = buildClaudeCodeRunArgs({
        capabilityProfile: input.capabilityProfile,
        model: input.model,
        upstreamSessionId: lease.upstreamSessionId,
        resume: lease.resume,
      })
      if (args instanceof ClaudeCodeDriverError) {
        await safeQuarantine(input.sessions, lease)
        yield failure(args.code)
        return
      }

      let processSession: ClaudeCodeProcessSession | null = null
      let terminal = false
      let completed = false
      let failCode: ClaudeCodeStableErrorCode | null = null
      let terminalUsage: Extract<BrainEvent, { type: 'usage' }> | null = null
      let terminalReply: string | null = null
      const abort = (): void => { void safeTerminate(processSession) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        processSession = await input.processes.start({
          args,
          stdin: assembled,
          cwd: lease.cwd,
          configDir: lease.configDir,
        })
        if (signal.aborted) throw new ClaudeCodeDriverError('CLAUDE_INTERRUPTED')

        let phase: 'pre-init' | 'active' | 'message' | 'assistant' | 'result' = 'pre-init'
        let rawMessageOpen = false
        let blockKind: 'text' | 'thinking' | null = null
        let nextBlockIndex = 0
        let reply = ''
        let messageId: string | null = null
        let messageDeltaSeen = false
        const seen = new Set<string>()

        for await (const raw of processSession.events()) {
          if (signal.aborted) throw new ClaudeCodeDriverError('CLAUDE_INTERRUPTED')
          if (terminal) throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
          if (!record(raw)) throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')

          if (phase === 'pre-init') {
            if (!validInit(raw, lease, input.model, seen)) {
              throw new ClaudeCodeDriverError('CLAUDE_ISOLATION_FAILED')
            }
            phase = 'active'
            yield { type: 'started' }
            continue
          }
          if (retryEvent(raw, lease.upstreamSessionId)) {
            if (!eventIdentity(raw, lease.upstreamSessionId, seen) || phase !== 'active') {
              throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
            }
            continue
          }
          if (!eventIdentity(raw, lease.upstreamSessionId, seen)) {
            throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
          }

          if (raw.type === 'stream_event') {
            if (!exactKeys(raw, ['type', 'event', 'parent_tool_use_id', 'uuid', 'session_id']) ||
              raw.parent_tool_use_id !== null || !record(raw.event) || phase === 'assistant') {
              throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
            }
            const event = raw.event
            if (event.type === 'message_start') {
              if (phase !== 'active' || rawMessageOpen || !validMessageStart(event, input.model)) {
                throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              }
              messageId = event.message.id
              rawMessageOpen = true
              phase = 'message'
              yield { type: 'thinking' }
              continue
            }
            if (event.type === 'content_block_start') {
              if (!exactKeys(event, ['type', 'index', 'content_block']) || !rawMessageOpen ||
                blockKind !== null || event.index !== nextBlockIndex || !record(event.content_block)) {
                throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              }
              const kind = event.content_block.type
              if (nativeBlock(kind)) throw new ClaudeCodeDriverError('CLAUDE_NATIVE_CAPABILITY_REJECTED')
              if (kind === 'text' && event.content_block.text === '') blockKind = 'text'
              else if (kind === 'thinking' && event.content_block.thinking === '' &&
                event.content_block.signature === '') blockKind = 'thinking'
              else if (kind === 'redacted_thinking' && typeof event.content_block.data === 'string') {
                blockKind = 'thinking'
              }
              else throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
              continue
            }
            if (event.type === 'content_block_delta') {
              if (!exactKeys(event, ['type', 'index', 'delta']) || !rawMessageOpen ||
                blockKind === null || event.index !== nextBlockIndex || !record(event.delta)) {
                throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              }
              if (blockKind === 'text') {
                if (!exactKeys(event.delta, ['type', 'text']) || event.delta.type !== 'text_delta' ||
                  typeof event.delta.text !== 'string') {
                  throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
                }
                if (Buffer.byteLength(reply + event.delta.text, 'utf8') > MAX_REPLY_BYTES) {
                  throw new ClaudeCodeDriverError('CLAUDE_OUTPUT_REJECTED')
                }
                reply += event.delta.text
                yield { type: 'text-delta', text: event.delta.text }
              } else {
                const validThinking = event.delta.type === 'thinking_delta' &&
                  exactKeys(event.delta, ['type', 'thinking']) && typeof event.delta.thinking === 'string'
                const validSignature = event.delta.type === 'signature_delta' &&
                  exactKeys(event.delta, ['type', 'signature']) && typeof event.delta.signature === 'string'
                if (!validThinking && !validSignature) throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
              }
              continue
            }
            if (event.type === 'content_block_stop') {
              if (!exactKeys(event, ['type', 'index']) || !rawMessageOpen ||
                blockKind === null || event.index !== nextBlockIndex) {
                throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              }
              blockKind = null
              nextBlockIndex += 1
              continue
            }
            if (event.type === 'message_delta') {
              if (!rawMessageOpen || blockKind !== null || messageDeltaSeen || !validMessageDelta(event)) {
                throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              }
              messageDeltaSeen = true
              continue
            }
            if (event.type === 'message_stop') {
              if (!rawMessageOpen || blockKind !== null || !messageDeltaSeen ||
                Object.keys(event).length !== 1) throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
              rawMessageOpen = false
              continue
            }
            throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
          }

          if (raw.type === 'assistant') {
            if (!exactKeys(raw, ['type', 'message', 'parent_tool_use_id', 'uuid', 'session_id']) ||
              phase !== 'message' || rawMessageOpen || raw.parent_tool_use_id !== null || !record(raw.message) ||
              raw.message.id !== messageId || raw.message.type !== 'message' ||
              raw.message.role !== 'assistant' || raw.message.model !== input.model ||
              raw.message.stop_reason !== 'end_turn' || raw.message.stop_sequence !== null ||
              !validMessageUsage(raw.message.usage) || !Array.isArray(raw.message.content)) {
              throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
            }
            let completeText = ''
            for (const block of raw.message.content) {
              if (!record(block)) throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
              if (nativeBlock(block.type)) throw new ClaudeCodeDriverError('CLAUDE_NATIVE_CAPABILITY_REJECTED')
              if (block.type === 'text') {
                if (typeof block.text !== 'string') throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
                completeText += block.text
              } else if (block.type === 'thinking') {
                if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') {
                  throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
                }
              } else if (block.type === 'redacted_thinking') {
                if (typeof block.data !== 'string') throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
              } else {
                throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
              }
            }
            if (completeText !== reply) throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
            phase = 'assistant'
            continue
          }

          if (raw.type === 'result') {
            if (!exactKeys(raw, [
              'type', 'subtype', 'duration_ms', 'duration_api_ms', 'is_error', 'num_turns',
              'result', 'session_id', 'total_cost_usd', 'usage', 'permission_denials', 'uuid',
            ]) || phase !== 'assistant' || raw.subtype !== 'success' || raw.is_error !== false ||
              raw.num_turns !== 1 || raw.result !== reply || !emptyArray(raw.permission_denials) ||
              !Number.isSafeInteger(raw.duration_ms) || Number(raw.duration_ms) < 0 ||
              !Number.isSafeInteger(raw.duration_api_ms) || Number(raw.duration_api_ms) < 0 ||
              Number(raw.duration_api_ms) > Number(raw.duration_ms)) {
              throw new ClaudeCodeDriverError('CLAUDE_EVENT_SEQUENCE_REJECTED')
            }
            const usage = parseUsage(raw.usage, raw.total_cost_usd)
            if (usage === null) throw new ClaudeCodeDriverError('CLAUDE_USAGE_REJECTED')
            terminalUsage = usage
            terminalReply = reply
            phase = 'result'
            terminal = true
            continue
          }
          throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
        }

        if (!terminal) throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
        const processResult = await processSession.completion
        if (processResult.exitCode !== 0 || processResult.signal !== null) {
          throw new ClaudeCodeDriverError(signal.aborted ? 'CLAUDE_INTERRUPTED' : 'CLAUDE_PROCESS_FAILED')
        }
        if (terminalUsage === null || terminalReply === null) {
          throw new ClaudeCodeDriverError('CLAUDE_PROTOCOL_FAILED')
        }
        if (signal.aborted) throw new ClaudeCodeDriverError('CLAUDE_INTERRUPTED')
        await input.sessions.completeTurn(lease)
        completed = true
        yield terminalUsage
        yield { type: 'completed', reply: terminalReply }
      } catch (error) {
        failCode = error instanceof ClaudeCodeDriverError ? error.code :
          signal.aborted ? 'CLAUDE_INTERRUPTED' : 'CLAUDE_PROCESS_FAILED'
      } finally {
        signal.removeEventListener('abort', abort)
        if (!completed) {
          const terminationFailure = await safeTerminate(processSession)
          if (terminationFailure !== null) failCode = terminationFailure
          await safeQuarantine(input.sessions, lease)
        }
      }
      if (!completed) yield failure(failCode ?? 'CLAUDE_PROCESS_FAILED')
    },
  })
}

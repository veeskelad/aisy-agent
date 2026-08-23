import { createHash } from 'node:crypto'

import type { Provenance, ToolCall } from '../agent-loop/types.js'
import type { ToolResult } from './execute-tool.js'
import { resolvedWorkBinding, type ResolvedWorkBinding } from './work-binding.js'

export class CodexCapabilityBridgeError extends Error {
  constructor(public readonly code:
    | 'INVALID_BRIDGE_CONFIG'
    | 'INVALID_CAPABILITY_CALL'
    | 'CAPABILITY_NOT_ALLOWED'
    | 'CAPABILITY_REPLAY_MISMATCH'
    | 'CAPABILITY_BUDGET_EXCEEDED'
    | 'CAPABILITY_CONTEXT_INACTIVE'
    | 'CAPABILITY_BRIDGE_CLOSED',
  ) {
    super(code)
    this.name = 'CodexCapabilityBridgeError'
  }
}

export interface CodexCapabilityCall {
  threadId: string
  turnId: string
  itemId: string
  tool: string
  arguments: Record<string, unknown>
}

/** Code-owned provenance state for the exact Codex turn. Never read from tool args. */
export interface CodexCapabilityContext {
  provenance: Provenance
  narrowed: boolean
}

export interface CodexCapabilityBridgeEvent {
  type: 'started' | 'completed' | 'denied'
  projectId: string
  sessionId: string
  threadId: string
  turnId: string
  itemId: string
  tool: string
  reason?: CodexCapabilityBridgeError['code']
    | 'CAPABILITY_DENIED'
    | 'CAPABILITY_CANCELLED'
    | 'CAPABILITY_EXECUTION_FAILED'
}

export interface BoundCodexCapabilityBridge {
  invoke(call: CodexCapabilityCall): Promise<ToolResult>
  close(): void
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MAX_ARGUMENT_BYTES = 256 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_ARGUMENT_NODES = 4096
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function fail(code: CodexCapabilityBridgeError['code']): CodexCapabilityBridgeError {
  return new CodexCapabilityBridgeError(code)
}

function safeJson(value: unknown, depth = 0, state = { nodes: 0 }): boolean {
  state.nodes++
  if (state.nodes > MAX_ARGUMENT_NODES || depth > 16) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1, state))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.entries(value as Record<string, unknown>).every(([key, item]) =>
    !FORBIDDEN_KEYS.has(key) && key.length <= 256 && safeJson(item, depth + 1, state))
}

function prepareCall(
  call: CodexCapabilityCall,
  context: CodexCapabilityContext,
): { call: ToolCall; hash: string } | null {
  if (!SAFE_ID.test(call.threadId) || !SAFE_ID.test(call.turnId) || !SAFE_ID.test(call.itemId) ||
    !SAFE_ID.test(call.tool) || !safeJson(call.arguments)) return null
  let encoded: string
  try { encoded = JSON.stringify(call.arguments) } catch { return null }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) return null
  return {
    call: Object.freeze({
      name: call.tool,
      args: Object.freeze(structuredClone(call.arguments)),
      sourceSpanProvenance: context.provenance,
    }),
    hash: createHash('sha256')
      .update(call.threadId).update('\0').update(call.turnId).update('\0')
      .update(call.itemId).update('\0').update(call.tool).update('\0').update(encoded)
      .digest('hex'),
  }
}

/**
 * Transport-independent, per-turn authority boundary for future stable adapters.
 * The injected executor remains responsible for Aisy approvals and verification.
 */
export function bindCodexCapabilityBridge(input: {
  binding: ResolvedWorkBinding
  threadId: string
  turnId: string
  context: CodexCapabilityContext
  allowedTools: ReadonlySet<string>
  maxCalls?: number
  signal?: AbortSignal
  isBindingActive(binding: ResolvedWorkBinding): boolean | Promise<boolean>
  execute(
    binding: ResolvedWorkBinding,
    call: ToolCall,
    context: CodexCapabilityContext,
    signal: AbortSignal,
  ): Promise<ToolResult>
  onEvent?(event: CodexCapabilityBridgeEvent): void
}): BoundCodexCapabilityBridge {
  const binding = Object.freeze(resolvedWorkBinding(input.binding))
  const context = Object.freeze({ ...input.context })
  const allowedTools = new Set(input.allowedTools)
  const maxCalls = input.maxCalls ?? 32
  if (!SAFE_ID.test(input.threadId) || !SAFE_ID.test(input.turnId) ||
    (context.provenance !== 'operator' && context.provenance !== 'untrusted') ||
    typeof context.narrowed !== 'boolean' ||
    (context.provenance === 'untrusted' && !context.narrowed) || allowedTools.size === 0 ||
    allowedTools.size > 64 || [...allowedTools].some(tool => !SAFE_ID.test(tool)) ||
    !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 128) {
    throw fail('INVALID_BRIDGE_CONFIG')
  }
  let closed = false
  let calls = 0
  const lifecycle = new AbortController()
  if (input.signal?.aborted) lifecycle.abort()
  else input.signal?.addEventListener('abort', () => lifecycle.abort(), { once: true })
  const results = new Map<string, { hash: string; result: Promise<ToolResult> }>()

  const event = (
    type: CodexCapabilityBridgeEvent['type'],
    call: CodexCapabilityCall,
    reason?: CodexCapabilityBridgeEvent['reason'],
  ): void => {
    input.onEvent?.(Object.freeze({
      type,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: call.itemId,
      tool: call.tool,
      ...(reason ? { reason } : {}),
    }))
  }

  const deny = (
    call: CodexCapabilityCall,
    code: CodexCapabilityBridgeError['code'],
  ): never => {
    event('denied', call, code)
    throw fail(code)
  }

  return Object.freeze({
    async invoke(raw: CodexCapabilityCall) {
      if (closed || lifecycle.signal.aborted) return deny(raw, 'CAPABILITY_BRIDGE_CLOSED')
      if (raw.threadId !== input.threadId || raw.turnId !== input.turnId) {
        return deny(raw, 'INVALID_CAPABILITY_CALL')
      }
      const prepared = prepareCall(raw, context)
      if (!prepared) return deny(raw, 'INVALID_CAPABILITY_CALL')
      if (!allowedTools.has(raw.tool)) return deny(raw, 'CAPABILITY_NOT_ALLOWED')
      const prior = results.get(raw.itemId)
      if (prior) {
        if (prior.hash !== prepared.hash) return deny(raw, 'CAPABILITY_REPLAY_MISMATCH')
        return prior.result
      }
      if (calls >= maxCalls) return deny(raw, 'CAPABILITY_BUDGET_EXCEEDED')
      calls++
      const result = (async (): Promise<ToolResult> => {
        let active = false
        try { active = await input.isBindingActive(binding) } catch { /* stable denial */ }
        if (!active || lifecycle.signal.aborted || closed) {
          return deny(raw, 'CAPABILITY_CONTEXT_INACTIVE')
        }
        event('started', raw)
        let executed: ToolResult
        try {
          executed = await input.execute(binding, prepared.call, context, lifecycle.signal)
        } catch {
          if (closed || lifecycle.signal.aborted) {
            return deny(raw, 'CAPABILITY_BRIDGE_CLOSED')
          }
          event('denied', raw, 'CAPABILITY_EXECUTION_FAILED')
          return { ok: false, output: 'CAPABILITY_EXECUTION_FAILED' }
        }
        if (closed || lifecycle.signal.aborted) {
          return deny(raw, 'CAPABILITY_BRIDGE_CLOSED')
        }
        if (typeof executed?.ok !== 'boolean' || typeof executed.output !== 'string' ||
          Buffer.byteLength(executed.output, 'utf8') > MAX_OUTPUT_BYTES) {
          event('denied', raw, 'CAPABILITY_EXECUTION_FAILED')
          return { ok: false, output: 'CAPABILITY_EXECUTION_FAILED' }
        }
        if (!executed.ok && (executed.output === 'CAPABILITY_DENIED' ||
          executed.output === 'CAPABILITY_CANCELLED' ||
          executed.output === 'CAPABILITY_EXECUTION_FAILED')) {
          event('denied', raw, executed.output)
          return Object.freeze({ ok: false, output: executed.output })
        }
        event('completed', raw)
        return Object.freeze({ ok: executed.ok, output: executed.output })
      })()
      results.set(raw.itemId, { hash: prepared.hash, result })
      return result
    },
    close() {
      closed = true
      lifecycle.abort()
    },
  })
}

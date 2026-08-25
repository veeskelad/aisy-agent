// HookGate adapter (runtime).
//
// Bridges the agent-loop's HookGate to the deterministic SafetyPolicy + the
// scoped-grant store + the human approval round-trip. The loop awaits pre(), so
// the entire "ask" resolution lives here: on a Tier-2/3 `ask` verdict we build a
// PendingAction, hand it to the injected approve() port (the transport issues
// the card and waits for the tap), and return allow/deny to the loop. On a
// confirmed Tier-2 with a remembered scope we record a code-derived similar
// grant, so only a matching call is allowed without another card.

import { randomUUID } from 'node:crypto'
import type { HookGate, HookCtx, ToolCall as LoopToolCall } from '../agent-loop/types.js'
import type {
  SafetyPolicy,
  Verdict,
  GrantStore,
  GrantScope,
  GrantBinding,
  ToolCall as SafetyToolCall,
  ContextSpan as SafetyContextSpan,
} from '../safety/index.js'
import type { PendingAction } from '../gateway/index.js'
import type { ApprovalProof } from '../gateway/index.js'
import { sanitizeControlSequences } from '../tools/index.js'
import type { ToolResult } from './execute-tool.js'
import {
  parseMemoryRememberReceipt,
  renderMemoryAcknowledgement,
} from './memory-receipt.js'

export type ApprovalDecision =
  | { decision: 'confirmed'; scope?: GrantScope; proof?: ApprovalProof }
  | { decision: 'rejected' }

export interface HookGateDeps {
  safety: SafetyPolicy
  grants: GrantStore
  /** Immutable context captured for this runner/turn. */
  grantBinding?: GrantBinding
  /** Resolve wrapper calls to their code-owned concrete Safety policy before evaluation. */
  resolveSafetyCall?(call: LoopToolCall, ctx: HookCtx): SafetyToolCall
  /** Commit/clear a resolver binding only after the final Safety + human verdict. */
  completeSafetyCall?(call: LoopToolCall, safetyCall: SafetyToolCall, allowed: boolean): void
  /** Human approval round-trip — the transport issues a card and awaits the tap. */
  approve(action: PendingAction): Promise<ApprovalDecision>
  /** Exact schema/allowlist check, installed by the live runner before Safety. */
  validateCall?(call: LoopToolCall): boolean
  /**
   * Learned autonomy (ADR-0061, спека 24). Returns true only when a live
   * operator-issued grant covers this exact call. It may suppress a Tier-2
   * `ask` and nothing else: `deny` stays denied, Tier 3 always asks, and an
   * untrusted-narrowed turn never qualifies — a grant is evidence about the
   * operator's own workflow, not a passport for content that arrived from
   * outside. Absence of the port means no learned autonomy exists.
   */
  learnedAutonomy?(call: LoopToolCall, ctx: HookCtx): boolean
  /**
   * Ответ человека на карточку — сырьё для обучаемой автономности (спека 24).
   *
   * Вызывается ровно один раз на решённую карточку тира 1–2 и только затем,
   * чтобы его записали: порт ничего не возвращает и не может ни разрешить, ни
   * запретить вызов. Tier 3 не наблюдается вовсе — такой процесс не обучается
   * ни при каком числе подтверждений.
   */
  observeApproval?(input: {
    call: LoopToolCall
    ctx: HookCtx
    tier: 1 | 2
    outcome: 'confirmed' | 'rejected'
  }): void
  /** Deterministic PostToolUse pipeline. Absence is fail-closed. */
  postToolUse?(call: LoopToolCall, result: unknown): Promise<unknown>
}

export interface PostToolUseDeps {
  /** Current code-owned secret values. Throwing means redaction is unavailable. */
  secretValues(): readonly string[] | Promise<readonly string[]>
  /** Additional output policy. Built-in control sanitization always runs after it. */
  filterOutput?(text: string): string | Promise<string>
  /** Optional size-only transform. Any failure returns the already-safe bytes. */
  compress?(text: string): Promise<{ text: string; compressed: boolean }>
}

const WITHHELD_RESULT: ToolResult = Object.freeze({
  ok: false,
  output: 'tool result withheld (redaction or filter unavailable)',
})

function resultParts(result: unknown): ToolResult {
  if (typeof result === 'object' && result !== null) {
    const value = result as { ok?: unknown; output?: unknown }
    if (typeof value.ok === 'boolean' && typeof value.output === 'string') {
      return { ok: value.ok, output: value.output }
    }
  }
  if (result instanceof Error) return { ok: false, output: result.message }
  if (typeof result === 'string') return { ok: true, output: result }
  try { return { ok: true, output: JSON.stringify(result) ?? '' } } catch {
    return { ok: false, output: 'unserializable tool result' }
  }
}

/** ADR-0009: error-wrap → vault redaction → filter/control sanitize → compress. */
export function makePostToolUseProcessor(deps: PostToolUseDeps) {
  return async (_call: LoopToolCall, result: unknown): Promise<ToolResult> => {
    const raw = resultParts(result)
    const memoryReceipt = (() => {
      if (typeof result !== 'object' || result === null) return null
      const value = result as Record<string, unknown>
      const receipt = parseMemoryRememberReceipt(value['mutationReceipt'])
      return receipt !== null && value['ok'] === true && value['verified'] === true &&
        value['output'] === renderMemoryAcknowledgement(receipt.fact)
        ? receipt
        : null
    })()
    let text = raw.ok ? raw.output : `Tool error: ${raw.output}`
    let values: readonly string[]
    try {
      values = await deps.secretValues()
      for (const value of values) {
        if (value.length > 0) text = text.replaceAll(value, '«redacted»')
      }
      text = deps.filterOutput === undefined ? text : await deps.filterOutput(text)
      // A filter is not allowed to re-introduce a vault value.
      for (const value of values) {
        if (value.length > 0) text = text.replaceAll(value, '«redacted»')
      }
      text = sanitizeControlSequences(text)
    } catch {
      return { ...WITHHELD_RESULT }
    }
    if (deps.compress !== undefined) {
      const safeText = text
      try {
        const candidate = (await deps.compress(safeText)).text
        text = typeof candidate === 'string' &&
          !values.some(value => value.length > 0 && candidate.includes(value))
          ? sanitizeControlSequences(candidate)
          : safeText
      } catch { /* compression is fail-open */ }
    }
    // A receipt may cross PostToolUse only when the exact verified output
    // survived every safety transform byte-for-byte. If redaction/filtering
    // changed it, dropping the receipt prevents a later acknowledgement from
    // reconstructing and re-exposing the pre-filter value.
    return memoryReceipt !== null && text === raw.output
      ? { ok: true, output: text, verified: true, mutationReceipt: memoryReceipt }
      : { ok: raw.ok, output: text }
  }
}

function toSafetyCall(call: LoopToolCall, ctx: HookCtx): SafetyToolCall {
  return {
    tool: call.name,
    args: call.args,
    argsTainted: ctx.provenance !== 'operator',
  }
}

/** Narrowing is carried on HookCtx; surface it to SafetyPolicy as a synthetic span. */
function safetyCtx(ctx: HookCtx): SafetyContextSpan[] {
  return ctx.narrowed ? [{ text: '', provenance: 'untrusted', source: 'narrowed' }] : []
}

function snapshotSafetyArgs(value: unknown): Record<string, unknown> {
  const copied = structuredClone(value) as unknown
  let nodes = 0
  const freeze = (item: unknown, depth: number): void => {
    if (typeof item !== 'object' || item === null) return
    nodes++
    if (nodes > 4096 || depth > 32 ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) {
      throw new Error('unsafe tool args')
    }
    for (const child of Object.values(item)) freeze(child, depth + 1)
    Object.freeze(item)
  }
  freeze(copied, 0)
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied)) {
    throw new Error('unsafe tool args')
  }
  return copied as Record<string, unknown>
}

export function makeHookGate(deps: HookGateDeps): HookGate {
  return {
    async pre(call: LoopToolCall, ctx: HookCtx) {
      try {
        if (deps.validateCall !== undefined && !deps.validateCall(call)) return 'deny'
      } catch {
        return 'deny'
      }
      let safetyCall: SafetyToolCall
      try {
        const resolved = deps.resolveSafetyCall?.(call, ctx) ?? toSafetyCall(call, ctx)
        safetyCall = Object.freeze({
          ...resolved,
          args: snapshotSafetyArgs(resolved.args),
          argsTainted: ctx.provenance !== 'operator',
        })
      } catch {
        return 'deny'
      }
      const complete = (allowed: boolean): boolean => {
        try {
          deps.completeSafetyCall?.(call, safetyCall, allowed)
          return true
        } catch {
          return false
        }
      }
      let verdict: Verdict
      try { verdict = deps.safety.evaluate(safetyCall, safetyCtx(ctx)) } catch {
        complete(false)
        return 'deny'
      }

      if (verdict.decision === 'allow') return complete(true) ? 'allow' : 'deny'
      if (verdict.decision === 'deny') {
        complete(false)
        return 'deny'
      }
      if (verdict.decision === 'modify') {
        if (safetyCall.tool !== call.name) {
          complete(false)
          return 'deny'
        }
        if (!complete(false)) return 'deny'
        return { modify: { name: verdict.rewritten.tool, args: verdict.rewritten.args } }
      }

      // verdict.decision === 'ask' — a learned grant may answer it, but only
      // within the bounds the operator's tap actually covered: Tier 2 exactly,
      // never a narrowed turn, never tainted args. Everything outside those
      // bounds goes to the human as before. A throwing port is not a yes.
      if (deps.learnedAutonomy !== undefined && verdict.tier === 2 &&
        !ctx.narrowed && ctx.provenance === 'operator') {
        let covered = false
        try { covered = deps.learnedAutonomy(call, ctx) === true } catch { covered = false }
        if (covered) return complete(true) ? 'allow' : 'deny'
      }

      // Otherwise resolve via the human approval round-trip.
      const action: PendingAction = Object.freeze({
        actionId: randomUUID(),
        actionHash: verdict.card.actionHash,
        tier: verdict.tier,
        requiresStepUp: verdict.tier === 3,
        summary: verdict.card.actionSummary,
        canRememberSimilar: deps.grants.canRememberSimilar(safetyCall, verdict.tier),
      })
      let result: ApprovalDecision
      try { result = await deps.approve(action) } catch {
        complete(false)
        return 'deny'
      }

      // Ответ человека на карточку — единственный источник демонстраций
      // (спека 24). Порт получает его вместе с вызовом, потому что из
      // PendingAction рабочий процесс уже не восстановить: там сводка и хэш, а
      // не аргументы. Отказ порта ничего не решает — он только наблюдатель.
      if (deps.observeApproval !== undefined && (verdict.tier === 1 || verdict.tier === 2)) {
        try {
          deps.observeApproval({
            call,
            ctx,
            tier: verdict.tier,
            outcome: result.decision === 'confirmed' ? 'confirmed' : 'rejected',
          })
        } catch { /* наблюдение не может влиять на решение */ }
      }

      if (result.decision !== 'confirmed') {
        complete(false)
        return 'deny'
      }

      if (!complete(true)) return 'deny'
      // Remember the grant only for Tier-2 (Tier-3 is never grantable, ADR-0047).
      if (result.scope && action.tier === 2 && action.canRememberSimilar === true) {
        // Missing binding is deliberately fail-closed: the approval still
        // confirms this one call, but cannot create an unscoped remembered grant.
        if (deps.grantBinding !== undefined) {
          try {
            deps.grants.recordSimilar(safetyCall, verdict.tier, result.scope, deps.grantBinding)
          } catch {
            complete(false)
            return 'deny'
          }
        }
      }
      return 'allow'
    },

    async post(call: LoopToolCall, result: unknown): Promise<unknown> {
      if (deps.postToolUse === undefined) return { ...WITHHELD_RESULT }
      try { return await deps.postToolUse(call, result) } catch {
        return { ...WITHHELD_RESULT }
      }
    },
  }
}

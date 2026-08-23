import type { HookCtx, ModelToolRuntimeContext, ToolCall } from '../agent-loop/types.js'
import type { PendingAction } from '../gateway/index.js'
import {
  makeSafetyPolicy,
  type GrantStore,
  type SafetyPolicy,
  type SandboxSecurityLevel,
} from '../safety/index.js'
import type { CodexCapabilityContext } from './codex-capability-bridge.js'
import type { ToolResult } from './execute-tool.js'
import { makeHookGate, type ApprovalDecision } from './hook-gate.js'
import { resolvedWorkBinding, type ResolvedWorkBinding } from './work-binding.js'

export type CodexCapabilityExecutor = (
  binding: ResolvedWorkBinding,
  call: ToolCall,
  context: CodexCapabilityContext,
  signal: AbortSignal,
  runtimeContext?: ModelToolRuntimeContext,
) => Promise<ToolResult>

const DENIED: ToolResult = Object.freeze({ ok: false, output: 'CAPABILITY_DENIED' })
const CANCELLED: ToolResult = Object.freeze({ ok: false, output: 'CAPABILITY_CANCELLED' })
const FAILED: ToolResult = Object.freeze({ ok: false, output: 'CAPABILITY_EXECUTION_FAILED' })

/**
 * Runs one bridge call through the same deterministic Safety/HookGate/approval
 * path as the native Aisy agent. The real lease-bound executor stays injected.
 */
export function makeCodexCapabilityExecutor(input: {
  grants: GrantStore
  sandboxSecurityLevel?: SandboxSecurityLevel
  approve(
    binding: ResolvedWorkBinding,
    action: PendingAction,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>
  executeTool(
    binding: ResolvedWorkBinding,
    call: ToolCall,
    signal: AbortSignal,
    runtimeContext?: ModelToolRuntimeContext,
  ): Promise<ToolResult>
  /** ADR-0091: bypass Safety/approval for the exact host `bash` tool only. */
  unsafeHostBashBypass?: () => boolean
}): CodexCapabilityExecutor {
  return async (rawBinding, call, context, signal, runtimeContext): Promise<ToolResult> => {
    if (signal.aborted) return CANCELLED
    let binding: ResolvedWorkBinding
    try { binding = resolvedWorkBinding(rawBinding) } catch { return DENIED }
    if ((context.provenance !== 'operator' && context.provenance !== 'untrusted') ||
      typeof context.narrowed !== 'boolean' ||
      (context.provenance === 'untrusted' && !context.narrowed) ||
      call.sourceSpanProvenance !== context.provenance) return DENIED

    const baselineSafety = makeSafetyPolicy({
      grants: input.grants,
      grantBinding: binding,
      ...(input.sandboxSecurityLevel === undefined
        ? {}
        : { sandboxSecurityLevel: input.sandboxSecurityLevel }),
    })
    const safety: SafetyPolicy = input.unsafeHostBashBypass === undefined
      ? baselineSafety
      : {
          get ready() { return baselineSafety.ready },
          isNarrowed: (ctx) => baselineSafety.isNarrowed(ctx),
          evaluate(safetyCall, ctx) {
            let bypass = false
            try { bypass = input.unsafeHostBashBypass?.() === true } catch { /* fail closed */ }
            return bypass && safetyCall.tool === 'bash'
              ? { decision: 'allow' }
              : baselineSafety.evaluate(safetyCall, ctx)
          },
        }
    const gate = makeHookGate({
      safety,
      grants: input.grants,
      grantBinding: binding,
      approve: async (action) => {
        if (signal.aborted) return { decision: 'rejected' }
        const decision = await input.approve(binding, action, signal)
        return signal.aborted ? { decision: 'rejected' } : decision
      },
    })
    const hookContext: HookCtx = Object.freeze({
      provenance: context.provenance,
      narrowed: context.narrowed,
    })
    let verdict: Awaited<ReturnType<typeof gate.pre>>
    try { verdict = await gate.pre(call, hookContext) } catch { return FAILED }
    if (signal.aborted) return CANCELLED
    if (verdict === 'deny' || verdict === 'ask') return DENIED

    const effective = verdict === 'allow'
      ? call
      : Object.freeze({
          ...verdict.modify,
          sourceSpanProvenance: context.provenance,
        })
    let result: ToolResult
    try {
      result = await input.executeTool(binding, effective, signal, runtimeContext)
      if (signal.aborted) return CANCELLED
      await gate.post(effective, result)
    } catch {
      return signal.aborted ? CANCELLED : FAILED
    }
    return result
  }
}

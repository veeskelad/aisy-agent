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
import {
  makeHookGate,
  type ApprovalDecision,
  type HookGateDeps,
  type PolicyRelaxationTarget,
  type RuntimePolicyNarrowing,
} from './hook-gate.js'
import { resolvedWorkBinding, type ResolvedWorkBinding } from './work-binding.js'
import {
  runtimeToolDefinition,
  validateRuntimeToolCall,
  type ToolTier,
} from './tool-catalog.js'

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
  /** Live execution-mode floor. It may only tighten the catalog tier. */
  toolTierFloor?(binding: ResolvedWorkBinding, call: ToolCall): ToolTier | undefined
  /** Same strict-only Project/path overlay as native and delegated runners. */
  narrowPolicy?(
    binding: ResolvedWorkBinding,
    request: Parameters<NonNullable<HookGateDeps['narrowPolicy']>>[0],
  ): RuntimePolicyNarrowing
  /** Resolves a relaxation handle to a code-owned operator-visible Project path. */
  describePolicyRelaxation?(
    binding: ResolvedWorkBinding,
    call: ToolCall,
    context: HookCtx,
  ): PolicyRelaxationTarget | null
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
      validateCall: call => validateRuntimeToolCall(call).ok,
      resolveSafetyCall: (candidate) => {
        const definition = runtimeToolDefinition(candidate.name)
        if (definition === undefined) throw new Error('unknown runtime tool')
        const requestedFloor = input.toolTierFloor?.(binding, candidate)
        if (requestedFloor !== undefined && ![0, 1, 2, 3].includes(requestedFloor)) {
          throw new Error('invalid runtime tool tier floor')
        }
        const effectiveTier = requestedFloor === undefined
          ? definition.tier
          : Math.max(definition.tier, requestedFloor) as ToolTier
        const policyRelaxation = candidate.name === 'configure_agent' &&
          typeof candidate.args['operation'] === 'string' &&
          candidate.args['operation'].startsWith('policy.relax-')
        let policyTarget: PolicyRelaxationTarget | null = null
        if (policyRelaxation) {
          policyTarget = input.describePolicyRelaxation?.(binding, candidate, hookContext) ?? null
          if (policyTarget === null) throw new Error('policy relaxation target unavailable')
        }
        return {
          tool: candidate.name,
          args: policyTarget === null
            ? candidate.args
            : policyTarget.scope === 'project'
              ? { ...candidate.args, policyScope: 'project' }
              : { ...candidate.args, policyScope: 'path', policyPath: policyTarget.relativePath },
          policyTier: policyRelaxation ? 3 : effectiveTier,
          outboundSink: definition.outboundSink,
        }
      },
      ...(input.narrowPolicy === undefined ? {} : {
        narrowPolicy: request => input.narrowPolicy!(binding, request),
      }),
      approve: async (action) => {
        if (signal.aborted) return { decision: 'rejected' }
        const decision = await input.approve(binding, action, signal)
        return signal.aborted ? { decision: 'rejected' } : decision
      },
    })
    const hookContext: HookCtx = Object.freeze({
      provenance: context.provenance,
      narrowed: context.narrowed,
      ...(runtimeContext === undefined ? {} : { sessionId: runtimeContext.sessionId }),
      ...(runtimeContext?.turnId === undefined ? {} : { turnId: runtimeContext.turnId }),
      ...(runtimeContext?.ordinal === undefined ? {} : { ordinal: runtimeContext.ordinal }),
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

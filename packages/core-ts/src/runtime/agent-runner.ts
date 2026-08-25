// Composition root (runtime).
//
// Wires the safety-critical core into one runnable agent: SafetyPolicy + the
// grant store + the HookGate (approval round-trip) feed the agent loop, which
// drives the provider and tool execution. Everything that touches the outside
// world — the LLM provider, tool implementations, the human approval port,
// memory, guardian, session log — is injected, so this stays pure and testable
// and the transport (Telegram) lives outside, in the app package.

import { makeSafetyPolicy } from '../safety/index.js'
import type { GrantBinding, GrantStore, SafetyPolicy, SandboxSecurityLevel } from '../safety/index.js'
import { makeHookGate, makePostToolUseProcessor, type ApprovalDecision, type HookGateDeps, type PostToolUseDeps } from './hook-gate.js'
import { CALL_MCP_TOOL_NAME } from './mcp-capability-runtime.js'
import { runtimeToolDefinition, validateRuntimeToolCall, type ToolTier } from './tool-catalog.js'
import { makeAgentLoop } from '../agent-loop/index.js'
import type {
  AgentLoop,
  AgentLoopDeps,
  Clock,
  ProviderAdapter,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  ToolCall,
  ToolExecutionContext,
  TurnInput,
  TurnResult,
} from '../agent-loop/types.js'
import type { PendingAction } from '../gateway/index.js'

export interface AgentRunnerDeps {
  provider: ProviderAdapter
  memory: MemoryPort
  grants: GrantStore
  /** Immutable context used for approval-grant lookup/recording. */
  grantBinding?: GrantBinding
  executeTool: (call: ToolCall, context: ToolExecutionContext) => unknown | Promise<unknown>
  /** Narrow code-owned exception classifier; false preserves legacy tool-error mapping. */
  propagateToolInterruption?: AgentLoopDeps['propagateToolInterruption']
  /** Internal protocol gate that runs before an approval card is created. */
  preToolDispatch?: AgentLoopDeps['preToolDispatch']
  /** Internal protocol observer for the filtered result returned to the model. */
  postToolDispatch?: AgentLoopDeps['postToolDispatch']
  /** Typed receipt observer used by the private auto-skill canary. */
  verifiedWorkflow?: AgentLoopDeps['verifiedWorkflow']
  /** Human approval round-trip — the transport issues a card and awaits the tap. */
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  guardian: LoopGuardian
  sessionLog: SessionLog
  /** Optional ADR-0064 sink. The app must create/bind the v2 transcript before
   *  installing it; omitting it preserves the legacy runtime path. */
  transcriptRecorder?: AgentLoopDeps['transcriptRecorder']
  /** Frozen into the per-session prefix; used by Skills menu and DNA indexes. */
  prefixExtension?: AgentLoopDeps['prefixExtension']
  /** Lazy working-context spans such as triggered Skill bodies. */
  augmentTurn?: (input: TurnInput) => Promise<TurnInput['spans']>
  /** Late context pull forwarded to the loop (ADR-0077). */
  lateContext?: AgentLoopDeps['lateContext']
  clock?: Clock
  sandboxSecurityLevel?: SandboxSecurityLevel
  maxReplans?: number
  maxTotalToolCalls?: number
  /** Mid-turn budget probe forwarded to the loop (ADR-0051). */
  budgetCheck?: (usage: {
    sessionId: string
    inputTokens: number
    outputTokens: number
    dollars: number
  }) => boolean | Promise<boolean>
  /** Optional live redaction/filter/compression ports. Safe built-ins are used by default. */
  postToolUse?: PostToolUseDeps
  /** Effective per-agent tiers. Values can only tighten the catalog floor. */
  toolTiers?: Readonly<Record<string, ToolTier>>
  /** ADR-0091: bypass Safety/approval for the exact host `bash` tool only. */
  unsafeHostBashBypass?: () => boolean
  /**
   * MCP seam. `call_mcp` is not in the narrow-waist catalog and carries no tier
   * of its own: the tier, the outbound flag and the approval identity all come
   * from the policy of the tool the wrapper names, which only the capability
   * runtime can resolve. Absent ⇒ `call_mcp` is not a tool at all and the gate
   * refuses it like any unknown name.
   */
  mcpCapability?: {
    resolveSafetyCall: NonNullable<HookGateDeps['resolveSafetyCall']>
    completeSafetyCall: NonNullable<HookGateDeps['completeSafetyCall']>
  }
  /**
   * Выученная автономность (спека 24): покрыт ли этот вызов живым грантом,
   * набранным демонстрациями. Отсутствие порта означает, что её нет вовсе —
   * гейт спрашивает карточкой, как раньше.
   */
  learnedAutonomy?: NonNullable<HookGateDeps['learnedAutonomy']>
  /** Наблюдатель ответов оператора — сырьё для той же автономности. */
  observeApproval?: NonNullable<HookGateDeps['observeApproval']>
}

export interface AgentRunner {
  handle(input: TurnInput): Promise<TurnResult>
}

export function makeAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const clock: Clock = deps.clock ?? { now: () => new Date().toISOString() }

  const baselineSafety = makeSafetyPolicy({
    grants: deps.grants,
    ...(deps.grantBinding === undefined ? {} : { grantBinding: deps.grantBinding }),
    ...(deps.sandboxSecurityLevel !== undefined
      ? { sandboxSecurityLevel: deps.sandboxSecurityLevel }
      : {}),
  })
  const safety: SafetyPolicy = deps.unsafeHostBashBypass === undefined
    ? baselineSafety
    : {
        get ready() { return baselineSafety.ready },
        isNarrowed: (ctx) => baselineSafety.isNarrowed(ctx),
        evaluate(call, ctx) {
          let bypass = false
          try { bypass = deps.unsafeHostBashBypass?.() === true } catch { /* fail closed */ }
          return bypass && call.tool === 'bash'
            ? { decision: 'allow' }
            : baselineSafety.evaluate(call, ctx)
        },
      }

  const hookGate = makeHookGate({
    safety,
    grants: deps.grants,
    approve: deps.approve,
    validateCall: call => call.name === CALL_MCP_TOOL_NAME
      ? deps.mcpCapability !== undefined
      : validateRuntimeToolCall(call).ok,
    resolveSafetyCall: (call, ctx) => {
      if (call.name === CALL_MCP_TOOL_NAME) {
        if (deps.mcpCapability === undefined) throw new Error('mcp capability unavailable')
        return deps.mcpCapability.resolveSafetyCall(call, ctx)
      }
      const definition = runtimeToolDefinition(call.name)
      if (!definition) throw new Error('unknown runtime tool')
      return {
        tool: call.name,
        args: call.args,
        policyTier: Math.max(definition.tier, deps.toolTiers?.[call.name] ?? definition.tier) as ToolTier,
        outboundSink: definition.outboundSink,
      }
    },
    ...(deps.mcpCapability === undefined
      ? {}
      : { completeSafetyCall: deps.mcpCapability.completeSafetyCall }),
    ...(deps.postToolUse === undefined ? {} : {
      postToolUse: makePostToolUseProcessor(deps.postToolUse),
    }),
    ...(deps.grantBinding === undefined ? {} : { grantBinding: deps.grantBinding }),
    ...(deps.learnedAutonomy === undefined ? {} : { learnedAutonomy: deps.learnedAutonomy }),
    ...(deps.observeApproval === undefined ? {} : { observeApproval: deps.observeApproval }),
  })

  const loop: AgentLoop = makeAgentLoop({
    clock,
    provider: deps.provider,
    hookGate,
    memory: deps.memory,
    guardian: deps.guardian,
    sessionLog: deps.sessionLog,
    ...(deps.transcriptRecorder === undefined ? {} : { transcriptRecorder: deps.transcriptRecorder }),
    ...(deps.lateContext === undefined ? {} : { lateContext: deps.lateContext }),
    ...(deps.prefixExtension === undefined ? {} : { prefixExtension: deps.prefixExtension }),
    executeTool: deps.executeTool,
    ...(deps.propagateToolInterruption === undefined
      ? {}
      : { propagateToolInterruption: deps.propagateToolInterruption }),
    ...(deps.preToolDispatch === undefined ? {} : { preToolDispatch: deps.preToolDispatch }),
    ...(deps.postToolDispatch === undefined ? {} : { postToolDispatch: deps.postToolDispatch }),
    ...(deps.verifiedWorkflow === undefined ? {} : { verifiedWorkflow: deps.verifiedWorkflow }),
    ...(deps.maxReplans !== undefined ? { maxReplans: deps.maxReplans } : {}),
    ...(deps.maxTotalToolCalls !== undefined ? { maxTotalToolCalls: deps.maxTotalToolCalls } : {}),
    ...(deps.budgetCheck !== undefined ? { budgetCheck: deps.budgetCheck } : {}),
  })

  // A turn that came from a transport batch carries its own identity, so a
  // replay of that batch appends the same transcript rows twice instead of
  // duplicating them. A turn with no batch behind it — a proactive greeting, a
  // trigger, a voice note, a goal iteration — has nothing to be idempotent
  // against, and refusing to run it would be worse than minting an identity
  // here. The loop keeps requiring one; this fills the gap it cannot.
  let turnSeq = 0
  const identify = (input: TurnInput): TurnInput => {
    if (typeof input.turnId === 'string' && input.turnId.length > 0 &&
      (deps.transcriptRecorder === undefined ||
        (typeof input.turnTs === 'string' && input.turnTs.length > 0))) return input
    turnSeq += 1
    const ts = clock.now()
    return { ...input, turnId: `local:${input.sessionId}:${ts}:${turnSeq}`, turnTs: ts }
  }

  return {
    handle: async (input: TurnInput): Promise<TurnResult> => {
      const extra = deps.augmentTurn === undefined ? [] : await deps.augmentTurn(input)
      return loop.runTurn({ ...identify(input), spans: [...input.spans, ...extra] })
    },
  }
}

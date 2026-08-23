import {
  bindCodexCapabilityBridge,
  makeCodexCapabilityExecutor,
  makeLeaseBoundToolExecutor,
  type ApprovalDecision,
  type BoundCodexCapabilityBridge,
  type CodexCapabilityBridgeEvent,
  type CodexCapabilityContext,
  type GrantStore,
  type PendingAction,
  type ProjectService,
  type ResolvedWorkBinding,
  type SandboxSecurityLevel,
  type ToolCall,
  type ToolResult,
  type TurnContextLease,
} from '@aisy/core'

/**
 * Disabled-by-default app composition for one exact Codex turn. File and bash
 * calls use a fresh durable binding lease; every other tool stays injected.
 */
export function makeCodexCapabilityTurnRuntime(input: {
  service: ProjectService
  confinement: Parameters<typeof makeLeaseBoundToolExecutor>[0]['confinement']
  grants: GrantStore
  binding: ResolvedWorkBinding
  threadId: string
  turnId: string
  context: CodexCapabilityContext
  allowedTools: ReadonlySet<string>
  maxCalls?: number
  signal?: AbortSignal
  sandboxSecurityLevel?: SandboxSecurityLevel
  approve(
    binding: ResolvedWorkBinding,
    action: PendingAction,
    signal: AbortSignal,
  ): Promise<ApprovalDecision>
  executeNonFileTool(
    lease: TurnContextLease,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult>
  runBash?: (
    lease: TurnContextLease,
    command: string,
    signal: AbortSignal,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  onEvent?(event: CodexCapabilityBridgeEvent): void
}): BoundCodexCapabilityBridge {
  const execute = makeCodexCapabilityExecutor({
    grants: input.grants,
    ...(input.sandboxSecurityLevel === undefined
      ? {}
      : { sandboxSecurityLevel: input.sandboxSecurityLevel }),
    approve: input.approve,
    executeTool: async (binding, call, signal) => {
      if (signal.aborted) return { ok: false, output: 'CAPABILITY_CANCELLED' }
      const lease = input.service.acquireBoundContext(binding)
      try {
        input.service.assertBoundContext(lease, binding)
        if (signal.aborted) return { ok: false, output: 'CAPABILITY_CANCELLED' }
        const leaseExecutor = makeLeaseBoundToolExecutor({
          lease,
          confinement: input.confinement,
          fallback: (toolCall) => input.executeNonFileTool(lease, toolCall, signal),
          ...(input.runBash === undefined ? {} : {
            runBash: (activeLease, command) => input.runBash!(activeLease, command, signal),
          }),
        })
        return await leaseExecutor(call)
      } finally {
        await input.service.releaseTurnContext(lease)
      }
    },
  })
  return bindCodexCapabilityBridge({
    binding: input.binding,
    threadId: input.threadId,
    turnId: input.turnId,
    context: input.context,
    allowedTools: input.allowedTools,
    ...(input.maxCalls === undefined ? {} : { maxCalls: input.maxCalls }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    isBindingActive: (binding) => input.service.isBindingActive(binding),
    execute,
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
  })
}

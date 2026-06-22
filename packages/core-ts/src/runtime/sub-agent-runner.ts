// Sub-agent runner factory (runtime, ADR-0052).
//
// Builds a card-scoped child AgentRunner for one delegation: a FRESH empty
// GrantStore (parent grants are never inherited — tier-2/3 re-prompt), the
// card's tools gated via the scoped executor, a fresh Loop Guardian, and the
// card's maxIterations as the tool-call cap. Parent narrowing is inherited by
// forcing the sub-agent's span provenance to untrusted.

import { makeAgentRunner, type AgentRunnerDeps, type AgentRunner } from './agent-runner.js'
import { makeGrantStore } from '../safety/index.js'
import { makeScopedToolExecutor } from './scoped-tool-executor.js'
import type { LoopGuardian, ProviderAdapter, MemoryPort, SessionLog, ToolCall, TurnInput, TurnResult } from '../agent-loop/types.js'
import type { ApprovalDecision } from './hook-gate.js'
import type { PendingAction } from '../gateway/index.js'
import type { DelegationHandle } from '../orchestration/index.js'
import type { ToolResult } from './execute-tool.js'

export interface SubAgentRunnerDeps {
  handle: DelegationHandle
  provider: ProviderAdapter
  baseExecuteTool: (call: ToolCall) => Promise<ToolResult>
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  memory: MemoryPort
  sessionLog: SessionLog
  parentNarrowed: boolean
  doNotTouch: string[]
  budgetCheck?: AgentRunnerDeps['budgetCheck']
}

export function makeSubAgentRunner(deps: SubAgentRunnerDeps): AgentRunner {
  // Fresh, empty grant store: the sub-agent inherits NO approvals from the parent.
  const grants = makeGrantStore()

  const scoped = makeScopedToolExecutor({
    base: deps.baseExecuteTool,
    permitsTool: deps.handle.permitsTool.bind(deps.handle),
    owns: deps.handle.owns,
    doNotTouch: deps.doNotTouch,
  })

  // The DelegationHandle.guardian is the orchestration-layer LoopGuardian (check/reset),
  // but makeAgentRunner requires the agent-loop LoopGuardian shape (observe/note).
  // Cast via unknown: in production, the DelegationHandle will be backed by an adapter
  // that implements both shapes; in tests, fakeHandle provides the observe/note shape.
  const guardian = deps.handle.guardian as unknown as LoopGuardian

  const runner = makeAgentRunner({
    provider: deps.provider,
    memory: deps.memory,
    grants,
    executeTool: scoped,
    approve: deps.approve,
    guardian,
    sessionLog: deps.sessionLog,
    maxTotalToolCalls: deps.handle.card.maxIterations,
    ...(deps.budgetCheck !== undefined ? { budgetCheck: deps.budgetCheck } : {}),
  })

  return {
    handle: (input: TurnInput): Promise<TurnResult> => {
      // Inherit parent narrowing: a narrowed parent forces the sub-agent's spans
      // to untrusted provenance so the loop narrows and the motivated-call block applies.
      const spans = deps.parentNarrowed
        ? input.spans.map((s) => ({ ...s, provenance: 'untrusted' as const }))
        : input.spans
      return runner.handle({ ...input, spans })
    },
  }
}

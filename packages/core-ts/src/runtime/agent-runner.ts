// Composition root (runtime).
//
// Wires the safety-critical core into one runnable agent: SafetyPolicy + the
// grant store + the HookGate (approval round-trip) feed the agent loop, which
// drives the provider and tool execution. Everything that touches the outside
// world — the LLM provider, tool implementations, the human approval port,
// memory, guardian, session log — is injected, so this stays pure and testable
// and the transport (Telegram) lives outside, in the app package.

import { makeSafetyPolicy } from '../safety/index.js'
import type { GrantStore, SandboxSecurityLevel } from '../safety/index.js'
import { makeHookGate, type ApprovalDecision } from './hook-gate.js'
import { makeAgentLoop } from '../agent-loop/index.js'
import type {
  AgentLoop,
  Clock,
  ProviderAdapter,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  ToolCall,
  TurnInput,
  TurnResult,
} from '../agent-loop/types.js'
import type { PendingAction } from '../gateway/index.js'

export interface AgentRunnerDeps {
  provider: ProviderAdapter
  memory: MemoryPort
  grants: GrantStore
  executeTool: (call: ToolCall) => unknown | Promise<unknown>
  /** Human approval round-trip — the transport issues a card and awaits the tap. */
  approve: (action: PendingAction) => Promise<ApprovalDecision>
  guardian: LoopGuardian
  sessionLog: SessionLog
  clock?: Clock
  sandboxSecurityLevel?: SandboxSecurityLevel
  maxReplans?: number
  maxTotalToolCalls?: number
}

export interface AgentRunner {
  handle(input: TurnInput): Promise<TurnResult>
}

export function makeAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const clock: Clock = deps.clock ?? { now: () => new Date().toISOString() }

  const safety = makeSafetyPolicy({
    grants: deps.grants,
    ...(deps.sandboxSecurityLevel !== undefined
      ? { sandboxSecurityLevel: deps.sandboxSecurityLevel }
      : {}),
  })

  const hookGate = makeHookGate({ safety, grants: deps.grants, approve: deps.approve })

  const loop: AgentLoop = makeAgentLoop({
    clock,
    provider: deps.provider,
    hookGate,
    memory: deps.memory,
    guardian: deps.guardian,
    sessionLog: deps.sessionLog,
    executeTool: deps.executeTool,
    ...(deps.maxReplans !== undefined ? { maxReplans: deps.maxReplans } : {}),
    ...(deps.maxTotalToolCalls !== undefined ? { maxTotalToolCalls: deps.maxTotalToolCalls } : {}),
  })

  return {
    handle: (input: TurnInput): Promise<TurnResult> => loop.runTurn(input),
  }
}

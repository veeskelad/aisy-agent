// Public entry point for `@aisy/core`.
//
// Two surfaces are exported:
//  1. The Gateway connectivity types (consumed by transport adapters).
//  2. The runtime composition surface (consumed by the app package to assemble
//     and run a live agent): the runner, the real provider/tool/hook adapters,
//     the gateway + grant factories, and the agent-loop vocabulary.
// Internal component types stay internal; widen this deliberately.

// --- Gateway connectivity ---
export type {
  Gateway,
  GatewayDeps,
  TelegramUpdate,
  InboundSpan,
  PendingAction,
  CardId,
  CardTap,
  ApprovalResult,
  ApprovalScope,
  IssuedCardView,
  Provenance,
  Channel,
} from './gateway/index.js'

export {
  makeGateway,
  AuthzRejected,
  RateLimited,
  VoiceUnavailable,
  IngestTooLarge,
  OutboundBlocked,
  TransportError,
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from './gateway/index.js'

// --- Runtime composition (app package assembles a live agent from these) ---
export { makeAgentRunner } from './runtime/agent-runner.js'
export type { AgentRunner, AgentRunnerDeps } from './runtime/agent-runner.js'

export { makeAnthropicProvider } from './runtime/provider-anthropic.js'
export type { AnthropicProviderDeps, AnthropicTool } from './runtime/provider-anthropic.js'

export { makeToolExecutor } from './runtime/execute-tool.js'
export type { ExecuteToolDeps, FsPort, ToolResult } from './runtime/execute-tool.js'

export { makeHookGate } from './runtime/hook-gate.js'
export type { HookGateDeps, ApprovalDecision } from './runtime/hook-gate.js'

// --- Safety: grant store (transport records grants; app may inspect/reset) ---
export { makeGrantStore } from './safety/index.js'
export type {
  GrantStore,
  GrantScope,
  GrantPersistencePort,
  SandboxSecurityLevel,
} from './safety/index.js'

// --- Agent-loop vocabulary (the app builds these; transport-facing) ---
export type {
  TurnInput,
  TurnResult,
  ContextSpan,
  ToolCall,
  ProviderAdapter,
  ModelRequest,
  ModelResponse,
  MemoryPort,
  LoopGuardian,
  SessionLog,
  LogEntry,
  Clock,
  HookGate,
  HookCtx,
} from './agent-loop/types.js'

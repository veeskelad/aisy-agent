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

export { makeOpenAICompatProvider, parseOpenAIResponse } from './runtime/provider-openai.js'
export type { OpenAIProviderDeps, ModelPrice } from './runtime/provider-openai.js'

export { makeCliProvider, promptFromSpans } from './runtime/provider-cli.js'
export type { CliProviderDeps, CliRunResult } from './runtime/provider-cli.js'

export { PROVIDER_CATALOG, findProvider, buildProvider, makeTieredProvider } from './runtime/providers.js'
export type { ProviderEntry, ProviderKind, BuildProviderConfig, TierAdapters } from './runtime/providers.js'

export { makeFailoverProvider } from './runtime/failover-provider.js'

export { makeToolExecutor } from './runtime/execute-tool.js'
export type { ExecuteToolDeps, FsPort, ToolResult } from './runtime/execute-tool.js'

export { makeHookGate } from './runtime/hook-gate.js'
export type { HookGateDeps, ApprovalDecision } from './runtime/hook-gate.js'

export { makeGuardian } from './runtime/guardian.js'
export type { GuardianDeps } from './runtime/guardian.js'

export { makeDockerBash, dockerRunArgs } from './runtime/sandbox-bash.js'
export type { DockerBashDeps, DockerResult } from './runtime/sandbox-bash.js'

export { makeSpendStore } from './runtime/spend.js'
export type {
  SpendStore,
  SpendEntry,
  SpendUsage,
  ModelSpend,
  AgentSpend,
  SpendPersistencePort,
} from './runtime/spend.js'

export { makeSettingsStore, DEFAULT_SETTINGS } from './runtime/settings.js'
export type { SettingsStore, Settings, SettingsPersistencePort } from './runtime/settings.js'

export { makeBudgetTracker } from './runtime/budget.js'
export type { BudgetTracker } from './runtime/budget.js'

export { makeMemoryStore } from './memory/index.js'
export type { Memory, MemoryStore, MemoryStoreDeps, RankedHit, MemoryFact } from './memory/index.js'
export { makeMemoryPort, makeMemorySearch } from './runtime/memory-adapter.js'
export { makeJsonlSessionLog } from './runtime/session-log.js'

// --- CLI (the app's unified `aisy` reuses these for init/doctor/diagnostics) ---
export { makeNodeOnboardingOps, harnessVersion, isNewerVersion } from './runtime/onboarding-node.js'
export { runCli } from './cli/index.js'
export { systemdUnit, launchdPlist } from './runtime/service-files.js'
export type { ServiceOpts } from './runtime/service-files.js'

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
  SessionSummary,
  LogEntry,
  Clock,
  HookGate,
  HookCtx,
  VerificationTrace,
} from './agent-loop/types.js'

// --- AgentCard loader (Tier-3, ADR-0039/0052) ---
export { makeCardResolver, parseAgentCard, DEFAULT_GENERAL_CARD } from './runtime/agent-cards.js'
export type { CardResolver } from './runtime/agent-cards.js'

// --- Delegation (Tier-3 sub-agent delegation, ADR-0039) ---
export { makeDelegationManager, ScopeConflictError, ScopeViolationError } from './orchestration/index.js'
export { runDelegation } from './runtime/delegation-driver.js'
export type { DelegationDriverDeps } from './runtime/delegation-driver.js'
export type {
  DelegationManager,
  DelegationHandle,
  DelegationDeps,
  DelegationTask,
  DelegationScope,
  PlanDAG,
  LinearPlanLike,
  AgentCard,
  CapabilityRequest,
  TaskObservation,
  ScheduleResult,
  BudgetSlice,
  IterationCost,
} from './orchestration/index.js'

// --- Sub-agent runner (Tier-3 sub-agent delegation, ADR-0052) ---
export { makeSubAgentRunner } from './runtime/sub-agent-runner.js'
export type { SubAgentRunnerDeps } from './runtime/sub-agent-runner.js'

// --- Plan normalizer (Tier-3 fix: ensures every node has non-null assignedTo) ---
export { normalizeSpawnPlan } from './runtime/spawn-plan.js'

// --- Tier-4 triggers ---
export { makeTriggerEngine } from './triggers/index.js'
export type {
  TriggerEngine,
  TriggerEngineDeps,
  TriggerSpec,
  TriggerStore,
  TriggerBudget,
  TriggerFiring,
} from './triggers/index.js'

// --- Tier-4 nightly consolidation (runner + adapters + LLM generator/judge) ---
export { makeConsolidationRunner } from './nightly/index.js'
export type {
  ConsolidationRunner,
  ConsolidationDeps,
  NightlyConfig,
  NightResult,
  MorningCard,
  MemOp,
  Fact,
} from './nightly/index.js'
export { makeFileRunLock, makeMemoryValidators, liveFactsForNightly, memOpToMemoryOp } from './runtime/nightly-adapters.js'
export type { FileRunLockDeps, MemoryValidatorsDeps } from './runtime/nightly-adapters.js'
export { makeNightlyGenerator, makeNightlyJudge } from './runtime/nightly-generator.js'

// --- Tier-8 exact-response cache (deterministic paths only; NEVER the live loop — ADR-0055) ---
export { makeExactCache, makeMemoryExactCacheStore } from './runtime/exact-cache.js'
export type { ExactCacheStore } from './runtime/exact-cache.js'

// --- Tier-7 goal-driven loop ---
export { makeGoalSpec } from './goals/index.js'
export type {
  GoalSpec,
  GoalStore,
  GoalMode,
  GoalBackstop,
  GoalUsage,
  GoalStatus,
} from './goals/index.js'

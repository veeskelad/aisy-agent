// §3 interfaces — pure types, no implementation
// Spec: docs/specs/09-provider-routing.md

// ---------------------------------------------------------------------------
// Core enumerations
// ---------------------------------------------------------------------------

export type RouteTier = "reasoning" | "critique" | "routine"

export type ProviderFamily =
  | "deepseek"   // V4-Pro, V4-Flash
  | "anthropic"  // Opus 4.8, Sonnet 4.6
  | "openai"     // GPT-5.5

export type ProviderErrorKind = "rate-limit" | "server-error" | "timeout"

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export interface ProviderId {
  family: ProviderFamily
  model: string  // e.g. "deepseek-v4-pro", "claude-opus-4.8"
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** Opaque append-only conversation tail + tool definitions authored by Core. */
export interface RequestBody {
  /** Serialised conversation tail; router must not inspect or mutate. */
  raw: Uint8Array
  /** Estimated input token count for budget pre-check. */
  estimatedInputTokens: number
}

/**
 * A request handed in by Core (01) or Nightly (10).
 * The prefix is already byte-stable; the router MUST NOT mutate it (ADR-0019).
 */
export interface ModelRequest {
  taskId: string
  requestId: string
  role: "classifier" | "generator" | "judge" | "agent"
  /** Byte-stable; cache-breakpoint layout is frozen by Core (ADR-0019). */
  stablePrefix: Uint8Array
  body: RequestBody
  /** For judge calls: the provider actually used for the paired generator artifact. */
  pairedGeneratorProvider?: ProviderId
}

export interface ModelResult {
  requestId: string
  provider: ProviderId
  content: string
  inputTokens: number
  outputTokens: number
  /** Actual dollar cost charged, computed from the resolved provider's price sheet. */
  dollarsCharged: number
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export interface RouteDecision {
  provider: ProviderId
  tier: RouteTier
  /** true if hysteresis escalated off the default provider (ADR-0018). */
  fromFallback: boolean
  /** 0..4 cache breakpoints placed in the dispatched request (ADR-0019). */
  cacheBreakpoints: number
}

// ---------------------------------------------------------------------------
// Hysteresis state (ADR-0018)
// ---------------------------------------------------------------------------

/**
 * Per-provider error counter for the current session.
 * Increments on 429 / 5xx / timeout; resets to 0 on any success.
 * Fallback fires when consecutiveErrors reaches exactly 2.
 */
export interface HysteresisState {
  provider: ProviderId
  consecutiveErrors: number
}

// ---------------------------------------------------------------------------
// Budget (Eng-12)
// ---------------------------------------------------------------------------

/** Per-task token and dollar ceilings enforced in code across all calls. */
export interface TaskBudget {
  taskId: string
  tokenCeiling: number
  dollarCeiling: number
  tokensSpent: number
  dollarsSpent: number
}

// ---------------------------------------------------------------------------
// Queue record — all-providers-down terminal policy (Eng-7)
// ---------------------------------------------------------------------------

export interface QueueRecord {
  taskId: string
  requestId: string
  serializedRequest: Uint8Array
  queuedAt: number  // epoch ms
}

// ---------------------------------------------------------------------------
// Stable-prefix stability contract
// ---------------------------------------------------------------------------

/** Session-start hash of the stable prefix used on every dispatch assertion. */
export interface PrefixContract {
  sessionId: string
  /** Hex-encoded SHA-256 of stablePrefix bytes at session start. */
  hash: string
}

// ---------------------------------------------------------------------------
// Router and adapter interfaces
// ---------------------------------------------------------------------------

/** Narrow adapter contract — Eng-11 / Finding 4: swappable test double. */
export interface ProviderAdapter {
  readonly providerId: ProviderId
  call(req: ModelRequest): Promise<ModelResult>
}

/** Dependencies injected into makeModelRouter. */
export interface ModelRouterDeps {
  adapters: ProviderAdapter[]
  /** Resolution order for fallback escalation. Defaults to the fixed policy. */
  escalationOrder?: ProviderId[]
  /** Write-only sink for observability events (route.*, budget.*, judge.*, cache.*). */
  emitEvent?: (event: RouterEvent) => void
  /** Mutable budget store; keyed by taskId. */
  budgets?: Map<string, TaskBudget>
  /** Mutable hysteresis store; keyed by `${family}:${model}`. */
  hysteresisStore?: Map<string, HysteresisState>
  /** Mutable queue for all-providers-down records; keyed by requestId. */
  queueStore?: Map<string, QueueRecord>
  /** Human review staging queue for judge collisions. */
  reviewQueue?: Map<string, ModelRequest>
  /** Whether the router is ready to dispatch (cold-start guard). */
  ready?: boolean
}

export interface ModelRouter {
  classify(req: ModelRequest): Promise<RouteTier>
  /**
   * Resolves the tier → provider decision. Fails closed: when every provider in
   * the escalation chain is down, returns the same all-providers-down terminal
   * policy as dispatch() rather than handing back a known-down provider.
   */
  route(req: ModelRequest): Promise<RouteDecision | DispatchError>
  dispatch(req: ModelRequest): Promise<ModelResult | DispatchError>
}

// ---------------------------------------------------------------------------
// Routing policy (public alias used in index.ts re-exports)
// ---------------------------------------------------------------------------

/** Alias for the routing table + escalation constants — config-level concept. */
export type RoutingPolicy = {
  readonly table: Readonly<Record<RouteTier, ProviderId>>
  readonly escalationOrder: readonly ProviderId[]
  readonly hysteresisThreshold: number  // always 2 per ADR-0018
  readonly maxCacheBreakpoints: number  // always 4 per ADR-0019
}

// ---------------------------------------------------------------------------
// Errors returned as typed results (never thrown through the agent loop)
// ---------------------------------------------------------------------------

export type DispatchError =
  | { kind: "budget_exceeded"; budget: TaskBudget }
  | { kind: "all_providers_down"; queuedRequestId: string }
  | { kind: "judge_collision_held"; candidateId: string }
  | { kind: "prefix_mutated"; expectedHash: string; actualHash: string }
  | { kind: "router_not_ready" }
  | { kind: "provider_error"; providerId: ProviderId; errorKind: ProviderErrorKind }

// ---------------------------------------------------------------------------
// Observability events emitted to Observability (12)
// ---------------------------------------------------------------------------

export type RouterEvent =
  | { type: "route.classified"; taskId: string; tier: RouteTier; fallback: boolean }
  | { type: "route.resolved"; taskId: string; decision: RouteDecision }
  | { type: "route.fallback"; taskId: string; from: ProviderId; to: ProviderId }
  | { type: "route.all_down_queued"; taskId: string; requestId: string }
  | { type: "budget.charged"; taskId: string; requestId: string; dollars: number; tokens: number }
  | { type: "budget.exceeded"; taskId: string; budget: TaskBudget }
  | { type: "judge.collision_held"; taskId: string; candidateId: string }
  | { type: "cache.prefix_mismatch"; taskId: string; expectedHash: string; actualHash: string }

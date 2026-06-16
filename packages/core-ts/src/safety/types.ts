// §3 — Safety interfaces (illustrative; no external deps)

// ---------------------------------------------------------------------------
// Core provenance primitives
// ---------------------------------------------------------------------------

export type Provenance = 'operator' | 'untrusted'

export interface ContextSpan {
  text: string
  /** Set by Core (01); Safety never sets it. Absent or unparsable → treat as 'untrusted'. */
  provenance: Provenance
  /** e.g. mcp:<server> | url:<host> | file:<path> | voice | telegram */
  source: string
}

// ---------------------------------------------------------------------------
// Tool call
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Canonical tool name, e.g. 'bash', 'telegram.send', 'mcp:write-file' */
  tool: string
  args: Record<string, unknown>
  /** True when any arg value is derived from an untrusted span (taint tracking). */
  argsTainted?: boolean
}

// ---------------------------------------------------------------------------
// Autonomy gradient — tiers 0–3  (ADR-0011)
// ---------------------------------------------------------------------------

/** Autonomy tier: property of the action class, never the model's confidence. */
export type Tier = 0 | 1 | 2 | 3

/** Global autonomy level governs whether Tier-2 may auto-run. */
export type AutonomyLevel = 'Supervised' | 'Delegation' | 'Autopilot'

export interface AutonomyTier {
  tier: Tier
  /** Glob / regex pattern matching tool names in this tier. */
  toolPattern: string
  description: string
}

/** Human-facing confirmation card rendered for Tier-3 (red card) and Tier-2 asks. */
export interface ConfirmationCard {
  tier: Tier
  actionSummary: string
  /** SHA-256 of the serialized ToolCall. */
  actionHash: string
  nonce: string
  issuedAt: number // unix ms
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'deny'; rule: string; reason: string }
  | { decision: 'ask'; tier: Tier; card: ConfirmationCard }
  | { decision: 'modify'; rewritten: ToolCall }

// ---------------------------------------------------------------------------
// HARD_DENY rule set  (ADR-0009)
// ---------------------------------------------------------------------------

export type HardDenyCategory =
  | 'infra-destruction'
  | 'filesystem-destruction'
  | 'db-destruction'
  | 'history-rewrite'
  | 'money-op'
  | 'secret-file-read'

export interface HardDenyRule {
  id: string
  /** Tested against the *normalized* tool name + serialized args string. */
  pattern: RegExp | string
  category: HardDenyCategory
}

// ---------------------------------------------------------------------------
// Injection classifier  (ADR-0028)
// ---------------------------------------------------------------------------

export type InjectionVerdict = 'clean' | 'suspicious' | 'injection'

export interface InjectionClassifier {
  /**
   * Advisory only. Returns 'clean' | 'suspicious' | 'injection'.
   * Can never downgrade a span from 'untrusted' to 'trusted'.
   * If unavailable/timeout, caller defaults to quarantine — classifier is not load-bearing.
   */
  classify(span: ContextSpan): Promise<InjectionVerdict>
}

// ---------------------------------------------------------------------------
// Input guard  (ADR-0028)
// ---------------------------------------------------------------------------

export interface InputGuard {
  /**
   * Unconditional deterministic transforms — run 100 % of the time before
   * the model sees untrusted text.  Strips markdown images / auto-loading
   * resources, neutralizes foreign URLs, defangs known injection patterns.
   */
  defang(span: ContextSpan): ContextSpan

  /**
   * Advisory escalation.  Can raise quarantine framing ('suspicious' →
   * 'injection'), but can never return a span with provenance 'operator'.
   */
  classify(span: ContextSpan): Promise<InjectionVerdict>
}

// ---------------------------------------------------------------------------
// Safety policy  (ADR-0009, ADR-0011, ADR-0027)
// ---------------------------------------------------------------------------

export interface SafetyPolicy {
  /** Loaded and self-checked; false = cold-start fail-closed mode. */
  readonly ready: boolean

  /** Pre-execution verdict for a resolved tool call given current context. */
  evaluate(call: ToolCall, ctx: ContextSpan[]): Verdict

  /** True when any span in ctx is 'untrusted' → narrowed-capability mode. */
  isNarrowed(ctx: ContextSpan[]): boolean
}

// ---------------------------------------------------------------------------
// Scoped approval grants — "session / always" (ADR-0047)
// A grant may only suppress a tier-based `ask`; it can NEVER override a `deny`.
// Granularity is per base tool. Tier-3 is never grantable (step-up every time).
// ---------------------------------------------------------------------------

export type GrantScope = 'session' | 'always'

/** Persistence for "always" grants only; session grants live in-memory. */
export interface GrantPersistencePort {
  loadAlways(): string[]
  saveAlways(tools: string[]): void
}

export interface GrantStore {
  /** True if a live session OR persisted always grant covers this tool. */
  has(tool: string): boolean
  /** Record a grant. 'always' is promoted over an existing session grant. */
  record(tool: string, scope: GrantScope): void
  revoke(tool: string): void
  revokeAll(): void
  list(): { tool: string; scope: GrantScope }[]
}

// ---------------------------------------------------------------------------
// Safety classifier (convenience wrapper used in tests)
// ---------------------------------------------------------------------------

export interface SafetyClassifier {
  classify(input: { call: ToolCall; ctx: ContextSpan[] }): Promise<Verdict>
}

// ---------------------------------------------------------------------------
// Egress guard  (ADR-0010)
// ---------------------------------------------------------------------------

export type EgressMode = 'read-only' | 'read-write'

export interface EgressAllowlistEntry {
  host: string
  methods: string[]
  mode: EgressMode
}

export interface OutboundRequest {
  host: string
  method: string
  path: string
  queryString?: string
  body?: string | Uint8Array
  headers?: Record<string, string>
}

export interface EgressGuard {
  /**
   * Data-side scan of an outbound body before it leaves the proxy.
   * Checks: read-only destination with write/body, size/entropy/secret-pattern,
   * and free-text in query string while narrowed.
   */
  inspectBody(
    req: OutboundRequest,
    ctx: ContextSpan[],
  ): { decision: 'allow' | 'deny'; reason?: string }
}

// ---------------------------------------------------------------------------
// Approval / human-confirmation handler  (ADR-0029)
// ---------------------------------------------------------------------------

export type ApprovalStatus =
  | 'approved'
  | 'rejected-replay'
  | 'rejected-stale'
  | 'rejected-hash-mismatch'
  | 'rejected-toctou'
  | 'rejected-second-factor'

export interface ApprovalRecord {
  nonce: string
  actionHash: string
  factId?: string
  op: string
  tapTimestamp: number
  secondFactorOk: boolean
  stagedHashAtAccept: string
  stagedHashAtPromote: string
}

export interface ApprovalResult {
  status: ApprovalStatus
  record?: ApprovalRecord
}

export interface ApprovalHandler {
  /**
   * The ONLY setter of is_human_confirmed / permanence flags.
   * Binds a human tap (nonce) to a hash-pinned action.
   */
  confirm(
    nonce: string,
    actionHash: string,
    secondFactor?: string,
  ): ApprovalResult

  /** Strip is_human_confirmed and all trust/permanence fields from arbitrary output. */
  stripTrustFields(output: Record<string, unknown>): Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Vault / secret management  (CSO-M3, ADR-0010)
// ---------------------------------------------------------------------------

export interface SecretRedactor {
  /** Applied to every sink — logs, audit journal, morning card, model context, outbound bodies. */
  redact(text: string): string
}

export interface Vault {
  /** Retrieve a named secret. Throws if not found. */
  getSecret(name: string): Promise<string>
  /** List available secret names (no values). */
  listSecrets(): Promise<string[]>
  /** Register a pattern to be redacted (in addition to built-in shapes). */
  addRedactionPattern(pattern: RegExp): void
  readonly redactor: SecretRedactor
}

// ---------------------------------------------------------------------------
// Sandbox / Docker runner  (ADR-0012)
// ---------------------------------------------------------------------------

export interface MountSpec {
  hostPath: string
  containerPath: string
  readOnly: boolean
}

export interface SandboxConfig {
  image: string
  mounts: MountSpec[]
  /** Absence → default-deny network. When present, per-task egress bridge host:port. */
  egressBridge?: string
  /** True = gVisor (runsc) runtime available; false = degraded mode. */
  gVisorAvailable: boolean
  /** Per-task unique id used to name/track the egress bridge. */
  taskId: string
}

export interface SandboxRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type SandboxSecurityLevel = 'full' | 'degraded-no-gvisor'

export interface SandboxRunner {
  /**
   * Validate mount spec against the allowlist (no docker.sock, own-worktree-only).
   * Returns null on success, or an error string.
   */
  validateMounts(mounts: MountSpec[]): string | null

  /**
   * Start a task container.  Returns an opaque container id.
   * Throws if mount validation fails or gVisor absent + high-risk tool requested.
   */
  start(config: SandboxConfig): Promise<string>

  /** Execute a command inside a running container. */
  exec(containerId: string, cmd: string, args: readonly string[]): Promise<SandboxRunResult>

  /**
   * Tear down the container and the per-task egress bridge.
   * Throws (marking the task failed) if teardown cannot be confirmed.
   */
  teardown(containerId: string, taskId: string): Promise<void>

  /** Security level reported at last probe. */
  readonly securityLevel: SandboxSecurityLevel
}

// ---------------------------------------------------------------------------
// Nightly carve-out  (Eng-13)
// ---------------------------------------------------------------------------

export type NightlyOpKind =
  | 'vacuum'
  | 'fts5-optimize'
  | 'wal-checkpoint'
  | 'log-rotation'
  | 'docker-prune'
  | 'worktree-prune'
  | 'git-push-ff'

export interface NightlyOp {
  kind: NightlyOpKind
  params: Record<string, unknown>
}

export interface NightlyCarveoutEntry {
  kind: NightlyOpKind
  /** Predicate that must return true before the op may run. */
  precondition(op: NightlyOp): boolean
  /** True = the op is reversible via pre-op DB snapshot. */
  reversibleBySnapshot: boolean
}

export interface NightlyCarveout {
  /** Returns true if the op is on the allowlist and its precondition holds. */
  isPermitted(op: NightlyOp): boolean
  /** Run the op unattended; throws if not permitted. */
  run(op: NightlyOp): Promise<{ ran: true } | { ran: false; reason: string }>
}

// ---------------------------------------------------------------------------
// Lethal-trifecta detection types  (ADR-0010)
// The "lethal trifecta": untrusted content in context + private data + outbound channel
// ---------------------------------------------------------------------------

export interface LethalTrifectaState {
  /** Untrusted span is in context. */
  hasUntrustedContent: boolean
  /** Private / sensitive data identified in context. */
  hasPrivateData: boolean
  /** An outbound channel (HTTP, Telegram send, git push, write MCP) is being attempted. */
  hasOutboundChannel: boolean
}

export interface LethalTrifectaResult {
  triggered: boolean
  /** Which legs of the trifecta are active. */
  state: LethalTrifectaState
}

export interface LethalTrifectaDetector {
  /** Evaluate whether opening this outbound call would complete the trifecta. */
  evaluate(call: ToolCall, ctx: ContextSpan[]): LethalTrifectaResult
}

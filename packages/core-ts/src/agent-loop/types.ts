// §3 interfaces — pure types, no implementation

/**
 * `learned-procedure` is code-generated procedural context. It is lower than
 * operator instructions and carries no authority of its own, while remaining
 * distinct from externally ingested `untrusted` content for narrowing.
 */
export type Provenance = "operator" | "learned-procedure" | "untrusted"

export interface ContextSpan {
  role: "system" | "user" | "assistant" | "tool"
  provenance: Provenance
  text: string
}

export interface FrozenSnapshot {
  prefixBytes: Uint8Array
  prefixHash: string
  breakpoints: number[]
  takenAt: string
}

export interface VerificationTraceFile {
  kind: "file"
  path: string
  existsExpected: true
  sha256?: string
}

export interface VerificationTraceSQL {
  kind: "sql"
  query: string
  expectRows: number | { op: "=" | ">" | ">="; n: number }
}

export interface VerificationTraceHTTP {
  kind: "http"
  method: string
  url: string
  expectStatus: number
}

export interface VerificationTraceExit {
  kind: "exit"
  argv: string[]
  expectCode: number
}

export type VerificationTrace =
  | VerificationTraceFile
  | VerificationTraceSQL
  | VerificationTraceHTTP
  | VerificationTraceExit

export interface PlanStep {
  intent: string
  tools: string[]
  irreversible: boolean
  trace: VerificationTrace
}

export interface Plan {
  steps: PlanStep[]
}

export interface TurnInput {
  sessionId: string
  /** Stable transport-owned id used for idempotent transcript events. Required
   *  when a transcriptRecorder is installed. */
  turnId?: string
  /** Stable transport-owned timestamp shared by this turn's transcript rows.
   *  Required with transcriptRecorder so a retry produces identical appends. */
  turnTs?: string
  spans: ContextSpan[]
  /** Optional approval token for Tier-3 plans (AC-01-17) */
  approvalToken?: string
  /** Per-turn cancellation (ADR-0051): /stop aborts the in-flight turn. The loop
   *  maps an abort to a clean Halt('stopped'), never an error. */
  signal?: AbortSignal
  /** Best-effort structured progress for transports. Safety state is emitted by
   *  the loop before the provider starts; sink failures never weaken Core. */
  onProgress?: TurnProgressSink
}

/**
 * Code-owned position of one model-requested tool call inside a turn.
 *
 * The model cannot supply or override this value. A durable adapter may use
 * the tuple as an idempotency identity, but only when `turnId` is present.
 */
export interface ToolExecutionContext {
  readonly sessionId: string
  readonly turnId?: string
  /** One-based position among every requested tool call in this turn. */
  readonly ordinal: number
  /** Turn cancellation; never participates in the durable identity. */
  readonly signal?: AbortSignal
}

/** Minimal code-owned projection admitted to typed auto-skill evidence. */
export interface VerifiedWorkflowStepObservation {
  readonly descriptorId: string
  readonly placeholderIds: readonly string[]
  readonly postconditionIds: readonly string[]
  readonly receiptId: string
}

export interface VerifiedWorkflowDeliveryBinding {
  readonly evidenceId: string
}

export interface VerifiedWorkflowObserver {
  capture(
    call: ToolCall,
    context: ToolExecutionContext,
    result: unknown,
  ): VerifiedWorkflowStepObservation | null
  /** Must be a bounded local transaction. Network/model work is forbidden here. */
  commit(input: Readonly<{
    sessionId: string
    turnId: string
    steps: readonly VerifiedWorkflowStepObservation[]
  }>): void | VerifiedWorkflowDeliveryBinding |
    Promise<void | VerifiedWorkflowDeliveryBinding>
}

export type ActionContractKind =
  | "answer-only"
  | "inspect-required"
  | "mutate-required"
  | "delegate-required"

export type ActionCompletionStatus = "verified" | "unverified"
export type ActionMissingEvidence = "none" | "observation" | "mutation" | "postcondition" | "delegation"

export type TurnState =
  | { status: "ok" }
  | { status: "awaiting-clarification" }
  | { status: "awaiting-approval" }
  | { status: "halted"; reason: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded" | "budget-capped" | "stopped" }
  | { status: "in-progress"; nextStepIndex: number; toolOrdinalHighWater: number }

/** Token + dollar usage for a turn (or a single model call). */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  dollars: number
}

export interface TurnResult {
  reply: string
  state: "ok" | "awaiting-clarification" | "awaiting-approval" | "halted"
  haltReason?: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded" | "budget-capped" | "stopped"
  /** On state "awaiting-approval", the hash of the pending Tier-3 plan; the caller must
   *  echo it back as approvalToken so a swapped plan cannot reuse a prior token (§5, AC-01-17). */
  planHash?: string
  /** True if the turn's context held an untrusted span (outbound is locked). */
  narrowed?: boolean
  /** Accumulated provider usage for the turn (when the adapter reports it). */
  usage?: TurnUsage
  /** Opaque code-owned binding confirmed only after exact terminal delivery. */
  verifiedWorkflowDelivery?: VerifiedWorkflowDeliveryBinding
  /** Present for an operator request that code classified as requiring action. */
  actionContractKind?: Exclude<ActionContractKind, "answer-only">
  /** A completion claim is verified only from tool/probe evidence, never model text. */
  actionStatus?: ActionCompletionStatus
}

export interface AgentLoop {
  runTurn(input: TurnInput): Promise<TurnResult>
}

// --- Injected collaborators (seams) ---

export interface Clock {
  now(): string
}

export interface ModelRequest {
  sessionId: string
  /** Transport-owned identity of the operator turn. Provider-owned tool loops
   *  must return it to the shared executor instead of minting a local one. */
  turnId?: string
  /** Highest code-owned tool ordinal already consumed in this turn. */
  toolOrdinalBase?: number
  /** Code-owned pre-effect checkpoint. Provider-owned tool loops must await it
   *  immediately before invoking Aisy's capability handler. */
  markToolAttempt?: (ordinal: number) => void | Promise<void>
  prefixBytes: Uint8Array
  spans: ContextSpan[]
}

export interface ModelToolRuntimeContext {
  readonly sessionId: string
  readonly turnId?: string
  /** Code-owned one-based position for supervised provider-owned tool loops. */
  readonly ordinal?: number
}

export interface ToolCall {
  name: string
  args: Record<string, unknown>
  /** ref back to the span the args were derived from, if any */
  sourceSpanProvenance?: Provenance
}

export interface ModelResponse {
  reply: string
  toolCalls?: ToolCall[]
  planPath?: string
  interpretationCount?: number
  /** Inline plan emitted by the model; linted (R1–R5) before any dispatch. */
  plan?: Plan
  /** Provider usage for this call, when the adapter reports it. */
  usage?: TurnUsage
}

/** Provider-owned progress. Terminal success/failure still travels through the
 *  complete() result/rejection so a partial stream can never masquerade as a
 *  completed model response. */
export type ModelProgressEvent =
  | { type: "started" }
  | { type: "thinking"; safeSummary?: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-requested"; toolCallId: string; name: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; result: unknown }
  | { type: "approval-required"; approvalId: string; summary: string; tier: 0 | 1 | 2 | 3 }
  | { type: "usage"; inputTokens: number; outputTokens: number; dollars?: number }

/** Code-owned progress may additionally carry the current egress verdict. The
 *  provider cannot emit or override this event. */
export type TurnProgressEvent =
  | ModelProgressEvent
  | { type: "outbound-lockout"; locked: boolean }
  | { type: "turn-started" }
  | {
      type: "turn-usage"
      inputTokens: number
      outputTokens: number
      dollars: number
    }
  | {
      type: "action-contract"
      kind: Exclude<ActionContractKind, "answer-only">
    }
  | {
      type: "action-recovery"
      kind: Exclude<ActionContractKind, "answer-only">
      missing: Exclude<ActionMissingEvidence, "none">
    }
  | {
      type: "tool-pending"
      sequence: number
      name: string
      category: "tool" | "subagent"
      /** Bounded, code-sanitized echo of the call's main argument — the command
       *  being run, the path being read. Never the full arguments. */
      arg?: string
    }
  | {
      type: "tool-started"
      sequence: number
      name: string
      category: "tool" | "subagent"
      /** Bounded, code-sanitized echo of the call's main argument — the command
       *  being run, the path being read. Never the full arguments. */
      arg?: string
    }
  | {
      type: "tool-completed"
      sequence: number
      name: string
      category: "tool" | "subagent"
      /** Bounded, code-sanitized echo of the call's main argument — the command
       *  being run, the path being read. Never the full arguments. */
      arg?: string
    }
  | {
      type: "tool-denied"
      sequence: number
      name: string
      category: "tool" | "subagent"
      /** Bounded, code-sanitized echo of the call's main argument — the command
       *  being run, the path being read. Never the full arguments. */
      arg?: string
      reason: "policy" | "untrusted-args" | "quarantined-ref"
    }
  | {
      type: "tool-failed"
      sequence: number
      name: string
      category: "tool" | "subagent"
      /** Bounded, code-sanitized echo of the call's main argument — the command
       *  being run, the path being read. Never the full arguments. */
      arg?: string
    }

export type ModelProgressSink = (event: ModelProgressEvent) => void | Promise<void>
export type TurnProgressSink = (event: TurnProgressEvent) => void | Promise<void>

export interface ProviderError extends Error {
  kind: "rate-limit" | "server-error" | "timeout" | "all-exhausted"
  /** HTTP status when the error came from an HTTP response. Lets failover tell a
   *  4xx client error (don't retry) from a 5xx server error (do retry). Absent for
   *  network-level failures. */
  httpStatus?: number
  /** Broker-backed calls expose whether upstream may have accepted the request.
   *  Callers must not replay an attempted failure implicitly. */
  attempted?: boolean
  /** Opaque per-dispatch id used to correlate an ambiguous provider attempt. */
  attemptId?: string
}

export interface ProviderAdapter {
  complete(
    req: ModelRequest,
    signal?: AbortSignal,
    onProgress?: ModelProgressSink,
  ): Promise<ModelResponse>
}

export interface HookCtx {
  provenance: Provenance
  narrowed: boolean
}

export interface HookGate {
  pre(call: ToolCall, ctx: HookCtx): Promise<"allow" | "deny" | "ask" | { modify: ToolCall }>
  /** Returns the only representation admitted to model context. */
  post(call: ToolCall, result: unknown): Promise<unknown>
}

export interface MemoryPort {
  snapshot(): Promise<FrozenSnapshot>
  forget(factRef: string, humanConfirmed: boolean): Promise<void>
}

export interface LoopGuardian {
  observe(call: ToolCall): { trip: boolean; period?: 1 | 2 | 3 }
  note(event: "replan"): void
}

export interface LogEntry {
  seq: number
  ts: string
  kind: string
  payloadHash: string
  payload: unknown
}

export interface SessionSummary {
  sessionId: string
  turns: number
  lastAt: string
}

export interface SessionLog {
  append(entry: LogEntry): void
  resume(sessionId: string, turnId?: string): TurnState | null
  recent?(n: number): SessionSummary[]
}

export interface TranscriptRecordRequest {
  sessionId: string
  turnId: string
  turnTs: string
  /** One-based, monotonic within a turn; forms part of the idempotency key. */
  ordinal: number
  span: ContextSpan
}

export interface TranscriptSessionStartRequest {
  sessionId: string
  frozen: FrozenSnapshot
}

export interface TranscriptHistoryRequest {
  sessionId: string
}

export interface TranscriptRecorder {
  /** Idempotently binds the durable manifest to the exact prefix bytes used by
   *  this AgentLoop session. On resume it returns the stored authoritative
   *  snapshot, which may differ from the current memory candidate. */
  start(input: TranscriptSessionStartRequest): Promise<FrozenSnapshot>
  /** Projects already durable rows for the next model request. Returned spans
   *  are read-only history and must not be appended again. */
  history(input: TranscriptHistoryRequest): Promise<ContextSpan[]>
  record(input: TranscriptRecordRequest): Promise<void>
}

export interface AgentLoopDeps {
  clock: Clock
  provider: ProviderAdapter
  hookGate: HookGate
  memory: MemoryPort
  guardian: LoopGuardian
  sessionLog: SessionLog
  /** Optional ADR-0064 full-fidelity sink. Legacy composition omits it and keeps
   *  byte-identical session-log behaviour. */
  transcriptRecorder?: TranscriptRecorder
  /** Byte-stable extension frozen together with the session prefix. */
  prefixExtension?: () => Uint8Array | Promise<Uint8Array>
  /**
   * Late context pull (ADR-0077). Called immediately before a provider call, so
   * a hook can fetch data at the moment it is needed. Returned spans belong to
   * that call only and never join the stable prefix, so the KV cache holds.
   */
  lateContext?: (input: {
    at: 'pre-provider' | 'post-tool'
    spans: readonly ContextSpan[]
  }) => Promise<ContextSpan[]>
  /** Maximum number of re-plans before halting with cap-exceeded (default 2) */
  maxReplans?: number
  /** Maximum total tool calls before halting with cap-exceeded */
  maxTotalToolCalls?: number
  /** Runs a verification trace probe (ADR-0017); injectable test seam. Default: pass. */
  probeRunner?: (trace: VerificationTrace) => boolean | Promise<boolean>
  /** Executes an allowed tool call; injectable test seam. Default: no-op. */
  executeTool?: (call: ToolCall, context: ToolExecutionContext) => unknown | Promise<unknown>
  /**
   * Code-owned classifier for control-flow interruptions that must cross the
   * tool boundary unchanged. Ordinary executor failures remain tool results.
   */
  propagateToolInterruption?: (
    error: unknown,
    call: ToolCall,
    context: ToolExecutionContext,
  ) => boolean
  /** Code-owned gate before Safety/approval. It may intercept internal protocol
   *  calls or return a detached call for the ordinary gate and executor. */
  preToolDispatch?: (
    call: ToolCall,
    context: ToolExecutionContext,
  ) => Readonly<{ kind: 'continue'; call: ToolCall }> |
    Readonly<{ kind: 'intercept'; result: unknown }> |
    Promise<Readonly<{ kind: 'continue'; call: ToolCall }> |
      Readonly<{ kind: 'intercept'; result: unknown }>>
  /** Observes only the already-filtered result returned by HookGate.post. */
  postToolDispatch?: (
    call: ToolCall,
    context: ToolExecutionContext,
    result: unknown,
  ) => void | Promise<void>
  /** Verified typed workflow observation; absence means zero learning I/O. */
  verifiedWorkflow?: VerifiedWorkflowObserver
  /** Post-model-call budget probe (ADR-0051): given the turn's running usage,
   *  return true to halt the turn with budget-capped. Default: never halts. */
  budgetCheck?: (usage: {
    sessionId: string
    inputTokens: number
    outputTokens: number
    dollars: number
  }) => boolean | Promise<boolean>
}

// §3 interfaces — pure types, no implementation

export type Provenance = "operator" | "untrusted"

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
  spans: ContextSpan[]
  /** Optional approval token for Tier-3 plans (AC-01-17) */
  approvalToken?: string
  /** Per-turn cancellation (ADR-0051): /stop aborts the in-flight turn. The loop
   *  maps an abort to a clean Halt('stopped'), never an error. */
  signal?: AbortSignal
}

export type TurnState =
  | { status: "ok" }
  | { status: "awaiting-clarification" }
  | { status: "awaiting-approval" }
  | { status: "halted"; reason: "loop-guardian" | "all-providers-down" | "plan-lint-failed" | "cap-exceeded" | "budget-capped" | "stopped" }
  | { status: "in-progress"; nextStepIndex: number }

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
  prefixBytes: Uint8Array
  spans: ContextSpan[]
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

export interface ProviderError extends Error {
  kind: "rate-limit" | "server-error" | "timeout" | "all-exhausted"
}

export interface ProviderAdapter {
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>
}

export interface HookCtx {
  provenance: Provenance
  narrowed: boolean
}

export interface HookGate {
  pre(call: ToolCall, ctx: HookCtx): Promise<"allow" | "deny" | "ask" | { modify: ToolCall }>
  post(call: ToolCall, result: unknown): Promise<void>
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

export interface SessionLog {
  append(entry: LogEntry): void
  resume(sessionId: string): TurnState | null
}

export interface AgentLoopDeps {
  clock: Clock
  provider: ProviderAdapter
  hookGate: HookGate
  memory: MemoryPort
  guardian: LoopGuardian
  sessionLog: SessionLog
  /** Maximum number of re-plans before halting with cap-exceeded (default 2) */
  maxReplans?: number
  /** Maximum total tool calls before halting with cap-exceeded */
  maxTotalToolCalls?: number
  /** Runs a verification trace probe (ADR-0017); injectable test seam. Default: pass. */
  probeRunner?: (trace: VerificationTrace) => boolean | Promise<boolean>
  /** Executes an allowed tool call; injectable test seam. Default: no-op. */
  executeTool?: (call: ToolCall) => unknown | Promise<unknown>
  /** Post-model-call budget probe (ADR-0051): given the turn's running usage,
   *  return true to halt the turn with budget-capped. Default: never halts. */
  budgetCheck?: (usage: {
    sessionId: string
    inputTokens: number
    outputTokens: number
    dollars: number
  }) => boolean | Promise<boolean>
}

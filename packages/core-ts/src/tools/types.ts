// Component 04: Tools & Hooks — Types
// Pure interfaces; no implementation, no external deps.

// ---- Narrow-waist base tool set (ADR-0014). Count invariant: < 20. ----

export type BaseToolName =
  | 'bash'           // run in the sandbox (Safety 05); never on host
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_dir'
  | 'search_memory'  // FTS5/BM25 read, Tier-0
  | 'fetch_web'      // via egress proxy (Safety 05)
  | 'send_message'   // outbound channel (Telegram) — outbound-tagged
  | 'git'            // wrapper; push/force gated by HARD_DENY + outbound tag
  | 'call_mcp'       // single entry to all MCP tools (MCP 07)
  | 'call_skill'     // single entry to skill bodies (Skills 06)

// Provenance of a value in context — set only by Core (01); never by the model.
export type Provenance = 'operator' | 'untrusted'

// ---- Tool call ----

export interface ToolCall {
  tool: BaseToolName
  args: Record<string, unknown>
  /** Provenance of every arg, threaded from Core (01) context assembly. */
  argProvenance: Record<string, Provenance> // never set by the model
}

// A tool call that has been normalized (canonical paths, decoded args, expanded aliases).
export interface NormalizedCall extends ToolCall {
  readonly _normalized: true
}

// ---- Write semantics (spec 04 §5, AC-04-19) ----

/** Discriminates a destructive overwrite from a non-destructive append. */
export type WriteMode = 'overwrite' | 'append'

/** Args shape for write_file relevant to the destructive-write gate. */
export interface WriteFileArgs {
  path: string
  content: string
  /** Defaults to 'overwrite' when omitted. */
  writeMode?: WriteMode
  /** Explicit confirmation required for a destructive overwrite. */
  confirmOverwrite?: boolean
}

/** Result of the write-path precondition check (AC-04-19). */
export interface WriteModeVerdict {
  ok: boolean
  /** Whether the requested write would truncate existing content. */
  truncates: boolean
  reason?: string
}

// ---- PreToolUse verdict ----

export interface ApprovalCard {
  toolName: BaseToolName
  normalizedArgs: Record<string, unknown>
  reason: string
}

export type PreVerdict =
  | { kind: 'allow'; call: NormalizedCall }
  | { kind: 'deny'; reason: string; rule: string }
  | { kind: 'ask'; tier: 2 | 3; card: ApprovalCard }
  | { kind: 'modify'; call: NormalizedCall; note: string }

// ---- PostToolUse types ----

export interface ToolResult {
  ok: boolean
  rawText: string
  error?: unknown
}

/** Simplified verdict shape used in tests; the full PreVerdict is the discriminated union above. */
export interface VerdictShape {
  kind: string
  rule?: string
  reason?: string
}

export interface ContextSafeResult {
  ok: boolean
  text: string        // redacted, filtered, possibly compressed
  redacted: boolean   // true if any vault value was masked
  compressed: boolean // true only if rtk ran and succeeded
  /** The PreToolUse verdict when execute() is implemented; undefined in stubs. */
  verdict?: VerdictShape
}

// ---- Context state (provided by Core 01) ----

export interface ContextState {
  hasUntrustedSpan: boolean  // any span tagged untrusted in context
  activeTier: 0 | 1 | 2 | 3
}

// ---- Tool definition (for the base registry) ----

export interface ToolDefinition {
  name: BaseToolName
  description: string
  /** Tier for capability narrowing (ADR-0027 / ADR-0011). */
  tier: 0 | 1 | 2 | 3
  /** True for tools that send bytes outside the system (ADR-0027). */
  outboundSink: boolean
  /** Whether the tool has side effects (writes, sends, executes). */
  sideEffecting: boolean
}

// ---- Rule types (owned by Safety 05; consumed here) ----

export interface HardDenyRule {
  id: string
  pattern: RegExp
  reason: string
}

export interface HardAllowRule {
  id: string
  pattern: RegExp
  reason: string
}

// ---- Hooks ----

export interface Hooks {
  /**
   * PreToolUse: deterministic, 100%.
   * Model does not see or vote on the verdict.
   */
  preToolUse(call: ToolCall, ctx: ContextState): Promise<PreVerdict>

  /**
   * PostToolUse: error->result, redact, filter, optional compress.
   * Returns the exact bytes that will enter context.
   * Fixed order: error-wrap -> redact -> filter -> compress.
   */
  postToolUse(call: NormalizedCall, raw: ToolResult): Promise<ContextSafeResult>
}

// ---- rtk compression boundary (ADR-0022) ----

export interface Compressor {
  /**
   * Returns raw input unchanged on ANY error (non-zero exit, malformed,
   * missing binary, timeout); never throws into the loop.
   */
  compress(input: string): Promise<{ text: string; compressed: boolean }>
  verifyBinary(): { ok: boolean; resolvedPath: string; version: string }
}

// ---- Tool registry ----

export interface ToolRegistryDeps {
  hooks: Hooks
  compressor?: Compressor
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void
  execute(call: ToolCall, ctx: ContextState): Promise<ContextSafeResult>
}

// ---- Observable events emitted to Observability (12) ----

export type ToolEventKind =
  | 'tool.pre_verdict'
  | 'tool.denied'
  | 'tool.blocked_motivated'
  | 'tool.outbound_locked'
  | 'tool.redacted'
  | 'tool.compressed'
  | 'tool.rtk_fallback'

export interface ToolEvent {
  kind: ToolEventKind
  toolName: BaseToolName
  rule?: string
  redactionCount?: number
  compressed?: boolean
}

// MCP component (07) — pure types. No implementation, no external deps.
// See docs/specs/07-mcp.md §3.

export type McpTransport = "stdio" | "streamable-http"

// ── Allowlist ─────────────────────────────────────────────────────────────────

/** Human-owned, version-controlled entry in the MCP allowlist config.
 *  `tier` and `outboundSink` live here; they are NEVER derived from descriptor text (CSO-M2). */
export interface McpServerEntry {
  name: string              // namespace prefix, e.g. "tracker"
  transport: McpTransport
  endpoint?: string         // HTTP only; MUST be on Safety egress allowlist
  command?: string[]        // stdio only; pinned binary
  pin: string               // exact version@digest; REQUIRED — fail-closed without it
  descriptorHash: string    // sha256 from first human approval; REQUIRED — fail-closed without it
  tokenEnv: string | null   // minimal-scope token env name; null = local read-only server
  tools: McpToolPolicy[]    // per-tool tier + read/write, human-authored
}

/** Per-tool policy — human-authored at allowlist time.
 *  The sole authority for `tier` and `outboundSink`; descriptor text is not an input. */
export interface McpToolPolicy {
  tool: string              // bare tool name; exposed to the model as `${server}.${tool}`
  tier: 0 | 1 | 2 | 3      // autonomy tier (ADR-0011)
  outboundSink: boolean     // true = writable / side-effecting destination (CSO-H1)
  summary: string | null    // human-authored menu line; null -> quarantined-generated pass (Eng-9)
}

// ── Connect result ─────────────────────────────────────────────────────────────

export type ConnectResult =
  | { kind: "connected"; menu: McpMenuLine[] }
  | { kind: "refused"; reason: "not-allowlisted" | "no-pin" | "no-hash" | "pin-mismatch" | "egress-blocked" | "token-unresolved" }
  | { kind: "disabled"; reason: "hash-mismatch"; diffCard: DiffCard }

// ── Prompt menu ───────────────────────────────────────────────────────────────

/** One namespaced line injected into the model's tool menu.
 *  Raw `description`, full `inputSchema`, endpoint URLs, tokens, and hashes are kept out of the prompt. */
export interface McpMenuLine {
  name: string              // namespaced `server.tool`
  summary: string           // human-authored OR quarantined-generated+classified; NEVER raw description
  rw: "read" | "write"      // derived from McpToolPolicy.outboundSink, not from descriptor
  tier: 0 | 1 | 2 | 3
}

// ── Raw descriptor (from tools/list) ─────────────────────────────────────────

/** The untrusted descriptor shape returned by a server's `tools/list` call.
 *  This is input to descriptor hashing only — it never reaches the prompt verbatim. */
export interface RawDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  rwClassInputs?: Record<string, unknown>   // optional read/write classification inputs
}

// ── Resolved call ─────────────────────────────────────────────────────────────

/** A model-selected tool resolved to a concrete call, ready for PreToolUse hook gating.
 *  `outboundSink` and `tier` are always taken from `McpToolPolicy`, never from descriptor. */
export interface ResolvedMcpCall {
  server: string
  tool: string
  args: Record<string, unknown>
  outboundSink: boolean     // from McpToolPolicy; hooks use this for outbound lockout (CSO-H1)
  tier: 0 | 1 | 2 | 3
}

// ── Untrusted result span ─────────────────────────────────────────────────────

/** Every MCP tools/call result is wrapped in this type at ingestion.
 *  `provenance` is set by code, never by the model (ADR-0028). */
export interface UntrustedResultSpan {
  provenance: "untrusted"   // always; safety transforms run before this enters context
  text: string              // pre-classifier; Safety deterministic transforms run 100%
  server: string
}

// ── Diff card ─────────────────────────────────────────────────────────────────

/** Emitted when the live descriptor hash mismatches the stored value.
 *  Server stays disabled until an operator reviews and approves the diff. */
export interface DiffCard {
  server: string
  oldHash: string
  newHash: string
  descriptorDiff: string    // textual diff of old vs new descriptors, for human review
}

// ── Client interface ──────────────────────────────────────────────────────────

export interface McpClient {
  /** Deterministic connect gauntlet (ADR-0013). Pure code; no model call. */
  connect(name: string): Promise<ConnectResult>

  /** Canonical sha256 over name + description + inputSchema + rwClassInputs, sorted by name (CSO-M2).
   *  Byte-stable: identical descriptors always produce the same hash. */
  descriptorHash(tools: RawDescriptor[]): string

  /** Resolve a model-selected `server.tool` to a concrete call.
   *  The returned call re-enters Tools & Hooks (04) PreToolUse; this method NEVER executes a write. */
  resolve(namespaced: string, args: unknown): ResolvedMcpCall

  /** Execute an already hook-approved call against the per-process, minimal-scope server.
   *  Returns the result span tagged `untrusted` for Safety's classifier (ADR-0028). */
  invokeApproved(call: ResolvedMcpCall): Promise<UntrustedResultSpan>
}

// ── Manager + dependency injection ───────────────────────────────────────────

/** Allowlist config — the human-owned, version-controlled source of truth. */
export interface McpAllowlistConfig {
  servers: McpServerEntry[]
}

/** Hash record stored per server after first-approval (mirrors the allowlist fields). */
export interface McpDescriptorHash {
  server: string
  hash: string              // sha256 from approved descriptors
}

/** Observability events this component emits (Observability 12). */
export type McpEvent =
  | "mcp.connected"
  | "mcp.refused"
  | "mcp.disabled_hash_mismatch"
  | "mcp.diff_card_emitted"
  | "mcp.summary_quarantined"
  | "mcp.result_classified"
  | "mcp.result_quarantined"

export interface McpManagerDeps {
  /** Loaded allowlist config; absent = cold-start, fail-closed. */
  allowlist: McpAllowlistConfig | null

  /** Check whether an HTTP endpoint host is on the Safety egress allowlist. */
  isEgressAllowed(host: string): boolean

  /** Resolve a token by env name; returns null if unresolved. */
  resolveToken(envName: string): string | null

  /** Emit an observability event. */
  emit(event: McpEvent, payload?: unknown): void

  /** Stub for the quarantined summary-generation pass (Eng-9).
   *  Returns null on failure (tool omitted from menu rather than falling back to raw description). */
  generateSummary(descriptor: RawDescriptor): Promise<string | null>

  /** Spy-able spawn shim — returns an opaque process handle. */
  spawnProcess(command: string[], env: Record<string, string>): McpProcessHandle

  /** Fetch the live tools/list from a server process. */
  fetchDescriptors(handle: McpProcessHandle): Promise<RawDescriptor[]>

  /** Resolve live version/digest from a server process (before tools/list). */
  resolvePin(handle: McpProcessHandle): Promise<string>

  /** Capability-narrowing input (ADR-0027): true while an untrusted span is in context. */
  hasUntrustedSpan?: () => boolean

  /** Execute an approved tools/call against a running server (injectable seam, Eng-11). */
  invokeTool?: (handle: McpProcessHandle, call: ResolvedMcpCall) => Promise<string>

  /** Test seam: observe the policy-resolved call before invocation. */
  onResolved?: (call: ResolvedMcpCall) => void
}

/** Opaque handle to a running MCP server process (stdio) or HTTP session. */
export interface McpProcessHandle {
  readonly id: string
  readonly env: Record<string, string>
  terminate(): void
}

/** The public manager surface (narrow waist — the model only reaches this via `call_mcp`). */
export interface McpManager {
  /** Run the full connect gauntlet for a named server (ADR-0013). */
  connect(name: string): Promise<ConnectResult>

  /** Resolve + invoke an already-approved `server.tool` call.
   *  `argProvenance` is code-assigned by the caller (ADR-0028); untrusted-derived
   *  args on an outbound sink are blocked (motivated-call, ADR-0027). */
  call(namespaced: string, args: Record<string, unknown>, argProvenance?: "operator" | "untrusted"): Promise<UntrustedResultSpan>

  /** Return true if the stored hash for the entry matches the recomputed hash.
   *  Used by the connect gauntlet; exposed for testing. */
  verifyHash(entry: McpServerEntry, live: RawDescriptor[]): boolean
}

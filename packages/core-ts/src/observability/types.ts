// §3 interfaces — pure types, no implementation
// Shared contract between Core (01) and Observability (12).

// Re-export from agent-loop for the shared contract; this component executes and matches.
export type {
  VerificationTrace,
  VerificationTraceFile,
  VerificationTraceSQL,
  VerificationTraceHTTP,
  VerificationTraceExit,
  ToolCall,
  LoopGuardian,
  Clock,
} from '../agent-loop/types.js'

// ---- trace verifier ----

export interface TraceResult {
  pass: boolean
  kind: "file" | "sql" | "http" | "exit"
  /** The real observed value (hash, row count, status, exit code) — redacted at journal sink */
  observed: unknown
  /** Why it failed, for the human-facing card */
  reason?: string
}

/**
 * Deterministic effect probe.
 * Production: touches the real world.
 * Tests: fake implementation scripted to report an absent effect (Eng-11 seam).
 */
export interface EffectProbe {
  file(path: string): Promise<{ exists: boolean; sha256?: string }> | { exists: boolean; sha256?: string }
  sql(query: string): Promise<{ rows: number }> | { rows: number }
  http(method: string, url: string): Promise<{ status: number }> | { status: number }
  exit(argv: string[]): Promise<{ code: number }> | { code: number }
}

export interface TraceVerifier {
  /** Runs the probe via the injected EffectProbe and matches against the declared trace. */
  verify(trace: import('../agent-loop/types.js').VerificationTrace, probe: EffectProbe): Promise<TraceResult>
}

// ---- trace linter (R1–R5, ADR-0026) ----

export type LintRule = "R1" | "R2" | "R3" | "R4" | "R5"

export type LintResult =
  | { ok: true }
  | { ok: false; rule: LintRule; stepIndex: number }

export interface LintablePlanStep {
  trace?: import('../agent-loop/types.js').VerificationTrace
  irreversible: boolean
  tools: string[]
  producesPath?: string
}

export interface TraceLinter {
  /**
   * Returns { ok: true } when all steps pass R1–R5.
   * Returns { ok: false, rule, stepIndex } on the first failing step.
   *   R1 – missing trace
   *   R2 – Tier ≥ 2 tool but irreversible !== true
   *   R3 – vacuous trace (no-op argv, loopback http, already-existing non-produced path)
   *   R4 – self-referential trace (points at PLAN.md/TODO.md or the step's own prose)
   *   R5 – out-of-enum kind
   */
  lint(plan: { steps: LintablePlanStep[] }): LintResult
}

// ---- append-only journal (ADR-0021) ----

export interface JournalEntry {
  /** Monotonic, gap-free per session */
  seq: number
  /** ISO timestamp from injected Clock; never on any cached prefix */
  ts: string
  /** Component id: "01".."12" */
  source: string
  /** e.g. "step.verified" | "guardian.tripped" | "decision" | "verify.pass" | "verify.fail" */
  kind: string
  /** Hash of previous entry for tamper-evidence chaining */
  prevHash: string
  /** Hash of the payload */
  payloadHash: string
  /** Already secret-redacted before append() returns */
  payload: unknown
}

export interface JournalFilter {
  sessionId?: string
  kind?: string
  /** Inclusive lower bound on seq */
  since?: number
}

export interface Journal {
  /** Redacts payload, chains prevHash, fsyncs. Throws when secret set not loaded. */
  append(source: string, kind: string, payload: unknown): Promise<JournalEntry>
  read(filter: JournalFilter): JournalEntry[]
}

export interface AuditLogDeps {
  clock: import('../agent-loop/types.js').Clock
  secretRedactor: SecretRedactor
}

/** Alias for external callers that prefer the AuditLog name */
export type AuditLog = Journal

// ---- secret redactor (CSO-M3) ----

export interface SecretRedactor {
  /**
   * Strips every known vault secret VALUE (and value-derived encodings) from arbitrary structures.
   * Safe to call before the vault is loaded — returns value unchanged but tracks that
   * no vault set is loaded, causing append() to fail-closed.
   */
  redact<T>(value: T): T
  /** Called by Safety (05) at start and on vault changes */
  loadVaultValues(values: ReadonlySet<string>): void
  /** True once loadVaultValues has been called at least once */
  readonly isLoaded: boolean
}

// ---- Loop Guardian (owned here; Core 01 holds the reference) ----
// LoopGuardian is re-exported from agent-loop/types.ts above (shared contract).

export interface GuardianDeps {
  /** Size of the bounded sliding window (default 12) */
  windowSize?: number
  /** Trip threshold — how many full cycle repeats trigger a halt (default 3) */
  tripThreshold?: number
  journal: Journal
}

// ---- verification runner (convenience façade) ----

export interface VerificationRunner {
  verify(
    trace: import('../agent-loop/types.js').VerificationTrace,
    probe: EffectProbe,
  ): Promise<TraceResult>
}

// ---- trace entry (used in observability reporting) ----

export interface TraceEntry {
  traceId: string
  stepIndex: number
  trace: import('../agent-loop/types.js').VerificationTrace
  result: TraceResult
  ts: string
}

// ---- cycle detector (separate from LoopGuardian interface) ----

export interface CycleDetector {
  /** Returns the detected period (1, 2, or 3) if a cycle of that length repeats > threshold times, else null */
  detect(window: string[]): { period: 1 | 2 | 3 } | null
}

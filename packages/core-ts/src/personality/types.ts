// §3 interfaces — pure types, no implementation

// ---- Principle hierarchy ----

export type Precedence = number   // lower = wins; total order, no ties allowed

export interface Principle {
  id: string                      // stable id, /^[a-z0-9][a-z0-9-]*$/
  precedence: Precedence          // unique within the constitution
  veto: boolean                   // exactly ONE principle has veto === true
  text: string                    // the normative statement (a frame, not a regex)
}

export interface Constitution {
  principles: Principle[]         // sorted ascending by precedence at parse time
  vetoId: string                  // the single id where veto === true
}

// ---- Persona ----

export interface Soul {
  raw: string                     // SOUL.md bytes (persona, voice, register)
  modes: Record<string, string>   // named register variants; never override precedence
}

// ---- Identity payload (the re-seed unit, finding 3) ----

export interface IdentityPayload {
  constitution: string            // constitution.md bytes, in precedence order
  soul: string                    // SOUL.md bytes
  hash: string                    // SHA-256 over (constitution || soul); the identity fingerprint
}

// ---- Veto ----

/**
 * Provenance-bound human confirmation (ADR-0029). Set ONLY by the deterministic
 * approval handler in direct response to a human tap on a specific channel —
 * never by model-turn code. The `channel` is verified against the
 * harness-controlled trusted-channel allowlist; a model can propose this shape
 * but cannot forge a trusted channel.
 */
export interface HumanConfirmation {
  channel: string                 // must be on the harness trusted-channel allowlist
  requestId: string               // the approval card / request this confirms
  issuedAt: number                // epoch ms the handler recorded the tap
}

export interface ProposedAction {
  id: string
  irreversible: boolean
  description: string
  metadata?: Record<string, unknown>
}

export interface VetoVerdict {
  allowed: boolean
  vetoId: string | null           // the principle that blocked it, if blocked
  reason: string                  // human-readable, surfaced on the card
}

// ---- Mode selection ----

export type ModeResult =
  | { ok: true; mode: string }
  | { ok: false; reason: 'unknown_mode' | 'mode_touches_precedence' | 'mode_disables_veto' }

// ---- Validation ----

export interface ValidationReport {
  unique_precedence: boolean      // no two principles share a precedence (total order)
  exactly_one_veto: boolean       // exactly one veto === true
  soul_present: boolean           // SOUL.md non-empty and parses
  ok: boolean                     // AND of all checks; false fails the session closed
}

// ---- Anti-degradation context ----

export interface DegradationCheckContext {
  sessionHash: string
  candidatePayload: IdentityPayload
}

export interface DegradationCheckResult {
  ok: boolean
  reason?: 'hash_mismatch' | 'soul_mismatch' | 'constitution_mismatch'
}

// ---- Personality loader (the narrow waist, §3) ----

export interface PersonalityLoader {
  /** Session start: load, validate, sort, and hash the identity payload. Fail-closed. */
  load(path: string): Promise<IdentityPayload>

  /** Return the active mode name (default: 'default'). */
  getActivePersona(): string

  /** Anti-degradation check: verify a candidate payload is byte-identical to the session original. */
  checkDegradation(ctx: DegradationCheckContext): Promise<DegradationCheckResult>
}

// ---- Full Personality surface (§3 illustrative interface) ----

export interface Personality {
  /** Session start: build the identity segment of the stable prefix. */
  loadIdentity(): IdentityPayload

  /** Anti-degradation: the verbatim payload Orchestration re-seeds (finding 3). */
  reseedPayload(): IdentityPayload

  /** Normative veto: deterministic frame check before an irreversible step. */
  checkVeto(action: ProposedAction): VetoVerdict

  /** Mode selection: tone only, never precedence. */
  setMode(name: string): ModeResult

  /** Load-time validation — fail-closed. */
  validate(c: Constitution, s: Soul): ValidationReport
}

// ---- Anti-degradation guard (callable seam for Orchestration 11) ----

export interface AntiDegradationGuard {
  /** Assert the re-seeded payload matches the session-original hash. Fail-closed on mismatch. */
  assertReseed(payload: IdentityPayload): DegradationCheckResult
}

// ---- PersonalityConfig (from AGENTS.md / SOUL.md) ----

export interface PersonalityConfig {
  /** Absolute path to SOUL.md on disk */
  soulPath: string
  /** Absolute path to constitution.md on disk */
  constitutionPath: string
  /** Initial mode name (default: 'default') */
  initialMode?: string
}

// ---- Errors ----

export class ConstitutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConstitutionError'
  }
}

export class SoulMissing extends Error {
  constructor(message = 'SOUL.md absent or empty') {
    super(message)
    this.name = 'SoulMissing'
  }
}

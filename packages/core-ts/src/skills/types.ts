// §3 interfaces — pure types, no implementation

// ---------------------------------------------------------------------------
// Core frontmatter / SKILL.md format (ADR-0015)
// ---------------------------------------------------------------------------

export type Provenance = 'human' | 'agent-authored' | 'imported'

export interface SkillFrontmatter {
  /** Stable id; telemetry join key; immutable once promoted. /^[a-z0-9][a-z0-9-]*$/ */
  name: string
  /** <= 60 chars — the single menu line injected into the prefix. */
  description: string
  /** Bumped on every approved edit; mirrors git commit chain. */
  version: number
  provenance: Provenance
  /** Phrases/intents matched deterministically at runtime. */
  triggers: string[]
}

/** The raw body text of a skill (Markdown after the frontmatter). */
export type SkillBody = string

export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: SkillBody
  /** Raw bytes of the complete SKILL.md, used for hash-pinning. */
  rawBytes: Uint8Array
}

export type ParseError =
  | { kind: 'description_too_long'; length: number }
  | { kind: 'missing_field'; field: keyof SkillFrontmatter }
  | { kind: 'invalid_name_format'; name: string }
  | { kind: 'malformed_frontmatter'; detail: string }

export type ParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; errors: ParseError[] }

// ---------------------------------------------------------------------------
// Menu — resident path (every prompt assembly)
// ---------------------------------------------------------------------------

/** What enters the always-loaded prefix: one line per active+trusted skill. */
export interface MenuEntry {
  name: string
  description: string
}

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

export interface SkillTrigger {
  skillName: string
  phrase: string
}

// ---------------------------------------------------------------------------
// Validation (deterministic, §6 validators)
// ---------------------------------------------------------------------------

export interface ValidationReport {
  refs_exist: boolean
  no_constitution_conflict: boolean
  dry_run_ok: boolean
  has_verification_section: boolean
  /** AND of all four; false drops the candidate before the judge. */
  ok: boolean
}

// ---------------------------------------------------------------------------
// Staged-skill record (ADR-0015, ADR-0029)
// ---------------------------------------------------------------------------

export interface TriggerContext {
  /** The request text or trace excerpt that caused the draft. */
  request: string
  sessionId: string
}

export interface StagedSkill {
  stageId: string
  /** SHA-256 of the exact bytes the judge accepted; re-checked at promote. */
  artifactHash: string
  /** Unified diff vs current prod skill, or empty for a new skill. */
  diff: string
  triggerContext: TriggerContext
  /**
   * True only when the verification section has passed against real traces
   * (ADR-0017). Never set from a self-report.
   */
  traceVerified: boolean
  provenance: Provenance
  /** Full text of the candidate (body + frontmatter). */
  fullText: string
}

/** Payload sent to the reviewer / approval card. */
export interface ReviewCard {
  stageId: string
  fullText: string
  diff: string
  triggerContext: TriggerContext
}

// ---------------------------------------------------------------------------
// Promotion (ADR-0029)
// ---------------------------------------------------------------------------

export interface ApprovalVerdict {
  stageId: string
  /** Must equal the judge-accept hash (TOCTOU close, ADR-0029 §3). */
  artifactHash: string
  /** Single-use, bound to this exact pending action (ADR-0029 §4). */
  nonce: string
  /** Required for permanence/irreversible items (ADR-0029 §5). */
  stepUpSatisfied: boolean
  /** Binding: which human tap → which action → when. */
  humanTapAuditId: string
}

/**
 * promote() claims the staged record synchronously (deleting it before the
 * first await) to close the concurrent-double-promote TOCTOU (ADR-0029 #4).
 * A consequence: if a post-claim gate fails (`not_trace_verified`,
 * `stepup_missing`) or the git commit throws, the staged artifact is already
 * consumed — the caller must re-stage and re-approve with a fresh nonce.
 */
export type PromoteResult =
  | { ok: true; commit: string; version: number }
  | {
      ok: false
      reason:
        | 'hash_mismatch'
        | 'replayed_nonce'
        | 'stepup_missing'
        | 'not_trace_verified'
        | 'no_pending_action'
    }

// ---------------------------------------------------------------------------
// Failure / negative-skill path (ADR-0025)
// ---------------------------------------------------------------------------

export type FailureClass = 'transient' | 'permanent'

export interface FailureSignal {
  /** The tool or strategy that failed. */
  target: string
  class: FailureClass
  sessionId: string
  detail?: string
}

export interface NegativeSkillRecord {
  /** The tool/strategy the negative skill deprioritizes. */
  target: string
  /** Distinct-session permanent-class failure count. Threshold: >= 3. */
  failureCount: number
  sessionIds: string[]
  valid_at: string
  invalid_at: string | null
  /** Always true: advisory only, never HARD_DENY (ADR-0025). */
  advisory: true
}

export interface ProbeReport {
  unfossilized: string[]
  stillFailing: string[]
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Main Skills interface (narrow waist — Agent Loop sees only menu/loadBody)
// ---------------------------------------------------------------------------

export interface Skills {
  // ---- resident path (cheap, called every prompt assembly) ----
  menu(): MenuEntry[]
  matchTriggers(request: string): string[]
  loadBody(name: string): Promise<SkillBody>

  // ---- authoring path (called by Nightly Consolidation 10) ----
  parse(raw: string): ParseResult
  /**
   * §6 deterministic validators. Async because `dry_run_ok` awaits Safety's
   * network-none sandbox: a body the sandbox REJECTS (resolves `{ok:false}`)
   * must fail-closed, not just one whose invocation throws.
   */
  validate(candidate: ParsedSkill): Promise<ValidationReport>
  stage(candidate: ParsedSkill, ctx: TriggerContext): StagedSkill
  reviewPayload(stageId: string): ReviewCard

  // ---- promotion path (consumes Safety/Personality approval verdict) ----
  promote(stageId: string, approval: ApprovalVerdict): Promise<PromoteResult>

  // ---- failure / negative-skill path (ADR-0025) ----
  recordFailure(name: string | null, f: FailureSignal): void
  probe(): Promise<ProbeReport>
}

// ---------------------------------------------------------------------------
// Dependency injection seams
// ---------------------------------------------------------------------------

export interface SandboxPort {
  /** Run the skill body in a network-none, read-only one-shot sandbox. */
  dryRun(body: SkillBody): Promise<{ ok: boolean; detail?: string }>
}

export interface ObservabilityPort {
  /** Check whether the given skill's verification section has passed against real traces. */
  hasPassingTrace(skillName: string): Promise<boolean>
  emit(event: string, payload: unknown): void
}

export interface GitPort {
  commit(message: string, files: Record<string, string>): Promise<string>
}

export interface NonceStore {
  consume(nonce: string, stageId: string): boolean
}

export interface SkillsDeps {
  sandbox: SandboxPort
  observability: ObservabilityPort
  git: GitPort
  nonceStore: NonceStore
}

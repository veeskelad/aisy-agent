import { createHash, randomUUID } from 'node:crypto'

export type {
  Provenance,
  SkillFrontmatter,
  SkillBody,
  ParsedSkill,
  ParseError,
  ParseResult,
  MenuEntry,
  SkillTrigger,
  ValidationReport,
  TriggerContext,
  StagedSkill,
  ReviewCard,
  ApprovalVerdict,
  PromoteResult,
  FailureClass,
  FailureSignal,
  NegativeSkillRecord,
  ProbeReport,
  SkillRevisionIdentity,
  SkillTraceEvidence,
  SkillPromotionAudit,
  SkillApprovalPreview,
  Skills,
  SandboxPort,
  ObservabilityPort,
  GitPort,
  NonceStore,
  SkillsDeps,
} from './types.js'

import type {
  Skills,
  SkillsDeps,
  ParseResult,
  ParseError,
  ParsedSkill,
  SkillFrontmatter,
  Provenance,
  ValidationReport,
  TriggerContext,
  StagedSkill,
  ReviewCard,
  ApprovalVerdict,
  PromoteResult,
  FailureSignal,
  NegativeSkillRecord,
  ProbeReport,
  MenuEntry,
  SkillRevisionIdentity,
  SkillTraceEvidence,
  SkillApprovalPreview,
} from './types.js'

// ---------------------------------------------------------------------------
// Hashing — SHA-256 over the exact candidate bytes (§4.2, ADR-0029 #3).
// rawBytes is the byte-stable artifact; the pin is taken at stage() time and
// re-checked at promote() to close the TOCTOU window.
// ---------------------------------------------------------------------------

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export function computeSkillActionHash(input: {
  stageId: string
  name: string
  candidateVersion: number
  artifactHash: string
  baseVersion?: number | null
  baseArtifactHash?: string | null
  diffHash?: string
  provenance?: Provenance
  riskClassification?: 'reversible' | 'irreversible'
  stepUpRequired?: boolean
  touchedPaths?: string[]
  traceEvidence?: SkillTraceEvidence
}): string {
  const canonical = 'skill.promote/v2\n' + JSON.stringify({
    stageId: input.stageId,
    name: input.name,
    baseVersion: input.baseVersion ?? null,
    baseArtifactHash: input.baseArtifactHash ?? null,
    candidateVersion: input.candidateVersion,
    artifactHash: input.artifactHash,
    diffHash: input.diffHash ?? null,
    traceIdentity: {
      skillName: input.name,
      artifactHash: input.artifactHash,
      revision: input.candidateVersion,
    },
    traceEvidence: input.traceEvidence ?? null,
    provenance: input.provenance ?? null,
    riskClassification: input.riskClassification ?? null,
    stepUpRequired: input.stepUpRequired ?? null,
    touchedPaths: input.touchedPaths ?? null,
  })
  return hashBytes(new TextEncoder().encode(canonical))
}

export class SkillStageError extends Error {
  constructor(public readonly code: 'INVALID_SKILL_STAGE' | 'PROHIBITED_SKILL_AUTHORITY_FIELD') {
    super(code)
    this.name = 'SkillStageError'
  }
}

// ---------------------------------------------------------------------------
// SKILL.md parser — frontmatter contract (§4.1, ADR-0015).
// Deterministic, fail-closed: a malformed candidate is dropped pre-judge.
// We use a minimal YAML reader for the fixed frontmatter shape rather than a
// general parser — the contract is a flat scalar/list block (§4.1).
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const REQUIRED_FIELDS = ['name', 'description', 'version', 'provenance', 'triggers'] as const
const VALID_PROVENANCE: ReadonlySet<string> = new Set(['human', 'agent-authored', 'imported'])

interface RawFrontmatter {
  name?: string
  description?: string
  version?: number
  provenance?: string
  triggers?: string[]
  unknownFields: string[]
  duplicateFields: string[]
}

/** Split the leading `---`…`---` block from the body. null = no frontmatter. */
function splitFrontmatter(raw: string): { fm: string; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  // Closing fence must be a line that is EXACTLY `---` (trimmed) — a body line
  // like `----` or `---yaml` is a `\n---` *prefix* but not the fence, and must
  // not truncate the frontmatter. Scan line-by-line from after the opener.
  const lines = text.split('\n')
  let fenceLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      fenceLine = i
      break
    }
  }
  if (fenceLine < 0) return null
  const fm = lines.slice(1, fenceLine).join('\n')
  // body starts after the closing fence line
  const body = lines.slice(fenceLine + 1).join('\n').replace(/^\n+/, '')
  return { fm, body }
}

/** Minimal flat-YAML reader for the frontmatter contract (scalars + one list). */
function readFrontmatter(fm: string): RawFrontmatter {
  const out: RawFrontmatter = { unknownFields: [], duplicateFields: [] }
  const seen = new Set<string>()
  const lines = fm.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    // List items belong to the most recent `key:` with no inline value.
    const kv = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!
    const value = kv[2]!
    if (!REQUIRED_FIELDS.includes(key as typeof REQUIRED_FIELDS[number])) {
      out.unknownFields.push(key)
      continue
    }
    if (seen.has(key)) out.duplicateFields.push(key)
    seen.add(key)
    if (key === 'triggers') {
      const items: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const lj = lines[j]!
        // A blank line within the list is skipped, not a terminator — items
        // listed after it still belong to the trigger list. A non-blank,
        // non-list line ends the list.
        if (lj.trim() === '') {
          i = j
          continue
        }
        const m = /^\s*-\s+(.*)$/.exec(lj)
        if (!m) break
        items.push(m[1]!.trim())
        i = j
      }
      out.triggers = items
    } else if (key === 'version') {
      if (value !== '') out.version = Number(value)
    } else if (key === 'name') {
      out.name = value
    } else if (key === 'description') {
      out.description = value
    } else if (key === 'provenance') {
      out.provenance = value
    }
  }
  return out
}

export function parseSkillDocument(raw: string): ParseResult {
  const split = splitFrontmatter(raw)
  if (!split) {
    return { ok: false, errors: [{ kind: 'malformed_frontmatter', detail: 'missing or unterminated --- fence' }] }
  }
  const rf = readFrontmatter(split.fm)
  const errors: ParseError[] = []

  for (const field of rf.unknownFields) errors.push({ kind: 'prohibited_authority_field', field })
  if (rf.duplicateFields.length > 0) {
    errors.push({ kind: 'malformed_frontmatter', detail: `duplicate fields: ${rf.duplicateFields.join(',')}` })
  }

  // Required-field presence (§9 AC-06-2).
  for (const field of REQUIRED_FIELDS) {
    const present =
      field === 'triggers'
        ? Array.isArray(rf.triggers) && rf.triggers.length > 0
        : rf[field] !== undefined && rf[field] !== ''
    if (!present) errors.push({ kind: 'missing_field', field })
  }

  // description ≤ 60 chars (§4.1, AC-06-1) — reported independently so an
  // over-long description is caught even when all fields are present.
  if (typeof rf.description === 'string' && rf.description.length > 60) {
    errors.push({ kind: 'description_too_long', length: rf.description.length })
  }
  if (rf.triggers?.some(trigger => trigger.trim().length === 0)) errors.push({ kind: 'empty_trigger' })
  // name format /^[a-z0-9][a-z0-9-]*$/ (§4.1).
  if (typeof rf.name === 'string' && rf.name !== '' && !NAME_RE.test(rf.name)) {
    errors.push({ kind: 'invalid_name_format', name: rf.name })
  }
  // provenance enum + version numeric.
  if (typeof rf.provenance === 'string' && rf.provenance !== '' && !VALID_PROVENANCE.has(rf.provenance)) {
    errors.push({ kind: 'malformed_frontmatter', detail: `invalid provenance '${rf.provenance}'` })
  }
  if (rf.version !== undefined && (Number.isNaN(rf.version) || !Number.isFinite(rf.version))) {
    errors.push({ kind: 'malformed_frontmatter', detail: 'version is not a number' })
  }

  if (errors.length > 0) return { ok: false, errors }

  const frontmatter: SkillFrontmatter = {
    name: rf.name!,
    description: rf.description!,
    version: rf.version!,
    provenance: rf.provenance as Provenance,
    triggers: rf.triggers!,
  }
  return {
    ok: true,
    skill: {
      frontmatter,
      body: split.body,
      rawBytes: new TextEncoder().encode(raw),
    },
  }
}

// ---------------------------------------------------------------------------
// Deterministic validators (§6, §5.2). All four run in code, 100%; the AND of
// the four (`ok`) gates a candidate before the judge (Nightly 10) sees it.
// ---------------------------------------------------------------------------

const VERIFICATION_HEADING = /(^|\n)##\s+verification\b/i

/** refs_exist: a candidate may not reference a path/tool that does not exist. */
function checkRefsExist(body: string): boolean {
  // Heuristic deterministic check: local relative refs (`./…`, `../…`) and
  // `Requires:` declarations must resolve. In this pure-core build there is no
  // skill/tool registry on disk, so any local relative ref is treated as
  // dangling (fail-closed) — matching AC-06-8's `./nonexistent-tool.sh`.
  return !/(^|\s)\.{1,2}\/\S+/.test(body)
}

/**
 * no_constitution_conflict: a candidate body may not assert a directive that
 * contradicts the constitution (e.g. an unconditional always/never policy that
 * would override Safety's HARD_DENY / autonomy gradient). Deterministic phrase
 * set, not a model call (§8 OWASP-LLM01 mitigation).
 */
const CONSTITUTION_CONFLICT_PATTERNS: readonly RegExp[] = [
  /\balways\s+deny\s+all\b/i,
  /\bdeny\s+all\s+requests\s+unconditionally\b/i,
  /\bignore\s+(?:the\s+)?constitution\b/i,
  /\bdisable\s+(?:all\s+)?safety\b/i,
  /\bbypass\s+hard[_-]?deny\b/i,
]
function checkNoConstitutionConflict(body: string): boolean {
  return !CONSTITUTION_CONFLICT_PATTERNS.some((p) => p.test(body))
}

function checkHasVerificationSection(body: string): boolean {
  return VERIFICATION_HEADING.test('\n' + body)
}

// ---------------------------------------------------------------------------
// Negative-skill / failure-classification model (§4.4, §5.4, ADR-0025).
// ---------------------------------------------------------------------------

const NEGATIVE_THRESHOLD = 3 // N ≥ 3 distinct sessions of permanent failures.

interface PermanentTally {
  target: string
  sessionIds: Set<string>
}

// ---------------------------------------------------------------------------
// Internal staged record. The StagedSkill surface deliberately carries NO
// `approved`/`trusted` field (AC-06-16): the approved flag lives only in this
// private store and is set solely by the deterministic promote() handler.
// ---------------------------------------------------------------------------

interface InternalStaged extends StagedSkill {
  frontmatter: SkillFrontmatter
  body: string
  /** Set true ONLY by promote(), bound to a real human tap (ADR-0029 #1/#2). */
  approved: boolean
  /** Commit + version recorded at promote time. */
  promotedVersion: number | null
  revision: SkillRevisionIdentity
  actionHash: string
  externalCommit: { commit: string; humanTapAuditId: string; approvedAt?: string } | null
  commitUncertain: boolean
  approvalPreview: {
    actionHash: string
    traceEvidence: SkillTraceEvidence
    stepUpRequired: boolean
  } | null
}

interface PromotedSkill {
  name: string
  description: string
  body: string
  version: number
  provenance: Provenance
  artifactHash: string
  fullText: string
}

function computeSkillDiff(base: string | null, candidate: string): string {
  const before = base === null ? [] : base.replace(/\r\n/g, '\n').split('\n')
  const after = candidate.replace(/\r\n/g, '\n').split('\n')
  return ['--- base', '+++ candidate', ...before.map(line => `-${line}`), ...after.map(line => `+${line}`)].join('\n')
}

/** Destructive operations in a skill BODY that force step-up (§8 ADR-0029 #5). */
const DESTRUCTIVE_BODY_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?/i, // rm -rf / rm -fr / rm -r ...
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\s+(?:--force|-f)\b/i,
  /\bforce[- ]?push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\b(?:mkfs|dd\s+if=|shred)\b/i,
  /\b(?:drop|wipe|destroy|delete\s+all|format)\b/i,
]

/**
 * Detect a permanence/irreversible-flagged candidate (§5.3, §8 ADR-0029 #5).
 * Step-up is required to promote one. The flag is derived deterministically
 * from the frontmatter AND the body, never from a model-set trust field — a
 * benign-titled skill whose body performs a destructive operation must not
 * bypass step-up.
 */
function isIrreversible(fm: SkillFrontmatter, body: string): boolean {
  const hay = `${fm.name} ${fm.description}`.toLowerCase()
  if (/\b(irreversible|permanence|permanent|wipe|destroy|delete\s+all)\b/.test(hay)) return true
  return DESTRUCTIVE_BODY_PATTERNS.some((p) => p.test(body))
}

export function makeSkillRegistry(deps: SkillsDeps): Skills {
  // Promoted (active+trusted) skills, keyed by name. Cold start: empty (§7).
  const promoted = new Map<string, PromotedSkill>()
  // Staged candidates awaiting human approval.
  const staged = new Map<string, InternalStaged>()
  // Distinct-session permanent-failure tallies, keyed by target (§4.4).
  const tallies = new Map<string, PermanentTally>()
  // Active negative-skill records (bi-temporal; probe sets invalid_at) (§4.4).
  const negatives = new Map<string, NegativeSkillRecord>()
  // Trigger phrases for promoted skills, kept OUT of the byte-stable menu line
  // (§5.1, ADR-0019). Per-instance; matchTriggers resolves against this.
  const promotedTriggers = new Map<string, string[]>()
  // A synchronous claim protects one stage across async trace/git/audit awaits.
  // Unlike the old delete-before-await path, failures leave the candidate staged.
  const promoting = new Set<string>()
  // A second reservation is keyed by active skill identity, not stageId. It is
  // acquired synchronously before nonce/git/audit so sibling stages derived
  // from the same base cannot both create external effects.
  const skillReservations = new Map<string, {
    stageId: string
    baseVersion: number | null
    baseArtifactHash: string | null
  }>()

  /** Telemetry emit is fail-open: it must never block serving (§7, AC-06-27). */
  const emit = (event: string, payload: unknown): void => {
    try {
      deps.observability.emit(event, payload)
    } catch {
      /* sidecar unavailable — serving is never blocked on telemetry */
    }
  }

  const activeRevisionMatches = (record: InternalStaged): boolean => {
    const current = promoted.get(record.revision.name)
    if (record.revision.baseVersion === null || record.revision.baseArtifactHash === null) {
      return current === undefined && record.revision.baseVersion === null && record.revision.baseArtifactHash === null
    }
    return current?.version === record.revision.baseVersion &&
      current.artifactHash === record.revision.baseArtifactHash
  }

  const reserveSkill = (record: InternalStaged): boolean => {
    const existing = skillReservations.get(record.revision.name)
    if (existing) {
      return existing.stageId === record.stageId &&
        existing.baseVersion === record.revision.baseVersion &&
        existing.baseArtifactHash === record.revision.baseArtifactHash
    }
    skillReservations.set(record.revision.name, {
      stageId: record.stageId,
      baseVersion: record.revision.baseVersion,
      baseArtifactHash: record.revision.baseArtifactHash,
    })
    return true
  }

  const releaseSkill = (record: InternalStaged): void => {
    const existing = skillReservations.get(record.revision.name)
    if (existing?.stageId === record.stageId) skillReservations.delete(record.revision.name)
  }

  return {
    // ---- resident path (deterministic, every prompt assembly) ----

    menu(): MenuEntry[] {
      // Active + TRUSTED only. A staged-but-unpromoted (untrusted) skill never
      // appears here (AC-06-4, AC-06-11). Body text is never included — only
      // the byte-stable name+description menu line (§4.1, ADR-0019).
      const entries: MenuEntry[] = []
      for (const skill of promoted.values()) {
        entries.push({ name: skill.name, description: skill.description })
      }
      return entries
    },

    matchTriggers(request: string): string[] {
      // Deterministic phrase match against TRUSTED skills only — an unverified
      // recipe can never fire (§5.1). Case-insensitive substring on triggers.
      const q = request.toLowerCase()
      const names: string[] = []
      for (const skill of promoted.values()) {
        const triggers = promotedTriggers.get(skill.name) ?? []
        if (triggers.some((t) => q.includes(t.toLowerCase()))) {
          names.push(skill.name)
        }
      }
      return names
    },

    async loadBody(name: string): Promise<string> {
      // Lazy body load into working context, NOT the prefix (§5.1, AC-06-6).
      // Serving is never blocked on telemetry (AC-06-27): emit is fail-open.
      const skill = promoted.get(name)
      if (!skill) return ''
      emit('skill.loaded', { name })
      return skill.body
    },

    // ---- authoring path ----

    parse(raw: string): ParseResult {
      return parseSkillDocument(raw)
    },

    async validate(candidate: ParsedSkill): Promise<ValidationReport> {
      const body = candidate.body
      const refs_exist = checkRefsExist(body)
      const no_constitution_conflict = checkNoConstitutionConflict(body)
      const has_verification_section = checkHasVerificationSection(body)

      // dry_run_ok: the body must run in Safety's network-none sandbox
      // (§6, ADR-0012). The sandbox is owned by Safety; Skills calls into it.
      // Fail-closed two ways (§7, AC-06-9): if invoking the sandbox fails
      // (unavailable) OR the sandbox runs the body and REJECTS it by resolving
      // `{ok:false}`, dry_run_ok is false and the candidate is not staged. We
      // await the verdict — same pattern as probe() (OWASP-LLM01 mitigation).
      let dry_run_ok = false
      try {
        const result = await deps.sandbox.dryRun(body)
        dry_run_ok = result.ok
      } catch {
        dry_run_ok = false
      }

      const ok = refs_exist && no_constitution_conflict && dry_run_ok && has_verification_section
      return { refs_exist, no_constitution_conflict, dry_run_ok, has_verification_section, ok }
    },

    stage(candidate: ParsedSkill, ctx: TriggerContext): StagedSkill {
      // Hash-pin the exact candidate bytes at stage time (ADR-0029 #3).
      const artifactHash = hashBytes(candidate.rawBytes)
      const stageId = `stage-${randomUUID()}`
      const fullText = new TextDecoder().decode(candidate.rawBytes)
      const parsed = parseSkillDocument(fullText)
      if (!parsed.ok) {
        const authority = parsed.errors.some(error => error.kind === 'prohibited_authority_field')
        throw new SkillStageError(authority ? 'PROHIBITED_SKILL_AUTHORITY_FIELD' : 'INVALID_SKILL_STAGE')
      }
      if (parsed.skill.body !== candidate.body ||
        JSON.stringify(parsed.skill.frontmatter) !== JSON.stringify(candidate.frontmatter)) {
        throw new SkillStageError('INVALID_SKILL_STAGE')
      }
      const canonical = parsed.skill
      const prior = promoted.get(canonical.frontmatter.name)
      const diff = computeSkillDiff(prior?.fullText ?? null, fullText)
      const revision: SkillRevisionIdentity = {
        name: canonical.frontmatter.name,
        baseVersion: prior?.version ?? null,
        baseArtifactHash: prior?.artifactHash ?? null,
        candidateVersion: canonical.frontmatter.version,
        artifactHash,
      }
      const actionHash = computeSkillActionHash({
        stageId,
        name: revision.name,
        candidateVersion: revision.candidateVersion,
        artifactHash,
        baseVersion: revision.baseVersion,
        baseArtifactHash: revision.baseArtifactHash,
        diffHash: hashBytes(new TextEncoder().encode(diff)),
        provenance: canonical.frontmatter.provenance,
        riskClassification: isIrreversible(canonical.frontmatter, canonical.body) ? 'irreversible' : 'reversible',
        stepUpRequired: isIrreversible(canonical.frontmatter, canonical.body),
        touchedPaths: [`skills/${canonical.frontmatter.name}/SKILL.md`],
      })

      // trace_verified is set ONLY from a real Observability trace, never a
      // self-report (ADR-0017, AC-06-13). At stage time we have not yet run the
      // verification section against real traces, so it stays false until
      // promote() consults Observability. The staged artifact carries NO
      // approved/trusted field (AC-06-16) — TypeScript + this record enforce it.
      const record: InternalStaged = {
        stageId,
        artifactHash,
        diff,
        triggerContext: { request: ctx.request, sessionId: ctx.sessionId },
        traceVerified: false,
        provenance: canonical.frontmatter.provenance,
        fullText,
        frontmatter: canonical.frontmatter,
        body: canonical.body,
        approved: false,
        promotedVersion: null,
        revision,
        actionHash,
        externalCommit: null,
        commitUncertain: false,
        approvalPreview: null,
      }
      staged.set(stageId, record)
      emit('skill.staged', { stageId, name: canonical.frontmatter.name, provenance: record.provenance })

      // Return only the public StagedSkill surface.
      return {
        stageId,
        artifactHash,
        diff: record.diff,
        triggerContext: record.triggerContext,
        traceVerified: record.traceVerified,
        provenance: record.provenance,
        fullText,
        revision: { ...revision },
        actionHash,
      }
    },

    reviewPayload(stageId: string): ReviewCard {
      const record = staged.get(stageId)
      if (!record) throw new Error(`skills.reviewPayload: unknown stageId '${stageId}'`)
      // Full text + diff + triggering context (§2, AC-06-15).
      return {
        stageId: record.stageId,
        fullText: record.fullText,
        diff: record.diff,
        triggerContext: record.triggerContext,
      }
    },

    async approvalPreview(stageId: string): Promise<SkillApprovalPreview> {
      const record = staged.get(stageId)
      if (!record) throw new Error(`skills.approvalPreview: unknown stageId '${stageId}'`)
      if (!deps.observability.passingTraceEvidence) {
        throw new Error('skills.approvalPreview: exact trace evidence unavailable')
      }
      const traceEvidence = await deps.observability.passingTraceEvidence(record.revision)
      if (!traceEvidence || traceEvidence.skillName !== record.revision.name ||
        traceEvidence.artifactHash !== record.revision.artifactHash ||
        traceEvidence.revision !== record.revision.candidateVersion ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(traceEvidence.evidenceId) ||
        !exactIso(traceEvidence.verifiedAt)) {
        throw new Error('skills.approvalPreview: invalid trace evidence')
      }
      const stepUpRequired = isIrreversible(record.frontmatter, record.body)
      const actionHash = computeSkillActionHash({
        stageId: record.stageId,
        name: record.revision.name,
        baseVersion: record.revision.baseVersion,
        baseArtifactHash: record.revision.baseArtifactHash,
        candidateVersion: record.revision.candidateVersion,
        artifactHash: record.revision.artifactHash,
        diffHash: hashBytes(new TextEncoder().encode(record.diff)),
        provenance: record.provenance,
        riskClassification: stepUpRequired ? 'irreversible' : 'reversible',
        stepUpRequired,
        touchedPaths: [`skills/${record.revision.name}/SKILL.md`],
        traceEvidence,
      })
      record.actionHash = actionHash
      record.approvalPreview = { actionHash, traceEvidence: { ...traceEvidence }, stepUpRequired }
      return {
        stageId: record.stageId,
        fullText: record.fullText,
        diff: record.diff,
        triggerContext: { ...record.triggerContext },
        actionHash,
        traceEvidence: { ...traceEvidence },
        stepUpRequired,
      }
    },

    // ---- promotion path (ADR-0029) ----

    async promote(stageId: string, approval: ApprovalVerdict): Promise<PromoteResult> {
      const record = staged.get(stageId)
      // No pending action for this stage id (§7, AC-06-18 alt reason).
      if (!record) return { ok: false, reason: 'no_pending_action' }
      if (approval.stageId !== stageId) return { ok: false, reason: 'approval_mismatch' }
      const exactPreview = record.approvalPreview
      if (!exactPreview && deps.unsafeLegacyPromotion !== true) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      if (approval.actionHash !== record.actionHash) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      if (exactPreview && (approval.traceEvidenceId !== exactPreview.traceEvidence.evidenceId ||
        approval.traceVerifiedAt !== exactPreview.traceEvidence.verifiedAt || !exactIso(approval.approvedAt) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approval.humanTapAuditId))) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      if (exactPreview && !deps.promotionAudit) return { ok: false, reason: 'audit_failed' }

      // TOCTOU close: re-hash the staged bytes and require equality with the
      // human-approved hash before anything else (ADR-0029 #3, AC-06-17).
      const currentHash = hashBytes(new TextEncoder().encode(record.fullText))
      if (approval.artifactHash !== currentHash) {
        return { ok: false, reason: 'hash_mismatch' }
      }

      // Trace-based trust: promotion requires a real passing trace on record,
      // never a self-report (ADR-0017, AC-06-12/AC-06-13). Observability owns
      // the trace journal; Skills only reads it.
      let traceEvidence: SkillTraceEvidence | null = null
      if (deps.observability.passingTraceEvidence) {
        traceEvidence = await deps.observability.passingTraceEvidence(record.revision)
        if (!traceEvidence) return { ok: false, reason: 'not_trace_verified' }
        if (traceEvidence.skillName !== record.revision.name ||
          traceEvidence.artifactHash !== record.revision.artifactHash ||
          traceEvidence.revision !== record.revision.candidateVersion ||
          (exactPreview !== null && (traceEvidence.evidenceId !== exactPreview.traceEvidence.evidenceId ||
            traceEvidence.verifiedAt !== exactPreview.traceEvidence.verifiedAt)) ||
          (approval.traceEvidenceId !== undefined && approval.traceEvidenceId !== traceEvidence.evidenceId)) {
          return { ok: false, reason: 'trace_evidence_mismatch' }
        }
      } else if (!await deps.observability.hasPassingTrace(record.frontmatter.name)) {
        return { ok: false, reason: 'not_trace_verified' }
      }

      // Step-up second factor for permanence/irreversible items (ADR-0029 #5,
      // AC-06-19). A plain tap is insufficient for these.
      if (isIrreversible(record.frontmatter, record.body) && !approval.stepUpSatisfied) {
        return { ok: false, reason: 'stepup_missing' }
      }

      const expectedVersion = (record.revision.baseVersion ?? 0) + 1
      if (record.revision.candidateVersion !== expectedVersion || !activeRevisionMatches(record)) {
        return { ok: false, reason: 'revision_conflict' }
      }

      if (record.commitUncertain) return { ok: false, reason: 'recovery_required' }
      if (record.externalCommit && record.externalCommit.humanTapAuditId !== approval.humanTapAuditId) {
        return { ok: false, reason: 'approval_mismatch' }
      }
      if (exactPreview && record.externalCommit?.approvedAt !== undefined &&
        record.externalCommit.approvedAt !== approval.approvedAt) {
        return { ok: false, reason: 'approval_mismatch' }
      }

      // Claim only after every async/read-only gate. The record remains present
      // through git and audit failure so a fresh approval can retry safely.
      if (promoting.has(stageId) || staged.get(stageId) !== record) {
        return { ok: false, reason: 'no_pending_action' }
      }
      if (!reserveSkill(record)) return { ok: false, reason: 'revision_conflict' }
      // Close the gap between the earlier read-only validation and the
      // synchronous reservation before consuming a nonce or touching git.
      if (!activeRevisionMatches(record)) {
        releaseSkill(record)
        return { ok: false, reason: 'revision_conflict' }
      }
      if (!record.externalCommit) {
        const nonceAccepted = deps.nonceStore.consumeAction
          ? deps.nonceStore.consumeAction(approval.nonce, record.actionHash)
          : deps.nonceStore.consume(approval.nonce, stageId)
        if (!nonceAccepted) {
          releaseSkill(record)
          return { ok: false, reason: 'replayed_nonce' }
        }
      }
      promoting.add(stageId)

      // All gates passed. Commit to prod git with a version bump, binding the
      // human tap to the commit (ADR-0029 #2, AC-06-14/AC-06-20). The approved
      // flag is set ONLY here, in code, bound to a real human action.
      const version = record.revision.candidateVersion
      const filename = `skills/${record.frontmatter.name}/SKILL.md`
      let commit = record.externalCommit?.commit
      if (!commit) {
        try {
          commit = await deps.git.commit(
            `skill: promote ${record.frontmatter.name} v${version} (tap ${approval.humanTapAuditId})`,
            { [filename]: record.fullText },
          )
          record.externalCommit = {
            commit,
            humanTapAuditId: approval.humanTapAuditId,
            ...(approval.approvedAt === undefined ? {} : { approvedAt: approval.approvedAt }),
          }
        } catch {
          record.commitUncertain = true
          promoting.delete(stageId)
          // Keep the per-skill reservation: the external result is ambiguous,
          // so a sibling must not attempt another write.
          return { ok: false, reason: 'recovery_required' }
        }
      }

      // Re-check after the external await and before writing an audit row for
      // a revision that a sibling may already have superseded.
      if (!activeRevisionMatches(record)) {
        promoting.delete(stageId)
        releaseSkill(record)
        return { ok: false, reason: 'revision_conflict' }
      }

      const audit = {
        stageId,
        actionHash: record.actionHash,
        artifactHash: record.artifactHash,
        version,
        commit,
        humanTapAuditId: approval.humanTapAuditId,
        ...(record.externalCommit?.approvedAt === undefined ? {} : { approvedAt: record.externalCommit.approvedAt }),
      }
      if (deps.promotionAudit) {
        try {
          await deps.promotionAudit.record(audit)
        } catch {
          promoting.delete(stageId)
          // The external commit is known. Keep ownership for same-stage
          // recover-forward and reject all sibling writers until publication.
          return { ok: false, reason: 'audit_failed' }
        }
      }

      // Exact CAS immediately before the local active pointer moves. Another
      // sibling stage may have promoted the same name while git/audit awaited.
      if (!activeRevisionMatches(record)) {
        promoting.delete(stageId)
        releaseSkill(record)
        return { ok: false, reason: 'revision_conflict' }
      }

      record.approved = true
      record.promotedVersion = version
      promoted.set(record.frontmatter.name, {
        name: record.frontmatter.name,
        description: record.frontmatter.description,
        body: record.body,
        version,
        provenance: record.provenance,
        artifactHash: record.artifactHash,
        fullText: record.fullText,
      })
      promotedTriggers.set(record.frontmatter.name, record.frontmatter.triggers)
      staged.delete(stageId)
      promoting.delete(stageId)
      releaseSkill(record)

      // tap→commit audit binding (AC-06-20) — emitted to Observability 12.
      emit('skill.promoted', {
        name: record.frontmatter.name,
        commit,
        version,
        humanTapAuditId: approval.humanTapAuditId,
        actionHash: record.actionHash,
        traceEvidenceId: traceEvidence?.evidenceId,
      })

      return { ok: true, commit, version }
    },

    // ---- failure / negative-skill path (ADR-0025) ----

    recordFailure(_name: string | null, f: FailureSignal): void {
      // Every signal produces a journal note (AC-06-21). Transient signals and
      // sub-threshold permanent signals are notes only — never a skill (§4.5).
      emit('skill.failure_recorded', { target: f.target, class: f.class, sessionId: f.sessionId, detail: f.detail })

      if (f.class !== 'permanent') return

      // Distinct-session permanent tally, keyed by target (§4.4). One session
      // cannot mint a negative skill (AC-06-22): the Set dedupes session ids.
      let tally = tallies.get(f.target)
      if (!tally) {
        tally = { target: f.target, sessionIds: new Set<string>() }
        tallies.set(f.target, tally)
      }
      tally.sessionIds.add(f.sessionId)

      // Below threshold → transient note only, no negative skill (AC-06-22).
      if (tally.sessionIds.size < NEGATIVE_THRESHOLD) return
      // Already fossilized and still active → do not re-draft.
      const existing = negatives.get(f.target)
      if (existing && existing.invalid_at === null) return

      // N ≥ 3 distinct sessions → draft a negative-skill candidate that enters
      // the staging path (AC-06-23). It is advisory only, never a HARD_DENY
      // (AC-06-24): priority is lowered, the capability stays callable.
      const record: NegativeSkillRecord = {
        target: f.target,
        failureCount: tally.sessionIds.size,
        sessionIds: [...tally.sessionIds],
        valid_at: new Date().toISOString(),
        invalid_at: null,
        advisory: true,
      }
      negatives.set(f.target, record)
      emit('skill.negative_created', record)
    },

    async probe(): Promise<ProbeReport> {
      // Nightly un-fossilize re-test (§5.4, AC-06-25). For each active negative
      // skill, re-test the failed strategy in the sandbox. First success sets
      // invalid_at (NOT a hard delete) and emits an un-fossilize diff card.
      const unfossilized: string[] = []
      const stillFailing: string[] = []
      const checkedAt = new Date().toISOString()

      for (const [target, record] of negatives) {
        if (record.invalid_at !== null) continue
        let ok = false
        try {
          const result = await deps.sandbox.dryRun(`probe: ${target}`)
          ok = result.ok
        } catch {
          ok = false
        }
        if (ok) {
          // Bi-temporal: set invalid_at, keep the row (recoverable from git).
          record.invalid_at = checkedAt
          unfossilized.push(target)
          // Clear the tally so a future outage starts a fresh distinct-session
          // count (hysteresis: a flaky tool does not immediately re-fossilize).
          tallies.delete(target)
          emit('skill.unfossilized', { name: target, invalid_at: checkedAt })
        } else {
          stillFailing.push(target)
        }
      }

      return { unfossilized, stillFailing, checkedAt }
    },
  }
}

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
} from './types.js'

// ---------------------------------------------------------------------------
// Hashing — SHA-256 over the exact candidate bytes (§4.2, ADR-0029 #3).
// rawBytes is the byte-stable artifact; the pin is taken at stage() time and
// re-checked at promote() to close the TOCTOU window.
// ---------------------------------------------------------------------------

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
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
}

/** Split the leading `---`…`---` block from the body. null = no frontmatter. */
function splitFrontmatter(raw: string): { fm: string; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end < 0) return null
  const fm = text.slice(4, end)
  // body starts after the closing fence line
  const afterFence = text.indexOf('\n', end + 1)
  const body = afterFence < 0 ? '' : text.slice(afterFence + 1).replace(/^\n+/, '')
  return { fm, body }
}

/** Minimal flat-YAML reader for the frontmatter contract (scalars + one list). */
function readFrontmatter(fm: string): RawFrontmatter {
  const out: RawFrontmatter = {}
  const lines = fm.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    // List items belong to the most recent `key:` with no inline value.
    const kv = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!
    const value = kv[2]!
    if (key === 'triggers') {
      const items: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const m = /^\s*-\s+(.*)$/.exec(lines[j]!)
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

function parseSkill(raw: string): ParseResult {
  const split = splitFrontmatter(raw)
  if (!split) {
    return { ok: false, errors: [{ kind: 'malformed_frontmatter', detail: 'missing or unterminated --- fence' }] }
  }
  const rf = readFrontmatter(split.fm)
  const errors: ParseError[] = []

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
}

interface PromotedSkill {
  name: string
  description: string
  body: string
  version: number
  provenance: Provenance
}

/**
 * Detect a permanence/irreversible-flagged candidate (§5.3, ADR-0029 #5).
 * Step-up is required to promote one. The flag is derived deterministically
 * from the frontmatter, never from a model-set trust field.
 */
function isIrreversible(fm: SkillFrontmatter): boolean {
  const hay = `${fm.name} ${fm.description}`.toLowerCase()
  return /\b(irreversible|permanence|permanent|wipe|destroy|delete\s+all)\b/.test(hay)
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

  /** Telemetry emit is fail-open: it must never block serving (§7, AC-06-27). */
  const emit = (event: string, payload: unknown): void => {
    try {
      deps.observability.emit(event, payload)
    } catch {
      /* sidecar unavailable — serving is never blocked on telemetry */
    }
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
      return parseSkill(raw)
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

      // trace_verified is set ONLY from a real Observability trace, never a
      // self-report (ADR-0017, AC-06-13). At stage time we have not yet run the
      // verification section against real traces, so it stays false until
      // promote() consults Observability. The staged artifact carries NO
      // approved/trusted field (AC-06-16) — TypeScript + this record enforce it.
      const record: InternalStaged = {
        stageId,
        artifactHash,
        diff: '',
        triggerContext: { request: ctx.request, sessionId: ctx.sessionId },
        traceVerified: false,
        provenance: candidate.frontmatter.provenance,
        fullText,
        frontmatter: candidate.frontmatter,
        body: candidate.body,
        approved: false,
        promotedVersion: null,
      }
      staged.set(stageId, record)
      emit('skill.staged', { stageId, name: candidate.frontmatter.name, provenance: record.provenance })

      // Return only the public StagedSkill surface.
      return {
        stageId,
        artifactHash,
        diff: record.diff,
        triggerContext: record.triggerContext,
        traceVerified: record.traceVerified,
        provenance: record.provenance,
        fullText,
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

    // ---- promotion path (ADR-0029) ----

    async promote(stageId: string, approval: ApprovalVerdict): Promise<PromoteResult> {
      const record = staged.get(stageId)
      // No pending action for this stage id (§7, AC-06-18 alt reason).
      if (!record) return { ok: false, reason: 'no_pending_action' }

      // TOCTOU close: re-hash the staged bytes and require equality with the
      // human-approved hash before anything else (ADR-0029 #3, AC-06-17).
      const currentHash = hashBytes(new TextEncoder().encode(record.fullText))
      if (approval.artifactHash !== currentHash) {
        return { ok: false, reason: 'hash_mismatch' }
      }

      // Single-use, per-action nonce (ADR-0029 #4, AC-06-18). A replayed/stale
      // nonce is rejected and nothing is committed.
      if (!deps.nonceStore.consume(approval.nonce, stageId)) {
        return { ok: false, reason: 'replayed_nonce' }
      }

      // TOCTOU close on the staged record itself: claim it synchronously, before
      // the first await. The NonceStore is keyed per-nonce, so two distinct valid
      // nonces for the same stageId would otherwise both pass the consume check
      // and race to a double git.commit(). Deleting here (no await between get and
      // delete) makes a concurrent promote on the same stageId see no record and
      // return no_pending_action — exactly one promotion wins (ADR-0029 #4).
      staged.delete(stageId)

      // Trace-based trust: promotion requires a real passing trace on record,
      // never a self-report (ADR-0017, AC-06-12/AC-06-13). Observability owns
      // the trace journal; Skills only reads it.
      const traceVerified = await deps.observability.hasPassingTrace(record.frontmatter.name)
      if (!traceVerified) {
        return { ok: false, reason: 'not_trace_verified' }
      }

      // Step-up second factor for permanence/irreversible items (ADR-0029 #5,
      // AC-06-19). A plain tap is insufficient for these.
      if (isIrreversible(record.frontmatter) && !approval.stepUpSatisfied) {
        return { ok: false, reason: 'stepup_missing' }
      }

      // All gates passed. Commit to prod git with a version bump, binding the
      // human tap to the commit (ADR-0029 #2, AC-06-14/AC-06-20). The approved
      // flag is set ONLY here, in code, bound to a real human action.
      const prior = promoted.get(record.frontmatter.name)
      const version = (prior?.version ?? record.frontmatter.version - 1) + 1
      const filename = `skills/${record.frontmatter.name}/SKILL.md`
      const commit = await deps.git.commit(
        `skill: promote ${record.frontmatter.name} v${version} (tap ${approval.humanTapAuditId})`,
        { [filename]: record.fullText },
      )

      record.approved = true
      record.promotedVersion = version
      promoted.set(record.frontmatter.name, {
        name: record.frontmatter.name,
        description: record.frontmatter.description,
        body: record.body,
        version,
        provenance: record.provenance,
      })
      promotedTriggers.set(record.frontmatter.name, record.frontmatter.triggers)
      // (staged record already removed above, before the first await — TOCTOU close.)

      // tap→commit audit binding (AC-06-20) — emitted to Observability 12.
      emit('skill.promoted', {
        name: record.frontmatter.name,
        commit,
        version,
        humanTapAuditId: approval.humanTapAuditId,
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

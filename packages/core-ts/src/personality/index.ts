// Component 08 — Personality (docs/specs/08-personality.md)
//
// Deterministic identity: SOUL.md persona + ordered constitution.md with exactly
// one veto principle, assembled into a byte-stable IdentityPayload (ADR-0019
// prefix segments 1-2) and re-seeded verbatim across generations and provider
// failovers (finding 3, ADR-0005 / ADR-0018). Parsing, ordering, validation, and
// hashing are 100% deterministic code (§5.1); the model performs the personality,
// the harness guarantees it is present, ordered, and unchanged.

export type {
  AntiDegradationGuard,
  Constitution,
  DegradationCheckContext,
  DegradationCheckResult,
  HumanConfirmation,
  IdentityPayload,
  ModeResult,
  Personality,
  PersonalityLoader,
  PersonalityConfig,
  Precedence,
  Principle,
  ProposedAction,
  Soul,
  ValidationReport,
  VetoVerdict,
} from './types.js'

// Re-export error classes (they are values, not just types)
export { ConstitutionError, SoulMissing } from './types.js'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  Constitution,
  DegradationCheckContext,
  DegradationCheckResult,
  HumanConfirmation,
  IdentityPayload,
  ModeResult,
  Personality,
  PersonalityLoader,
  Principle,
  ProposedAction,
  Soul,
  ValidationReport,
  VetoVerdict,
} from './types.js'
import { ConstitutionError, SoulMissing } from './types.js'

// ---------------------------------------------------------------------------
// Identity event seam (Observability 12, §3 "Events emitted").
// Structurally compatible with the testing EffectVerifier's RecordedEffect so
// tests can pass `ev.record` directly; production wires the append-only journal.
// ---------------------------------------------------------------------------

export interface IdentityEvent {
  kind: 'tool-call'
  target: string                  // 'identity.loaded' | 'identity.reseeded' | 'veto-check' | 'veto.blocked' | 'mode.changed'
  payload?: unknown
}

export type IdentityEventRecorder = (event: IdentityEvent) => void

const noopRecord: IdentityEventRecorder = () => {}

/** SHA-256 over (constitution || soul) — the identity fingerprint (§4.3, ADR-0004). */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// constitution.md parsing (§4.2) — deterministic, no model call.
// Entries: "[N] (veto) text..." with indented continuation lines.
// ---------------------------------------------------------------------------

const PRINCIPLE_RE = /^\[(\d+)\]\s*(\(veto\)\s*)?(\S.*)$/

/** Stable id from the principle text: first four word tokens, /^[a-z0-9][a-z0-9-]*$/ (§3). */
function principleId(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0)
    .slice(0, 4)
  return tokens.length > 0 ? tokens.join('-') : 'principle'
}

/**
 * Parse constitution.md bytes into an ordered Constitution (§4.2).
 * Principles are sorted ascending by precedence at parse time (§3); structural
 * validity (total order, single veto) is judged by validateIdentity().
 * Throws ConstitutionError when no principle can be parsed at all.
 */
export function parseConstitution(raw: string): Constitution {
  const principles: Principle[] = []
  let current: Principle | null = null

  for (const line of raw.split('\n')) {
    const match = PRINCIPLE_RE.exec(line)
    if (match !== null) {
      current = {
        id: principleId(match[3] ?? ''),
        precedence: Number(match[1]),
        veto: match[2] !== undefined,
        text: (match[3] ?? '').trim(),
      }
      principles.push(current)
      continue
    }
    // Indented continuation lines extend the current principle's text.
    if (current !== null && /^\s+\S/.test(line) && !line.trimStart().startsWith('<!--')) {
      current.text += ' ' + line.trim()
    } else if (line.trim() === '') {
      current = null
    }
  }

  if (principles.length === 0) {
    throw new ConstitutionError(
      'ConstitutionError: constitution.md is unparseable — no "[N] text" principles found (§4.2)',
    )
  }

  // Stable ids must be unique: a colliding id silently shadows an earlier
  // principle (incl. vetoId resolution). Fail closed (§3, §5.1).
  const seenIds = new Set<string>()
  for (const p of principles) {
    if (seenIds.has(p.id)) {
      throw new ConstitutionError(
        `ConstitutionError: duplicate principle id "${p.id}" in constitution.md — ids must be unique, no silent shadowing (§3)`,
      )
    }
    seenIds.add(p.id)
  }

  // Sorted ascending by precedence at parse time (§3); the model never sees an
  // unordered bag and cannot "choose" a different precedence (§5.1).
  principles.sort((a, b) => a.precedence - b.precedence)

  const vetoes = principles.filter(p => p.veto)
  return {
    principles,
    vetoId: vetoes.length === 1 ? (vetoes[0] as Principle).id : '',
  }
}

/** Parse SOUL.md bytes (§4.1): raw persona text plus named register modes ("- name: body"). */
export function parseSoul(raw: string): Soul {
  const modes: Record<string, string> = {}
  const MODE_RE = /^-\s*([a-z][a-z0-9-]*):\s+(.+)$/
  for (const line of raw.split('\n')) {
    const match = MODE_RE.exec(line.trim())
    if (match !== null) {
      modes[match[1] as string] = (match[2] as string).trim()
    }
  }
  return { raw, modes }
}

/**
 * Load-time validation, fail-closed (§3, §5.1):
 *   unique_precedence — no two principles share a precedence (total order)
 *   exactly_one_veto  — exactly one veto === true, at the LOWEST precedence (§5.1)
 *   soul_present      — SOUL.md non-empty and parses
 */
export function validateIdentity(c: Constitution, s: Soul): ValidationReport {
  const precedences = c.principles.map(p => p.precedence)
  const unique_precedence =
    c.principles.length > 0 && new Set(precedences).size === precedences.length

  const vetoes = c.principles.filter(p => p.veto)
  const lowest = Math.min(...precedences)
  // §5.1: exactly one veto===true, lowest precedence — the veto always wins (§4.2 table).
  const exactly_one_veto =
    vetoes.length === 1 && (vetoes[0] as Principle).precedence === lowest

  const soul_present = s.raw.trim().length > 0

  return {
    unique_precedence,
    exactly_one_veto,
    soul_present,
    ok: unique_precedence && exactly_one_veto && soul_present,
  }
}

/** Fail-closed gate shared by the loader and the Personality factory (§5.1, §7). */
function assertValid(report: ValidationReport, where: string): void {
  if (!report.unique_precedence) {
    throw new ConstitutionError(
      `ConstitutionError: duplicate precedence in ${where} — no total order, the model could pick (§7, AC-08-5)`,
    )
  }
  if (!report.exactly_one_veto) {
    throw new ConstitutionError(
      `ConstitutionError: ${where} must mark exactly one veto principle at the lowest precedence (§7, AC-08-6)`,
    )
  }
  if (!report.soul_present) {
    throw new SoulMissing(
      `SoulMissing: SOUL.md absent or empty in ${where} — identity must not come from model weights (§7, AC-08-15)`,
    )
  }
}

// ---------------------------------------------------------------------------
// PersonalityLoader (§3 narrow waist: load / getActivePersona / checkDegradation)
// ---------------------------------------------------------------------------

export interface PersonalityLoaderDeps {
  /** Read a file as utf-8, returning null when absent. DI seam; defaults to node:fs. */
  readFile?: (path: string) => string | null
  /** Append-only journal sink (Observability 12); defaults to a no-op. */
  record?: IdentityEventRecorder
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function makePersonalityLoader(deps: PersonalityLoaderDeps = {}): PersonalityLoader {
  const readFile = deps.readFile ?? defaultReadFile
  const record = deps.record ?? noopRecord

  // Frozen per-path session snapshots (ADR-0019): the first successful load is
  // the session's identity; mid-session disk edits are ignored until the next
  // session's loadIdentity() (§7 "Mid-session edit", AC-08-17).
  const snapshots = new Map<string, IdentityPayload>()

  return {
    async load(path: string): Promise<IdentityPayload> {
      const frozen = snapshots.get(path)
      if (frozen !== undefined) {
        return frozen
      }

      // Constitution first: a harness with no enforceable veto must not run (§5.1).
      const constitutionRaw = readFile(join(path, 'constitution.md'))
      if (constitutionRaw === null || constitutionRaw.trim() === '') {
        throw new ConstitutionError(
          `ConstitutionError: constitution.md absent or empty at ${path} — fail closed, no session (§7 cold start)`,
        )
      }
      const constitution = parseConstitution(constitutionRaw)

      const soulRaw = readFile(join(path, 'SOUL.md'))
      const soul = parseSoul(soulRaw ?? '')
      const report = validateIdentity(constitution, soul)
      if (soulRaw === null || !report.soul_present) {
        throw new SoulMissing(
          `SoulMissing: SOUL.md absent or empty at ${path} — fail closed, no silent default persona (§7 cold start)`,
        )
      }

      assertValid(report, `${path}/constitution.md`)

      // Byte-identical payload: raw on-disk bytes, never a re-serialization (§4.3).
      const payload: IdentityPayload = Object.freeze({
        constitution: constitutionRaw,
        soul: soulRaw,
        hash: sha256(constitutionRaw + soulRaw),
      })
      snapshots.set(path, payload)
      record({ kind: 'tool-call', target: 'identity.loaded', payload: { hash: payload.hash } })
      return payload
    },

    getActivePersona(): string {
      // Mode selection lives on the full Personality surface; the loader always
      // reports the default register (§4.4, types.ts contract).
      return 'default'
    },

    async checkDegradation(ctx: DegradationCheckContext): Promise<DegradationCheckResult> {
      // The hash invariant is the machine-checkable anti-degradation check (§4.3):
      // a drifted candidate is rejected fail-closed before any turn runs (AC-08-14).
      if (ctx.candidatePayload.hash !== ctx.sessionHash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const recomputed = sha256(ctx.candidatePayload.constitution + ctx.candidatePayload.soul)
      if (recomputed !== ctx.sessionHash) {
        // Declared hash matches but the bytes drifted — name the drifted segment
        // when the frozen session snapshot is available.
        for (const snapshot of snapshots.values()) {
          if (snapshot.hash !== ctx.sessionHash) continue
          if (ctx.candidatePayload.soul !== snapshot.soul) {
            return { ok: false, reason: 'soul_mismatch' }
          }
          if (ctx.candidatePayload.constitution !== snapshot.constitution) {
            return { ok: false, reason: 'constitution_mismatch' }
          }
        }
        return { ok: false, reason: 'hash_mismatch' }
      }
      return { ok: true }
    },
  }
}

// ---------------------------------------------------------------------------
// Full Personality surface (§3): loadIdentity / reseedPayload / checkVeto /
// setMode / validate.
// ---------------------------------------------------------------------------

/** Mode record (§4.4): tone/wording only. The override fields exist so the
 *  setMode() guard can deterministically reject a register that tries to
 *  amend the constitution — they are never applied. */
export interface ModeSpec {
  body: string
  /** Present and non-empty -> rejected with 'mode_touches_precedence' (§5.5). */
  precedenceOverrides?: Record<string, number>
  /** false -> rejected with 'mode_disables_veto' (§5.5). */
  vetoOverride?: boolean
}

export interface PersonalityDeps {
  /** constitution.md bytes, in precedence order (§4.2). */
  constitution: string
  /** SOUL.md bytes (§4.1). */
  soul: string
  /** Additional proposed registers beyond SOUL.md's; validated by the setMode() guard. */
  modes?: Record<string, ModeSpec>
  /** Initial register name (default: 'default'). */
  initialMode?: string
  /** Append-only journal sink (Observability 12); defaults to a no-op. */
  record?: IdentityEventRecorder
  /**
   * Harness-controlled set of channels a HumanConfirmation token may originate
   * from (ADR-0029). When provided, checkVeto() accepts an irreversible action
   * only if it carries a structured HumanConfirmation whose `channel` is in this
   * set — a model-set bare boolean or a token with a forged channel never passes.
   * When omitted (e.g. a unit context with no approval handler wired), the legacy
   * boolean flag is honored for backward compatibility.
   */
  trustedConfirmationChannels?: readonly string[]
}

/**
 * Provenance gate for the veto (ADR-0029). Returns true only for a confirmation
 * that the harness — not the model — could have produced.
 *  - With a trusted-channel allowlist: requires a structured HumanConfirmation
 *    token whose channel is on the allowlist. A bare boolean or a token with an
 *    untrusted/missing channel is rejected.
 *  - Without an allowlist (no approval handler wired): the legacy bare boolean
 *    is honored, preserving existing callers.
 */
function isHumanConfirmed(
  metadata: Record<string, unknown> | undefined,
  trustedChannels: readonly string[] | undefined,
): boolean {
  const raw = metadata?.['humanConfirmation']
  if (trustedChannels === undefined) {
    return raw === true
  }
  if (typeof raw !== 'object' || raw === null) return false
  const token = raw as Partial<HumanConfirmation>
  return typeof token.channel === 'string' && trustedChannels.includes(token.channel)
}

export function makePersonality(deps: PersonalityDeps): Personality {
  const record = deps.record ?? noopRecord

  // Parse + validate fail-closed at construction (§5.1): a Personality with no
  // enforceable veto must not exist.
  const constitution = parseConstitution(deps.constitution)
  const soul = parseSoul(deps.soul)
  assertValid(validateIdentity(constitution, soul), 'constitution.md')

  const vetoPrinciple = constitution.principles.find(p => p.veto) as Principle

  // The frozen session payload (ADR-0019 segments 1-2): byte-identical for the
  // whole session; reseedPayload() returns these exact bytes (finding 3).
  const payload: IdentityPayload = Object.freeze({
    constitution: deps.constitution,
    soul: deps.soul,
    hash: sha256(deps.constitution + deps.soul),
  })

  // Mode registry: SOUL.md registers (tone only) plus any proposed extras.
  const modeRegistry: Record<string, ModeSpec> = {}
  for (const [name, body] of Object.entries(soul.modes)) {
    modeRegistry[name] = { body }
  }
  for (const [name, spec] of Object.entries(deps.modes ?? {})) {
    modeRegistry[name] = spec
  }

  // An explicit initialMode must name a registered register; an unknown one would
  // start the session in a register that does not exist. Fail closed at
  // construction (§5.1), consistent with the constitution/soul gates above. The
  // implicit 'default' fallback (when initialMode is omitted) stays a safe default.
  if (deps.initialMode !== undefined && modeRegistry[deps.initialMode] === undefined) {
    throw new ConstitutionError(
      `ConstitutionError: initialMode "${deps.initialMode}" is not a registered mode — fail closed at construction (§5.1)`,
    )
  }

  let activeMode = deps.initialMode ?? 'default'
  let generation = 0

  return {
    loadIdentity(): IdentityPayload {
      record({ kind: 'tool-call', target: 'identity.loaded', payload: { hash: payload.hash } })
      return payload
    },

    reseedPayload(): IdentityPayload {
      // Byte-identical to loadIdentity() this session — the anti-degradation
      // invariant (§5.4, AC-08-12/13).
      generation += 1
      record({
        kind: 'tool-call',
        target: 'identity.reseeded',
        payload: { hash: payload.hash, generation_id: generation },
      })
      return payload
    },

    checkVeto(action: ProposedAction): VetoVerdict {
      // (b) of §5.3: the veto-check event is journaled BEFORE any execute, so
      // Observability can assert consultation order (AC-08-9, AC-08-19).
      record({
        kind: 'tool-call',
        target: 'veto-check',
        payload: { actionId: action.id, vetoId: vetoPrinciple.id, hash: payload.hash },
      })

      if (!action.irreversible) {
        return {
          allowed: true,
          vetoId: null,
          reason: 'reversible action — the veto principle gates only irreversible steps (§5.3)',
        }
      }

      // The veto principle (§4.2): no irreversible harm/destruction WITHOUT
      // explicit, provenance-bound human confirmation. The deterministic gate
      // reads that confirmation from action metadata and binds it to a
      // harness-controlled channel (ADR-0029) so a model-set flag cannot pass;
      // absent a valid confirmation, fail closed.
      const confirmed = isHumanConfirmed(action.metadata, deps.trustedConfirmationChannels)
      if (confirmed) {
        return {
          allowed: true,
          vetoId: null,
          reason: 'irreversible action carries explicit, provenance-bound human confirmation (§4.2 [1])',
        }
      }

      record({
        kind: 'tool-call',
        target: 'veto.blocked',
        payload: { vetoId: vetoPrinciple.id, action: action.id, hash: payload.hash },
      })
      return {
        allowed: false,
        vetoId: vetoPrinciple.id,
        reason: `blocked by veto principle "${vetoPrinciple.id}": ${vetoPrinciple.text}`,
      }
    },

    setMode(name: string): ModeResult {
      // §5.5: a mode is a register, not a constitution amendment.
      const spec = modeRegistry[name]
      if (spec === undefined) {
        return { ok: false, reason: 'unknown_mode' }
      }
      if (spec.precedenceOverrides !== undefined && Object.keys(spec.precedenceOverrides).length > 0) {
        return { ok: false, reason: 'mode_touches_precedence' }
      }
      if (spec.vetoOverride === false) {
        return { ok: false, reason: 'mode_disables_veto' }
      }
      activeMode = name
      record({ kind: 'tool-call', target: 'mode.changed', payload: { mode: activeMode, hash: payload.hash } })
      return { ok: true, mode: name }
    },

    validate(c: Constitution, s: Soul): ValidationReport {
      return validateIdentity(c, s)
    },
  }
}

import { createHash } from 'node:crypto'

export type {
  AuditLog,
  AuditLogDeps,
  TraceEntry,
  TraceResult,
  TraceVerifier,
  TraceLinter,
  LintResult,
  LintRule,
  LintablePlanStep,
  JournalEntry,
  JournalFilter,
  Journal,
  EffectProbe,
  SecretRedactor,
  GuardianDeps,
  CycleDetector,
  VerificationRunner,
} from './types.js'

// Re-export shared types that originate in agent-loop but are part of the
// observability contract (§3, spec 12).
export type {
  VerificationTrace,
  VerificationTraceFile,
  VerificationTraceSQL,
  VerificationTraceHTTP,
  VerificationTraceExit,
  ToolCall,
  LoopGuardian,
} from './types.js'

import type {
  AuditLog,
  AuditLogDeps,
  VerificationRunner,
  Journal,
  JournalEntry,
  JournalFilter,
  EffectProbe,
  TraceResult,
  TraceLinter,
  LintResult,
  LintablePlanStep,
  GuardianDeps,
  SecretRedactor,
  CycleDetector,
} from './types.js'
import type { VerificationTrace, ToolCall, LoopGuardian } from '../agent-loop/types.js'

// ---------------------------------------------------------------------------
// Hashing helper — node:crypto, deterministic over canonical JSON.
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Stable JSON: sorts object keys recursively so the hash is order-insensitive. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// Trace verifier / VerificationRunner (§5.1, ADR-0017, ADR-0026)
//
// Deterministic effect matching. The model is never on this path: a step
// closes only when the injected EffectProbe confirms the declared criterion
// against the real world. Every failure mode (absent effect, probe throw,
// unbound probe) is fail-closed → pass:false, never "pass on error" (§7).
// ---------------------------------------------------------------------------

export function makeVerificationRunner(): VerificationRunner {
  return {
    async verify(trace: VerificationTrace, probe: EffectProbe): Promise<TraceResult> {
      // Cold start / unbound probe seam (AC-12-23): fail-closed. With no probe
      // bound there is no effect to confirm, so verify() refuses (throws) rather
      // than fabricating a verdict — no step can close. Both throw and pass:false
      // are fail-closed; the contract here is a hard refusal.
      if (probe === null || probe === undefined) {
        throw new Error('effect probe not bound (cold start) — verification fail-closed')
      }
      try {
        switch (trace.kind) {
          case 'file': {
            // pass iff exists === existsExpected AND, when sha256 declared, the
            // content hash matches — content is the effect, not mere presence.
            const observed = await probe.file(trace.path)
            if (observed.exists !== trace.existsExpected) {
              return { pass: false, kind: 'file', observed, reason: `file exists=${observed.exists}, expected ${trace.existsExpected}` }
            }
            if (trace.sha256 !== undefined && observed.sha256 !== trace.sha256) {
              return { pass: false, kind: 'file', observed, reason: `sha256 ${observed.sha256 ?? '<none>'} != declared ${trace.sha256}` }
            }
            return { pass: true, kind: 'file', observed }
          }
          case 'sql': {
            // pass iff the returned row count satisfies the predicate.
            const observed = await probe.sql(trace.query)
            const ok = matchRows(observed.rows, trace.expectRows)
            return ok
              ? { pass: true, kind: 'sql', observed }
              : { pass: false, kind: 'sql', observed, reason: `rows ${observed.rows} fails predicate ${JSON.stringify(trace.expectRows)}` }
          }
          case 'http': {
            // pass iff response status equals the expected status.
            const observed = await probe.http(trace.method, trace.url)
            return observed.status === trace.expectStatus
              ? { pass: true, kind: 'http', observed }
              : { pass: false, kind: 'http', observed, reason: `status ${observed.status} != expected ${trace.expectStatus}` }
          }
          case 'exit': {
            // pass iff the process exit code equals the expected code.
            const observed = await probe.exit(trace.argv)
            return observed.code === trace.expectCode
              ? { pass: true, kind: 'exit', observed }
              : { pass: false, kind: 'exit', observed, reason: `exit ${observed.code} != expected ${trace.expectCode}` }
          }
        }
      } catch (err) {
        // §7 dependency-unavailable: probe raised/timed out → trace failed.
        const reason = err instanceof Error ? err.message : String(err)
        return { pass: false, kind: trace.kind, observed: null, reason: `probe error: ${reason}` }
      }
    },
  }
}

function matchRows(rows: number, expect: number | { op: '=' | '>' | '>='; n: number }): boolean {
  if (typeof expect === 'number') return rows === expect
  switch (expect.op) {
    case '=': return rows === expect.n
    case '>': return rows > expect.n
    case '>=': return rows >= expect.n
  }
}

// ---------------------------------------------------------------------------
// Trace linter R1–R5 (§4 data structures, ADR-0026, Eng-5)
//
// Runs at plan time, before the gate. The first failing step short-circuits.
// The gate is never downgraded: a broken plan is a hard rejection (§7).
// ---------------------------------------------------------------------------

const VALID_TRACE_KINDS: ReadonlySet<string> = new Set(['file', 'sql', 'http', 'exit'])

/** Tier ≥ 2 tools (ADR-0011): any write/send/exec/db/git tool is irreversible. */
function isTier2Tool(tool: string): boolean {
  return (
    /write|send|delete|exec|drop|push/i.test(tool) ||
    /^(git|db|telegram|http|fs)[._]/i.test(tool) ||
    tool === 'bash'
  )
}

/** R3 no-op argv: the exit trace asserts nothing about the world. */
function isNoOpArgv(argv: string[]): boolean {
  const cmd = argv[0]
  if (cmd === undefined) return true
  return cmd === 'echo' || cmd === 'true' || cmd === ':' || cmd === 'printf'
}

/** R4 self-referential: a file trace pointing at the model's own plan artifact. */
function isSelfReferentialPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return base === 'PLAN.md' || base === 'TODO.md'
}

export function makeTraceLinter(): TraceLinter {
  return {
    lint(plan: { steps: LintablePlanStep[] }): LintResult {
      // Set of paths produced by some step in the plan. A file trace whose
      // target is in this set asserts a real effect the plan created; a trace
      // whose target is NOT produced by any step only re-asserts a pre-existing
      // file, which proves nothing (R3 vacuous, §4.4).
      const producedPaths = new Set<string>()
      for (const s of plan.steps) {
        if (s.producesPath !== undefined) producedPaths.add(s.producesPath)
      }

      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i]!
        const trace = step.trace

        // R1 missing — a step has no trace.
        if (trace === undefined || trace === null) {
          return { ok: false, rule: 'R1', stepIndex: i }
        }
        // R5 out-of-enum — kind outside file | sql | http | exit.
        if (!VALID_TRACE_KINDS.has((trace as { kind: string }).kind)) {
          return { ok: false, rule: 'R5', stepIndex: i }
        }
        // R2 unflagged-irreversible — Tier ≥ 2 tool but irreversible !== true.
        if (step.irreversible !== true && step.tools.some(isTier2Tool)) {
          return { ok: false, rule: 'R2', stepIndex: i }
        }
        // R4 self-referential — file trace pointing at PLAN.md/TODO.md.
        if (trace.kind === 'file' && isSelfReferentialPath(trace.path)) {
          return { ok: false, rule: 'R4', stepIndex: i }
        }
        // R3 vacuous — the trace asserts nothing about the world.
        if (trace.kind === 'exit' && isNoOpArgv(trace.argv)) {
          return { ok: false, rule: 'R3', stepIndex: i }
        }
        if (trace.kind === 'http' && isLoopback(trace.url) && isReadMethod(trace.method)) {
          return { ok: false, rule: 'R3', stepIndex: i }
        }
        // R3 pre-existing target — a file trace whose path is not produced by any
        // step in the plan re-asserts a file that already existed; verifying
        // something already true proves no effect (§4.4).
        if (trace.kind === 'file' && !producedPaths.has(trace.path)) {
          return { ok: false, rule: 'R3', stepIndex: i }
        }
      }
      return { ok: true }
    },
  }
}

function isLoopback(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url)
}

function isReadMethod(method: string): boolean {
  return ['GET', 'HEAD'].includes(method.toUpperCase())
}

// ---------------------------------------------------------------------------
// Cycle detector (§4 tool-call signature; ADR-0020)
//
// Detects a period-1/2/3 cycle in the trailing window. A cycle "trips" only
// when it repeats strictly more than `threshold` times (default 3, configurable
// per §4/§10 and GuardianDeps.tripThreshold) — i.e. the trailing run forming a
// period-p block is at least p*threshold + 1 long. Shorter periods win first so
// A-A-A-A is period 1, not a degenerate period-2/3 reading.
// ---------------------------------------------------------------------------

const DEFAULT_TRIP_THRESHOLD = 3

export function makeCycleDetector(threshold: number = DEFAULT_TRIP_THRESHOLD): CycleDetector {
  return {
    detect(window: string[]): { period: 1 | 2 | 3 } | null {
      for (const period of [1, 2, 3] as const) {
        if (matchesPeriod(window, period, threshold)) return { period }
      }
      return null
    },
  }
}

/** True when the tail of `window` is a period-`p` cycle repeating > `threshold` times. */
function matchesPeriod(window: string[], p: 1 | 2 | 3, threshold: number): boolean {
  // > `threshold` repeats of a length-p block means at least p*threshold + 1
  // trailing elements that are consistent with period p (w[i] === w[i - p]).
  const needed = p * threshold + 1
  if (window.length < needed) return false
  const start = window.length - needed
  for (let i = start + p; i < window.length; i++) {
    if (window[i] !== window[i - p]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tool-call signature (§4) — order-insensitive, canonicalized.
// ---------------------------------------------------------------------------

function signature(call: ToolCall): string {
  return sha256(`${call.name} ${canonical(call.args)}`)
}

// ---------------------------------------------------------------------------
// Loop Guardian (§5.2, ADR-0020, Eng-12)
//
// Consulted on every tool dispatch. Pushes a signature into a bounded ring
// window tagged with the current re-plan epoch, then trips on a period-1/2/3
// cycle repeating > 3 times WITHIN the current epoch. note("replan") advances
// the epoch (clearing the live window) but never resets a budget — Core owns
// the monotonic cap (§5.2). On trip the run halts and stays halted; work is
// never deleted and the Guardian never auto-resumes (AC-12-17). A window that
// cannot be rebuilt (windowSize 0) fails safe by tripping (AC-12-27).
// ---------------------------------------------------------------------------

export function makeLoopGuardian(deps: GuardianDeps): LoopGuardian {
  const windowSize = deps.windowSize ?? 12
  // Wire the injected trip threshold (cap on full cycle repeats) into the
  // detector; falls back to the default when unset (§4, §10, GuardianDeps).
  const detector = makeCycleDetector(deps.tripThreshold ?? DEFAULT_TRIP_THRESHOLD)
  let window: string[] = []
  let tripped = false

  // windowSize 0 means the window cannot be rebuilt after a crash; fail-safe.
  const cannotRebuild = windowSize <= 0

  return {
    observe(call: ToolCall): { trip: boolean; period?: 1 | 2 | 3 } {
      if (cannotRebuild) {
        // §7 crash recovery: no window to protect with → pause unattended runs.
        return { trip: true }
      }
      // Once halted the Guardian stays halted; it does not auto-resume.
      if (tripped) return { trip: true }

      window.push(signature(call))
      if (window.length > windowSize) window = window.slice(window.length - windowSize)

      const cycle = detector.detect(window)
      if (cycle !== null) {
        tripped = true
        // journal `guardian.tripped` with the offending window (best-effort:
        // the journal write is fire-and-forget; the trip verdict is the gate).
        // Swallow the rejection: when the journal is fail-closed (secret set not
        // yet loaded) the forensic note is dropped on purpose — the synchronous
        // trip verdict already halts the loop, and a leaked unhandled rejection
        // would be worse than a missing best-effort log line.
        void deps.journal
          .append('12', 'guardian.tripped', { window: [...window], period: cycle.period })
          .catch(() => {})
        return { trip: true, period: cycle.period }
      }
      return { trip: false }
    },

    note(event: 'replan'): void {
      if (event !== 'replan') return
      // Advance the re-plan epoch: clear the live window so signatures from the
      // prior attempt do not count toward a cycle in the new epoch (Eng-12).
      // This is NOT a budget reset and never widens the trip threshold.
      // A latched trip is a permanent STOP signal (ADR-0020, §5.2): once halted
      // the Guardian never auto-resumes, so a re-plan must NOT clear `tripped` —
      // resuming requires an explicit human-confirmation path outside this gate.
      window = []
    },
  }
}

// ---------------------------------------------------------------------------
// Secret redactor (§5.3, CSO-M3)
//
// Strips every known vault secret VALUE from arbitrary structures before the
// journal persists them. Safe to call before the vault is loaded — it returns
// the value unchanged but reports isLoaded:false, which makes append()
// fail-closed so nothing unredacted is ever written (§7).
// ---------------------------------------------------------------------------

export function makeSecretRedactor(): SecretRedactor {
  let loaded = false
  // The literal value plus every value-derived encoding we strip (§4, §5.3,
  // CSO-M3): raw, base64, URL-encoded, and hex. Precomputed at load time so the
  // redact hot-path is a flat substring sweep, not a per-string re-derivation.
  let needles: string[] = []

  // Derive the strippable encodings for a single secret VALUE. A secret echoed
  // as base64 / URL-encoded / hex must never reach the journal in the clear.
  const encodingsOf = (secret: string): string[] => [
    secret,
    Buffer.from(secret).toString('base64'),
    encodeURIComponent(secret),
    Buffer.from(secret).toString('hex'),
  ]

  const redactString = (s: string): string => {
    let out = s
    for (const needle of needles) {
      if (needle.length === 0) continue
      out = out.split(needle).join('«redacted»')
    }
    return out
  }

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v)
      }
      return out
    }
    return value
  }

  return {
    redact<T>(value: T): T {
      return walk(value) as T
    },
    loadVaultValues(next: ReadonlySet<string>): void {
      const acc: string[] = []
      for (const secret of next) {
        if (secret.length === 0) continue
        acc.push(...encodingsOf(secret))
      }
      needles = acc
      loaded = true
    },
    get isLoaded(): boolean {
      return loaded
    },
  }
}

// ---------------------------------------------------------------------------
// Append-only journal / AuditLog (§5.3, ADR-0021, CSO-M3)
//
// Each append: (1) refuses if the secret set is not loaded (fail-closed,
// AC-12-21/§7); (2) redacts the payload BEFORE persistence; (3) assigns a
// gap-free monotonic seq; (4) chains prevHash for tamper-evidence; (5) "fsyncs"
// — here, commits to the in-memory durable log (the disk lineage is the same
// shape, ADR-0021). read() verifies the prevHash chain and throws if a tamper
// breaks it, flagging the run unverifiable (AC-12-22).
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0'.repeat(64)

export function makeAuditLog(deps: AuditLogDeps): AuditLog {
  const entries: JournalEntry[] = []

  const entryHash = (e: JournalEntry): string =>
    sha256(canonical({ seq: e.seq, ts: e.ts, source: e.source, kind: e.kind, prevHash: e.prevHash, payloadHash: e.payloadHash }))

  return {
    async append(source: string, kind: string, payload: unknown): Promise<JournalEntry> {
      // Fail-closed: never persist before the known-secret set is loaded, so an
      // unredacted value can never touch the log (CSO-M3, AC-12-21, AC-12-23).
      if (!deps.secretRedactor.isLoaded) {
        throw new Error('journal append refused: secret set not loaded (fail-closed)')
      }
      // Redact BEFORE persistence — an unredacted payload never reaches storage.
      const redacted = deps.secretRedactor.redact(payload)
      const seq = entries.length + 1 // monotonic, gap-free per session
      const prev = entries[entries.length - 1]
      const prevHash = prev ? entryHash(prev) : GENESIS_HASH
      const entry: JournalEntry = {
        seq,
        ts: deps.clock.now(),
        source,
        kind,
        prevHash,
        payloadHash: sha256(canonical(redacted)),
        payload: redacted,
      }
      entries.push(entry) // commit (fsync in the disk lineage)
      return entry
    },

    read(filter: JournalFilter): JournalEntry[] {
      // Tamper-evidence: verify the prevHash chain on read. A broken link flags
      // the run unverifiable rather than silently accepting it (AC-12-22, §7).
      let expectedPrev = GENESIS_HASH
      for (const e of entries) {
        if (e.prevHash !== expectedPrev) {
          throw new Error(`journal chain broken at seq ${e.seq}: run is unverifiable from this point`)
        }
        expectedPrev = entryHash(e)
      }
      return entries.filter(
        e =>
          (filter.kind === undefined || e.kind === filter.kind) &&
          (filter.since === undefined || e.seq >= filter.since),
      )
    },
  }
}

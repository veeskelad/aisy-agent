// Orchestration — Component 11
// Deterministic control plane for multi-step work: coordinator-workers topology
// (ADR-0021), Loop Guardian retry cap (ADR-0020), generations (ADR-0005).
// See docs/specs/11-orchestration.md.

import { randomUUID, createHash } from 'node:crypto'
import { resolvedWorkBinding } from '../runtime/work-binding.js'

export type {
  RunId,
  WorkerId,
  GenerationId,
  BudgetSlice,
  IterationCost,
  BudgetVerdict,
  GlobalBudgetCounters,
  NestedBudgetCounters,
  BudgetLedger,
  TaskClass,
  WorkerScope,
  WorkerBrief,
  Task,
  JournalEntry,
  ReconcileResult,
  ConflictRecord,
  WorkerHandle,
  Coordinator,
  CoordinatorDeps,
  Worker,
  DecisionJournal,
  BudgetGuard,
  LoopPeriod,
  LoopStep,
  GuardianVerdict,
  LoopGuardian,
  LoopGuardianConfig,
  DistilledLesson,
  GenerationManifest,
  GenerationManager,
  OrchestrationEventKind,
  OrchestrationEvent,
  // Delegation (ADR-0039)
  DelegationId,
  DelegationScope,
  DelegationTask,
  Dependency,
  PlanDAG,
  LinearPlanLike,
  AgentCard,
  CapabilityRequest,
  ShardEntry,
  DelegationCheckpoint,
  DelegationStatus,
  PersistedDelegationV1,
  PersistedDelegationRunV1,
  DelegationQuarantineReason,
  DelegationPersistencePort,
  TaskObservation,
  DelegationHandle,
  DelegationDeps,
  ScheduleResult,
  DelegationRecoveryResult,
  DelegationRecoveryPreflight,
  DelegationManager,
} from './types.js'

export { DelegationResumeError, ScopeConflictError, ScopeViolationError } from './types.js'

import {
  ScopeConflictError,
  ScopeViolationError,
  DelegationResumeError,
  type BudgetVerdict,
  type ConflictRecord,
  type Coordinator,
  type CoordinatorDeps,
  type DistilledLesson,
  type GenerationId,
  type GuardianVerdict,
  type IterationCost,
  type JournalEntry,
  type LoopGuardian,
  type LoopGuardianConfig,
  type LoopPeriod,
  type LoopStep,
  type NestedBudgetCounters,
  type OrchestrationEventKind,
  type ReconcileResult,
  type RunId,
  type Task,
  type TaskClass,
  type WorkerBrief,
  type WorkerHandle,
  type WorkerId,
  type WorkerScope,
  // Delegation (ADR-0039)
  type AgentCard,
  type CapabilityRequest,
  type DelegationCheckpoint,
  type DelegationQuarantineReason,
  type DelegationStatus,
  type PersistedDelegationV1,
  type PersistedDelegationRunV1,
  type DelegationDeps,
  type DelegationHandle,
  type DelegationId,
  type DelegationManager,
  type DelegationTask,
  type Dependency,
  type LinearPlanLike,
  type PlanDAG,
  type ScheduleResult,
  type DelegationRecoveryResult,
  type DelegationRecoveryPreflight,
  type ShardEntry,
  type TaskObservation,
} from './types.js'

const USD_NANOS_PER_USD = 1_000_000_000n
const MAX_SAFE_USD_NANOS = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Convert a public USD number to exact integer nanos using its canonical
 * decimal/exponent spelling. Rounding is decimal half-up at 1e-9; invalid,
 * negative and unsafe totals are refused without throwing so App recovery can
 * map the same code-owned parser directly to a stable denial.
 */
export function iterationCostSpendNanos(spendUsd: number): number | undefined {
  if (typeof spendUsd !== 'number' || !Number.isFinite(spendUsd) || spendUsd < 0) {
    return undefined
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(spendUsd.toString())
  if (match === null) return undefined
  const whole = match[1]!
  const fraction = match[2] ?? ''
  const exponent = Number.parseInt(match[3] ?? '0', 10)
  const coefficient = BigInt(`${whole}${fraction}`)
  const decimalScale = fraction.length - exponent
  const nanosShift = 9 - decimalScale
  let nanos: bigint
  if (nanosShift >= 0) {
    nanos = coefficient * (10n ** BigInt(nanosShift))
  } else {
    const divisor = 10n ** BigInt(-nanosShift)
    const quotient = coefficient / divisor
    const remainder = coefficient % divisor
    nanos = quotient + (remainder * 2n >= divisor ? 1n : 0n)
  }
  if (nanos > MAX_SAFE_USD_NANOS) return undefined
  return Number(nanos)
}

function spendUsdFromNanos(nanos: number): number | undefined {
  if (!Number.isSafeInteger(nanos) || nanos < 0) return undefined
  const spendUsd = nanos / Number(USD_NANOS_PER_USD)
  return iterationCostSpendNanos(spendUsd) === nanos ? spendUsd : undefined
}

function quantizedIterationCost(
  cost: IterationCost,
): { cost: IterationCost; spendNanos: number } | undefined {
  if (typeof cost !== 'object' || cost === null ||
    !Number.isSafeInteger(cost.iterations) || cost.iterations < 0 ||
    !Number.isSafeInteger(cost.wallMs) || cost.wallMs < 0) return undefined
  const spendNanos = iterationCostSpendNanos(cost.spendUsd)
  if (spendNanos === undefined) return undefined
  const spendUsd = spendUsdFromNanos(spendNanos)
  if (spendUsd === undefined) return undefined
  return {
    cost: { iterations: cost.iterations, spendUsd, wallMs: cost.wallMs },
    spendNanos,
  }
}

/** Canonical public IterationCost derived from the exact nanos representation. */
export function canonicalizeIterationCost(cost: IterationCost): IterationCost | undefined {
  return quantizedIterationCost(cost)?.cost
}

// ---------------------------------------------------------------------------
// Glob matching — minimal, deterministic. Worker scopes use glob paths
// ('src/api/**'); `touched` carries concrete paths checked against them
// (spec §3 WorkerScope, §5.1 "code checks touched ⊆ scope.owns").
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path)
}

/** Literal prefix of a glob — everything before the first wildcard. */
function globRoot(glob: string): string {
  const wildcardIdx = glob.search(/[*?]/)
  return wildcardIdx === -1 ? glob : glob.slice(0, wildcardIdx)
}

/**
 * Conservative may-overlap test between two scope patterns: equal patterns or
 * one literal root truly *containing* the other are treated as overlapping.
 * Containment only counts at a path-segment boundary — the character after the
 * shorter root in the longer one must be a `/` (or the shorter root already
 * ends in `/`, or the roots are equal). Otherwise a bare prefix like
 * 'src/api' would wrongly match the disjoint 'src/apiv2/**'.
 * Used for the pairwise write-disjointness assertion (ADR-0021, AC-11-1).
 */
function patternsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const ra = globRoot(a)
  const rb = globRoot(b)
  const [shorter, longer] = ra.length <= rb.length ? [ra, rb] : [rb, ra]
  if (!longer.startsWith(shorter)) return false
  return longer.length === shorter.length || shorter.endsWith('/') || longer[shorter.length] === '/'
}

function overlappingPaths(ownsA: string[], ownsB: string[]): string[] {
  const overlap: string[] = []
  for (const a of ownsA) {
    for (const b of ownsB) {
      if (patternsMayOverlap(a, b)) overlap.push(a === b ? a : `${a} ~ ${b}`)
    }
  }
  return overlap
}

// ---------------------------------------------------------------------------
// Loop Guardian — sliding-window cycle detector for periods 1/2/3 (ADR-0020).
// A cycle repeating more than `maxRepeats` times latches a STOP; the verdict
// persists across further checks (no auto-resume, spec §7 / AC-11-7). Cycles
// of period ≥4 are by design invisible here and are caught by the global
// budget cap instead (spec §5.2 / AC-11-8).
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REPEATS = 3
const DEFAULT_WINDOW_SIZE = 32

export function makeLoopGuardian(config: LoopGuardianConfig = {}): LoopGuardian {
  const maxRepeats = config.maxRepeats ?? DEFAULT_MAX_REPEATS
  const windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE

  let window: LoopStep[] = []
  let latched: GuardianVerdict | undefined

  return {
    check(step: LoopStep): GuardianVerdict {
      // STOP is latched — the run never auto-resumes (AC-11-7).
      if (latched !== undefined) return latched

      window.push(step)
      if (window.length > windowSize) window.shift()

      for (const period of [1, 2, 3] as const satisfies readonly LoopPeriod[]) {
        if (window.length < period * 2) continue
        // The candidate cycle is the last `period` actions; count how many
        // times it repeats consecutively at the tail of the window.
        const block = window.slice(-period).map(s => s.actionId)
        let repeats = 1
        let pos = window.length - 2 * period
        while (pos >= 0) {
          let same = true
          for (let i = 0; i < period; i++) {
            if (window[pos + i]!.actionId !== block[i]) {
              same = false
              break
            }
          }
          if (!same) break
          repeats++
          pos -= period
        }
        if (repeats > maxRepeats) {
          latched = { stop: true, period, repeatCount: repeats, windowSnapshot: [...window] }
          return latched
        }
      }
      return { pass: true }
    },

    reset(): void {
      window = []
      latched = undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Coordinator — decomposition, scope-checked spawn, journal reconciliation
// (ADR-0021). Scope assignment and all invariants below are code (100%
// adherence); only the *wording* of intents/entries defers to the model.
// ---------------------------------------------------------------------------

/** §7: with the Loop Guardian unavailable the iteration cap tightens to this floor. */
const CONSERVATIVE_ITERATION_FLOOR = 25

/** §4 example scope contract — default per-worker budget slice. */
const DEFAULT_WORKER_ITERATIONS = 40
const DEFAULT_WORKER_SPEND_USD = 0.5

export function makeCoordinator(deps: CoordinatorDeps): Coordinator {
  const runId: RunId = `r-${randomUUID().slice(0, 8)}`
  let generationId: GenerationId = 'g-1'

  const spawnedScopes = new Map<WorkerId, WorkerScope>()
  /** Workers that attempted an out-of-scope write; excluded from the merge (§7). */
  const faulted = new Set<WorkerId>()
  /** Mirror of budget.json.nested — proves which bound stopped the run (§5.2). */
  const nested: NestedBudgetCounters = { loopGuardianTrips: 0, planReplans: 0, skillFailures: {} }

  let haltReason: string | undefined
  let degraded = false
  /**
   * Coordinator-controlled monotonic seq. The journal `seq` is a tamper signal
   * (§4), so a worker must never assign its own — a hostile/buggy worker could
   * forge collisions or gaps. The coordinator alone advances it (§8 repudiation).
   */
  let nextSeq = 1

  function emit(kind: OrchestrationEventKind, payload?: unknown): void {
    deps.emit({ kind, runId, ts: new Date().toISOString(), payload })
  }

  /** Halt fail-closed on the first cap reached; never proceeds past it (§5.2). */
  function halt(reason: string, extra?: Record<string, unknown>): void {
    if (haltReason !== undefined) return
    haltReason = reason
    emit('run.terminated', { reason, nested: { ...nested }, ...extra })
  }

  // Cold start (§7 / AC-11-14): no run state exists yet — fail closed by
  // construction: fresh g-1, empty journal, fresh ledger, zero workers, and
  // no orphan-resumption capability at all.
  //
  // Guardian heartbeat probe (§7 / AC-11-15): if Observability's Loop
  // Guardian is unreachable, do not run unattended at normal caps — flag the
  // run degraded and tighten the iteration cap to the conservative floor.
  let startupVerdict: GuardianVerdict | undefined
  try {
    startupVerdict = deps.loopGuardian.check({ actionId: '__heartbeat__', seq: 0 })
    if (!('stop' in startupVerdict)) deps.loopGuardian.reset()
  } catch {
    degraded = true
  }

  emit('run.started', {
    generationId,
    degraded,
    iterationCapFloor: degraded ? CONSERVATIVE_ITERATION_FLOOR : undefined,
  })

  // Precedence (§5.2 / AC-11-9): the Loop-Guardian STOP is the innermost
  // bound and fires before any budget charge — a latched STOP halts here.
  if (startupVerdict !== undefined && 'stop' in startupVerdict) {
    nested.loopGuardianTrips++
    halt('loop-guardian', { reviewCard: { windowSnapshot: startupVerdict.windowSnapshot } })
  }

  function checkScope(
    touched: string[],
    scope: WorkerScope,
  ): { paths: string[]; reason: 'outside-owns' | 'inside-doNotTouch' } | undefined {
    // §5.1: touched ⊆ owns ∧ touched ∩ doNotTouch = ∅; doNotTouch overrides owns.
    const insideDeny = touched.filter(p => scope.doNotTouch.some(g => globMatches(g, p)))
    if (insideDeny.length > 0) return { paths: insideDeny, reason: 'inside-doNotTouch' }
    const outsideOwns = touched.filter(p => !scope.owns.some(g => globMatches(g, p)))
    if (outsideOwns.length > 0) return { paths: outsideOwns, reason: 'outside-owns' }
    return undefined
  }

  function abortReconcile(reason: 'seq-gap' | 'untrusted'): ReconcileResult {
    // §7 seq gap / tamper: reconciliation aborts, run is halted as untrusted.
    halt('untrusted-journal', { integrity: reason })
    return { aborted: reason }
  }

  /**
   * Dead-end fork (§5.3 / ADR-0005). The model would distill lessons (~70%); the
   * fork itself is code. The new generation carries constitution + lessons only —
   * the failed transcript is dropped — and per-generation counters reset, but the
   * run-level spend cap is NOT reset (no budget-reset evasion, §8). Switching
   * `generationId` is the deterministic transcript drop: subsequent entries are
   * stamped with the fresh generation, never the dead-ended one.
   */
  function forkOnDeadEnd(lessons: DistilledLesson[]): GenerationId {
    const newGen = deps.generationManager.fork(runId, lessons)
    const parent = generationId
    generationId = newGen
    nested.loopGuardianTrips = 0
    nested.planReplans = 0
    nested.skillFailures = {}
    emit('generation.forked', { generationId: newGen, parent })
    return newGen
  }

  return {
    decompose(task: Task, _gen: GenerationId): WorkerBrief[] {
      // Decomposition is a model call in production (~70%, spec §5.1); the
      // deterministic carve here is one worker per affected path. Each
      // worker's doNotTouch explicitly denies every peer's lane.
      const paths = [...new Set(task.affectedPaths)]
      const briefs: WorkerBrief[] = paths.map((path, i) => ({
        workerId: `w-${i + 1}`,
        intent: `Apply '${task.description}' within ${path}`,
        scope: {
          owns: [path],
          doNotTouch: paths.filter(p => p !== path),
          taskClass: 'reasoning',
          budgetSlice: { iterations: DEFAULT_WORKER_ITERATIONS, spendUsd: DEFAULT_WORKER_SPEND_USD },
        },
      }))

      // Code-enforced (ADR-0021 / AC-11-1): scopes must be pairwise
      // write-disjoint before any spawn; an overlap halts the run instead.
      for (let i = 0; i < briefs.length; i++) {
        for (let j = i + 1; j < briefs.length; j++) {
          const overlap = overlappingPaths(briefs[i]!.scope.owns, briefs[j]!.scope.owns)
          if (overlap.length > 0) {
            throw new ScopeConflictError(briefs[i]!.workerId, briefs[j]!.workerId, overlap)
          }
        }
      }
      return briefs
    },

    async spawn(brief: WorkerBrief): Promise<WorkerHandle> {
      if (haltReason !== undefined) {
        throw new Error(`run halted (${haltReason}); refusing to spawn worker '${brief.workerId}'`)
      }

      // Reject any scope overlapping an already-spawned worker (AC-11-1).
      for (const [otherId, otherScope] of spawnedScopes) {
        const overlap = overlappingPaths(brief.scope.owns, otherScope.owns)
        if (overlap.length > 0) {
          throw new ScopeConflictError(otherId, brief.workerId, overlap)
        }
      }

      spawnedScopes.set(brief.workerId, brief.scope)
      emit('worker.spawned', { workerId: brief.workerId, scope: brief.scope })

      // The handle deliberately exposes NO peer channel — no sendToPeer /
      // message / peers. The no-peer-to-peer invariant is enforced by
      // absence of capability (ADR-0021 / AC-11-3); the only sink a worker
      // has is appendDecision into the shared journal.
      const handle: WorkerHandle = {
        workerId: brief.workerId,
        appendDecision: (partial): void => {
          // Fail closed (§7): a worker that already committed a scope violation
          // is faulted and excluded from the merge — it must not be able to
          // write any further entries into the shared journal (AC-11-2).
          if (faulted.has(brief.workerId)) {
            throw new ScopeViolationError(brief.workerId, partial.touched, 'outside-owns')
          }
          const violation = checkScope(partial.touched, brief.scope)
          if (violation !== undefined) {
            // Fail closed (§7): reject the append, mark the worker faulted
            // so its output never enters the merge (AC-11-2).
            faulted.add(brief.workerId)
            emit('scope.violation', {
              workerId: brief.workerId,
              violatingPaths: violation.paths,
              reason: violation.reason,
            })
            throw new ScopeViolationError(brief.workerId, violation.paths, violation.reason)
          }
          // Seq is coordinator-controlled (§4 / §8): override any worker-supplied
          // value with a fresh monotonic seq so the journal stays tamper-evident.
          const entry: JournalEntry = {
            runId,
            generationId,
            workerId: brief.workerId,
            ...partial,
            seq: nextSeq++,
          }
          deps.journal.append(entry)
          emit('journal.appended', { workerId: brief.workerId, seq: entry.seq })
        },
        done: Promise.resolve(),
      }
      return handle
    },

    reconcile(targetRunId: RunId): ReconcileResult {
      const all = deps.journal.read(targetRunId)

      // Integrity first (AC-11-5/6): `seq` must be strictly monotonic with no
      // gaps. A gap means loss/tampering; a duplicate means mutation. Both
      // fail closed — no merge is ever produced from an untrusted journal.
      const seqs = all.map(e => e.seq).sort((a, b) => a - b)
      for (let i = 1; i < seqs.length; i++) {
        const delta = seqs[i]! - seqs[i - 1]!
        if (delta === 0) return abortReconcile('untrusted')
        if (delta > 1) return abortReconcile('seq-gap')
      }

      // Faulted workers' decisions never enter the merge (§7 scope violation).
      const entries = all.filter(e => !faulted.has(e.workerId))

      // Contradiction scan (AC-11-4 / ADR-0021): two entries conflict when they
      // touch a shared resource and chose *different* options for it. Only one
      // decision can hold per resource, so distinct `decidedFor` on a shared path
      // is incompatible — regardless of whether either recorded a competing
      // `decidedAgainst` (which is often '' when there was no rival option). The
      // earlier FOR==AGAINST-only test silently glued together exactly this common
      // case, the failure ADR-0021 exists to prevent.
      const conflicts: ConflictRecord[] = []
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i]!
          const b = entries[j]!
          if (a.decidedFor === b.decidedFor) continue
          const shared = a.touched.find(p => b.touched.includes(p))
          if (shared === undefined) continue
          conflicts.push({ entryA: a, entryB: b, resource: shared })
        }
      }

      if (conflicts.length === 0) {
        emit('run.reconciled', { entries: entries.length, conflicts: 0 })
        return { merged: entries }
      }

      // Deterministic resolution (§5.1): one merger, not dialogue — the
      // earliest decision (lowest seq) wins and the coordinator records its
      // own journal entry; the losing decision is excluded from the merge.
      const excluded = new Set<JournalEntry>()
      const resolutions: JournalEntry[] = []
      let resolutionSeq = (seqs[seqs.length - 1] ?? 0) + 1
      for (const c of conflicts) {
        const winner = c.entryA.seq <= c.entryB.seq ? c.entryA : c.entryB
        const loser = winner === c.entryA ? c.entryB : c.entryA
        excluded.add(loser)
        const resolution: JournalEntry = {
          runId: targetRunId,
          generationId,
          workerId: 'coordinator',
          seq: resolutionSeq++,
          decidedFor: winner.decidedFor,
          decidedAgainst: loser.decidedFor,
          because:
            `coordinator resolution over '${c.resource}': ` +
            `earliest decision (seq ${winner.seq}, ${winner.workerId}) is the single source of truth`,
          touched: [],
          ts: new Date().toISOString(),
        }
        deps.journal.append(resolution)
        resolutions.push(resolution)
      }

      const merged = [...entries.filter(e => !excluded.has(e)), ...resolutions]
      emit('run.reconciled', { entries: merged.length, conflicts: conflicts.length })
      return { merged }
    },

    // §5.2 global-budget backstop (AC-11-8/9). Every iteration / tool dispatch
    // is charged here; the run never proceeds past the first cap reached. A
    // `global-budget` cap is a dead-end trigger (§5.3) → fork a fresh generation.
    charge(cost: IterationCost): BudgetVerdict {
      // Fail-closed: once halted, never charge or proceed again.
      if (haltReason !== undefined) {
        return { capped: true, reason: 'global-budget' }
      }
      const verdict = deps.budgetGuard.charge(runId, cost)
      if ('capped' in verdict) {
        emit('budget.capped', { reason: verdict.reason })
        halt(verdict.reason)
        if (verdict.reason === 'global-budget') {
          // Dead-end: distillation is the model's job in production; the fork is code.
          forkOnDeadEnd([{ summary: `run hit global budget cap` }])
        }
      }
      return verdict
    },

    // ADR-0025 / AC-11-10: advisory only. N≥3 failures lower the strategy's
    // priority in a worker's choice (recorded in the nested ledger); this
    // never emits run.terminated and never blocks a spawn.
    onSkillFailure(skill: string): void {
      nested.skillFailures[skill] = (nested.skillFailures[skill] ?? 0) + 1
    },
  }
}

// ---------------------------------------------------------------------------
// First-class sub-agent delegation (ADR-0039, spec §5.4/§5.5).
//
// A goal-DAG of DelegationTasks, each served by a sub-agent whose capabilities
// are fixed by an AgentCard (the model cannot self-widen). State hands off
// without loss: every delegation owns a hash-chained shard; the parent receives
// only a compact TaskObservation. Reuses the §5.1 scope-disjointness logic, the
// ADR-0020 Loop Guardian, and ScopeConflictError — nothing here is a new runtime.
// ---------------------------------------------------------------------------

const SHARD_GENESIS = '0'.repeat(64)
const MAX_SHARD_ENTRY_BYTES = 1024 * 1024
const MAX_SHARD_JSON_DEPTH = 128
const MAX_PLAN_TASKS = 256
const MAX_PLAN_EDGES = 2048
const MAX_TASK_DEPENDENCIES = 64

/** Deterministic JSON after the iterative bounds check has made recursion safe. */
function uncheckedStableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map(k => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  )
}

function assertBoundedSerializable(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let approximateBytes = 0
  while (pending.length > 0) {
    const next = pending.pop()!
    const current = next.value
    if (next.depth > MAX_SHARD_JSON_DEPTH) {
      throw new Error('delegation shard payload exceeds depth limit')
    }
    if (current === null || typeof current === 'boolean') {
      approximateBytes += 8
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('delegation shard payload is not serializable')
      approximateBytes += 32
    } else if (typeof current === 'string') {
      approximateBytes += Buffer.byteLength(current, 'utf8') + 2
    } else if (typeof current === 'object') {
      if (seen.has(current)) throw new Error('delegation shard payload is not serializable')
      seen.add(current)
      if (Array.isArray(current)) {
        if (current.length > MAX_SHARD_ENTRY_BYTES) {
          throw new Error('delegation shard entry exceeds size limit')
        }
        approximateBytes += current.length + 2
        for (let i = current.length - 1; i >= 0; i--) {
          pending.push({ value: current[i], depth: next.depth + 1 })
        }
      } else {
        const prototype = Object.getPrototypeOf(current)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('delegation shard payload is not serializable')
        }
        const record = current as Record<string, unknown>
        const keys = Object.keys(record)
        approximateBytes += keys.length + 2
        for (const key of keys) {
          approximateBytes += Buffer.byteLength(key, 'utf8') + 3
          pending.push({ value: record[key], depth: next.depth + 1 })
        }
      }
    } else {
      throw new Error('delegation shard payload is not serializable')
    }
    if (approximateBytes > MAX_SHARD_ENTRY_BYTES) {
      throw new Error('delegation shard entry exceeds size limit')
    }
  }
  const encoded = uncheckedStableStringify(value)
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_SHARD_ENTRY_BYTES) {
    throw new Error('delegation shard entry exceeds size limit')
  }
}

/** Deterministic JSON: object keys sorted recursively (stable hashing input). */
function stableStringify(value: unknown): string {
  // Every call site, including comparisons of untrusted persisted state, gets
  // the same iterative guard before recursive JSON.stringify can run.
  assertBoundedSerializable(value)
  return uncheckedStableStringify(value)
}

/**
 * Deep clone a shard payload so neither the caller (who keeps a reference to
 * what it passed to append) nor a post-mortem shard() reader can mutate an
 * "immutable" audit entry after the fact. structuredClone handles cycles/Dates;
 * the rare non-cloneable payload (e.g. a function) falls back to the original.
 */
function safeClone<T>(v: T): T {
  return structuredClone(v)
}

function isDelegationQuarantineReason(value: unknown): value is DelegationQuarantineReason {
  return value === 'legacy-or-invalid-state' || value === 'binding-mismatch' ||
    value === 'binding-inactive' || value === 'task-or-card-mismatch' ||
    value === 'shard-integrity-failed' || value === 'checkpoint-mismatch'
}

function cloneEntry(e: ShardEntry): ShardEntry {
  return { ...e, payload: safeClone(e.payload) }
}

function immutableAgentCard(card: AgentCard): AgentCard {
  const cloned = safeClone(card)
  Object.freeze(cloned.skills)
  Object.freeze(cloned.mcpAllowlist)
  Object.freeze(cloned.toolTiers)
  return Object.freeze(cloned)
}

function shardEntryHash(e: Omit<ShardEntry, 'hash'>): string {
  const payloadHash = createHash('sha256').update(stableStringify(e.payload), 'utf8').digest('hex')
  return createHash('sha256')
    .update(
      stableStringify({
        delegationId: e.delegationId,
        seq: e.seq,
        prevHash: e.prevHash,
        kind: e.kind,
        ts: e.ts,
        payloadHash,
      }),
      'utf8',
    )
    .digest('hex')
}

function isPlanDAG(plan: LinearPlanLike | PlanDAG): plan is PlanDAG {
  return Array.isArray((plan as PlanDAG).nodes)
}

/**
 * Normalize a Core (01) linear plan into a degenerate goal-DAG: each step
 * becomes a node depending on the previous one, preserving sequential order
 * (AC-11-16). A PlanDAG is returned unchanged. The Core `Plan` shape itself is
 * never modified — the union lives here, at the orchestration layer.
 */
function normalizePlan(plan: LinearPlanLike | PlanDAG): PlanDAG {
  if (isPlanDAG(plan)) {
    if (!Array.isArray(plan.edges)) throw new Error('invalid delegation plan')
    return { nodes: [...plan.nodes], edges: [...plan.edges] }
  }
  const nodes: DelegationTask[] = plan.steps.map((step, i) => ({
    taskId: `s${i + 1}`,
    intent: step.intent ?? '',
    assignedTo: null,
    dependsOn: i > 0 ? [`s${i}`] : [],
    scope: { owns: [], doNotTouch: [], taskClass: 'reasoning' as TaskClass },
    budgetSlice: { iterations: DEFAULT_WORKER_ITERATIONS, spendUsd: DEFAULT_WORKER_SPEND_USD },
    outputContract: '',
    retryPolicy: { maxReplans: 0, maxIterations: DEFAULT_WORKER_ITERATIONS },
  }))
  const edges: Dependency[] = nodes.slice(1).map((n, i) => ({ from: `s${i + 1}`, to: n.taskId }))
  return { nodes, edges }
}

function assertValidPlan(plan: PlanDAG): void {
  if (plan.nodes.length > MAX_PLAN_TASKS || plan.edges.length > MAX_PLAN_EDGES) {
    throw new Error('invalid delegation plan')
  }
  const ids = plan.nodes.map(task => task.taskId)
  const idSet = new Set(ids)
  if (ids.some(id => typeof id !== 'string') || idSet.size !== ids.length) {
    throw new Error('invalid delegation plan')
  }

  const expectedEdges = new Set<string>()
  for (const task of plan.nodes) {
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length > MAX_TASK_DEPENDENCIES ||
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.some(dependency => dependency === task.taskId || !idSet.has(dependency))) {
      throw new Error('invalid delegation plan')
    }
    for (const dependency of task.dependsOn) {
      expectedEdges.add(`${dependency}\0${task.taskId}`)
    }
  }

  const actualEdges = new Set<string>()
  for (const edge of plan.edges) {
    if (typeof edge !== 'object' || edge === null || !idSet.has(edge.from) ||
      !idSet.has(edge.to) || edge.from === edge.to) {
      throw new Error('invalid delegation plan')
    }
    actualEdges.add(`${edge.from}\0${edge.to}`)
  }
  if (actualEdges.size !== plan.edges.length || actualEdges.size !== expectedEdges.size ||
    [...actualEdges].some(edge => !expectedEdges.has(edge))) {
    throw new Error('invalid delegation plan')
  }

  const remaining = new Map(plan.nodes.map(task => [task.taskId, task.dependsOn.length] as const))
  const dependents = new Map<string, string[]>()
  for (const task of plan.nodes) {
    for (const dependency of task.dependsOn) {
      const targets = dependents.get(dependency) ?? []
      targets.push(task.taskId)
      dependents.set(dependency, targets)
    }
  }
  const ready = ids.filter(id => remaining.get(id) === 0)
  let visited = 0
  while (ready.length > 0) {
    const id = ready.pop()!
    visited += 1
    for (const dependent of dependents.get(id) ?? []) {
      const next = (remaining.get(dependent) ?? 0) - 1
      remaining.set(dependent, next)
      if (next === 0) ready.push(dependent)
    }
  }
  if (visited !== ids.length) throw new Error('invalid delegation plan')
}

interface DelegationState {
  task: DelegationTask
  card: AgentCard
  /** Composed writable path set = task.scope.owns ∪ skill-touched (== owns; §5.5). */
  owns: string[]
  /** card.mcpAllowlist ∩ MCP-writable. */
  writableMcp: string[]
  /** The card's tool set — the capability authority (AC-11-17). */
  permittedTools: Set<string>
  entries: ShardEntry[]
  guardian: LoopGuardian
  status: DelegationStatus
  terminalObservation?: TaskObservation
}

interface ValidatedDelegationSnapshot {
  run: PersistedDelegationRunV1
  state: DelegationState
  checkpoint: DelegationCheckpoint
}

class PersistedDelegationValidationError extends DelegationResumeError {
  declare public readonly code: DelegationQuarantineReason

  constructor(
    public readonly delegationId: DelegationId,
    reason: DelegationQuarantineReason,
  ) {
    super(reason, `delegation '${delegationId}' recovery denied: ${reason}`)
    this.name = 'PersistedDelegationValidationError'
  }
}

export function makeDelegationManager(
  plan: LinearPlanLike | PlanDAG,
  deps: DelegationDeps,
): DelegationManager {
  let runId: RunId = `r-${randomUUID().slice(0, 8)}`
  const binding = Object.freeze(resolvedWorkBinding(deps.binding))
  const bindingView = () => Object.freeze({ ...binding })
  const dagPlan = normalizePlan(plan)
  assertValidPlan(dagPlan)
  const tasksById = new Map(dagPlan.nodes.map(t => [t.taskId, t] as const))

  const completed = new Set<string>()
  const failed = new Set<string>()
  const skipped = new Set<string>()
  const delegations = new Map<DelegationId, DelegationState>()
  const checkpoints = new Map<DelegationId, DelegationCheckpoint>()
  const issuedHandles = new Set<DelegationId>()
  const handleEpochs = new Map<DelegationId, number>()
  const runBudget: IterationCost = { iterations: 0, spendUsd: 0, wallMs: 0 }
  let runSpendNanos = 0

  const delegationIdFor = (taskId: string): DelegationId => `d-${taskId}`

  function emit(kind: OrchestrationEventKind, payload?: unknown): void {
    deps.emit({ kind, runId, ts: new Date().toISOString(), payload })
  }

  function isTerminal(taskId: string): boolean {
    return completed.has(taskId) || failed.has(taskId) || skipped.has(taskId)
  }

  /** Owns of every delegation still holding write scope (active or resumed). */
  function activeOwns(exceptId?: DelegationId): Array<{ id: DelegationId; owns: string[] }> {
    const out: Array<{ id: DelegationId; owns: string[] }> = []
    for (const [id, st] of delegations) {
      if (id === exceptId) continue
      if (st.status === 'active' || st.status === 'resumed') out.push({ id, owns: st.owns })
    }
    return out
  }

  function nextRunBudget(
    cost: IterationCost,
    spendNanos: number,
  ): { cost: IterationCost; spendNanos: number } | undefined {
    const iterations = runBudget.iterations + cost.iterations
    const wallMs = runBudget.wallMs + cost.wallMs
    const nextSpendNanos = runSpendNanos + spendNanos
    if (!Number.isSafeInteger(iterations) || !Number.isSafeInteger(wallMs) ||
      !Number.isSafeInteger(nextSpendNanos) || nextSpendNanos > Number.MAX_SAFE_INTEGER) {
      return undefined
    }
    const spendUsd = spendUsdFromNanos(nextSpendNanos)
    if (spendUsd === undefined) return undefined
    return { cost: { iterations, spendUsd, wallMs }, spendNanos: nextSpendNanos }
  }

  function applyRunBudget(next: { cost: IterationCost; spendNanos: number }): void {
    Object.assign(runBudget, next.cost)
    runSpendNanos = next.spendNanos
  }

  function withinDelegationBudget(
    state: DelegationState,
    cost: IterationCost,
    spendNanos: number,
  ): boolean {
    // Budget caps use the same decimal half-up nanos as charged costs. Raw
    // binary floating-point comparisons would make a 0.1/0.2 boundary order-
    // dependent and are therefore never an authority decision.
    const sliceNanos = iterationCostSpendNanos(state.task.budgetSlice.spendUsd)
    return cost.iterations <= state.task.budgetSlice.iterations &&
      cost.iterations <= state.task.retryPolicy.maxIterations &&
      cost.iterations <= state.card.maxIterations &&
      sliceNanos !== undefined && spendNanos <= sliceNanos
  }

  function sameValue(left: unknown, right: unknown): boolean {
    return stableStringify(left) === stableStringify(right)
  }

  function bindingIsActive(candidate: typeof binding): boolean {
    try {
      return deps.isBindingActive?.(candidate) ?? true
    } catch {
      return false
    }
  }

  function checkpointFor(delegationId: DelegationId, state: DelegationState): DelegationCheckpoint {
    const last = state.entries[state.entries.length - 1]
    return {
      delegationId,
      taskId: state.task.taskId,
      binding: bindingView(),
      scope: safeClone(state.task.scope),
      snapshotPrefixHash: last?.hash ?? SHARD_GENESIS,
      lastSeq: last?.seq ?? 0,
    }
  }

  function persistedState(
    delegationId: DelegationId,
    state: DelegationState,
  ): PersistedDelegationV1 {
    const checkpoint = checkpoints.get(delegationId) ?? checkpointFor(delegationId, state)
    return {
      schemaVersion: 1,
      runId,
      binding: bindingView(),
      task: safeClone(state.task),
      card: safeClone(state.card),
      owns: [...state.owns],
      writableMcp: [...state.writableMcp],
      permittedTools: [...state.permittedTools].sort(),
      entries: state.entries.map(cloneEntry),
      checkpoint: safeClone(checkpoint),
      status: state.status,
      ...(state.terminalObservation === undefined
        ? {}
        : { terminalObservation: safeClone(state.terminalObservation) }),
    }
  }

  function persistedRunState(): PersistedDelegationRunV1 {
    const spendUsd = spendUsdFromNanos(runSpendNanos)
    if (spendUsd === undefined) throw new Error('invalid delegation run spend')
    return {
      schemaVersion: 1,
      runId,
      binding: bindingView(),
      runBudget: { ...runBudget, spendUsd },
      activeTaskIds: [...delegations.values()]
        .filter(state => state.status === 'active' || state.status === 'resumed')
        .map(state => state.task.taskId)
        .sort(),
      completedTaskIds: [...completed].sort(),
      failedTaskIds: [...failed].sort(),
      skippedTaskIds: [...skipped].sort(),
    }
  }

  function persist(delegationId: DelegationId, state: DelegationState): void {
    if (deps.persistence === undefined) return
    // Child first, shared ledger second. A crash between the two is detected by
    // status-vs-ledger validation and quarantined; it can never lower budget.
    deps.persistence.save(persistedState(delegationId, state))
    deps.persistence.saveRun(persistedRunState())
  }

  function persistRun(): void {
    deps.persistence?.saveRun(persistedRunState())
  }

  function quarantine(
    delegationId: DelegationId,
    reason: DelegationQuarantineReason,
    value: unknown,
  ): never {
    try {
      deps.persistence?.quarantine(delegationId, reason, value)
    } catch {
      // Quarantine persistence is best-effort; never replace the stable,
      // code-owned resume denial with an adapter-specific error.
    } finally {
      emit('delegation.quarantined', { delegationId, reason })
    }
    throw new DelegationResumeError(reason, `delegation '${delegationId}' quarantined: ${reason}`)
  }

  function entriesVerify(entries: ShardEntry[], delegationId: DelegationId): boolean {
    try {
      let prev = SHARD_GENESIS
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!
        if (typeof e !== 'object' || e === null || e.delegationId !== delegationId ||
          e.seq !== i + 1 || e.prevHash !== prev || typeof e.kind !== 'string' ||
          typeof e.ts !== 'string' || typeof e.hash !== 'string' ||
          e.hash.length !== 64 || e.prevHash.length !== 64 || e.payload === undefined) return false
        const recomputed = shardEntryHash({
          delegationId: e.delegationId,
          seq: e.seq,
          prevHash: e.prevHash,
          kind: e.kind,
          payload: e.payload,
          ts: e.ts,
        })
        if (recomputed !== e.hash) return false
        prev = e.hash
      }
      return true
    } catch {
      return false
    }
  }

  function terminalObservationValid(
    value: unknown,
    delegationId: DelegationId,
    status: 'completed' | 'failed',
    owns: string[],
    budget: IterationCost,
  ): value is TaskObservation {
    if (typeof value !== 'object' || value === null) return false
    const observation = value as Partial<TaskObservation>
    const cost = observation.cost
    const canonicalCost = typeof cost === 'object' && cost !== null
      ? canonicalizeIterationCost(cost)
      : undefined
    const canonicalBudget = canonicalizeIterationCost(budget)
    const costNanos = canonicalCost === undefined
      ? undefined
      : iterationCostSpendNanos(canonicalCost.spendUsd)
    const budgetNanos = canonicalBudget === undefined
      ? undefined
      : iterationCostSpendNanos(canonicalBudget.spendUsd)
    let payloadValid = status === 'failed' && observation.result === undefined
    if (status === 'completed') {
      try {
        assertBoundedSerializable(observation.result)
        payloadValid = true
      } catch {
        payloadValid = false
      }
    }
    return observation.delegationId === delegationId && observation.status === status &&
      typeof observation.summary === 'string' && Array.isArray(observation.touched) &&
      observation.summary.trim().length > 0 && Buffer.byteLength(observation.summary, 'utf8') <= 8 * 1024 &&
      observation.touched.every(path => typeof path === 'string') &&
      sameValue(observation.touched, owns) && canonicalCost !== undefined &&
      canonicalBudget !== undefined && sameValue(cost, canonicalCost) &&
      sameValue(budget, canonicalBudget) && costNanos !== undefined &&
      budgetNanos !== undefined && canonicalCost.iterations <= canonicalBudget.iterations &&
      costNanos <= budgetNanos && canonicalCost.wallMs <= canonicalBudget.wallMs && payloadValid
  }

  function validationFailure(
    delegationId: DelegationId,
    reason: DelegationQuarantineReason,
  ): never {
    throw new PersistedDelegationValidationError(delegationId, reason)
  }

  function validatePersistedRun(
    delegationId: DelegationId,
    value: unknown,
  ): PersistedDelegationRunV1 {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    const raw = value as Partial<PersistedDelegationRunV1>
    if (raw.schemaVersion !== 1 || typeof raw.runId !== 'string' || raw.runId.length === 0 ||
      raw.runBudget === undefined || !Array.isArray(raw.activeTaskIds) ||
      !Array.isArray(raw.completedTaskIds) || !Array.isArray(raw.failedTaskIds) ||
      !Array.isArray(raw.skippedTaskIds)) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    let runBinding
    try {
      runBinding = resolvedWorkBinding(raw.binding)
    } catch {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    if (!sameValue(runBinding, binding)) {
      return validationFailure(delegationId, 'binding-mismatch')
    }
    if (!bindingIsActive(runBinding)) {
      return validationFailure(delegationId, 'binding-inactive')
    }
    const budget = raw.runBudget
    const canonicalBudget = canonicalizeIterationCost(budget)
    if (canonicalBudget === undefined || !sameValue(budget, canonicalBudget)) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    const stateLists = [
      raw.activeTaskIds,
      raw.completedTaskIds,
      raw.failedTaskIds,
      raw.skippedTaskIds,
    ]
    if (stateLists.some(list => list.some(id =>
      typeof id !== 'string' || !tasksById.has(id))) ||
      new Set(stateLists.flat()).size !== stateLists.flat().length) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    return {
      schemaVersion: 1,
      runId: raw.runId,
      binding: safeClone(runBinding),
      runBudget: canonicalBudget,
      activeTaskIds: [...raw.activeTaskIds],
      completedTaskIds: [...raw.completedTaskIds],
      failedTaskIds: [...raw.failedTaskIds],
      skippedTaskIds: [...raw.skippedTaskIds],
    }
  }

  function validatePersistedDelegation(
    delegationId: DelegationId,
    value: unknown,
    run: PersistedDelegationRunV1,
  ): ValidatedDelegationSnapshot {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    const storageMarker = value as { storageStatus?: unknown; reason?: unknown }
    if (storageMarker.storageStatus === 'quarantined' &&
      isDelegationQuarantineReason(storageMarker.reason)) {
      return validationFailure(delegationId, storageMarker.reason)
    }
    const raw = value as Partial<PersistedDelegationV1>
    if (raw.schemaVersion !== 1 || raw.runId !== run.runId || raw.checkpoint === undefined ||
      raw.task === undefined || raw.card === undefined || !Array.isArray(raw.entries) ||
      !Array.isArray(raw.owns) || !Array.isArray(raw.writableMcp) ||
      !Array.isArray(raw.permittedTools) ||
      (raw.status !== 'active' && raw.status !== 'failed' && raw.status !== 'resumed' &&
        raw.status !== 'completed')) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }

    let persistedBinding
    try {
      persistedBinding = resolvedWorkBinding(raw.binding)
    } catch {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    if (!sameValue(persistedBinding, binding)) {
      return validationFailure(delegationId, 'binding-mismatch')
    }
    if (!bindingIsActive(persistedBinding)) {
      return validationFailure(delegationId, 'binding-inactive')
    }

    const task = tasksById.get(raw.task.taskId)
    const currentCard = task?.assignedTo === null || task?.assignedTo === undefined
      ? undefined
      : deps.resolveCard(task.assignedTo)
    if (task === undefined || delegationId !== delegationIdFor(task.taskId) ||
      currentCard === undefined || !sameValue(raw.task, task) ||
      !sameValue(raw.card, currentCard) || !sameValue(raw.owns, task.scope.owns) ||
      !sameValue([...raw.permittedTools].sort(), Object.keys(currentCard.toolTiers).sort()) ||
      !sameValue(raw.writableMcp, currentCard.mcpAllowlist.filter(s => deps.mcpWritable(s)))) {
      return validationFailure(delegationId, 'task-or-card-mismatch')
    }

    const inGrantedLane = (p: string): boolean =>
      task.scope.owns.some(g => globMatches(g, p)) &&
      !task.scope.doNotTouch.some(g => globMatches(g, p))
    if (currentCard.skills.flatMap(s => deps.skillTouchedPaths(s)).some(p => !inGrantedLane(p))) {
      return validationFailure(delegationId, 'task-or-card-mismatch')
    }
    if (!entriesVerify(raw.entries, delegationId)) {
      return validationFailure(delegationId, 'shard-integrity-failed')
    }

    const last = raw.entries[raw.entries.length - 1]
    const expectedCheckpoint: DelegationCheckpoint = {
      delegationId,
      taskId: task.taskId,
      binding: bindingView(),
      scope: safeClone(task.scope),
      snapshotPrefixHash: last?.hash ?? SHARD_GENESIS,
      lastSeq: last?.seq ?? 0,
    }
    if (!sameValue(raw.checkpoint, expectedCheckpoint)) {
      return validationFailure(delegationId, 'checkpoint-mismatch')
    }
    if (((raw.status === 'active' || raw.status === 'resumed') !==
        run.activeTaskIds.includes(task.taskId)) ||
      (raw.status === 'completed') !== run.completedTaskIds.includes(task.taskId) ||
      (raw.status === 'failed') !== run.failedTaskIds.includes(task.taskId) ||
      ((raw.status === 'active' || raw.status === 'resumed') &&
        [run.completedTaskIds, run.failedTaskIds, run.skippedTaskIds]
          .some(list => list.includes(task.taskId)))) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }
    const terminalStatus = raw.status === 'completed' || raw.status === 'failed'
    if ((terminalStatus && !terminalObservationValid(
      raw.terminalObservation,
      delegationId,
      raw.status as 'completed' | 'failed',
      raw.owns,
      run.runBudget,
    )) || (!terminalStatus && raw.terminalObservation !== undefined)) {
      return validationFailure(delegationId, 'legacy-or-invalid-state')
    }

    return {
      run,
      checkpoint: safeClone(expectedCheckpoint),
      state: {
        task,
        card: immutableAgentCard(currentCard),
        owns: [...raw.owns],
        writableMcp: [...raw.writableMcp],
        permittedTools: new Set(raw.permittedTools),
        entries: raw.entries.map(cloneEntry),
        guardian: makeLoopGuardian({}),
        status: raw.status,
        ...(raw.terminalObservation === undefined
          ? {}
          : { terminalObservation: safeClone(raw.terminalObservation) }),
      },
    }
  }

  function installRun(run: PersistedDelegationRunV1): void {
    const spendNanos = iterationCostSpendNanos(run.runBudget.spendUsd)
    if (spendNanos === undefined) {
      throw new DelegationResumeError('legacy-or-invalid-state', 'invalid delegation run spend')
    }
    runId = run.runId
    completed.clear()
    failed.clear()
    skipped.clear()
    for (const id of run.completedTaskIds) completed.add(id)
    for (const id of run.failedTaskIds) failed.add(id)
    for (const id of run.skippedTaskIds) skipped.add(id)
    Object.assign(runBudget, run.runBudget)
    runSpendNanos = spendNanos
  }

  function installSnapshots(snapshots: readonly ValidatedDelegationSnapshot[]): void {
    for (const snapshot of snapshots) {
      const delegationId = delegationIdFor(snapshot.state.task.taskId)
      delegations.set(delegationId, snapshot.state)
      checkpoints.set(delegationId, snapshot.checkpoint)
    }
  }

  function loadRunValue(): unknown {
    try {
      return deps.persistence?.loadRun()
    } catch {
      return undefined
    }
  }

  function loadDelegationValue(delegationId: DelegationId): unknown {
    try {
      return deps.persistence?.load(delegationId)
    } catch {
      return undefined
    }
  }

  function restorePersisted(
    delegationId: DelegationId,
    value: unknown,
  ): DelegationState {
    try {
      const run = validatePersistedRun(delegationId, loadRunValue())
      const snapshot = validatePersistedDelegation(delegationId, value, run)
      installRun(run)
      installSnapshots([snapshot])
      return snapshot.state
    } catch (error) {
      if (error instanceof PersistedDelegationValidationError) {
        return quarantine(delegationId, error.code, value)
      }
      throw error
    }
  }

  function validateActiveSnapshots(
    delegationIds: readonly DelegationId[],
    run: PersistedDelegationRunV1,
    rejectIssuedHandles: boolean,
  ): ValidatedDelegationSnapshot[] {
    const requested = [...delegationIds]
    if (new Set(requested).size !== requested.length) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'active recovery set contains duplicate ids')
    }
    const diagnosticId = requested[0] ?? 'active-set'
    const expected = run.activeTaskIds.map(delegationIdFor)
    const expectedSet = new Set(expected)
    if (requested.length !== expected.length || requested.some(id => !expectedSet.has(id))) {
      throw new DelegationResumeError(
        'NOT_RESUMABLE',
        'active recovery requires the exact persisted active set',
      )
    }
    if (rejectIssuedHandles && requested.some(id => issuedHandles.has(id))) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'active recovery set contains a replayed handle')
    }

    // Two-phase recovery: every child is loaded and validated against the same
    // immutable run snapshot before any in-memory authority is installed.
    const snapshots = requested.map(delegationId =>
      validatePersistedDelegation(delegationId, loadDelegationValue(delegationId), run))
    for (let i = 0; i < snapshots.length; i++) {
      for (let j = i + 1; j < snapshots.length; j++) {
        if (overlappingPaths(snapshots[i]!.state.owns, snapshots[j]!.state.owns).length > 0) {
          return validationFailure(diagnosticId, 'task-or-card-mismatch')
        }
      }
    }
    return snapshots
  }

  function prepareActiveRecovery(
    delegationIds: readonly DelegationId[],
  ): { run: PersistedDelegationRunV1; snapshots: ValidatedDelegationSnapshot[] } {
    if (deps.persistence === undefined) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'durable active recovery is unavailable')
    }
    const diagnosticId = delegationIds[0] ?? 'active-set'
    const run = validatePersistedRun(diagnosticId, loadRunValue())
    return { run, snapshots: validateActiveSnapshots(delegationIds, run, true) }
  }

  function prepareColdTargetRecovery(
    delegationId: DelegationId,
  ): { run: PersistedDelegationRunV1; snapshots: ValidatedDelegationSnapshot[]; target: DelegationState } {
    if (deps.persistence === undefined) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'durable recovery is unavailable')
    }
    const targetValue = loadDelegationValue(delegationId)
    let run: PersistedDelegationRunV1 | undefined
    try {
      run = validatePersistedRun(delegationId, loadRunValue())
      const activeIds = run.activeTaskIds.map(delegationIdFor)
      const snapshots = validateActiveSnapshots(activeIds, run, false)
      const activeTarget = snapshots.find(snapshot =>
        delegationIdFor(snapshot.state.task.taskId) === delegationId)
      if (activeTarget !== undefined) return { run, snapshots, target: activeTarget.state }

      const target = validatePersistedDelegation(delegationId, targetValue, run)
      return { run, snapshots: [...snapshots, target], target: target.state }
    } catch (error) {
      // Preserve historical quarantine for a corrupt requested terminal/failed
      // record. An active-set sibling failure remains a pure all-or-nothing
      // denial: never quarantine the innocent requested record.
      const targetIsActive = run?.activeTaskIds.map(delegationIdFor).includes(delegationId) ?? false
      if (error instanceof PersistedDelegationValidationError &&
        error.delegationId === delegationId && !targetIsActive) {
        return quarantine(delegationId, error.code, targetValue)
      }
      throw error
    }
  }

  function prepareRecoveryPreflight(): DelegationRecoveryPreflight {
    if (deps.persistence === undefined) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'durable recovery is unavailable')
    }
    if (delegations.size !== 0 || issuedHandles.size !== 0) {
      throw new DelegationResumeError('NOT_RESUMABLE', 'recovery preflight requires a cold manager')
    }

    let runValue: unknown
    const values = new Map<DelegationId, unknown>()
    try {
      runValue = deps.persistence.loadRun()
      for (const task of dagPlan.nodes) {
        const delegationId = delegationIdFor(task.taskId)
        values.set(delegationId, deps.persistence.load(delegationId))
      }
    } catch {
      throw new DelegationResumeError('legacy-or-invalid-state', 'delegation recovery state unavailable')
    }
    if (runValue === undefined) {
      if ([...values.values()].some(value => value !== undefined)) {
        throw new DelegationResumeError('legacy-or-invalid-state', 'orphan delegation state')
      }
      return Object.freeze({ status: 'none' as const })
    }

    const run = validatePersistedRun('run-inventory', runValue)
    const durableTaskIds = new Set([
      ...run.activeTaskIds,
      ...run.completedTaskIds,
      ...run.failedTaskIds,
    ])
    const snapshots: ValidatedDelegationSnapshot[] = []
    for (const task of dagPlan.nodes) {
      const delegationId = delegationIdFor(task.taskId)
      const value = values.get(delegationId)
      if (!durableTaskIds.has(task.taskId)) {
        if (value !== undefined) {
          return validationFailure(delegationId, 'legacy-or-invalid-state')
        }
        continue
      }
      snapshots.push(validatePersistedDelegation(delegationId, value, run))
    }
    if (snapshots.length === 0) {
      return validationFailure('run-inventory', 'legacy-or-invalid-state')
    }

    const activeSnapshots = snapshots.filter(snapshot =>
      snapshot.state.status === 'active' || snapshot.state.status === 'resumed')
    for (let i = 0; i < activeSnapshots.length; i++) {
      for (let j = i + 1; j < activeSnapshots.length; j++) {
        if (overlappingPaths(
          activeSnapshots[i]!.state.owns,
          activeSnapshots[j]!.state.owns,
        ).length > 0) {
          return validationFailure('run-inventory', 'task-or-card-mismatch')
        }
      }
    }

    const terminalObservations = snapshots.flatMap(snapshot =>
      snapshot.state.terminalObservation === undefined
        ? []
        : [safeClone(snapshot.state.terminalObservation)])
    let iterations = 0
    let wallMs = 0
    let spendNanos = 0
    for (const observation of terminalObservations) {
      const observationSpend = iterationCostSpendNanos(observation.cost.spendUsd)
      if (observationSpend === undefined) {
        return validationFailure(observation.delegationId, 'legacy-or-invalid-state')
      }
      iterations += observation.cost.iterations
      wallMs += observation.cost.wallMs
      spendNanos += observationSpend
      if (!Number.isSafeInteger(iterations) || !Number.isSafeInteger(wallMs) ||
        !Number.isSafeInteger(spendNanos)) {
        return validationFailure('run-inventory', 'legacy-or-invalid-state')
      }
    }
    const runSpendNanos = iterationCostSpendNanos(run.runBudget.spendUsd)
    if (runSpendNanos === undefined || iterations !== run.runBudget.iterations ||
      wallMs !== run.runBudget.wallMs || spendNanos !== runSpendNanos) {
      return validationFailure('run-inventory', 'legacy-or-invalid-state')
    }

    const activeDelegationIds = Object.freeze(run.activeTaskIds.map(delegationIdFor))
    return Object.freeze({
      status: activeDelegationIds.length === 0 ? 'terminal' as const : 'continuation' as const,
      activeDelegationIds,
      terminalObservations: Object.freeze(terminalObservations),
      runBudget: Object.freeze({ ...run.runBudget }),
    })
  }

  function hydrateColdTarget(delegationId: DelegationId): DelegationState {
    const prepared = prepareColdTargetRecovery(delegationId)
    installRun(prepared.run)
    installSnapshots(prepared.snapshots)
    return prepared.target
  }

  function hydrateActiveSet(delegationIds: readonly DelegationId[]): DelegationState[] {
    const prepared = prepareActiveRecovery(delegationIds)
    installRun(prepared.run)
    installSnapshots(prepared.snapshots)
    return prepared.snapshots.map(snapshot => snapshot.state)
  }

  function appendShard(state: DelegationState, delegationId: DelegationId, kind: string, payload: unknown): ShardEntry {
    if (state.status !== 'active' && state.status !== 'resumed') {
      throw new DelegationResumeError('NOT_RESUMABLE', `delegation '${delegationId}' is terminal`)
    }
    assertBoundedSerializable(payload)
    const prev = state.entries[state.entries.length - 1]
    const seq = (prev?.seq ?? 0) + 1
    const prevHash = prev?.hash ?? SHARD_GENESIS
    const ts = new Date().toISOString()
    // Sever the caller's reference: store an independent deep copy so the
    // append-only shard stays tamper-evident (a circular payload fails fast at
    // the hash step below, never reaching storage).
    const stored = safeClone(payload)
    const base: Omit<ShardEntry, 'hash'> = { delegationId, seq, prevHash, kind, payload: stored, ts }
    const entry: ShardEntry = { ...base, hash: shardEntryHash(base) }
    const priorCheckpoint = checkpoints.get(delegationId)
    state.entries.push(entry)
    writeCheckpoint(delegationId, state)
    try {
      persist(delegationId, state)
    } catch (error) {
      state.entries.pop()
      if (priorCheckpoint === undefined) checkpoints.delete(delegationId)
      else checkpoints.set(delegationId, priorCheckpoint)
      throw error
    }
    return cloneEntry(entry)
  }

  function writeCheckpoint(delegationId: DelegationId, state: DelegationState): void {
    checkpoints.set(delegationId, checkpointFor(delegationId, state))
  }

  function restoreTerminalObservation(
    state: DelegationState,
    observation: TaskObservation | undefined,
  ): void {
    if (observation === undefined) delete state.terminalObservation
    else state.terminalObservation = observation
  }

  function makeHandle(delegationId: DelegationId, state: DelegationState): DelegationHandle {
    const epoch = (handleEpochs.get(delegationId) ?? 0) + 1
    handleEpochs.set(delegationId, epoch)
    issuedHandles.add(delegationId)
    const current = (): boolean => handleEpochs.get(delegationId) === epoch &&
      (state.status === 'active' || state.status === 'resumed')
    const assertCurrent = (): void => {
      if (!current()) {
        throw new DelegationResumeError('NOT_RESUMABLE', `delegation '${delegationId}' handle is no longer active`)
      }
    }
    return {
      delegationId,
      taskId: state.task.taskId,
      binding: bindingView(),
      card: state.card,
      owns: [...state.owns],
      writableMcp: [...state.writableMcp],
      permitsTool: (name: string) => current() && state.permittedTools.has(name),
      permitsMcp: (server: string) => current() && state.writableMcp.includes(server),
      append: (kind: string, payload: unknown) => {
        assertCurrent()
        return appendShard(state, delegationId, kind, payload)
      },
      shard: () => state.entries.map(cloneEntry),
      get guardian() {
        assertCurrent()
        return state.guardian
      },
      complete: (summary: string, result: unknown, cost: IterationCost) => {
        assertCurrent()
        const quantized = quantizedIterationCost(cost)
        if (quantized === undefined ||
          !withinDelegationBudget(state, quantized.cost, quantized.spendNanos)) {
          throw new Error('invalid delegation cost')
        }
        if (typeof summary !== 'string' || summary.trim().length === 0 ||
          Buffer.byteLength(summary, 'utf8') > 8 * 1024) {
          throw new Error('invalid delegation summary')
        }
        assertBoundedSerializable(result)
        const nextBudget = nextRunBudget(quantized.cost, quantized.spendNanos)
        if (nextBudget === undefined) throw new Error('invalid delegation cost')
        const priorStatus = state.status
        const priorBudget = { ...runBudget }
        const priorSpendNanos = runSpendNanos
        const priorObservation = state.terminalObservation
        const observation: TaskObservation = {
          delegationId,
          status: 'completed',
          summary,
          touched: [...state.owns],
          result: safeClone(result),
          cost: { ...quantized.cost },
        }
        state.status = 'completed'
        state.terminalObservation = observation
        completed.add(state.task.taskId)
        applyRunBudget(nextBudget)
        writeCheckpoint(delegationId, state)
        try {
          persist(delegationId, state)
        } catch (error) {
          state.status = priorStatus
          restoreTerminalObservation(state, priorObservation)
          completed.delete(state.task.taskId)
          Object.assign(runBudget, priorBudget)
          runSpendNanos = priorSpendNanos
          throw error
        }
        emit('delegation.completed', { delegationId, taskId: state.task.taskId })
        return safeClone(observation)
      },
      fail: (summary: string, cost: IterationCost) => {
        assertCurrent()
        const quantized = quantizedIterationCost(cost)
        if (quantized === undefined) throw new Error('invalid delegation cost')
        if (typeof summary !== 'string' || summary.trim().length === 0 ||
          Buffer.byteLength(summary, 'utf8') > 8 * 1024) {
          throw new Error('invalid delegation summary')
        }
        const nextBudget = nextRunBudget(quantized.cost, quantized.spendNanos)
        if (nextBudget === undefined) throw new Error('invalid delegation cost')
        const priorStatus = state.status
        const priorBudget = { ...runBudget }
        const priorSpendNanos = runSpendNanos
        const priorObservation = state.terminalObservation
        const observation: TaskObservation = {
          delegationId,
          status: 'failed',
          summary,
          touched: [...state.owns],
          result: undefined,
          cost: { ...quantized.cost },
        }
        state.status = 'failed'
        state.terminalObservation = observation
        failed.add(state.task.taskId)
        applyRunBudget(nextBudget)
        writeCheckpoint(delegationId, state)
        try {
          persist(delegationId, state)
        } catch (error) {
          state.status = priorStatus
          restoreTerminalObservation(state, priorObservation)
          failed.delete(state.task.taskId)
          Object.assign(runBudget, priorBudget)
          runSpendNanos = priorSpendNanos
          throw error
        }
        emit('delegation.failed', { delegationId, taskId: state.task.taskId })
        return safeClone(observation)
      },
    }
  }

  function loadDelegationState(delegationId: DelegationId): DelegationState {
    const current = delegations.get(delegationId)
    if (current !== undefined) return current
    if (deps.persistence === undefined) {
      throw new Error(`cannot recover unknown delegation '${delegationId}'`)
    }
    return restorePersisted(delegationId, loadDelegationValue(delegationId))
  }

  function loadRecoveryTarget(delegationId: DelegationId): DelegationState {
    const current = delegations.get(delegationId)
    if (current !== undefined) return current
    if (deps.persistence !== undefined && delegations.size === 0) {
      return hydrateColdTarget(delegationId)
    }
    return loadDelegationState(delegationId)
  }

  function resumeState(delegationId: DelegationId, state: DelegationState): DelegationHandle {
    const cp = checkpoints.get(delegationId)
    if (cp === undefined) throw new Error(`no checkpoint for '${delegationId}' — nothing to resume`)
    if (!bindingIsActive(binding)) {
      return quarantine(delegationId, 'binding-inactive', persistedState(delegationId, state))
    }
    if (!entriesVerify(state.entries, delegationId)) {
      return quarantine(delegationId, 'shard-integrity-failed', persistedState(delegationId, state))
    }
    if (!sameValue(cp, checkpointFor(delegationId, state))) {
      return quarantine(delegationId, 'checkpoint-mismatch', persistedState(delegationId, state))
    }
    for (const other of activeOwns(delegationId)) {
      const overlap = overlappingPaths(state.owns, other.owns)
      if (overlap.length > 0) throw new ScopeConflictError(other.id, delegationId, overlap)
    }

    const priorStatus = state.status
    const priorGuardian = state.guardian
    const priorObservation = state.terminalObservation
    failed.delete(state.task.taskId)
    state.status = 'resumed'
    delete state.terminalObservation
    state.guardian = makeLoopGuardian({})
    try {
      persist(delegationId, state)
    } catch (error) {
      state.status = priorStatus
      state.guardian = priorGuardian
      restoreTerminalObservation(state, priorObservation)
      if (priorStatus === 'failed') failed.add(state.task.taskId)
      throw error
    }
    emit('delegation.resumed', { delegationId, fromSeq: cp.lastSeq })
    return makeHandle(delegationId, state)
  }

  return {
    dag(): PlanDAG {
      return { nodes: [...dagPlan.nodes], edges: [...dagPlan.edges] }
    },

    readySet(): DelegationTask[] {
      // Deterministic: input order, a task ready only when every dependency has
      // COMPLETED and it has not itself run / been spawned (AC-11-16).
      return dagPlan.nodes.filter(
        t =>
          !isTerminal(t.taskId) &&
          !delegations.has(delegationIdFor(t.taskId)) &&
          t.dependsOn.every(dep => completed.has(dep)),
      )
    },

    spawn(taskId: string, requested?: CapabilityRequest): DelegationHandle {
      const task = tasksById.get(taskId)
      if (task === undefined) throw new Error(`unknown delegation task '${taskId}'`)
      const delegationId = delegationIdFor(taskId)
      if (delegations.has(delegationId)) {
        throw new Error(`delegation '${delegationId}' already spawned — use resume()`)
      }
      if (failed.has(taskId) || skipped.has(taskId)) {
        throw new Error(`task '${taskId}' is terminal (failed/cascade-skipped) and not runnable`)
      }
      // Deterministic ready-set: refuse a task whose upstream has not completed.
      const unmet = task.dependsOn.filter(d => !completed.has(d))
      if (unmet.length > 0) {
        throw new Error(`task '${taskId}' not ready: unmet dependencies [${unmet.join(', ')}]`)
      }
      if (task.assignedTo === null) {
        throw new Error(`task '${taskId}' has no assigned AgentCard`)
      }
      const card = deps.resolveCard(task.assignedTo)
      if (card === undefined) throw new Error(`AgentCard '${task.assignedTo}' not found`)

      // §5.5 scope composition. The granted lane is owns minus doNotTouch; a
      // declared skill writing outside it is a ScopeConflictError and no
      // sub-agent starts. owns = task.scope.owns ∪ skill-touched, which equals
      // task.scope.owns precisely because skill-touched ⊆ the granted lane.
      const inGrantedLane = (p: string): boolean =>
        task.scope.owns.some(g => globMatches(g, p)) &&
        !task.scope.doNotTouch.some(g => globMatches(g, p))
      const skillTouched = card.skills.flatMap(s => deps.skillTouchedPaths(s))
      const outOfLane = skillTouched.filter(p => !inGrantedLane(p))
      if (outOfLane.length > 0) {
        emit('scope.violation', { delegationId, taskId, reason: 'skill-outside-lane', paths: outOfLane })
        throw new ScopeConflictError(delegationId, `card:${card.name}`, outOfLane)
      }
      const owns = [...task.scope.owns]

      // Pairwise write-disjointness across ALL active delegations (§5.5).
      for (const other of activeOwns()) {
        const overlap = overlappingPaths(owns, other.owns)
        if (overlap.length > 0) throw new ScopeConflictError(other.id, delegationId, overlap)
      }

      // Capabilities are the card's; any model-emitted request that exceeds the
      // card is ignored — the card is the sole authority (AC-11-17).
      void requested
      const permittedTools = new Set(Object.keys(card.toolTiers))
      const writableMcp = card.mcpAllowlist.filter(s => deps.mcpWritable(s))

      const state: DelegationState = {
        task,
        card: immutableAgentCard(card),
        owns,
        writableMcp,
        permittedTools,
        entries: [],
        guardian: makeLoopGuardian({}),
        status: 'active',
      }
      delegations.set(delegationId, state)
      writeCheckpoint(delegationId, state)
      try {
        persist(delegationId, state)
      } catch (error) {
        delegations.delete(delegationId)
        checkpoints.delete(delegationId)
        throw error
      }
      emit('delegation.spawned', {
        delegationId,
        taskId,
        owns,
        card: card.name,
        binding: {
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          scope: binding.scope,
        },
      })
      return makeHandle(delegationId, state)
    },

    resume(delegationId: DelegationId): DelegationHandle {
      const state = loadRecoveryTarget(delegationId)
      if (state.status === 'completed') {
        throw new DelegationResumeError('NOT_RESUMABLE', `delegation '${delegationId}' already completed`)
      }
      if (state.status !== 'failed') {
        throw new DelegationResumeError('NOT_RESUMABLE', `delegation '${delegationId}' is not failed`)
      }
      return resumeState(delegationId, state)
    },

    recover(delegationId: DelegationId): DelegationRecoveryResult {
      // The first durable access validates and installs every active sibling
      // plus this target before exposing any state. Later accesses reuse that
      // manager-owned complete run view.
      const state = loadRecoveryTarget(delegationId)
      if (state.status === 'completed' || state.status === 'failed') {
        const observation = state.terminalObservation
        if (observation === undefined) {
          return quarantine(delegationId, 'legacy-or-invalid-state', persistedState(delegationId, state))
        }
        return { status: 'terminal', observation: safeClone(observation) }
      }
      if (issuedHandles.has(delegationId)) {
        throw new DelegationResumeError('NOT_RESUMABLE', `delegation '${delegationId}' already has an active handle`)
      }
      return { status: 'resumable', handle: makeHandle(delegationId, state) }
    },

    preflightRecovery(): DelegationRecoveryPreflight {
      return prepareRecoveryPreflight()
    },

    recoverActive(delegationIds: readonly DelegationId[]): DelegationHandle[] {
      const states = hydrateActiveSet(delegationIds)
      return delegationIds.map((delegationId, index) => makeHandle(delegationId, states[index]!))
    },

    schedule(): ScheduleResult {
      // Cascade-skip: any non-terminal task with a failed or already-skipped
      // ancestor is skipped, transitively, with an explicit journal entry — no
      // silent drop (AC-11-20). Once skipped, a task is terminal and not re-emitted.
      let changed = true
      const newlySkipped: string[] = []
      while (changed) {
        changed = false
        for (const t of dagPlan.nodes) {
          if (isTerminal(t.taskId)) continue
          const blocked = t.dependsOn.some(d => failed.has(d) || skipped.has(d))
          if (blocked) {
            skipped.add(t.taskId)
            changed = true
            newlySkipped.push(t.taskId)
          }
        }
      }
      if (newlySkipped.length > 0) {
        try {
          persistRun()
        } catch (error) {
          for (const taskId of newlySkipped) skipped.delete(taskId)
          throw error
        }
        for (const taskId of newlySkipped) {
          emit('cascade-skip', { taskId, reason: 'upstream-failed' })
        }
      }
      const ready = dagPlan.nodes
        .filter(
          t =>
            !isTerminal(t.taskId) &&
            !delegations.has(delegationIdFor(t.taskId)) &&
            t.dependsOn.every(dep => completed.has(dep)),
        )
        .map(t => t.taskId)
      const cascadeSkipped = dagPlan.nodes.filter(t => skipped.has(t.taskId)).map(t => t.taskId)
      return { ready, cascadeSkipped }
    },

    runBudgetSpent(): IterationCost {
      const spendUsd = spendUsdFromNanos(runSpendNanos)
      if (spendUsd === undefined) throw new Error('invalid delegation run spend')
      return { ...runBudget, spendUsd }
    },

    verifyShardChain(delegationId: DelegationId): boolean {
      const state = delegations.get(delegationId)
      if (state === undefined) return false
      return entriesVerify(state.entries, delegationId)
    },

    terminalObservation(delegationId: DelegationId): TaskObservation | undefined {
      const observation = delegations.get(delegationId)?.terminalObservation
      return observation === undefined ? undefined : safeClone(observation)
    },
  }
}

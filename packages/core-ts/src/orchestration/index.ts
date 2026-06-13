// Orchestration — Component 11
// Deterministic control plane for multi-step work: coordinator-workers topology
// (ADR-0021), Loop Guardian retry cap (ADR-0020), generations (ADR-0005).
// See docs/specs/11-orchestration.md.

import { randomUUID } from 'node:crypto'

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
} from './types.js'

export { ScopeConflictError, ScopeViolationError } from './types.js'

import {
  ScopeConflictError,
  ScopeViolationError,
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
  type WorkerBrief,
  type WorkerHandle,
  type WorkerId,
  type WorkerScope,
} from './types.js'

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

function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path)
}

/** Literal prefix of a glob — everything before the first wildcard. */
function globRoot(glob: string): string {
  const wildcardIdx = glob.search(/[*?]/)
  return wildcardIdx === -1 ? glob : glob.slice(0, wildcardIdx)
}

/**
 * Conservative may-overlap test between two scope patterns: equal patterns or
 * one literal root being a prefix of the other are treated as overlapping.
 * Used for the pairwise write-disjointness assertion (ADR-0021, AC-11-1).
 */
function patternsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const ra = globRoot(a)
  const rb = globRoot(b)
  return ra.startsWith(rb) || rb.startsWith(ra)
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

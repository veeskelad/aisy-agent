// Orchestration types — Component 11
// Pure interfaces; no implementation. See docs/specs/11-orchestration.md §3.

export type RunId = string
export type WorkerId = string
export type GenerationId = string

// ─── Budget & spend ───────────────────────────────────────────────────────────

export interface BudgetSlice {
  /** Max tool/iteration dispatches this worker may consume. */
  iterations: number
  /** USD ceiling for this worker's share of the run. */
  spendUsd: number
}

export interface IterationCost {
  iterations: number
  spendUsd: number
  wallMs: number
}

export type BudgetVerdict =
  | { ok: true }
  | { capped: true; reason: 'loop-guardian' | 'replan-exhausted' | 'global-budget' }

export interface GlobalBudgetCounters {
  iterationCap: number
  iterations: number
  spendCapUsd: number
  spendUsd: number
  wallCapMs: number
  wallMs: number
}

export interface NestedBudgetCounters {
  loopGuardianTrips: number
  planReplans: number
  skillFailures: Record<string, number>
}

export interface BudgetLedger {
  runId: RunId
  global: GlobalBudgetCounters
  nested: NestedBudgetCounters
}

// ─── Worker scope ─────────────────────────────────────────────────────────────

export type TaskClass = 'reasoning' | 'critique' | 'routine'

export interface WorkerScope {
  /** Glob paths / resource ids this worker may write. */
  owns: string[]
  /** Explicit denylist — overrides `owns` on conflict. */
  doNotTouch: string[]
  /** Handed to Provider Routing (09). */
  taskClass: TaskClass
  /** Share of the run's global cap. */
  budgetSlice: BudgetSlice
}

export interface WorkerBrief {
  workerId: WorkerId
  /** Model-written: what this worker should accomplish. */
  intent: string
  /** Code-enforced scope contract. */
  scope: WorkerScope
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export interface Task {
  description: string
  /** Paths/resources this task may affect (superset; workers carve out subsets). */
  affectedPaths: string[]
  [key: string]: unknown
}

// ─── Decision Journal ─────────────────────────────────────────────────────────

/** One immutable line in the Decision Journal (JSONL, one per line). */
export interface JournalEntry {
  runId: RunId
  generationId: GenerationId
  /** 'coordinator' for reconciliation entries. */
  workerId: WorkerId
  /** Monotonic per run; a gap is a tamper signal. */
  seq: number
  decidedFor: string
  /** May be empty string when there was no competing option. */
  decidedAgainst: string
  because: string
  /** Paths/resources this decision wrote; checked against scope.owns. */
  touched: string[]
  /** ISO-8601 timestamp. */
  ts: string
}

export interface ReconcileResult {
  merged?: JournalEntry[]
  conflicts?: ConflictRecord[]
  /** Halt reason when reconciliation aborts (e.g. seq gap). */
  aborted?: 'seq-gap' | 'untrusted'
}

export interface ConflictRecord {
  entryA: JournalEntry
  entryB: JournalEntry
  resource: string
}

// ─── Worker handle ────────────────────────────────────────────────────────────

/** Opaque handle returned by Coordinator.spawn(). Workers have no peer handles. */
export interface WorkerHandle {
  workerId: WorkerId
  /** Append a decision to the shared journal. Throws ScopeViolationError on scope breach. */
  appendDecision(entry: Omit<JournalEntry, 'runId' | 'generationId' | 'workerId'>): void
  /** Resolve when the worker has finished its task. */
  done: Promise<void>
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export interface Coordinator {
  /**
   * Decompose a task into worker briefs whose scope.owns sets are pairwise write-disjoint.
   * Model call (~70%); scope disjointness assertion is code.
   */
  decompose(task: Task, gen: GenerationId): WorkerBrief[]

  /**
   * Spawn an isolated worker (Core loop + Safety sandbox).
   * Throws ScopeConflictError if the brief's scope overlaps any already-spawned worker.
   */
  spawn(brief: WorkerBrief): Promise<WorkerHandle>

  /**
   * Read the whole journal for this run and merge; resolves FOR/AGAINST contradictions.
   * Returns { merged } on success, { conflicts[] } on irresolvable contradictions,
   * or { aborted } on integrity failure (seq gap).
   */
  reconcile(runId: RunId): ReconcileResult

  /**
   * Drive one iteration through the global budget backstop (§5.2 precedence).
   * Charges the run's BudgetGuard and, when it caps, halts fail-closed on the
   * tightest bound that fired. A `global-budget` cap is a dead-end (§5.3): the
   * coordinator forks a fresh generation (constitution + lessons only). Returns
   * the BudgetGuard verdict; once halted, every further call stays capped.
   */
  charge(cost: IterationCost): BudgetVerdict

  /**
   * Optional advisory input consumed from Skills (06), event `skill.failure.threshold`.
   * ADR-0025 / spec §5.2 + AC-11-10: N≥3 failures only lower a strategy's priority
   * in a worker's choice — this never halts the run and never blocks a spawn.
   */
  onSkillFailure?(skill: string): void
}

export interface CoordinatorDeps {
  journal: DecisionJournal
  budgetGuard: BudgetGuard
  loopGuardian: LoopGuardian
  generationManager: GenerationManager
  /** Emit an orchestration event to Observability (12). */
  emit(event: OrchestrationEvent): void
}

// ─── Worker (consumer interface) ─────────────────────────────────────────────

/**
 * A Worker is a Core loop instance. It knows its own scope and may only
 * write via appendDecision. It has no handle to any peer.
 */
export interface Worker {
  workerId: WorkerId
  scope: WorkerScope
  /** Run the worker's task. The worker must not call any peer handle. */
  run(): Promise<void>
}

// ─── Decision Journal ─────────────────────────────────────────────────────────

export interface DecisionJournal {
  /**
   * Append-only. Rejects any write whose `touched` set violates the worker's scope.
   * Throws ScopeViolationError on violation.
   */
  append(entry: JournalEntry): void

  /** Full read — coordinator-only. */
  read(runId: RunId): JournalEntry[]
}

// ─── Budget Guard ─────────────────────────────────────────────────────────────

export interface BudgetGuard {
  /**
   * Charge one iteration against the run's global budget.
   * Returns { ok } or { capped, reason } — the tightest bound that fired.
   */
  charge(runId: RunId, cost: IterationCost): BudgetVerdict

  status(runId: RunId): { iterations: number; spendUsd: number; wallMs: number }
}

// ─── Loop Guardian ────────────────────────────────────────────────────────────

export type LoopPeriod = 1 | 2 | 3

export interface LoopStep {
  /** Opaque identifier for the action taken at this step (e.g. tool name + args hash). */
  actionId: string
  /** Iteration index within the run. */
  seq: number
}

export type GuardianVerdict =
  | { pass: true }
  | { stop: true; period: LoopPeriod; repeatCount: number; windowSnapshot: LoopStep[] }

export interface LoopGuardian {
  /**
   * Feed the next step into the sliding-window cycle detector.
   * Returns { pass } or { stop, period, repeatCount } when a period-1/2/3 cycle
   * has repeated more than 3 times.
   */
  check(step: LoopStep): GuardianVerdict

  /** Reset the detector (e.g. after a generation fork). */
  reset(): void
}

export interface LoopGuardianConfig {
  /** Number of repetitions before a STOP is issued. Default: 3. */
  maxRepeats?: number
  /** Maximum window size to scan for cycles. Default: 32. */
  windowSize?: number
}

// ─── Generation Manager ───────────────────────────────────────────────────────

export interface DistilledLesson {
  /** Short, model-written summary of why the prior generation failed. */
  summary: string
}

export interface GenerationManifest {
  generationId: GenerationId
  parent: GenerationId | null
  /** Always ['constitution'] + distilledLessons. Failed transcript NOT included. */
  carries: string[]
  distilledLessons: DistilledLesson[]
  droppedTranscriptOf: GenerationId | null
}

export interface GenerationManager {
  /**
   * Called when a run is judged dead-ended.
   * The new generation carries constitution + lessons only; the failed transcript is dropped.
   * Per-generation counters reset; the run-level spend cap is NOT reset.
   */
  fork(runId: RunId, lessons: DistilledLesson[]): GenerationId

  getManifest(generationId: GenerationId): GenerationManifest | undefined
}

// ─── Orchestration events (emitted to Observability 12) ──────────────────────

export type OrchestrationEventKind =
  | 'run.started'
  | 'worker.spawned'
  | 'journal.appended'
  | 'scope.violation'
  | 'budget.capped'
  | 'generation.forked'
  | 'run.reconciled'
  | 'run.terminated'

export interface OrchestrationEvent {
  kind: OrchestrationEventKind
  runId: RunId
  ts: string
  payload?: unknown
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class ScopeConflictError extends Error {
  constructor(
    public readonly workerA: WorkerId,
    public readonly workerB: WorkerId,
    public readonly overlappingPaths: string[],
  ) {
    super(
      `Scope conflict between worker '${workerA}' and '${workerB}' ` +
      `on paths: ${overlappingPaths.join(', ')}`,
    )
    this.name = 'ScopeConflictError'
  }
}

export class ScopeViolationError extends Error {
  constructor(
    public readonly workerId: WorkerId,
    public readonly violatingPaths: string[],
    public readonly reason: 'outside-owns' | 'inside-doNotTouch',
  ) {
    super(
      `Scope violation by worker '${workerId}': ` +
      `paths [${violatingPaths.join(', ')}] violate scope (${reason})`,
    )
    this.name = 'ScopeViolationError'
  }
}

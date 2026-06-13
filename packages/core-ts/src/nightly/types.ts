// §3 interfaces — pure types, no implementation

// ---------------------------------------------------------------------------
// Primitives shared across the pipeline
// ---------------------------------------------------------------------------

export type Stage = 'archival' | 'consolidation' | 'lint-pass' | 'skill-hygiene' | 'disk-hygiene' | 'backup'

export type ValidatorId = 'refs_exist' | 'no_conflicts' | 'dry_run_ok' | 'has_check_section'

/** (entity, relation, object) equivalence-class key; owned by Memory (03). */
export interface FactKey {
  entity: string
  relation: string
  object: string
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export interface LockToken {
  pid: number
  bootId: string
  startTime: number
  nonce: string
  acquiredAt: number
}

export interface RunLock {
  /** PID-reuse-safe: token triple {pid, bootId, startTime} must match a live job process. */
  acquire(): { ok: true; token: LockToken } | { ok: false; heldBy: LockToken; heldForMs: number }
  release(token: LockToken): void
}

// ---------------------------------------------------------------------------
// Memory operations
// ---------------------------------------------------------------------------

export type MemOp =
  | { kind: 'ADD'; factKey: FactKey; text: string }
  | { kind: 'UPDATE'; factId: string; factKey: FactKey; text: string }
  | { kind: 'DELETE'; factId: string; reason: string }   // never carries is_human_confirmed
  | { kind: 'NOOP'; factId: string }

// ---------------------------------------------------------------------------
// Normalized day log
// ---------------------------------------------------------------------------

export type DayLogRecordKind = 'utterance' | 'tool-call' | 'tool-result' | 'decision-journal'

export interface NormalizedDayLogRecord {
  kind: DayLogRecordKind
  ts: string
  payload: unknown
}

/** De-duplicated, timestamp-ordered stream with do_not_remember records already removed. */
export interface NormalizedDayLog {
  date: string
  records: NormalizedDayLogRecord[]
}

// ---------------------------------------------------------------------------
// Facts (live view)
// ---------------------------------------------------------------------------

export interface Fact {
  id: string
  factKey: FactKey
  text: string
  /** NULL means live; non-null means soft-deleted/tombstoned */
  invalidAt: string | null
  isHumanConfirmed: boolean
}

// ---------------------------------------------------------------------------
// Skill draft
// ---------------------------------------------------------------------------

export interface SkillDraft {
  id: string
  name: string
  body: string
  /** Provenance hint; transient-origin items flagged for retirement (ADR-0025) */
  provenance: 'transient' | 'session' | 'operator'
  hasCheckSection: boolean
}

// ---------------------------------------------------------------------------
// Diff / quarantined diff
// ---------------------------------------------------------------------------

export interface Diff {
  added: MemOp[]
  removed: string[]   // factIds
  updated: MemOp[]
}

export interface QuarantinedDiff {
  /** Has passed the input classifier/quarantine (Safety 05, CSO-M5). */
  quarantined: true
  body: string
  diff: Diff
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface Generator {
  /** Reads the NORMALIZED, forget-filtered day log + live facts only (invalid_at IS NULL). */
  proposeMemoryOps(log: NormalizedDayLog, liveFacts: Fact[]): Promise<{ ops: MemOp[]; diff: Diff }>
  draftSkills(log: NormalizedDayLog): Promise<SkillDraft[]>
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export interface ValidatorResult {
  ok: boolean
  failed?: ValidatorId[]
}

export interface Validators {
  /** Deterministic, 100%. Run BEFORE the judge. A failing candidate is dropped. */
  check(candidate: MemOp | SkillDraft): ValidatorResult
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export type JudgeVerdict = 'accept' | 'reject' | 'edit'

export interface Judge {
  /** Different model/provider. Sees ONLY final artifact + diff; never the generator CoT. */
  grade(quarantinedDiff: QuarantinedDiff): Promise<JudgeVerdict>
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StagedPatch {
  id: string
  kind: 'memory' | 'skill' | 'lint-orphan' | 'lint-stale' | 'lint-broken-edge'
  body: string
  /** Computed at judge-accept (ADR-0029); re-verified at promotion. */
  hashAtAccept: string
  /** Stripped of is_human_confirmed before staging. */
  /** false = held unjudged (judge unavailable, §7); never auto-promoted. */
  judged: boolean
}

export interface StagingArea {
  memoryPatches: StagedPatch[]
  skillPatches: StagedPatch[]
  lintPatches: StagedPatch[]
}

// ---------------------------------------------------------------------------
// Lint pass (Stage 2b)
// ---------------------------------------------------------------------------

export interface LintOrphan {
  kind: 'orphan'
  path: string   // working/*.md path or fact id
  reason: string
}

export interface LintStaleAnnotation {
  kind: 'stale'
  factId: string
  lastUpdated: string
  thresholdDays: number
}

export interface LintBrokenEdge {
  kind: 'broken-edge'
  fromFactKey: FactKey
  edgeType: 'supersedes' | 'contradicts' | 'extends'
  missingFactKey: FactKey
}

export type LintFinding = LintOrphan | LintStaleAnnotation | LintBrokenEdge

export interface LintPassResult {
  orphans: LintOrphan[]
  staleAnnotations: LintStaleAnnotation[]
  brokenEdges: LintBrokenEdge[]
  /** When the generator was unavailable and the pass was skipped. */
  skipped: boolean
  skipReason?: string
}

// ---------------------------------------------------------------------------
// Morning card
// ---------------------------------------------------------------------------

export interface MorningCardItem {
  /** The staged patch behind this card line. Absent for advisory-only items
   *  (e.g. transient-skill retirement flags) that have no promotion path. */
  patch?: StagedPatch
  summary: string
}

export interface ResurrectionBlocked {
  op: MemOp
  reason: 'tombstone' | 'forget-list' | 'human-confirmed-delete'
}

export interface HygieneReport {
  vacuumed: boolean
  walCheckpointed: boolean
  logRotated: boolean
  dockerPruned: boolean
  worktreePruned: boolean
  dbIntegrityOk: boolean
}

export interface BackupStatus {
  pushed: boolean
  commitHash?: string
  failureReason?: string
  retried: boolean
}

export interface VerificationMiss {
  stage: Stage
  claimedEffect: string
  traceFailure: string
}

export interface MorningCard {
  runDate: string
  memoryEdits: MorningCardItem[]
  triedToResurrect: ResurrectionBlocked[]
  skillChanges: MorningCardItem[]
  lintReport: LintPassResult
  hygieneReport: HygieneReport
  backupStatus: BackupStatus
  verificationMisses: VerificationMiss[]
  cost: {
    generatorTokens: number
    judgeTokens: number
    lintPassTokens: number
    totalUsd: number
  }
}

// ---------------------------------------------------------------------------
// Commit journal
// ---------------------------------------------------------------------------

export type CommitJournalState = 'pending' | 'reindexed' | 'committed'

export interface CommitJournalEntry {
  runDate: string
  stage: Stage
  op: MemOp
  factIds: string[]
  snapshotRef: string
  reindexDone: boolean
  gitCommitHash?: string
  state: CommitJournalState
}

// ---------------------------------------------------------------------------
// Nightly result
// ---------------------------------------------------------------------------

export interface NightResult {
  runDate: string
  stagesCompleted: Stage[]
  card: MorningCard
  lockToken: LockToken
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NightlyConfig {
  runAt: string   // cron expression, default "30 3 * * *"
  maxHeldMs: number
  lintStaleDays: number
  backupRemote: string
  stagingDir: string
  archiveDir: string
}

// ---------------------------------------------------------------------------
// ConsolidationRunner — the orchestrated entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Optional DI seams (deterministic effect ports). Every one is OPTIONAL with a
// safe in-memory default so the orchestration stays testable without real
// filesystem/SQLite/git; the spec's effects (§5) are threaded through these.
// ---------------------------------------------------------------------------

export interface SessionRecord {
  id: string
  transcript: string
}

/** Content-addressed session archival (Stage 1; AC-10-1). */
export interface ArchiveStore {
  sessions(): SessionRecord[]
  write(path: string, body: string): void
  has(path: string): boolean
}

/** Backup git remote (Stage 5; AC-10-15/24/25/32) — fast-forward push only. */
export interface GitBackup {
  commitAndPush(opts?: { force?: boolean }): Promise<
    { ok: true; commitHash: string } | { ok: false; failureReason: string }
  >
}

/** DB/disk hygiene ops (Stage 4; AC-10-24) — run under Safety's carve-out. */
export interface Hygiene {
  snapshot(): void
  vacuum(): void
  optimizeFts(): void
  walCheckpoint(): void
  rotateLogs(): void
  dockerPrune(): void
  integrityCheck(): boolean
}

/** Trace probes for self-verification (AC-10-26; ADR-0017). */
export interface TraceProbe {
  fileExists(path: string): boolean
  refAdvanced(commitHash: string): boolean
  rowTombstoned(factId: string): boolean
}

/** Least-privilege runtime context (AC-10-18; CSO-H6). */
export interface EnvContext {
  hasProdCreds: boolean
  egressAllowlist: string[]
}

/** Lint findings the deterministic scan surfaced (Stage 2b; AC-10-29/30/31). */
export interface LintInputs {
  orphans: LintOrphan[]
  staleAnnotations: LintStaleAnnotation[]
  brokenEdges: LintBrokenEdge[]
}

/** Crash-recovery journal (Eng-7; AC-10-16/17). */
export interface CommitJournal {
  entries: CommitJournalEntry[]
  record(entry: CommitJournalEntry): void
}

export interface ConsolidationDeps {
  clock: { now(): Date }
  generator: Generator
  judge: Judge
  validators: Validators
  lock: RunLock

  // --- optional effect seams (safe defaults applied by the factory) ---
  /** Raw normalized day log before the forget filter (AC-10-2). */
  rawDayLog?: NormalizedDayLog
  /** Forget-list predicate applied at ingestion (AC-10-2). */
  isForgotten?(record: NormalizedDayLogRecord): boolean
  /** Full fact set; the generator only sees the live (invalid_at IS NULL) subset (AC-10-3). */
  facts?: Fact[]
  /** Equivalence-class keys the resurrection-guard must block (AC-10-10/11/12). */
  tombstones?: FactKey[]
  /** Guard availability; false = Memory down, fail-closed (AC-10-22). */
  guardAvailable?(): boolean
  /** Observed on every resurrection-guard evaluation (AC-10-17). */
  onGuardCheck?(): void
  /** Session archival store (AC-10-1/26). */
  archive?: ArchiveStore
  /** Atomic SQLite txn wrapper; reindex runs inside, git push after (AC-10-15/16). */
  memoryTxn?(apply: () => Promise<void> | void): Promise<void>
  /** FTS5 reindex on the promotion path (AC-10-11/13/14/15/21/22/28). */
  reindex?(factId: string): void
  /** Live body of a staged patch at promote time; tamper => TOCTOU abort (AC-10-13). */
  currentBodyForPatch?(id: string, body: string): string
  /** Hard delete observer — must stay empty during lint (AC-10-30 no silent loss). */
  onDelete?(factId: string): void
  /** Git backup remote (AC-10-15/24/25). */
  git?: GitBackup
  /** DB/disk hygiene ops (AC-10-24). */
  hygiene?: Hygiene
  /** Trace probes for self-verification (AC-10-26). */
  traceProbe?: TraceProbe
  /** Least-privilege startup assertion input (AC-10-18). */
  envContext?: EnvContext
  /** Deterministic lint findings (AC-10-29/30/31). */
  lintInputs?: LintInputs
  /** Crash-recovery journal (AC-10-16/17). */
  journal?: CommitJournal
  /** Staging write observer; every target must be under staging/ (AC-10-14). */
  stagingWrite?(path: string): void
  /** Event sink (AC-10-20 held_too_long). */
  emit?(event: string): void
}

export interface ConsolidationRunner {
  run(config: NightlyConfig): Promise<NightResult>
  runLintPass(): Promise<LintPassResult>
  getStagedProposals(): Promise<StagingArea>
  approveStagedItem(id: string): Promise<void>
}

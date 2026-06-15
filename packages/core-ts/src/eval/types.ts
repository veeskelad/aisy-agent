// Eval & Red-Team Harness — ADR-0037
//
// Two regression-discipline primitives that sit above the per-component unit
// tests (OpenClaw shipped nine CVEs *with* tests; the failures lived above the
// unit level):
//   1. pass^k scoring — ALL k attempts must pass. pass@1 averages over attempts
//      and hides an agent that fails a fixed slice of cases; pass^k drops that
//      case's score to zero and surfaces the slice.
//   2. Golden-trajectory replay + diff — replay the saved append-only journal
//      (Observability 12 / ADR-0017) for representative sessions after a harness
//      change; a trajectory divergence (changed tool, altered verdict, added or
//      removed step) is a regression GATE, not just an output-level check.
//
// Pure and deterministic; the live replay driver is injected by the caller so
// the harness reuses the existing test seams (effect-verifier, provider-fake).

// ─── pass^k ────────────────────────────────────────────────────────────────────

/** One eval case run k times; `outcomes[i]` = did attempt i pass. */
export interface CaseRuns {
  caseId: string
  outcomes: boolean[]
}

export interface PassHatKReport {
  /** Attempts per case (must be uniform across the suite). */
  k: number
  total: number
  /** Fraction of cases where ALL k attempts passed — the headline metric. */
  passHatK: number
  /** Mean attempt pass-rate (pass@1-style average; can hide a failing slice). */
  pass1: number
  allPass: string[]
  /** All k attempts failed. */
  consistentlyFailing: string[]
  /** Mixed outcomes: pass^k fails for these, yet pass@1 stays > 0 — the slice pass@1 hides. */
  flaky: string[]
  /** Release gate: 'pass' only when every case passed all k attempts. */
  gate: 'pass' | 'fail'
}

// ─── golden-trajectory replay ──────────────────────────────────────────────────

/** One comparable step in a trajectory; volatile fields (ts/seq/hashes) are excluded. */
export interface TrajectoryStep {
  /** Tool selected at this step (or the journal entry `kind` for a non-tool step). */
  tool: string
  /** Verification verdict, when the step produced one. */
  verdict?: string
  /** Further deterministic, comparison-relevant fields. */
  meta?: Record<string, unknown>
}

export type Trajectory = TrajectoryStep[]

export type DivergenceKind =
  | 'tool-changed'
  | 'verdict-changed'
  | 'signature-changed'
  | 'step-added'
  | 'step-removed'

export interface Divergence {
  index: number
  kind: DivergenceKind
  golden?: TrajectoryStep
  replayed?: TrajectoryStep
}

export interface TrajectoryDiff {
  identical: boolean
  divergences: Divergence[]
}

export interface GoldenCase {
  caseId: string
  prompt: string
  trajectory: Trajectory
}

export interface ReplayReport {
  regressions: Array<{ caseId: string; diff: TrajectoryDiff }>
  clean: string[]
  /** Any trajectory divergence fails the gate. */
  gate: 'pass' | 'fail'
}

/** Minimal structural view of an append-only journal entry (Observability 12). */
export interface JournalLike {
  kind: string
  payload: unknown
}

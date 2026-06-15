// Eval & Red-Team Harness — ADR-0037. See ./types.ts and the ADR for rationale.

export type {
  CaseRuns,
  PassHatKReport,
  TrajectoryStep,
  Trajectory,
  DivergenceKind,
  Divergence,
  TrajectoryDiff,
  GoldenCase,
  ReplayReport,
  JournalLike,
} from './types.js'

import type {
  CaseRuns,
  PassHatKReport,
  Trajectory,
  TrajectoryStep,
  TrajectoryDiff,
  Divergence,
  GoldenCase,
  ReplayReport,
  JournalLike,
} from './types.js'

// ---------------------------------------------------------------------------
// pass^k — ALL k attempts must pass. pass@1 averages over attempts and hides an
// agent that fails a fixed slice of cases; pass^k drops that case to zero so the
// slice surfaces. The release gate passes only when every case is all-k-pass.
// ---------------------------------------------------------------------------

export function passHatK(cases: CaseRuns[]): PassHatKReport {
  if (cases.length === 0) {
    return { k: 0, total: 0, passHatK: 1, pass1: 1, allPass: [], consistentlyFailing: [], flaky: [], gate: 'pass' }
  }
  const k = cases[0]!.outcomes.length
  for (const c of cases) {
    if (c.outcomes.length === 0) {
      throw new Error(`pass^k case '${c.caseId}' has zero attempts`)
    }
    if (c.outcomes.length !== k) {
      throw new Error(
        `pass^k requires a uniform attempt count: case '${c.caseId}' has ${c.outcomes.length}, expected ${k}`,
      )
    }
  }

  const allPass: string[] = []
  const consistentlyFailing: string[] = []
  const flaky: string[] = []
  let attemptPasses = 0
  let attemptTotal = 0

  for (const c of cases) {
    const passes = c.outcomes.filter(Boolean).length
    attemptPasses += passes
    attemptTotal += c.outcomes.length
    if (passes === k) allPass.push(c.caseId)
    else if (passes === 0) consistentlyFailing.push(c.caseId)
    else flaky.push(c.caseId)
  }

  return {
    k,
    total: cases.length,
    passHatK: allPass.length / cases.length,
    pass1: attemptPasses / attemptTotal,
    allPass,
    consistentlyFailing,
    flaky,
    gate: allPass.length === cases.length ? 'pass' : 'fail',
  }
}

// ---------------------------------------------------------------------------
// Golden-trajectory replay + diff. A trajectory is the comparison-relevant
// projection of the append-only journal (volatile ts/seq/hashes excluded). Any
// divergence after a harness change is a regression gate.
// ---------------------------------------------------------------------------

/** Deterministic JSON over object keys (stable signature input). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map(key => [key, (v as Record<string, unknown>)[key]]),
        )
      : v,
  )
}

export function stepSignature(step: TrajectoryStep): string {
  return stableStringify({ tool: step.tool, verdict: step.verdict ?? null, meta: step.meta ?? null })
}

export function diffTrajectory(golden: Trajectory, replayed: Trajectory): TrajectoryDiff {
  const divergences: Divergence[] = []
  const n = Math.max(golden.length, replayed.length)
  for (let i = 0; i < n; i++) {
    const g = golden[i]
    const r = replayed[i]
    if (g === undefined && r !== undefined) {
      divergences.push({ index: i, kind: 'step-added', replayed: r })
      continue
    }
    if (g !== undefined && r === undefined) {
      divergences.push({ index: i, kind: 'step-removed', golden: g })
      continue
    }
    if (g === undefined || r === undefined) continue
    if (g.tool !== r.tool) {
      divergences.push({ index: i, kind: 'tool-changed', golden: g, replayed: r })
      continue
    }
    if ((g.verdict ?? null) !== (r.verdict ?? null)) {
      divergences.push({ index: i, kind: 'verdict-changed', golden: g, replayed: r })
      continue
    }
    if (stepSignature(g) !== stepSignature(r)) {
      divergences.push({ index: i, kind: 'signature-changed', golden: g, replayed: r })
    }
  }
  return { identical: divergences.length === 0, divergences }
}

/**
 * Replay a golden suite through an injected driver and gate on any divergence.
 * The driver maps a prompt to the trajectory the current harness produces; in a
 * real run it wraps the assembled system (safety/memory/gateway/observability),
 * in a unit test it is a fake — the diff logic is identical either way.
 */
export function replaySuite(golden: GoldenCase[], replay: (prompt: string) => Trajectory): ReplayReport {
  const regressions: Array<{ caseId: string; diff: TrajectoryDiff }> = []
  const clean: string[] = []
  for (const c of golden) {
    const diff = diffTrajectory(c.trajectory, replay(c.prompt))
    if (diff.identical) clean.push(c.caseId)
    else regressions.push({ caseId: c.caseId, diff })
  }
  return { regressions, clean, gate: regressions.length === 0 ? 'pass' : 'fail' }
}

/**
 * Derive a comparable trajectory from the append-only journal (Observability 12
 * / ADR-0017). Volatile fields (ts/seq/prevHash/hash) never enter the step, so
 * two runs that differ only in timing produce identical trajectories. tool ←
 * payload.tool || entry.kind; verdict ← payload.verdict || (payload.pass ? …).
 */
export function trajectoryFromJournal(entries: JournalLike[]): Trajectory {
  return entries.map(e => {
    const p = (e.payload ?? {}) as Record<string, unknown>
    const tool = typeof p['tool'] === 'string' ? (p['tool'] as string) : e.kind
    const step: TrajectoryStep = { tool }
    const rawVerdict =
      p['verdict'] ?? (typeof p['pass'] === 'boolean' ? (p['pass'] ? 'pass' : 'fail') : undefined)
    if (rawVerdict !== undefined) step.verdict = String(rawVerdict)
    return step
  })
}

/**
 * Eval & Red-Team Harness — ADR-0037
 *
 * Tests for the two regression-discipline primitives: pass^k scoring and
 * golden-trajectory replay + diff. Label convention: AC-EVAL-N.
 */

import { describe, it, expect } from 'vitest'
import {
  passHatK,
  diffTrajectory,
  stepSignature,
  replaySuite,
  trajectoryFromJournal,
  type CaseRuns,
  type Trajectory,
  type GoldenCase,
  type JournalLike,
} from './index.js'

// ─── pass^k ────────────────────────────────────────────────────────────────────

describe('Eval — pass^k (ADR-0037)', () => {
  it('AC-EVAL-1: a flaky case (mixed outcomes) drops pass^k to fail while pass@1 stays high — the slice pass@1 hides', () => {
    const cases: CaseRuns[] = [
      { caseId: 'a', outcomes: [true, true, true, true, true] },
      { caseId: 'b', outcomes: [true, true, true, true, true] },
      { caseId: 'c', outcomes: [true, true, true, true, false] }, // flaky: 4/5
    ]
    const r = passHatK(cases)

    expect(r.k).toBe(5)
    expect(r.flaky).toEqual(['c'])
    expect(r.allPass).toEqual(['a', 'b'])
    // pass^k = 2/3 cases all-pass; pass@1 = 14/15 ≈ 0.933 — pass@1 hides the slice.
    expect(r.passHatK).toBeCloseTo(2 / 3, 5)
    expect(r.pass1).toBeCloseTo(14 / 15, 5)
    expect(r.pass1).toBeGreaterThan(r.passHatK)
    expect(r.gate).toBe('fail')
  })

  it('AC-EVAL-2: a consistently-failing case is distinguished from a flaky one; gate passes only when every case is all-pass', () => {
    const allGreen = passHatK([
      { caseId: 'a', outcomes: [true, true, true] },
      { caseId: 'b', outcomes: [true, true, true] },
    ])
    expect(allGreen.gate).toBe('pass')
    expect(allGreen.passHatK).toBe(1)

    const withDead = passHatK([
      { caseId: 'a', outcomes: [true, true, true] },
      { caseId: 'dead', outcomes: [false, false, false] },
    ])
    expect(withDead.consistentlyFailing).toEqual(['dead'])
    expect(withDead.flaky).toEqual([])
    expect(withDead.gate).toBe('fail')
  })

  it('AC-EVAL-3: a non-uniform attempt count is rejected (pass^k is incomparable across uneven k)', () => {
    expect(() =>
      passHatK([
        { caseId: 'a', outcomes: [true, true, true] },
        { caseId: 'b', outcomes: [true, true] },
      ]),
    ).toThrow()
    expect(() => passHatK([{ caseId: 'empty', outcomes: [] }])).toThrow()
  })
})

// ─── golden-trajectory replay ──────────────────────────────────────────────────

describe('Eval — golden-trajectory replay (ADR-0037)', () => {
  const golden: Trajectory = [
    { tool: 'read_file', verdict: 'pass' },
    { tool: 'search_memory', verdict: 'pass' },
    { tool: 'write_file', verdict: 'pass' },
  ]

  it('AC-EVAL-4: an identical replay diffs clean (no divergences, gate pass)', () => {
    const diff = diffTrajectory(golden, [...golden.map(s => ({ ...s }))])
    expect(diff.identical).toBe(true)
    expect(diff.divergences).toEqual([])
  })

  it('AC-EVAL-5: a changed tool selection is a divergence (tool-changed)', () => {
    const replayed: Trajectory = [
      { tool: 'read_file', verdict: 'pass' },
      { tool: 'shell_exec', verdict: 'pass' }, // tool drift
      { tool: 'write_file', verdict: 'pass' },
    ]
    const diff = diffTrajectory(golden, replayed)
    expect(diff.identical).toBe(false)
    expect(diff.divergences).toHaveLength(1)
    expect(diff.divergences[0]).toMatchObject({ index: 1, kind: 'tool-changed' })
  })

  it('AC-EVAL-6: an altered verdict is a divergence (verdict-changed)', () => {
    const replayed: Trajectory = [
      { tool: 'read_file', verdict: 'pass' },
      { tool: 'search_memory', verdict: 'fail' }, // verdict drift
      { tool: 'write_file', verdict: 'pass' },
    ]
    const diff = diffTrajectory(golden, replayed)
    expect(diff.divergences[0]).toMatchObject({ index: 1, kind: 'verdict-changed' })
  })

  it('AC-EVAL-7: an added and a removed step are both divergences', () => {
    const added = diffTrajectory(golden, [...golden, { tool: 'extra_call', verdict: 'pass' }])
    expect(added.divergences).toHaveLength(1)
    expect(added.divergences[0]).toMatchObject({ index: 3, kind: 'step-added' })

    const removed = diffTrajectory(golden, golden.slice(0, 2))
    expect(removed.divergences).toHaveLength(1)
    expect(removed.divergences[0]).toMatchObject({ index: 2, kind: 'step-removed' })
  })

  it('AC-EVAL-8: a meta-only difference is caught as a signature change', () => {
    const g: Trajectory = [{ tool: 'http', verdict: 'pass', meta: { host: 'api.example.com' } }]
    const r: Trajectory = [{ tool: 'http', verdict: 'pass', meta: { host: 'evil.example.com' } }]
    const diff = diffTrajectory(g, r)
    expect(diff.divergences[0]).toMatchObject({ index: 0, kind: 'signature-changed' })
    // and a step signature is deterministic / order-independent over meta keys
    expect(stepSignature({ tool: 'x', meta: { a: 1, b: 2 } })).toBe(
      stepSignature({ tool: 'x', meta: { b: 2, a: 1 } }),
    )
  })

  it('AC-EVAL-9: replaySuite aggregates regressions and fails the gate on any divergence', () => {
    const suite: GoldenCase[] = [
      { caseId: 'happy', prompt: 'summarize the file', trajectory: golden },
      { caseId: 'drift', prompt: 'do the thing', trajectory: golden },
    ]
    // replay reproduces 'happy' exactly but drifts the tool for 'drift'
    const report = replaySuite(suite, (prompt) =>
      prompt === 'do the thing'
        ? [{ tool: 'read_file', verdict: 'pass' }, { tool: 'rm_rf', verdict: 'pass' }, { tool: 'write_file', verdict: 'pass' }]
        : golden.map(s => ({ ...s })),
    )
    expect(report.clean).toEqual(['happy'])
    expect(report.regressions.map(r => r.caseId)).toEqual(['drift'])
    expect(report.gate).toBe('fail')
  })

  it('AC-EVAL-10: trajectoryFromJournal ignores volatile fields — two journals differing only in ts/seq yield identical trajectories', () => {
    const runA: JournalLike[] = [
      { kind: 'tool.call', payload: { tool: 'read_file', ts: '2026-06-15T00:00:00Z', seq: 1 } },
      { kind: 'step.verified', payload: { tool: 'verify', pass: true, ts: '2026-06-15T00:00:01Z', seq: 2 } },
    ]
    const runB: JournalLike[] = [
      { kind: 'tool.call', payload: { tool: 'read_file', ts: '2027-01-01T12:00:00Z', seq: 99 } },
      { kind: 'step.verified', payload: { tool: 'verify', pass: true, ts: '2027-01-01T12:00:05Z', seq: 100 } },
    ]
    const tA = trajectoryFromJournal(runA)
    const tB = trajectoryFromJournal(runB)

    expect(diffTrajectory(tA, tB).identical).toBe(true)
    expect(tA[1]!.verdict).toBe('pass') // payload.pass:true → verdict 'pass'
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type DailyBudgetState, makeDailyBudget } from './daily-budget.js'

const roots: string[] = []

function statePath(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-budget-'))
  roots.push(created)
  return join(created, 'daily-budget.json')
}

function budget(path: string, capUsd = 10, start = '2026-07-29T09:00:00Z') {
  let now = start
  const warnings: DailyBudgetState[] = []
  const pauses: DailyBudgetState[] = []
  const value = makeDailyBudget({
    path,
    capUsd,
    nowIso: () => now,
    onWarning: (state) => warnings.push(state),
    onPause: (state) => pauses.push(state),
  })
  return { value, warnings, pauses, setNow: (iso: string) => { now = iso } }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('daily budget thresholds (ADR-0082)', () => {
  it('stays quiet below the warning threshold', () => {
    const { value, warnings, pauses } = budget(statePath())
    value.record(7.9)
    expect(warnings).toEqual([])
    expect(pauses).toEqual([])
    expect(value.paused()).toBe(false)
  })

  it('warns exactly once per day, not once per charge', () => {
    const { value, warnings } = budget(statePath())

    value.record(8)
    value.record(0.5)
    value.record(0.5)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.share).toBeCloseTo(0.8)
  })

  it('pauses at the cap and reports it once', () => {
    const { value, pauses } = budget(statePath())

    value.record(10)
    value.record(1)

    expect(value.paused()).toBe(true)
    expect(pauses).toHaveLength(1)
  })

  it('clears the pause and the warning when the date changes', () => {
    const { value, warnings, setNow } = budget(statePath())
    value.record(12)
    expect(value.paused()).toBe(true)

    setNow('2026-07-30T00:05:00Z')

    expect(value.paused()).toBe(false)
    expect(value.state()).toMatchObject({ date: '2026-07-30', spent: 0 })
    // Yesterday's warning does not silence today's.
    value.record(9)
    expect(warnings).toHaveLength(2)
  })

  it('does not accumulate skipped days', () => {
    const { value, setNow } = budget(statePath())
    value.record(12)

    setNow('2026-08-15T10:00:00Z')

    expect(value.state()).toMatchObject({ spent: 0, paused: false })
  })

  it('survives a restart with today\'s spend intact', () => {
    const path = statePath()
    budget(path).value.record(9)

    const reopened = budget(path)

    expect(reopened.value.state().spent).toBe(9)
    // The warning already happened today and must not repeat after a restart.
    reopened.value.record(0.1)
    expect(reopened.warnings).toEqual([])
  })

  it('treats a missing cap as no limit at all', () => {
    const { value, warnings, pauses } = budget(statePath(), 0)

    value.record(1000)

    expect(value.paused()).toBe(false)
    expect([...warnings, ...pauses]).toEqual([])
  })

  it('starts the day at zero when the stored counter is unreadable', () => {
    const path = statePath()
    writeFileSync(path, 'не json')

    expect(budget(path).value.state().spent).toBe(0)
  })

  it('ignores a charge that is not a positive number', () => {
    const { value } = budget(statePath())

    value.record(Number.NaN)
    value.record(-5)

    expect(value.state().spent).toBe(0)
  })
})

describe('operator-chosen daily cap', () => {
  it('persists the cap and lifts a pause when it is raised', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aisy-budget-cap-')), 'daily.json')
    const budget = makeDailyBudget({ path, capUsd: 10, nowIso: () => '2026-08-06T10:00:00.000Z' })
    budget.record(10)
    expect(budget.paused()).toBe(true)

    expect(budget.setCap(50)).toMatchObject({ cap: 50, paused: false })
    expect(budget.paused()).toBe(false)

    // A restart must not silently restore the environment's cap.
    const reopened = makeDailyBudget({ path, capUsd: 10, nowIso: () => '2026-08-06T12:00:00.000Z' })
    expect(reopened.state()).toMatchObject({ cap: 50, spent: 10 })
    expect(reopened.paused()).toBe(false)
  })

  it('removes the limit entirely on zero', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aisy-budget-cap-')), 'daily.json')
    const budget = makeDailyBudget({ path, capUsd: 25, nowIso: () => '2026-08-06T10:00:00.000Z' })
    budget.record(30)
    expect(budget.paused()).toBe(true)

    expect(budget.setCap(0)).toMatchObject({ cap: 0, paused: false })
    expect(budget.record(100).paused).toBe(false)
  })
})

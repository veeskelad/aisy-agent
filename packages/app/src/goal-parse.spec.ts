import { describe, it, expect } from 'vitest'
import { parseGoalMode } from './goal-parse.js'

describe('parseGoalMode', () => {
  it("'until' → { kind:'until' }", () => {
    expect(parseGoalMode('until')).toEqual({ kind: 'until' })
  })

  it("'until:file:/p' → { kind:'until', probe: { kind:'file', path:'/p', existsExpected:true } }", () => {
    expect(parseGoalMode('until:file:/p')).toEqual({
      kind: 'until',
      probe: { kind: 'file', path: '/p', existsExpected: true },
    })
  })

  it("'until:garbage' → null (bad probe)", () => {
    expect(parseGoalMode('until:garbage')).toBeNull()
  })

  it("'every:10m' → { kind:'every', intervalMs:600000 }", () => {
    expect(parseGoalMode('every:10m')).toEqual({ kind: 'every', intervalMs: 600_000 })
  })

  it("'every:2h' → { kind:'every', intervalMs:7200000 }", () => {
    expect(parseGoalMode('every:2h')).toEqual({ kind: 'every', intervalMs: 7_200_000 })
  })

  it("'every:1d' → { kind:'every', intervalMs:86400000 }", () => {
    expect(parseGoalMode('every:1d')).toEqual({ kind: 'every', intervalMs: 86_400_000 })
  })

  it("'every:@hourly' → { kind:'every', intervalMs:3600000 }", () => {
    expect(parseGoalMode('every:@hourly')).toEqual({ kind: 'every', intervalMs: 3_600_000 })
  })

  it("'every:@daily' → { kind:'every', intervalMs:86400000 }", () => {
    expect(parseGoalMode('every:@daily')).toEqual({ kind: 'every', intervalMs: 86_400_000 })
  })

  it("'every:garbage' → null", () => {
    expect(parseGoalMode('every:garbage')).toBeNull()
  })

  it("'budget:0.50' → { kind:'budget', dollarCeiling:0.5 }", () => {
    expect(parseGoalMode('budget:0.50')).toEqual({ kind: 'budget', dollarCeiling: 0.5 })
  })

  it("'budget:50000' → { kind:'budget', tokenCeiling:50000 }", () => {
    expect(parseGoalMode('budget:50000')).toEqual({ kind: 'budget', tokenCeiling: 50000 })
  })

  it("'garbage' → null", () => {
    expect(parseGoalMode('garbage')).toBeNull()
  })

  it("empty string → null", () => {
    expect(parseGoalMode('')).toBeNull()
  })
})

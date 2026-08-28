import { describe, expect, it } from 'vitest'
import {
  latestSunday,
  makeWeeklyConsolidationCadence,
} from './weekly-consolidation-cadence.js'

describe('weekly consolidation cadence', () => {
  it('maps every day to the most recent Sunday', () => {
    expect(latestSunday('2026-08-30')).toBe('2026-08-30')
    expect(latestSunday('2026-08-31')).toBe('2026-08-30')
    expect(latestSunday('2026-09-05')).toBe('2026-08-30')
    expect(latestSunday('2026-09-06')).toBe('2026-09-06')
  })

  it('keeps a missed Sunday due through the week and survives restart', () => {
    let content: string | null = null
    const make = () => makeWeeklyConsolidationCadence({
      load: () => content,
      save: (next) => { content = next },
    })
    const first = make()
    expect(first.due('2026-08-31')).toBe(true)
    first.markSuccessful('2026-08-31')

    const restarted = make()
    expect(restarted.lastSuccessfulSunday()).toBe('2026-08-30')
    expect(restarted.due('2026-09-05')).toBe(false)
    expect(restarted.due('2026-09-06')).toBe(true)
  })

  it('fails closed on invalid dates and refuses cursor regression', () => {
    const cadence = makeWeeklyConsolidationCadence({ load: () => null, save: () => undefined })
    expect(() => cadence.due('2026-02-31')).toThrowError('INVALID_LOCAL_DATE')
    cadence.markSuccessful('2026-09-06')
    expect(() => cadence.markSuccessful('2026-08-30')).toThrowError('WEEKLY_CURSOR_REGRESSION')
  })
})

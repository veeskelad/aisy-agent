import { describe, expect, it } from 'vitest'

import { isKnownTimeZone, wallClockIso } from './wall-clock.js'

describe('wall clock', () => {
  it('renders the instant as the operator reads it', () => {
    // 06:00 UTC is 09:00 in Moscow — the whole reason schedules were wrong.
    expect(wallClockIso('2026-08-07T06:00:00.000Z', 'Europe/Moscow'))
      .toBe('2026-08-07T09:00:00')
    expect(wallClockIso('2026-08-07T06:00:00.000Z', 'America/New_York'))
      .toBe('2026-08-07T02:00:00')
  })

  it('crosses the date line the same way a wall clock does', () => {
    expect(wallClockIso('2026-08-07T22:30:00.000Z', 'Asia/Almaty').slice(0, 10)).toBe('2026-08-08')
    expect(wallClockIso('2026-08-07T02:30:00.000Z', 'America/Los_Angeles').slice(0, 10))
      .toBe('2026-08-06')
  })

  it('renders midnight as 00, not 24', () => {
    // hour12:false yields "24" on some ICU builds, and a 00:05 schedule would
    // then never match its slot.
    expect(wallClockIso('2026-08-07T21:00:00.000Z', 'Europe/Moscow')).toBe('2026-08-08T00:00:00')
  })

  it('follows daylight saving instead of a fixed offset', () => {
    expect(wallClockIso('2026-01-15T12:00:00.000Z', 'Europe/Berlin')).toBe('2026-01-15T13:00:00')
    expect(wallClockIso('2026-07-15T12:00:00.000Z', 'Europe/Berlin')).toBe('2026-07-15T14:00:00')
  })

  it('degrades to the input rather than stopping a schedule', () => {
    expect(wallClockIso('2026-08-07T06:00:00.000Z', 'Mars/Olympus'))
      .toBe('2026-08-07T06:00:00.000Z')
    expect(wallClockIso('not a date', 'Europe/Moscow')).toBe('not a date')
    expect(wallClockIso('2026-08-07T06:00:00.000Z', undefined)).toBe('2026-08-07T06:00:00.000Z')
  })

  it('knows a real zone from a typo', () => {
    expect(isKnownTimeZone('Europe/Moscow')).toBe(true)
    expect(isKnownTimeZone('UTC')).toBe(true)
    expect(isKnownTimeZone('Europe/Moskow')).toBe(false)
    expect(isKnownTimeZone('')).toBe(false)
  })
})

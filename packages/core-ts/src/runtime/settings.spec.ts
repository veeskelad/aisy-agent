import { describe, it, expect } from 'vitest'
import { makeSettingsStore, DEFAULT_SETTINGS } from './settings.js'
import type { Settings } from './settings.js'

describe('makeSettingsStore', () => {
  it('starts at the conservative defaults (no per-turn cost, no budget)', () => {
    const s = makeSettingsStore({})
    expect(s.get()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.showCostPerTurn).toBe(false)
    expect(DEFAULT_SETTINGS.budgetEnabled).toBe(false)
  })

  it('set persists and is reflected by get', () => {
    let stored: Partial<Settings> = {}
    const s = makeSettingsStore({ persistence: { load: () => stored, save: (v) => void (stored = v) } })
    s.set('showCostPerTurn', true)
    expect(s.get().showCostPerTurn).toBe(true)
    expect(stored.showCostPerTurn).toBe(true)
  })

  it('toggle flips a flag and returns the new value', () => {
    const s = makeSettingsStore({})
    expect(s.toggle('budgetEnabled')).toBe(true)
    expect(s.get().budgetEnabled).toBe(true)
    expect(s.toggle('budgetEnabled')).toBe(false)
    expect(s.get().budgetEnabled).toBe(false)
  })

  it('loads a partial persisted file over the defaults', () => {
    const s = makeSettingsStore({ persistence: { load: () => ({ showCostPerTurn: true }), save: () => {} } })
    expect(s.get()).toEqual({
      showCostPerTurn: true, budgetEnabled: false, debug: false, timeZone: '',
    })
  })

  it('debug defaults to false', () => {
    const s = makeSettingsStore({})
    expect(s.get().debug).toBe(false)
    expect(DEFAULT_SETTINGS.debug).toBe(false)
  })

  it('toggle("debug") flips the debug flag', () => {
    const s = makeSettingsStore({})
    expect(s.toggle('debug')).toBe(true)
    expect(s.get().debug).toBe(true)
    expect(s.toggle('debug')).toBe(false)
    expect(s.get().debug).toBe(false)
  })

  it('debug persists across reload', () => {
    let stored: Partial<Settings> = {}
    const s = makeSettingsStore({ persistence: { load: () => stored, save: (v) => void (stored = v) } })
    s.set('debug', true)
    expect(stored.debug).toBe(true)
    const s2 = makeSettingsStore({ persistence: { load: () => stored, save: () => {} } })
    expect(s2.get().debug).toBe(true)
  })

  it('keeps the timezone empty until the operator names one', () => {
    // Empty means "whatever the host runs in": guessing a zone would move
    // every schedule without anyone asking.
    expect(makeSettingsStore({}).get().timeZone).toBe('')

    const s = makeSettingsStore({ persistence: { load: () => ({}), save: () => {} } })
    s.set('timeZone', 'Europe/Moscow')
    expect(s.get().timeZone).toBe('Europe/Moscow')
  })
})

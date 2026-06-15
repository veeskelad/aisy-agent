import { describe, it, expect } from 'vitest'
import { MAIN_MENU, resolveMenu, MENU_GREETING } from './menu.js'

describe('main menu', () => {
  it('is a 2×4 grid of 8 buttons', () => {
    expect(MAIN_MENU.length).toBe(4)
    for (const row of MAIN_MENU) expect(row.length).toBe(2)
    expect(MAIN_MENU.flat().length).toBe(8)
  })

  it('has a greeting', () => {
    expect(MENU_GREETING).toContain('Aisy')
  })

  it('resolves every label to its action', () => {
    for (const b of MAIN_MENU.flat()) {
      expect(resolveMenu(b.label)).toBe(b.action)
    }
  })

  it('resolves with surrounding whitespace', () => {
    expect(resolveMenu('  🆕 Новая сессия ')).toBe('new_session')
  })

  it('returns null for non-menu text', () => {
    expect(resolveMenu('run the linter')).toBeNull()
  })

  it('covers all eight distinct actions', () => {
    const actions = new Set(MAIN_MENU.flat().map((b) => b.action))
    expect(actions.size).toBe(8)
  })
})

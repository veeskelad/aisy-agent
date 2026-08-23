import { describe, expect, it } from 'vitest'
import { renderSkillCatalog } from './skill-catalog-view.js'

describe('Skills Telegram catalog view', () => {
  it('renders sorted active metadata without a Skill body', () => {
    const text = renderSkillCatalog([
      { name: 'write-report', summary: 'Собрать отчёт' },
      { name: 'inspect', summary: 'Проверить артефакты' },
    ])

    expect(text).toContain('Активных навыков: 2')
    expect(text.indexOf('inspect')).toBeLessThan(text.indexOf('write-report'))
    expect(text).not.toContain('## steps')
  })

  it('renders an explicit empty state', () => {
    expect(renderSkillCatalog([])).toBe('🧩 Навыки\nАктивных навыков нет.')
  })

  it('normalizes control text and stays within the Telegram limit', () => {
    const text = renderSkillCatalog(Array.from({ length: 100 }, (_, index) => ({
      name: `skill-${index}`,
      summary: 'Строка\nс управляющим\u0000 текстом '.repeat(20),
    })))

    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).not.toContain('\u0000')
    expect(text).toMatch(/Ещё \d+/)
  })
})

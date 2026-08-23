import { describe, expect, it } from 'vitest'
import { renderMcpCatalog } from './mcp-catalog-view.js'

describe('MCP Telegram catalog view', () => {
  it('shows configured versus active state using bounded human-owned fields', () => {
    const text = renderMcpCatalog([
      { name: 'tracker.search', summary: 'Поиск задач', rw: 'read', tier: 0, active: false },
      { name: 'tracker.update', summary: 'Изменение задач', rw: 'write', tier: 2, active: true },
    ])

    expect(text).toContain('Активно инструментов: 1 из 2')
    expect(text).toContain('tracker.search · чтение · без спроса · не подключён')
    expect(text).toContain('tracker.update · запись · с подтверждением · активен')
  })

  it('renders an explicit empty state without claiming activation', () => {
    expect(renderMcpCatalog([])).toBe('🔌 MCP\nСерверы не настроены.')
  })

  it('normalizes control text and stays within the Telegram limit', () => {
    const text = renderMcpCatalog(Array.from({ length: 100 }, (_, index) => ({
      name: `server.tool-${index}`,
      summary: 'Строка\nс управляющим\u0000 текстом '.repeat(20),
      rw: 'read' as const,
      tier: 1 as const,
      active: false,
    })))
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).not.toContain('\u0000')
    expect(text).toMatch(/Ещё \d+/)
  })
})

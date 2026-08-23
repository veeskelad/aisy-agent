import { describe, expect, it } from 'vitest'
import { renderMonitoringStatus } from './monitoring-status-view.js'

describe('Telegram monitoring status view', () => {
  it('renders aggregate source and activation state without locator content', () => {
    const text = renderMonitoringStatus({
      available: true,
      configuredSources: 3,
      activeSources: 1,
      pausedSources: 1,
      quarantinedSources: 1,
      collectionActive: false,
      deliveryActive: false,
    })

    expect(text).toContain('Источников настроено: 3')
    expect(text).toContain('Сбор: выключен')
    expect(text).toContain('Доставка дайджестов: выключена')
    expect(text).not.toMatch(/https?:\/\//)
  })

  it('renders a fail-closed unavailable state', () => {
    const text = renderMonitoringStatus({
      available: false,
      configuredSources: 0,
      activeSources: 0,
      pausedSources: 0,
      quarantinedSources: 0,
      collectionActive: true,
      deliveryActive: true,
    })

    expect(text).toContain('Локальное состояние недоступно')
    expect(text).toContain('Сбор и доставка остановлены')
    expect(text).not.toContain('включён')
  })
})

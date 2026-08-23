export interface MonitoringStatusView {
  available: boolean
  configuredSources: number
  activeSources: number
  pausedSources: number
  quarantinedSources: number
  collectionActive: boolean
  deliveryActive: boolean
}

/** Render aggregate code-owned monitoring state; locators and collected content stay out. */
export function renderMonitoringStatus(status: MonitoringStatusView): string {
  if (!status.available) {
    return '📡 Мониторинг\nЛокальное состояние недоступно. Сбор и доставка остановлены.'
  }

  return [
    '📡 Мониторинг',
    `Источников настроено: ${status.configuredSources}.`,
    `Статусы: активных ${status.activeSources}, на паузе ${status.pausedSources}, ` +
      `в карантине ${status.quarantinedSources}.`,
    `Сбор: ${status.collectionActive ? 'включён' : 'выключен'}.`,
    `Доставка дайджестов: ${status.deliveryActive ? 'включена' : 'выключена'}.`,
  ].join('\n')
}

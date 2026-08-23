import type { MonitoringSource, ResolvedWorkBinding } from '@aisy/core'
import type { MonitoringStatusView } from '@aisy/telegram-gw'

export interface MonitoringStatusStorePort {
  listSources(binding: ResolvedWorkBinding): MonitoringSource[]
}

const unavailable = (): MonitoringStatusView => ({
  available: false,
  configuredSources: 0,
  activeSources: 0,
  pausedSources: 0,
  quarantinedSources: 0,
  collectionActive: false,
  deliveryActive: false,
})

/** Resolve exact binding before every local status read and expose aggregate counts only. */
export function makeMonitoringStatusSource(input: {
  store?: MonitoringStatusStorePort
  binding: ResolvedWorkBinding
  resolveBinding(binding: ResolvedWorkBinding): void
  collectionActive: boolean
  deliveryActive: boolean
}): () => MonitoringStatusView {
  return () => {
    if (input.store === undefined) return unavailable()
    try {
      input.resolveBinding(input.binding)
      const sources = input.store.listSources(input.binding)
      return {
        available: true,
        configuredSources: sources.length,
        activeSources: sources.filter((source) => source.status === 'active').length,
        pausedSources: sources.filter((source) => source.status === 'paused').length,
        quarantinedSources: sources.filter((source) => source.status === 'quarantined').length,
        collectionActive: input.collectionActive,
        deliveryActive: input.deliveryActive,
      }
    } catch {
      return unavailable()
    }
  }
}

import type { MonitoringSource, ResolvedWorkBinding } from '@aisy/core'
import { describe, expect, it } from 'vitest'
import { makeMonitoringStatusSource } from './monitoring-status-runtime.js'

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-1',
  sessionId: 'session-1', scope: 'project',
}

function source(id: string, status: MonitoringSource['status']): MonitoringSource {
  return {
    schemaVersion: 1,
    id,
    kind: 'rss',
    locator: `https://private.example/${id}`,
    binding: BINDING,
    criteria: 'private criteria',
    pollIntervalMs: 60_000,
    status,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  }
}

describe('monitoring status source', () => {
  it('revalidates the exact binding and projects aggregate counts only', () => {
    const calls: string[] = []
    const status = makeMonitoringStatusSource({
      binding: BINDING,
      resolveBinding: (binding) => { calls.push(`resolve:${binding.projectId}`) },
      store: {
        listSources: (binding) => {
          calls.push(`list:${binding.projectId}`)
          return [source('one', 'active'), source('two', 'paused'), source('three', 'quarantined')]
        },
      },
      collectionActive: false,
      deliveryActive: false,
    })()

    expect(calls).toEqual(['resolve:project-1', 'list:project-1'])
    expect(status).toEqual({
      available: true,
      configuredSources: 3,
      activeSources: 1,
      pausedSources: 1,
      quarantinedSources: 1,
      collectionActive: false,
      deliveryActive: false,
    })
    expect(JSON.stringify(status)).not.toMatch(/private|https?:/)
  })

  it('fails closed before store access when binding resolution fails', () => {
    let reads = 0
    const status = makeMonitoringStatusSource({
      binding: BINDING,
      resolveBinding: () => { throw new Error('sensitive binding detail') },
      store: { listSources: () => { reads += 1; return [] } },
      collectionActive: true,
      deliveryActive: true,
    })()

    expect(reads).toBe(0)
    expect(status).toMatchObject({ available: false, collectionActive: false, deliveryActive: false })
    expect(JSON.stringify(status)).not.toContain('sensitive')
  })

  it('reports unavailable without opening an absent optional store', () => {
    let resolves = 0
    const status = makeMonitoringStatusSource({
      binding: BINDING,
      resolveBinding: () => { resolves += 1 },
      collectionActive: false,
      deliveryActive: false,
    })()
    expect(resolves).toBe(0)
    expect(status.available).toBe(false)
  })
})

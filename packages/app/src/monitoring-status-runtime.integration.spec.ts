import type { ResolvedWorkBinding } from '@aisy/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeMonitoringRuntime } from './monitoring-runtime.js'
import { makeMonitoringStatusSource } from './monitoring-status-runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-1',
  sessionId: 'session-1', scope: 'project',
}

describe('passive monitoring status composition', () => {
  it('restores configured source counts after restart without collection or delivery I/O', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-status-'))
    roots.push(root)
    const dbPath = join(root, 'monitoring.db')
    let httpCalls = 0
    const compose = () => makeNodeMonitoringRuntime({
      dbPath,
      resolveBinding: (binding) => {
        if (JSON.stringify(binding) !== JSON.stringify(BINDING)) throw new Error('binding mismatch')
      },
      http: {
        get: async () => {
          httpCalls += 1
          throw new Error('MONITORING_EGRESS_INACTIVE')
        },
      },
      nowIso: () => '2026-07-27T00:00:00.000Z',
      newId: () => 'unused-id',
    })

    const first = compose()
    first.engine.registerSource({
      id: 'source-1',
      kind: 'rss',
      locator: 'https://example.test/feed.xml',
      binding: BINDING,
      criteria: 'Важные обновления',
      pollIntervalMs: 60_000,
    })

    const restarted = compose()
    const status = makeMonitoringStatusSource({
      store: restarted.store,
      binding: BINDING,
      resolveBinding: () => {},
      collectionActive: false,
      deliveryActive: false,
    })()

    expect(status).toMatchObject({
      available: true,
      configuredSources: 1,
      activeSources: 1,
      collectionActive: false,
      deliveryActive: false,
    })
    expect(httpCalls).toBe(0)
  })
})

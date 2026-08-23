import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MonitoringHttpPort,
  MonitoringScorer,
  ResolvedWorkBinding,
} from '@aisy/core'
import { makeMonitoringDeliveryCoordinator, makeNodeMonitoringRuntime } from './monitoring-runtime.js'
import { makeMonitoringLiveCoordinator, makeNodeMonitoringWindowStore } from './monitoring-live-runtime.js'
import { makeTelegramMonitoringControls } from './telegram-monitoring-controls.js'
import { makeTelegramMonitoringDigestDeliveryPort } from './telegram-monitoring-delivery.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const BINDING: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'session-a', scope: 'project',
})
const RSS = `<?xml version="1.0"?><rss><channel><item>
  <guid>release-1</guid><link>https://news.example.com/releases/1</link>
  <title>Aisy release</title><description>Production monitoring is live.</description>
  <dc:creator>Aisy</dc:creator><pubDate>Wed, 12 Aug 2026 07:30:00 GMT</pubDate>
</item></channel></rss>`

describe('RSS/Web monitoring LIVE composition', () => {
  it('runs add → exact fetch → no-tools score → daily digest → guarded Telegram receipt once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitoring-e2e-'))
    roots.push(root)
    const dbPath = join(root, 'monitoring.db')
    const windowPath = join(root, 'monitoring-windows.json')
    let now = '2026-08-12T08:01:00.000Z'
    const httpGet = vi.fn<MonitoringHttpPort['get']>(async (request) => ({
      status: 200,
      body: RSS,
      finalUrl: request.url,
      etag: '"release-v1"',
    }))
    const score = vi.fn<MonitoringScorer['score']>(async () => ({
      score: 0.9, category: 'important', summary: 'Monitoring готов.', whyUseful: 'Можно включать.',
    }))
    let digestId = 0
    const compose = () => makeNodeMonitoringRuntime({
      dbPath,
      resolveBinding: (binding) => {
        if (JSON.stringify(binding) !== JSON.stringify(BINDING)) throw new Error('binding mismatch')
      },
      http: { get: httpGet },
      scorer: { score },
      nowIso: () => now,
      newId: () => `digest-${++digestId}`,
    })
    const runtime = compose()
    let token = 0
    const controls = makeTelegramMonitoringControls({
      engine: runtime.engine,
      store: runtime.store,
      binding: BINDING,
      resolveBinding: () => {},
      newTokenId: () => `token-${++token}`,
      newSourceId: () => 'source-rss',
      nowMs: () => Date.parse(now),
    })
    const principal = { chatId: 42, userId: 42 }
    const view = controls.open({ principal, messageId: 10 })
    const add = view.buttons.flat().find((button) => button.text === '➕ RSS')!
    expect(controls.handle({ data: add.data, principal, messageId: 10 }))
      .toMatchObject({ kind: 'prompt' })
    expect(controls.handleText({
      principal,
      text: 'https://news.example.com/feed.xml\nТолько production-релизы',
    })).toMatchObject({ kind: 'view' })
    expect(runtime.store.getSourceEgressDomain('source-rss')).toBe('news.example.com')

    const calls: string[] = []
    const delivery = makeMonitoringDeliveryCoordinator({
      engine: runtime.engine,
      nowIso: () => now,
      delivery: makeTelegramMonitoringDigestDeliveryPort({
        allowedChatId: 42,
        output: {
          guard: async ({ binding, html, idempotencyKey }) => {
            expect(binding).toEqual(BINDING)
            expect(html).toContain('https://news.example.com/releases/1')
            calls.push(`guard:${idempotencyKey}`)
          },
          sendMessage: async ({ chatId, html, idempotencyKey }) => {
            expect(chatId).toBe(42)
            expect(html).toContain('Monitoring готов.')
            calls.push(`send:${idempotencyKey}`)
            return { messageId: 501 }
          },
        },
      }),
    })
    const coordinator = makeMonitoringLiveCoordinator({
      engine: runtime.engine,
      store: runtime.store,
      delivery,
      windows: makeNodeMonitoringWindowStore({ path: windowPath }),
      binding: BINDING,
      nowIso: () => now,
      timeZone: () => 'UTC',
    })

    await expect(coordinator.tick()).resolves.toMatchObject({
      collection: [expect.objectContaining({ collected: 1, inserted: 1, scored: 1 })],
      digest: 'created',
      delivery: expect.objectContaining({ delivered: 1 }),
    })
    expect(httpGet).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-rss', url: 'https://news.example.com/feed.xml', maxBytes: 2_000_000,
    }))
    expect(score).toHaveBeenCalledWith(expect.objectContaining({
      provenance: 'untrusted', outboundAllowed: false,
      criteria: expect.stringContaining('Только production-релизы'),
    }))
    expect(calls).toEqual(['guard:digest-1', 'send:digest-1'])
    expect(runtime.store.getDigestForWindow(
      BINDING, '2026-08-11T08:01:00.000Z', '2026-08-12T08:01:00.000Z',
    )).toMatchObject({
      id: 'digest-1', status: 'delivered', deliveryReceipt: 'telegram:message:501',
    })

    now = '2026-08-12T08:02:00.000Z'
    const restarted = compose()
    const restartedDelivery = makeMonitoringDeliveryCoordinator({
      engine: restarted.engine,
      nowIso: () => now,
      delivery: { deliver: vi.fn(async () => 'must-not-send') },
    })
    const restartedCoordinator = makeMonitoringLiveCoordinator({
      engine: restarted.engine,
      store: restarted.store,
      delivery: restartedDelivery,
      windows: makeNodeMonitoringWindowStore({ path: windowPath }),
      binding: BINDING,
      nowIso: () => now,
      timeZone: () => 'UTC',
    })
    await expect(restartedCoordinator.tick()).resolves.toMatchObject({
      collection: [], digest: 'existing', delivery: expect.objectContaining({ attempted: 0 }),
    })
    expect(httpGet).toHaveBeenCalledTimes(1)
    expect(score).toHaveBeenCalledTimes(1)
  })
})

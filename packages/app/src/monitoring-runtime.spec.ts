import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeMonitoringDeliveryCoordinator,
  makeNodeMonitoringRuntime,
} from './monitoring-runtime.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Node monitoring runtime', () => {
  it('assembles all connector families without polling or activating delivery', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-runtime-'))
    roots.push(root)
    const runtime = makeNodeMonitoringRuntime({
      dbPath: join(root, 'monitoring.db'),
      resolveBinding: () => {},
      nowIso: () => '2026-07-27T09:00:00.000Z',
      newId: () => 'digest-1',
    })
    const binding = {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project' as const,
    }
    for (const kind of ['telegram', 'rss', 'youtube', 'github', 'web'] as const) {
      expect(() => runtime.engine.registerSource({
        id: `source-${kind}`,
        kind,
        locator: kind === 'telegram' ? '@aisy_news'
          : kind === 'youtube' ? 'UC1234567890'
            : kind === 'github' ? 'https://github.com/veeskelad/aisy'
              : `https://example.com/${kind}`,
        binding,
        criteria: '',
        pollIntervalMs: 60_000,
      })).not.toThrow()
    }
    expect(runtime.store.listSources(binding)).toHaveLength(5)
    expect(runtime.store.getSourceEgressDomain('source-telegram')).toBe('t.me')
    expect(runtime.store.getSourceEgressDomain('source-youtube')).toBe('www.youtube.com')
    expect(runtime.store.getSourceEgressDomain('source-github')).toBe('github.com')
    expect(runtime.store.getSourceEgressDomain('source-rss')).toBe('example.com')
    expect(runtime.store.getSourceEgressDomain('source-web')).toBe('example.com')
  })

  it('delivers a bounded due batch and marks only non-empty receipts as delivered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-delivery-'))
    roots.push(root)
    let id = 0
    const runtime = makeNodeMonitoringRuntime({
      dbPath: join(root, 'monitoring.db'),
      resolveBinding: () => {},
      http: { get: async () => { throw new Error('must not collect') } },
      nowIso: () => '2026-07-27T10:00:00.000Z',
      newId: () => `digest-${++id}`,
    })
    const binding = {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project' as const,
    }
    const digestConfig = {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    }
    const delivered = runtime.engine.buildDigest(binding, digestConfig)
    const noReceipt = runtime.engine.buildDigest(binding, digestConfig)
    const untouched = runtime.engine.buildDigest(binding, digestConfig)
    const calls: string[] = []
    const coordinator = makeMonitoringDeliveryCoordinator({
      engine: runtime.engine,
      nowIso: () => '2026-07-27T10:00:00.000Z',
      delivery: {
        deliver: async ({ digest, idempotencyKey }) => {
          calls.push(`${digest.id}:${idempotencyKey}`)
          return digest.id === delivered.id ? ' telegram:message-42 ' : '  '
        },
      },
    })

    await expect(coordinator.tick(2)).resolves.toEqual({
      due: 2,
      attempted: 2,
      delivered: 1,
      noReceipt: 1,
      failed: 0,
      skipped: 0,
    })
    expect(calls).toEqual([
      `${delivered.id}:${delivered.id}`,
      `${noReceipt.id}:${noReceipt.id}`,
    ])
    expect(runtime.store.getDigest(delivered.id)).toMatchObject({
      status: 'delivered',
      deliveryReceipt: 'telegram:message-42',
    })
    expect(runtime.store.getDigest(noReceipt.id)).toMatchObject({ status: 'ready' })
    expect(runtime.store.getDigest(untouched.id)).toMatchObject({ status: 'ready' })
  })

  it('rechecks binding before each delivery I/O and pauses an archived digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-delivery-binding-'))
    roots.push(root)
    let active = true
    const runtime = makeNodeMonitoringRuntime({
      dbPath: join(root, 'monitoring.db'),
      resolveBinding: () => {
        if (!active) throw new Error('archived sensitive detail')
      },
      http: { get: async () => { throw new Error('must not collect') } },
      nowIso: () => '2026-07-27T10:00:00.000Z',
      newId: () => 'digest-archived',
    })
    const digest = runtime.engine.buildDigest({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project',
    }, {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    })
    active = false
    let calls = 0
    const coordinator = makeMonitoringDeliveryCoordinator({
      engine: runtime.engine,
      nowIso: () => '2026-07-27T10:00:00.000Z',
      delivery: { deliver: async () => { calls += 1; return 'must-not-happen' } },
    })

    await expect(coordinator.tick(1)).resolves.toEqual({
      due: 0,
      attempted: 0,
      delivered: 0,
      noReceipt: 0,
      failed: 0,
      skipped: 0,
    })
    expect(calls).toBe(0)
    expect(runtime.store.getDigest(digest.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'context-unavailable',
    })
  })

  it('stops a due batch when the binding is archived between two deliveries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-delivery-race-'))
    roots.push(root)
    let active = true
    let id = 0
    const runtime = makeNodeMonitoringRuntime({
      dbPath: join(root, 'monitoring.db'),
      resolveBinding: () => {
        if (!active) throw new Error('archived sensitive detail')
      },
      http: { get: async () => { throw new Error('must not collect') } },
      nowIso: () => '2026-07-27T10:00:00.000Z',
      newId: () => `digest-race-${++id}`,
    })
    const binding = {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project' as const,
    }
    const config = {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    }
    const first = runtime.engine.buildDigest(binding, config)
    const second = runtime.engine.buildDigest(binding, config)
    const engine = {
      ...runtime.engine,
      markDelivered(digestId: string, receipt: string) {
        const delivered = runtime.engine.markDelivered(digestId, receipt)
        active = false
        return delivered
      },
    }
    const calls: string[] = []
    const coordinator = makeMonitoringDeliveryCoordinator({
      engine,
      nowIso: () => '2026-07-27T10:00:00.000Z',
      delivery: {
        deliver: async ({ digest }) => {
          calls.push(digest.id)
          return `telegram:${digest.id}`
        },
      },
    })

    await expect(coordinator.tick(2)).resolves.toEqual({
      due: 2,
      attempted: 1,
      delivered: 1,
      noReceipt: 0,
      failed: 0,
      skipped: 1,
    })
    expect(calls).toEqual([first.id])
    expect(runtime.store.getDigest(first.id)).toMatchObject({ status: 'delivered' })
    expect(runtime.store.getDigest(second.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'context-unavailable',
    })
  })

  it('keeps failed delivery retryable and rejects an unbounded batch before I/O', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-monitor-delivery-failure-'))
    roots.push(root)
    const runtime = makeNodeMonitoringRuntime({
      dbPath: join(root, 'monitoring.db'),
      resolveBinding: () => {},
      http: { get: async () => { throw new Error('must not collect') } },
      nowIso: () => '2026-07-27T10:00:00.000Z',
      newId: () => 'digest-failed',
    })
    const digest = runtime.engine.buildDigest({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project',
    }, {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    })
    let calls = 0
    const coordinator = makeMonitoringDeliveryCoordinator({
      engine: runtime.engine,
      nowIso: () => '2026-07-27T10:00:00.000Z',
      delivery: {
        deliver: async () => {
          calls += 1
          throw new Error('transport secret')
        },
      },
    })

    await expect(coordinator.tick(1)).resolves.toEqual({
      due: 1,
      attempted: 1,
      delivered: 0,
      noReceipt: 0,
      failed: 1,
      skipped: 0,
    })
    expect(runtime.store.getDigest(digest.id)).toMatchObject({ status: 'ready' })
    await expect(coordinator.tick(101)).rejects.toThrow(RangeError)
    expect(calls).toBe(1)
  })
})

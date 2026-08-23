import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type {
  MonitoringDeliveryCoordinator,
  MonitoringDeliveryTickResult,
} from './monitoring-runtime.js'
import type {
  MonitoringEngine,
  MonitoringEvidence,
  MonitoringStore,
  ResolvedWorkBinding,
} from '@aisy/core'
import {
  DEFAULT_MONITORING_LIVE_CONFIG,
  makeMonitoringLiveCoordinator,
  makeNodeMonitoringWindowStore,
} from './monitoring-live-runtime.js'

const BINDING: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'session-a', scope: 'project',
})
const DELIVERY_RESULT: MonitoringDeliveryTickResult = {
  due: 0, attempted: 0, delivered: 0, noReceipt: 0, failed: 0, skipped: 0,
}

function evidence(): MonitoringEvidence {
  return {
    id: 'evidence-1', sourceId: 'source-1', binding: BINDING,
    externalId: 'external-1', primaryUrl: 'https://example.com/item',
    title: 'Item', text: 'Body', collectedAt: '2026-08-12T07:00:00.000Z',
    contentHash: 'a'.repeat(64), provenance: 'untrusted', needsScoring: false,
    score: 0.9, category: 'important', summary: 'Summary', whyUseful: 'Useful',
  }
}

function setup(options: { candidates?: MonitoringEvidence[]; now?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aisy-monitoring-live-'))
  const path = join(root, 'windows.json')
  const engine = {
    tick: vi.fn(async () => []),
    buildDigest: vi.fn(() => ({
      schemaVersion: 1, id: 'digest-1', binding: BINDING,
      windowStart: '2026-08-11T08:01:00.000Z', windowEnd: '2026-08-12T08:01:00.000Z',
      notBefore: '2026-08-12T08:01:00.000Z', expiresAt: '2026-08-14T08:01:00.000Z',
      createdAt: '2026-08-12T08:01:00.000Z', status: 'ready',
      items: options.candidates?.length ? [{ evidenceId: 'evidence-1' }] : [],
    })),
  } as unknown as MonitoringEngine
  const store = {
    candidates: vi.fn(() => options.candidates ?? []),
    getDigestForWindow: vi.fn(() => null),
  } as unknown as Pick<MonitoringStore, 'candidates' | 'getDigestForWindow'>
  const delivery: MonitoringDeliveryCoordinator = {
    tick: vi.fn(async () => DELIVERY_RESULT),
  }
  const windows = makeNodeMonitoringWindowStore({ path, newTempId: () => 'temp' })
  const coordinator = makeMonitoringLiveCoordinator({
    engine, store, delivery, windows, binding: BINDING,
    nowIso: () => options.now ?? '2026-08-12T08:01:00.000Z',
    timeZone: () => 'UTC',
  })
  return { root, path, engine, store, delivery, windows, coordinator }
}

describe('monitoring LIVE coordinator', () => {
  it('uses exact bounded budgets and performs no build when the source corpus is empty', async () => {
    const h = setup()
    await expect(h.coordinator.tick()).resolves.toMatchObject({
      skipped: false, digest: 'empty', delivery: DELIVERY_RESULT,
    })
    expect(h.engine.tick).toHaveBeenCalledWith({
      maxSources: 3, maxCollectedItems: 20, maxScoringCalls: 8,
    })
    expect(h.engine.buildDigest).not.toHaveBeenCalled()
    expect(h.delivery.tick).toHaveBeenCalledWith(10)
  })

  it('builds one evidence-linked daily window and does not rebuild it after restart', async () => {
    const h = setup({ candidates: [evidence()] })
    await expect(h.coordinator.tick()).resolves.toMatchObject({ digest: 'created' })
    expect(h.engine.buildDigest).toHaveBeenCalledTimes(1)

    const restarted = makeMonitoringLiveCoordinator({
      engine: h.engine,
      store: h.store,
      delivery: h.delivery,
      windows: makeNodeMonitoringWindowStore({ path: h.path, newTempId: () => 'restart' }),
      binding: BINDING,
      nowIso: () => '2026-08-12T09:30:00.000Z',
      timeZone: () => 'UTC',
    })
    await expect(restarted.tick()).resolves.toMatchObject({ digest: 'empty' })
    expect(h.engine.buildDigest).toHaveBeenCalledTimes(1)
  })

  it('resumes an exact claimed window after a crash and reuses its original boundaries', async () => {
    const h = setup({ candidates: [evidence()] })
    const claimed = h.windows.claim({
      binding: BINDING,
      localDate: '2026-08-12',
      windowStart: '2026-08-11T08:00:00.000Z',
      windowEnd: '2026-08-12T08:00:00.000Z',
    })
    expect(claimed.status).toBe('claimed')

    await expect(h.coordinator.tick()).resolves.toMatchObject({ digest: 'created' })
    expect(h.store.candidates).toHaveBeenCalledWith(
      BINDING, '2026-08-11T08:00:00.000Z', '2026-08-12T08:00:00.000Z',
    )
  })

  it('checks the DB before rebuilding a claimed window completed before a crash', async () => {
    const h = setup({ candidates: [evidence()] })
    h.windows.claim({
      binding: BINDING,
      localDate: '2026-08-12',
      windowStart: '2026-08-11T08:00:00.000Z',
      windowEnd: '2026-08-12T08:00:00.000Z',
    })
    vi.mocked(h.store.getDigestForWindow).mockReturnValue({ id: 'already-built' } as never)

    await expect(h.coordinator.tick()).resolves.toMatchObject({ digest: 'existing' })
    expect(h.engine.buildDigest).not.toHaveBeenCalled()
  })

  it('serializes overlapping scheduler ticks', async () => {
    const h = setup({ now: '2026-08-12T07:00:00.000Z' })
    let release!: () => void
    vi.mocked(h.engine.tick).mockImplementation(() => new Promise((resolve) => { release = () => resolve([]) }))
    const first = h.coordinator.tick()
    await Promise.resolve()
    await expect(h.coordinator.tick()).resolves.toMatchObject({ skipped: true, delivery: null })
    release()
    await first
  })

  it('persists validated 0600 state and fails closed on corruption', () => {
    const h = setup()
    h.windows.claim({
      binding: BINDING,
      localDate: '2026-08-12',
      windowStart: '2026-08-11T08:00:00.000Z',
      windowEnd: '2026-08-12T08:00:00.000Z',
    })
    expect(statSync(h.path).mode & 0o777).toBe(0o600)
    expect(readFileSync(h.path, 'utf8')).not.toContain('project-a')

    writeFileSync(h.path, '{"schemaVersion":1,"windows":[{}]}')
    chmodSync(h.path, 0o600)
    expect(() => makeNodeMonitoringWindowStore({ path: h.path }))
      .toThrow('MONITORING_WINDOW_STATE_INVALID')
  })

  it('rejects unbounded production configuration', () => {
    const h = setup()
    expect(() => makeMonitoringLiveCoordinator({
      engine: h.engine,
      store: h.store,
      delivery: h.delivery,
      windows: h.windows,
      binding: BINDING,
      config: { ...DEFAULT_MONITORING_LIVE_CONFIG, maxScoringCalls: 101 },
    })).toThrow('invalid monitoring live config')
  })
})

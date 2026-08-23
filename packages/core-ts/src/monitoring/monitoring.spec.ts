import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeMonitoringEngine,
  makeMonitoringStore,
  MonitoringError,
} from './index.js'
import type {
  CollectedEvidence,
  EvidenceScoreInput,
  MonitoringCollector,
  MonitoringScorer,
} from './types.js'

const PROJECT_A = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'monitor-a',
  scope: 'project' as const,
}
const PROJECT_B = { ...PROJECT_A, projectId: 'project-b', sessionId: 'monitor-b' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function testDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-monitoring-'))
  roots.push(root)
  return join(root, 'monitoring.db')
}

function evidence(overrides: Partial<CollectedEvidence> = {}): CollectedEvidence {
  return {
    externalId: 'item-1',
    primaryUrl: 'https://example.com/news/1?utm_source=test',
    title: 'Aisy release',
    text: 'Aisy shipped an important release.',
    author: 'Alice',
    publishedAt: '2026-07-27T08:00:00.000Z',
    ...overrides,
  }
}

function harness(options: {
  dbPath?: string
  items?: CollectedEvidence[]
  bindingActive?: () => boolean
  score?: (input: EvidenceScoreInput) => number
  category?: (input: EvidenceScoreInput) => 'critical' | 'important' | 'useful' | 'noise'
  globalCriteria?: () => string | null
} = {}) {
  const dbPath = options.dbPath ?? testDb()
  const batch = { items: options.items ?? [evidence()] }
  const collector = { collect: vi.fn<MonitoringCollector['collect']>(async () => batch) }
  const scorer = {
    score: vi.fn<MonitoringScorer['score']>(async (input) => ({
      score: options.score?.(input) ?? 0.9,
      category: options.category?.(input) ?? 'important',
      summary: `Кратко: ${input.title}`,
      whyUseful: 'Соответствует критериям.',
    })),
  }
  let id = 0
  let now = '2026-07-27T09:00:00.000Z'
  const events: unknown[] = []
  const store = makeMonitoringStore({ dbPath })
  const engine = makeMonitoringEngine({
    store,
    collectors: { rss: collector },
    scorer,
    resolveBinding: () => {
      if (options.bindingActive?.() === false) throw new Error('archived')
    },
    nowIso: () => now,
    newId: () => `id-${++id}`,
    emit: (event) => events.push(event),
    ...(options.globalCriteria === undefined ? {} : { globalCriteria: options.globalCriteria }),
  })
  return {
    batch,
    collector,
    dbPath,
    engine,
    events,
    scorer,
    setNow: (value: string) => { now = value },
    store,
  }
}

function register(h: ReturnType<typeof harness>, id = 'source-a', binding = PROJECT_A) {
  return h.engine.registerSource({
    id,
    kind: 'rss',
    locator: `https://example.com/${id}.xml`,
    binding,
    criteria: 'Aisy, agents, production reliability',
    pollIntervalMs: 60_000,
  })
}

const BUDGET = { maxCollectedItems: 100, maxScoringCalls: 100 }

describe('monitoring source registry and evidence pipeline (ADR-0062)', () => {
  it('migrates an existing schema-v1 database to source-domain authority schema v3', () => {
    const dbPath = testDb()
    const legacy = new Database(dbPath)
    legacy.exec(`CREATE TABLE monitoring_sources (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      route_key TEXT NOT NULL,
      criteria TEXT NOT NULL,
      poll_interval_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      cursor TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_collected_at TEXT,
      paused_reason TEXT
    )`)
    legacy.pragma('user_version = 2')
    legacy.close()

    makeMonitoringStore({ dbPath })

    const migrated = new Database(dbPath, { readonly: true })
    expect(migrated.pragma('user_version', { simple: true })).toBe(3)
    expect(migrated.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name='monitoring_followups'`).get()).toEqual({
      name: 'monitoring_followups',
    })
    expect(migrated.prepare('PRAGMA table_info(monitoring_sources)').all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'egress_domain' })]))
    migrated.close()
  })

  it('persists a private exact-bound source and restores it after restart without cross-project listing', () => {
    const h = harness()
    register(h)

    expect(statSync(h.dbPath).mode & 0o777).toBe(0o600)
    const restarted = makeMonitoringStore({ dbPath: h.dbPath })
    expect(restarted.listSources(PROJECT_A)).toEqual([
      expect.objectContaining({ id: 'source-a', binding: PROJECT_A, status: 'active' }),
    ])
    expect(restarted.listSources(PROJECT_B)).toEqual([])
  })

  it('retains exact HTTPS authority through pause/resume and revokes it only on exact removal', () => {
    const h = harness()
    const source = register(h)
    const sibling = register(h, 'source-b')

    expect(h.store.getSourceEgressDomain(source.id)).toBe('example.com')
    expect(h.engine.pauseSource(source.id, PROJECT_A)).toMatchObject({
      status: 'paused', pausedReason: 'operator', locator: source.locator,
    })
    expect(h.store.getSourceEgressDomain(source.id)).toBe('example.com')
    expect(h.engine.resumeSource(source.id, PROJECT_A)).toMatchObject({ status: 'active' })
    expect(h.store.getSourceEgressDomain(source.id)).toBe('example.com')

    expect(() => h.store.updateSource({
      ...source,
      locator: 'https://other.example.net/feed.xml',
      updatedAt: '2026-07-27T09:01:00.000Z',
    })).toThrowError(expect.objectContaining<Partial<MonitoringError>>({
      code: 'BINDING_MISMATCH',
    }))
    expect(() => h.engine.removeSource(source.id, PROJECT_B)).toThrowError(
      expect.objectContaining<Partial<MonitoringError>>({ code: 'BINDING_MISMATCH' }),
    )
    expect(() => h.engine.pauseSource(source.id, PROJECT_B)).toThrowError(
      expect.objectContaining<Partial<MonitoringError>>({ code: 'BINDING_MISMATCH' }),
    )
    expect(() => h.engine.resumeSource(source.id, PROJECT_B)).toThrowError(
      expect.objectContaining<Partial<MonitoringError>>({ code: 'BINDING_MISMATCH' }),
    )
    expect(h.store.getSourceEgressDomain(source.id)).toBe('example.com')

    h.engine.removeSource(source.id, PROJECT_A)
    expect(h.store.getSourceEgressDomain(source.id)).toBeNull()
    expect(h.store.getSource(source.id)).toBeNull()
    expect(h.store.getSourceEgressDomain(sibling.id)).toBe('example.com')
    expect(h.store.listSources(PROJECT_A)).toEqual([expect.objectContaining({ id: sibling.id })])
  })

  it('does not promote a legacy source without an explicit exact-domain grant', () => {
    const h = harness()
    const source = register(h)
    const raw = new Database(h.dbPath)
    raw.prepare('UPDATE monitoring_sources SET egress_domain=NULL WHERE id=?').run(source.id)
    raw.pragma('user_version = 2')
    raw.close()

    const restarted = makeMonitoringStore({ dbPath: h.dbPath })
    expect(restarted.getSourceEgressDomain(source.id)).toBeNull()
    expect(restarted.listSources(PROJECT_A)).toEqual([])
    const inspected = new Database(h.dbPath, { readonly: true })
    expect(inspected.prepare('SELECT status, paused_reason, egress_domain FROM monitoring_sources WHERE id=?')
      .get(source.id)).toEqual({
        status: 'quarantined', paused_reason: 'invalid-binding', egress_domain: null,
      })
    inspected.close()
  })

  it('rejects HTTP source registration before persistence', () => {
    const h = harness()
    expect(() => h.engine.registerSource({
      id: 'source-http',
      kind: 'rss',
      locator: 'http://example.com/feed.xml',
      binding: PROJECT_A,
      criteria: '',
      pollIntervalMs: 60_000,
    })).toThrowError(expect.objectContaining<Partial<MonitoringError>>({ code: 'INVALID_SOURCE' }))
    expect(h.store.getSourceEgressDomain('source-http')).toBeNull()
    expect(() => h.engine.registerSource({
      id: 'source-secret-query',
      kind: 'rss',
      locator: 'https://example.com/feed.xml?token=must-not-leave',
      binding: PROJECT_A,
      criteria: '',
      pollIntervalMs: 60_000,
    })).toThrowError(expect.objectContaining<Partial<MonitoringError>>({ code: 'INVALID_SOURCE' }))
    expect(h.store.getSourceEgressDomain('source-secret-query')).toBeNull()
    expect(() => h.store.registerSource({
      schemaVersion: 1,
      id: 'source-direct-secret',
      kind: 'rss',
      locator: 'https://example.com/feed.xml?authorization=must-not-leave',
      binding: PROJECT_A,
      criteria: '',
      pollIntervalMs: 60_000,
      status: 'active',
      createdAt: '2026-07-27T09:00:00.000Z',
      updatedAt: '2026-07-27T09:00:00.000Z',
    })).toThrowError(expect.objectContaining<Partial<MonitoringError>>({ code: 'INVALID_SOURCE' }))
  })

  it('scores only new/changed untrusted evidence and makes it searchable with a primary URL', async () => {
    const h = harness()
    register(h)

    await expect(h.engine.poll('source-a', BUDGET)).resolves.toMatchObject({
      inserted: 1,
      changed: 0,
      unchanged: 0,
      scored: 1,
    })
    expect(h.scorer.score).toHaveBeenCalledWith(expect.objectContaining({
      provenance: 'untrusted',
      outboundAllowed: false,
    }))
    expect(h.store.search(PROJECT_A, 'important release', 10)).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          primaryUrl: 'https://example.com/news/1',
          provenance: 'untrusted',
          category: 'important',
        }),
      }),
    ])
    expect(h.store.search(PROJECT_B, 'important release', 10)).toEqual([])
  })

  it('rejects private evidence from any collector before storage and scorer I/O', async () => {
    const h = harness({ items: [evidence({ primaryUrl: 'http://127.0.0.1/internal' })] })
    register(h)

    await expect(h.engine.poll('source-a', BUDGET))
      .rejects.toThrowError(expect.objectContaining<Partial<MonitoringError>>({
        code: 'INVALID_EVIDENCE',
      }))
    expect(h.scorer.score).not.toHaveBeenCalled()
    expect(h.store.search(PROJECT_A, 'important release', 10)).toEqual([])
  })

  it('uses zero scorer/model calls for an unchanged already-scored poll', async () => {
    const h = harness()
    register(h)
    await h.engine.poll('source-a', BUDGET)
    h.scorer.score.mockClear()

    await expect(h.engine.poll('source-a', BUDGET)).resolves.toMatchObject({
      inserted: 0,
      changed: 0,
      unchanged: 1,
      scored: 0,
      scoringDeferred: 0,
    })
    expect(h.scorer.score).not.toHaveBeenCalled()
  })

  it('invalidates only a changed item and scores it again', async () => {
    const h = harness()
    register(h)
    await h.engine.poll('source-a', BUDGET)
    h.scorer.score.mockClear()
    h.batch.items = [evidence({ text: 'Aisy shipped a corrected production release.' })]

    await expect(h.engine.poll('source-a', BUDGET)).resolves.toMatchObject({ changed: 1, scored: 1 })
    expect(h.scorer.score).toHaveBeenCalledTimes(1)
  })

  it('deduplicates identical content across sources in the same binding', async () => {
    const h = harness()
    register(h, 'source-a')
    register(h, 'source-b')
    await h.engine.poll('source-a', BUDGET)
    h.scorer.score.mockClear()

    await expect(h.engine.poll('source-b', BUDGET)).resolves.toMatchObject({
      inserted: 0,
      duplicates: 1,
      scored: 0,
    })
    expect(h.scorer.score).not.toHaveBeenCalled()
  })

  it('enforces scoring budget and retries still-pending evidence without rescoring completed items', async () => {
    const h = harness({ items: [
      evidence({ externalId: 'one', primaryUrl: 'https://example.com/1', text: 'one' }),
      evidence({ externalId: 'two', primaryUrl: 'https://example.com/2', text: 'two' }),
    ] })
    register(h)
    await expect(h.engine.poll('source-a', { maxCollectedItems: 10, maxScoringCalls: 1 }))
      .resolves.toMatchObject({ inserted: 2, scored: 1, scoringDeferred: 1 })
    h.scorer.score.mockClear()

    await expect(h.engine.poll('source-a', { maxCollectedItems: 10, maxScoringCalls: 1 }))
      .resolves.toMatchObject({ unchanged: 2, scored: 1, scoringDeferred: 0 })
    expect(h.scorer.score).toHaveBeenCalledTimes(1)
  })

  it('pauses an archived binding before collector and scorer I/O and keeps that state after restart', async () => {
    let active = true
    const h = harness({ bindingActive: () => active })
    register(h)
    active = false

    await expect(h.engine.poll('source-a', BUDGET)).resolves.toMatchObject({
      status: 'paused',
      reason: 'context-unavailable',
    })
    expect(h.collector.collect).not.toHaveBeenCalled()
    expect(h.scorer.score).not.toHaveBeenCalled()
    expect(makeMonitoringStore({ dbPath: h.dbPath }).getSource('source-a')).toMatchObject({
      status: 'paused',
      pausedReason: 'context-unavailable',
    })
  })

  it('ticks a new source immediately, respects interval, and never creates a catch-up storm', async () => {
    const h = harness()
    register(h)
    await expect(h.engine.tick({ maxSources: 10, ...BUDGET })).resolves.toHaveLength(1)
    expect(h.collector.collect).toHaveBeenCalledTimes(1)

    h.setNow('2026-07-27T09:00:30.000Z')
    await expect(h.engine.tick({ maxSources: 10, ...BUDGET })).resolves.toEqual([])
    h.setNow('2026-07-27T09:01:00.000Z')
    await expect(h.engine.tick({ maxSources: 10, ...BUDGET })).resolves.toHaveLength(1)
    expect(h.collector.collect).toHaveBeenCalledTimes(2)
  })

  it('debits failed scorer attempts from the global tick budget', async () => {
    const store = makeMonitoringStore({ dbPath: testDb() })
    const score = vi.fn<MonitoringScorer['score']>(async () => { throw new Error('provider down') })
    let id = 0
    const engine = makeMonitoringEngine({
      store,
      collectors: {
        rss: {
          collect: async (source) => ({
            items: [evidence({
              externalId: source.id,
              primaryUrl: `https://example.com/${source.id}`,
              title: source.id,
              text: `content ${source.id}`,
            })],
          }),
        },
      },
      scorer: { score },
      resolveBinding: () => {},
      nowIso: () => '2026-07-27T09:00:00.000Z',
      newId: () => `id-${++id}`,
    })
    for (const sourceId of ['source-a', 'source-b']) {
      engine.registerSource({
        id: sourceId,
        kind: 'rss',
        locator: `https://example.com/${sourceId}.xml`,
        binding: PROJECT_A,
        criteria: '',
        pollIntervalMs: 60_000,
      })
    }

    const results = await engine.tick({ maxSources: 2, maxCollectedItems: 2, maxScoringCalls: 1 })
    expect(score).toHaveBeenCalledTimes(1)
    expect(results.map((result) => result.scoringCalls)).toEqual([1, 0])
    expect(results[1]).toMatchObject({ scoringDeferred: 1, scored: 0 })
  })

  it('quarantines an unscoped persisted digest instead of routing it as global or crashing due delivery', () => {
    const h = harness()
    const raw = new Database(h.dbPath)
    raw.prepare(`INSERT INTO monitoring_digests
      (id,schema_version,binding_json,route_key,window_start,window_end,not_before,expires_at,
       created_at,status,items_json)
      VALUES ('legacy',1,'{}','legacy','2026-07-27T00:00:00.000Z','2026-07-27T09:00:00.000Z',
       '2026-07-27T09:00:00.000Z','2026-07-27T12:00:00.000Z','2026-07-27T09:00:00.000Z','ready','[]')`).run()
    raw.close()

    expect(h.engine.listDueDigests('2026-07-27T10:00:00.000Z')).toEqual([])
    const inspect = new Database(h.dbPath, { readonly: true })
    expect(inspect.prepare('SELECT status, paused_reason FROM monitoring_digests WHERE id=?')
      .get('legacy')).toEqual({ status: 'quarantined', paused_reason: 'invalid-binding' })
    inspect.close()
  })
})

describe('evidence-linked digest', () => {
  it('applies time decay and author/source diversity while retaining primary evidence links', async () => {
    const h = harness({
      items: [
        evidence({ externalId: 'new-alice', primaryUrl: 'https://example.com/new', title: 'New Alice', text: 'new alice', publishedAt: '2026-07-27T08:00:00.000Z' }),
        evidence({ externalId: 'old-alice', primaryUrl: 'https://example.com/old', title: 'Old Alice', text: 'old alice', publishedAt: '2026-07-26T08:00:00.000Z' }),
        evidence({ externalId: 'bob', primaryUrl: 'https://example.com/bob', title: 'Bob', text: 'bob item', author: 'Bob', publishedAt: '2026-07-27T07:00:00.000Z' }),
      ],
    })
    register(h)
    await h.engine.poll('source-a', BUDGET)

    const digest = h.engine.buildDigest(PROJECT_A, {
      windowStart: '2026-07-26T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 3,
      maxPerSource: 3,
      maxPerAuthor: 1,
      halfLifeHours: 24,
    })

    expect(digest.status).toBe('ready')
    expect(digest.items.map((item) => item.title)).toEqual(['New Alice', 'Bob'])
    expect(digest.items.every((item) => item.primaryUrl.startsWith('https://'))).toBe(true)
    expect(digest.items[0]!.rankScore).toBeGreaterThan(digest.items[1]!.rankScore)
    expect(h.engine.markDelivered(digest.id, 'telegram:message-42')).toMatchObject({
      status: 'delivered',
      deliveryReceipt: 'telegram:message-42',
    })
    expect(h.engine.listDueDigests('2026-07-27T10:00:00.000Z')).toEqual([])
  })

  it('survives restart, remains Project A after a switch to B, and pauses before delivery after archive', async () => {
    let active = true
    const h = harness({ bindingActive: () => active })
    register(h)
    await h.engine.poll('source-a', BUDGET)
    const digest = h.engine.buildDigest(PROJECT_A, {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    })
    expect(digest.binding).toEqual(PROJECT_A)

    const restarted = harness({ dbPath: h.dbPath, bindingActive: () => active })
    expect(restarted.engine.listDueDigests('2026-07-27T10:00:00.000Z')).toEqual([
      expect.objectContaining({ id: digest.id, binding: PROJECT_A }),
    ])
    expect(restarted.store.listSources(PROJECT_B)).toEqual([])

    active = false
    expect(restarted.engine.listDueDigests('2026-07-27T10:01:00.000Z')).toEqual([])
    expect(restarted.store.getDigest(digest.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'context-unavailable',
    })
    expect(() => restarted.engine.markDelivered(digest.id, 'telegram:receipt'))
      .toThrowError(expect.objectContaining<Partial<MonitoringError>>({ code: 'CONTEXT_UNAVAILABLE' }))
  })

  it('stages feedback without mutating policy and rejects cross-project feedback', async () => {
    const h = harness()
    register(h)
    await h.engine.poll('source-a', BUDGET)
    const digest = h.engine.buildDigest(PROJECT_A, {
      windowStart: '2026-07-27T00:00:00.000Z',
      windowEnd: '2026-07-27T09:00:00.000Z',
      notBefore: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T12:00:00.000Z',
      maxItems: 10,
      maxPerSource: 10,
      maxPerAuthor: 10,
      halfLifeHours: 24,
    })
    const evidenceId = digest.items[0]!.evidenceId

    expect(h.engine.stageFeedback({ binding: PROJECT_A, digestId: digest.id, evidenceId, verdict: 'important' }))
      .toMatchObject({ status: 'staged', verdict: 'important', binding: PROJECT_A })
    expect(() => h.engine.stageFeedback({ binding: PROJECT_B, digestId: digest.id, evidenceId, verdict: 'not-useful' }))
      .toThrowError(expect.objectContaining<Partial<MonitoringError>>({ code: 'BINDING_MISMATCH' }))
  })
})

describe('digest ranking factors', () => {
  const window = {
    windowStart: '2026-07-26T00:00:00.000Z',
    windowEnd: '2026-07-27T09:00:00.000Z',
    notBefore: '2026-07-27T09:00:00.000Z',
    expiresAt: '2026-07-27T12:00:00.000Z',
    maxItems: 5,
    maxPerSource: 5,
    maxPerAuthor: 5,
    halfLifeHours: 24,
  }

  it('lets an older critical item outrank a fresh useful one', async () => {
    const h = harness({
      items: [
        evidence({ externalId: 'fresh', title: 'Fresh useful', text: 'useful', publishedAt: '2026-07-27T08:00:00.000Z' }),
        evidence({ externalId: 'old', title: 'Old critical', text: 'critical', publishedAt: '2026-07-26T20:00:00.000Z' }),
      ],
      category: (input) => (input.title.includes('critical') ? 'critical' : 'useful'),
    })
    register(h)
    await h.engine.poll('source-a', BUDGET)

    const digest = h.engine.buildDigest(PROJECT_A, window)

    expect(digest.items.map((item) => item.title)).toEqual(['Old critical', 'Fresh useful'])
  })

  it('applies a per-kind half-life so a slow feed does not decay like a chat', async () => {
    const h = harness({
      items: [evidence({ externalId: 'a', title: 'Release notes', text: 'release', publishedAt: '2026-07-26T09:00:00.000Z' })],
    })
    register(h)
    await h.engine.poll('source-a', BUDGET)

    const fast = h.engine.buildDigest(PROJECT_A, { ...window, halfLifeHours: 6 })
    const slow = h.engine.buildDigest(PROJECT_A, {
      ...window,
      halfLifeHours: 6,
      halfLifeHoursByKind: { rss: 240 },
    })

    expect(slow.items[0]!.rankScore).toBeGreaterThan(fast.items[0]!.rankScore)
  })

  it('keeps noise out of the digest by default', async () => {
    const h = harness({
      items: [evidence({ externalId: 'spam', title: 'Spam', text: 'spam' })],
      category: () => 'noise',
    })
    register(h)
    await h.engine.poll('source-a', BUDGET)

    expect(h.engine.buildDigest(PROJECT_A, window).items).toEqual([])
  })

  it('refuses a ranking configuration that makes no sense', async () => {
    const h = harness()
    register(h)

    expect(() => h.engine.buildDigest(PROJECT_A, { ...window, halfLifeHoursByKind: { rss: 0 } }))
      .toThrowError()
    expect(() => h.engine.buildDigest(PROJECT_A, { ...window, categoryWeights: { critical: -1 } }))
      .toThrowError()
  })
})

describe('monitoring retention', () => {
  const window = {
    windowStart: '2026-07-20T00:00:00.000Z',
    windowEnd: '2026-07-27T09:00:00.000Z',
    notBefore: '2026-07-27T09:00:00.000Z',
    expiresAt: '2026-07-27T12:00:00.000Z',
    maxItems: 5,
    maxPerSource: 5,
    maxPerAuthor: 5,
    halfLifeHours: 24,
  }

  async function filled(count: number) {
    const h = harness({
      items: Array.from({ length: count }, (_, i) => evidence({
        externalId: `e${i}`,
        primaryUrl: `https://example.com/${i}`,
        title: `Материал ${i}`,
        text: `тело ${i}`,
        publishedAt: `2026-07-${String(20 + (i % 7)).padStart(2, '0')}T09:00:00.000Z`,
      })),
    })
    register(h)
    await h.engine.poll('source-a', BUDGET)
    return h
  }

  it('drops evidence older than the retention window', async () => {
    const h = await filled(7)

    const result = h.store.prune({
      olderThan: '2026-07-24T00:00:00.000Z',
      maxRows: 1000,
      now: '2026-07-27T09:00:00.000Z',
    })

    expect(result.byAge).toBe(4)
    expect(result.kept).toBe(3)
  })

  it('drops the oldest rows once the table is over the volume cap', async () => {
    const h = await filled(7)

    const result = h.store.prune({
      olderThan: '2026-01-01T00:00:00.000Z',
      maxRows: 2,
      now: '2026-07-27T09:00:00.000Z',
    })

    expect(result.byAge).toBe(0)
    expect(result.byVolume).toBe(5)
    expect(result.kept).toBe(2)
  })

  it('keeps evidence a live digest still links to', async () => {
    const h = await filled(3)
    const digest = h.engine.buildDigest(PROJECT_A, window)
    expect(digest.items.length).toBeGreaterThan(0)

    const result = h.store.prune({
      olderThan: '2026-12-31T00:00:00.000Z',
      maxRows: 0,
      now: '2026-07-27T10:00:00.000Z',
    })

    expect(result.kept).toBe(digest.items.length)
  })

  it('stops protecting evidence once the digest has expired', async () => {
    const h = await filled(3)
    h.engine.buildDigest(PROJECT_A, window)

    const result = h.store.prune({
      olderThan: '2026-12-31T00:00:00.000Z',
      maxRows: 0,
      now: '2026-07-28T00:00:00.000Z',
    })

    expect(result.kept).toBe(0)
  })

  it('removes the search index along with the evidence', async () => {
    const h = await filled(3)
    h.store.prune({
      olderThan: '2026-12-31T00:00:00.000Z',
      maxRows: 0,
      now: '2026-07-28T00:00:00.000Z',
    })

    expect(h.store.search(PROJECT_A, 'Материал', 10)).toEqual([])
  })

  it('refuses a nonsensical volume cap instead of deleting everything', async () => {
    const h = await filled(2)

    expect(() => h.store.prune({
      olderThan: '2026-07-01T00:00:00.000Z',
      maxRows: -1,
      now: '2026-07-27T09:00:00.000Z',
    })).toThrowError()
  })
})

describe('digest criteria', () => {
  it('narrows the operator-wide criteria with the source\'s own', async () => {
    const h = harness({ globalCriteria: () => 'Только про production-надёжность' })
    register(h)

    await h.engine.poll('source-a', BUDGET)

    expect(h.scorer.score).toHaveBeenCalledWith(expect.objectContaining({
      criteria: expect.stringContaining('Только про production-надёжность'),
    }))
    expect(h.scorer.score).toHaveBeenCalledWith(expect.objectContaining({
      criteria: expect.stringContaining('Для этого источника:'),
    }))
  })

  it('falls back to the source criteria when there are no global ones', async () => {
    const h = harness()
    register(h)

    await h.engine.poll('source-a', BUDGET)

    expect(h.scorer.score).toHaveBeenCalledWith(expect.objectContaining({
      criteria: 'Aisy, agents, production reliability',
    }))
  })

  it('keeps scoring when the global criteria cannot be read', async () => {
    const h = harness({ globalCriteria: () => { throw new Error('EACCES') } })
    register(h)

    const result = await h.engine.poll('source-a', BUDGET)

    expect(result.scored).toBeGreaterThan(0)
  })
})

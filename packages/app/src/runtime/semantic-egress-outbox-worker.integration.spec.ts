import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeSemanticEgressConsentAuthority,
  makeSemanticEgressOutboxWorker,
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  semanticDescriptorId,
  type SemanticEgressConsentBinding,
  type SemanticEgressConsentChallengeV1,
  type SemanticEgressOutboxDurablePort,
  type SemanticEgressOutboxEventV1,
} from '@aisy/core'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeNodeSemanticEgressConsentStore } from './semantic-egress-consent-store.js'

const roots: string[] = []
const SECRET = new Uint8Array(32).fill(11)
const START = Date.parse('2026-08-01T08:00:00.000Z')

function databasePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-semantic-outbox-worker-')))
  roots.push(root)
  return join(root, 'private', 'semantic-egress.sqlite')
}

function binding(): SemanticEgressConsentBinding {
  const descriptor = {
    provider: 'openrouter' as const,
    modelId: 'openai/text-embedding-3-small',
    modelRevision: '2026-08-01',
    dimensions: 1536,
    normalizationVersion: 'nfkc-lf-v1',
    chunkerVersion: 'memory-fact-v1',
  }
  return {
    operatorId: 'operator-outbox',
    profileId: 'profile-outbox',
    purpose: 'memory.semantic-embedding.v1',
    provider: 'openrouter',
    connectionId: 'connection-outbox',
    connectionRevision: 'ready-record-1',
    descriptor,
    semanticDescriptorId: semanticDescriptorId(descriptor),
    scope: {
      kind: 'profile-memory',
      includeGlobal: true,
      includeOwnedProjects: true,
      includeFutureOwnedProjects: true,
      includeArchived: false,
      excludedCategories: SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
    },
    disclosure: {
      revision: SEMANTIC_EGRESS_DISCLOSURE_REVISION,
      hash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
      destination: 'openrouter',
      dataClasses: ['query', 'chunks'],
      scopePolicy: 'profile-global-and-owned-projects',
      dataCollectionDenyRequested: true,
    },
  }
}

function proof(challenge: SemanticEgressConsentChallengeV1) {
  return {
    cardId: challenge.cardId,
    actionId: challenge.actionId,
    actionHash: challenge.actionHash,
    confirmedAt: challenge.issuedAt,
    stepUpVerified: true,
  }
}

async function fixture(eventCount: 1 | 2) {
  const path = databasePath()
  const store = makeNodeSemanticEgressConsentStore({ path })
  let now = START
  let serial = 0
  const authority = makeSemanticEgressConsentAuthority({
    secret: SECRET,
    bootId: 'boot-outbox',
    durable: store.durable,
    nowMs: () => now,
    newId: () => `outbox-id-${++serial}`,
    health: async () => 'healthy',
    purgeAndVerify: async () => true,
  })
  await authority.recoverForBoot()
  const challenge = await authority.beginConsent(binding(), null)
  if (eventCount === 2) {
    now += 1_000
    await authority.confirmConsent({
      operatorId: binding().operatorId,
      profileId: binding().profileId,
      purpose: binding().purpose,
    }, challenge.authorityRevision, proof(challenge))
  }
  const events = await store.durable.readOutbox(10)
  expect(events).toHaveLength(eventCount)
  return { path, store, events }
}

function effectiveOnceSink() {
  const applied = new Map<string, SemanticEgressOutboxEventV1>()
  const attempts: SemanticEgressOutboxEventV1[] = []
  return {
    applied,
    attempts,
    sink: {
      async deliver(event: SemanticEgressOutboxEventV1, signal: AbortSignal) {
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal.aborted).toBe(false)
        attempts.push(structuredClone(event))
        if (applied.has(event.eventId)) return { status: 'duplicate-exact' } as const
        applied.set(event.eventId, structuredClone(event))
        return { status: 'accepted' } as const
      },
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Semantic egress outbox worker with the real SQLite store', () => {
  it('redelivers the exact event after sink apply followed by an ack crash', async () => {
    const { path, store, events } = await fixture(1)
    const receiver = effectiveOnceSink()
    const durable = {
      readOutbox: store.durable.readOutbox.bind(store.durable),
      ackOutboxHead: vi.fn(async () => { throw new Error('simulated ack crash') }),
    } satisfies SemanticEgressOutboxDurablePort
    const crashed = makeSemanticEgressOutboxWorker({ durable, sink: receiver.sink })
    await expect(crashed.run()).rejects.toBeDefined()
    expect(receiver.attempts).toEqual(events)
    expect(receiver.applied.size).toBe(1)
    store.close()

    const restarted = makeNodeSemanticEgressConsentStore({ path })
    const recovered = makeSemanticEgressOutboxWorker({
      durable: restarted.durable,
      sink: receiver.sink,
    })
    await expect(recovered.run()).resolves.toEqual({
      read: 1, accepted: 0, duplicates: 1, acknowledged: 1,
    })
    expect(receiver.attempts).toEqual([events[0], events[0]])
    expect(receiver.applied.size).toBe(1)
    await expect(restarted.durable.readOutbox(10)).resolves.toEqual([])
    restarted.close()
  })

  it('does not redeliver an acknowledged event after restart', async () => {
    const { path, store, events } = await fixture(1)
    const receiver = effectiveOnceSink()
    const worker = makeSemanticEgressOutboxWorker({ durable: store.durable, sink: receiver.sink })
    await expect(worker.run()).resolves.toEqual({
      read: 1, accepted: 1, duplicates: 0, acknowledged: 1,
    })
    store.close()

    const restarted = makeNodeSemanticEgressConsentStore({ path })
    const afterRestart = makeSemanticEgressOutboxWorker({
      durable: restarted.durable,
      sink: receiver.sink,
    })
    await expect(afterRestart.run()).resolves.toEqual({
      read: 0, accepted: 0, duplicates: 0, acknowledged: 0,
    })
    expect(receiver.attempts).toEqual(events)
    restarted.close()
  })

  it('stops at a failed delivery and preserves it and every later event', async () => {
    const { store, events } = await fixture(2)
    const deliver = vi.fn(async (_event: SemanticEgressOutboxEventV1, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      throw new Error('sink unavailable')
    })
    const worker = makeSemanticEgressOutboxWorker({ durable: store.durable, sink: { deliver } })
    await expect(worker.run()).rejects.toBeDefined()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(events[0], expect.any(AbortSignal))
    await expect(store.durable.readOutbox(10)).resolves.toEqual(events)
    store.close()
  })

  it('delivers nothing when persisted outbox content is tampered', async () => {
    const { path, store } = await fixture(1)
    store.close()
    const raw = new Database(path)
    raw.prepare(`UPDATE semantic_egress_outbox SET payload = '{'`).run()
    raw.close()

    const restarted = makeNodeSemanticEgressConsentStore({ path })
    const deliver = vi.fn(async (
      _event: SemanticEgressOutboxEventV1,
      _signal: AbortSignal,
    ) => ({ status: 'accepted' as const }))
    const worker = makeSemanticEgressOutboxWorker({ durable: restarted.durable, sink: { deliver } })
    await expect(worker.run()).rejects.toBeDefined()
    expect(deliver).not.toHaveBeenCalled()
    restarted.close()
  })

  it('serializes concurrent runs without reordering or duplicate application', async () => {
    const { store, events } = await fixture(2)
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const entered = new Promise<void>(resolve => { firstEntered = resolve })
    const release = new Promise<void>(resolve => { releaseFirst = resolve })
    const applied: SemanticEgressOutboxEventV1[] = []
    const sink = {
      async deliver(event: SemanticEgressOutboxEventV1, signal: AbortSignal) {
        expect(signal.aborted).toBe(false)
        if (applied.length === 0) {
          firstEntered()
          await release
        }
        applied.push(structuredClone(event))
        return { status: 'accepted' } as const
      },
    }
    const worker = makeSemanticEgressOutboxWorker({ durable: store.durable, sink })
    const first = worker.run()
    await entered
    const concurrent = worker.run()
    releaseFirst()
    await expect(Promise.all([first, concurrent])).resolves.toBeDefined()
    expect(applied).toEqual(events)
    await expect(store.durable.readOutbox(10)).resolves.toEqual([])
    store.close()
  })

  it('times out before ack and retries a late accepted result after restart', async () => {
    const { path, store, events } = await fixture(1)
    const applied = new Map<string, SemanticEgressOutboxEventV1>()
    let releaseLate!: () => void
    let deliverySignal: AbortSignal | undefined
    const lateResult = new Promise<{ status: 'accepted' }>(resolve => {
      releaseLate = () => resolve({ status: 'accepted' })
    })
    const timedOut = makeSemanticEgressOutboxWorker({
      durable: store.durable,
      deliveryTimeoutMs: 10,
      sink: {
        async deliver(event, signal) {
          expect(signal.aborted).toBe(false)
          deliverySignal = signal
          applied.set(event.eventId, structuredClone(event))
          return lateResult
        },
      },
    })
    await expect(timedOut.run()).rejects.toBeDefined()
    expect(deliverySignal?.aborted).toBe(true)
    expect(applied.size).toBe(1)
    releaseLate()
    await lateResult
    await expect(store.durable.readOutbox(10)).resolves.toEqual(events)
    store.close()

    const restarted = makeNodeSemanticEgressConsentStore({ path })
    const attempts: SemanticEgressOutboxEventV1[] = []
    const recovered = makeSemanticEgressOutboxWorker({
      durable: restarted.durable,
      sink: {
        async deliver(event, signal) {
          expect(signal.aborted).toBe(false)
          attempts.push(structuredClone(event))
          return { status: applied.has(event.eventId) ? 'duplicate-exact' : 'accepted' }
        },
      },
    })
    await expect(recovered.run()).resolves.toEqual({
      read: 1, accepted: 0, duplicates: 1, acknowledged: 1,
    })
    expect(attempts).toEqual(events)
    await expect(restarted.durable.readOutbox(10)).resolves.toEqual([])
    restarted.close()
  })
})

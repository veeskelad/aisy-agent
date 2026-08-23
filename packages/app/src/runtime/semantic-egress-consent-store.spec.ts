import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  semanticEgressBindingHash,
  semanticEgressConsentActionHash,
  semanticEgressOutboxEventId,
  semanticEgressRequestEventId,
  semanticDescriptorId,
  type SemanticEgressActiveConsentRecordV1,
  type SemanticEgressAwaitingConsentRecordV1,
  type SemanticEgressConsentBinding,
  type SemanticEgressConsentRecordV1,
  type SemanticEgressConsentSlot,
  type SemanticEgressDurableTransitionV1,
  type SemanticEgressOutboxEventV1,
  type SemanticEgressRevokingConsentRecordV1,
} from '@aisy/core'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeNodeSemanticEgressConsentStore,
  SemanticEgressConsentSqliteStoreError,
} from './semantic-egress-consent-store.js'

const roots: string[] = []
const NOW = '2026-07-29T12:00:00.000Z'
const LATER = '2026-07-29T12:00:01.000Z'
const EXPIRES = '2026-07-29T12:05:00.000Z'

function slot(profileId = 'default'): SemanticEgressConsentSlot {
  return {
    operatorId: 'telegram:42',
    profileId,
    purpose: 'memory.semantic-embedding.v1',
  }
}

function binding(profileId = 'default'): SemanticEgressConsentBinding {
  const descriptor = {
    provider: 'openrouter' as const,
    modelId: 'openai/text-embedding-3-small',
    modelRevision: '2026-07-29',
    dimensions: 1536,
    normalizationVersion: 'nfkc-v1',
    chunkerVersion: 'fact-v1',
  }
  return {
    ...slot(profileId),
    provider: 'openrouter',
    connectionId: `connection-${profileId}`,
    connectionRevision: 'opaque-revision-1',
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

function awaiting(profileId = 'default', bootId = 'boot-old'): SemanticEgressAwaitingConsentRecordV1 {
  const value = binding(profileId)
  const authorityId = `authority-${profileId}`
  const authorityRevision = 1
  const generation = 1
  const actionId = `action-${profileId}`
  const cardId = `card-${profileId}`
  const nonceId = `grant-${profileId}`
  return {
    schemaVersion: 1,
    authorityId,
    revision: authorityRevision,
    generation,
    binding: value,
    state: 'AWAITING_CONSENT',
    pending: {
      bootId,
      authorityRevision,
      generation,
      actionId,
      actionHash: semanticEgressConsentActionHash({
        authorityId,
        authorityRevision,
        generation,
        binding: value,
        bootId,
        actionId,
        cardId,
        nonceId,
        issuedAt: NOW,
        expiresAt: EXPIRES,
      }),
      cardId,
      nonceId,
      issuedAt: NOW,
      expiresAt: EXPIRES,
      invalidatedAt: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function consented(
  pendingRecord: SemanticEgressAwaitingConsentRecordV1,
): SemanticEgressActiveConsentRecordV1 {
  return {
    schemaVersion: 1,
    authorityId: pendingRecord.authorityId,
    revision: pendingRecord.revision + 1,
    generation: pendingRecord.generation + 1,
    binding: pendingRecord.binding,
    state: 'CONSENTED',
    approval: {
      bootId: pendingRecord.pending.bootId,
      authorityRevision: pendingRecord.pending.authorityRevision,
      generation: pendingRecord.pending.generation,
      actionId: pendingRecord.pending.actionId,
      actionHash: pendingRecord.pending.actionHash,
      cardId: pendingRecord.pending.cardId,
      acceptedAt: LATER,
      expiresAt: pendingRecord.pending.expiresAt,
    },
    authorityNonce: {
      nonceId: pendingRecord.pending.nonceId,
      issuedAt: pendingRecord.pending.issuedAt,
      consumedAt: LATER,
    },
    createdAt: pendingRecord.createdAt,
    updatedAt: LATER,
  }
}

function nextState(
  current: SemanticEgressActiveConsentRecordV1,
  state: SemanticEgressActiveConsentRecordV1['state'],
  at = '2026-07-29T12:00:02.000Z',
): SemanticEgressActiveConsentRecordV1 {
  return {
    ...current,
    revision: current.revision + 1,
    generation: current.generation + 1,
    state,
    updatedAt: at,
  }
}

function event(
  record: SemanticEgressConsentRecordV1,
  _eventId: string,
  kind: SemanticEgressOutboxEventV1['kind'],
  at = record.updatedAt,
  code?: string,
): SemanticEgressOutboxEventV1 {
  return {
    schemaVersion: 1,
    eventId: semanticEgressOutboxEventId({
      authorityId: record.authorityId,
      authorityRevision: record.revision,
      kind,
    }),
    kind,
    operatorId: record.binding.operatorId,
    profileId: record.binding.profileId,
    purpose: record.binding.purpose,
    authorityId: record.authorityId,
    authorityRevision: record.revision,
    generation: record.generation,
    connectionId: record.binding.connectionId,
    connectionRevision: record.binding.connectionRevision,
    semanticDescriptorId: record.binding.semanticDescriptorId,
    disclosureRevision: record.binding.disclosure.revision,
    disclosureHash: record.binding.disclosure.hash,
    ...(code === undefined ? {} : { code }),
    at,
  }
}

function useStart(
  record: SemanticEgressActiveConsentRecordV1,
  nonce: { nonceId: string; bindingHash: string },
  consumedAt: string,
) {
  return {
    slot: slot(record.binding.profileId),
    authorityId: record.authorityId,
    authorityRevision: record.revision,
    generation: record.generation,
    bindingHash: nonce.bindingHash,
    nonceId: nonce.nonceId,
    consumedAt,
    outbox: {
      ...event(record, 'ignored', 'memory.semantic_egress.request_started', consumedAt),
      eventId: semanticEgressRequestEventId('started', nonce.nonceId),
    },
  }
}

function beginTransition(record: SemanticEgressAwaitingConsentRecordV1): SemanticEgressDurableTransitionV1 {
  return {
    slot: slot(record.binding.profileId),
    expectedRevision: null,
    nextRecord: record,
    nonce: {
      operation: 'issue',
      record: {
        nonceId: record.pending.nonceId,
        kind: 'grant',
        bindingHash: record.pending.actionHash,
        issuedAt: record.pending.issuedAt,
        expiresAt: record.pending.expiresAt,
      },
    },
    outbox: [event(record, `disclosure-${record.binding.profileId}`, 'memory.semantic_egress.disclosure_issued')],
  }
}

function confirmTransition(
  current: SemanticEgressAwaitingConsentRecordV1,
  next = consented(current),
): SemanticEgressDurableTransitionV1 {
  return {
    slot: slot(current.binding.profileId),
    expectedRevision: current.revision,
    nextRecord: next,
    nonce: {
      operation: 'consume',
      nonceId: current.pending.nonceId,
      kind: 'grant',
      bindingHash: current.pending.actionHash,
      consumedAt: next.authorityNonce.consumedAt,
    },
    outbox: [event(next, `consented-${next.binding.profileId}`, 'memory.semantic_egress.consent_granted')],
  }
}

function databasePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-semantic-consent-')))
  roots.push(root)
  return join(root, 'private', 'semantic-egress.sqlite')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Node semantic egress durable SQLite store', () => {
  it('atomically persists AWAITING_CONSENT, nonce, and outbox across restart', async () => {
    const path = databasePath()
    const first = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    const transition = {
      ...beginTransition(pending),
      outbox: [event(
        pending, 'event-disclosure-1', 'memory.semantic_egress.disclosure_issued',
      )],
    }
    await expect(first.durable.transition(transition)).resolves.toEqual({ status: 'committed' })
    first.close()

    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const restarted = makeNodeSemanticEgressConsentStore({ path })
    await expect(restarted.durable.load(slot())).resolves.toEqual(pending)
    await expect(restarted.durable.readOutbox(10)).resolves.toEqual(transition.outbox)
    restarted.close()

    const raw = new Database(path, { readonly: true })
    expect(raw.pragma('user_version', { simple: true })).toBe(1)
    expect(raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).pluck().all()).toEqual([
      'semantic_egress_consents', 'semantic_egress_nonces', 'semantic_egress_outbox',
    ])
    expect(raw.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).pluck().all()).toEqual(['sqlite_autoindex_semantic_egress_outbox_1'])
    raw.close()
  })

  it('commits confirmation CAS, nonce consumption, and outbox in one transaction', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    await store.durable.transition(beginTransition(pending))
    const next = consented(pending)
    const transition = {
      ...confirmTransition(pending, next),
      outbox: [event(next, 'event-consented-1', 'memory.semantic_egress.consent_granted')],
    }
    await expect(store.durable.transition(transition)).resolves.toEqual({ status: 'committed' })
    await expect(store.durable.load(slot())).resolves.toEqual(next)
    store.close()
  })

  it('holds a real singleton writer lease across same-process and child-process contention', async () => {
    const path = databasePath()
    const first = makeNodeSemanticEgressConsentStore({ path })
    expect(() => makeNodeSemanticEgressConsentStore({ path })).toThrowError(
      new SemanticEgressConsentSqliteStoreError('STORE_UNAVAILABLE'),
    )
    const leasePath = join(path, '..', 'semantic-egress-writer-lease.sqlite3')
    const child = spawnSync(process.execPath, ['-e', [
      "const Database = require('better-sqlite3')",
      'const db = new Database(process.argv[1], { timeout: 0 })',
      "try { db.exec('BEGIN IMMEDIATE'); process.stdout.write('acquired') } catch (error) { process.stdout.write(String(error.code)) } finally { db.close() }",
    ].join(';'), leasePath], { cwd: process.cwd(), encoding: 'utf8' })
    expect(child.status).toBe(0)
    expect(child.stdout).toMatch(/^SQLITE_(BUSY|LOCKED)$/)
    first.close()
    const successor = makeNodeSemanticEgressConsentStore({ path })
    successor.close()
  })

  it('enforces consumed/invalidated nonce exclusivity', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    await store.durable.transition(beginTransition(pending))
    await store.durable.recoverForBoot({ bootId: 'boot-new', at: LATER })
    const invalidated = await store.durable.load(slot()) as SemanticEgressAwaitingConsentRecordV1
    await expect(store.durable.transition(confirmTransition(invalidated))).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'),
    )

    const raw = new Database(path, { readonly: true })
    expect(raw.prepare(`
      SELECT consumed_at, invalidated_at FROM semantic_egress_nonces WHERE nonce_id = ?
    `).get(pending.pending.nonceId)).toEqual({ consumed_at: null, invalidated_at: LATER })
    raw.close()
    store.close()
  })

  it('provides ordered at-least-once outbox reads, deterministic IDs, and atomic ack', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    const firstEvent = event(pending, 'event-1', 'memory.semantic_egress.disclosure_issued')
    const transition = { ...beginTransition(pending), outbox: [firstEvent] }
    await expect(store.durable.transition(transition)).resolves.toEqual({ status: 'committed' })
    const next = consented(pending)
    const secondEvent = event(next, 'event-2', 'memory.semantic_egress.consent_granted')
    await expect(store.durable.transition({
      ...confirmTransition(pending, next), outbox: [secondEvent],
    })).resolves.toEqual({ status: 'committed' })
    await expect(store.durable.readOutbox(10)).resolves.toEqual([firstEvent, secondEvent])
    await expect(store.durable.ackOutboxHead(secondEvent.eventId)).resolves.toBe('not-head')
    await expect(store.durable.ackOutboxHead(firstEvent.eventId)).resolves.toBe('acked')
    await expect(store.durable.ackOutboxHead(firstEvent.eventId)).resolves.toBe('already-acked')
    await expect(store.durable.readOutbox(10)).resolves.toEqual([secondEvent])
    store.close()

    const restarted = makeNodeSemanticEgressConsentStore({ path })
    await expect(restarted.durable.ackOutboxHead(firstEvent.eventId))
      .resolves.toBe('already-acked')
    await expect(restarted.durable.ackOutboxHead('unknown-event')).resolves.toBe('unknown')
    await expect(restarted.durable.readOutbox(10)).resolves.toEqual([secondEvent])
    restarted.close()

    const conflictPath = databasePath()
    const conflictStore = makeNodeSemanticEgressConsentStore({ path: conflictPath })
    const conflictPending = awaiting('conflict')
    const sameId = event(conflictPending, 'event-conflict', 'memory.semantic_egress.disclosure_issued')
    await conflictStore.durable.transition({
      ...beginTransition(conflictPending), outbox: [sameId],
    })
    const conflictNext = consented(conflictPending)
    const conflicting = {
      ...event(conflictNext, 'ignored', 'memory.semantic_egress.consent_granted'),
      eventId: sameId.eventId,
    }
    await expect(conflictStore.durable.transition({
      ...confirmTransition(conflictPending, conflictNext), outbox: [conflicting],
    })).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'),
    )
    await expect(conflictStore.durable.load(slot('conflict'))).resolves.toEqual(conflictPending)
    await expect(conflictStore.durable.readOutbox(10)).resolves.toEqual([sameId])
    conflictStore.close()
  })

  it('restricts use nonces to ACTIVE and verifies request event IDs', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting('use-proof')
    await store.durable.transition(beginTransition(pending))
    const accepted = consented(pending)
    await store.durable.transition(confirmTransition(pending, accepted))
    const useNonce = {
      nonceId: 'use-proof-1',
      kind: 'use' as const,
      bindingHash: semanticEgressBindingHash(accepted.binding),
      issuedAt: '2026-07-29T12:00:02.000Z',
      expiresAt: EXPIRES,
    }
    const invalidDegraded = nextState(accepted, 'DEGRADED')
    await expect(store.durable.transition({
      slot: slot('use-proof'),
      expectedRevision: accepted.revision,
      nextRecord: invalidDegraded,
      nonce: { operation: 'none' },
      outbox: [event(invalidDegraded, 'degraded', 'memory.semantic_egress.degraded')],
    })).rejects.toEqual(new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'))
    await expect(store.durable.transition({
      slot: slot('use-proof'),
      expectedRevision: accepted.revision,
      nextRecord: null,
      nonce: { operation: 'issue', record: useNonce },
      outbox: [],
    })).rejects.toEqual(new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'))

    const active = nextState(accepted, 'ACTIVE')
    await store.durable.transition({
      slot: slot('use-proof'),
      expectedRevision: accepted.revision,
      nextRecord: active,
      nonce: { operation: 'none' },
      outbox: [event(active, 'active', 'memory.semantic_egress.activated')],
    })
    await expect(store.durable.transition({
      slot: slot('use-proof'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: { operation: 'issue', record: useNonce },
      outbox: [],
    })).resolves.toEqual({ status: 'committed' })

    const startedAt = '2026-07-29T12:00:03.000Z'
    const started = {
      ...event(active, 'request-started', 'memory.semantic_egress.request_started', startedAt),
      eventId: semanticEgressRequestEventId('started', useNonce.nonceId),
    }
    const genericStart = {
      slot: slot('use-proof'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: {
        operation: 'consume',
        nonceId: useNonce.nonceId,
        kind: 'use',
        bindingHash: useNonce.bindingHash,
        consumedAt: startedAt,
      },
      outbox: [started],
    } satisfies SemanticEgressDurableTransitionV1
    await expect(store.durable.transition(genericStart)).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'),
    )
    await expect(store.durable.consumeUseIfActive(
      useStart(active, useNonce, startedAt),
    )).resolves.toEqual({ status: 'committed' })

    const completed = {
      ...event(
        active,
        'request-completed',
        'memory.semantic_egress.request_completed',
        '2026-07-29T12:00:04.000Z',
      ),
      eventId: semanticEgressRequestEventId('completed', useNonce.nonceId),
    }
    await expect(store.durable.transition({
      slot: slot('use-proof'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: {
        operation: 'assert-consumed',
        nonceId: useNonce.nonceId,
        kind: 'use',
        bindingHash: useNonce.bindingHash,
      },
      outbox: [completed],
    })).resolves.toEqual({ status: 'committed' })
    await expect(store.durable.readOutbox(10)).resolves.toContainEqual(started)
    await expect(store.durable.readOutbox(10)).resolves.toContainEqual(completed)
    store.close()
  })

  it('atomically starts use only for the exact ACTIVE authority snapshot', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting('exact-use')
    await store.durable.transition(beginTransition(pending))
    const accepted = consented(pending)
    await store.durable.transition(confirmTransition(pending, accepted))
    const active = nextState(accepted, 'ACTIVE')
    await store.durable.transition({
      slot: slot('exact-use'),
      expectedRevision: accepted.revision,
      nextRecord: active,
      nonce: { operation: 'none' },
      outbox: [event(active, 'ignored', 'memory.semantic_egress.activated')],
    })
    const useNonce = {
      nonceId: 'exact-use-nonce',
      kind: 'use' as const,
      bindingHash: semanticEgressBindingHash(active.binding),
      issuedAt: '2026-07-29T12:00:02.500Z',
      expiresAt: EXPIRES,
    }
    await store.durable.transition({
      slot: slot('exact-use'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: { operation: 'issue', record: useNonce },
      outbox: [],
    })
    const valid = useStart(active, useNonce, '2026-07-29T12:00:03.000Z')

    for (const mismatch of [
      {
        ...valid,
        authorityId: 'authority-other',
        outbox: { ...valid.outbox, authorityId: 'authority-other' },
      },
      {
        ...valid,
        authorityRevision: valid.authorityRevision + 1,
        outbox: { ...valid.outbox, authorityRevision: valid.authorityRevision + 1 },
      },
      {
        ...valid,
        generation: valid.generation + 1,
        outbox: { ...valid.outbox, generation: valid.generation + 1 },
      },
      { ...valid, bindingHash: 'd'.repeat(64) },
    ]) {
      await expect(store.durable.consumeUseIfActive(mismatch)).resolves.toEqual({
        status: 'cas-conflict',
      })
    }
    await expect(store.durable.consumeUseIfActive({
      ...valid,
      outbox: { ...valid.outbox, connectionRevision: 'same-revision-tamper' },
    })).rejects.toEqual(new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'))
    await expect(store.durable.consumeUseIfActive({
      ...valid, nonceId: 'unknown-nonce',
      outbox: {
        ...valid.outbox,
        eventId: semanticEgressRequestEventId('started', 'unknown-nonce'),
      },
    })).resolves.toEqual({ status: 'nonce-conflict' })

    await expect(store.durable.consumeUseIfActive(valid)).resolves.toEqual({ status: 'committed' })
    await expect(store.durable.readOutbox(100)).resolves.toContainEqual(valid.outbox)
    store.close()
  })

  it('serializes concurrent use starts so a nonce can commit only once', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting('use-race')
    await store.durable.transition(beginTransition(pending))
    const accepted = consented(pending)
    await store.durable.transition(confirmTransition(pending, accepted))
    const active = nextState(accepted, 'ACTIVE')
    await store.durable.transition({
      slot: slot('use-race'),
      expectedRevision: accepted.revision,
      nextRecord: active,
      nonce: { operation: 'none' },
      outbox: [event(active, 'ignored', 'memory.semantic_egress.activated')],
    })
    const useNonce = {
      nonceId: 'use-race-nonce',
      kind: 'use' as const,
      bindingHash: semanticEgressBindingHash(active.binding),
      issuedAt: '2026-07-29T12:00:02.500Z',
      expiresAt: EXPIRES,
    }
    await store.durable.transition({
      slot: slot('use-race'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: { operation: 'issue', record: useNonce },
      outbox: [],
    })
    const input = useStart(active, useNonce, '2026-07-29T12:00:03.000Z')
    const results = await Promise.all([
      store.durable.consumeUseIfActive(input),
      store.durable.consumeUseIfActive(input),
    ])
    expect(results).toEqual(expect.arrayContaining([
      { status: 'committed' }, { status: 'nonce-conflict' },
    ]))
    expect((await store.durable.readOutbox(100)).filter(
      item => item.eventId === input.outbox.eventId,
    )).toHaveLength(1)
    store.close()
  })

  it('recomputes lifecycle, request, and recovery event IDs from private anchors after restart', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const lifecycle = awaiting('anchor-lifecycle', 'boot-new')
    const stale = awaiting('anchor-recovery', 'boot-old')
    await store.durable.transition(beginTransition(lifecycle))
    await store.durable.transition(beginTransition(stale))
    await store.durable.recoverForBoot({ bootId: 'boot-new', at: LATER })

    const requestPending = awaiting('anchor-request', 'boot-new')
    await store.durable.transition(beginTransition(requestPending))
    const accepted = consented(requestPending)
    await store.durable.transition(confirmTransition(requestPending, accepted))
    const active = nextState(accepted, 'ACTIVE')
    await store.durable.transition({
      slot: slot('anchor-request'),
      expectedRevision: accepted.revision,
      nextRecord: active,
      nonce: { operation: 'none' },
      outbox: [event(active, 'active', 'memory.semantic_egress.activated')],
    })
    const useNonce = {
      nonceId: 'anchor-use-1',
      kind: 'use' as const,
      bindingHash: semanticEgressBindingHash(active.binding),
      issuedAt: '2026-07-29T12:00:03.000Z',
      expiresAt: EXPIRES,
    }
    await store.durable.transition({
      slot: slot('anchor-request'),
      expectedRevision: active.revision,
      nextRecord: null,
      nonce: { operation: 'issue', record: useNonce },
      outbox: [],
    })
    const requestEvent = {
      ...event(
        active,
        'request',
        'memory.semantic_egress.request_started',
        '2026-07-29T12:00:04.000Z',
      ),
      eventId: semanticEgressRequestEventId('started', useNonce.nonceId),
    }
    await store.durable.consumeUseIfActive({
      ...useStart(active, useNonce, requestEvent.at),
      outbox: requestEvent,
    })
    store.close()

    for (const [eventClass, replacement] of [
      ['lifecycle', 'a'.repeat(64)],
      ['request', 'b'.repeat(64)],
      ['recovery', 'c'.repeat(64)],
    ] as const) {
      const raw = new Database(path)
      const original = raw.prepare(`
        SELECT event_id, payload FROM semantic_egress_outbox
        WHERE event_class = ? ORDER BY sequence LIMIT 1
      `).get(eventClass) as { event_id: string; payload: string }
      const payload = JSON.parse(original.payload) as Record<string, unknown>
      payload['eventId'] = replacement
      raw.prepare(`
        UPDATE semantic_egress_outbox SET event_id = ?, payload = ? WHERE event_id = ?
      `).run(replacement, JSON.stringify(payload), original.event_id)
      raw.close()

      const tampered = makeNodeSemanticEgressConsentStore({ path })
      await expect(tampered.durable.readOutbox(100)).rejects.toEqual(
        new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE'),
      )
      tampered.close()

      const restore = new Database(path)
      restore.prepare(`
        UPDATE semantic_egress_outbox SET event_id = ?, payload = ? WHERE event_id = ?
      `).run(original.event_id, original.payload, replacement)
      restore.close()
    }
  })

  it('recovers all slots atomically for a new boot and is idempotent', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const stale = awaiting('stale', 'boot-old')
    const currentBoot = awaiting('current', 'boot-new')
    await store.durable.transition(beginTransition(stale))
    await store.durable.transition(beginTransition(currentBoot))

    for (const [profileId, state] of [['active', 'ACTIVE'], ['degraded', 'DEGRADED']] as const) {
      const pending = awaiting(profileId)
      await store.durable.transition(beginTransition(pending))
      const accepted = consented(pending)
      await store.durable.transition(confirmTransition(pending, accepted))
      const activeRecord = nextState(accepted, 'ACTIVE')
      await store.durable.transition({
        slot: slot(profileId),
        expectedRevision: accepted.revision,
        nextRecord: activeRecord,
        nonce: { operation: 'none' },
        outbox: [event(
          activeRecord,
          `state-${profileId}`,
          'memory.semantic_egress.activated',
        )],
      })
      if (state === 'DEGRADED') {
        const degradedRecord = nextState(activeRecord, 'DEGRADED', '2026-07-29T12:00:02.500Z')
        await store.durable.transition({
          slot: slot(profileId),
          expectedRevision: activeRecord.revision,
          nextRecord: degradedRecord,
          nonce: { operation: 'none' },
          outbox: [event(
            degradedRecord,
            `state-${profileId}`,
            'memory.semantic_egress.degraded',
          )],
        })
      }
    }

    const revokePending = awaiting('revoking')
    await store.durable.transition(beginTransition(revokePending))
    const revokeConsented = consented(revokePending)
    await store.durable.transition(confirmTransition(revokePending, revokeConsented))
    const revoking: SemanticEgressRevokingConsentRecordV1 = {
      ...revokeConsented,
      state: 'REVOKING',
      revision: revokeConsented.revision + 1,
      generation: revokeConsented.generation + 1,
      updatedAt: '2026-07-29T12:00:02.000Z',
      revokeStartedAt: '2026-07-29T12:00:02.000Z',
    }
    await store.durable.transition({
      slot: slot('revoking'),
      expectedRevision: revokeConsented.revision,
      nextRecord: revoking,
      nonce: { operation: 'none' },
      outbox: [event(
        revoking,
        'revoking-event',
        'memory.semantic_egress.revoke_started',
      )],
    })

    for (const queued of await store.durable.readOutbox(100)) {
      await store.durable.ackOutboxHead(queued.eventId)
    }

    const recoveryAt = '2026-07-29T12:00:03.000Z'
    await expect(store.durable.recoverForBoot({
      bootId: 'boot-new', at: recoveryAt,
    })).resolves.toEqual({
      invalidatedCards: [{ cardId: stale.pending.cardId, actionId: stale.pending.actionId }],
      revoking: [slot('revoking')],
    })
    await expect(store.durable.load(slot('stale'))).resolves.toMatchObject({
      state: 'AWAITING_CONSENT', revision: 2, generation: 2,
      pending: { invalidatedAt: recoveryAt },
    })
    await expect(store.durable.load(slot('current'))).resolves.toEqual(currentBoot)
    await expect(store.durable.load(slot('active'))).resolves.toMatchObject({
      state: 'SUSPENDED', revision: 4, generation: 4,
    })
    await expect(store.durable.load(slot('degraded'))).resolves.toMatchObject({
      state: 'SUSPENDED', revision: 5, generation: 5,
    })
    const recoveryEvents = await store.durable.readOutbox(10)
    expect(recoveryEvents.map((value) => [value.kind, value.code])).toEqual([
      ['memory.semantic_egress.suspended', 'BOOT_REACTIVATION_REQUIRED'],
      ['memory.semantic_egress.suspended', 'BOOT_REACTIVATION_REQUIRED'],
      ['memory.semantic_egress.stale', 'STALE_BOOT'],
    ])
    const beforeRetry = recoveryEvents.map((value) => value.eventId)
    await store.durable.recoverForBoot({ bootId: 'boot-new', at: recoveryAt })
    expect((await store.durable.readOutbox(10)).map((value) => value.eventId)).toEqual(beforeRetry)
    store.close()
  })

  it('fails closed on malformed records, accessors, and corrupt nonce/outbox rows', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    let getterCalls = 0
    const getterRecord = { ...pending }
    Object.defineProperty(getterRecord, 'state', {
      enumerable: true,
      get() { getterCalls += 1; return 'AWAITING_CONSENT' },
    })
    await expect(store.durable.transition({
      ...beginTransition(pending),
      nextRecord: getterRecord as SemanticEgressAwaitingConsentRecordV1,
    })).rejects.toEqual(new SemanticEgressConsentSqliteStoreError('INVALID_INPUT'))
    expect(getterCalls).toBe(0)
    await store.durable.transition(beginTransition(pending))
    store.close()

    const rawNonce = new Database(path)
    rawNonce.prepare(`
      UPDATE semantic_egress_nonces SET expires_at = 'not-an-instant' WHERE nonce_id = ?
    `).run(pending.pending.nonceId)
    rawNonce.close()
    const corruptNonce = makeNodeSemanticEgressConsentStore({ path })
    await expect(corruptNonce.durable.load(slot())).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE'),
    )
    corruptNonce.close()

    const outboxPath = databasePath()
    const outboxStore = makeNodeSemanticEgressConsentStore({ path: outboxPath })
    const outboxPending = awaiting('outbox')
    const outboxTransition = {
      ...beginTransition(outboxPending),
      outbox: [event(
        outboxPending, 'event-corrupt', 'memory.semantic_egress.disclosure_issued',
      )],
    }
    await outboxStore.durable.transition(outboxTransition)
    outboxStore.close()
    const rawOutbox = new Database(outboxPath)
    rawOutbox.prepare(`UPDATE semantic_egress_outbox SET payload = '{'`).run()
    rawOutbox.close()
    const corruptOutbox = makeNodeSemanticEgressConsentStore({ path: outboxPath })
    await expect(corruptOutbox.durable.readOutbox(10)).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE'),
    )
    corruptOutbox.close()
  })

  it('fails closed on future or non-exact schema', () => {
    const futurePath = databasePath()
    mkdirSync(join(futurePath, '..'), { recursive: true, mode: 0o700 })
    const future = new Database(futurePath)
    future.pragma('user_version = 2')
    future.close()
    chmodSync(futurePath, 0o600)
    expect(() => makeNodeSemanticEgressConsentStore({ path: futurePath })).toThrowError(
      new SemanticEgressConsentSqliteStoreError('FUTURE_SCHEMA'),
    )

    const indexedPath = databasePath()
    const exact = makeNodeSemanticEgressConsentStore({ path: indexedPath })
    exact.close()
    const indexed = new Database(indexedPath)
    indexed.exec('CREATE INDEX unexpected_nonce_index ON semantic_egress_nonces(kind)')
    indexed.close()
    expect(() => makeNodeSemanticEgressConsentStore({ path: indexedPath })).toThrowError(
      new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE'),
    )

    const maliciousObjects = [
      `CREATE TRIGGER malicious_outbox AFTER INSERT ON semantic_egress_nonces
        BEGIN DELETE FROM semantic_egress_outbox; END`,
      `CREATE TRIGGER malicious_nonce AFTER INSERT ON semantic_egress_outbox
        BEGIN DELETE FROM semantic_egress_nonces; END`,
      `CREATE VIEW malicious_view AS SELECT * FROM semantic_egress_consents`,
    ]
    for (const sql of maliciousObjects) {
      const maliciousPath = databasePath()
      const initialized = makeNodeSemanticEgressConsentStore({ path: maliciousPath })
      initialized.close()
      const malicious = new Database(maliciousPath)
      malicious.exec(sql)
      malicious.close()
      expect(() => makeNodeSemanticEgressConsentStore({ path: maliciousPath })).toThrowError(
        new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE'),
      )
    }
  })

  it('rejects unsafe database paths, relative paths, and unsafe SQLite sidecars', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-semantic-consent-unsafe-')))
    roots.push(root)
    const outside = join(root, 'outside.sqlite')
    writeFileSync(outside, '', { mode: 0o600 })
    const linked = join(root, 'linked.sqlite')
    symlinkSync(outside, linked)
    expect(() => makeNodeSemanticEgressConsentStore({ path: linked })).toThrowError(
      new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'),
    )
    const hardlinked = join(root, 'hardlinked.sqlite')
    linkSync(outside, hardlinked)
    expect(() => makeNodeSemanticEgressConsentStore({ path: hardlinked })).toThrowError(
      new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'),
    )

    const absoluteTarget = databasePath()
    expect(() => makeNodeSemanticEgressConsentStore({
      path: relative(process.cwd(), absoluteTarget),
    })).toThrowError(new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'))
    expect(existsSync(absoluteTarget)).toBe(false)

    for (const suffix of ['-journal', '-wal', '-shm']) {
      const path = databasePath()
      const initialized = makeNodeSemanticEgressConsentStore({ path })
      initialized.close()
      writeFileSync(path + suffix, '', { mode: 0o600 })
      expect(() => makeNodeSemanticEgressConsentStore({ path })).toThrowError(
        new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'),
      )
    }
  })

  it('recovers a private hot rollback journal without leaking partial transition state', async () => {
    const path = databasePath()
    const initialized = makeNodeSemanticEgressConsentStore({ path })
    const pending = awaiting()
    await initialized.durable.transition(beginTransition(pending))
    initialized.close()

    const child = spawnSync(process.execPath, [
      '-e',
      [
        "const Database = require('better-sqlite3')",
        'const db = new Database(process.argv[1])',
        "db.pragma('journal_mode = DELETE')",
        "db.pragma('synchronous = FULL')",
        "db.pragma('cache_size = 1')",
        "db.pragma('cache_spill = ON')",
        "db.exec('BEGIN IMMEDIATE')",
        "db.prepare('UPDATE semantic_egress_nonces SET binding_hash = ?').run('f'.repeat(64))",
        "db.prepare('UPDATE semantic_egress_consents SET revision = 99') .run()",
        "process.kill(process.pid, 'SIGKILL')",
      ].join(';'),
      path,
    ], { cwd: process.cwd() })
    expect(child.signal).toBe('SIGKILL')
    expect(statSync(path + '-journal').mode & 0o777).toBe(0o600)

    const recovered = makeNodeSemanticEgressConsentStore({ path })
    expect(existsSync(path + '-journal')).toBe(false)
    await expect(recovered.durable.load(slot())).resolves.toEqual(pending)
    recovered.close()
  })

  it('fails closed after path replacement and exposes no non-atomic adapter', async () => {
    const path = databasePath()
    const store = makeNodeSemanticEgressConsentStore({ path })
    expect(Object.keys(store).sort()).toEqual(['close', 'durable'])
    expect(readFileSync(path).includes('content')).toBe(false)
    expect(readFileSync(path).includes('secret')).toBe(false)
    renameSync(path, path + '.original')
    writeFileSync(path, '', { mode: 0o600 })
    await expect(store.durable.load(slot())).rejects.toEqual(
      new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'),
    )
    expect(() => store.close()).toThrowError(
      new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH'),
    )
    expect(() => store.close()).not.toThrow()
  })
})

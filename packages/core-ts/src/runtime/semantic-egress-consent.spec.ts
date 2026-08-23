import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { semanticDescriptorId } from './protected-memory-semantic-reconciler.js'
import {
  makeSemanticEgressConsentAuthority,
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  semanticEgressRecoveryEventId,
  semanticEgressRequestEventId,
  semanticEgressBindingHash,
  type SemanticEgressActiveConsentRecordV1,
  type SemanticEgressConsentBinding,
  type SemanticEgressConsentChallengeV1,
  type SemanticEgressConsentNonceRecord,
  type SemanticEgressConsentRecordV1,
  type SemanticEgressConsentSlot,
  type SemanticEgressDurableStore,
  type SemanticEgressDurableTransitionV1,
  type SemanticEgressDurableUseStartV1,
  type SemanticEgressOutboxEventV1,
} from './semantic-egress-consent.js'

const NOW = Date.parse('2026-07-30T08:00:00.000Z')
const DESCRIPTOR = Object.freeze({
  provider: 'openrouter',
  modelId: 'openai/text-embedding-3-small',
  modelRevision: '2026-07-01',
  dimensions: 1536,
  normalizationVersion: 'nfkc-lf-v1',
  chunkerVersion: 'memory-fact-v1',
})

function binding(overrides: Partial<SemanticEgressConsentBinding> = {}): SemanticEgressConsentBinding {
  return {
    operatorId: 'operator-1',
    profileId: 'profile-1',
    purpose: 'memory.semantic-embedding.v1',
    provider: 'openrouter',
    connectionId: 'connection-1',
    connectionRevision: 'ready-record-7',
    descriptor: DESCRIPTOR,
    semanticDescriptorId: semanticDescriptorId(DESCRIPTOR),
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
    ...overrides,
  }
}

function slot(value = binding()): SemanticEgressConsentSlot {
  return {
    operatorId: value.operatorId,
    profileId: value.profileId,
    purpose: value.purpose,
  }
}

function slotKey(value: SemanticEgressConsentSlot): string {
  return JSON.stringify([value.operatorId, value.profileId, value.purpose])
}

type StoredNonce = SemanticEgressConsentNonceRecord & {
  status: 'issued' | 'consumed' | 'invalidated'
}

function makeHarness(options: {
  bootId?: string
  skipRecovery?: boolean
  health?: 'healthy' | 'unavailable' | 'revoked'
  purge?: boolean
  storeThrows?: boolean
  transitionStatus?: 'cas-conflict' | 'nonce-conflict'
  useStartStatus?: 'cas-conflict' | 'nonce-conflict'
  malformedRecovery?: boolean
} = {}) {
  let now = NOW
  let serial = 0
  let storeThrows = options.storeThrows ?? false
  let healthState = options.health ?? 'healthy'
  let useStartStatus = options.useStartStatus
  const records = new Map<string, SemanticEgressConsentRecordV1>()
  const nonces = new Map<string, StoredNonce>()
  const outbox = new Map<string, SemanticEgressOutboxEventV1>()
  const acked = new Set<string>()
  const transitions: SemanticEgressDurableTransitionV1[] = []
  const useStarts: SemanticEgressDurableUseStartV1[] = []

  const nonceKey = (kind: SemanticEgressConsentNonceRecord['kind'], nonceId: string) =>
    `${kind}:${nonceId}`

  const durable: SemanticEgressDurableStore = {
    async load(input) {
      if (storeThrows) throw new Error('private disk detail')
      const record = records.get(slotKey(input))
      return record === undefined ? null : structuredClone(record)
    },

    async transition(input) {
      if (storeThrows) throw new Error('private disk detail')
      if (options.transitionStatus !== undefined) return { status: options.transitionStatus }
      transitions.push(structuredClone(input))
      const key = slotKey(input.slot)
      const current = records.get(key)
      if ((current?.revision ?? null) !== input.expectedRevision) return { status: 'cas-conflict' }

      const nextNonces = new Map(nonces)
      const mutation = input.nonce
      if (mutation.operation === 'issue') {
        const key = nonceKey(mutation.record.kind, mutation.record.nonceId)
        if (nextNonces.has(key)) return { status: 'nonce-conflict' }
        nextNonces.set(key, { ...structuredClone(mutation.record), status: 'issued' })
      } else if (mutation.operation === 'consume') {
        const key = nonceKey(mutation.kind, mutation.nonceId)
        const nonce = nextNonces.get(key)
        if (nonce === undefined || nonce.status !== 'issued' ||
          nonce.bindingHash !== mutation.bindingHash ||
          Date.parse(mutation.consumedAt) >= Date.parse(nonce.expiresAt)) {
          return { status: 'nonce-conflict' }
        }
        nextNonces.set(key, { ...nonce, status: 'consumed' })
      } else if (mutation.operation === 'assert-consumed') {
        const nonce = nextNonces.get(nonceKey(mutation.kind, mutation.nonceId))
        if (nonce === undefined || nonce.status !== 'consumed' ||
          nonce.bindingHash !== mutation.bindingHash) return { status: 'nonce-conflict' }
      } else if (mutation.operation === 'invalidate') {
        const key = nonceKey(mutation.kind, mutation.nonceId)
        const nonce = nextNonces.get(key)
        if (nonce === undefined || nonce.status !== 'issued' ||
          nonce.bindingHash !== mutation.bindingHash) return { status: 'nonce-conflict' }
        nextNonces.set(key, { ...nonce, status: 'invalidated' })
      }

      const nextOutbox = new Map(outbox)
      for (const event of input.outbox) {
        const existing = nextOutbox.get(event.eventId)
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(event)) {
          return { status: 'nonce-conflict' }
        }
        nextOutbox.set(event.eventId, structuredClone(event))
      }
      if (input.nextRecord !== null) records.set(key, structuredClone(input.nextRecord))
      nonces.clear()
      for (const [nonceId, nonce] of nextNonces) nonces.set(nonceId, nonce)
      outbox.clear()
      for (const [eventId, event] of nextOutbox) outbox.set(eventId, event)
      return { status: 'committed' }
    },

    async consumeUseIfActive(input) {
      if (storeThrows) throw new Error('private disk detail')
      if (useStartStatus !== undefined) return { status: useStartStatus }
      useStarts.push(structuredClone(input))
      const current = records.get(slotKey(input.slot))
      if (current === undefined || current.state !== 'ACTIVE' ||
        current.authorityId !== input.authorityId ||
        current.revision !== input.authorityRevision ||
        current.generation !== input.generation ||
        semanticEgressBindingHash(current.binding) !== input.bindingHash) {
        return { status: 'cas-conflict' }
      }
      const key = nonceKey('use', input.nonceId)
      const nonce = nonces.get(key)
      if (nonce === undefined || nonce.status !== 'issued' ||
        nonce.bindingHash !== input.bindingHash ||
        Date.parse(input.consumedAt) < Date.parse(nonce.issuedAt) ||
        Date.parse(input.consumedAt) >= Date.parse(nonce.expiresAt)) {
        return { status: 'nonce-conflict' }
      }
      if (input.outbox.kind !== 'memory.semantic_egress.request_started' ||
        input.outbox.eventId !== semanticEgressRequestEventId('started', input.nonceId)) {
        throw new Error('invalid use event')
      }
      nonces.set(key, { ...nonce, status: 'consumed' })
      outbox.set(input.outbox.eventId, structuredClone(input.outbox))
      return { status: 'committed' }
    },

    async recoverForBoot(input) {
      if (storeThrows) throw new Error('private disk detail')
      if (options.malformedRecovery) {
        return { invalidatedCards: [], revoking: [], extra: true } as never
      }
      const invalidatedCards: Array<{ cardId: string; actionId: string }> = []
      const revoking: SemanticEgressConsentSlot[] = []
      for (const [key, current] of [...records]) {
        if (current.state === 'AWAITING_CONSENT' && current.pending.bootId !== input.bootId &&
          current.pending.invalidatedAt === null) {
          const next: SemanticEgressConsentRecordV1 = {
            ...current,
            revision: current.revision + 1,
            generation: current.generation + 1,
            pending: { ...current.pending, invalidatedAt: input.at },
            updatedAt: input.at,
          }
          const nonce = nonces.get(nonceKey('grant', current.pending.nonceId))
          if (nonce === undefined || nonce.status !== 'issued' ||
            nonce.bindingHash !== current.pending.actionHash) throw new Error('atomic recovery failed')
          nonces.set(nonceKey('grant', current.pending.nonceId), { ...nonce, status: 'invalidated' })
          records.set(key, next)
          invalidatedCards.push({ cardId: current.pending.cardId, actionId: current.pending.actionId })
          const event: SemanticEgressOutboxEventV1 = {
            schemaVersion: 1,
            eventId: semanticEgressRecoveryEventId({
              bootId: input.bootId,
              kind: 'memory.semantic_egress.stale',
              slot: slot(current.binding),
              priorRevision: current.revision,
              nextRevision: next.revision,
            }),
            kind: 'memory.semantic_egress.stale',
            operatorId: current.binding.operatorId,
            profileId: current.binding.profileId,
            purpose: current.binding.purpose,
            authorityId: current.authorityId,
            authorityRevision: next.revision,
            generation: next.generation,
            connectionId: current.binding.connectionId,
            connectionRevision: current.binding.connectionRevision,
            semanticDescriptorId: current.binding.semanticDescriptorId,
            disclosureRevision: current.binding.disclosure.revision,
            disclosureHash: current.binding.disclosure.hash,
            code: 'STALE_BOOT',
            at: input.at,
          }
          outbox.set(event.eventId, event)
        } else if (current.state === 'ACTIVE' || current.state === 'DEGRADED') {
          const next: SemanticEgressActiveConsentRecordV1 = {
            ...current,
            revision: current.revision + 1,
            generation: current.generation + 1,
            state: 'SUSPENDED',
            updatedAt: input.at,
          }
          records.set(key, next)
          const event: SemanticEgressOutboxEventV1 = {
            schemaVersion: 1,
            eventId: semanticEgressRecoveryEventId({
              bootId: input.bootId,
              kind: 'memory.semantic_egress.suspended',
              slot: slot(current.binding),
              priorRevision: current.revision,
              nextRevision: next.revision,
            }),
            kind: 'memory.semantic_egress.suspended',
            operatorId: current.binding.operatorId,
            profileId: current.binding.profileId,
            purpose: current.binding.purpose,
            authorityId: current.authorityId,
            authorityRevision: next.revision,
            generation: next.generation,
            connectionId: current.binding.connectionId,
            connectionRevision: current.binding.connectionRevision,
            semanticDescriptorId: current.binding.semanticDescriptorId,
            disclosureRevision: current.binding.disclosure.revision,
            disclosureHash: current.binding.disclosure.hash,
            code: 'BOOT_REACTIVATION_REQUIRED',
            at: input.at,
          }
          outbox.set(event.eventId, event)
        } else if (current.state === 'REVOKING') {
          revoking.push(slot(current.binding))
        }
      }
      return { invalidatedCards, revoking }
    },

    async readOutbox(limit) {
      return [...outbox.values()]
        .filter(event => !acked.has(event.eventId))
        .slice(0, limit)
        .map(event => structuredClone(event))
    },

    async ackOutboxHead(eventId) {
      if (acked.has(eventId)) return 'already-acked'
      if (!outbox.has(eventId)) return 'unknown'
      const head = [...outbox.values()].find(event => !acked.has(event.eventId))
      if (head?.eventId !== eventId) return 'not-head'
      acked.add(eventId)
      return 'acked'
    },
  }

  const health = vi.fn(async () => healthState)
  const purgeAndVerify = vi.fn(async () => options.purge ?? true)
  const makeAuthority = (bootId = options.bootId ?? 'boot-1') => makeSemanticEgressConsentAuthority({
    secret: new Uint8Array(32).fill(7),
    bootId,
    durable,
    nowMs: () => now,
    newId: () => `id-${++serial}`,
    health,
    purgeAndVerify,
  })

  const authority = makeAuthority()
  const recoveredAuthorities = new WeakSet<object>()
  return {
    authority,
    durable,
    records,
    nonces,
    outbox,
    transitions,
    useStarts,
    health,
    purgeAndVerify,
    restartAuthority: makeAuthority,
    async ready(target = authority) {
      if (!recoveredAuthorities.has(target)) {
        await target.recoverForBoot()
        recoveredAuthorities.add(target)
      }
      return target
    },
    setHealth(value: 'healthy' | 'unavailable' | 'revoked') { healthState = value },
    setUseStartStatus(value: 'cas-conflict' | 'nonce-conflict' | undefined) {
      useStartStatus = value
    },
    setStoreThrows(value: boolean) { storeThrows = value },
    setNow(value: number) { now = value },
    setStored(value: SemanticEgressConsentRecordV1) {
      records.set(slotKey(slot(value.binding)), structuredClone(value))
    },
  }
}

function proof(challenge: SemanticEgressConsentChallengeV1, overrides: Record<string, unknown> = {}) {
  return {
    cardId: challenge.cardId,
    actionId: challenge.actionId,
    actionHash: challenge.actionHash,
    confirmedAt: challenge.issuedAt,
    stepUpVerified: true,
    ...overrides,
  }
}

async function consent(harness: ReturnType<typeof makeHarness>) {
  await harness.ready()
  const challenge = await harness.authority.beginConsent(binding(), null)
  const record = await harness.authority.confirmConsent(
    slot(), challenge.authorityRevision, proof(challenge),
  )
  return { challenge, record }
}

async function consentAndActivate(harness: ReturnType<typeof makeHarness>) {
  const { record } = await consent(harness)
  const active = await harness.authority.activate({
    binding: binding(),
    expectedRevision: record.revision,
  })
  if (active.state !== 'ACTIVE') throw new Error('expected ACTIVE')
  return active
}

describe('semantic egress durable consent authority', () => {
  it('keeps every operational method closed after failed boot recovery', async () => {
    const harness = makeHarness({ storeThrows: true })
    await expect(harness.authority.recoverForBoot())
      .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    const dummyApproval = {
      cardId: 'card-1', actionId: 'action-1', actionHash: 'a'.repeat(64),
      confirmedAt: new Date(NOW).toISOString(), stepUpVerified: true,
    }
    const dummyUseProof = {
      schemaVersion: 1 as const,
      proofId: 'proof-1',
      nonceId: 'nonce-1',
      authorityId: 'authority-1',
      authorityRevision: 1,
      generation: 1,
      bindingHash: 'a'.repeat(64),
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 1000).toISOString(),
      mac: 'b'.repeat(64),
    }
    const operations: Array<() => Promise<unknown>> = [
      () => harness.authority.beginConsent(binding(), null),
      () => harness.authority.confirmConsent(slot(), 1, dummyApproval),
      () => harness.authority.activate({ binding: binding(), expectedRevision: 1 }),
      () => harness.authority.issueUseProof({ binding: binding(), expectedRevision: 1, ttlMs: 1 }),
      () => harness.authority.consumeUseProof(dummyUseProof, binding()),
      () => harness.authority.completeUse(dummyUseProof, binding()),
      () => harness.authority.setDegraded(slot(), 1),
      () => harness.authority.suspend(slot(), 1),
      () => harness.authority.beginRevoke(slot(), 1),
      () => harness.authority.completeRevoke(slot(), 1),
      () => harness.authority.block(slot(), 1, 'TEST_BLOCK'),
    ]
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
    }
  })

  it('binds confirmation to the factory boot and invalidates old-boot proof on recovery', async () => {
    const harness = makeHarness({ bootId: 'boot-old' })
    await harness.ready()
    const challenge = await harness.authority.beginConsent(binding(), null)
    const restarted = harness.restartAuthority('boot-new')

    await expect(restarted.confirmConsent(slot(), challenge.authorityRevision, proof(challenge)))
      .rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
    await restarted.recoverForBoot()
    await expect(restarted.confirmConsent(slot(), challenge.authorityRevision + 1, proof(challenge)))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(harness.nonces.get(`grant:${challenge.nonceId}`)?.status).toBe('invalidated')
  })

  it('opens the gate only after validated recovery for the factory-owned boot', async () => {
    const harness = makeHarness({ bootId: 'boot-current' })
    await expect(harness.authority.beginConsent(binding(), null))
      .rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
    await harness.authority.recoverForBoot()
    const challenge = await harness.authority.beginConsent(binding(), null)
    expect(challenge.bootId).toBe('boot-current')
  })

  it('durably stores AWAITING, nonce and disclosure event before returning the challenge', async () => {
    const harness = makeHarness()
    await harness.ready()
    const challenge = await harness.authority.beginConsent(binding(), null)
    const stored = harness.records.get(slotKey(slot()))

    expect(stored).toMatchObject({
      state: 'AWAITING_CONSENT',
      authorityId: challenge.authorityId,
      revision: challenge.authorityRevision,
      pending: {
        bootId: 'boot-1',
        actionId: challenge.actionId,
        actionHash: challenge.actionHash,
        cardId: challenge.cardId,
        nonceId: challenge.nonceId,
        invalidatedAt: null,
      },
    })
    expect(harness.nonces.get(`grant:${challenge.nonceId}`)?.status).toBe('issued')
    expect([...harness.outbox.values()]).toEqual([
      expect.objectContaining({
        kind: 'memory.semantic_egress.disclosure_issued',
        purpose: 'memory.semantic-embedding.v1',
        disclosureHash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
      }),
    ])
    expect(harness.transitions[0]).toMatchObject({
      expectedRevision: null,
      nonce: { operation: 'issue' },
    })
  })

  it('does not return a card when the atomic durable transition fails', async () => {
    const harness = makeHarness()
    await harness.ready()
    harness.setStoreThrows(true)
    await expect(harness.authority.beginConsent(binding(), null))
      .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', message: 'STORE_UNAVAILABLE' })
  })

  it('uses a full code-owned disclosure without content or credentials in the summary', async () => {
    const harness = makeHarness()
    await harness.ready()
    const challenge = await harness.authority.beginConsent(binding(), null)
    expect(challenge.summary).toContain('Подключение: connection-1 @ ready-record-7')
    expect(challenge.summary).toContain(`Disclosure: revision 1, hash ${SEMANTIC_EGRESS_DISCLOSURE_HASH}`)
    expect(challenge.summary).toContain('monitoring, transcripts, dna-config, attachments, knowledge-zones, archive')
    expect(challenge.summary).toContain('archive=false')
    expect(challenge.summary).toContain('не гарантируется третьей стороной')
    expect(challenge.summary).not.toContain('apiKey')
    expect(challenge.summary).not.toContain('memory/facts/')
  })

  it.each([
    ['disclosure revision', () => binding({ disclosure: { ...binding().disclosure, revision: 2 as 1 } })],
    ['disclosure hash', () => binding({ disclosure: { ...binding().disclosure, hash: 'a'.repeat(64) } })],
    ['archive widening', () => binding({ scope: { ...binding().scope, includeArchived: true as false } })],
    ['excluded category widening', () => binding({
      scope: { ...binding().scope, excludedCategories: ['monitoring'] as never },
    })],
  ])('rejects caller-controlled %s', async (_name, makeBinding) => {
    const harness = makeHarness()
    await harness.ready()
    await expect(harness.authority.beginConsent(makeBinding(), null))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(harness.transitions).toHaveLength(0)
  })

  it('atomically consumes the exact challenge nonce and grants consent', async () => {
    const harness = makeHarness()
    await harness.ready()
    const challenge = await harness.authority.beginConsent(binding(), null)
    const record = await harness.authority.confirmConsent(
      slot(), challenge.authorityRevision, proof(challenge),
    )

    expect(record).toMatchObject({
      state: 'CONSENTED',
      revision: challenge.authorityRevision + 1,
      generation: challenge.generation + 1,
      approval: {
        actionId: challenge.actionId,
        actionHash: challenge.actionHash,
        cardId: challenge.cardId,
      },
      authorityNonce: { nonceId: challenge.nonceId },
    })
    expect(harness.nonces.get(`grant:${challenge.nonceId}`)?.status).toBe('consumed')
    expect([...harness.outbox.values()].map(event => event.kind)).toEqual([
      'memory.semantic_egress.disclosure_issued',
      'memory.semantic_egress.consent_granted',
    ])
    expect(harness.transitions[1]).toMatchObject({ nonce: { operation: 'consume' } })
  })

  it.each([
    ['authorityId', (record: SemanticEgressConsentRecordV1) => { record.authorityId = 'tampered-authority' }],
    ['authorityRevision', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.authorityRevision += 1
    }],
    ['generation', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.generation += 1
    }],
    ['binding', (record: SemanticEgressConsentRecordV1) => {
      record.binding = { ...record.binding, connectionId: 'tampered-connection' }
    }],
    ['bootId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.bootId = 'tampered-boot'
    }],
    ['actionId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.actionId = 'tampered-action'
    }],
    ['cardId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.cardId = 'tampered-card'
    }],
    ['nonceId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.nonceId = 'tampered-nonce'
    }],
    ['issuedAt', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') return
      const tampered = new Date(Date.parse(record.pending.issuedAt) + 1).toISOString()
      record.pending.issuedAt = tampered
      record.createdAt = tampered
      record.updatedAt = tampered
    }],
    ['expiresAt', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') {
        record.pending.expiresAt = new Date(Date.parse(record.pending.expiresAt) + 1).toISOString()
      }
    }],
    ['actionHash', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') record.pending.actionHash = 'a'.repeat(64)
    }],
  ])('rejects persisted AWAITING tamper of action-hash input %s', async (_name, mutate) => {
    const harness = makeHarness()
    await harness.ready()
    await harness.authority.beginConsent(binding(), null)
    const stored = structuredClone(harness.records.get(slotKey(slot())))
    if (stored === undefined) throw new Error('missing record')
    mutate(stored)
    harness.records.set(slotKey(slot()), stored)
    await expect(harness.authority.load(slot()))
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_STATE' })
  })

  it.each([
    ['authorityId', (record: SemanticEgressConsentRecordV1) => { record.authorityId = 'tampered-authority' }],
    ['authorityRevision', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.authorityRevision += 1
    }],
    ['generation', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.generation += 1
    }],
    ['binding', (record: SemanticEgressConsentRecordV1) => {
      record.binding = { ...record.binding, connectionRevision: 'tampered-revision' }
    }],
    ['bootId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.bootId = 'tampered-boot'
    }],
    ['actionId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.actionId = 'tampered-action'
    }],
    ['cardId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.cardId = 'tampered-card'
    }],
    ['nonceId', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.authorityNonce.nonceId = 'tampered-nonce'
    }],
    ['issuedAt', (record: SemanticEgressConsentRecordV1) => {
      if (record.state === 'AWAITING_CONSENT') return
      const tampered = new Date(Date.parse(record.authorityNonce.issuedAt) - 1).toISOString()
      record.authorityNonce.issuedAt = tampered
      record.createdAt = tampered
    }],
    ['expiresAt', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') {
        record.approval.expiresAt = new Date(Date.parse(record.approval.expiresAt) + 1).toISOString()
      }
    }],
    ['actionHash', (record: SemanticEgressConsentRecordV1) => {
      if (record.state !== 'AWAITING_CONSENT') record.approval.actionHash = 'a'.repeat(64)
    }],
  ])('rejects persisted approved tamper of action-hash input %s', async (_name, mutate) => {
    const harness = makeHarness()
    await consentAndActivate(harness)
    const stored = structuredClone(harness.records.get(slotKey(slot())))
    if (stored === undefined) throw new Error('missing record')
    mutate(stored)
    harness.records.set(slotKey(slot()), stored)
    await expect(harness.authority.load(slot()))
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_STATE' })
  })

  it.each([
    ['actionId', { actionId: 'wrong-action' }],
    ['actionHash', { actionHash: 'a'.repeat(64) }],
    ['cardId', { cardId: 'wrong-card' }],
    ['step-up', { stepUpVerified: false }],
  ])('rejects a proof with wrong %s without consuming the nonce', async (field, change) => {
    const harness = makeHarness()
    await harness.ready()
    const challenge = await harness.authority.beginConsent(binding(), null)
    await expect(harness.authority.confirmConsent(
      slot(), challenge.authorityRevision, proof(challenge, change),
    )).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' })
    expect(harness.nonces.get(`grant:${challenge.nonceId}`)?.status).toBe('issued')
  })

  it('rejects expired, future and pre-issue confirmation timestamps', async () => {
    const expired = makeHarness()
    await expired.ready()
    const expiredChallenge = await expired.authority.beginConsent(binding(), null)
    expired.setNow(Date.parse(expiredChallenge.expiresAt))
    await expect(expired.authority.confirmConsent(
      slot(), expiredChallenge.authorityRevision, proof(expiredChallenge),
    )).rejects.toMatchObject({ code: 'APPROVAL_STALE' })

    for (const confirmedAt of [NOW + 1, NOW - 1]) {
      const harness = makeHarness()
      await harness.ready()
      const challenge = await harness.authority.beginConsent(binding(), null)
      await expect(harness.authority.confirmConsent(
        slot(), challenge.authorityRevision,
        proof(challenge, { confirmedAt: new Date(confirmedAt).toISOString() }),
      )).rejects.toMatchObject({ code: 'APPROVAL_STALE' })
    }
  })

  it('maps CAS and nonce conflicts to stable fail-closed errors', async () => {
    const cas = makeHarness({ transitionStatus: 'cas-conflict' })
    await cas.ready()
    await expect(cas.authority.beginConsent(binding(), null))
      .rejects.toMatchObject({ code: 'CAS_CONFLICT' })
    const nonce = makeHarness({ transitionStatus: 'nonce-conflict' })
    await nonce.ready()
    await expect(nonce.authority.beginConsent(binding(), null))
      .rejects.toMatchObject({ code: 'REPLAYED_OR_UNKNOWN' })
  })

  it('globally invalidates old-boot cards, suspends live authorities and returns revoking slots', async () => {
    const pendingHarness = makeHarness({ bootId: 'boot-old' })
    await pendingHarness.ready()
    const stale = await pendingHarness.authority.beginConsent(binding(), null)

    const activeBinding = binding({ profileId: 'profile-active' })
    const activeHarness = makeHarness({ bootId: 'boot-old' })
    await activeHarness.ready()
    const activeChallenge = await activeHarness.authority.beginConsent(activeBinding, null)
    const activeConsent = await activeHarness.authority.confirmConsent(
      slot(activeBinding), activeChallenge.authorityRevision, proof(activeChallenge),
    )
    const active = await activeHarness.authority.activate({
      binding: activeBinding,
      expectedRevision: activeConsent.revision,
    })
    if (active.state !== 'ACTIVE') throw new Error('expected ACTIVE')
    pendingHarness.setStored(active)

    const revokingBinding = binding({ profileId: 'profile-revoking' })
    const revokingRecord = { ...active, binding: revokingBinding, state: 'REVOKING' as const,
      revokeStartedAt: active.updatedAt }
    pendingHarness.setStored(revokingRecord)

    const restarted = pendingHarness.restartAuthority('boot-new')
    const recovery = await restarted.recoverForBoot()
    expect(recovery).toEqual({
      invalidatedCards: [{ cardId: stale.cardId, actionId: stale.actionId }],
      revoking: [slot(revokingBinding)],
    })
    expect(pendingHarness.records.get(slotKey(slot()))).toMatchObject({
      state: 'AWAITING_CONSENT',
      revision: stale.authorityRevision + 1,
      pending: { invalidatedAt: new Date(NOW).toISOString() },
    })
    expect(pendingHarness.records.get(slotKey(slot(activeBinding)))).toMatchObject({
      state: 'SUSPENDED',
      revision: active.revision + 1,
    })
    expect(pendingHarness.nonces.get(`grant:${stale.nonceId}`)?.status).toBe('invalidated')
    expect([...pendingHarness.outbox.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'memory.semantic_egress.stale', code: 'STALE_BOOT' }),
      expect.objectContaining({
        kind: 'memory.semantic_egress.suspended',
        code: 'BOOT_REACTIVATION_REQUIRED',
      }),
    ]))
  })

  it('permits a fresh challenge only after durable stale invalidation', async () => {
    const harness = makeHarness({ bootId: 'boot-old' })
    await harness.ready()
    const first = await harness.authority.beginConsent(binding(), null)
    await expect(harness.authority.beginConsent(binding(), first.authorityRevision))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    const restarted = harness.restartAuthority('boot-new')
    await restarted.recoverForBoot()
    const fresh = await restarted.beginConsent(binding(), first.authorityRevision + 1)
    expect(fresh.authorityRevision).toBe(first.authorityRevision + 2)
    expect(fresh.actionHash).not.toBe(first.actionHash)
  })

  it('clears volatile activation leases even when boot recovery storage fails', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    let failRecovery = false
    const throwingStore: SemanticEgressDurableStore = {
      ...harness.durable,
      async recoverForBoot(input) {
        if (failRecovery) throw new Error('private disk detail')
        return harness.durable.recoverForBoot(input)
      },
    }
    const authority = makeSemanticEgressConsentAuthority({
      secret: new Uint8Array(32).fill(7),
      bootId: 'boot-new',
      durable: throwingStore,
      nowMs: () => NOW,
      newId: () => 'unused-id',
      health: async () => 'healthy',
      purgeAndVerify: async () => true,
    })
    await authority.recoverForBoot()
    const reactivated = await authority.activate({
      binding: binding(), expectedRevision: active.revision + 1,
    })
    failRecovery = true
    await expect(authority.recoverForBoot())
      .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    await expect(authority.issueUseProof({
      binding: binding(), expectedRevision: reactivated.revision, ttlMs: 1000,
    })).rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
  })

  it('rejects malformed recovery responses from the durable boundary', async () => {
    await expect(makeHarness({ malformedRecovery: true }).authority.recoverForBoot())
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_STATE' })
  })

  it('keeps use proof issue/consume/complete on the unified atomic boundary', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })
    expect(harness.nonces.get(`use:${useProof.nonceId}`)?.status).toBe('issued')
    await harness.authority.consumeUseProof(useProof, binding())
    expect(harness.nonces.get(`use:${useProof.nonceId}`)?.status).toBe('consumed')
    await harness.authority.completeUse(useProof, binding())
    expect([...harness.outbox.values()].map(event => event.kind)).toEqual(expect.arrayContaining([
      'memory.semantic_egress.request_started',
      'memory.semantic_egress.request_completed',
    ]))
    await expect(harness.authority.consumeUseProof(useProof, binding()))
      .rejects.toMatchObject({ code: 'REPLAYED_OR_UNKNOWN' })
  })

  it('starts use with one exact ACTIVE authority transaction and registers the lease before unlock', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })

    const lease = await harness.authority.consumeUseProof(useProof, binding())
    const revoking = await harness.authority.beginRevoke(slot(), active.revision)

    expect(harness.useStarts).toEqual([expect.objectContaining({
      authorityId: active.authorityId,
      authorityRevision: active.revision,
      generation: active.generation,
      bindingHash: semanticEgressBindingHash(binding()),
      nonceId: useProof.nonceId,
      outbox: expect.objectContaining({ kind: 'memory.semantic_egress.request_started' }),
    })])
    expect(revoking.state).toBe('REVOKING')
    expect(lease.signal.aborted).toBe(true)
    await lease.release()
  })

  it('lets REVOKING win before a queued use and blocks new provider I/O', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })

    const revokePromise = harness.authority.beginRevoke(slot(), active.revision)
    const usePromise = harness.authority.consumeUseProof(useProof, binding())

    await expect(revokePromise).resolves.toMatchObject({ state: 'REVOKING' })
    await expect(usePromise).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(harness.useStarts).toHaveLength(0)
  })

  it('unregisters the provisional lease when the atomic use start does not commit', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })
    harness.setUseStartStatus('cas-conflict')

    await expect(harness.authority.consumeUseProof(useProof, binding()))
      .rejects.toMatchObject({ code: 'CAS_CONFLICT' })
    harness.setUseStartStatus(undefined)
    const revoking = await harness.authority.beginRevoke(slot(), active.revision)
    await expect(harness.authority.completeRevoke(slot(), revoking.revision))
      .resolves.toMatchObject({ state: 'REVOKED' })
    expect(harness.purgeAndVerify).toHaveBeenCalledTimes(1)
  })

  it('holds revoke completion and purge until an aborted provider owner releases its lease', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })
    const lease = await harness.authority.consumeUseProof(useProof, binding())
    const revoking = await harness.authority.beginRevoke(slot(), active.revision)

    expect(lease.signal.aborted).toBe(true)
    const completion = harness.authority.completeRevoke(slot(), revoking.revision)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.purgeAndVerify).not.toHaveBeenCalled()

    await lease.release()
    await expect(completion).resolves.toMatchObject({ state: 'REVOKED' })
    expect(harness.purgeAndVerify).toHaveBeenCalledTimes(1)
  })

  it('serializes publication and revoke in both orders and rejects a late ignored-abort result', async () => {
    const first = makeHarness()
    const firstActive = await consentAndActivate(first)
    const firstProof = await first.authority.issueUseProof({
      binding: binding(), expectedRevision: firstActive.revision, ttlMs: 1000,
    })
    const firstLease = await first.authority.consumeUseProof(firstProof, binding())
    let enterPublish!: () => void
    let finishPublish!: () => void
    const entered = new Promise<void>(resolve => { enterPublish = resolve })
    const finish = new Promise<void>(resolve => { finishPublish = resolve })
    const publication = firstLease.publish(async () => {
      enterPublish()
      await finish
      return 'published'
    })
    await entered
    const firstRevoke = first.authority.beginRevoke(slot(), firstActive.revision)
    expect(firstLease.signal.aborted).toBe(true)
    finishPublish()
    await expect(publication).resolves.toBe('published')
    await expect(firstRevoke).resolves.toMatchObject({ state: 'REVOKING' })

    const second = makeHarness()
    const secondActive = await consentAndActivate(second)
    const secondProof = await second.authority.issueUseProof({
      binding: binding(), expectedRevision: secondActive.revision, ttlMs: 1000,
    })
    const secondLease = await second.authority.consumeUseProof(secondProof, binding())
    const secondRevoking = await second.authority.beginRevoke(slot(), secondActive.revision)
    let latePublisherCalled = false
    const completion = second.authority.completeRevoke(slot(), secondRevoking.revision)
    await expect(secondLease.publish(async () => {
      latePublisherCalled = true
    })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(latePublisherCalled).toBe(false)
    await expect(completion).resolves.toMatchObject({ state: 'REVOKED' })
  })

  it('aborts an active lease even when durable revoke intent cannot be read or persisted', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })
    const lease = await harness.authority.consumeUseProof(useProof, binding())
    harness.setStoreThrows(true)

    await expect(harness.authority.beginRevoke(slot(), active.revision))
      .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    expect(lease.signal.aborted).toBe(true)
    let published = false
    await expect(lease.publish(async () => { published = true }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(published).toBe(false)
  })

  it('serializes every closing authority transition with publish and aborts the lease', async () => {
    const cases = [
      {
        state: 'DEGRADED',
        close: (harness: ReturnType<typeof makeHarness>, revision: number) =>
          harness.authority.setDegraded(slot(), revision),
      },
      {
        state: 'SUSPENDED',
        close: (harness: ReturnType<typeof makeHarness>, revision: number) =>
          harness.authority.suspend(slot(), revision),
      },
      {
        state: 'BLOCKED',
        close: (harness: ReturnType<typeof makeHarness>, revision: number) =>
          harness.authority.block(slot(), revision, 'POLICY_BLOCKED'),
      },
    ] as const

    for (const entry of cases) {
      const harness = makeHarness()
      const active = await consentAndActivate(harness)
      const useProof = await harness.authority.issueUseProof({
        binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
      })
      const lease = await harness.authority.consumeUseProof(useProof, binding())
      await expect(entry.close(harness, active.revision)).resolves.toMatchObject({
        state: entry.state,
      })
      expect(lease.signal.aborted).toBe(true)
      let published = false
      await expect(lease.publish(async () => { published = true }))
        .rejects.toMatchObject({ code: 'INVALID_STATE' })
      expect(published).toBe(false)
    }
  })

  it('makes repeated recovery wait for an entered publication fence before suspending', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const useProof = await harness.authority.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 1000,
    })
    const lease = await harness.authority.consumeUseProof(useProof, binding())
    let entered!: () => void
    let finish!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const finishPromise = new Promise<void>(resolve => { finish = resolve })
    const publication = lease.publish(async () => {
      entered()
      await finishPromise
      return 'published-before-recovery'
    })
    await enteredPromise

    let recoveryFinished = false
    const recovery = harness.authority.recoverForBoot().then((value) => {
      recoveryFinished = true
      return value
    })
    expect(lease.signal.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(recoveryFinished).toBe(false)

    finish()
    await expect(publication).resolves.toBe('published-before-recovery')
    await expect(recovery).resolves.toMatchObject({ revoking: [] })
    await expect(harness.authority.load(slot())).resolves.toMatchObject({ state: 'SUSPENDED' })
  })

  it('derives request event ids deterministically from the domain, phase and nonce', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify([
        'aisy.semantic-egress.request-event.v1', 'started', 'nonce-1',
      ]), 'utf8')
      .digest('hex')
    expect(semanticEgressRequestEventId('started', 'nonce-1')).toBe(expected)
    expect(semanticEgressRequestEventId('started', 'nonce-1')).toBe(expected)
    expect(semanticEgressRequestEventId('completed', 'nonce-1')).not.toBe(expected)
    expect(semanticEgressRequestEventId('started', 'nonce-2')).not.toBe(expected)
  })

  it('atomically emits lifecycle events and keeps purge failure fail closed', async () => {
    const harness = makeHarness()
    const active = await consentAndActivate(harness)
    const revoking = await harness.authority.beginRevoke(slot(), active.revision)
    const revoked = await harness.authority.completeRevoke(slot(), revoking.revision)
    expect(revoked.state).toBe('REVOKED')
    expect([...harness.outbox.values()].map(event => event.kind)).toEqual(expect.arrayContaining([
      'memory.semantic_egress.revoke_started',
      'memory.semantic_egress.purge_completed',
      'memory.semantic_egress.revoked',
    ]))

    const failed = makeHarness({ purge: false })
    const failedActive = await consentAndActivate(failed)
    const failedRevoking = await failed.authority.beginRevoke(slot(), failedActive.revision)
    await expect(failed.authority.completeRevoke(slot(), failedRevoking.revision))
      .rejects.toMatchObject({ code: 'PURGE_FAILED' })
    expect(failed.records.get(slotKey(slot()))?.state).toBe('REVOKING')
  })

  it('fails closed on corrupt persisted records without leaking backend details', async () => {
    const harness = makeHarness()
    harness.records.set(slotKey(slot()), { schemaVersion: 2 } as never)
    await expect(harness.authority.load(slot()))
      .rejects.toMatchObject({ code: 'INVALID_PERSISTED_STATE', message: 'INVALID_PERSISTED_STATE' })
    await expect(makeHarness({ storeThrows: true }).authority.load(slot()))
      .rejects.toMatchObject({ code: 'STORE_UNAVAILABLE', message: 'STORE_UNAVAILABLE' })
  })
})

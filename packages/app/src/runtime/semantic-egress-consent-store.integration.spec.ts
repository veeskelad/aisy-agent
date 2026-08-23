import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeSemanticEgressConsentAuthority,
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  semanticDescriptorId,
  semanticEgressOutboxEventId,
  semanticEgressRecoveryEventId,
  type SemanticEgressConsentBinding,
  type SemanticEgressConsentChallengeV1,
  type SemanticEgressConsentSlot,
  type SemanticEgressDurableStore,
} from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeNodeSemanticEgressConsentStore } from './semantic-egress-consent-store.js'

const roots: string[] = []
const START = Date.parse('2026-07-30T08:00:00.000Z')
const SECRET = new Uint8Array(32).fill(7)

function databasePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-semantic-consent-integration-')))
  roots.push(root)
  return join(root, 'private', 'semantic-egress.sqlite')
}

function binding(): SemanticEgressConsentBinding {
  const descriptor = {
    provider: 'openrouter' as const,
    modelId: 'openai/text-embedding-3-small',
    modelRevision: '2026-07-01',
    dimensions: 1536,
    normalizationVersion: 'nfkc-lf-v1',
    chunkerVersion: 'memory-fact-v1',
  }
  return {
    operatorId: 'operator-1',
    profileId: 'profile-1',
    purpose: 'memory.semantic-embedding.v1',
    provider: 'openrouter',
    connectionId: 'connection-1',
    connectionRevision: 'ready-record-7',
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

function slot(value = binding()): SemanticEgressConsentSlot {
  return {
    operatorId: value.operatorId,
    profileId: value.profileId,
    purpose: value.purpose,
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

function authority(input: {
  bootId: string
  durable: SemanticEgressDurableStore
  nowMs(): number
  newId(): string
  purgeAndVerify?: () => Promise<boolean>
}) {
  return makeSemanticEgressConsentAuthority({
    ...input,
    secret: SECRET,
    health: async () => 'healthy',
    purgeAndVerify: input.purgeAndVerify ?? (async () => true),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Core authority with the real semantic egress SQLite store', () => {
  it('survives restart, remains closed before recovery, and preserves exact outbox IDs', async () => {
    const path = databasePath()
    let now = START
    let serial = 0
    const firstStore = makeNodeSemanticEgressConsentStore({ path })
    const boot1 = authority({
      bootId: 'boot-1',
      durable: firstStore.durable,
      nowMs: () => now,
      newId: () => `id-${++serial}`,
    })
    await boot1.recoverForBoot()
    const challenge = await boot1.beginConsent(binding(), null)
    now += 1_000
    const consented = await boot1.confirmConsent(
      slot(), challenge.authorityRevision, proof(challenge),
    )
    firstStore.close()

    const restartedStore = makeNodeSemanticEgressConsentStore({ path })
    const boot2 = authority({
      bootId: 'boot-2',
      durable: restartedStore.durable,
      nowMs: () => now,
      newId: () => `id-${++serial}`,
    })
    await expect(boot2.activate({ binding: binding(), expectedRevision: consented.revision }))
      .rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
    expect((await restartedStore.durable.readOutbox(10)).map(event => event.eventId)).toEqual([
      semanticEgressOutboxEventId({
        authorityId: challenge.authorityId,
        authorityRevision: challenge.authorityRevision,
        kind: 'memory.semantic_egress.disclosure_issued',
      }),
      semanticEgressOutboxEventId({
        authorityId: consented.authorityId,
        authorityRevision: consented.revision,
        kind: 'memory.semantic_egress.consent_granted',
      }),
    ])

    now += 1_000
    await expect(boot2.recoverForBoot()).resolves.toEqual({ invalidatedCards: [], revoking: [] })
    const active = await boot2.activate({ binding: binding(), expectedRevision: consented.revision })
    expect(active.state).toBe('ACTIVE')
    const events = await restartedStore.durable.readOutbox(10)
    expect(events.map(event => event.kind)).toEqual([
      'memory.semantic_egress.disclosure_issued',
      'memory.semantic_egress.consent_granted',
      'memory.semantic_egress.activated',
    ])
    expect(events.map(event => event.eventId)).toEqual(events.map(event =>
      semanticEgressOutboxEventId({
        authorityId: event.authorityId,
        authorityRevision: event.authorityRevision,
        kind: event.kind,
      })))
    restartedStore.close()
  })

  it('invalidates an old-boot challenge and accepts only a fresh bumped challenge', async () => {
    const path = databasePath()
    let now = START
    let serial = 0
    const oldStore = makeNodeSemanticEgressConsentStore({ path })
    const oldAuthority = authority({
      bootId: 'boot-old',
      durable: oldStore.durable,
      nowMs: () => now,
      newId: () => `id-${++serial}`,
    })
    await oldAuthority.recoverForBoot()
    const oldChallenge = await oldAuthority.beginConsent(binding(), null)
    oldStore.close()

    now += 1_000
    const newStore = makeNodeSemanticEgressConsentStore({ path })
    const newAuthority = authority({
      bootId: 'boot-new',
      durable: newStore.durable,
      nowMs: () => now,
      newId: () => `id-${++serial}`,
    })
    await expect(newAuthority.confirmConsent(
      slot(), oldChallenge.authorityRevision, proof(oldChallenge),
    )).rejects.toMatchObject({ code: 'BOOT_RECOVERY_REQUIRED' })
    await expect(newAuthority.recoverForBoot()).resolves.toEqual({
      invalidatedCards: [{ cardId: oldChallenge.cardId, actionId: oldChallenge.actionId }],
      revoking: [],
    })
    await expect(newAuthority.confirmConsent(
      slot(), oldChallenge.authorityRevision + 1, proof(oldChallenge),
    )).rejects.toMatchObject({ code: 'INVALID_STATE' })

    now += 1_000
    const freshChallenge = await newAuthority.beginConsent(
      binding(), oldChallenge.authorityRevision + 1,
    )
    expect(freshChallenge.authorityRevision).toBe(oldChallenge.authorityRevision + 2)
    now += 1_000
    await expect(newAuthority.confirmConsent(
      slot(), freshChallenge.authorityRevision, proof(freshChallenge),
    )).resolves.toMatchObject({
      state: 'CONSENTED',
      revision: oldChallenge.authorityRevision + 3,
    })

    const events = await newStore.durable.readOutbox(10)
    expect(events.map(event => event.kind)).toEqual([
      'memory.semantic_egress.disclosure_issued',
      'memory.semantic_egress.stale',
      'memory.semantic_egress.disclosure_issued',
      'memory.semantic_egress.consent_granted',
    ])
    expect(events[1]?.eventId).toBe(semanticEgressRecoveryEventId({
      bootId: 'boot-new',
      kind: 'memory.semantic_egress.stale',
      slot: slot(),
      priorRevision: oldChallenge.authorityRevision,
      nextRevision: oldChallenge.authorityRevision + 1,
    }))
    newStore.close()
  })

  it('orders real SQLite use and revoke so late publication is denied before purge', async () => {
    const path = databasePath()
    let now = START
    let serial = 0
    const purgeAndVerify = vi.fn(async () => true)
    const store = makeNodeSemanticEgressConsentStore({ path })
    const runtime = authority({
      bootId: 'boot-use-revoke',
      durable: store.durable,
      nowMs: () => now,
      newId: () => `id-${++serial}`,
      purgeAndVerify,
    })
    await runtime.recoverForBoot()
    const challenge = await runtime.beginConsent(binding(), null)
    now += 1_000
    const consented = await runtime.confirmConsent(
      slot(), challenge.authorityRevision, proof(challenge),
    )
    now += 1_000
    const active = await runtime.activate({
      binding: binding(), expectedRevision: consented.revision,
    })
    if (active.state !== 'ACTIVE') throw new Error('expected ACTIVE test fixture')
    const startedProof = await runtime.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 10_000,
    })
    const blockedProof = await runtime.issueUseProof({
      binding: binding(), expectedRevision: active.revision, ttlMs: 10_000,
    })
    const lease = await runtime.consumeUseProof(startedProof, binding())

    now += 1_000
    const revoking = await runtime.beginRevoke(slot(), active.revision)
    expect(lease.signal.aborted).toBe(true)
    const completion = runtime.completeRevoke(slot(), revoking.revision)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(purgeAndVerify).not.toHaveBeenCalled()

    let published = false
    await expect(lease.publish(async () => {
      published = true
    })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(published).toBe(false)
    await expect(completion).resolves.toMatchObject({ state: 'REVOKED' })
    expect(purgeAndVerify).toHaveBeenCalledTimes(1)
    await expect(runtime.consumeUseProof(blockedProof, binding()))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })

    const events = await store.durable.readOutbox(100)
    expect(events.filter(event => event.kind === 'memory.semantic_egress.request_started'))
      .toHaveLength(1)
    expect(events.map(event => event.kind)).toEqual(expect.arrayContaining([
      'memory.semantic_egress.revoke_started',
      'memory.semantic_egress.purge_completed',
      'memory.semantic_egress.revoked',
    ]))
    store.close()
  })
})

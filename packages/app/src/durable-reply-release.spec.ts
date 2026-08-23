import { describe, expect, it } from 'vitest'

import type { ResolvedWorkBinding } from '@aisy/core'

import {
  durableTelegramReplyEnvelopeHash,
  durableTelegramReplyReleaseIntentHash,
  recoverDurableTelegramReplyRelease,
} from './durable-reply-release.js'
import type { ExecutionSupervisorReleaseReceiptV1 } from './execution-supervisor-ipc.js'
import {
  makeJsonTelegramReplyCheckpointStore,
  makeTelegramReplyCheckpoint,
  makeTelegramReplyDeliveryReceipt,
} from './telegram-reply-stream-checkpoint.js'

const binding: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}

function fixture() {
  let content: string | undefined
  const store = makeJsonTelegramReplyCheckpointStore({
    exists: () => content !== undefined,
    read: () => content ?? '',
    saveAtomic: value => { content = value },
  })
  const checkpoint = makeTelegramReplyCheckpoint({
    bindingHash: '1'.repeat(64),
    dispatchId: '2'.repeat(64),
    ownerId: 'owner-a',
    revision: 1,
    phase: 'terminal',
    delivery: 'delivered',
    messageId: 17,
    locked: false,
    replyHash: '3'.repeat(64),
    document: 'none',
    updatedAt: '2026-08-12T00:00:00.000Z',
  })
  // The generic store permits only a prepared begin, so publish the exact
  // terminal fixture through its storage seam.
  content = `${JSON.stringify(checkpoint, null, 2)}\n`
  const delivery = makeTelegramReplyDeliveryReceipt(checkpoint)!
  const envelopeHash = durableTelegramReplyEnvelopeHash({
    binding,
    replyBindingHash: delivery.bindingHash,
    dispatchId: delivery.dispatchId,
    ownerId: delivery.ownerId,
  })
  const releaseIntentHash = durableTelegramReplyReleaseIntentHash({ envelopeHash, receipt: delivery })
  const releaseReceipt = Object.freeze({
    kind: 'execution-supervisor-release-receipt-v1' as const,
    releaseIntentHash,
    envelopeHash,
    receiptHash: '4'.repeat(64),
    bindingHash: '5'.repeat(64),
    runLivenessHash: '6'.repeat(64),
    authorityPhase: 'checkpoint-bound' as const,
    releasedAtMs: 1,
  }) satisfies ExecutionSupervisorReleaseReceiptV1
  return { store, releaseReceipt }
}

describe('durable Telegram reply release recovery', () => {
  it('consumes only the receipt reconstructed from terminal private evidence', async () => {
    const { store, releaseReceipt } = fixture()
    const consumed: ExecutionSupervisorReleaseReceiptV1[] = []
    await expect(recoverDurableTelegramReplyRelease({
      store,
      binding,
      releaseReceipt,
      consumeReleaseReceipt: async receipt => { consumed.push(receipt) },
    })).resolves.toBe('consumed')
    expect(consumed).toEqual([releaseReceipt])
  })

  it('fails closed on a receipt/checkpoint identity mismatch', async () => {
    const { store, releaseReceipt } = fixture()
    await expect(recoverDurableTelegramReplyRelease({
      store,
      binding,
      releaseReceipt: Object.freeze({ ...releaseReceipt, envelopeHash: '9'.repeat(64) }),
      consumeReleaseReceipt: async () => { throw new Error('must not consume') },
    })).rejects.toThrow('DURABLE_REPLY_RECOVERY_MISMATCH')
  })
})

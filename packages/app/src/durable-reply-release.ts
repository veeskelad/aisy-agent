import { createHash } from 'node:crypto'

import type { ResolvedWorkBinding } from '@aisy/core'

import type { ExecutionSupervisorReleaseReceiptV1 } from './execution-supervisor-ipc.js'
import {
  makeTelegramReplyDeliveryReceipt,
  type TelegramReplyCheckpointStore,
  type TelegramReplyDeliveryReceiptV1,
} from './telegram-reply-stream-checkpoint.js'

const HASH = /^[a-f0-9]{64}$/

export function durableTelegramReplyEnvelopeHash(input: Readonly<{
  binding: ResolvedWorkBinding
  replyBindingHash: string
  dispatchId: string
  ownerId: string
}>): string {
  if (!HASH.test(input.replyBindingHash) || !HASH.test(input.dispatchId) ||
    typeof input.ownerId !== 'string' || input.ownerId.length === 0) {
    throw new Error('DURABLE_REPLY_IDENTITY_INVALID')
  }
  return createHash('sha256')
    .update('aisy.telegram.reply-envelope.v1\0')
    .update(JSON.stringify([
      input.binding,
      input.replyBindingHash,
      input.dispatchId,
      input.ownerId,
    ]))
    .digest('hex')
}

export function durableTelegramReplyReleaseIntentHash(input: Readonly<{
  envelopeHash: string
  receipt: TelegramReplyDeliveryReceiptV1
}>): string {
  if (!HASH.test(input.envelopeHash)) throw new Error('DURABLE_REPLY_IDENTITY_INVALID')
  return createHash('sha256')
    .update('aisy.telegram.reply-release-intent.v1\0')
    .update(JSON.stringify({ envelopeHash: input.envelopeHash, receipt: input.receipt }))
    .digest('hex')
}

/** Consume a parent-held release receipt only when the private reply evidence matches it. */
export async function recoverDurableTelegramReplyRelease(input: Readonly<{
  store: TelegramReplyCheckpointStore
  binding: ResolvedWorkBinding
  releaseReceipt: ExecutionSupervisorReleaseReceiptV1 | null
  consumeReleaseReceipt(receipt: ExecutionSupervisorReleaseReceiptV1): Promise<void>
}>): Promise<'none' | 'consumed'> {
  if (input.releaseReceipt === null) return 'none'
  const loaded = input.store.load()
  if (loaded.status !== 'ready') throw new Error('DURABLE_REPLY_RECOVERY_UNAVAILABLE')
  const delivery = makeTelegramReplyDeliveryReceipt(loaded.checkpoint)
  if (delivery === null) throw new Error('DURABLE_REPLY_RECOVERY_UNAVAILABLE')
  const envelopeHash = durableTelegramReplyEnvelopeHash({
    binding: input.binding,
    replyBindingHash: delivery.bindingHash,
    dispatchId: delivery.dispatchId,
    ownerId: delivery.ownerId,
  })
  const releaseIntentHash = durableTelegramReplyReleaseIntentHash({
    envelopeHash,
    receipt: delivery,
  })
  if (input.releaseReceipt.envelopeHash !== envelopeHash ||
    input.releaseReceipt.releaseIntentHash !== releaseIntentHash) {
    throw new Error('DURABLE_REPLY_RECOVERY_MISMATCH')
  }
  await input.consumeReleaseReceipt(input.releaseReceipt)
  return 'consumed'
}

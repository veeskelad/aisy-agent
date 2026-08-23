import { fitBody } from '@aisy/telegram-gw'
import {
  confirmTelegramReplyCheckpointForSupervisorRelease,
  isTelegramReplyCheckpointAuthorityGenuine,
  makeTelegramReplyDeliveryReceipt,
  makeTelegramReplyCheckpoint,
  replyContentHash,
  type TelegramReplyCheckpointAuthorityV1,
  type TelegramReplyDeliveryReceiptV1,
  type TelegramReplyCheckpointStore,
  type TelegramReplyDocumentDelivery,
  type TelegramReplyPhase,
} from './telegram-reply-stream-checkpoint.js'

export interface TelegramReplyStreamOutput {
  /** Re-check the code-owned egress gate immediately before a Telegram write. */
  guard(text: string): Promise<void>
  sendText(html: string): Promise<number>
  editText(messageId: number, html: string): Promise<void>
  sendDocument(document: { filename: string; content: string }): Promise<void>
}

export interface TelegramReplyStream {
  setLockout(locked: boolean): void
  append(delta: string): Promise<void>
  finalizeWithReceipt(reply: string): Promise<TelegramReplyFinalizeResult>
  /** Backwards-compatible projection: true means the complete reply was delivered. */
  finalize(reply: string): Promise<boolean>
  stop(): Promise<void>
}

export type TelegramReplyFinalizeResult =
  | Readonly<{
      kind: 'delivered'
      durability: 'durable'
      receipt: TelegramReplyDeliveryReceiptV1
    }>
  | Readonly<{
      kind: 'delivered'
      durability: 'volatile'
      messageId: number
      replyHash: string
      document: Exclude<TelegramReplyDocumentDelivery, 'pending'>
    }>
  | Readonly<{ kind: 'fallback-safe'; code: 'NO_TELEGRAM_WRITE' }>
  | Readonly<{
      kind: 'blocked'
      code: 'REPLY_DURABILITY_UNAVAILABLE' | 'FINAL_REPLY_MISMATCH'
    }>
  | Readonly<{
      kind: 'delivery-uncertain'
      code: 'DELIVERY_UNCERTAIN'
      messageId?: number
      checkpointRevision?: number
    }>

const DEFAULT_EDIT_INTERVAL_MS = 250
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

/**
 * One Telegram message, edited in place. It starts fail-closed and ignores all
 * deltas until Core emits an explicit outbound-lockout verdict for this turn.
 */
export function makeTelegramReplyStream(input: {
  output: TelegramReplyStreamOutput
  signal: AbortSignal
  editIntervalMs?: number
  nowMs?: () => number
  checkpoint?: {
    store: TelegramReplyCheckpointStore
    bindingHash: string
    dispatchId: string
    ownerId: string
    nowIso?: () => string
    authority?: TelegramReplyCheckpointAuthorityV1
    /** Legacy guard: it can narrow writes but cannot make a receipt release-safe. */
    assertAuthorityHeld?: () => boolean
  }
}): TelegramReplyStream {
  const interval = input.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS
  if (!Number.isFinite(interval) || interval < 0) throw new Error('INVALID_STREAM_INTERVAL')
  const nowMs = input.nowMs ?? Date.now
  let authorized = false
  let locked = true
  let stopped = false
  let closed = false
  let failed = false
  let deliveryUncertain = false
  let durabilityBlocked = false
  let telegramWriteAttempted = false
  let body = ''
  let bodyBytes = 0
  let lastSentBody = ''
  let messageId: number | null = null
  let lastWriteAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let tail: Promise<void> = Promise.resolve()
  let checkpointRevision = 0
  let terminal = false
  let documentDelivery: TelegramReplyDocumentDelivery = 'none'
  let durableReceipt: TelegramReplyDeliveryReceiptV1 | null = null
  let finalReplyHash: string | null = null
  let finalization: Promise<TelegramReplyFinalizeResult> | null = null
  const checkpointNow = input.checkpoint?.nowIso ?? (() => new Date().toISOString())

  const assertAuthorityHeld = (): void => {
    const authority = input.checkpoint?.authority
    if (authority !== undefined && (!isTelegramReplyCheckpointAuthorityGenuine(authority) ||
      authority.bindingHash !== input.checkpoint?.bindingHash ||
      authority.dispatchId !== input.checkpoint?.dispatchId ||
      authority.ownerId !== input.checkpoint?.ownerId || !authority.assertHeld())) {
      throw new Error('REPLY_AUTHORITY_UNAVAILABLE')
    }
    if (input.checkpoint?.assertAuthorityHeld?.() === false) {
      throw new Error('REPLY_AUTHORITY_UNAVAILABLE')
    }
  }

  const saveCheckpoint = (
    phase: TelegramReplyPhase,
    delivery: 'pending' | 'delivered',
    nextMessageId: number | null,
    replyHash?: string,
    nextDocument: TelegramReplyDocumentDelivery = 'none',
  ) => {
    if (input.checkpoint === undefined) return null
    assertAuthorityHeld()
    const next = makeTelegramReplyCheckpoint({
      bindingHash: input.checkpoint.bindingHash,
      dispatchId: input.checkpoint.dispatchId,
      ownerId: input.checkpoint.ownerId,
      revision: checkpointRevision + 1,
      phase,
      delivery,
      ...(nextMessageId === null ? {} : { messageId: nextMessageId }),
      locked: false,
      ...(replyHash === undefined ? {} : { replyHash }),
      document: nextDocument,
      updatedAt: checkpointNow(),
    })
    if (checkpointRevision === 0) input.checkpoint.store.begin(next)
    else {
      input.checkpoint.store.replace(next, {
        bindingHash: input.checkpoint.bindingHash,
        dispatchId: input.checkpoint.dispatchId,
        ownerId: input.checkpoint.ownerId,
        revision: checkpointRevision,
      })
    }
    checkpointRevision = next.revision
    return next
  }

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const writable = (): boolean =>
    authorized && !locked && !stopped && !input.signal.aborted

  const flush = async (): Promise<void> => {
    if (!writable() || deliveryUncertain) return
    const snapshot = body.length > 0 ? body : '(пустой ответ)'
    if (snapshot === lastSentBody) {
      if (terminal && messageId !== null) {
        const checkpoint = saveCheckpoint(
          'terminal', 'delivered', messageId, replyContentHash(snapshot), documentDelivery,
        )
        durableReceipt = checkpoint === null ? null : makeTelegramReplyDeliveryReceipt(checkpoint)
      }
      return
    }
    await input.output.guard(snapshot)
    // A lockout/abort can arrive while the asynchronous guard is running.
    if (!writable() || deliveryUncertain) return
    const fitted = fitBody(snapshot)
    const hash = terminal ? replyContentHash(snapshot) : undefined
    saveCheckpoint(messageId === null ? 'prepared' : terminal ? 'terminal' : 'bound', 'pending', messageId,
      hash,
      messageId === null ? 'none' : terminal ? documentDelivery : 'none')
    assertAuthorityHeld()
    telegramWriteAttempted = true
    if (messageId === null) {
      const sentMessageId = await input.output.sendText(fitted.text)
      if (!Number.isSafeInteger(sentMessageId) || sentMessageId < 1) {
        throw new Error('INVALID_REPLY_MESSAGE_ID')
      }
      messageId = sentMessageId
    } else await input.output.editText(messageId, fitted.text)
    assertAuthorityHeld()
    const checkpoint = saveCheckpoint(terminal ? 'terminal' : 'bound', 'delivered', messageId, hash,
      terminal ? documentDelivery : 'none')
    durableReceipt = checkpoint === null ? null : makeTelegramReplyDeliveryReceipt(checkpoint)
    lastSentBody = snapshot
    lastWriteAt = nowMs()
  }

  const queueFlush = (): Promise<void> => {
    tail = tail.then(flush).catch(() => {
      failed = true
      if (telegramWriteAttempted) deliveryUncertain = true
      else if (input.checkpoint !== undefined) durabilityBlocked = true
    })
    return tail
  }

  const schedule = (): void => {
    if (timer !== null || !writable() || deliveryUncertain) return
    const remaining = Math.max(0, interval - (nowMs() - lastWriteAt))
    timer = setTimeout(() => {
      timer = null
      void queueFlush()
    }, remaining)
  }

  const resultWithoutDelivery = (): TelegramReplyFinalizeResult => {
    if (deliveryUncertain || telegramWriteAttempted) {
      return Object.freeze({
        kind: 'delivery-uncertain',
        code: 'DELIVERY_UNCERTAIN',
        ...(messageId === null ? {} : { messageId }),
        ...(checkpointRevision === 0 ? {} : { checkpointRevision }),
      })
    }
    if (durabilityBlocked) {
      return Object.freeze({ kind: 'blocked', code: 'REPLY_DURABILITY_UNAVAILABLE' })
    }
    return Object.freeze({ kind: 'fallback-safe', code: 'NO_TELEGRAM_WRITE' })
  }

  const performFinalize = async (reply: string): Promise<TelegramReplyFinalizeResult> => {
    if (stopped || input.signal.aborted || !authorized || locked) return resultWithoutDelivery()
    closed = true
    clearTimer()
    body = reply.length > 0 ? reply : '(пустой ответ)'
    bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes > MAX_BUFFERED_BYTES || deliveryUncertain) return resultWithoutDelivery()
    terminal = true
    const fitted = fitBody(body)
    documentDelivery = fitted.document === undefined ? 'none' : 'pending'
    // A pre-write delta failure may be retried by the authoritative final body.
    failed = false
    await queueFlush()
    if (failed || messageId === null) return resultWithoutDelivery()
    if (fitted.document !== undefined) {
      try {
        await input.output.guard(body)
        if (!writable()) return resultWithoutDelivery()
        assertAuthorityHeld()
        telegramWriteAttempted = true
        await input.output.sendDocument(fitted.document)
        assertAuthorityHeld()
        documentDelivery = 'delivered'
        const checkpoint = saveCheckpoint(
          'terminal', 'delivered', messageId, replyContentHash(body), documentDelivery,
        )
        durableReceipt = checkpoint === null ? null : makeTelegramReplyDeliveryReceipt(checkpoint)
      } catch {
        deliveryUncertain = true
        return resultWithoutDelivery()
      }
    }
    if (input.checkpoint !== undefined && durableReceipt !== null) {
      let confirmation
      try { assertAuthorityHeld() } catch {
        deliveryUncertain = true
        return resultWithoutDelivery()
      }
      confirmation = confirmTelegramReplyCheckpointForSupervisorRelease({
        store: input.checkpoint.store,
        authority: input.checkpoint.authority,
        bindingHash: input.checkpoint.bindingHash,
        dispatchId: input.checkpoint.dispatchId,
        ownerId: input.checkpoint.ownerId,
        expectedReceipt: durableReceipt,
      })
      if (confirmation.kind === 'delivered') {
        return Object.freeze({
          kind: 'delivered', durability: 'durable', receipt: confirmation.receipt,
        })
      }
      if (confirmation.kind !== 'unavailable') {
        deliveryUncertain = true
        return resultWithoutDelivery()
      }
    }
    if (input.checkpoint !== undefined) {
      if (durableReceipt === null) {
        durabilityBlocked = true
        return resultWithoutDelivery()
      }
    }
    return Object.freeze({
      kind: 'delivered',
      durability: 'volatile',
      messageId,
      replyHash: replyContentHash(body),
      document: documentDelivery === 'pending' ? 'none' : documentDelivery,
    })
  }

  const finalizeWithReceipt = (reply: string): Promise<TelegramReplyFinalizeResult> => {
    const hash = replyContentHash(reply.length > 0 ? reply : '(пустой ответ)')
    if (finalization !== null) {
      return finalReplyHash === hash
        ? finalization
        : Promise.resolve(Object.freeze({ kind: 'blocked', code: 'FINAL_REPLY_MISMATCH' }))
    }
    finalReplyHash = hash
    finalization = performFinalize(reply)
    return finalization
  }

  return Object.freeze<TelegramReplyStream>({
    setLockout(nextLocked) {
      authorized = true
      locked = nextLocked
      if (locked) clearTimer()
    },

    async append(delta) {
      if (closed || stopped || input.signal.aborted || delta.length === 0) return
      // Never retain pre-verdict or locked content for a later unlock: a
      // provider that races the code-owned verdict must not smuggle bytes into
      // the first visible edit.
      if (!authorized || locked) return
      const deltaBytes = Buffer.byteLength(delta, 'utf8')
      if (bodyBytes + deltaBytes > MAX_BUFFERED_BYTES) {
        failed = true
        return
      }
      body += delta
      bodyBytes += deltaBytes
      if (!writable() || failed) return
      if (messageId === null || interval === 0 || nowMs() - lastWriteAt >= interval) {
        await queueFlush()
      } else {
        schedule()
      }
    },

    finalizeWithReceipt,

    async finalize(reply) {
      return (await finalizeWithReceipt(reply)).kind === 'delivered'
    },

    async stop() {
      stopped = true
      clearTimer()
      await tail
    },
  })
}

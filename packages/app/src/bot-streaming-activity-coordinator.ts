import { createHash } from 'node:crypto'

import {
  SessionActivityJournalError,
  type ActivityBinding,
  type ActivityRecovery,
  type ContextSpan,
  type SessionActivityJournal,
  type TranscriptEnvelope,
  type TurnDispatchV1,
} from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

export type TelegramTurnActivityCode =
  | 'INVALID_REQUEST'
  | 'BINDING_MISMATCH'
  | 'INGRESS_IDENTITY_CONFLICT'
  | 'ACTIVITY_UNAVAILABLE'
  | 'ACTIVITY_QUARANTINED'

export class TelegramTurnActivityError extends Error {
  constructor(readonly code: TelegramTurnActivityCode) {
    super(code)
    this.name = 'TelegramTurnActivityError'
  }
}

export interface TelegramTransportBindingV1 extends ActivityBinding {
  readonly chatBindingHash: string
}

export interface TelegramTurnActivityCoordinator {
  accept(input: {
    binding: TelegramTransportBindingV1
    updateId: number
    messageTs: string
    span: ContextSpan
  }): Promise<{ status: 'accepted' | 'duplicate'; ingressId: string }>
  seal(input: {
    binding: TelegramTransportBindingV1
    orderedIngressIds: readonly string[]
    sealedAt: string
  }): Promise<{ status: 'prepared' | 'duplicate'; dispatch: TurnDispatchV1 }>
  recover(input: {
    binding: TelegramTransportBindingV1
    dispatchId: string
    updateIds: readonly number[]
    transcript: readonly TranscriptEnvelope[]
  }): Promise<ActivityRecovery>
}

function strictBinding(value: TelegramTransportBindingV1): TelegramTransportBindingV1 {
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify([
    'chatBindingHash', 'operatorId', 'profileId', 'projectId', 'sessionId',
  ]) || !HASH.test(value.chatBindingHash) ||
    ![value.operatorId, value.profileId, value.projectId, value.sessionId]
      .every(item => SAFE_ID.test(item))) {
    throw new TelegramTurnActivityError('INVALID_REQUEST')
  }
  return Object.freeze(structuredClone(value))
}

function activityBinding(value: TelegramTransportBindingV1): ActivityBinding {
  return Object.freeze<ActivityBinding>({
    operatorId: value.operatorId,
    profileId: value.profileId,
    projectId: value.projectId,
    sessionId: value.sessionId,
  })
}

function mapError(error: unknown): TelegramTurnActivityError {
  if (error instanceof TelegramTurnActivityError) return error
  if (error instanceof SessionActivityJournalError) {
    if (error.code === 'identity-conflict') {
      return new TelegramTurnActivityError('INGRESS_IDENTITY_CONFLICT')
    }
    if (error.code === 'quarantined') {
      return new TelegramTurnActivityError('ACTIVITY_QUARANTINED')
    }
  }
  return new TelegramTurnActivityError('ACTIVITY_UNAVAILABLE')
}

/** Stable transport identity. It never includes the bot token or message content. */
export function makeTelegramChatBindingHash(input: {
  botPublicId: string
  chatId: number
  operatorId: string
}): string {
  if (!SAFE_ID.test(input.botPublicId) || !Number.isSafeInteger(input.chatId) ||
    !SAFE_ID.test(input.operatorId)) {
    throw new TelegramTurnActivityError('INVALID_REQUEST')
  }
  return createHash('sha256').update(JSON.stringify([
    'aisy.telegram.chat-binding.v1', input.botPublicId, input.chatId, input.operatorId,
  ])).digest('hex')
}

/** Offline adapter: the injected journal remains the only durable turn authority. */
export function makeTelegramTurnActivityCoordinator(input: {
  journal: SessionActivityJournal
}): TelegramTurnActivityCoordinator {
  return Object.freeze<TelegramTurnActivityCoordinator>({
    async accept(request) {
      const binding = strictBinding(request.binding)
      try {
        return await input.journal.acceptTelegram({
          binding: activityBinding(binding),
          chatBindingHash: binding.chatBindingHash,
          updateId: request.updateId,
          messageTs: request.messageTs,
          span: structuredClone(request.span),
        })
      } catch (error) {
        throw mapError(error)
      }
    },

    async seal(request) {
      const binding = strictBinding(request.binding)
      try {
        return await input.journal.sealTelegram({
          binding: activityBinding(binding),
          chatBindingHash: binding.chatBindingHash,
          orderedIngressIds: [...request.orderedIngressIds],
          sealedAt: request.sealedAt,
        })
      } catch (error) {
        throw mapError(error)
      }
    },

    async recover(request) {
      const binding = strictBinding(request.binding)
      if (!HASH.test(request.dispatchId) || !Array.isArray(request.updateIds) ||
        request.updateIds.length < 1 || new Set(request.updateIds).size !== request.updateIds.length ||
        request.updateIds.some(id => !Number.isSafeInteger(id) || id < 0)) {
        throw new TelegramTurnActivityError('INVALID_REQUEST')
      }
      const expectedDispatchId = createHash('sha256').update(JSON.stringify([
        'aisy.session-activity.dispatch.v1', binding.operatorId, binding.profileId,
        binding.projectId, binding.sessionId, 'telegram', binding.chatBindingHash,
        [...request.updateIds],
      ])).digest('hex')
      if (request.dispatchId !== expectedDispatchId) {
        throw new TelegramTurnActivityError('BINDING_MISMATCH')
      }
      try {
        const recovered = await input.journal.recover({
          binding: activityBinding(binding),
          dispatchId: request.dispatchId,
          transcript: request.transcript.map(row => structuredClone(row)),
        })
        if (recovered.kind === 'ready' &&
          (recovered.dispatch.source.kind !== 'telegram' ||
            recovered.dispatch.source.chatBindingHash !== binding.chatBindingHash ||
            JSON.stringify(recovered.dispatch.source.updateIds) !== JSON.stringify(request.updateIds))) {
          throw new TelegramTurnActivityError('BINDING_MISMATCH')
        }
        return recovered
      } catch (error) {
        throw mapError(error)
      }
    },
  })
}

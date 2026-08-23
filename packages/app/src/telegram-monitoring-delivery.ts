import type { ResolvedWorkBinding } from '@aisy/core'
import { renderMonitoringDigest } from '@aisy/telegram-gw'
import type { MonitoringDigestDeliveryPort } from './monitoring-runtime.js'

export type TelegramMonitoringDeliveryErrorCode =
  | 'ROUTE_MISMATCH'
  | 'INVALID_MESSAGE_ID'

export class TelegramMonitoringDeliveryError extends Error {
  constructor(readonly code: TelegramMonitoringDeliveryErrorCode) {
    super(code)
    this.name = 'TelegramMonitoringDeliveryError'
  }
}

export interface TelegramMonitoringOutput {
  /** Re-check context and the code-owned Telegram egress policy immediately before send. */
  guard(input: {
    binding: ResolvedWorkBinding
    html: string
    idempotencyKey: string
  }): Promise<void>
  sendMessage(input: {
    chatId: number
    html: string
    disableWebPagePreview: true
    idempotencyKey: string
  }): Promise<{ messageId: number }>
}

function exactTelegramChat(operatorId: string): number | null {
  const match = /^telegram:(-?[1-9][0-9]{0,15})$/.exec(operatorId)
  if (match === null) return null
  const chatId = Number(match[1])
  return Number.isSafeInteger(chatId) ? chatId : null
}

/** Concrete transport seam; constructing it performs no Telegram I/O. */
export function makeTelegramMonitoringDigestDeliveryPort(input: {
  allowedChatId: number
  output: TelegramMonitoringOutput
}): MonitoringDigestDeliveryPort {
  if (!Number.isSafeInteger(input.allowedChatId) || input.allowedChatId === 0) {
    throw new TelegramMonitoringDeliveryError('ROUTE_MISMATCH')
  }

  return {
    async deliver({ digest, idempotencyKey }) {
      const chatId = exactTelegramChat(digest.binding.operatorId)
      if (chatId === null || chatId !== input.allowedChatId) {
        throw new TelegramMonitoringDeliveryError('ROUTE_MISMATCH')
      }
      if (digest.items.length === 0) return null

      const view = renderMonitoringDigest(digest)
      await input.output.guard({ binding: digest.binding, html: view.html, idempotencyKey })
      const sent = await input.output.sendMessage({
        chatId,
        html: view.html,
        disableWebPagePreview: true,
        idempotencyKey,
      })
      if (!Number.isSafeInteger(sent.messageId) || sent.messageId <= 0) {
        throw new TelegramMonitoringDeliveryError('INVALID_MESSAGE_ID')
      }
      return `telegram:message:${sent.messageId}`
    },
  }
}

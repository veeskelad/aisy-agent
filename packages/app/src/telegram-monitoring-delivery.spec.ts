import type { MonitoringDigest } from '@aisy/core'
import { describe, expect, it } from 'vitest'
import {
  makeTelegramMonitoringDigestDeliveryPort,
  TelegramMonitoringDeliveryError,
  type TelegramMonitoringOutput,
} from './telegram-monitoring-delivery.js'

function digest(overrides: Partial<MonitoringDigest> = {}): MonitoringDigest {
  return {
    schemaVersion: 1,
    id: 'digest-1',
    binding: {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project',
    },
    windowStart: '2026-07-27T00:00:00.000Z',
    windowEnd: '2026-07-27T09:00:00.000Z',
    notBefore: '2026-07-27T09:00:00.000Z',
    expiresAt: '2026-07-27T12:00:00.000Z',
    createdAt: '2026-07-27T09:00:00.000Z',
    status: 'ready',
    items: [{
      evidenceId: 'evidence-1',
      sourceId: 'source-1',
      primaryUrl: 'https://example.com/evidence-1',
      title: 'Первичный материал',
      summary: 'Краткое описание',
      whyUseful: 'Причина включения',
      category: 'important',
      rawScore: 0.9,
      rankScore: 0.8,
    }],
    ...overrides,
  }
}

function output(overrides: Partial<TelegramMonitoringOutput> = {}) {
  const calls: string[] = []
  const value: TelegramMonitoringOutput = {
    guard: async ({ html, idempotencyKey }) => {
      expect(html).toContain('https://example.com/evidence-1')
      calls.push(`guard:${idempotencyKey}`)
    },
    sendMessage: async ({ chatId, idempotencyKey, disableWebPagePreview, html }) => {
      calls.push(`send:${chatId}:${idempotencyKey}:${disableWebPagePreview}`)
      expect(html).toContain('https://example.com/evidence-1')
      return { messageId: 77 }
    },
    ...overrides,
  }
  return { calls, value }
}

describe('Telegram monitoring digest delivery', () => {
  it('guards exact binding, sends bounded evidence HTML and returns a message receipt', async () => {
    const h = output()
    const delivery = makeTelegramMonitoringDigestDeliveryPort({ allowedChatId: 42, output: h.value })

    await expect(delivery.deliver({ digest: digest(), idempotencyKey: 'digest-1' }))
      .resolves.toBe('telegram:message:77')
    expect(h.calls).toEqual(['guard:digest-1', 'send:42:digest-1:true'])
  })

  it('rejects a foreign or malformed operator route before guard and send', async () => {
    for (const operatorId of ['telegram:43', 'telegram:42:extra', 'email:42']) {
      const h = output()
      const delivery = makeTelegramMonitoringDigestDeliveryPort({ allowedChatId: 42, output: h.value })
      await expect(delivery.deliver({
        digest: digest({ binding: { ...digest().binding, operatorId } }),
        idempotencyKey: 'digest-1',
      })).rejects.toThrowError(expect.objectContaining<Partial<TelegramMonitoringDeliveryError>>({
        code: 'ROUTE_MISMATCH',
      }))
      expect(h.calls).toEqual([])
    }
  })

  it('does not send an empty digest', async () => {
    const h = output()
    const delivery = makeTelegramMonitoringDigestDeliveryPort({ allowedChatId: 42, output: h.value })
    await expect(delivery.deliver({ digest: digest({ items: [] }), idempotencyKey: 'digest-empty' }))
      .resolves.toBeNull()
    expect(h.calls).toEqual([])
  })

  it('does not send when the code-owned guard fails', async () => {
    const h = output({ guard: async () => { h.calls.push('guard'); throw new Error('denied') } })
    const delivery = makeTelegramMonitoringDigestDeliveryPort({ allowedChatId: 42, output: h.value })
    await expect(delivery.deliver({ digest: digest(), idempotencyKey: 'digest-1' }))
      .rejects.toThrow('denied')
    expect(h.calls).toEqual(['guard'])
  })

  it('rejects an invalid Telegram message id instead of creating a receipt', async () => {
    const h = output({ sendMessage: async () => ({ messageId: 0 }) })
    const delivery = makeTelegramMonitoringDigestDeliveryPort({ allowedChatId: 42, output: h.value })
    await expect(delivery.deliver({ digest: digest(), idempotencyKey: 'digest-1' }))
      .rejects.toThrowError(expect.objectContaining<Partial<TelegramMonitoringDeliveryError>>({
        code: 'INVALID_MESSAGE_ID',
      }))
  })
})

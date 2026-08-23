import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'
import { makeTelegramBot } from './bot.js'
import type { TelegramMonitoringControls } from './telegram-monitoring-controls.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

function update(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
    },
  }
}

function callback(data: string, messageId = 9): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-1',
      chat_instance: 'instance',
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
      },
    },
  }
}

function harness(available: boolean, monitoringControls?: TelegramMonitoringControls) {
  const calls: Array<{ method: string; payload: unknown }> = []
  const gateway: Gateway = {
    onUpdate: async () => ({
      spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
      text: '', receivedAt: '2026-07-27T00:00:00.000Z',
    }),
    streamReply: async () => {},
    issueCard: async () => 'unused-card',
    getIssuedCard: () => null,
    handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
  }
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    monitoringStatus: () => ({
      available,
      configuredSources: available ? 2 : 0,
      activeSources: available ? 2 : 0,
      pausedSources: 0,
      quarantinedSources: 0,
      collectionActive: false,
      deliveryActive: false,
    }),
    ...(monitoringControls === undefined ? {} : { monitoringControls }),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, result: true } as never
  })
  return { bot, calls }
}

describe('Telegram monitoring status menu', () => {
  it('shows passive monitoring state instead of the spend report', async () => {
    const h = harness(true)
    await h.bot.handleUpdate(update('📡 Монитор'))
    const text = (h.calls.find((call) => call.method === 'sendMessage')?.payload as { text?: string }).text
    expect(text).toContain('Источников настроено: 2')
    expect(text).toContain('Сбор: выключен')
    expect(text).not.toContain('Расходы')
  })

  it('shows fail-closed unavailable state without a model turn', async () => {
    const h = harness(false)
    await h.bot.handleUpdate(update('📡 Монитор'))
    const text = (h.calls.find((call) => call.method === 'sendMessage')?.payload as { text?: string }).text
    expect(text).toContain('Локальное состояние недоступно')
  })

  it('binds a source screen to the exact callback principal and message', async () => {
    const open = vi.fn<TelegramMonitoringControls['open']>(() => ({
      text: '🔭 Источники · 0',
      buttons: [[{ text: '➕ RSS', data: 'monitoring:v1:token' }]],
    }))
    const controls: TelegramMonitoringControls = {
      open,
      handle: () => ({ kind: 'stale', text: 'stale' }),
      handleText: () => null,
      cancelForm: () => {},
    }
    const h = harness(true, controls)

    await h.bot.handleUpdate(update('📡 Монитор'))
    const markup = (h.calls.find((call) => call.method === 'sendMessage')?.payload as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    }).reply_markup
    expect(markup?.inline_keyboard?.flat().map((item) => item.callback_data))
      .toContain('monitoring:open')

    await h.bot.handleUpdate(callback('monitoring:open', 91))

    expect(open).toHaveBeenCalledWith({ principal: { chatId: 42, userId: 42 }, messageId: 91 })
    expect(h.calls.some((call) => call.method === 'editMessageText' &&
      (call.payload as { text?: string }).text === '🔭 Источники · 0')).toBe(true)
  })

  it('consumes a pending source form before the model turn', async () => {
    const handleText = vi.fn<TelegramMonitoringControls['handleText']>(() => ({
      kind: 'notice', text: 'Источник не добавлен.',
    }))
    const controls: TelegramMonitoringControls = {
      open: () => ({ text: '', buttons: [] }),
      handle: () => ({ kind: 'stale', text: 'stale' }),
      handleText,
      cancelForm: () => {},
    }
    const h = harness(true, controls)

    await h.bot.handleUpdate(update('https://example.com/feed'))

    expect(handleText).toHaveBeenCalledWith({
      text: 'https://example.com/feed', principal: { chatId: 42, userId: 42 },
    })
    expect(h.calls.some((call) => call.method === 'deleteMessage')).toBe(true)
    expect(h.calls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === 'Источник не добавлен.')).toBe(true)
  })
})

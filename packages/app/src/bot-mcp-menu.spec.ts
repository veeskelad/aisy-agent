import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it } from 'vitest'
import { makeTelegramBot } from './bot.js'

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

function harness(withEntry: boolean) {
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
    mcpMenu: () => withEntry
      ? [{ name: 'tracker.search', summary: 'Поиск задач', rw: 'read', tier: 0, active: false }]
      : [],
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, result: true } as never
  })
  return { bot, calls }
}

describe('Telegram MCP menu', () => {
  it('shows validated configured tools without claiming the transport is active', async () => {
    const h = harness(true)
    await h.bot.handleUpdate(update('🔌 MCP'))
    const text = (h.calls.find((call) => call.method === 'sendMessage')?.payload as { text?: string }).text
    expect(text).toContain('tracker.search · чтение · без спроса · не подключён')
    expect(text).toContain('но связь не поднята')
    expect(text).not.toContain('Раздел в разработке')
  })

  it('shows an explicit empty state', async () => {
    const h = harness(false)
    await h.bot.handleUpdate(update('🔌 MCP'))
    const text = (h.calls.find((call) => call.method === 'sendMessage')?.payload as { text?: string }).text
    expect(text).toContain('Серверы не настроены')
  })
})

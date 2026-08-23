// What a brand-new operator sees. Two things have to be true of the very first
// message: the menu is under it (telling someone the menu is "below" while
// nothing is below is worse than saying nothing), and the services card follows
// it instead of the agent listing keys in prose.

import type { Gateway } from '@aisy/core'
import type { UserFromGetMe } from 'grammy/types'
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

const gateway: Gateway = {
  onUpdate: async () => ({
    spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
    text: '', receivedAt: '2026-08-10T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function harness() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const made = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    serviceKeys: {
      connected: () => ['deepgram'],
      store: async () => ({ ok: true, envKey: 'X', verified: true }),
      storeCustom: () => ({ ok: true, envKey: 'X', verified: false }),
      describe: () => null,
    } as never,
  })
  made.bot.botInfo = BOT_INFO
  made.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: { message_id: calls.length } } as never
  })
  return { ...made, calls }
}

const sends = (calls: Array<{ method: string; payload: Record<string, unknown> }>) =>
  calls.filter((call) => call.method === 'sendMessage')

describe('first contact', () => {
  it('puts the menu under the first message the agent sends, and only that one', async () => {
    const h = harness()

    h.armMainMenu()
    await h.sendProactive('Привет, я Aisy.')
    await h.sendProactive('И второе сообщение.')

    const [greeting, second] = sends(h.calls)
    expect((greeting?.payload['reply_markup'] as { keyboard?: unknown[] }).keyboard)
      .toHaveLength(4)
    expect(second?.payload['reply_markup']).toBeUndefined()
  })

  it('does not attach a keyboard nobody asked for', async () => {
    const h = harness()

    await h.sendProactive('Обычный проактивный ход.')

    expect(sends(h.calls)[0]?.payload['reply_markup']).toBeUndefined()
  })

  it('offers the service catalogue as a card with buttons', async () => {
    const h = harness()

    await h.offerServiceKeys()

    const card = sends(h.calls)[0]!
    expect(card.payload['text']).toContain('Что подключим')
    const markup = card.payload['reply_markup'] as {
      inline_keyboard: Array<Array<{ text: string }>>
    }
    // Already-connected services are marked, not hidden — the operator sees
    // the whole shape of what this agent can reach. Отметка живёт на кнопке:
    // список сервисов существует один раз, а не текстом и клавиатурой сразу.
    expect(markup.inline_keyboard.flat().some((button) => button.text.includes('✅'))).toBe(true)
    expect(markup.inline_keyboard.length).toBeGreaterThan(1)
  })
})

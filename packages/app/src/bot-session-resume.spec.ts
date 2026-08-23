// 💬 Сессии used to be a text dump: the operator could read that yesterday's
// conversation existed and had no way back into it. These are the two seams that
// close it — the screen carries buttons, and a tap switches and restarts.

import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'
import { makeTelegramBot } from './bot.js'
import type { TelegramSessionControls, TelegramSessionView } from './telegram-session-controls.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

const CHAT = { id: 42, type: 'private' as const, first_name: 'Operator' }
const FROM = { id: 42, is_bot: false, first_name: 'Operator' }

const VIEW: TelegramSessionView = {
  text: 'Сессии текущего контекста:\n• Вчерашний разбор · #abc12345',
  projectId: 'project-a',
  generation: 3,
  sessions: [],
  buttons: [[{ text: '↩️ Вчерашний разбор', data: 'session:token-1' }]],
}

function textUpdate(text: string): Update {
  return { update_id: 1, message: { message_id: 1, date: 0, chat: CHAT, from: FROM, text } }
}

function tap(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1', from: FROM, chat_instance: 'ci-1', data,
      message: {
        message_id: 77, date: 0, chat: CHAT, text: 'список сессий',
        from: { id: 999, is_bot: true, first_name: 'Aisy' },
      },
    },
  }
}

function harness(input: {
  resume?: (sessionId: string) => Promise<{ ok: true } | { ok: false; errorCode: string }>
} = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const controls: TelegramSessionControls = {
    open: () => VIEW,
    handle: (data) => data === 'session:token-1'
      ? { kind: 'resume', sessionId: 'session-old', name: 'Вчерашний разбор' }
      : { kind: 'stale', view: VIEW },
    create: () => { throw new Error('not used') },
    rename: () => { throw new Error('not used') },
    handleAuthenticatedText: () => null,
  }
  const gateway: Gateway = {
    onUpdate: async () => ({
      spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
      text: '', receivedAt: '2026-08-07T00:00:00.000Z',
    }),
    streamReply: async () => {},
    issueCard: async () => 'unused-card',
    getIssuedCard: () => null,
    handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
  }
  const prepared: string[] = []
  const restartRuntime = {
    prepare: (reason: string) => {
      prepared.push(reason)
      return { requestedAt: '2026-08-07T00:00:00.000Z', reason, activeTurns: 0 }
    },
    commitExit: vi.fn(),
    cancel: () => 'cancelled' as const,
  }
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    registerCommands: false,
    debounceMs: 1,
    sessionControls: controls,
    ...(input.resume === undefined ? {} : { resumeSession: input.resume }),
    restartRuntime,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return { bot, calls, prepared, restartRuntime }
}

describe('sessions screen', () => {
  it('sends the list with buttons instead of a flat text', async () => {
    const h = harness()

    await h.bot.handleUpdate(textUpdate('💬 Сессии'))

    const sent = h.calls.find((call) => call.method === 'sendMessage')!
    expect(String(sent.payload['text'])).toContain('Вчерашний разбор')
    expect(JSON.stringify(sent.payload['reply_markup'])).toContain('session:token-1')
  })

  it('switches and restarts into the session that was tapped', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-1'))

    expect(resume).toHaveBeenCalledWith('session-old')
    expect(h.prepared).toEqual(['возврат в сессию'])
  })

  it('says so instead of restarting when the switch is refused', async () => {
    const resume = vi.fn(async () => ({ ok: false as const, errorCode: 'ALREADY_ACTIVE' }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-1'))

    expect(h.prepared).toEqual([])
    expect(h.calls.map((call) => String(call.payload['text'] ?? '')).join('\n'))
      .toContain('Это и есть текущая сессия')
  })

  it('refuses a stale token without touching the runtime', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-gone'))

    expect(resume).not.toHaveBeenCalled()
    expect(h.prepared).toEqual([])
    expect(h.calls.some((call) => call.method === 'editMessageText')).toBe(true)
  })
})

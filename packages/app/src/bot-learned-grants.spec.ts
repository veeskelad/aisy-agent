// Экран «🗝 Разрешения» и выученная автономия (спека 24, AC-24-13).
//
// Выученное и ручное разрешают одно и то же и снимаются одинаково — различаются
// они только тем, как появились. Поэтому оператор видит их рядом, на одном
// экране, а не ищет автономию в отдельном месте.

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

const KEY = 'a'.repeat(32)

function callback(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-1',
      chat_instance: 'instance',
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: 9, date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
      },
    },
  }
}

const gateway: Gateway = {
  onUpdate: async () => ({
    spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
    text: '', receivedAt: '2026-08-15T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function harness(withLearned: boolean) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const revoked: string[] = []
  let learned = [{
    workflowKey: KEY,
    title: 'читаю страницу docs.example.com',
    version: 1,
    expires: '2026-11-13',
    demonstrations: 7,
  }]
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    grants: { list: () => [], revokeAll: () => {} },
    ...(withLearned ? {
      learnedGrants: {
        list: () => learned,
        revoke: (workflowKey: string) => {
          revoked.push(workflowKey)
          learned = learned.filter((grant) => grant.workflowKey !== workflowKey)
        },
      },
    } : {}),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return { bot, calls, revoked }
}

const screens = (calls: Array<{ method: string; payload: Record<string, unknown> }>): string =>
  calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => String(call.payload['text'] ?? ''))
    .join('\n')

const buttons = (calls: Array<{ method: string; payload: Record<string, unknown> }>): string[] =>
  calls.flatMap((call) => {
    const markup = call.payload['reply_markup'] as
      { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> } | undefined
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '')
  })

describe('выученные разрешения на экране (AC-24-13)', () => {
  it('показывает выученное рядом с ручным и даёт снять поштучно', async () => {
    const h = harness(true)
    await h.bot.handleUpdate(callback('cfg:open:grants'))

    expect(screens(h.calls)).toContain('читаю страницу docs.example.com')
    expect(screens(h.calls)).toContain('показал 7 раз')
    // Адресный отзыв идёт первым: сбросить всё — тупой инструмент, а неделя
    // демонстраций стоит дороже одного лишнего тапа.
    expect(buttons(h.calls)).toContain(`cfg:unlearn:${KEY}`)
  })

  it('снимает выученное по кнопке и сразу перерисовывает экран', async () => {
    const h = harness(true)
    await h.bot.handleUpdate(callback(`cfg:unlearn:${KEY}`))

    expect(h.revoked).toEqual([KEY])
    // Перерисовка вместо уведомления: оператор видит, что автономии больше нет,
    // а не читает обещание, что её сняли.
    expect(screens(h.calls)).not.toContain('docs.example.com')
  })

  it('без обучения экран остаётся прежним и не обещает автономии', async () => {
    const h = harness(false)
    await h.bot.handleUpdate(callback('cfg:open:grants'))

    expect(screens(h.calls)).toContain('Разрешения')
    expect(screens(h.calls)).not.toContain('Выученное')
    expect(buttons(h.calls).some((data) => data.startsWith('cfg:unlearn:'))).toBe(false)
  })

  it('чужой ключ отзыва не проходит кодек', async () => {
    const h = harness(true)
    await h.bot.handleUpdate(callback('cfg:unlearn:не-ключ'))

    expect(h.revoked).toEqual([])
  })
})

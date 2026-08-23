import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'

import { makeTelegramBot } from './bot.js'
import type {
  ProviderLifecycleBinding,
  ProviderLifecycleControlPort,
} from './provider-lifecycle-control.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

const BINDING: ProviderLifecycleBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  providerId: 'openai',
}

let nextUpdateId = 1

function update(text: string): Update {
  const commandLength = text.split(' ', 1)[0]!.length
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: 1, date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
    },
  }
}

function callback(data: string, messageId = 9): Update {
  return {
    update_id: 99,
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

function harness(input: {
  begin?: ProviderLifecycleControlPort['begin']
  inspect?: ProviderLifecycleControlPort['inspect']
  revoke?: ProviderLifecycleControlPort['revoke']
  nowMs?: () => number
  token?: () => string
} = {}) {
  const calls: Array<{ method: string; payload: unknown }> = []
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
  const begin = input.begin ?? (async () => ({
    code: 'provider_code_abcdefghijklmnopqrstuvwx',
    expiresAt: '2026-08-15T00:05:00.000Z',
  }))
  const inspect = input.inspect ?? (async () => ({ state: 'unconfigured' as const }))
  const revoke = input.revoke ?? (async () => ({ state: 'unconfigured' as const }))
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    providerCredentials: { bindings: [BINDING], begin, inspect, revoke },
    providerCredentialNowMs: input.nowMs ?? (() => 1_000),
    newProviderCredentialToken: input.token ?? (() => 't'.repeat(24)),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: 9,
          date: 0,
          chat: { id: 42, type: 'private', first_name: 'Operator' },
          text: (payload as { text?: string }).text ?? '',
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return { bot, calls, begin, inspect, revoke }
}

describe('Telegram provider lifecycle controls', () => {
  it('projects only status and a one-use local TTY command', async () => {
    const begin = vi.fn<ProviderLifecycleControlPort['begin']>(async () => ({
      code: 'provider_code_abcdefghijklmnopqrstuvwx',
      expiresAt: '2026-08-15T00:05:00.000Z',
    }))
    const inspect = vi.fn<ProviderLifecycleControlPort['inspect']>(async () => ({
      state: 'ready', handle: 'a'.repeat(64), revision: 3,
    }))
    const h = harness({ begin, inspect })

    await h.bot.handleUpdate(update('/provider'))
    await h.bot.handleUpdate(update('/provider connect openai'))

    const messages = h.calls.filter(call => call.method === 'sendMessage')
      .map(call => (call.payload as { text?: string }).text ?? '')
    expect(messages[0]).toContain('openai — готов · версия 3')
    expect(messages[0]).not.toContain('a'.repeat(64))
    expect(messages[1]).toContain('aisy provider credential set --code=provider_code_')
    expect(messages[1]).toContain('Сам ключ в Telegram не отправляйте')
    expect(begin).toHaveBeenCalledWith(BINDING)
    expect(inspect).toHaveBeenCalledWith(BINDING)
  })

  it('binds revoke to the exact chat, user, message, provider and one-use approval', async () => {
    const revoke = vi.fn<ProviderLifecycleControlPort['revoke']>(async () => ({ state: 'unconfigured' }))
    const h = harness({ revoke })

    await h.bot.handleUpdate(update('/provider revoke openai'))
    const confirmation = h.calls.find(call => call.method === 'sendMessage')?.payload as {
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    }
    const data = confirmation.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data
    expect(data).toBe(`provider:revoke:openai:${'t'.repeat(24)}`)

    await h.bot.handleUpdate(callback(data!))
    await h.bot.handleUpdate(callback(data!))

    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith(BINDING, 't'.repeat(24))
    expect(h.calls.some(call => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text?.includes('Ключ openai отозван'))).toBe(true)
  })

  it('rejects provider ids and positional material before root control', async () => {
    const begin = vi.fn<ProviderLifecycleControlPort['begin']>()
    const h = harness({ begin })

    await h.bot.handleUpdate(update('/provider connect custom'))
    await h.bot.handleUpdate(update('/provider connect openai raw-material'))

    expect(begin).not.toHaveBeenCalled()
    const text = h.calls.filter(call => call.method === 'sendMessage')
      .map(call => (call.payload as { text?: string }).text ?? '').join('\n')
    expect(text).toContain('Доступны только: openai')
    expect(text).toContain('Команда не распознана и удалена')
    expect(h.calls.some(call => call.method === 'deleteMessage')).toBe(true)
  })
})

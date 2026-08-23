import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'

import { makeTelegramBot } from './bot.js'
import type { VoiceCredentialBinding } from './voice-credential-control.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

const BINDING: VoiceCredentialBinding = Object.freeze({
  installationHash: 'a'.repeat(64),
  operatorId: 'telegram:42',
  profileId: 'default',
  providerId: 'deepgram-cloud',
})

const gateway: Gateway = {
  onUpdate: async () => ({
    spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
    text: '', receivedAt: '2026-08-14T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function command(text: string, userId = 42): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: userId, is_bot: false, first_name: 'Operator' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  }
}

function callback(data: string, messageId: number, userId = 42): Update {
  return {
    update_id: 2,
    callback_query: {
      id: `callback-${userId}-${messageId}`,
      chat_instance: 'private-chat',
      from: { id: userId, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: messageId, date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        text: 'approval',
      },
    },
  }
}

function harness() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const begin = vi.fn(async () => ({ code: 'B'.repeat(32), expiresAt: '2026-08-14T12:05:00.000Z' }))
  const inspect = vi.fn(async () => ({ state: 'ready' as const, handle: 'H'.repeat(24), revision: 7 }))
  const revoke = vi.fn(async () => ({ state: 'revoked' as const, revision: 8 }))
  const select = vi.fn(() => ({
    id: 'deepgram-cloud', label: 'Deepgram Nova-3', audioLeavesHost: true,
    privacyDisclosure: 'Аудио отправляется Deepgram через основной API.',
  }))
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    registerCommands: false,
    transcription: {
      list: () => [{
        id: 'deepgram-cloud', label: 'Deepgram Nova-3', audioLeavesHost: true,
        privacyDisclosure: 'Аудио отправляется Deepgram через основной API.', selected: false,
      }],
      select,
      selected: () => null,
    },
    voiceCredentials: { binding: BINDING, begin, inspect, revoke },
    voiceCredentialNowMs: () => 1_786_700_000_000,
    newVoiceCredentialToken: () => 'A'.repeat(16),
  })
  bot.botInfo = BOT_INFO
  let messageId = 100
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: ++messageId, date: 0,
          chat: { id: 42, type: 'private' },
          text: String((payload as { text?: unknown }).text ?? ''),
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  const replies = (): string => calls
    .filter(call => call.method === 'sendMessage')
    .map(call => String(call.payload['text'] ?? ''))
    .join('\n')
  return { bot, calls, replies, begin, inspect, revoke, select }
}

describe('/voice credential control (ADR-0098)', () => {
  it('shows credential readiness separately from cloud-audio consent', async () => {
    const h = harness()
    await h.bot.handleUpdate(command('/voice'))

    expect(h.inspect).toHaveBeenCalledWith(BINDING)
    expect(h.replies()).toContain('ключ: готов · версия 7')
    expect(h.replies()).toContain('Согласие: не выбрано')
  })

  it('issues a one-use local command without asking for a key in Telegram', async () => {
    const h = harness()
    await h.bot.handleUpdate(command('/voice connect deepgram-cloud'))

    expect(h.begin).toHaveBeenCalledWith(BINDING)
    expect(h.replies()).toContain(`aisy voice credential set --code=${'B'.repeat(32)}`)
    expect(h.replies()).toContain('Сам ключ в Telegram не отправляйте')
  })

  it('keeps provider selection as a separate explicit consent operation', async () => {
    const h = harness()
    await h.bot.handleUpdate(command('/voice deepgram-cloud'))

    expect(h.select).toHaveBeenCalledWith('deepgram-cloud')
    expect(h.begin).not.toHaveBeenCalled()
  })

  it('spends an exact revoke card once and rejects replay', async () => {
    const h = harness()
    await h.bot.handleUpdate(command('/voice revoke deepgram-cloud'))
    await h.bot.handleUpdate(callback(`voice:revoke:${'A'.repeat(16)}`, 101))
    await h.bot.handleUpdate(callback(`voice:revoke:${'A'.repeat(16)}`, 101))

    expect(h.revoke).toHaveBeenCalledTimes(1)
    expect(h.revoke).toHaveBeenCalledWith(BINDING)
    expect(h.replies()).toContain('Ключ Deepgram отозван (версия 8)')
  })

  it('rejects a revoke tap from another principal', async () => {
    const h = harness()
    await h.bot.handleUpdate(command('/voice revoke deepgram-cloud'))
    await h.bot.handleUpdate(callback(`voice:revoke:${'A'.repeat(16)}`, 101, 7))

    expect(h.revoke).not.toHaveBeenCalled()
  })
})

// The two seams the skills folder needs from the transport: the 🧩 button opens
// a screen with real buttons, and a SKILL.md sent to the chat installs.

import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTelegramBot } from './bot.js'
import { makeTelegramSkillControls } from './telegram-skill-controls.js'
import type { SkillFolderPort, SkillInstallResult } from './active-skill-store.js'

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

function textUpdate(text: string): Update {
  return { update_id: 1, message: { message_id: 1, date: 0, chat: CHAT, from: FROM, text } }
}

function documentUpdate(fileName: string, sizeBytes = 120): Update {
  return {
    update_id: 2,
    message: {
      message_id: 2, date: 0, chat: CHAT, from: FROM,
      document: {
        file_id: 'file-1', file_unique_id: 'unique-1', file_name: fileName, file_size: sizeBytes,
      },
    },
  }
}

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function harness(installed: SkillInstallResult = {
  ok: true, name: 'inspect', version: 1, previousVersion: null, versionRaised: false,
}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const received: string[] = []
  const folder: SkillFolderPort = {
    list: () => [{
      name: 'inspect', version: 1, description: 'Проверить артефакты',
      enabled: true, trustSource: 'user', problem: null,
    }],
    setEnabled: () => true,
    remove: () => true,
    install: (text) => { received.push(text); return installed },
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
  const { bot } = makeTelegramBot({
    token: '1234:test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    skillControls: makeTelegramSkillControls({
      folder,
      newTokenId: (() => { let n = 0; return () => `token-${++n}` })(),
    }),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'getFile') {
      return { ok: true, result: { file_id: 'file-1', file_path: 'documents/file_1.md' } } as never
    }
    return { ok: true, result: true } as never
  })
  return { bot, calls, received }
}

describe('skills folder in Telegram', () => {
  it('opens a screen with buttons instead of a flat list', async () => {
    const h = harness()

    await h.bot.handleUpdate(textUpdate('🧩 Навыки'))

    const sent = h.calls.find((call) => call.method === 'sendMessage')!
    expect(sent.payload['text']).toContain('🧩 Навыки · 1')
    expect(JSON.stringify(sent.payload['reply_markup'])).toContain('inspect')
  })

  it('opens the card in place when a skill button is tapped', async () => {
    const h = harness()
    await h.bot.handleUpdate(textUpdate('🧩 Навыки'))
    const markup = h.calls.find((call) => call.method === 'sendMessage')!.payload['reply_markup']
    const data = (markup as { inline_keyboard: { text: string; callback_data: string }[][] })
      .inline_keyboard.flat().find((button) => button.text.includes('inspect'))!.callback_data

    await h.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-1', from: FROM, chat_instance: 'ci-1', data,
        message: {
          message_id: 7, date: 0, chat: CHAT, text: 'старая карточка',
          from: { id: 999, is_bot: true, first_name: 'Aisy' },
        },
      },
    })

    const edited = h.calls.find((call) => call.method === 'editMessageText')!
    expect(String(edited.payload['text'])).toContain('🧩 inspect')
    expect(String(edited.payload['text'])).toContain('Проверить артефакты')
  })

  it('installs a SKILL.md sent to the chat', async () => {
    const h = harness()
    const body = '---\nname: inspect\n---\n## verification\nok'
    globalThis.fetch = vi.fn(async () => new Response(body)) as unknown as typeof fetch

    await h.bot.handleUpdate(documentUpdate('SKILL.md'))

    expect(h.received).toEqual([body])
    const url = String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])
    expect(url).toBe('https://api.telegram.org/file/bot1234:test-token/documents/file_1.md')
    const sent = h.calls.filter((call) => call.method === 'sendMessage')
    expect(String(sent.at(-1)?.payload['text'])).toContain('Навык «inspect» установлен')
  })

  it('leaves any other document to the normal attachment path', async () => {
    const h = harness()
    globalThis.fetch = vi.fn(async () => new Response('x')) as unknown as typeof fetch

    await h.bot.handleUpdate(documentUpdate('notes.md'))

    expect(h.received).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('refuses an oversized file before downloading it', async () => {
    const h = harness()
    globalThis.fetch = vi.fn(async () => new Response('x')) as unknown as typeof fetch

    await h.bot.handleUpdate(documentUpdate('SKILL.md', 400 * 1024))

    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(h.received).toEqual([])
    const sent = h.calls.filter((call) => call.method === 'sendMessage')
    expect(String(sent.at(-1)?.payload['text'])).toContain('больше 256 КБ')
  })

  it('says why a bad file was refused', async () => {
    const h = harness({ ok: false, errorCode: 'NO_VERIFICATION' })
    globalThis.fetch = vi.fn(async () => new Response('nope')) as unknown as typeof fetch

    await h.bot.handleUpdate(documentUpdate('SKILL.md'))

    const sent = h.calls.filter((call) => call.method === 'sendMessage')
    expect(String(sent.at(-1)?.payload['text'])).toContain('## Verification')
  })
})

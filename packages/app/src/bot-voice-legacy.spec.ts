// Voice on the legacy turn path.
//
// The branch used to demand `acquireBackgroundRuntime`, which only the v2 turn
// runtime provides — so on the composition that actually ships, every voice
// message was answered with "недоступен".

import type { AgentRunner, Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'
import { makeTelegramBot } from './bot.js'
import type { TelegramVoiceIngress } from './telegram-voice-ingress.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

const BINDING = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'project' as const,
})

function voiceUpdate(): Update {
  return {
    update_id: 20,
    message: {
      message_id: 20, date: 1_785_000_000,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      voice: { file_id: 'voice-file', file_unique_id: 'voice-1', duration: 3 },
    },
  } as Update
}

function harness(options: {
  selectedProvider?: { id: string } | null
  ingress?: TelegramVoiceIngress
  failure?: Error
  methodFailures?: Record<string, number>
} = {}) {
  const sent: string[] = []
  const seen: string[] = []
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const runner: AgentRunner = {
    async handle(input) {
      seen.push(...input.spans.map((span) => span.text))
      if (options.failure !== undefined) {
        await input.onProgress?.({ type: 'turn-started' })
        throw options.failure
      }
      return { state: 'ok', reply: 'услышал', narrowed: false }
    },
  }
  const gateway: Gateway = {
    onUpdate: async () => ({
      spanId: 'span-1', chatId: 42, channel: 'voice', provenance: 'operator',
      text: '', receivedAt: '2026-08-07T00:00:00.000Z',
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
    // Legacy composition: no v2 turn runtime, so no background runtime either.
    buildRunner: () => runner,
    model: 'test-model',
    registerCommands: false,
    debounceMs: 1,
    captureWorkBinding: async () => ({ ...BINDING }),
    voiceIngress: options.ingress ?? {
      handle: vi.fn(async () => ({
        kind: 'transcribed' as const,
        binding: { ...BINDING },
        span: {
          provenance: 'untrusted' as const,
          channel: 'voice' as const,
          text: 'напомни про встречу',
          receivedAt: '2026-08-07T00:00:01.000Z',
          sourceRef: 'telegram:update:20:message:20:voice:test',
        },
      })),
    },
    transcription: {
      list: () => [],
      select: () => ({ id: 'deepgram-cloud', label: 'Deepgram', audioLeavesHost: true }),
      selected: () => options.selectedProvider === undefined
        ? { id: 'deepgram-cloud' }
        : options.selectedProvider,
    },
  })
  bot.botInfo = BOT_INFO
  let messageId = 100
  bot.api.config.use(async (_previous, method, payload) => {
    const failures = options.methodFailures?.[method] ?? 0
    if (failures > 0) {
      options.methodFailures![method] = failures - 1
      throw new Error(`${method} unavailable`)
    }
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'sendMessage') {
      sent.push(String((payload as { text?: unknown }).text ?? ''))
      return {
        ok: true,
        result: {
          message_id: ++messageId, date: 0, chat: { id: 42, type: 'private' },
          text: sent.at(-1) ?? '',
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return { bot, sent, seen, calls }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('voice without the v2 turn runtime', () => {
  it('runs the transcript through the legacy runner', async () => {
    const h = harness()

    await h.bot.handleUpdate(voiceUpdate())
    await settle()

    expect(h.sent.join('\n')).not.toContain('Голос пока недоступен')
    expect(h.seen).toContain('напомни про встречу')
  })

  it('says what to configure when no provider is chosen yet', async () => {
    const h = harness({ selectedProvider: null })

    await h.bot.handleUpdate(voiceUpdate())
    await settle()

    // Refusing with "не удалось обработать" would send the operator looking for
    // a bug instead of into the settings screen.
    expect(h.seen).toEqual([])
    expect(h.sent.join('\n')).toContain('Расшифровка ещё не выбрана')
  })

  it('corrects a failed voice turn even when its running card cannot be edited or deleted', async () => {
    const h = harness({
      failure: new Error('private provider detail'),
      methodFailures: { editMessageText: 2, deleteMessage: 1 },
    })

    await h.bot.handleUpdate(voiceUpdate())
    await settle()

    expect(h.sent).toEqual([
      'Работаю…',
      'Не получилось ответить. Попробовать ещё раз?',
    ])
    expect(JSON.stringify(h.calls)).not.toContain('private provider detail')
    expect(JSON.stringify(h.calls)).not.toContain('error:retry')
  })
})

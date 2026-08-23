import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it } from 'vitest'
import { makeTelegramBot } from './bot.js'
import { makeExecutionModeStore } from './execution-mode.js'
import { makeTranscriptionRegistry } from './transcription-registry.js'
import { makeBotRegistry } from './bot-registry-store.js'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  }
}

const gateway: Gateway = {
  onUpdate: async () => ({
    spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
    text: '', receivedAt: '2026-07-29T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function harness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-bot-mode-')))
  const executionMode = makeExecutionModeStore({ path: join(dir, 'execution-mode.json') })
  const registry = makeBotRegistry({ path: join(dir, 'bots.json') })
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    executionMode,
    bots: {
      list: () => registry.list(true),
      activeId: () => registry.primary()?.id ?? null,
      add: (input) => registry.add(input),
      archive: (botId) => registry.archive(botId),
    },
    transcription: makeTranscriptionRegistry({
      path: join(dir, 'transcription.json'),
      providers: [
        {
          id: 'whisper-local',
          label: 'Whisper в контейнере',
          audioLeavesHost: false,
          transcribe: async () => ({ text: '', provenance: 'untrusted', channel: 'voice' }),
        },
        {
          id: 'cloud-stt',
          label: 'Облачный сервис',
          audioLeavesHost: true,
          privacyDisclosure: 'Аудио отправляется Deepgram.',
          privacyRevision: 'deepgram-v1',
          transcribe: async () => ({ text: '', provenance: 'untrusted', channel: 'voice' }),
        },
      ],
    }),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return {
    bot,
    calls,
    executionMode,
    registry,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const replies = (calls: Array<{ payload: Record<string, unknown> }>): string =>
  calls.map((call) => String(call.payload['text'] ?? '')).join('\n')

describe('/mode command (ADR-0083)', () => {
  it('reports the current mode and how to change it', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/mode'))
      expect(replies(h.calls)).toContain('Режим: без спроса')
      expect(replies(h.calls)).toContain('/mode auto | confirm | plan | bypass')
      // С телефона команду никто не набирает — путь кнопками должен быть назван.
      expect(replies(h.calls)).toContain('🎛 Режим работы')
    } finally {
      h.cleanup()
    }
  })

  it('switches the mode and confirms what changed', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/mode confirm'))

      expect(h.executionMode.get()).toBe('confirm')
      expect(replies(h.calls)).toContain('Режим: с подтверждением')
    } finally {
      h.cleanup()
    }
  })

  it('shows an unmistakable warning when the unrestricted mode is enabled', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/mode bypass'))

      expect(h.executionMode.get()).toBe('bypass')
      expect(replies(h.calls)).toContain('🚨')
      expect(replies(h.calls)).toContain('без ограничений')
      // Режим не выключается сам — это должно быть сказано прямо.
      expect(replies(h.calls)).toContain('пока сам не выключишь')
    } finally {
      h.cleanup()
    }
  })

  it('refuses a mode it does not know instead of picking one', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/mode yolo'))

      expect(h.executionMode.get()).toBe('auto')
      expect(replies(h.calls)).toContain('Пиши так:')
    } finally {
      h.cleanup()
    }
  })
})

describe('/voice command (ADR-0085)', () => {
  it('says of each provider whether audio leaves the host', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/voice'))
      const text = replies(h.calls)

      expect(text).toContain('аудио остаётся на сервере')
      expect(text).toContain('Аудио отправляется Deepgram')
      expect(text).toContain('▶ whisper-local')
    } finally {
      h.cleanup()
    }
  })

  it('spells out the consequence when a cloud provider is chosen', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/voice cloud-stt'))

      expect(replies(h.calls)).toContain('Аудио отправляется Deepgram')
    } finally {
      h.cleanup()
    }
  })

  it('refuses a provider that does not exist', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/voice nope'))

      expect(replies(h.calls)).toContain('Такого провайдера нет')
    } finally {
      h.cleanup()
    }
  })
})

describe('/bots command (ADR-0076)', () => {
  it('explains the empty installation instead of showing a blank list', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/bots'))
      expect(replies(h.calls)).toContain('единственный')
    } finally {
      h.cleanup()
    }
  })

  it('adds a bot by naming the env variable, never the token', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/bots add Копирайтер AISY_COPY_TOKEN 4242 тексты'))

      const text = replies(h.calls)
      expect(text).toContain('AISY_COPY_TOKEN')
      expect(text).toContain('сам токен реестр не хранит')
      expect(h.registry.list().map((record) => record.name)).toEqual(['Копирайтер'])
    } finally {
      h.cleanup()
    }
  })

  it('shows which bot this process serves and where its token comes from', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/bots add Основной AISY_TELEGRAM_BOT_TOKEN 42'))
      h.calls.length = 0
      await h.bot.handleUpdate(update('/bots'))

      const text = replies(h.calls)
      expect(text).toContain('▶')
      expect(text).toContain('токен из AISY_TELEGRAM_BOT_TOKEN')
    } finally {
      h.cleanup()
    }
  })

  it('archives without touching memory, and says so', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/bots add Второй AISY_SECOND_TOKEN 77'))
      const id = h.registry.list()[0]!.id
      h.calls.length = 0

      await h.bot.handleUpdate(update(`/bots archive ${id}`))

      expect(replies(h.calls)).toContain('Память и журнал остались на месте')
      expect(h.registry.list(true)[0]?.archivedAt).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('refuses an incomplete add rather than inventing a chat id', async () => {
    const h = harness()
    try {
      await h.bot.handleUpdate(update('/bots add Только-имя'))

      // The same refusal the ➕ button's form gives, since both go through it.
      expect(replies(h.calls)).toContain('четыре слова')
      expect(h.registry.list()).toEqual([])
    } finally {
      h.cleanup()
    }
  })
})

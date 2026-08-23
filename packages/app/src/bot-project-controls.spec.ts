import { describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import type { Gateway } from '@aisy/core'
import { makeTelegramBot } from './bot.js'
import type {
  TelegramProjectControlOutcome,
  TelegramProjectControls,
  TelegramProjectView,
} from './telegram-project-controls.js'

const BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Aisy',
  username: 'aisy_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}

const VIEW: TelegramProjectView = {
  text: 'Где я работаю · поколение 3',
  buttons: [[
    { text: '🏠 Workspace', data: 'project:workspace' },
    { text: '✅ Project A', data: 'project:active' },
  ]],
}

function textUpdate(updateId: number, chatId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private', first_name: 'Operator' },
      from: { id: chatId, is_bot: false, first_name: 'Operator' },
      text,
    },
  }
}

function callbackUpdate(updateId: number, chatId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: 'test',
      from: { id: chatId, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: chatId, type: 'private', first_name: 'Operator' },
        text: VIEW.text,
      },
    },
  }
}

function harness(
  handle: (data: string) => Promise<TelegramProjectControlOutcome>,
  handleText: (input: {
    text: string
    chatId: number
    updateId: number
  }) => Promise<TelegramProjectControlOutcome | null> = async () => null,
) {
  const opened: number[] = []
  const handled: string[] = []
  const authenticatedTexts: string[] = []
  const projectControls: TelegramProjectControls = {
    open: async () => {
      opened.push(1)
      return VIEW
    },
    handle: async (data) => {
      handled.push(data)
      return handle(data)
    },
    handleAuthenticatedText: async (input) => {
      authenticatedTexts.push(input.text)
      return handleText(input)
    },
  }
  const calls: Array<{ method: string; payload: unknown }> = []
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway: {
      onUpdate: async (update) => ({
        text: String((update.message as { text?: unknown } | undefined)?.text ?? ''),
        provenance: 'operator',
      }),
    } as Gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    projectControls,
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, result: true } as never
  })
  return { bot, calls, opened, handled, authenticatedTexts }
}

describe('Telegram project controls transport', () => {
  it('renders the project picker and routes an opaque callback to the verified adapter', async () => {
    const h = harness(async () => ({
      kind: 'switched',
      text: '✅ Контекст: Workspace',
      selection: {
        operatorId: 'telegram:42',
        profileId: 'default',
        projectId: 'workspace',
        sessionId: 'workspace-session',
        generation: 4,
      },
    }))

    await h.bot.handleUpdate(textUpdate(1, 42, '📁 Проекты'))
    expect(h.opened).toEqual([1])
    expect(h.calls.find((call) => call.method === 'sendMessage')?.payload).toMatchObject({
      chat_id: 42,
      text: VIEW.text,
      reply_markup: {
        inline_keyboard: [[
          { text: '🏠 Workspace', callback_data: 'project:workspace' },
          { text: '✅ Project A', callback_data: 'project:active' },
        ]],
      },
    })

    await h.bot.handleUpdate(callbackUpdate(2, 42, 'project:workspace'))
    expect(h.handled).toEqual(['project:workspace'])
    expect(h.calls.some((call) => call.method === 'editMessageText' &&
      (call.payload as { text?: string }).text === '✅ Контекст: Workspace')).toBe(true)
  })

  it('re-renders a stale card with a toast and keeps unavailable actions code-owned', async () => {
    const h = harness(async (data) => data === 'project:stale'
      ? { kind: 'stale', view: VIEW }
      : { kind: 'unavailable', text: 'Действие ещё не подключено.' })

    await h.bot.handleUpdate(callbackUpdate(1, 42, 'project:stale'))
    expect(h.calls.some((call) => call.method === 'editMessageText')).toBe(true)
    expect(h.calls.some((call) => call.method === 'answerCallbackQuery' &&
      (call.payload as { text?: string }).text === 'Экран устарел — открой раздел заново.')).toBe(true)

    await h.bot.handleUpdate(callbackUpdate(2, 42, 'project:future'))
    expect(h.calls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === 'Действие ещё не подключено.')).toBe(true)
  })

  it('drops a callback from a foreign chat before adapter or Telegram API mutation', async () => {
    const h = harness(async () => ({ kind: 'stale', view: VIEW }))
    const callsBefore = h.calls.length

    await h.bot.handleUpdate(callbackUpdate(1, 777, 'project:workspace'))

    expect(h.handled).toEqual([])
    expect(h.calls).toHaveLength(callsBefore)
  })

  it('authenticates natural-language selection before routing it outside the model turn', async () => {
    const h = harness(
      async () => ({ kind: 'stale', view: VIEW }),
      async () => ({
        kind: 'switched',
        text: '✅ Контекст: Project A',
        selection: {
          operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
          sessionId: 'session-a', generation: 4,
        },
      }),
    )

    await h.bot.handleUpdate(textUpdate(1, 42, 'switch to Project A'))

    expect(h.authenticatedTexts).toEqual(['switch to Project A'])
    expect(h.calls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === '✅ Контекст: Project A')).toBe(true)
  })
})

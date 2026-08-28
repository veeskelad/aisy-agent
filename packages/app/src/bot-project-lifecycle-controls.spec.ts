import { describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import type { Gateway } from '@aisy/core'

import { makeTelegramBot } from './bot.js'
import type {
  TelegramProjectLifecycleControls,
  TelegramProjectLifecycleOutcome,
} from './telegram-project-lifecycle-controls.js'
import type { TelegramProjectControls } from './telegram-project-controls.js'
import type { TelegramSessionControls } from './telegram-session-controls.js'

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

const CALLBACK = 'project-lifecycle:v1:confirm:epoch123.token_123456789012345'

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

function callbackUpdate(updateId: number, chatId: number, data = CALLBACK): Update {
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
        text: 'Подтвердить архивацию?',
      },
    },
  }
}

function confirmation(): TelegramProjectLifecycleOutcome {
  return {
    kind: 'confirmation',
    view: {
      text: 'Архивировать проект «Alpha»?',
      buttons: [[
        { text: '✅ Архивировать', data: CALLBACK },
        { text: 'Отмена', data: CALLBACK.replace(':confirm:', ':cancel:') },
      ]],
    },
    action: 'project.archive',
    projectId: 'project-a',
    expiresAt: '2026-07-28T12:02:00.000Z',
  }
}

function controls(input: {
  text?: TelegramProjectLifecycleControls['handleAuthenticatedText']
  callback?: TelegramProjectLifecycleControls['handleAuthenticatedCallback']
}): TelegramProjectLifecycleControls {
  return {
    handleAuthenticatedText: input.text ?? (async () => null),
    handleAuthenticatedCallback: input.callback ?? (async () => ({
      kind: 'stale',
      text: 'Подтверждение устарело. Повтори команду.',
    })),
  }
}

function harness(input: {
  lifecycle?: TelegramProjectLifecycleControls
  projectControls?: TelegramProjectControls
  sessionControls?: TelegramSessionControls
  failEdit?: boolean
}) {
  const apiCalls: Array<{ method: string; payload: unknown }> = []
  const gatewayUpdates: Update[] = []
  let modelCalls = 0
  let runtimeAcquisitions = 0
  const gateway = {
    onUpdate: async (update: Update) => {
      gatewayUpdates.push(update)
      return {
        text: String(update.message?.text ?? ''),
        provenance: 'operator' as const,
      }
    },
    streamReply: async (_chatId: number, chunks: AsyncIterable<string>) => {
      for await (const _chunk of chunks) { /* consume guarded output */ }
    },
  } as unknown as Gateway
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => {
      runtimeAcquisitions += 1
      return {
        sessionId: 'session-a',
        runner: {
          handle: async () => {
            modelCalls += 1
            return { state: 'ok' as const, reply: 'unexpected', narrowed: false }
          },
        },
      }
    },
    ...(input.lifecycle === undefined ? {} : { projectLifecycleControls: input.lifecycle }),
    ...(input.projectControls === undefined ? {} : { projectControls: input.projectControls }),
    ...(input.sessionControls === undefined ? {} : { sessionControls: input.sessionControls }),
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload })
    if (input.failEdit === true && method === 'editMessageText') {
      throw new Error('telegram edit failed')
    }
    return { ok: true, result: true } as never
  })
  return {
    bot,
    apiCalls,
    gatewayUpdates,
    modelCalls: () => modelCalls,
    runtimeAcquisitions: () => runtimeAcquisitions,
  }
}

describe('Telegram Project lifecycle controls transport', () => {
  it('drops foreign text and callbacks before controls, gateway, model, or Telegram I/O', async () => {
    const textInputs: unknown[] = []
    const callbackInputs: unknown[] = []
    const h = harness({
      lifecycle: controls({
        text: async (value) => { textInputs.push(value); return confirmation() },
        callback: async (value) => {
          callbackInputs.push(value)
          return { kind: 'cancelled', text: 'Архивация отменена.' }
        },
      }),
    })

    await h.bot.handleUpdate(textUpdate(1, 777, 'архивируй текущий проект'))
    await h.bot.handleUpdate(callbackUpdate(2, 777))

    expect(textInputs).toEqual([])
    expect(callbackInputs).toEqual([])
    expect(h.gatewayUpdates).toEqual([])
    expect(h.modelCalls()).toBe(0)
    expect(h.runtimeAcquisitions()).toBe(0)
    expect(h.apiCalls).toEqual([])
  })

  it('renders authenticated confirmation buttons before model/coalescing', async () => {
    const textInputs: unknown[] = []
    const h = harness({
      lifecycle: controls({
        text: async (value) => { textInputs.push(value); return confirmation() },
      }),
    })

    await h.bot.handleUpdate(textUpdate(11, 42, 'архивируй текущий проект'))

    expect(textInputs).toEqual([{
      text: 'архивируй текущий проект',
      chatId: 42,
      updateId: 11,
    }])
    expect(h.modelCalls()).toBe(0)
    expect(h.runtimeAcquisitions()).toBe(0)
    expect(h.apiCalls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === 'Архивировать проект «Alpha»?' &&
      (call.payload as { reply_markup?: { inline_keyboard?: unknown } }).reply_markup
        ?.inline_keyboard !== undefined)).toBe(true)
  })

  it('falls through in lifecycle, session, Project order and stops at the first handled text', async () => {
    const order: string[] = []
    const h = harness({
      lifecycle: controls({
        text: async () => { order.push('lifecycle'); return null },
      }),
      sessionControls: {
        open: () => { throw new Error('not used') },
        resolvePrefix: () => ({ kind: 'unknown' }),
        handle: () => { throw new Error('not used') },
        create: () => { throw new Error('not used') },
        rename: () => { throw new Error('not used') },
        handleAuthenticatedText: () => {
          order.push('session')
          return {
            kind: 'view',
            view: {
              text: 'Сессии текущего контекста.',
              projectId: 'project-a',
              generation: 3,
              sessions: [],
              buttons: [],
            },
          }
        },
      },
      projectControls: {
        open: async () => { throw new Error('not used') },
        handle: async () => { throw new Error('not used') },
        handleAuthenticatedText: async () => {
          order.push('project')
          return { kind: 'unavailable', text: 'must not render' }
        },
      },
    })

    await h.bot.handleUpdate(textUpdate(16, 42, 'найди сессии'))

    expect(order).toEqual(['lifecycle', 'session'])
    expect(h.apiCalls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === 'Сессии текущего контекста.')).toBe(true)
    expect(h.modelCalls()).toBe(0)
    expect(h.runtimeAcquisitions()).toBe(0)
  })

  it('routes the strict lifecycle callback first with exact provenance', async () => {
    const lifecycleInputs: unknown[] = []
    const projectInputs: string[] = []
    const h = harness({
      lifecycle: controls({
        callback: async (value) => {
          lifecycleInputs.push(value)
          return {
            kind: 'archived',
            text: '✅ Проект «Alpha» архивирован.',
            action: 'project.archive',
            projectId: 'project-a',
            generation: 4,
          }
        },
      }),
      projectControls: {
        open: async () => { throw new Error('not used') },
        handle: async (data) => {
          projectInputs.push(data)
          return { kind: 'unavailable', text: 'not used' }
        },
        handleAuthenticatedText: async () => null,
      },
    })

    await h.bot.handleUpdate(callbackUpdate(21, 42))

    expect(lifecycleInputs).toEqual([{ data: CALLBACK, chatId: 42, updateId: 21 }])
    expect(projectInputs).toEqual([])
    expect(h.apiCalls.some((call) => call.method === 'editMessageText' &&
      (call.payload as { text?: string }).text === '✅ Проект «Alpha» архивирован.')).toBe(true)
    expect(h.modelCalls()).toBe(0)
    expect(h.runtimeAcquisitions()).toBe(0)
  })

  it('falls back to the same safe plain reply when a terminal edit fails', async () => {
    const h = harness({
      failEdit: true,
      lifecycle: controls({
        callback: async () => ({
          kind: 'archived',
          text: '✅ Проект «Alpha» архивирован.',
          action: 'project.archive',
          projectId: 'project-a',
          generation: 4,
        }),
      }),
    })

    await h.bot.handleUpdate(callbackUpdate(36, 42))

    expect(h.apiCalls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === '✅ Проект «Alpha» архивирован.')).toBe(true)
    expect(h.runtimeAcquisitions()).toBe(0)
    expect(h.modelCalls()).toBe(0)
  })

  it('renders replay/stale results as stable plain edits and unavailable as a reply', async () => {
    let calls = 0
    const h = harness({
      lifecycle: controls({
        callback: async () => {
          calls += 1
          return calls === 1
            ? { kind: 'cancelled', text: 'Архивация отменена.' }
            : calls === 2
              ? { kind: 'stale', text: 'Подтверждение устарело. Повтори команду.' }
              : { kind: 'unavailable', text: 'Архивация временно недоступна.' }
        },
      }),
    })

    await h.bot.handleUpdate(callbackUpdate(31, 42))
    await h.bot.handleUpdate(callbackUpdate(31, 42))
    await h.bot.handleUpdate(callbackUpdate(32, 42))

    const edits = h.apiCalls
      .filter((call) => call.method === 'editMessageText')
      .map((call) => (call.payload as { text?: string }).text)
    expect(edits).toContain('Архивация отменена.')
    expect(edits).toContain('Подтверждение устарело. Повтори команду.')
    expect(h.apiCalls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text === 'Архивация временно недоступна.')).toBe(true)
    expect(h.modelCalls()).toBe(0)
  })

  it('redacts adapter exceptions for text and callbacks', async () => {
    const h = harness({
      lifecycle: controls({
        text: async () => { throw new Error('private project path') },
        callback: async () => { throw new Error('private authority nonce') },
      }),
    })

    await h.bot.handleUpdate(textUpdate(41, 42, 'архивируй текущий проект'))
    await h.bot.handleUpdate(callbackUpdate(42, 42))

    const bodies = h.apiCalls.map((call) => String((call.payload as { text?: unknown }).text ?? ''))
    expect(bodies.filter((body) =>
      body === '❌ Не удалось безопасно обработать действие с контекстом.')).toHaveLength(2)
    expect(bodies.join('\n')).not.toContain('private project path')
    expect(bodies.join('\n')).not.toContain('private authority nonce')
    expect(h.modelCalls()).toBe(0)
    expect(h.runtimeAcquisitions()).toBe(0)
  })

  it('preserves callback and model behavior when lifecycle controls are omitted', async () => {
    const h = harness({})

    await h.bot.handleUpdate(callbackUpdate(51, 42))
    expect(h.runtimeAcquisitions()).toBe(0)
    expect(h.modelCalls()).toBe(0)

    await h.bot.handleUpdate(textUpdate(52, 42, 'архивируй текущий проект'))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(h.runtimeAcquisitions()).toBe(1)
    expect(h.modelCalls()).toBe(1)
  })
})

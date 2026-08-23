import { describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import type { Gateway } from '@aisy/core'

import { makeTelegramBot } from './bot.js'
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

function sessionControls(
  handle: TelegramSessionControls['handleAuthenticatedText'],
): TelegramSessionControls {
  return {
    open: () => { throw new Error('not used') },
    handle: () => { throw new Error('not used') },
    create: () => { throw new Error('not used') },
    rename: () => { throw new Error('not used') },
    handleAuthenticatedText: handle,
  }
}

function harness(input: {
  controls?: TelegramSessionControls
  gatewayFailure?: boolean
}) {
  const apiCalls: Array<{ method: string; payload: unknown }> = []
  const gatewayUpdates: Update[] = []
  let modelCalls = 0
  const gateway = {
    onUpdate: async (update: Update) => {
      gatewayUpdates.push(update)
      if (input.gatewayFailure === true) throw new Error('AUTH_FAILED')
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
    acquireTurnRuntime: async () => ({
      sessionId: 'session-a',
      runner: {
        handle: async () => {
          modelCalls += 1
          return { state: 'ok' as const, reply: 'legacy reply', narrowed: false }
        },
      },
    }),
    ...(input.controls === undefined ? {} : { sessionControls: input.controls }),
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload })
    return { ok: true, result: true } as never
  })
  return {
    bot,
    apiCalls,
    gatewayUpdates,
    modelCalls: () => modelCalls,
  }
}

describe('Telegram session controls transport', () => {
  it('drops a foreign chat before gateway, controls, or model work', async () => {
    const controlInputs: unknown[] = []
    const h = harness({
      controls: sessionControls((value) => {
        controlInputs.push(value)
        return null
      }),
    })

    await h.bot.handleUpdate(textUpdate(7, 777, 'создай сессию Чужая'))

    expect(h.gatewayUpdates).toEqual([])
    expect(controlInputs).toEqual([])
    expect(h.modelCalls()).toBe(0)
    expect(h.apiCalls).toEqual([])
  })

  it('routes authenticated session text with exact provenance and performs zero model work', async () => {
    const controlInputs: unknown[] = []
    const h = harness({
      controls: sessionControls((value) => {
        controlInputs.push(value)
        return {
          kind: 'created',
          text: '✅ Сессия «Исследование» создана. Текущая сессия не изменена.',
          session: {} as never,
        }
      }),
    })

    await h.bot.handleUpdate(textUpdate(71, 42, 'создай сессию Исследование'))

    expect(controlInputs).toEqual([{
      text: 'создай сессию Исследование',
      chatId: 42,
      updateId: 71,
    }])
    expect(h.modelCalls()).toBe(0)
    expect(h.apiCalls.some((call) => call.method === 'sendMessage' &&
      (call.payload as { text?: string }).text ===
        '✅ Сессия «Исследование» создана. Текущая сессия не изменена.')).toBe(true)
  })

  it('redacts gateway and session-adapter failures', async () => {
    const adapter = harness({
      controls: sessionControls(() => { throw new Error('private registry path') }),
    })
    await adapter.bot.handleUpdate(textUpdate(81, 42, 'найди сессии alpha'))
    const adapterBodies = adapter.apiCalls.map((call) =>
      String((call.payload as { text?: unknown }).text ?? ''))
    expect(adapterBodies).toContain('❌ Не удалось безопасно обработать команду сессии.')
    expect(adapterBodies.join('\n')).not.toContain('private registry path')
    expect(adapter.modelCalls()).toBe(0)

    const auth = harness({
      gatewayFailure: true,
      controls: sessionControls(() => { throw new Error('must not run') }),
    })
    await auth.bot.handleUpdate(textUpdate(82, 42, 'найди сессии alpha'))
    const authBodies = auth.apiCalls.map((call) =>
      String((call.payload as { text?: unknown }).text ?? ''))
    expect(authBodies).toContain('❌ Сообщение не прошло проверку доступа.')
    expect(authBodies.join('\n')).not.toContain('AUTH_FAILED')
    expect(auth.modelCalls()).toBe(0)
  })

  it('preserves the legacy model path when the optional dependency is omitted', async () => {
    const h = harness({})

    await h.bot.handleUpdate(textUpdate(91, 42, 'обычная задача'))
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(h.gatewayUpdates).toHaveLength(1)
    expect(h.modelCalls()).toBe(1)
  })
})

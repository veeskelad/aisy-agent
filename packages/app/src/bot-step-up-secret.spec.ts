// Кодовое слово второго фактора приходит тем же каналом, что и ключи сервисов:
// сообщением в чат. Ключи бот удаляет сразу, а этот текст оставался в
// переписке — секрет, лежащий в истории, перестаёт быть вторым фактором.

import { StepUpFailed, StepUpRequired } from '@aisy/core'
import type { Gateway, PendingAction } from '@aisy/core'
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

const ACTION: PendingAction = Object.freeze({
  actionId: 'act-1',
  actionHash: 'deadbeef',
  tier: 3,
  requiresStepUp: true,
  summary: 'db.drop-database(prod)',
})

function harness(verified: boolean) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let issued = false
  const gateway: Gateway = {
    onUpdate: async () => ({
      spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
      text: '', receivedAt: '2026-08-16T00:00:00.000Z',
    }),
    streamReply: async () => {},
    issueCard: async () => { issued = true; return 'card-1' },
    getIssuedCard: () => (issued
      ? { cardId: 'card-1', nonce: 'nonce-1', action: ACTION, expiresAt: 0 } as never
      : null),
    // Первый тап без кода требует второй фактор; с кодом — решает по нему.
    // Шлюз сообщает это исключениями, а не значением решения.
    handleCardTap: async (tap: { stepUpProof?: string }) => {
      if (tap.stepUpProof === undefined) throw new StepUpRequired('step-up required')
      if (!verified) throw new StepUpFailed('wrong code')
      return { decision: 'confirmed' as const, actionId: ACTION.actionId } as never
    },
  }
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    // Карточка регистрируется в транспорте только когда её запросил ход.
    acquireTurnRuntime: async (approvalForSession) => ({
      sessionId: 'session-a',
      runner: {
        handle: async () => {
          void approvalForSession('session-a')(ACTION)
          // Ход не ждёт ответа: карточка уже висит, а решение придёт кодом.
          return { state: 'ok', reply: 'жду код', narrowed: false }
        },
      },
    }),
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return { bot, calls }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Карточка появляется в чате не сразу: ход запускается после debounce. */
async function issueCardAndTap(h: ReturnType<typeof harness>): Promise<void> {
  await h.bot.handleUpdate(message('удали базу'))
  await pause(40)
  const button = h.calls
    .filter((call) => call.method === 'sendMessage')
    .flatMap((call) => {
      const markup = call.payload['reply_markup'] as
        { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined
      return markup?.inline_keyboard?.flat() ?? []
    })
    .find((item) => item.callback_data.startsWith('atap|y|'))
  if (button === undefined) throw new Error('карточка подтверждения не появилась')
  await h.bot.handleUpdate(tap(button.callback_data))
  await pause(10)
}

const tap = (data: string): Update => ({
  update_id: 1,
  callback_query: {
    id: 'cb-1',
    chat_instance: 'instance',
    from: { id: 42, is_bot: false, first_name: 'Operator' },
    data,
    message: {
      message_id: 7, date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
    },
  },
})

const message = (text: string): Update => ({
  update_id: 2,
  message: {
    message_id: 8, date: 0,
    chat: { id: 42, type: 'private', first_name: 'Operator' },
    from: { id: 42, is_bot: false, first_name: 'Operator' },
    text,
  },
})

describe('кодовое слово второго фактора', () => {
  it('удаляется из переписки — и когда подошло, и когда нет', async () => {
    for (const verified of [true, false]) {
      const h = harness(verified)
      await issueCardAndTap(h)
      await h.bot.handleUpdate(message('моё-кодовое-слово'))
      await pause(10)

      const deleted = h.calls.filter((call) => call.method === 'deleteMessage')
      expect(deleted.map((call) => call.payload['message_id'])).toContain(8)
      // Неверная попытка — тоже попытка угадать секрет, и хранить её незачем.
      expect(deleted.length).toBeGreaterThan(0)
    }
  })

  it('просит код по-русски, без названия протокола', async () => {
    const h = harness(true)
    await issueCardAndTap(h)

    const asked = h.calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text'] ?? ''))
      .join('\n')
    expect(asked).toContain('одноразовый код')
    expect(asked).not.toContain('TOTP')
  })
})

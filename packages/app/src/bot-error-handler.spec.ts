import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'

import { makeTelegramBot } from './bot.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

const gateway: Gateway = {
  onUpdate: async () => ({
    spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
    text: 'привет', receivedAt: '2026-08-13T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

/** A command update: it answers inside handleUpdate, with no debounce in between. */
function textUpdate(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
    },
  }
}

/**
 * A bot whose very first API call fails the way Telegram fails on unparsable
 * HTML — the exact shape that took the live agent down on 2026-08-12.
 */
function harness(options: { failWith?: Error } = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let failuresLeft = options.failWith === undefined ? 0 : 1
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    acquireTurnRuntime: async () => ({
      sessionId: 'session-a',
      runner: { handle: async () => ({ state: 'ok', reply: 'ответ', narrowed: false }) },
    }),
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    if (failuresLeft > 0 && method === 'sendMessage') {
      failuresLeft -= 1
      throw options.failWith
    }
    calls.push({ method, payload: payload as Record<string, unknown> })
    return {
      ok: true,
      result: { message_id: 77, date: 0, chat: { id: 42, type: 'private' }, text: '' },
    } as never
  })
  return {
    bot, calls,
    texts: () => calls.map((c) => String(c.payload['text'] ?? '')),
    /**
     * Доставляет обновление так же, как это делает polling.
     *
     * `handleUpdates` приватен, но именно он применяет обработчик ошибок:
     * одиночный `handleUpdate` бросает по контракту grammY, и тест на нём
     * проверял бы путь, которым живой бот не ходит. Каст — цена за проверку
     * настоящего пути вместо удобного.
     */
    deliver: (update: Update): Promise<void> =>
      (bot as unknown as { handleUpdates(updates: Update[]): Promise<void> })
        .handleUpdates([update]),
  }
}

describe('обработчик ошибок бота', () => {
  it('не даёт одной неудачной доставке уронить процесс', async () => {
    // Ровно то, что случилось в проде: ответ с «<имя>» не прошёл HTML-разбор.
    const h = harness({
      failWith: new Error(
        "Call to 'sendMessage' failed! (400: Bad Request: can't parse entities: " +
        'Unsupported start tag "имя" at byte offset 40)'),
    })

    // Раньше это уходило в uncaughtException и валило весь агент. Проверяется
    // handleUpdates — именно этот путь использует polling, и именно он
    // применяет обработчик; handleUpdate в одиночку бросает по контракту grammY.
    await expect(h.deliver(textUpdate('/grants'))).resolves.toBeUndefined()
  })

  it('говорит оператору, что ход не доставлен, и остаётся на связи', async () => {
    const h = harness({ failWith: new Error('400: Bad Request: can\'t parse entities') })

    await h.deliver(textUpdate('/grants'))

    const reported = h.texts().join('\n')
    expect(reported).toContain('Не смог доставить ответ')
    // Отчёт идёт простым текстом: если сломался именно HTML-разбор, ответ с
    // разметкой утонул бы там же.
    const report = h.calls.find((c) => String(c.payload['text'] ?? '').includes('Не смог'))
    expect(report?.payload['parse_mode']).toBeUndefined()
  })

  it('следующее сообщение обрабатывается как ни в чём не бывало', async () => {
    const h = harness({ failWith: new Error('400: Bad Request') })

    await h.deliver(textUpdate('/grants'))
    await h.deliver({ ...textUpdate('/grants'), update_id: 2 })

    expect(h.texts().some((t) => t.includes('Разрешения'))).toBe(true)
  })

  it('молчащий чат не превращает сбой доставки в падение', async () => {
    const h = harness({ failWith: new Error('400: Bad Request') })
    // Отчёт об ошибке тоже не проходит — обработчик обязан пережить и это.
    h.bot.api.config.use(async () => { throw new Error('чат недоступен') })

    await expect(h.deliver(textUpdate('/grants'))).resolves.toBeUndefined()
  })

  it('исправный ход не трогает обработчик ошибок', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const h = harness()

    await h.deliver(textUpdate('/grants'))

    expect(h.texts().some((t) => t.includes('Разрешения'))).toBe(true)
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('не доставлен'))).toBe(false)
    stderr.mockRestore()
  })
})

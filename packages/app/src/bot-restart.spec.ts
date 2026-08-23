import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'

import { makeTelegramBot, type TelegramBotDeps } from './bot.js'
import type { RestartIntent } from './runtime-restart.js'

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
    text: '', receivedAt: '2026-07-29T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'unused-card',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function update(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text: '/restart после обновления',
      entities: [{ type: 'bot_command', offset: 0, length: 8 }],
    },
  }
}

function harness(
  restartRuntime: Pick<NonNullable<TelegramBotDeps['restartRuntime']>, 'prepare' | 'commitExit'>
    & Partial<Pick<NonNullable<TelegramBotDeps['restartRuntime']>, 'cancel'>>,
  options: { replyError?: Error; order?: string[] } = {},
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    restartRuntime: { cancel: () => 'cancelled', ...restartRuntime },
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    options.order?.push('reply')
    if (options.replyError !== undefined) throw options.replyError
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return {
    bot,
    replies: () => calls.map((call) => String(call.payload['text'] ?? '')).join('\n'),
  }
}

describe('/restart command', () => {
  it('reports a durable-intent failure without claiming that restart started', async () => {
    const prepare = vi.fn(() => 'intent-not-durable' as const)
    const commitExit = vi.fn()
    const h = harness({ prepare, commitExit })

    await h.bot.handleUpdate(update())

    expect(prepare).toHaveBeenCalledWith('после обновления')
    expect(commitExit).not.toHaveBeenCalled()
    expect(h.replies()).toContain('Не удалось надёжно записать намерение перезапуска')
    expect(h.replies()).toContain('Процесс оставлен запущенным')
    expect(h.replies()).not.toContain('Перезапускаюсь')
  })

  it('reports ambiguous state without claiming whether a receipt exists', async () => {
    const h = harness({
      prepare: () => 'restart-state-ambiguous',
      commitExit: vi.fn(),
    })

    await h.bot.handleUpdate(update())

    expect(h.replies()).toContain('Состояние перезапуска неоднозначно')
    expect(h.replies()).toContain('текущий процесс оставлен запущенным')
    expect(h.replies()).not.toContain('Новая запись не создана')
    expect(h.replies()).not.toContain('Завершаю текущий процесс')
    expect(h.replies()).not.toContain('Вернусь')
  })

  it('commits the exact prepared intent only after Telegram accepted the reply', async () => {
    const order: string[] = []
    const intent = validRestartIntent()
    const prepare = vi.fn(() => { order.push('prepare'); return intent })
    const commitExit = vi.fn(async (received: RestartIntent) => {
      order.push('commit')
      expect(received).toBe(intent)
      return 'committed' as const
    })
    const h = harness({ prepare, commitExit }, { order })

    await h.bot.handleUpdate(update())

    expect(order).toEqual(['prepare', 'reply', 'commit'])
    expect(commitExit).toHaveBeenCalledOnce()
    expect(h.replies()).toContain('Намерение перезапуска надёжно записано')
    expect(h.replies()).not.toContain('Вернусь')
    expect(h.replies()).not.toContain('перезапустился')
  })

  it.each([
    ['already-committed', 'повторная команда не выполнялась'],
    ['not-supervised', 'Завершение отменено'],
    ['busy', 'началась новая задача'],
    ['restart-state-ambiguous', 'Не удалось подтвердить завершение'],
  ] as const)('handles commit result %s without a false exit claim', async (commitResult, expected) => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => commitResult,
    })

    await h.bot.handleUpdate(update())

    expect(h.replies()).toContain('Намерение перезапуска надёжно записано')
    expect(h.replies()).toContain(expected)
    expect(h.replies()).not.toContain('Завершаю текущий процесс')
  })

  it('turns a throwing exit callback into a best-effort corrective reply', async () => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => { throw new Error('exit callback failed') },
    })

    await expect(h.bot.handleUpdate(update())).resolves.toBeUndefined()
    expect(h.replies()).toContain('Не удалось подтвердить завершение')
  })

  it('keeps the process alive when Telegram does not accept the reply', async () => {
    const intent = validRestartIntent()
    const commitExit = vi.fn()
    const cancel = vi.fn(() => 'cancelled' as const)
    const h = harness(
      { prepare: () => intent, commitExit, cancel },
      { replyError: new Error('telegram unavailable') },
    )

    await expect(h.bot.handleUpdate(update())).resolves.toBeUndefined()
    expect(commitExit).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith(intent)
  })
})

function validRestartIntent(): RestartIntent {
  return Object.freeze({
    requestedAt: '2026-07-29T00:00:00.000Z',
    reason: 'после обновления',
    activeTurns: 0,
  })
}

import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeTelegramBot, type TelegramBotDeps } from './bot.js'
import { makeRuntimeRestart, type RestartIntent } from './runtime-restart.js'

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

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
    & Partial<Pick<NonNullable<TelegramBotDeps['restartRuntime']>,
      'cancel' | 'previous' | 'acknowledgePrevious'>>,
  options: {
    replyError?: Error
    methodFailures?: Record<string, number>
    order?: string[]
    deps?: Partial<TelegramBotDeps>
  } = {},
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
    ...options.deps,
    restartRuntime: {
      cancel: () => 'cancelled',
      previous: () => null,
      ...restartRuntime,
    },
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    options.order?.push('reply')
    if (options.replyError !== undefined) throw options.replyError
    const failures = options.methodFailures?.[method] ?? 0
    if (failures > 0) {
      options.methodFailures![method] = failures - 1
      throw new Error(`${method} unavailable`)
    }
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: { message_id: 77, date: 0, chat: { id: 42, type: 'private' }, text: '' },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return {
    bot,
    calls,
    replies: () => calls.map((call) => String(call.payload['text'] ?? '')).join('\n'),
    sentReplies: () => calls.filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text'] ?? '')),
    editedReplies: () => calls.filter((call) => call.method === 'editMessageText')
      .map((call) => String(call.payload['text'] ?? '')),
  }
}

describe('/restart command', () => {
  it('reports a durable-intent failure without claiming that restart started', async () => {
    const prepare = vi.fn(() => 'intent-not-durable' as const)
    const commitExit = vi.fn()
    const h = harness({ prepare, commitExit })

    await h.bot.handleUpdate(update())

    expect(prepare).toHaveBeenCalledWith('telegram-update:1 · после обновления')
    expect(commitExit).not.toHaveBeenCalled()
    expect(h.replies()).toBe('Не получилось перезапуститься. Я остаюсь на связи.')
    expect(h.replies()).not.toContain('намерение')
    expect(h.replies()).not.toContain('Перезапускаюсь')
  })

  it('reports ambiguous state without claiming whether a receipt exists', async () => {
    const h = harness({
      prepare: () => 'restart-state-ambiguous',
      commitExit: vi.fn(),
    })

    await h.bot.handleUpdate(update())

    expect(h.replies()).toBe('Не получилось перезапуститься. Я остаюсь на связи.')
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
    expect(h.replies()).toBe('Перезапускаюсь. Скоро вернусь.')
    expect(h.replies()).not.toContain('намерение')
    expect(h.replies()).not.toContain('перезапустился')
  })

  it.each([
    ['already-committed', 'Перезапуск уже начался.'],
    ['not-supervised', 'Перезапуск отменился. Я остаюсь на связи.'],
    ['busy', 'Перезапуск отменился: началась новая задача. Я остаюсь на связи.'],
    ['restart-state-ambiguous', 'Перезапуск не завершился. Я остаюсь на связи.'],
  ] as const)('handles commit result %s without a false exit claim', async (commitResult, expected) => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => commitResult,
    })

    await h.bot.handleUpdate(update())

    expect(h.replies()).toContain('Перезапускаюсь. Скоро вернусь.')
    expect(h.replies()).toContain(expected)
    expect(h.sentReplies()).toEqual(['Перезапускаюсь. Скоро вернусь.'])
    expect(h.editedReplies()).toEqual([expected])
    expect(h.replies()).not.toContain('намерение')
    expect(h.replies()).not.toContain('подтвердить завершение')
  })

  it('replaces the start message only after a failed correction edit was deleted', async () => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => 'not-supervised',
    }, { methodFailures: { editMessageText: 1 } })

    await h.bot.handleUpdate(update())

    expect(h.sentReplies()).toEqual([
      'Перезапускаюсь. Скоро вернусь.',
      'Перезапуск отменился. Я остаюсь на связи.',
    ])
    expect(h.calls.some((call) => call.method === 'deleteMessage')).toBe(true)
  })

  it('does not add a contradictory reply when correction and deletion both fail', async () => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => 'not-supervised',
    }, { methodFailures: { editMessageText: 1, deleteMessage: 1 } })

    await h.bot.handleUpdate(update())

    expect(h.sentReplies()).toEqual(['Перезапускаюсь. Скоро вернусь.'])
    expect(h.editedReplies()).toEqual([])
  })

  it('turns a throwing exit callback into a best-effort corrective reply', async () => {
    const h = harness({
      prepare: () => validRestartIntent(),
      commitExit: async () => { throw new Error('exit callback failed') },
    })

    await expect(h.bot.handleUpdate(update())).resolves.toBeUndefined()
    expect(h.replies()).toContain('Перезапуск не завершился. Я остаюсь на связи.')
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

  it('drops the exact replay after a fresh process starts, before any reply or restart', async () => {
    const intent = validRestartIntent()
    const prepare = vi.fn(() => intent)
    const commitExit = vi.fn(async () => 'committed' as const)
    const first = harness({ prepare, commitExit })

    await first.bot.handleUpdate(update())

    const nextIntent = Object.freeze({
      requestedAt: '2026-07-29T00:01:00.000Z',
      reason: 'telegram-update:2 · после обновления',
      activeTurns: 0,
    })
    const replayPrepare = vi.fn(() => nextIntent)
    const replayCommit = vi.fn(async () => 'committed' as const)
    const acknowledgePrevious = vi.fn(() => 'acknowledged' as const)
    const second = harness({
      previous: () => intent,
      acknowledgePrevious,
      prepare: replayPrepare,
      commitExit: replayCommit,
    })

    await second.bot.handleUpdate(update())

    expect(replayPrepare).not.toHaveBeenCalled()
    expect(replayCommit).not.toHaveBeenCalled()
    expect(acknowledgePrevious).not.toHaveBeenCalled()
    expect(second.replies()).toBe('')

    const next = update()
    next.update_id = 2
    await second.bot.handleUpdate(next)

    expect(replayPrepare).toHaveBeenCalledWith('telegram-update:2 · после обновления')
    expect(replayCommit).toHaveBeenCalledWith(nextIntent)
    expect(acknowledgePrevious).toHaveBeenCalledWith(intent)
  })

  it('bridges the deployed legacy new-session loop only for the first exact menu update', async () => {
    const startNewSession = vi.fn(async () => ({ ok: true as const, name: 'New session' }))
    const nextIntent = Object.freeze({
      requestedAt: '2026-08-28T00:01:00.000Z',
      reason: 'telegram-update:8 · после обновления',
      activeTurns: 0,
    })
    const prepare = vi.fn(() => nextIntent)
    const acknowledgePrevious = vi.fn(() => 'acknowledged' as const)
    const legacy = Object.freeze({
      requestedAt: '2026-08-28T00:00:00.000Z',
      reason: 'новая сессия',
      activeTurns: 0,
    })
    const h = harness({
      previous: () => legacy,
      acknowledgePrevious,
      prepare,
      commitExit: vi.fn(async () => 'committed' as const),
    }, { deps: { startNewSession } })

    await h.bot.handleUpdate({
      update_id: 7,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        text: '🆕 Новая сессия',
      },
    })

    expect(startNewSession).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(acknowledgePrevious).not.toHaveBeenCalled()
    expect(h.replies()).toBe('')

    const next = update()
    next.update_id = 8
    await h.bot.handleUpdate(next)

    expect(acknowledgePrevious).toHaveBeenCalledWith(legacy)
    expect(prepare).toHaveBeenCalledWith('telegram-update:8 · после обновления')
  })

  it('does not swallow the first update after a non-Telegram planned restart', async () => {
    const prepare = vi.fn(() => validRestartIntent())
    const acknowledgePrevious = vi.fn(() => 'acknowledged' as const)
    const previous = Object.freeze({
      requestedAt: '2026-08-28T00:00:00.000Z',
      reason: 'daily session rotation',
      activeTurns: 0,
    })
    const h = harness({
      previous: () => previous,
      acknowledgePrevious,
      prepare,
      commitExit: vi.fn(async () => 'committed' as const),
    })

    await h.bot.handleUpdate(update())

    expect(prepare).toHaveBeenCalledWith('telegram-update:1 · после обновления')
    expect(acknowledgePrevious).toHaveBeenCalledWith(previous)
  })

  it('keeps replay evidence through a second process replacement until a newer update arrives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-bot-restart-'))
    roots.push(root)
    const path = join(root, 'restart.json')
    const runtime = () => makeRuntimeRestart({
      path,
      nowIso: () => '2026-08-28T00:00:00.000Z',
      supervised: () => true,
      activeTurns: () => 0,
      authorizePlannedRestart: async () => undefined,
      exit: () => undefined,
    })

    const first = harness(runtime())
    await first.bot.handleUpdate(update())

    const replacement = harness(runtime())
    await replacement.bot.handleUpdate(update())
    expect(replacement.replies()).toBe('')

    const stoppedAndStartedAgain = harness(runtime())
    await stoppedAndStartedAgain.bot.handleUpdate(update())
    expect(stoppedAndStartedAgain.replies()).toBe('')

    const newer = update()
    newer.update_id = 2
    newer.message!.text = '/server'
    newer.message!.entities = [{ type: 'bot_command', offset: 0, length: 7 }]
    await stoppedAndStartedAgain.bot.handleUpdate(newer)
    expect(stoppedAndStartedAgain.replies()).toContain('Состояние сервера недоступно')
    expect(runtime().previous()).toBeNull()
  })
})

function validRestartIntent(): RestartIntent {
  return Object.freeze({
    requestedAt: '2026-07-29T00:00:00.000Z',
    reason: 'telegram-update:1 · после обновления',
    activeTurns: 0,
  })
}

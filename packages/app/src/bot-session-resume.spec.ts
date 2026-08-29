// 💬 Сессии used to be a text dump: the operator could read that yesterday's
// conversation existed and had no way back into it. These are the two seams that
// close it — the screen carries buttons, and a tap switches and restarts.

import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it, vi } from 'vitest'
import { makeTelegramBot } from './bot.js'
import type { SessionDeletionRecordV1 } from './session-deletion.js'
import type {
  TelegramSessionControls,
  TelegramSessionTap,
  TelegramSessionView,
} from './telegram-session-controls.js'

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

const VIEW: TelegramSessionView = {
  text: 'Сессии текущего контекста:\n• Вчерашний разбор · #abc12345',
  projectId: 'project-a',
  generation: 3,
  sessions: [],
  buttons: [[{ text: '↩️ Вчерашний разбор', data: 'session:token-1' }]],
}

function textUpdate(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: 0, chat: CHAT, from: FROM, text,
      ...(text.startsWith('/resume')
        ? { entities: [{ type: 'bot_command' as const, offset: 0, length: 7 }] }
        : {}),
    },
  }
}

function tap(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb-1', from: FROM, chat_instance: 'ci-1', data,
      message: {
        message_id: 77, date: 0, chat: CHAT, text: 'список сессий',
        from: { id: 999, is_bot: true, first_name: 'Aisy' },
      },
    },
  }
}

function harness(input: {
  resume?: (sessionId: string) => Promise<{ ok: true } | { ok: false; errorCode: string }>
  prefix?: TelegramSessionControls['resolvePrefix']
  tapOutcome?: TelegramSessionTap
  failMessage?: string
  commitResults?: Array<'committed' | 'already-committed' | 'not-supervised' | 'busy' |
  'restart-state-ambiguous'>
} = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const controls: TelegramSessionControls = {
    open: () => VIEW,
    resolvePrefix: input.prefix ?? (() => ({ kind: 'unknown' })),
    handle: async ({ data }) => input.tapOutcome ?? (data === 'session:token-1'
      ? { kind: 'resume', sessionId: 'session-old', name: 'Вчерашний разбор' }
      : { kind: 'stale', view: VIEW }),
    create: () => { throw new Error('not used') },
    rename: () => { throw new Error('not used') },
    handleAuthenticatedText: () => null,
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
  const prepared: string[] = []
  const scheduled: Array<() => void> = []
  let preparedIntent: { requestedAt: string; reason: string; activeTurns: number } | null = null
  const restartRuntime = {
    previous: () => null,
    prepare: (reason: string) => {
      if (preparedIntent !== null) return preparedIntent
      prepared.push(reason)
      preparedIntent = { requestedAt: '2026-08-07T00:00:00.000Z', reason, activeTurns: 0 }
      return preparedIntent
    },
    commitExit: vi.fn(async () => {
      const result = input.commitResults?.shift() ?? 'committed'
      if (result === 'not-supervised' || result === 'busy') preparedIntent = null
      return result
    }),
    cancel: vi.fn(() => {
      preparedIntent = null
      return 'cancelled' as const
    }),
  }
  const { bot } = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => { throw new Error('turn runtime must not run') },
    model: 'test-model',
    registerCommands: false,
    debounceMs: 1,
    sessionControls: controls,
    ...(input.resume === undefined ? {} : { resumeSession: input.resume }),
    restartRuntime,
    scheduleRequiredRestartRetry: (retry) => { scheduled.push(retry) },
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    const recorded = payload as Record<string, unknown>
    calls.push({ method, payload: recorded })
    if (method === 'sendMessage' && recorded['text'] === input.failMessage) {
      throw new Error('injected Telegram delivery failure')
    }
    return { ok: true, result: true } as never
  })
  return { bot, calls, prepared, restartRuntime, scheduled }
}

describe('sessions screen', () => {
  it('sends the list with buttons instead of a flat text', async () => {
    const h = harness()

    await h.bot.handleUpdate(textUpdate('💬 Сессии'))

    const sent = h.calls.find((call) => call.method === 'sendMessage')!
    expect(String(sent.payload['text'])).toContain('Вчерашний разбор')
    expect(JSON.stringify(sent.payload['reply_markup'])).toContain('session:token-1')
  })

  it('opens the same list for /resume without an argument', async () => {
    const h = harness()

    await h.bot.handleUpdate(textUpdate('/resume'))

    const sent = h.calls.find((call) => call.method === 'sendMessage')!
    expect(String(sent.payload['text'])).toContain('Вчерашний разбор')
    expect(JSON.stringify(sent.payload['reply_markup'])).toContain('session:token-1')
  })

  it('resolves a unique /resume prefix and restarts into it', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const prefix = vi.fn(() => ({
      kind: 'resume' as const, sessionId: 'session-old', name: 'Вчерашний разбор',
    }))
    const h = harness({ resume, prefix })

    await h.bot.handleUpdate(textUpdate('/resume session-o'))

    expect(prefix).toHaveBeenCalledWith('session-o')
    expect(resume).toHaveBeenCalledWith('session-old')
    expect(h.prepared).toEqual(['telegram-update:1 · возврат в сессию'])
  })

  it('does not mutate state for an ambiguous /resume prefix', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const h = harness({ resume, prefix: () => ({ kind: 'ambiguous' }) })

    await h.bot.handleUpdate(textUpdate('/resume session'))

    expect(resume).not.toHaveBeenCalled()
    expect(h.prepared).toEqual([])
    expect(h.calls.map((call) => String(call.payload['text'] ?? '')).join('\n'))
      .toContain('Нашёл несколько сессий')
  })

  it('switches and restarts into the session that was tapped', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-1'))

    expect(resume).toHaveBeenCalledWith('session-old')
    expect(h.prepared).toEqual(['telegram-update:2 · возврат в сессию'])
  })

  it('says so instead of restarting when the switch is refused', async () => {
    const resume = vi.fn(async () => ({ ok: false as const, errorCode: 'ALREADY_ACTIVE' }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-1'))

    expect(h.prepared).toEqual([])
    expect(h.calls.map((call) => String(call.payload['text'] ?? '')).join('\n'))
      .toContain('Это и есть текущая сессия')
  })

  it('refuses a stale token without touching the runtime', async () => {
    const resume = vi.fn(async () => ({ ok: true as const }))
    const h = harness({ resume })

    await h.bot.handleUpdate(tap('session:token-gone'))

    expect(resume).not.toHaveBeenCalled()
    expect(h.prepared).toEqual([])
    expect(h.calls.some((call) => call.method === 'editMessageText')).toBe(true)
  })

  it('speaks once and commits the already prepared restart after deleting the active Session', async () => {
    const operationHash = 'd'.repeat(64)
    const record: SessionDeletionRecordV1 = {
      schemaVersion: 1,
      operationHash,
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      sessionId: 'session-old',
      deletedAt: '2026-08-29T20:00:00.000Z',
      restartRequired: true,
      restartUpdateId: 2,
      purgeRevision: 1,
      purgedAt: '2026-08-29T20:00:01.000Z',
      phase: 'restart-requested',
    }
    const h = harness({
      tapOutcome: { kind: 'deleted', text: 'Сессия удалена.', record },
    })
    const intent = h.restartRuntime.prepare(
      `telegram-update:2 · session deletion ${operationHash}`,
    )

    await h.bot.handleUpdate(tap('session:delete-token'))

    expect(h.prepared).toEqual([
      `telegram-update:2 · session deletion ${operationHash}`,
    ])
    const messages = h.calls.filter((call) =>
      call.method === 'sendMessage' && typeof call.payload['text'] === 'string')
    expect(messages.map((call) => call.payload['text'])).toEqual([
      'Сессия удалена. Перезапускаюсь. Скоро вернусь.',
    ])
    expect(h.calls.some((call) => call.method === 'editMessageText')).toBe(false)
    expect(h.restartRuntime.commitExit).toHaveBeenCalledTimes(1)
    expect(h.restartRuntime.commitExit).toHaveBeenCalledWith(intent)
  })

  it('edits the card without restarting after deleting an inactive Session', async () => {
    const record: SessionDeletionRecordV1 = {
      schemaVersion: 1,
      operationHash: 'e'.repeat(64),
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      sessionId: 'session-old',
      deletedAt: '2026-08-29T20:00:00.000Z',
      restartRequired: false,
      purgeRevision: 1,
      purgedAt: '2026-08-29T20:00:01.000Z',
      phase: 'terminal',
    }
    const h = harness({
      tapOutcome: { kind: 'deleted', text: 'Сессия удалена.', record },
    })

    await h.bot.handleUpdate(tap('session:delete-token'))

    expect(h.prepared).toEqual([])
    expect(h.calls.filter((call) => call.method === 'editMessageText')
      .map((call) => call.payload['text'])).toEqual(['Сессия удалена.'])
    expect(h.restartRuntime.commitExit).not.toHaveBeenCalled()
  })

  it('still commits the mandatory restart when the deletion notice cannot be delivered', async () => {
    const operationHash = 'f'.repeat(64)
    const startingMessage = 'Сессия удалена. Перезапускаюсь. Скоро вернусь.'
    const record: SessionDeletionRecordV1 = {
      schemaVersion: 1,
      operationHash,
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      sessionId: 'session-old',
      deletedAt: '2026-08-29T20:00:00.000Z',
      restartRequired: true,
      restartUpdateId: 2,
      purgeRevision: 1,
      purgedAt: '2026-08-29T20:00:01.000Z',
      phase: 'restart-requested',
    }
    const h = harness({
      tapOutcome: { kind: 'deleted', text: 'Сессия удалена.', record },
      failMessage: startingMessage,
    })
    const intent = h.restartRuntime.prepare(
      `telegram-update:2 · session deletion ${operationHash}`,
    )

    await h.bot.handleUpdate(tap('session:delete-token'))

    expect(h.restartRuntime.cancel).not.toHaveBeenCalled()
    expect(h.restartRuntime.commitExit).toHaveBeenCalledWith(intent)
  })

  it('keeps the deleted binding closed and retries a refused mandatory restart', async () => {
    const operationHash = 'a'.repeat(64)
    const record: SessionDeletionRecordV1 = {
      schemaVersion: 1,
      operationHash,
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      sessionId: 'session-old',
      deletedAt: '2026-08-29T20:00:00.000Z',
      restartRequired: true,
      restartUpdateId: 2,
      purgeRevision: 1,
      purgedAt: '2026-08-29T20:00:01.000Z',
      phase: 'restart-requested',
    }
    const h = harness({
      tapOutcome: { kind: 'deleted', text: 'Сессия удалена.', record },
      commitResults: ['not-supervised', 'committed'],
    })
    h.restartRuntime.prepare(`telegram-update:2 · session deletion ${operationHash}`)

    await h.bot.handleUpdate(tap('session:delete-token'))

    expect(h.scheduled).toHaveLength(1)
    expect(h.restartRuntime.cancel).not.toHaveBeenCalled()
    h.scheduled.shift()!()
    await vi.waitFor(() => expect(h.restartRuntime.commitExit).toHaveBeenCalledTimes(2))
    expect(h.prepared).toEqual([
      `telegram-update:2 · session deletion ${operationHash}`,
      `telegram-update:2 · session deletion ${operationHash}`,
    ])
  })
})

// The 🔄 Повторить button under a failed turn.
//
// The card has always been rendered with the button, but no handler ever
// resolved `error:retry` — the tap stopped the spinner and did nothing, which is
// the worst possible answer to "your turn failed".

import type { AgentRunner, Gateway } from '@aisy/core'
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

const CHAT = { id: 42, type: 'private' as const, first_name: 'Operator' }
const FROM = { id: 42, is_bot: false, first_name: 'Operator' }

function textUpdate(text: string, id = 1): Update {
  return { update_id: id, message: { message_id: id, date: 0, chat: CHAT, from: FROM, text } }
}

function tap(data: string, messageId: number, id = 90): Update {
  return {
    update_id: id,
    callback_query: {
      id: `cb-${id}`, from: FROM, chat_instance: 'ci-1', data,
      message: {
        message_id: messageId, date: 0, chat: CHAT, text: 'карточка ошибки',
        from: { id: 999, is_bot: true, first_name: 'Aisy' },
      },
    },
  }
}

function harness(
  failures: number,
  emitProgressBeforeFailure = false,
  failure: Error & { kind?: string } = Object.assign(new Error('провайдер вернул 502'), {
    name: 'ProviderError', kind: 'server-error',
  }),
  failFirstEdit = false,
  methodFailures: Record<string, number> = {},
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const diagnostics: Array<{ code: string; errorName: string }> = []
  const seen: string[] = []
  let remaining = failures
  const runner: AgentRunner = {
    async handle(input) {
      seen.push(...input.spans.map((span) => span.text))
      if (remaining > 0) {
        remaining -= 1
        if (emitProgressBeforeFailure) await input.onProgress?.({ type: 'turn-started' })
        throw failure
      }
      return { state: 'ok', reply: 'готово', narrowed: false }
    },
  }
  const gateway: Gateway = {
    // The runner sees whatever the gateway normalised, so the fake has to carry
    // the operator's actual text through — otherwise a replay of "the same
    // input" would be indistinguishable from a replay of nothing.
    onUpdate: async (update) => ({
      spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
      text: String((update['message'] as { text?: unknown } | undefined)?.text ?? ''),
      receivedAt: '2026-08-07T00:00:00.000Z',
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
    buildRunner: () => runner,
    model: 'test-model',
    registerCommands: false,
    debounceMs: 1,
    reportTurnFailure: (failure) => { diagnostics.push({ ...failure }) },
  })
  bot.botInfo = BOT_INFO
  let messageId = 500
  let editFailurePending = failFirstEdit
  const sentIds: Array<{ id: number; text: string }> = []
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'editMessageText' && editFailurePending) {
      editFailurePending = false
      throw new Error('telegram edit unavailable')
    }
    const failures = methodFailures[method] ?? 0
    if (failures > 0) {
      methodFailures[method] = failures - 1
      throw new Error(`${method} unavailable`)
    }
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'sendMessage') {
      const text = String((payload as { text?: unknown }).text ?? '')
      const id = ++messageId
      sentIds.push({ id, text })
      return {
        ok: true,
        result: { message_id: id, date: 0, chat: { id: 42, type: 'private' }, text },
      } as never
    }
    return { ok: true, result: true } as never
  })
  /** Every failed turn reuses its single execution card as the retry card. */
  const errorCardId = (index = 0): number => sentIds[index]!.id
  return { bot, calls, seen, diagnostics, errorCardId }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

function sentTexts(calls: Array<{ method: string; payload: Record<string, unknown> }>): string[] {
  return calls.filter((call) => call.method === 'sendMessage')
    .map((call) => String(call.payload['text'] ?? ''))
}

function errorCard(calls: Array<{ method: string; payload: Record<string, unknown> }>) {
  return calls.find((call) =>
    JSON.stringify(call.payload['reply_markup'] ?? '').includes('error:retry'))
}

describe('retrying a failed turn', () => {
  it('AC-02-102 reuses one existing execution card and hides internal detail', async () => {
    const h = harness(1, true)

    await h.bot.handleUpdate(textUpdate('ответь'))
    await settle()

    const sent = h.calls.filter((call) => call.method === 'sendMessage')
    const terminalEdit = [...h.calls].reverse()
      .find((call) => call.method === 'editMessageText')
    const retryMarkup = errorCard(h.calls)
    expect(sent).toHaveLength(1)
    expect(terminalEdit?.payload['text']).toBe('Не получилось ответить. Попробовать ещё раз?')
    expect(JSON.stringify(retryMarkup?.payload['reply_markup'])).toContain('error:retry')
    expect(JSON.stringify(h.calls)).not.toContain('провайдер вернул 502')
    expect(h.diagnostics).toEqual([{ code: 'provider.server-error', errorName: 'ProviderError' }])
    expect(JSON.stringify(h.diagnostics)).not.toContain('провайдер вернул 502')
  })

  it('replays the same message and answers on the second attempt', async () => {
    const h = harness(1)

    await h.bot.handleUpdate(textUpdate('посчитай остаток'))
    await settle()

    const card = errorCard(h.calls)!
    expect(JSON.stringify(card.payload['reply_markup'])).toContain('error:retry')
    const visible = String(card.payload['text'] ?? '')
    expect(visible).toBe('Не получилось ответить. Попробовать ещё раз?')
    expect(visible).not.toContain('провайдер вернул 502')
    expect(visible).not.toContain('общая папка')

    await h.bot.handleUpdate(tap('error:retry', h.errorCardId()))
    await settle()

    expect(h.seen.filter((text) => text === 'посчитай остаток')).toHaveLength(2)
    expect(sentTexts(h.calls)).toContain('готово')
  })

  it('never derives a diagnostic from hostile error name or message', async () => {
    const failure = Object.assign(new Error('UPPERCASE_SECRET_PAYLOAD'), {
      name: 'SecretTokenABC123',
    })
    const h = harness(1, false, failure)

    await h.bot.handleUpdate(textUpdate('ответь'))
    await settle()

    expect(h.diagnostics).toEqual([{ code: 'turn.unclassified', errorName: 'Error' }])
    expect(JSON.stringify(h.diagnostics)).not.toContain('SECRET')
    expect(JSON.stringify(h.diagnostics)).not.toContain('TokenABC123')
  })

  it('retries terminalizing the same card with a working retry button', async () => {
    const failure = Object.assign(new Error('provider secret'), {
      name: 'ProviderError', kind: 'server-error',
    })
    const h = harness(1, true, failure, true)

    await h.bot.handleUpdate(textUpdate('ответь'))
    await settle()

    expect(sentTexts(h.calls)).toEqual(['Работаю…'])
    const terminalEdit = [...h.calls].reverse()
      .find((call) => call.method === 'editMessageText')
    expect(terminalEdit?.payload['text']).toBe('Не получилось ответить. Попробовать ещё раз?')
    expect(JSON.stringify(terminalEdit?.payload['reply_markup'])).toContain('error:retry')
    expect(JSON.stringify(h.calls)).not.toContain('provider secret')
  })

  it('sends a corrective retry card when the stale running card cannot be edited or deleted', async () => {
    const failure = Object.assign(new Error('provider secret'), {
      name: 'ProviderError', kind: 'server-error',
    })
    const h = harness(1, true, failure, false, {
      editMessageText: 2,
      deleteMessage: 1,
    })

    await h.bot.handleUpdate(textUpdate('ответь'))
    await settle()

    expect(sentTexts(h.calls)).toEqual([
      'Работаю…',
      'Не получилось ответить. Попробовать ещё раз?',
    ])
    const retry = errorCard(h.calls)
    expect(retry?.method).toBe('sendMessage')
    expect(JSON.stringify(retry?.payload['reply_markup'])).toContain('error:retry')
    expect(JSON.stringify(h.calls)).not.toContain('provider secret')
  })

  it('takes the button away so a second tap cannot start a third turn', async () => {
    const h = harness(1)
    await h.bot.handleUpdate(textUpdate('посчитай остаток'))
    await settle()

    const cardId = h.errorCardId()
    await h.bot.handleUpdate(tap('error:retry', cardId))
    await settle()
    const attemptsAfterFirst = h.seen.length

    await h.bot.handleUpdate(tap('error:retry', cardId, 91))
    await settle()

    expect(h.calls.some((call) => call.method === 'editMessageReplyMarkup')).toBe(true)
    expect(h.seen).toHaveLength(attemptsAfterFirst)
    expect(sentTexts(h.calls).join('\n')).toContain('уже неактуальна')
  })

  it('refuses a tap on an older error card', async () => {
    const h = harness(2)

    await h.bot.handleUpdate(textUpdate('первое', 1))
    await settle()
    const staleCard = h.errorCardId()
    await h.bot.handleUpdate(textUpdate('второе', 2))
    await settle()

    // The first card is stale: only the newest failure can be replayed.
    await h.bot.handleUpdate(tap('error:retry', staleCard))
    await settle()

    // Only the two original turns ran; the stale tap started nothing.
    expect(h.seen.filter((text) => text === 'первое' || text === 'второе'))
      .toEqual(['первое', 'второе'])
    expect(sentTexts(h.calls).join('\n')).toContain('уже неактуальна')
  })

  it('keeps the retried failure retryable when it fails again', async () => {
    const h = harness(2)

    await h.bot.handleUpdate(textUpdate('посчитай остаток'))
    await settle()
    await h.bot.handleUpdate(tap('error:retry', h.errorCardId()))
    await settle()

    // The retry produced its own error card — with its own live button.
    const cards = h.calls.filter((call) =>
      JSON.stringify(call.payload['reply_markup'] ?? '').includes('error:retry'))
    expect(cards).toHaveLength(2)
    expect(JSON.stringify(cards[1]?.payload['reply_markup'])).toContain('error:retry')
  })
})

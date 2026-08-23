// Screens that ask for one line back.
//
// Two capabilities existed only as typed commands with positional arguments —
// `/bots add <имя> <ПЕРЕМЕННАЯ> <chatId>` and `/access add-key <ключ>`. On a
// phone that is the same as not existing. The buttons open a form: the screen
// asks, the next plain message answers, and the answer runs the same code the
// command ran.

import type { Gateway } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it } from 'vitest'

import { makeTelegramBot, type TelegramBotDeps } from './bot.js'

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
    text: '', receivedAt: '2026-08-11T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'card-1',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

function textUpdate(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id, date: 0,
      chat: { id: 42, type: 'private', first_name: 'Operator' },
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      text,
    },
  }
}

/** `messageId` is the card the tap came from — cards bound to their own message
 *  (the goal proposal) refuse a tap that arrives from any other one. */
function tapUpdate(id: number, data: string, messageId = 900): Update {
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: messageId, date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        text: 'экран',
      },
    },
  }
}

/** What the fake Telegram assigns to everything it sends. */
const SENT_MESSAGE_ID = 777

function harness() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const added: Array<Record<string, unknown>> = []
  const access: Array<{ operation: string; publicKey?: string }> = []
  const confirmed: string[] = []
  const cancelled: string[] = []
  const goals: Array<{ kind: string; objective?: string; mode?: string }> = []
  const agentCardDrafts: Array<{ markdown: string; scope: string }> = []
  const agentCards: NonNullable<TelegramBotDeps['agentCards']> = {
    catalog: () => ({
      configuredName: 'researcher', cutoverActive: false,
      currentBinding: { scope: 'project', projectId: 'p1' },
      projectScopeAvailable: true, legacyImportAvailable: false,
      workspace: [], project: [],
    }),
    detail: (target) => ({ target, active: null, history: [] }),
    createDraft: async ({ markdown, binding }) => {
      agentCardDrafts.push({ markdown, scope: binding.scope })
      return {
        binding,
        name: 'researcher', revision: 1, hash: 'a'.repeat(64), status: 'active',
        provenance: 'published', publishedAt: '2026-08-12T10:00:00Z',
        card: { name: 'researcher', instructions: 'DNA', skills: [], mcpAllowlist: [],
          toolTiers: {}, maxIterations: 8, contextStrategy: 'compact', provenance: 'user' },
      }
    },
    publishDraft: async () => { throw new Error('unused') },
    importLegacy: async () => { throw new Error('unused') },
    archive: async () => { throw new Error('unused') },
    rollback: async () => { throw new Error('unused') },
  }
  let liveGoal: {
    objective: string
    mode: 'until' | 'every' | 'budget'
    status: 'active' | 'completed' | 'halted' | 'stopped'
    iterationsSpent: number
    maxIterations: number
    dollarsSpent: number
    dollarCeiling: number
  } | null = {
    objective: 'собрать проект без ошибок',
    mode: 'until',
    status: 'active',
    iterationsSpent: 2,
    maxIterations: 10,
    dollarsSpent: 0.3,
    dollarCeiling: 2,
  }
  const { bot, proposeTrigger, proposeGoal, goalProgress, researchProgress } = makeTelegramBot({
    onConfirmTrigger: async (id) => { confirmed.push(id); return id !== 'gone' },
    onCancelTrigger: async (id) => { cancelled.push(id); return true },
    captureWorkBinding: async () => ({
      operatorId: 'op', profileId: 'default', projectId: 'p1',
      sessionId: 's1', scope: 'project',
    } as never),
    onGoalCommand: async (input) => {
      goals.push({
        kind: input.kind,
        ...(input.kind === 'start' ? { objective: input.objective, mode: input.mode } : {}),
      })
      if (input.kind === 'stop') { liveGoal = null; return { ok: true, message: '⏹ Цель остановлена.' } }
      if (input.kind === 'start') return { ok: true, message: '🎯 Цель принята (until).' }
      return liveGoal === null
        ? { ok: true, message: 'Активной цели нет.' }
        : { ok: true, message: 'работаю', goal: liveGoal }
    },
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    acquireTurnRuntime: async () => ({
      sessionId: 'session-a',
      runner: { handle: async () => ({ state: 'ok', reply: 'готово', narrowed: false }) },
    }),
    bots: {
      list: () => [],
      activeId: () => null,
      add: (record) => { added.push(record as Record<string, unknown>); return { id: 'b2' } },
      archive: () => ({ id: 'b1' }),
    },
    serverStatus: () => 'Диск 40 %',
    agentCards,
    newAgentCardToken: (() => {
      let token = 0
      return () => `token_${String(++token).padStart(10, '0')}`
    })(),
    serverAccess: {
      available: () => ['open-ssh', 'add-key'],
      request: async (input) => {
        access.push({
          operation: input.operation,
          ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
        })
        return { operation: input.operation, fingerprint: 'SHA256:abc' }
      },
    },
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return {
      ok: true,
      result: { message_id: SENT_MESSAGE_ID, date: 0, chat: { id: 42, type: 'private' }, text: '' },
    } as never
  })
  const sent = (): string[] => calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => String(call.payload['text'] ?? ''))
  return {
    bot, calls, sent, added, access, confirmed, cancelled, goals, agentCardDrafts,
    proposeTrigger, proposeGoal, goalProgress, researchProgress,
  }
}

function keyboardOf(call: { payload: Record<string, unknown> }): string[] {
  const markup = call.payload['reply_markup'] as
    { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
  return (markup?.inline_keyboard ?? []).flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string')
}

describe('a screen that asks for one line', () => {
  it('registers a bot from the line typed after the ➕ button', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:botadd'))
    await h.bot.handleUpdate(textUpdate(2, 'Помощник AISY_HELPER_TOKEN 12345678 отвечает по работе'))

    expect(h.added).toEqual([{
      name: 'Помощник',
      tokenEnv: 'AISY_HELPER_TOKEN',
      chatId: 12345678,
      role: 'отвечает по работе',
    }])
    expect(h.sent().some((text) => text.includes('добавлен'))).toBe(true)
  })

  it('says what is wrong instead of registering half a bot', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:botadd'))
    await h.bot.handleUpdate(textUpdate(2, 'Помощник'))

    expect(h.added).toEqual([])
    expect(h.sent().some((text) => text.includes('четыре слова'))).toBe(true)
  })

  it('carries the typed key into the access request', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:acc:add-key'))
    await h.bot.handleUpdate(textUpdate(2, 'ssh-ed25519 AAAAC3NzaC1lZDI1 operator@phone'))

    expect(h.access).toEqual([{
      operation: 'add-key',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1 operator@phone',
    }])
    expect(h.sent().some((text) => text.includes('SHA256:abc'))).toBe(true)
  })

  it('runs a keyless access operation on the tap itself', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:acc:open-ssh'))

    expect(h.access).toEqual([{ operation: 'open-ssh' }])
    // And the screen comes back, so the operator sees the new state.
    expect(h.sent().some((text) => text.includes('Состояние сервера'))).toBe(true)
  })

  it('deletes and creates the Markdown typed after a tokenized AgentCard scope button', async () => {
    const h = harness()
    const markdown = '---\nname: researcher\n---\nPrivate DNA'

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:open:agent-cards'))
    const create = h.calls.flatMap(keyboardOf).filter(data => data.startsWith('ac:v1:create:'))[1]
    expect(create).toBeDefined()
    await h.bot.handleUpdate(tapUpdate(2, create!, 900))
    await h.bot.handleUpdate(textUpdate(3, markdown))

    expect(h.agentCardDrafts).toEqual([{ markdown, scope: 'project' }])
    expect(h.calls.some((call) => call.method === 'deleteMessage')).toBe(true)
    expect(h.sent().some((text) => text.includes('researcher@1'))).toBe(true)
    expect(h.sent().some((text) => text.includes('Private DNA'))).toBe(false)
  })

  it('turns on an agent-set trigger only when the card is answered', async () => {
    const h = harness()

    await h.proposeTrigger({
      id: 'trg-1', kind: 'schedule', prompt: 'утренняя сводка', detail: 'Расписание: @daily',
    })
    const card = h.calls.find((call) => call.method === 'sendMessage' &&
      String(call.payload['text'] ?? '').includes('утренняя сводка'))!
    expect(keyboardOf(card)).toEqual(['trig:ok:trg-1', 'trig:no:trg-1'])
    expect(String(card.payload['text'])).toContain('Расписание')

    await h.bot.handleUpdate(tapUpdate(1, 'trig:ok:trg-1'))

    expect(h.confirmed).toEqual(['trg-1'])
    expect(h.cancelled).toEqual([])
    expect(h.sent().some((text) => text.includes('Включил'))).toBe(true)
  })

  it('removes the trigger the operator refused instead of parking it', async () => {
    const h = harness()

    await h.proposeTrigger({ id: 'trg-2', kind: 'remind', prompt: 'позвонить', detail: 'Когда: 30m' })
    await h.bot.handleUpdate(tapUpdate(1, 'trig:no:trg-2'))

    expect(h.cancelled).toEqual(['trg-2'])
    expect(h.confirmed).toEqual([])
  })

  it('says so when the card outlived its trigger', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'trig:ok:gone'))

    expect(h.sent().some((text) => text.includes('уже не найти'))).toBe(true)
  })

  it('shows the running goal on its screen and stops it from there', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:open:goals'))
    expect(h.sent().some((text) => text.includes('собрать проект без ошибок'))).toBe(true)
    expect(h.sent().some((text) => text.includes('Итераций: 2 из 10'))).toBe(true)

    await h.bot.handleUpdate(tapUpdate(2, 'cfg:goalstop'))

    expect(h.goals.map((entry) => entry.kind)).toEqual(['status', 'stop', 'status'])
    // The screen redraws empty — that is how the operator knows it is over.
    expect(h.sent().at(-1)).toContain('Активной цели нет')
  })

  it('starts a proposed goal only from its own card', async () => {
    const h = harness()

    await h.proposeGoal({ objective: 'довести тесты до зелёного', mode: 'until' })
    const card = h.calls.find((call) => call.method === 'sendMessage' &&
      String(call.payload['text'] ?? '').includes('довести тесты'))!
    expect(keyboardOf(card)).toEqual(['goal:start', 'goal:drop'])

    await h.bot.handleUpdate(tapUpdate(1, 'goal:start', SENT_MESSAGE_ID))

    expect(h.goals.filter((entry) => entry.kind === 'start')).toEqual([
      { kind: 'start', objective: 'довести тесты до зелёного', mode: 'until' },
    ])
  })

  it('refuses a second tap on a card whose proposal was already answered', async () => {
    const h = harness()

    await h.proposeGoal({ objective: 'довести тесты до зелёного', mode: 'until' })
    await h.bot.handleUpdate(tapUpdate(1, 'goal:drop', SENT_MESSAGE_ID))
    await h.bot.handleUpdate(tapUpdate(2, 'goal:start', SENT_MESSAGE_ID))

    expect(h.goals.some((entry) => entry.kind === 'start')).toBe(false)
    expect(h.sent().some((text) => text.includes('уже неактуально'))).toBe(true)
  })

  it('keeps one live card for the goal and edits it in place', async () => {
    const h = harness()
    const view = {
      objective: 'довести тесты до зелёного',
      mode: 'until' as const,
      status: 'active' as const,
      iterationsSpent: 0,
      maxIterations: 10,
      dollarsSpent: 0,
      dollarCeiling: 2,
    }

    await h.goalProgress(view)
    await h.goalProgress({ ...view, iterationsSpent: 1, dollarsSpent: 0.2 })
    // The same state twice: Telegram refuses an edit that changes nothing.
    await h.goalProgress({ ...view, iterationsSpent: 1, dollarsSpent: 0.2 })

    const sends = h.calls.filter((call) => call.method === 'sendMessage')
    const edits = h.calls.filter((call) => call.method === 'editMessageText')
    expect(sends).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(keyboardOf(sends[0]!)).toContain('cfg:goalstop')
    expect(String(edits[0]?.payload['text'])).toContain('Итераций: 1 из 10')
  })

  it('releases the card when the goal ends, so the next goal gets its own', async () => {
    const h = harness()
    const view = {
      objective: 'довести тесты до зелёного',
      mode: 'until' as const,
      status: 'active' as const,
      iterationsSpent: 1,
      maxIterations: 10,
      dollarsSpent: 0.2,
      dollarCeiling: 2,
    }

    await h.goalProgress(view)
    await h.goalProgress({ ...view, status: 'completed' })
    await h.goalProgress({ ...view, objective: 'следующая цель' })

    const sends = h.calls.filter((call) => call.method === 'sendMessage')
    expect(sends).toHaveLength(2)
    // A finished goal has nothing left to stop.
    const final = h.calls.filter((call) => call.method === 'editMessageText').at(-1)!
    expect(keyboardOf(final)).not.toContain('cfg:goalstop')
  })

  it('keeps one heartbeat card for a research and edits it in place', async () => {
    const h = harness()
    const view = {
      question: 'сравнить харнессы',
      pages: 0,
      maxPages: 12,
      status: 'active' as const,
    }

    await h.researchProgress(view)
    await h.researchProgress({ ...view, pages: 1 })
    // The same state twice: Telegram refuses an edit that changes nothing.
    await h.researchProgress({ ...view, pages: 1 })

    const sends = h.calls.filter((call) => call.method === 'sendMessage')
    const edits = h.calls.filter((call) => call.method === 'editMessageText')
    expect(sends).toHaveLength(1)
    expect(edits).toHaveLength(1)
    expect(String(edits[0]?.payload['text'])).toContain('страниц: 1 из 12')
  })

  it('releases the research card at the end, so the next search gets its own', async () => {
    const h = harness()
    const view = { question: 'вопрос', pages: 4, maxPages: 12, status: 'active' as const }

    await h.researchProgress(view)
    await h.researchProgress({
      ...view, status: 'done' as const,
      note: 'Исследование остановлено по времени.',
    })
    await h.researchProgress({ ...view, question: 'следующий вопрос', pages: 0 })

    const sends = h.calls.filter((call) => call.method === 'sendMessage')
    expect(sends).toHaveLength(2)
    const closing = h.calls.filter((call) => call.method === 'editMessageText').at(0)!
    expect(String(closing.payload['text'])).toContain('по времени')
  })

  it('forgets the form when the operator walks away to another screen', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'cfg:botadd'))
    await h.bot.handleUpdate(tapUpdate(2, 'cfg:open:root'))
    await h.bot.handleUpdate(textUpdate(3, 'Помощник AISY_HELPER_TOKEN 12345678'))

    // The message is an ordinary one now — it must reach the agent, not the
    // registry that stopped waiting for it.
    expect(h.added).toEqual([])
  })
})

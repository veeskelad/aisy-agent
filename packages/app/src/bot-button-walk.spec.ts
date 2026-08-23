// Every button, tapped.
//
// The screens are built from a dozen independent view modules and answered by
// one callback handler, so a button can look right and route nowhere: a data
// prefix nobody decodes, a screen no button opens, a dep the live composition
// never passes. Reading the code does not catch that reliably — walking it does.
//
// The walk taps every reply-keyboard label, then breadth-first every inline
// button that comes back, and demands that each tap produce something visible.
// `answerCallbackQuery` alone does not count: the handler fires it for every
// tap before it decides anything, so a tap that produces only that is exactly
// the silent dead end this test exists to find.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Gateway } from '@aisy/core'
import * as ts from 'typescript'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it } from 'vitest'

import { makeTelegramBot } from './bot.js'
import { MAIN_MENU } from '@aisy/telegram-gw'

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
    text: '', receivedAt: '2026-08-10T00:00:00.000Z',
  }),
  streamReply: async () => {},
  issueCard: async () => 'card-1',
  getIssuedCard: () => null,
  handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
}

let nextMessageId = 1000

interface ApiCall { method: string; payload: Record<string, unknown> }

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

function tapUpdate(id: number, data: string): Update {
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 900, date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' },
        text: 'screen',
      },
    },
  }
}

/**
 * Everything the live binary passes, in the smallest form that still answers.
 * A dep the composition really does omit is left out here too — the walk must
 * see the same screens the operator sees.
 */
function harness(overrides: Record<string, unknown> = {}) {
  const calls: ApiCall[] = []
  const settings = {
    showCostPerTurn: false, budgetEnabled: false, debug: false, timeZone: 'Europe/Moscow',
  }
  const made = makeTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    gateway,
    acquireTurnRuntime: async () => ({
      sessionId: 'session-a',
      runner: { handle: async () => ({ state: 'ok', reply: 'готово', narrowed: false }) },
    }),
    model: 'test-model',
    debounceMs: 1,
    registerCommands: false,
    activeProjectName: () => 'Workspace',
    settings: {
      get: () => ({ ...settings }),
      set: (key: string, value: unknown) => { (settings as Record<string, unknown>)[key] = value },
      toggle: (key: string) => {
        const current = (settings as Record<string, unknown>)[key]
        ;(settings as Record<string, unknown>)[key] = !(current === true)
      },
    } as never,
    spend: {
      record: () => {},
      total: () => ({ dollars: 0.12 }),
      byModel: () => [{ model: 'sonnet', inputTokens: 100, outputTokens: 40, dollars: 0.12 }],
      byAgent: () => [{ agentId: 'main', dollars: 0.12 }],
      recent: () => [],
    } as never,
    dailyBudget: {
      paused: () => false,
      state: () => ({ spent: 0.12, cap: 25 }),
      setCap: () => {},
    },
    executionMode: {
      get: () => 'auto',
      set: () => {},
    },
    transcription: {
      list: () => [{ id: 'deepgram', label: '🎙 Deepgram', audioLeavesHost: true, selected: false }],
      select: (id) => ({ id, label: '🎙 Deepgram', audioLeavesHost: true }),
      selected: () => null,
    },
    serviceKeys: {
      connected: () => ['deepgram'],
      store: async () => ({ ok: true, envKey: 'X', verified: true }),
      storeCustom: () => ({ ok: true, envKey: 'X', verified: false }),
      describe: (id: string) => ({
        label: id, purpose: 'зачем-то', source: 'где-то', envKey: 'X_KEY',
      }),
    } as never,
    brainSelection: () => ({ provider: 'anthropic', model: 'sonnet' }),
    brainModels: () => ['sonnet', 'opus'],
    bots: {
      list: () => [{ id: 'b1', name: 'Aisy', tokenEnv: 'AISY_TELEGRAM_TOKEN', chatId: 42 }],
      activeId: () => 'b1',
      add: () => ({ id: 'b2' }),
      archive: () => ({ id: 'b1' }),
    },
    serverStatus: () => 'Диск 40 %, память 30 %',
    serverAccess: {
      available: () => ['open-ssh', 'close-ssh', 'add-key', 'remove-key', 'tunnel'],
      request: async ({ operation }) => ({ operation, expiresAt: '2026-08-11T12:00:00.000Z' }),
    },
    onConsolidate: async () => {},
    getStaging: async () => [
      { id: 'patch-1', preview: 'запомнить часовой пояс', judged: true },
      { id: 'patch-2', preview: 'ещё не проверено', judged: false },
    ],
    onApproveNightly: async () => {},
    // The four screens the live binary builds from real runtimes. Their own
    // logic has its own specs; here they only have to hand the bot a button and
    // accept it back, which is exactly the routing this walk is checking.
    projectControls: {
      open: async () => ({
        text: '📁 Проекты', buttons: [[{ text: 'Workspace', data: 'project:pick:w' }]],
      }),
      handle: async () => ({
        kind: 'view',
        view: { text: '📁 Проекты', buttons: [[{ text: '← К списку', data: 'project:list' }]] },
      }),
      handleAuthenticatedText: async () => null,
    } as never,
    sessionControls: {
      open: () => ({
        text: '💬 Сессии', buttons: [[{ text: 'Сегодня', data: 'session:open:s1' }]],
      }),
      handle: () => ({
        kind: 'view',
        view: { text: '💬 Сессии', buttons: [[{ text: '← К списку', data: 'session:list' }]] },
      }),
      create: () => ({ kind: 'view', view: { text: 'создана', buttons: [] } }),
      rename: () => ({ kind: 'view', view: { text: 'переименована', buttons: [] } }),
      handleAuthenticatedText: () => null,
    } as never,
    projectLifecycleControls: {
      handle: async () => ({
        kind: 'view',
        view: { text: 'архив', buttons: [] },
      }),
    } as never,
    skillControls: {
      open: () => ({
        text: '🧩 Навыки', buttons: [[{ text: 'inspect', data: 'skill:card:inspect:0' }]],
      }),
      handle: () => ({
        kind: 'view',
        view: { text: 'inspect', buttons: [[{ text: '← К списку', data: 'skill:page:0' }]] },
      }),
      install: () => ({ kind: 'view', view: { text: 'установлен', buttons: [] } }),
    } as never,
    mcpControls: {
      open: () => ({ text: '🔌 MCP', buttons: [[{ text: 'tracker', data: 'mcp:card:tracker' }]] }),
      handle: () => ({
        kind: 'view',
        view: { text: 'tracker', buttons: [[{ text: '← К списку', data: 'mcp:list' }]] },
      }),
      add: async () => ({ kind: 'view', view: { text: 'добавлен', buttons: [] } }),
    } as never,
    startNewSession: async () => ({ ok: true, name: 'Новая' }),
    resumeSession: async () => ({ ok: true }),
    createProject: async () => ({ ok: true, name: 'p', root: '/tmp/p' }),
    reconnectBrain: async () => {},
    restartRuntime: {
      prepare: () => 'перезапуск недоступен в тесте',
      commitExit: () => {},
      cancel: () => {},
    } as never,
    agentCard: () => ({ name: 'general', description: 'основной агент', skills: ['inspect'] }),
    agentCards: {
      catalog: () => ({
        configuredName: 'researcher', cutoverActive: false,
        currentBinding: { scope: 'project', projectId: 'p1' },
        projectScopeAvailable: true, legacyImportAvailable: true,
        workspace: [],
        project: [{
          binding: { scope: 'project', projectId: 'p1' }, name: 'researcher',
          activeRevision: 2, activeHashPrefix: 'abcdef012345', latestRevision: 2,
          latestHashPrefix: 'abcdef012345', latestStatus: 'active', revisionCount: 2,
        }],
      }),
      detail: (target) => ({
        target,
        active: { revision: 2, status: 'active', hashPrefix: 'abcdef012345' },
        history: [
          { revision: 1, status: 'superseded', hashPrefix: '111111111111' },
          { revision: 2, status: 'active', hashPrefix: 'abcdef012345' },
        ],
      }),
      createDraft: async () => { throw new Error('form not submitted by button walk') },
      publishDraft: async () => { throw new Error('form not submitted by button walk') },
      importLegacy: async () => { throw new Error('form not submitted by button walk') },
      archive: async () => ({
        binding: { scope: 'project', projectId: 'p1' }, name: 'researcher', revision: 2,
        hash: 'a'.repeat(64), status: 'archived', provenance: 'published',
        publishedAt: '2026-08-12T10:00:00Z',
        card: { name: 'researcher', instructions: 'DNA', skills: [], mcpAllowlist: [],
          toolTiers: {}, maxIterations: 8, contextStrategy: 'compact', provenance: 'user' },
      }),
      rollback: async () => ({
        binding: { scope: 'project', projectId: 'p1' }, name: 'researcher', revision: 3,
        hash: 'b'.repeat(64), status: 'active', provenance: 'published',
        publishedAt: '2026-08-12T10:00:00Z',
        card: { name: 'researcher', instructions: 'DNA', skills: [], mcpAllowlist: [],
          toolTiers: {}, maxIterations: 8, contextStrategy: 'compact', provenance: 'user' },
      }),
    },
    onGoalCommand: async () => ({
      ok: true,
      message: 'работаю',
      // A goal in flight, so the screen shows its one action and the walk has
      // something to tap; an empty goals screen would hide it.
      goal: {
        objective: 'собрать проект', mode: 'until', status: 'active',
        iterationsSpent: 1, maxIterations: 10, dollarsSpent: 0.1, dollarCeiling: 2,
      },
    }),
    grants: {
      list: () => [],
      revokeAll: () => {},
      has: () => false,
      record: () => {},
      hasSimilar: () => false,
      canRememberSimilar: () => false,
      recordSimilar: () => {},
      revoke: () => {},
    } as never,
    monitoringStatus: () => ({
      available: true, configuredSources: 2, activeSources: 2,
      pausedSources: 0, quarantinedSources: 0,
      collectionActive: true, deliveryActive: true,
    }),
    skillsMenu: () => [{ name: 'inspect', summary: 'Проверить артефакты' }],
    onListTriggers: async () => [],
    sessionLog: { append: () => {}, resume: () => null, recent: () => [] } as never,
    // A dep set to undefined here models a composition that really does omit
    // it — that is the case the silent taps came from.
    ...overrides,
  })
  made.bot.botInfo = BOT_INFO
  made.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === 'sendMessage' || method === 'editMessageText') {
      return {
        ok: true,
        result: {
          message_id: ++nextMessageId, date: 0,
          chat: { id: 42, type: 'private' },
          text: String((payload as { text?: unknown }).text ?? ''),
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  return { ...made, calls }
}

function buttonsOf(call: ApiCall): string[] {
  const markup = call.payload['reply_markup'] as
    { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
  return (markup?.inline_keyboard ?? []).flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string')
}

const VISIBLE = new Set(['sendMessage', 'editMessageText', 'sendDocument', 'deleteMessage'])

// Taps that would end this process or hand it to another one. They are real
// buttons with real handlers; walking them would kill the harness, not test it.
const TERMINAL = /^(?:cfg:(?:restart|reconnect)|ac:v1:)/

describe('every button in the bot', () => {
  it('opens a screen for every menu label', async () => {
    const h = harness()
    let update = 1

    for (const button of MAIN_MENU.flat()) {
      const before = h.calls.length
      await h.bot.handleUpdate(textUpdate(update++, button.label))
      const produced = h.calls.slice(before).filter((call) => VISIBLE.has(call.method))

      expect(produced.length, `«${button.label}» ничего не показала`).toBeGreaterThan(0)
      const text = String(produced[0]?.payload['text'] ?? '')
      // A screen that exists but says the feature is absent is the failure this
      // is looking for — the operator taps and gets a shrug.
      expect(text, `«${button.label}»: ${text}`).not.toMatch(/ещё не подключен|не настроен|недоступн/i)
    }
  })

  it('answers every inline button reachable from the menu', async () => {
    const h = harness()
    let update = 100
    const seen = new Set<string>()
    const queue: string[] = []
    const silent: string[] = []

    const collect = (from: number): void => {
      for (const call of h.calls.slice(from)) {
        for (const data of buttonsOf(call)) {
          if (!seen.has(data) && !TERMINAL.test(data)) {
            seen.add(data)
            queue.push(data)
          }
        }
      }
    }

    for (const button of MAIN_MENU.flat()) {
      const before = h.calls.length
      await h.bot.handleUpdate(textUpdate(update++, button.label))
      collect(before)
    }

    // Bounded: the tree is small, and a runaway walk would mean a cycle we want
    // to see as a failure rather than as a hang.
    for (let step = 0; step < 200 && queue.length > 0; step += 1) {
      const data = queue.shift()!
      const before = h.calls.length
      await h.bot.handleUpdate(tapUpdate(update++, data))
      const produced = h.calls.slice(before)
      if (!produced.some((call) => VISIBLE.has(call.method) ||
        (call.method === 'answerCallbackQuery' && call.payload['text'] !== undefined))) {
        silent.push(data)
      }
      collect(before)
    }

    expect(queue, 'обход не сошёлся — кнопки плодятся по кругу').toHaveLength(0)
    expect(silent, 'кнопки без ответа').toEqual([])
    // A sanity floor: if the walk collapsed to a handful of buttons, the test is
    // no longer walking anything.
    expect(seen.size).toBeGreaterThan(25)
    // The screens whose ports are optional are the ones that silently vanish;
    // name the buttons that must have been reached with those ports wired.
    for (const data of ['cfg:acc:open-ssh', 'cfg:nightly:staged', 'cfg:nightly:run',
      'cfg:botadd', 'cfg:open:goals', 'cfg:goalstop', 'cfg:open:agent-cards',
      'nightly:approve:patch-1']) {
      expect(seen, `кнопка ${data} не встретилась в обходе`).toContain(data)
    }
  })
})

// The walk above only ever taps buttons the bot itself just produced. The chat
// holds older ones too: cards and screens live in memory, so every restart
// leaves a chat full of buttons whose state is gone. Those taps used to return
// in silence — the spinner stops, nothing happens, and the operator taps again.
describe('a tap nobody can answer', () => {
  it('says the button is stale and takes it away', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(1, 'atap|y|card-from-a-previous-run|nonce-1'))

    const toast = h.calls.find((call) => call.method === 'answerCallbackQuery' &&
      call.payload['text'] !== undefined)
    expect(String(toast?.payload['text'] ?? '')).toContain('Экран устарел')
    // The dead button disappears, so the second tap cannot happen at all.
    expect(h.calls.some((call) => call.method === 'editMessageReplyMarkup')).toBe(true)
  })

  it('answers a callback prefix nothing in this build decodes', async () => {
    const h = harness()

    await h.bot.handleUpdate(tapUpdate(2, 'legacy:whatever:42'))

    const toast = h.calls.find((call) => call.method === 'answerCallbackQuery' &&
      call.payload['text'] !== undefined)
    expect(String(toast?.payload['text'] ?? '')).toContain('Экран устарел')
  })

  it('answers a screen whose port this build does not carry', async () => {
    // A composition without MCP still shows whatever buttons were sent earlier.
    const h = harness({ mcpControls: undefined })

    await h.bot.handleUpdate(tapUpdate(3, 'mcp:list'))

    const toast = h.calls.find((call) => call.method === 'answerCallbackQuery' &&
      call.payload['text'] !== undefined)
    expect(String(toast?.payload['text'] ?? '')).toContain('Раздел ещё не подключён')
  })
})

describe('the live binary wires every screen it advertises', () => {
  // The walk above proves the routing; this proves the composition. A screen
  // whose port `bin/aisy.ts` never passes answers "ещё не подключено" in
  // production while every test here stays green.
  const source = ts.createSourceFile(
    'aisy.ts',
    readFileSync(fileURLToPath(new URL('./bin/aisy.ts', import.meta.url)), 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )

  const botDepNames = (): Set<string> => {
    const found = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'makeTelegramBot') {
        const argument = node.arguments[0]
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          for (const property of argument.properties) {
            const name = property.name
            if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
              found.add(name.text)
            }
            // `...(x === null ? {} : { dep: … })` — the dep is conditional but
            // present; take the names out of the spread's own literals.
            if (ts.isSpreadAssignment(property)) {
              const spread = (inner: ts.Node): void => {
                if (ts.isObjectLiteralExpression(inner)) {
                  for (const item of inner.properties) {
                    const key = item.name
                    if (key !== undefined && (ts.isIdentifier(key) || ts.isStringLiteral(key))) {
                      found.add(key.text)
                    }
                  }
                }
                ts.forEachChild(inner, spread)
              }
              spread(property.expression)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return found
  }

  it('passes the port behind every button a screen can show', () => {
    const passed = botDepNames()
    const required = [
      'settings', 'spend', 'dailyBudget', 'executionMode', 'transcription', 'serviceKeys',
      'bots', 'serverStatus', 'monitoringStatus', 'grants', 'agentCard', 'agentCards',
      'projectControls', 'sessionControls', 'projectLifecycleControls',
      'skillControls', 'mcpControls', 'skillsMenu', 'mcpMenu',
      'startNewSession', 'resumeSession', 'createProject',
      'brainSelection', 'brainModels', 'setBrainModel', 'reconnectBrain',
      'restartRuntime', 'serverAccess', 'onListTriggers', 'onCancelTrigger', 'onGoalCommand',
      'onConsolidate', 'getStaging', 'onApproveNightly',
      'onRegisterTrigger', 'onConfirmTrigger',
    ]

    expect([...required].filter((name) => !passed.has(name))).toEqual([])
  })
})

import type { Gateway, PendingAction, TelegramUpdate } from '@aisy/core'
import type { Update, UserFromGetMe } from 'grammy/types'
import { describe, expect, it } from 'vitest'

import { makeTelegramBot } from './bot.js'
import type { AgentCardLifecycleRuntime } from './agent-card-lifecycle-runtime.js'

const BOT_INFO: UserFromGetMe = {
  id: 999, is_bot: true, first_name: 'Aisy', username: 'aisy_test_bot',
  can_join_groups: false, can_read_all_group_messages: false,
  supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false,
  supports_join_request_queries: false,
}

function tapUpdate(id: number, data: string, userId = 7, messageId = 900): Update {
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: userId, is_bot: false, first_name: 'Operator' },
      chat_instance: 'ci', data,
      message: {
        message_id: messageId, date: 0,
        chat: { id: 42, type: 'private', first_name: 'Operator' }, text: 'screen',
      },
    },
  }
}

function textUpdate(id: number, text: string, userId = 7): Update {
  return {
    update_id: id,
    message: {
      message_id: id + 1000, date: 0, text,
      from: { id: userId, is_bot: false, first_name: 'Operator' },
      chat: { id: 42, type: 'private', first_name: 'Operator' },
    },
  }
}

function setup() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const archiveTargets: unknown[] = []
  const createInputs: unknown[] = []
  const importTargets: unknown[] = []
  let dialogueCalls = 0
  let token = 0
  const revision = (status: 'active' | 'archived', number = 2) => ({
    binding: { scope: 'project' as const, projectId: 'project-a' },
    name: 'reviewer', revision: number, hash: 'a'.repeat(64), status,
    provenance: 'published' as const, publishedAt: '2026-08-12T10:00:00Z',
    card: {
      name: 'reviewer', instructions: 'PRIVATE-DNA-MARKER', skills: [], mcpAllowlist: [],
      toolTiers: {}, maxIterations: 8, contextStrategy: 'compact' as const, provenance: 'user' as const,
    },
  })
  const lifecycle: AgentCardLifecycleRuntime = {
    catalog: () => ({
      configuredName: 'main', cutoverActive: false,
      currentBinding: { scope: 'project', projectId: 'project-a' },
      projectScopeAvailable: true, legacyImportAvailable: true,
      workspace: [],
      project: [{
        binding: { scope: 'project', projectId: 'project-a' }, name: 'reviewer',
        activeRevision: 2, activeHashPrefix: 'aaaaaaaaaaaa', latestRevision: 2,
        latestHashPrefix: 'aaaaaaaaaaaa', latestStatus: 'active', revisionCount: 2,
      }],
    }),
    detail: target => ({
      target,
      active: { revision: 2, status: 'active', hashPrefix: 'aaaaaaaaaaaa' },
      history: [
        { revision: 1, status: 'superseded', hashPrefix: 'bbbbbbbbbbbb' },
        { revision: 2, status: 'active', hashPrefix: 'aaaaaaaaaaaa' },
      ],
    }),
    createDraft: async input => {
      createInputs.push({ markdown: input.markdown, binding: input.binding })
      return { ...revision('active', 1), binding: input.binding, name: 'alpha' }
    },
    publishDraft: async () => revision('active', 3),
    archive: async input => {
      if (!('target' in input)) throw new Error('exact target required')
      archiveTargets.push(input.target)
      await Promise.resolve()
      return revision('archived')
    },
    rollback: async () => revision('active', 3),
    importLegacy: async input => {
      importTargets.push(input.target)
      return { ...revision('active', 1), binding: input.target.binding, name: input.target.name }
    },
  }
  const gateway: Gateway = {
    onUpdate: async (_update: TelegramUpdate) => {
      dialogueCalls += 1
      return {
        spanId: 'span-1', chatId: 42, channel: 'text', provenance: 'operator',
        text: 'dialogue', receivedAt: '2026-08-12T10:00:00.000Z',
      }
    },
    streamReply: async () => {},
    issueCard: async (_action: PendingAction) => 'approval-card',
    getIssuedCard: () => null,
    handleCardTap: async () => ({ decision: 'rejected', reason: 'unused' }),
  }
  const { bot } = makeTelegramBot({
    token: 'test-token', allowedChatId: 42, gateway, model: 'test-model',
    registerCommands: false, debounceMs: 1,
    acquireTurnRuntime: async () => ({
      sessionId: 'session-a',
      runner: { handle: async () => ({ state: 'ok', reply: 'готово', narrowed: false }) },
    }),
    captureWorkBinding: async () => ({
      operatorId: 'operator', profileId: 'default', projectId: 'project-a',
      sessionId: 'session-a', scope: 'project',
    }),
    agentCards: lifecycle,
    newAgentCardToken: () => `token_${String(++token).padStart(10, '0')}`,
    agentCardNowMs: () => 1_000,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return {
      ok: true,
      result: { message_id: 777, date: 0, chat: { id: 42, type: 'private' }, text: '' },
    } as never
  })
  const latest = (prefix: string): string => {
    for (const call of [...calls].reverse()) {
      const markup = call.payload['reply_markup'] as
        { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
      const found = (markup?.inline_keyboard ?? []).flat()
        .map(button => button.callback_data)
        .find(data => typeof data === 'string' && data.startsWith(prefix))
      if (found) return found
    }
    throw new Error(`missing button ${prefix}`)
  }
  return { bot, calls, latest, archiveTargets, createInputs, importTargets, dialogue: () => dialogueCalls }
}

describe('live tokenized AgentCard catalog', () => {
  it('spends one of two concurrent archive taps before lifecycle approval', async () => {
    const h = setup()
    await h.bot.handleUpdate(tapUpdate(1, 'cfg:open:agent-cards'))
    await h.bot.handleUpdate(tapUpdate(2, h.latest('ac:v1:select:')))
    const archive = h.latest('ac:v1:archive:')
    await Promise.all([
      h.bot.handleUpdate(tapUpdate(3, archive)),
      h.bot.handleUpdate(tapUpdate(4, archive)),
    ])
    expect(h.archiveTargets).toEqual([{
      binding: { scope: 'project', projectId: 'project-a' }, name: 'reviewer',
    }])
    expect(h.calls.some(call => call.method === 'answerCallbackQuery' &&
      call.payload['text'] === 'Экран устарел — открой раздел заново.')).toBe(true)
  })

  it('ignores a foreign form answer and consumes the exact principal answer once', async () => {
    const h = setup()
    await h.bot.handleUpdate(tapUpdate(1, 'cfg:open:agent-cards'))
    const createButtons = h.calls.flatMap(call => {
      const markup = call.payload['reply_markup'] as
        { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
      return (markup?.inline_keyboard ?? []).flat().map(button => button.callback_data)
        .filter((data): data is string => typeof data === 'string' && data.startsWith('ac:v1:create:'))
    })
    await h.bot.handleUpdate(tapUpdate(2, createButtons[1]!))
    await h.bot.handleUpdate(textUpdate(3, 'PRIVATE-DNA-MARKER', 8))
    expect(h.createInputs).toEqual([])
    expect(h.dialogue()).toBe(0)
    await Promise.all([
      h.bot.handleUpdate(textUpdate(4, 'PRIVATE-DNA-MARKER', 7)),
      h.bot.handleUpdate(textUpdate(5, 'PRIVATE-DNA-MARKER', 7)),
    ])
    expect(h.createInputs).toHaveLength(1)
    expect(h.calls.filter(call => call.method === 'deleteMessage')).toHaveLength(1)
    expect(JSON.stringify(h.calls)).not.toContain('PRIVATE-DNA-MARKER')
  })

  it('imports only the exact typed legacy name and keeps identities out of callbacks', async () => {
    const h = setup()
    await h.bot.handleUpdate(tapUpdate(1, 'cfg:open:agent-cards'))
    await h.bot.handleUpdate(tapUpdate(2, h.latest('ac:v1:import:')))
    await h.bot.handleUpdate(textUpdate(3, 'legacy-worker'))
    expect(h.importTargets).toEqual([{
      binding: { scope: 'workspace' }, name: 'legacy-worker',
    }])
    const callbacks = h.calls.flatMap(call => {
      const markup = call.payload['reply_markup'] as
        { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
      return (markup?.inline_keyboard ?? []).flat().map(button => button.callback_data).filter(Boolean)
    })
    expect(JSON.stringify(callbacks)).not.toContain('project-a')
    expect(JSON.stringify(callbacks)).not.toContain('reviewer')
  })
})

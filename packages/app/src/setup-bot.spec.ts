import { describe, expect, it } from 'vitest'
import type { Update, UserFromGetMe } from 'grammy/types'
import {
  makeBrainBootstrap,
  makeBrainBootstrapCoordinator,
  type BrainBootstrapState,
  type BrainConnectionSetupDriver,
} from '@aisy/core'
import { makeSetupTelegramBot } from './setup-bot.js'

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
      ...(text.startsWith('/')
        ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.length }] }
        : {}),
    },
  }
}

function callbackUpdate(updateId: number, chatId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: 'callback-' + updateId,
      chat_instance: 'test',
      from: { id: chatId, is_bot: false, first_name: 'Operator' },
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: chatId, type: 'private', first_name: 'Operator' },
        text: 'setup',
      },
    },
  }
}

function makeHarness(driver?: BrainConnectionSetupDriver, extra?: {
  onBrainReady?: () => void
}) {
  let persisted: BrainBootstrapState | null = null
  const bootstrap = makeBrainBootstrap({
    store: {
      load: async () => persisted,
      save: async (state) => { persisted = structuredClone(state) },
    },
    nowIso: () => '2026-07-26T00:00:00.000Z',
  })
  const calls: Array<{ method: string; payload: unknown }> = []
  const { bot } = makeSetupTelegramBot({
    token: 'test-token',
    allowedChatId: 42,
    bootstrap,
    ...(driver === undefined
      ? {}
      : { coordinator: makeBrainBootstrapCoordinator({ bootstrap, drivers: [driver] }) }),
    ...extra,
    registerCommands: false,
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    return { ok: true, result: true } as never
  })
  return { bot, bootstrap, calls }
}

describe('setup-only Telegram transport', () => {
  it('ignores an unpaired chat before any state or API action', async () => {
    const { bot, bootstrap, calls } = makeHarness()
    await bot.handleUpdate(textUpdate(1, 777, '/start'))
    expect(calls).toEqual([])
    expect((await bootstrap.state()).phase).toBe('NO_BRAIN')
  })

  it('starts deterministic setup for the paired chat without a runner/provider', async () => {
    const { bot, bootstrap, calls } = makeHarness()
    await bot.handleUpdate(textUpdate(1, 42, '/start'))
    expect((await bootstrap.state()).phase).toBe('CHOOSE_BRAIN')
    const send = calls.find((call) => call.method === 'sendMessage')
    expect(send?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining('Подключим первый мозг'),
    })
  })

  it('routes an allowlisted brain callback and fails closed on replay', async () => {
    const { bot, bootstrap, calls } = makeHarness()
    await bot.handleUpdate(textUpdate(1, 42, '/start'))
    await bot.handleUpdate(callbackUpdate(2, 42, 'bootstrap:brain:codex-subscription:1'))
    const selected = await bootstrap.state()
    expect(selected.phase).toBe('INSTALLING_RUNTIME')
    expect(selected.selectedBrain?.runtime).toBe('codex-app-server')

    await bot.handleUpdate(callbackUpdate(3, 42, 'bootstrap:brain:codex-subscription:1'))
    expect((await bootstrap.state()).revision).toBe(selected.revision)
    expect(calls.some((call) => call.method === 'editMessageText')).toBe(true)
  })

  it('keeps free-form text in code-owned setup and removes a stale reply keyboard', async () => {
    const { bot, bootstrap, calls } = makeHarness()
    await bot.handleUpdate(textUpdate(1, 42, 'Сделай задачу'))
    expect((await bootstrap.state()).phase).toBe('NO_BRAIN')
    const send = calls.find((call) => call.method === 'sendMessage')
    expect(send?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining('подключаем первый мозг'),
      reply_markup: { remove_keyboard: true },
    })
  })

  it('drives detect, official challenge and validation through revision-bound callbacks', async () => {
    const calls: string[] = []
    const driver: BrainConnectionSetupDriver = {
      connectionId: 'codex-subscription',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      detect: async () => { calls.push('detect'); return { installed: true } },
      install: async () => { calls.push('install'); return { installed: true, safeDetail: 'ok' } },
      beginAuth: async () => {
        calls.push('beginAuth')
        return {
          kind: 'device-code',
          verificationUri: 'https://auth.example/activate',
          userCode: 'ABCD-1234',
        }
      },
      validate: async () => { calls.push('validate'); return { ok: true, safeDetail: 'ok' } },
      revoke: async () => ({ ok: true, safeDetail: 'ok' }),
    }
    const { bot, bootstrap, calls: apiCalls } = makeHarness(driver)
    await bot.handleUpdate(textUpdate(1, 42, '/start'))
    await bot.handleUpdate(callbackUpdate(2, 42, 'bootstrap:brain:codex-subscription:1'))
    expect(await bootstrap.state()).toMatchObject({ phase: 'AWAITING_AUTH', revision: 3 })
    expect(calls).toEqual(['detect'])

    await bot.handleUpdate(callbackUpdate(3, 42, 'bootstrap:advance:begin-auth:3'))
    expect(calls).toEqual(['detect', 'beginAuth'])
    expect(apiCalls.some((call) => call.method === 'editMessageText' &&
      String((call.payload as { text?: unknown }).text ?? '').includes('ABCD-1234'))).toBe(true)

    await bot.handleUpdate(callbackUpdate(4, 42, 'bootstrap:advance:begin-auth:3'))
    expect(calls).toEqual(['detect', 'beginAuth'])
    expect((await bootstrap.state()).revision).toBe(3)

    await bot.handleUpdate(callbackUpdate(5, 42, 'bootstrap:advance:complete-auth:3'))
    expect(calls).toEqual(['detect', 'beginAuth', 'validate'])
    expect(await bootstrap.state()).toMatchObject({ phase: 'BRAIN_READY', revision: 5 })
  })

  it('never accepts an API key from Telegram and does not advance bootstrap', async () => {
    const { bot, bootstrap, calls } = makeHarness()
    await bot.handleUpdate(textUpdate(1, 42, '/start'))
    await bot.handleUpdate(callbackUpdate(2, 42, 'bootstrap:brain:openrouter-api:1'))
    expect(await bootstrap.state()).toMatchObject({
      phase: 'AWAITING_AUTH',
      selectedBrain: { authMode: 'api-key', provider: 'openrouter' },
    })

    await bot.handleUpdate(textUpdate(3, 42, 'sk-or-fixture-secret'))
    expect(calls.some((call) => call.method === 'deleteMessage')).toBe(true)
    expect(JSON.stringify(calls.map((call) => call.payload)))
      .not.toContain('sk-or-fixture-secret')
    expect(await bootstrap.state()).toMatchObject({
      phase: 'AWAITING_AUTH',
      selectedBrain: { authMode: 'api-key', provider: 'openrouter' },
    })
    expect(calls.some((call) => call.method === 'sendMessage' &&
      String((call.payload as { text?: unknown }).text ?? '').includes('Ввод API-ключа в Telegram отключён')))
      .toBe(true)
  })

  it('hands over to the agent only after the operator has seen the card', async () => {
    const order: string[] = []
    const driver: BrainConnectionSetupDriver = {
      connectionId: 'codex-subscription',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
      detect: async () => ({ installed: true }),
      install: async () => ({ installed: true, safeDetail: 'ok' }),
      beginAuth: async () => ({
        kind: 'device-code',
        verificationUri: 'https://auth.example/activate',
        userCode: 'ABCD-1234',
      }),
      validate: async () => ({ ok: true, safeDetail: 'ok' }),
      revoke: async () => ({ ok: true, safeDetail: 'ok' }),
    }
    const { bot, bootstrap } = makeHarness(driver, {
      onBrainReady: () => { order.push('handover') },
    })
    await bot.handleUpdate(textUpdate(1, 42, '/start'))
    await bot.handleUpdate(callbackUpdate(2, 42, 'bootstrap:brain:codex-subscription:1'))
    await bot.handleUpdate(callbackUpdate(3, 42, 'bootstrap:advance:begin-auth:3'))
    await bot.handleUpdate(callbackUpdate(4, 42, 'bootstrap:advance:complete-auth:3'))
    const ready = await bootstrap.state()
    expect(order).toEqual([])

    await bot.handleUpdate(callbackUpdate(5, 42, `bootstrap:advance:start-intro:${ready.revision}`))
    expect(order).toEqual(['handover'])
    // Setup is finished as a state machine; the interview belongs to the agent.
    expect((await bootstrap.state()).phase).toBe('COMPLETE')
  })
})

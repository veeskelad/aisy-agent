import { describe, expect, it } from 'vitest'

import {
  TelegramAgentCardStateError,
  makeTelegramAgentCardState,
  type AgentCardIntent,
} from './telegram-agent-card-state.js'

const P = { chatId: 1, userId: 1 } as const
const SELECT = {
  kind: 'select',
  target: { binding: { scope: 'workspace' }, name: 'researcher' },
} as const

function fixture() {
  let nowMs = 1_000
  let sequence = 0
  const state = makeTelegramAgentCardState({
    nowMs: () => nowMs,
    newToken: () => `token_${String(++sequence).padStart(10, '0')}`,
  })
  return { state, advance: (value: number) => { nowMs += value } }
}

describe('Telegram AgentCard ephemeral state', () => {
  it('binds one-shot callbacks to exact principal and message', () => {
    const { state } = fixture()
    const prepared = state.prepare({ principal: P, intents: [SELECT] })
    expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
    prepared.bind(77)
    expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toEqual(SELECT)
    expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
  })

  it('does not retire a token for wrong principal or message', () => {
    const { state } = fixture()
    const prepared = state.prepare({ principal: P, intents: [SELECT] })
    prepared.bind(77)
    const callback = prepared.callbacks[0]!
    expect(state.claimCallback({ principal: { chatId: 2, userId: 1 }, messageId: 77, ...callback })).toBeNull()
    expect(state.claimCallback({ principal: { chatId: 1, userId: 2 }, messageId: 77, ...callback })).toBeNull()
    expect(state.claimCallback({ principal: P, messageId: 78, ...callback })).toBeNull()
    expect(state.claimCallback({ principal: P, messageId: 77, ...callback })).toEqual(SELECT)
  })

  it('retires the previous generation and supports discard before bind', () => {
    const { state } = fixture()
    const first = state.prepare({ principal: P, intents: [SELECT] })
    first.bind(77)
    const second = state.prepare({ principal: P, intents: [SELECT] })
    second.bind(78)
    expect(state.claimCallback({ principal: P, messageId: 77, ...first.callbacks[0]! })).toBeNull()
    second.discard()
    expect(state.claimCallback({ principal: P, messageId: 78, ...second.callbacks[0]! })).toBeNull()
  })

  it('maps every intent to its exact callback verb and snapshots targets', () => {
    const { state } = fixture()
    const intents: AgentCardIntent[] = [
      { kind: 'catalog', workspacePage: 0, projectPage: 1 },
      { kind: 'page', workspacePage: 1, projectPage: 0 },
      SELECT,
      { kind: 'create', binding: { scope: 'workspace' } },
      { kind: 'import', binding: { scope: 'workspace' } },
      { kind: 'publish', target: SELECT.target },
      { kind: 'archive', target: SELECT.target },
      { kind: 'rollback', target: SELECT.target },
    ]
    const prepared = state.prepare({ principal: P, intents })
    expect(prepared.callbacks.map(item => item.verb)).toEqual([
      'catalog', 'page', 'select', 'create', 'import', 'publish', 'archive', 'rollback',
    ])
    expect(prepared.callbacks.every(item => /^[A-Za-z0-9_-]{16,24}$/.test(item.token))).toBe(true)
    expect(Object.isFrozen(prepared.callbacks)).toBe(true)
  })

  it('atomically replaces and claims one form per principal', () => {
    const { state } = fixture()
    const first = state.openForm({
      principal: P, operation: 'create', binding: { scope: 'workspace' }, target: null,
    })
    const second = state.openForm({
      principal: P, operation: 'import-legacy', binding: { scope: 'workspace' }, target: null,
    })
    expect(second.formId).not.toBe(first.formId)
    expect(state.claimForm({ chatId: 1, userId: 2 })).toEqual({ kind: 'foreign' })
    const claimed = state.claimForm(P)
    expect(claimed).toMatchObject({ kind: 'claimed', form: second })
    expect(state.claimForm(P)).toEqual({ kind: 'busy' })
    if (claimed.kind !== 'claimed') throw new Error('claimed form expected')
    claimed.finish()
    claimed.finish()
    expect(state.claimForm(P)).toEqual({ kind: 'none' })
  })

  it('expires tokens and forms without durable resurrection', () => {
    const { state, advance } = fixture()
    const prepared = state.prepare({ principal: P, intents: [SELECT] })
    prepared.bind(77)
    state.openForm({
      principal: P, operation: 'create', binding: { scope: 'workspace' }, target: null,
    })
    advance(5 * 60_000 + 1)
    expect(state.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
    expect(state.claimForm(P)).toEqual({ kind: 'none' })
    const restarted = makeTelegramAgentCardState({
      nowMs: () => 999_999,
      newToken: () => 'token_0000000001',
    })
    expect(restarted.claimForm(P)).toEqual({ kind: 'none' })
    expect(restarted.claimCallback({ principal: P, messageId: 77, ...prepared.callbacks[0]! })).toBeNull()
  })

  it('invalidates only one principal and rejects duplicate or malformed token sources', () => {
    const { state } = fixture()
    const other = { chatId: 2, userId: 2 }
    const first = state.prepare({ principal: P, intents: [SELECT] })
    const second = state.prepare({ principal: other, intents: [SELECT] })
    first.bind(1)
    second.bind(2)
    state.invalidate(P)
    expect(state.claimCallback({ principal: P, messageId: 1, ...first.callbacks[0]! })).toBeNull()
    expect(state.claimCallback({ principal: other, messageId: 2, ...second.callbacks[0]! })).toEqual(SELECT)

    const duplicate = makeTelegramAgentCardState({ nowMs: () => 0, newToken: () => 'token_0000000001' })
    duplicate.prepare({ principal: P, intents: [SELECT] })
    expect(() => duplicate.prepare({ principal: P, intents: [SELECT] }))
      .toThrowError(expect.objectContaining({ code: 'TOKEN_REUSED' }))
    const malformed = makeTelegramAgentCardState({ nowMs: () => 0, newToken: () => 'short' })
    expect(() => malformed.prepare({ principal: P, intents: [SELECT] }))
      .toThrow(TelegramAgentCardStateError)
  })

  it('bounds one generation to 64 intents', () => {
    const { state } = fixture()
    expect(() => state.prepare({ principal: P, intents: Array(65).fill(SELECT) }))
      .toThrowError(expect.objectContaining({ code: 'TOO_MANY_INTENTS' }))
  })
})

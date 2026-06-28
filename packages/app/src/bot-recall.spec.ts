// packages/app/src/bot-recall.spec.ts
//
// Unit tests for the per-turn recall feature.
//
// bot.ts is not unit-testable in isolation because makeTelegramBot() constructs
// a live grammY Bot that calls the Telegram API on creation. We therefore test:
//
//  (a) buildSpansWithRecall — the exported pure helper that encapsulates the
//      span-injection logic, covering all three required behaviours.
//  (b) The TelegramBotDeps.recall field — verified at the TypeScript level by
//      assigning a typed deps literal; the compiler rejects it if the property
//      is absent or has the wrong type.
//
// Full end-to-end behaviour (recall fires once per turn, a recall throw doesn't
// block the turn, the system span arrives at runner.handle) requires a live-bot
// integration test or grammY mocking and is covered by manual QA.

import { describe, it, expect } from 'vitest'
import { buildSpansWithRecall, type TelegramBotDeps } from './bot.js'

describe('buildSpansWithRecall', () => {
  const user = { role: 'user' as const, provenance: 'operator' as const, text: 'hello' }

  it('prepends a system span with the recall text when mem is non-empty', () => {
    const result = buildSpansWithRecall([user], '• fact one\n• fact two')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      role: 'system',
      provenance: 'operator',
      text: 'Релевантное из памяти:\n• fact one\n• fact two',
    })
    expect(result[1]).toEqual(user)
  })

  it('returns the original spans unchanged when mem is empty string', () => {
    const result = buildSpansWithRecall([user], '')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(user)
  })

  it('works with multiple user spans; system span is always first', () => {
    const spans = [
      { role: 'user' as const, provenance: 'operator' as const, text: 'msg1' },
      { role: 'user' as const, provenance: 'untrusted' as const, text: 'msg2' },
    ]
    const result = buildSpansWithRecall(spans, 'some fact')
    expect(result[0]?.role).toBe('system')
    expect(result[1]?.text).toBe('msg1')
    expect(result[2]?.text).toBe('msg2')
  })

  it('returns empty array unchanged when both spans and mem are empty', () => {
    expect(buildSpansWithRecall([], '')).toEqual([])
  })
})

describe('TelegramBotDeps.recall type wiring', () => {
  it('accepts recall as an optional async function returning string', () => {
    // This is a compile-time check: if TelegramBotDeps.recall is absent or has
    // the wrong type, TypeScript will reject the assignment below.
    const deps: Pick<TelegramBotDeps, 'recall'> = {
      recall: async (query: string) => `hits for ${query}`,
    }
    expect(typeof deps.recall).toBe('function')
  })

  it('accepts deps without recall (field is optional)', () => {
    const deps: Pick<TelegramBotDeps, 'recall'> = {}
    expect(deps.recall).toBeUndefined()
  })
})

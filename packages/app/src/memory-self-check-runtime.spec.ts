import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_PROJECTION_LIMIT_BYTES,
  SESSION_CONSOLIDATION_MESSAGES,
  projectionHealth,
  type MemoryNotice,
} from '@aisy/core'

import { makeMemorySelfCheckRuntime } from './memory-self-check-runtime.js'

const over = () => ({
  ...projectionHealth('x'.repeat(MEMORY_PROJECTION_LIMIT_BYTES + 1)),
  truncated: true,
})

function runtime(profileBytes: () => number = () => 128) {
  const emitted: MemoryNotice[] = []
  const check = makeMemorySelfCheckRuntime({
    operatorProfileBytes: profileBytes,
    emit: (notice) => emitted.push(notice),
  })
  return { check, emitted }
}

describe('per-turn memory self-check runtime (ADR-0078)', () => {
  it('says nothing about a projection it has never read', () => {
    const { check, emitted } = runtime()
    expect(check.check({ sessionMessages: 2 })).toEqual([])
    expect(emitted).toEqual([])
  })

  it('reports the projection once it has been observed', () => {
    const { check, emitted } = runtime()
    check.observeProjection(over())

    expect(check.check({ sessionMessages: 2 }).map((n) => n.code)).toEqual(['projection-over'])
    expect(emitted).toHaveLength(1)
  })

  it('does not repeat the same situation every turn', () => {
    const { check, emitted } = runtime()
    check.observeProjection(over())

    for (let turn = 0; turn < 5; turn += 1) check.check({ sessionMessages: 2 })

    expect(emitted).toHaveLength(1)
    // …but the caller still sees the current state on every turn.
    expect(check.check({ sessionMessages: 2 })).toHaveLength(1)
  })

  it('speaks up again when the situation changes', () => {
    const { check, emitted } = runtime()
    check.observeProjection(over())
    check.check({ sessionMessages: 2 })

    check.check({ sessionMessages: 40 })

    expect(emitted.map((n) => n.code)).toEqual([
      'projection-over',
      'projection-over',
      'session-consolidate',
    ])
  })

  it('stays silent about an unreadable profile rather than guessing it is empty', () => {
    const { check, emitted } = runtime(() => { throw new Error('EACCES') })
    expect(check.check({ sessionMessages: 1 })).toEqual([])
    expect(emitted).toEqual([])
  })

  it('survives a journal that refuses the notice', () => {
    const check = makeMemorySelfCheckRuntime({
      operatorProfileBytes: () => 0,
      emit: vi.fn(() => { throw new Error('journal is down') }),
    })
    expect(() => check.check({ sessionMessages: 1 })).not.toThrow()
  })
})

describe('flushing the session to the daily journal (ADR-0079)', () => {
  function withFlush() {
    const flushes: number[] = []
    const check = makeMemorySelfCheckRuntime({
      operatorProfileBytes: () => 128,
      emit: () => {},
      onConsolidate: (messages) => flushes.push(messages),
    })
    return { check, flushes }
  }

  it('does not flush a short session', () => {
    const { check, flushes } = withFlush()
    check.check({ sessionMessages: SESSION_CONSOLIDATION_MESSAGES - 1 })
    expect(flushes).toEqual([])
  })

  it('flushes once per threshold crossed, not once per turn', () => {
    const { check, flushes } = withFlush()

    for (let messages = 1; messages <= SESSION_CONSOLIDATION_MESSAGES * 2; messages += 1) {
      check.check({ sessionMessages: messages })
    }

    expect(flushes).toEqual([SESSION_CONSOLIDATION_MESSAGES, SESSION_CONSOLIDATION_MESSAGES * 2])
  })

  it('survives a journal that cannot be written', () => {
    const check = makeMemorySelfCheckRuntime({
      operatorProfileBytes: () => 128,
      emit: () => {},
      onConsolidate: () => { throw new Error('ENOSPC') },
    })
    expect(() => check.check({ sessionMessages: SESSION_CONSOLIDATION_MESSAGES })).not.toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import { makeGuardian } from './guardian.js'
import type { ToolCall } from '../agent-loop/types.js'

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, args })

function observeAll(g: ReturnType<typeof makeGuardian>, calls: ToolCall[]) {
  return calls.map((c) => g.observe(c))
}

describe('makeGuardian', () => {
  it('does not trip on varied calls', () => {
    const g = makeGuardian()
    const verdicts = observeAll(g, [call('a'), call('b'), call('c'), call('d')])
    expect(verdicts.every((v) => !v.trip)).toBe(true)
  })

  it('trips period-1 on the same call repeated 3×', () => {
    const g = makeGuardian()
    const v = observeAll(g, [call('read_file', { p: 'x' }), call('read_file', { p: 'x' }), call('read_file', { p: 'x' })])
    expect(v[2]).toEqual({ trip: true, period: 1 })
  })

  it('does not trip when the same tool has different args', () => {
    const g = makeGuardian()
    const v = observeAll(g, [call('read_file', { p: '1' }), call('read_file', { p: '2' }), call('read_file', { p: '3' })])
    expect(v.every((x) => !x.trip)).toBe(true)
  })

  it('trips period-2 on an A,B,A,B,A,B oscillation', () => {
    const g = makeGuardian()
    const v = observeAll(g, [call('a'), call('b'), call('a'), call('b'), call('a'), call('b')])
    expect(v[5]).toEqual({ trip: true, period: 2 })
    expect(v.slice(0, 5).every((x) => !x.trip)).toBe(true)
  })

  it('note(replan) resets the window so a prior pattern does not carry over', () => {
    const g = makeGuardian()
    g.observe(call('a'))
    g.observe(call('a'))
    g.note('replan')
    // only one more 'a' after reset → not yet 3 in a row
    expect(g.observe(call('a')).trip).toBe(false)
  })

  it('respects a custom repeats threshold', () => {
    const g = makeGuardian({ repeats: 2 })
    const v = observeAll(g, [call('x'), call('x')])
    expect(v[1]).toEqual({ trip: true, period: 1 })
  })
})

import { describe, it, expect } from 'vitest'
import { makeScheduler } from './scheduler.js'

function deps(over = {}) {
  const calls = { nightly: 0, ticks: 0, marked: [] as string[] }
  let last: string | null = null
  return {
    calls,
    d: {
      now: () => new Date('2026-06-22T04:00:00'),  // after 03:30
      nightlyAt: '03:30',
      lastNightlyRun: () => last,
      markNightlyRun: (date: string) => { last = date; calls.marked.push(date) },
      runNightly: async () => { calls.nightly++ },
      tickTriggers: async () => { calls.ticks++ },
      setInterval: (_fn: () => void, _ms: number) => 0,
      ...over,
    },
  }
}

describe('makeScheduler', () => {
  it('pump runs triggers every cycle and the nightly once per day when the slot has passed (catch-up)', async () => {
    const { calls, d } = deps()
    const s = makeScheduler(d)
    await s.pump()
    expect(calls.ticks).toBe(1)
    expect(calls.nightly).toBe(1)          // 04:00 >= 03:30 and not run today → catch-up fires
    await s.pump()
    expect(calls.ticks).toBe(2)
    expect(calls.nightly).toBe(1)          // already marked today → not re-run
  })
  it('does not run the nightly before its slot', async () => {
    const { calls, d } = deps({ now: () => new Date('2026-06-22T02:00:00') }) // before 03:30
    const s = makeScheduler(d)
    await s.pump()
    expect(calls.ticks).toBe(1)
    expect(calls.nightly).toBe(0)
  })
  it('a throwing runNightly does not break the loop (next pump still ticks triggers)', async () => {
    const { calls, d } = deps({ runNightly: async () => { throw new Error('boom') } })
    const s = makeScheduler(d)
    await s.pump()                          // nightly throws, swallowed
    expect(calls.ticks).toBe(1)
    await s.pump()
    expect(calls.ticks).toBe(2)
  })
})

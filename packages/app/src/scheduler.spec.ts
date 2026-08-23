import { describe, it, expect } from 'vitest'
import { makeScheduler } from './scheduler.js'
import type { ResolvedWorkBinding } from '@aisy/core'

const BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'workspace-1',
  sessionId: 'nightly-system-1',
  scope: 'workspace' as const,
}

function deps(over = {}) {
  const calls = { nightly: 0, ticks: 0, marked: [] as string[], bindings: [] as unknown[] }
  let last: string | null = null
  return {
    calls,
    d: {
      now: () => new Date('2026-06-22T04:00:00'),  // after 03:30
      nightlyAt: '03:30',
      lastNightlyRun: () => last,
      markNightlyRun: (date: string) => { last = date; calls.marked.push(date) },
      resolveNightlyBinding: () => BINDING,
      runNightly: async (binding: ResolvedWorkBinding) => {
        calls.nightly++
        calls.bindings.push(binding)
      },
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
    expect(calls.bindings).toEqual([BINDING])
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

  it('does not run or mark nightly when the persisted binding is quarantined', async () => {
    const { calls, d } = deps({ resolveNightlyBinding: () => null })
    const s = makeScheduler(d)
    await s.pump()
    expect(calls.nightly).toBe(0)
    expect(calls.marked).toEqual([])
  })

  it('runs optional monitoring every cycle and isolates its failure from nightly', async () => {
    let monitoring = 0
    const { calls, d } = deps({
      tickMonitoring: async () => {
        monitoring++
        if (monitoring === 1) throw new Error('monitor unavailable')
      },
    })
    const s = makeScheduler(d)

    await s.pump()
    expect(monitoring).toBe(1)
    expect(calls.nightly).toBe(1)
    await s.pump()
    expect(monitoring).toBe(2)
    expect(calls.ticks).toBe(2)
  })
})

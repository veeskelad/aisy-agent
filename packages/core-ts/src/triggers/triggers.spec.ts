import { describe, it, expect } from 'vitest'
import { MAX_LIVE_TRIGGERS, makeTriggerEngine } from './index.js'
import { fakeClock } from '../testing/index.js'
import type {
  TriggerSpec,
  TriggerEngineDeps,
  TriggerStore,
  TriggerBudget,
  ContextSpan,
  VerificationTrace,
  Clock,
} from './types.js'
import type { ResolvedWorkBinding } from '../runtime/work-binding.js'
import { WorkBindingError } from '../runtime/work-binding.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-06-13T12:00:00.000Z')
const BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'system-session-1',
  scope: 'project' as const,
}

function budget(over: Partial<TriggerBudget> = {}): TriggerBudget {
  return { tokenCeiling: 100_000, dollarCeiling: 100, tokensSpent: 0, dollarsSpent: 0, ...over }
}

function makeStore(seed: TriggerSpec[] = []): TriggerStore {
  const map = new Map<string, TriggerSpec>(seed.map(s => [s.id, structuredClone(s)]))
  return {
    async load() { return [...map.values()].map(s => structuredClone(s)) },
    async save(spec) { map.set(spec.id, structuredClone(spec)) },
    async remove(id) { map.delete(id) },
  }
}

interface Harness {
  deps: TriggerEngineDeps
  started: Array<{
    triggerId: string
    binding: ResolvedWorkBinding
    prompt: string
    spans: ContextSpan[]
    budget: TriggerBudget
  }>
  events: Array<{ event: string; payload: unknown }>
  clock: Clock & { advance(ms: number): void }
}

function makeDeps(over: Partial<TriggerEngineDeps> & { probeResult?: boolean } = {}): Harness {
  const started: Harness['started'] = []
  const events: Harness['events'] = []
  const clock = (over.clock as Clock & { advance(ms: number): void }) ?? fakeClock(T0)
  const deps: TriggerEngineDeps = {
    clock,
    probeRunner: over.probeRunner ?? (() => over.probeResult ?? true),
    startTurn: over.startTurn ?? (async (i) => { started.push(i) }),
    store: over.store ?? makeStore(),
    emitEvent: over.emitEvent ?? ((event, payload) => events.push({ event, payload })),
    globalBackgroundBudget: over.globalBackgroundBudget ?? budget(),
    observe: over.observe ?? (async () => 'watched page content'),
    ...(over.timeZone === undefined ? {} : { timeZone: over.timeZone }),
  }
  return { deps, started, events, clock }
}

type RegInput = Omit<TriggerSpec, 'schemaVersion' | 'confirmed' | 'enabled'>

function remind(over: Partial<RegInput> = {}): RegInput {
  return { id: 'r1', kind: 'remind', createdBy: 'operator', prompt: 'remind me', fireAt: new Date(T0 - 1000).toISOString(), budget: budget(), ...over, binding: over.binding ?? BINDING }
}
function schedule(over: Partial<RegInput> = {}): RegInput {
  return { id: 's1', kind: 'schedule', createdBy: 'operator', prompt: 'digest', cron: '@hourly', budget: budget(), ...over, binding: over.binding ?? BINDING }
}
function watch(over: Partial<RegInput> = {}): RegInput {
  const probe: VerificationTrace = { kind: 'http', method: 'GET', url: 'https://ci.example.com/status', expectStatus: 200 }
  return { id: 'w1', kind: 'watch', createdBy: 'operator', prompt: 'CI changed', probe, budget: budget(), ...over, binding: over.binding ?? BINDING }
}

// ---------------------------------------------------------------------------
// AC-14-1 .. AC-14-14
// ---------------------------------------------------------------------------

describe('Triggers & Proactivity (14)', () => {
  it('AC-14-1: a due remind fires exactly once, calls startTurn with the prompt, then disables (one-shot)', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind())

    const f1 = await eng.tick()
    expect(f1.find(f => f.triggerId === 'r1')?.phase1).toBe('due')
    expect(f1.find(f => f.triggerId === 'r1')?.turnStarted).toBe(true)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.prompt).toBe('remind me')
    expect(h.started[0]!.binding).toEqual(BINDING)

    const f2 = await eng.tick()           // one-shot: must not fire again
    expect(h.started).toHaveLength(1)
    expect(f2.find(f => f.triggerId === 'r1')?.turnStarted ?? false).toBe(false)
  })

  it('AC-14-2: a remind whose fireAt is in the future does not fire', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind({ fireAt: new Date(T0 + 60_000).toISOString() }))
    const f = await eng.tick()
    expect(h.started).toHaveLength(0)
    expect(f.find(x => x.triggerId === 'r1')?.turnStarted ?? false).toBe(false)
  })

  it('AC-14-3: a schedule fires on a matching cron tick and stays enabled for the next match', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(schedule({ cron: '@hourly' }))

    const f1 = await eng.tick()
    expect(f1.find(f => f.triggerId === 's1')?.phase1).toBe('due')
    expect(h.started).toHaveLength(1)
    // same hour → no second fire
    await eng.tick()
    expect(h.started).toHaveLength(1)
    // next hour → fires again, still enabled
    h.clock.advance(3_600_000)
    const f3 = await eng.tick()
    expect(f3.find(f => f.triggerId === 's1')?.phase1).toBe('due')
    expect(h.started).toHaveLength(2)
  })

  it('AC-14-4: a watch whose probe returns false starts zero turns (phase-1 only, 0 model calls)', async () => {
    const h = makeDeps({ probeResult: false })
    const eng = makeTriggerEngine(h.deps)
    await eng.register(watch())
    const f = await eng.tick()
    expect(h.started).toHaveLength(0)
    expect(f.find(x => x.triggerId === 'w1')?.phase1).toBe('no-change')
  })

  it('AC-14-5: a watch whose probe returns true wakes one turn whose observation span is untrusted', async () => {
    const h = makeDeps({ probeResult: true })
    const eng = makeTriggerEngine(h.deps)
    await eng.register(watch())
    const f = await eng.tick()
    expect(f.find(x => x.triggerId === 'w1')?.phase1).toBe('condition-met')
    expect(h.started).toHaveLength(1)
    const spans = h.started[0]!.spans
    expect(spans.length).toBeGreaterThanOrEqual(1)
    expect(spans.every(s => s.provenance === 'untrusted')).toBe(true)
  })

  it('AC-14-6: a trigger whose per-trigger budget is exhausted is paused, no startTurn, journaled once', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind({ budget: budget({ tokensSpent: 100_000 }) }))  // at ceiling

    const f1 = await eng.tick()
    expect(f1.find(x => x.triggerId === 'r1')?.phase1).toBe('budget-paused')
    expect(h.started).toHaveLength(0)
    await eng.tick()                         // second tick: still no startTurn
    expect(h.started).toHaveLength(0)
    const pauseEvents = h.events.filter(e => e.event === 'trigger.budget_paused')
    expect(pauseEvents).toHaveLength(1)      // reported exactly once
  })

  it('AC-14-7: when the global background budget is exhausted, no trigger fires', async () => {
    const h = makeDeps({ globalBackgroundBudget: budget({ dollarsSpent: 100 }) })  // at ceiling
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind())             // individually well within budget
    await eng.tick()
    expect(h.started).toHaveLength(0)
  })

  it('AC-14-8: an agent-created trigger with confirmed=false never fires; register reports it pending', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    const reg = await eng.register(remind({ createdBy: 'agent' }))
    expect(reg.createdBy).toBe('agent')
    expect(reg.confirmed).toBe(false)        // pending confirmation
    await eng.tick()
    expect(h.started).toHaveLength(0)         // due, but unconfirmed → never fires
  })

  it('AC-14-9: confirm() is the only activation; after it the same due tick fires', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind({ createdBy: 'agent' }))
    await eng.tick()
    expect(h.started).toHaveLength(0)
    await eng.confirm('r1')
    await eng.tick()
    expect(h.started).toHaveLength(1)
  })

  it('AC-14-10: an expired trigger never fires; cancel() removes it', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind({ id: 'exp', expiresAt: new Date(T0 - 60_000).toISOString() }))
    await eng.tick()
    expect(h.started).toHaveLength(0)        // expired → no fire

    await eng.register(remind({ id: 'live' }))
    await eng.cancel('live')
    await eng.tick()
    expect(h.started.find(s => s.triggerId === 'live')).toBeUndefined()
    expect((await eng.list()).find(t => t.id === 'live')).toBeUndefined()
  })

  it('AC-14-11: tick reads only the injected Clock — two engines over identical state produce identical firings', async () => {
    const seed: TriggerSpec = { ...remind(), schemaVersion: 2, confirmed: true, enabled: true }
    const a = makeDeps({ clock: fakeClock(T0), store: makeStore([seed]) })
    const b = makeDeps({ clock: fakeClock(T0), store: makeStore([seed]) })
    const fa = await makeTriggerEngine(a.deps).tick()
    const fb = await makeTriggerEngine(b.deps).tick()
    expect(fa).toEqual(fb)
  })

  it('AC-14-12: firing emits trigger.fired; pause emits trigger.budget_paused', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await eng.register(remind())
    await eng.tick()
    expect(h.events.some(e => e.event === 'trigger.fired')).toBe(true)

    const h2 = makeDeps()
    const eng2 = makeTriggerEngine(h2.deps)
    await eng2.register(remind({ id: 'rp', budget: budget({ tokensSpent: 100_000 }) }))
    await eng2.tick()
    expect(h2.events.some(e => e.event === 'trigger.budget_paused')).toBe(true)
  })

  it('AC-14-13: register rejects a vacuous (R3) or self-referential (R4) watch probe', async () => {
    const h = makeDeps()
    const eng = makeTriggerEngine(h.deps)
    await expect(
      eng.register(watch({ id: 'v', probe: { kind: 'exit', argv: ['echo', 'ok'], expectCode: 0 } })),
    ).rejects.toThrow(/vacuous|R3/i)
    await expect(
      eng.register(watch({ id: 'sr', probe: { kind: 'file', path: 'PLAN.md', existsExpected: true } })),
    ).rejects.toThrow(/self-referential|R4/i)
  })

  it('AC-14-14: the same due slot never fires twice across a restart (idempotent by trigger+slot)', async () => {
    const store = makeStore()
    const a = makeDeps({ clock: fakeClock(T0), store })
    const eng1 = makeTriggerEngine(a.deps)
    await eng1.register(schedule({ cron: '@daily' }))
    await eng1.tick()
    expect(a.started).toHaveLength(1)        // fired today's slot, persisted

    // "restart": a brand-new engine over the SAME store + same clock
    const b = makeDeps({ clock: fakeClock(T0), store })
    const eng2 = makeTriggerEngine(b.deps)
    await eng2.tick()
    expect(b.started).toHaveLength(0)        // today's slot already fired → no double fire
  })

  it('persists schema v2 and the exact binding across an engine restart', async () => {
    const store = makeStore()
    const first = makeTriggerEngine(makeDeps({ store }).deps)
    const registered = await first.register(schedule())
    expect(registered).toMatchObject({ schemaVersion: 2, binding: BINDING })

    const restarted = makeTriggerEngine(makeDeps({ store }).deps)
    expect(await restarted.list()).toEqual([
      expect.objectContaining({ schemaVersion: 2, binding: BINDING }),
    ])
  })

  it('pauses a trigger durably when its bound context is archived', async () => {
    const store = makeStore()
    const h = makeDeps({
      store,
      startTurn: async () => { throw new WorkBindingError('PROJECT_ARCHIVED') },
    })
    const engine = makeTriggerEngine(h.deps)
    await engine.register(schedule())

    const firing = await engine.tick()

    expect(firing).toEqual([
      expect.objectContaining({ phase1: 'context-paused', turnStarted: false }),
    ])
    expect(h.events).toContainEqual(expect.objectContaining({ event: 'trigger.context_paused' }))
    expect((await engine.list())[0]).toMatchObject({ enabled: false, binding: BINDING })

    const restarted = makeTriggerEngine(makeDeps({ store }).deps)
    await restarted.tick()
    expect((await restarted.list())[0]).toMatchObject({ enabled: false, binding: BINDING })
  })
})

describe('timer limits and long-running schedules', () => {
  it('fires a weekly schedule once per ISO week, not once per tick', async () => {
    const fired: string[] = []
    let now = '2026-07-29T09:00:00.000Z'   // Wednesday, week 31
    const eng = makeTriggerEngine(makeDeps({
      clock: { now: () => now } as never,
      startTurn: async (input) => { fired.push(input.triggerId) },
    }).deps)
    await eng.register(schedule({ id: 'w', cron: '@weekly' }))

    await eng.tick()
    now = '2026-08-01T09:00:00.000Z'       // Saturday, same ISO week
    await eng.tick()
    expect(fired).toEqual(['w'])

    now = '2026-08-03T09:00:00.000Z'       // Monday, next ISO week
    await eng.tick()
    expect(fired).toEqual(['w', 'w'])
  })

  it('does not accumulate missed slots after a long outage', async () => {
    const fired: string[] = []
    let now = '2026-07-29T09:00:00.000Z'
    const eng = makeTriggerEngine(makeDeps({
      clock: { now: () => now } as never,
      startTurn: async (input) => { fired.push(input.triggerId) },
    }).deps)
    await eng.register(schedule({ id: 'd', cron: '@daily' }))

    await eng.tick()
    now = '2026-08-10T09:00:00.000Z'       // twelve days later, one tick
    await eng.tick()

    expect(fired).toEqual(['d', 'd'])
  })

  it('remembers only the recent slots, so a frequent timer does not grow forever', async () => {
    let minute = 0
    const eng = makeTriggerEngine(makeDeps({
      clock: { now: () => `2026-07-29T${String(9 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z` } as never,
      startTurn: async () => {},
    }).deps)
    await eng.register(schedule({ id: 'm', cron: '@minutely' }))

    for (minute = 0; minute < 40; minute += 1) await eng.tick()

    const stored = (await eng.list()).find(s => s.id === 'm')
    expect(stored?.firedSlots?.length).toBeLessThanOrEqual(16)
  })

  it('refuses to register past the live-trigger ceiling', async () => {
    const eng = makeTriggerEngine(makeDeps({ startTurn: async () => {} }).deps)
    for (let i = 0; i < MAX_LIVE_TRIGGERS; i += 1) {
      await eng.register(schedule({ id: `s${i}`, cron: '@daily' }))
    }

    await expect(eng.register(schedule({ id: 'one-too-many', cron: '@daily' })))
      .rejects.toThrowError(/live triggers/)
    // Re-registering an existing id stays possible: that is an update, not growth.
    await expect(eng.register(schedule({ id: 's0', cron: '@hourly' }))).resolves.toBeTruthy()
  })

  it('fires a daily schedule on the operator’s clock, not the server’s', async () => {
    // 06:30 UTC is 09:30 in Moscow: the operator asked for nine in the morning
    // and would otherwise have been woken at noon.
    const clock = fakeClock(Date.parse('2026-08-07T06:30:00.000Z'))
    const h = makeDeps({ clock, timeZone: () => 'Europe/Moscow' })
    const eng = makeTriggerEngine(h.deps)
    await eng.register(schedule({ id: 'morning', cron: '09:00' }))

    await eng.tick()

    expect(h.started.map(s => s.triggerId)).toEqual(['morning'])
  })

  it('holds a schedule that has not come round yet in that zone', async () => {
    const clock = fakeClock(Date.parse('2026-08-07T09:30:00.000Z'))
    const h = makeDeps({ clock, timeZone: () => 'America/Los_Angeles' })
    const eng = makeTriggerEngine(h.deps)
    await eng.register(schedule({ id: 'morning', cron: '09:00' }))

    // 09:30 UTC is 02:30 in Los Angeles — still the middle of the night.
    await eng.tick()

    expect(h.started).toEqual([])
  })
})

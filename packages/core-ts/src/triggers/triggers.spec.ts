import { describe, it, expect } from 'vitest'
import { makeTriggerEngine } from './index.js'
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-06-13T12:00:00.000Z')

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
  started: Array<{ triggerId: string; prompt: string; spans: ContextSpan[]; budget: TriggerBudget }>
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
  }
  return { deps, started, events, clock }
}

type RegInput = Omit<TriggerSpec, 'confirmed' | 'enabled'>

function remind(over: Partial<RegInput> = {}): RegInput {
  return { id: 'r1', kind: 'remind', createdBy: 'operator', prompt: 'remind me', fireAt: new Date(T0 - 1000).toISOString(), budget: budget(), ...over }
}
function schedule(over: Partial<RegInput> = {}): RegInput {
  return { id: 's1', kind: 'schedule', createdBy: 'operator', prompt: 'digest', cron: '@hourly', budget: budget(), ...over }
}
function watch(over: Partial<RegInput> = {}): RegInput {
  const probe: VerificationTrace = { kind: 'http', method: 'GET', url: 'https://ci.example.com/status', expectStatus: 200 }
  return { id: 'w1', kind: 'watch', createdBy: 'operator', prompt: 'CI changed', probe, budget: budget(), ...over }
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
    const seed: TriggerSpec = { ...remind(), confirmed: true, enabled: true }
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
})

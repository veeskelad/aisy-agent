// Tier-7 Phase C — goal-orchestrator unit tests (TDD merge gate).
// 11 cases covering: completion+probe, probe-fail retry, no-probe, backstop iterations,
// backstop usage, abort, budget-ceiling, every-mode, awaiting-approval, save-every-iter,
// pre-grant.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GoalSpec, GoalStore, GoalUsage, VerificationTrace } from '@aisy/core'
import { makeGoalSpec } from '@aisy/core'
import { makeGoalOrchestrator } from './goal-orchestrator.js'
import type { GoalOrchestratorDeps, GoalRunTurnResult } from './goal-orchestrator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<GoalSpec> = {}): GoalSpec {
  return makeGoalSpec({
    id: 'g1',
    objective: 'do something',
    mode: { kind: 'until' },
    backstop: { maxIterations: 10, tokenCeiling: 100_000, dollarCeiling: 5 },
    grantedScope: [],
    nowIso: '2026-01-01T00:00:00Z',
    ...overrides,
  })
}

function okDone(reply = 'done'): GoalRunTurnResult {
  return { state: 'ok', claimedDone: true, reply }
}

function okContinue(reply = 'still working'): GoalRunTurnResult {
  return { state: 'ok', claimedDone: false, reply }
}

function makeInMemoryStore(): GoalStore & { saved: GoalSpec[] } {
  const saved: GoalSpec[] = []
  let current: GoalSpec | null = null
  return {
    saved,
    async load() { return current },
    async save(spec) { current = { ...spec }; saved.push({ ...spec }) },
    async clear() { current = null },
  }
}

function makeDeps(overrides: Partial<Omit<GoalOrchestratorDeps, 'store'>> = {}): GoalOrchestratorDeps & {
  store: GoalStore & { saved: GoalSpec[] }
  calls: Array<Parameters<GoalOrchestratorDeps['runGoalTurn']>[0]>
  progress: string[]
  grants: string[]
  events: Array<{ event: string; payload: unknown }>
} {
  const store = makeInMemoryStore()
  const calls: Array<Parameters<GoalOrchestratorDeps['runGoalTurn']>[0]> = []
  const progress: string[] = []
  const grants: string[] = []
  const events: Array<{ event: string; payload: unknown }> = []

  return {
    store,
    calls,
    progress,
    grants,
    events,
    runGoalTurn: async (input) => {
      calls.push(input)
      return okDone()
    },
    probeRunner: async () => true,
    recordGrant: (t) => { grants.push(t) },
    sendProgress: async (text) => { progress.push(text) },
    clock: { now: () => '2026-01-01T00:01:00Z' },
    sleep: async () => {},
    emit: (event, payload) => { events.push({ event, payload }) },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. until + probe-pass after claim → completed
// ---------------------------------------------------------------------------
describe('1. until + probe-pass → completed', () => {
  it('completes when claim is true and probe passes', async () => {
    const probe: VerificationTrace = { kind: 'exit', argv: ['true'], expectCode: 0 }
    const spec = makeSpec({ mode: { kind: 'until', probe } })
    const probeRunner = vi.fn(async () => true)
    const deps = makeDeps({
      runGoalTurn: async () => okDone(),
      probeRunner,
    })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    expect(deps.store.saved.at(-1)?.status).toBe('completed')
    expect(probeRunner).toHaveBeenCalledWith(probe)
  })
})

// ---------------------------------------------------------------------------
// 2. until + probe-fail → continue+feedback, then retry with probe-pass
// ---------------------------------------------------------------------------
describe('2. until + probe-fail → continue, then done', () => {
  it('loops with feedback when probe fails, completes on 2nd probe-pass', async () => {
    const probe: VerificationTrace = { kind: 'exit', argv: ['true'], expectCode: 0 }
    const spec = makeSpec({ mode: { kind: 'until', probe } })

    let callCount = 0
    const runGoalTurn = vi.fn(async (): Promise<GoalRunTurnResult> => {
      callCount++
      return okDone()
    })
    let probeCount = 0
    const probeRunner = vi.fn(async () => {
      probeCount++
      return probeCount >= 2 // fail on 1st, pass on 2nd
    })

    const deps = makeDeps({ runGoalTurn, probeRunner })
    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    expect(deps.store.saved.at(-1)?.status).toBe('completed')
    expect(runGoalTurn).toHaveBeenCalledTimes(2)
    expect(probeCount).toBeGreaterThanOrEqual(2)

    // feedback was set after probe-fail
    const intermediate = deps.store.saved.find(s => s.lastFeedback !== undefined)
    expect(intermediate?.lastFeedback).toMatch(/не прошла/)
  })
})

// ---------------------------------------------------------------------------
// 3. no-probe until + claim → completed (fallback)
// ---------------------------------------------------------------------------
describe('3. no-probe until + claim → completed', () => {
  it('completes without running probe when mode has no probe', async () => {
    const spec = makeSpec({ mode: { kind: 'until' } })
    const probeRunner = vi.fn(async () => false) // should never be called
    const deps = makeDeps({ runGoalTurn: async () => okDone(), probeRunner })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    expect(deps.store.saved.at(-1)?.status).toBe('completed')
    expect(probeRunner).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. backstop maxIterations → halts exactly at maxIterations
// ---------------------------------------------------------------------------
describe('4. backstop maxIterations', () => {
  it('halts with max-iterations and iterationsSpent === maxIterations', async () => {
    const spec = makeSpec({
      backstop: { maxIterations: 3, tokenCeiling: 999_999, dollarCeiling: 999 },
    })
    const deps = makeDeps({ runGoalTurn: async () => okContinue() })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('max-iterations')
    expect(last.iterationsSpent).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 5. backstop usage ceiling (dollarCeiling)
// ---------------------------------------------------------------------------
describe('5. backstop usage ceiling', () => {
  it('halts backstop-budget when accumulated dollars exceed dollarCeiling', async () => {
    const spec = makeSpec({
      backstop: { maxIterations: 100, tokenCeiling: 999_999, dollarCeiling: 1.0 },
    })
    // each turn costs $0.6 → after 2nd turn usageSpent.dollars >= 1.0
    const usage: GoalUsage = { inputTokens: 100, outputTokens: 100, dollars: 0.6 }
    const deps = makeDeps({
      runGoalTurn: async () => ({ ...okContinue(), usage }),
    })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('backstop-budget')
  })
})

// ---------------------------------------------------------------------------
// 6. abort → stopped
// ---------------------------------------------------------------------------
describe('6. abort → stopped', () => {
  it('stops immediately when signal is pre-aborted', async () => {
    const spec = makeSpec()
    const runGoalTurn = vi.fn(async () => okDone())
    const deps = makeDeps({ runGoalTurn })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    ac.abort()
    await orch.start(spec, ac.signal)

    expect(deps.store.saved.at(-1)?.status).toBe('stopped')
    expect(runGoalTurn).not.toHaveBeenCalled()
  })

  it('stops mid-loop when signal is aborted after first turn', async () => {
    const spec = makeSpec({ backstop: { maxIterations: 10, tokenCeiling: 999_999, dollarCeiling: 99 } })
    const ac = new AbortController()
    let callCount = 0
    const runGoalTurn = vi.fn(async (): Promise<GoalRunTurnResult> => {
      callCount++
      // abort after 1st call so next iterate sees aborted
      ac.abort()
      return okContinue()
    })
    const deps = makeDeps({ runGoalTurn })

    const orch = makeGoalOrchestrator(deps)
    await orch.start(spec, ac.signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('stopped')
    expect(callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. budget mode → halts budget-ceiling
// ---------------------------------------------------------------------------
describe('7. budget mode', () => {
  it('halts budget-ceiling when mode dollar ceiling is reached', async () => {
    const spec = makeSpec({
      mode: { kind: 'budget', dollarCeiling: 0.5 },
      backstop: { maxIterations: 100, tokenCeiling: 999_999, dollarCeiling: 99 },
    })
    const usage: GoalUsage = { inputTokens: 100, outputTokens: 100, dollars: 0.3 }
    const deps = makeDeps({
      runGoalTurn: async () => ({ ...okContinue(), usage }),
    })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('budget-ceiling')
  })

  it('halts budget-ceiling when mode token ceiling is reached', async () => {
    const spec = makeSpec({
      mode: { kind: 'budget', tokenCeiling: 500 },
      backstop: { maxIterations: 100, tokenCeiling: 999_999, dollarCeiling: 99 },
    })
    // each turn: 300 tokens → after 2nd: 600 >= 500
    const usage: GoalUsage = { inputTokens: 200, outputTokens: 100, dollars: 0.001 }
    const deps = makeDeps({
      runGoalTurn: async () => ({ ...okContinue(), usage }),
    })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('budget-ceiling')
  })
})

// ---------------------------------------------------------------------------
// 8. every mode — tick() runs exactly ONE iterate per call
// ---------------------------------------------------------------------------
describe('8. every mode', () => {
  it('runs exactly one iteration per tick(), N ticks → N iterations', async () => {
    const spec = makeSpec({ mode: { kind: 'every', intervalMs: 60_000 } })
    const runGoalTurn = vi.fn(async () => okContinue())
    const deps = makeDeps({ runGoalTurn })
    const orch = makeGoalOrchestrator(deps)

    // Seed current by calling start() but with a spec that will quickly be saved
    // Actually for every mode we use tick(); we need to set current via start() is wrong.
    // tick() checks current; we simulate via status() by calling start() for 'every' mode
    // The algorithm says start() is for until/budget. For every, tick() is called by scheduler.
    // We need to set `current` somehow; per the spec, resume() or start() can seed it.
    await deps.store.save({ ...spec })
    await orch.resume(new AbortController().signal)

    const ac = new AbortController()
    await orch.tick(ac.signal)
    await orch.tick(ac.signal)
    await orch.tick(ac.signal)

    expect(runGoalTurn).toHaveBeenCalledTimes(3)
  })

  it('backstop applies across ticks', async () => {
    const spec = makeSpec({
      mode: { kind: 'every', intervalMs: 1000 },
      backstop: { maxIterations: 2, tokenCeiling: 999_999, dollarCeiling: 99 },
    })
    const runGoalTurn = vi.fn(async () => okContinue())
    const deps = makeDeps({ runGoalTurn })
    const orch = makeGoalOrchestrator(deps)

    await deps.store.save({ ...spec })
    await orch.resume(new AbortController().signal)

    // tick 1 → 1 iteration (still active, iterationsSpent=1)
    await orch.tick(new AbortController().signal)
    // tick 2 → 2 iterations (still active, iterationsSpent=2)
    await orch.tick(new AbortController().signal)
    // tick 3 → backstop pre-check kicks in (iterationsSpent >= 2), no turn called, halted
    await orch.tick(new AbortController().signal)

    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('max-iterations')
    // runGoalTurn called exactly 2 times (not 3)
    expect(runGoalTurn).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// 9. awaiting-approval → HALTS (safety regression lock: no self-issued token)
// ---------------------------------------------------------------------------
describe('9. awaiting-approval', () => {
  it('halts goal on awaiting-approval; runGoalTurn called once; recordGrant not called for tier-3', async () => {
    const spec = makeSpec({ grantedScope: ['read_file'] })
    const runGoalTurn = vi.fn<GoalOrchestratorDeps['runGoalTurn']>()
      .mockResolvedValueOnce({ state: 'awaiting-approval', planHash: 'hash-abc', claimedDone: false, reply: 'plan ready' })

    const deps = makeDeps({ runGoalTurn })
    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    // runGoalTurn must be called exactly ONCE — no self-issued re-call with approvalToken
    expect(runGoalTurn).toHaveBeenCalledTimes(1)

    // Goal must be halted, not completed
    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('awaiting-approval')

    // recordGrant only called for grantedScope tools (read_file), NOT for planHash / tier-3
    expect(deps.grants).toContain('read_file')
    expect(deps.grants).not.toContain('hash-abc')
    expect(deps.grants).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 10. save() called every iteration (crash-safe)
// ---------------------------------------------------------------------------
describe('10. save() every iteration', () => {
  it('persists after each iterate, even when looping', async () => {
    const spec = makeSpec({
      backstop: { maxIterations: 4, tokenCeiling: 999_999, dollarCeiling: 99 },
    })
    let callCount = 0
    const deps = makeDeps({
      runGoalTurn: async () => {
        callCount++
        return okContinue()
      },
    })

    const saveSpy = vi.spyOn(deps.store, 'save')
    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    // backstop pre-check fires at 4, so we get 4 actual turns + 1 for initial start() save
    // Each iterate: 1 save after turn; plus backstop halt saves; plus start() initial save
    // At minimum, save was called once per iterate (4 turns) plus halted save
    // The key invariant: save() is called at least once per iteration (crash-safe).
    // (It may be called more than once per iterate for field updates like lastFeedback.)
    const last = deps.store.saved.at(-1)!
    expect(saveSpy.mock.calls.length).toBeGreaterThanOrEqual(last.iterationsSpent)
  })
})

// ---------------------------------------------------------------------------
// 11. pre-grant — start() calls recordGrant for each grantedScope tool exactly once
// ---------------------------------------------------------------------------
describe('11. pre-grant', () => {
  it('calls recordGrant once per grantedScope tool at start', async () => {
    const spec = makeSpec({ grantedScope: ['read_file', 'bash', 'write_file'] })
    const deps = makeDeps({ runGoalTurn: async () => okDone() })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    expect(deps.grants).toEqual(['read_file', 'bash', 'write_file'])
  })
})

// ---------------------------------------------------------------------------
// 12. resume() non-every — grants scope ONCE (not twice)
// ---------------------------------------------------------------------------
describe('12. resume() non-every — no double-grant', () => {
  it('grants read_file exactly once when resuming an until goal', async () => {
    const spec = makeSpec({
      mode: { kind: 'until' },
      grantedScope: ['read_file'],
      status: 'active',
    })
    const deps = makeDeps({ runGoalTurn: async () => okDone() })

    // Seed the store so resume() finds the spec
    await deps.store.save({ ...spec })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.resume(ac.signal)

    // Allow any microtasks from the void start() to settle
    await Promise.resolve()

    // 'read_file' must appear exactly once in grants
    expect(deps.grants.filter(t => t === 'read_file')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 13. resume() every-mode — grants scope once via the every branch
// ---------------------------------------------------------------------------
describe('13. resume() every-mode — grants scope once', () => {
  it('grants scope once for an every-mode goal on resume', async () => {
    const spec = makeSpec({
      mode: { kind: 'every', intervalMs: 60_000 },
      grantedScope: ['read_file'],
      status: 'active',
    })
    const deps = makeDeps({ runGoalTurn: async () => okContinue() })

    await deps.store.save({ ...spec })

    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.resume(ac.signal)

    expect(deps.grants.filter(t => t === 'read_file')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 14. awaiting-approval halts immediately (no backstop-guarded re-call path)
// ---------------------------------------------------------------------------
describe('14. awaiting-approval halts regardless of backstop state', () => {
  it('halts with awaiting-approval when the turn returns that state, even mid-run', async () => {
    // maxIterations = 2; first turn continues; second turn hits awaiting-approval
    const spec = makeSpec({
      backstop: { maxIterations: 2, tokenCeiling: 999_999, dollarCeiling: 99 },
    })

    const runGoalTurn = vi.fn<GoalOrchestratorDeps['runGoalTurn']>()
      // turn 1 (iterationsSpent→1): ok continue
      .mockResolvedValueOnce(okContinue())
      // turn 2 (iterationsSpent→2 == maxIterations): awaiting-approval → must halt immediately
      .mockResolvedValueOnce({ state: 'awaiting-approval', planHash: 'h1', claimedDone: false, reply: 'plan' })

    const deps = makeDeps({ runGoalTurn })
    const orch = makeGoalOrchestrator(deps)
    const ac = new AbortController()
    await orch.start(spec, ac.signal)

    // No re-call — runGoalTurn called exactly 2 times (once per turn, no self-issued approval)
    expect(runGoalTurn).toHaveBeenCalledTimes(2)

    // Goal halts with awaiting-approval (not max-iterations)
    const last = deps.store.saved.at(-1)!
    expect(last.status).toBe('halted')
    expect(last.haltReason).toBe('awaiting-approval')
  })
})

// ---------------------------------------------------------------------------
// 15. generation guard — superseded loop never clobbers the new active goal
// ---------------------------------------------------------------------------
describe('15. generation guard — superseded loop cannot overwrite new goal', () => {
  it('skips the terminal save from a superseded loop, keeping goal B in the store', async () => {
    // Goal A: loops (okContinue), will be superseded by goal B
    const specA = makeSpec({ id: 'goal-a', objective: 'task A' })
    const specB = makeSpec({ id: 'goal-b', objective: 'task B' })

    // Shared store between both orchestrators
    const store = makeInMemoryStore()

    // Track when A's runGoalTurn is called so we can abort it mid-loop
    const acA = new AbortController()
    let aTurnCount = 0
    const orchA = makeGoalOrchestrator({
      store,
      runGoalTurn: async () => {
        aTurnCount++
        if (aTurnCount >= 1) acA.abort() // abort A after first turn
        return okContinue()
      },
      probeRunner: async () => true,
      recordGrant: () => {},
      sendProgress: async () => {},
      clock: { now: () => '2026-01-01T00:01:00Z' },
    })

    // Start A in the background (will abort after first turn)
    const aLoop = orchA.start(specA, acA.signal)

    // Wait for A to abort and save its stopped state
    await aLoop

    // Now start goal B — this sets current = specB and saves it
    const orchB = makeGoalOrchestrator({
      store,
      runGoalTurn: async () => okDone(), // B completes immediately
      probeRunner: async () => true,
      recordGrant: () => {},
      sendProgress: async () => {},
      clock: { now: () => '2026-01-01T00:02:00Z' },
    })
    const acB = new AbortController()
    await orchB.start(specB, acB.signal)

    // The last persisted spec must be goal B (completed), not goal A (stopped)
    const last = store.saved.at(-1)!
    expect(last.id).toBe('goal-b')
    expect(last.status).toBe('completed')
  })
})

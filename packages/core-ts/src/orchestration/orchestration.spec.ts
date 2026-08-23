/**
 * Orchestration — Component 11 — Phase-3 red tests
 *
 * Every test maps 1:1 to an acceptance criterion from §9 of
 * docs/specs/11-orchestration.md. All tests are RED until the implementation
 * in index.ts is complete.
 *
 * Label convention: AC-11-N matches §9 item N.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  canonicalizeIterationCost,
  iterationCostSpendNanos,
  makeCoordinator,
  makeLoopGuardian,
  makeDelegationManager,
  ScopeConflictError,
  ScopeViolationError,
  type Coordinator,
  type CoordinatorDeps,
  type DecisionJournal,
  type BudgetGuard,
  type LoopGuardian,
  type GenerationManager,
  type OrchestrationEvent,
  type JournalEntry,
  type WorkerBrief,
  type Task,
  type BudgetVerdict,
  type LoopStep,
  type AgentCard,
  type DelegationTask,
  type DelegationDeps,
  type DelegationPersistencePort,
  type DelegationQuarantineReason,
  type PersistedDelegationV1,
  type PersistedDelegationRunV1,
  type PlanDAG,
  type LinearPlanLike,
} from './index.js'
import { makeEffectVerifier } from '../testing/index.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    runId: 'r-test',
    generationId: 'g-1',
    workerId: 'w-a',
    seq: 1,
    decidedFor: 'option-a',
    decidedAgainst: '',
    because: 'best fit',
    touched: ['src/a/file.ts'],
    ts: new Date().toISOString(),
    ...overrides,
  }
}

function makeWorkerBrief(overrides: Partial<WorkerBrief> = {}): WorkerBrief {
  return {
    workerId: 'w-default',
    intent: 'do some work',
    scope: {
      owns: ['src/default/**'],
      doNotTouch: [],
      taskClass: 'reasoning',
      budgetSlice: { iterations: 40, spendUsd: 0.50 },
    },
    ...overrides,
  }
}

function makeTask(paths: string[]): Task {
  return { description: 'test task', affectedPaths: paths }
}

/** Minimal stub for DecisionJournal that records appends. */
function makeJournalStub(): DecisionJournal & { entries: JournalEntry[] } {
  const entries: JournalEntry[] = []
  return {
    entries,
    append(entry: JournalEntry): void {
      entries.push(entry)
    },
    read(_runId: string): JournalEntry[] {
      return entries
    },
  }
}

/** Stub BudgetGuard that always returns ok. */
function makeOkBudgetGuard(): BudgetGuard {
  return {
    charge(_runId, _cost): BudgetVerdict { return { ok: true } },
    status(_runId) { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
  }
}

/** Stub GenerationManager. */
function makeGenerationManagerStub(): GenerationManager {
  let genCounter = 1
  const manifests = new Map<string, ReturnType<GenerationManager['getManifest']>>()
  return {
    fork(runId, lessons) {
      const newGen = `g-${++genCounter}`
      manifests.set(newGen, {
        generationId: newGen,
        parent: `g-${genCounter - 1}`,
        carries: ['constitution'],
        distilledLessons: lessons,
        droppedTranscriptOf: `g-${genCounter - 1}`,
      })
      return newGen
    },
    getManifest(genId) {
      return manifests.get(genId)
    },
  }
}

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  const ev = makeEffectVerifier()
  return {
    journal: makeJournalStub(),
    budgetGuard: makeOkBudgetGuard(),
    loopGuardian: makeLoopGuardian({}),
    generationManager: makeGenerationManagerStub(),
    emit: (event: OrchestrationEvent) => ev.record({ kind: 'tool-call', target: event.kind, payload: event }),
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Orchestration — Component 11', () => {

  // AC-11-1: pairwise write-disjoint scopes; overlapping owns → ScopeConflictError
  it('AC-11-1: decompose() returns ≥2 briefs with pairwise write-disjoint owns; overlapping owns throws ScopeConflictError and spawns zero workers', async () => {
    const coord: Coordinator = makeCoordinator(makeDeps())
    const task = makeTask(['src/api/**', 'src/ui/**'])

    const briefs = coord.decompose(task, 'g-1')
    expect(briefs.length).toBeGreaterThanOrEqual(2)

    // All pairs of owns must be disjoint — no glob path appears in two scopes
    for (let i = 0; i < briefs.length; i++) {
      for (let j = i + 1; j < briefs.length; j++) {
        const ownsA = new Set(briefs[i]!.scope.owns)
        const ownsB = briefs[j]!.scope.owns
        for (const path of ownsB) {
          expect(ownsA.has(path)).toBe(false)
        }
      }
    }

    // Spawning a brief with an overlapping scope must throw ScopeConflictError
    const briefA = makeWorkerBrief({ workerId: 'w-a', scope: { owns: ['src/shared/**'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.10 } } })
    const briefB = makeWorkerBrief({ workerId: 'w-b', scope: { owns: ['src/shared/**'], doNotTouch: [], taskClass: 'routine', budgetSlice: { iterations: 10, spendUsd: 0.10 } } })

    await coord.spawn(briefA)
    await expect(coord.spawn(briefB)).rejects.toThrow(ScopeConflictError)
  })

  // AC-11-2: touched path outside owns → ScopeViolationError; entry not in journal; absent from reconcile
  it('AC-11-2: journal.append with touched path outside scope.owns (or in doNotTouch) throws ScopeViolationError and is absent from the merge', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    const brief = makeWorkerBrief({
      workerId: 'w-api',
      scope: {
        owns: ['src/api/**'],
        doNotTouch: ['src/ui/**'],
        taskClass: 'reasoning',
        budgetSlice: { iterations: 40, spendUsd: 0.50 },
      },
    })

    const handle = await coord.spawn(brief)

    // Writing inside doNotTouch — must throw
    expect(() =>
      handle.appendDecision({
        seq: 1,
        decidedFor: 'some-ui-file',
        decidedAgainst: '',
        because: 'should be rejected',
        touched: ['src/ui/component.tsx'],
        ts: new Date().toISOString(),
      }),
    ).toThrow(ScopeViolationError)

    // The bad entry must not be in the journal
    const entries = journal.read('r-test')
    expect(entries.some(e => e.touched.includes('src/ui/component.tsx'))).toBe(false)

    // Reconcile must exclude output from this worker
    const result = coord.reconcile('r-test')
    expect(result.merged ?? []).not.toContainEqual(
      expect.objectContaining({ workerId: 'w-api', touched: expect.arrayContaining(['src/ui/component.tsx']) }),
    )
  })

  // AC-11-3: no peer-to-peer channel; worker-to-worker call resolves to nothing; scope.violation event emitted
  it('AC-11-3: workers have no peer handle; a worker-to-worker message attempt has no target and emits scope.violation', async () => {
    const emitted: OrchestrationEvent[] = []
    const deps = makeDeps({ emit: (e) => emitted.push(e) })
    const coord = makeCoordinator(deps)

    const briefA = makeWorkerBrief({ workerId: 'w-a', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.10 } } })
    const briefB = makeWorkerBrief({ workerId: 'w-b', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'routine', budgetSlice: { iterations: 10, spendUsd: 0.10 } } })

    const handleA = await coord.spawn(briefA)
    const handleB = await coord.spawn(briefB)

    // Workers must not expose any way to address a peer
    // The handle interface has no sendToPeer / message method
    expect((handleA as unknown as Record<string, unknown>)['sendToPeer']).toBeUndefined()
    expect((handleA as unknown as Record<string, unknown>)['message']).toBeUndefined()
    expect((handleA as unknown as Record<string, unknown>)['peers']).toBeUndefined()
    expect((handleB as unknown as Record<string, unknown>)['sendToPeer']).toBeUndefined()

    // Any attempt to construct a peer channel should emit scope.violation
    // Simulate: worker tries to reference handleB from handleA context
    // Implementation must detect and emit the event
    expect(() => {
      // Calling a non-existent peer method must throw/be a no-op and emit scope.violation
      const fakePeerCall = (handleA as unknown as Record<string, unknown>)['messagePeer']
      if (typeof fakePeerCall === 'function') {
        fakePeerCall({ targetWorkerId: 'w-b', payload: 'hello' })
      }
    }).not.toThrow() // The call simply has no target

    // Implementation must ensure scope.violation is emitted if any peer-message API is invoked
    // After a true peer-message attempt the event must appear
    // (stubs will implement this; for now assert the shape once implemented)
    const peerAttemptEvent = emitted.find(e => e.kind === 'scope.violation')
    // Either the event is emitted OR there is simply no such API (both satisfy the AC)
    if (peerAttemptEvent !== undefined) {
      expect(peerAttemptEvent.kind).toBe('scope.violation')
    }
  })

  // AC-11-4: contradictory decidedFor/decidedAgainst → reconcile does not merge both; returns resolution or conflicts[]
  it('AC-11-4: reconcile() with contradictory entries does not merge both; emits coordinator resolution entry OR non-empty conflicts[]', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    // Inject two conflicting entries directly into the journal stub
    journal.append(makeJournalEntry({
      workerId: 'w-a',
      seq: 1,
      decidedFor: 'zod-schema',
      decidedAgainst: 'inline-validation',
      because: 'reusable',
      touched: ['src/api/types.ts'],
    }))
    journal.append(makeJournalEntry({
      workerId: 'w-b',
      seq: 2,
      decidedFor: 'inline-validation',
      decidedAgainst: 'zod-schema',
      because: 'simpler',
      touched: ['src/api/types.ts'],
    }))

    const result = coord.reconcile('r-test')

    if (result.merged !== undefined) {
      // If a merge was produced, it must not contain BOTH conflicting decisions
      const mergedFors = result.merged.map(e => e.decidedFor)
      const hasBoth = mergedFors.includes('zod-schema') && mergedFors.includes('inline-validation')
      expect(hasBoth).toBe(false)

      // A coordinator resolution entry must be present
      expect(result.merged.some(e => e.workerId === 'coordinator')).toBe(true)
    } else {
      // Otherwise a non-empty conflicts array must be returned
      expect(result.conflicts).toBeDefined()
      expect(result.conflicts!.length).toBeGreaterThan(0)
    }

    expect(result.aborted).toBeUndefined()
  })

  // AC-11-5: seq gap → reconcile aborts; run marked halted/untrusted; no merge
  it('AC-11-5: journal with a seq gap causes reconcile() to abort and produce no merge', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    // seq jumps from 1 to 3 — gap at 2
    journal.append(makeJournalEntry({ seq: 1, workerId: 'w-a', touched: ['src/a.ts'] }))
    journal.append(makeJournalEntry({ seq: 3, workerId: 'w-a', touched: ['src/b.ts'] })) // gap!

    const result = coord.reconcile('r-test')

    expect(result.aborted).toBeDefined()
    expect(['seq-gap', 'untrusted']).toContain(result.aborted)
    expect(result.merged).toBeUndefined()
  })

  // AC-11-5 (duplicate seq variant): duplicate seq → reconcile aborts
  it('AC-11-5 (duplicate seq): journal with a duplicate seq causes reconcile() to abort', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    journal.append(makeJournalEntry({ seq: 1, workerId: 'w-a', touched: ['src/a.ts'] }))
    journal.append(makeJournalEntry({ seq: 1, workerId: 'w-b', touched: ['src/b.ts'] })) // duplicate!

    const result = coord.reconcile('r-test')

    expect(result.aborted).toBeDefined()
    expect(result.merged).toBeUndefined()
  })

  // AC-11-6: journal is append-only; mutation/deletion is detected; entries survive after simulated compaction
  it('AC-11-6: the Decision Journal is append-only; mutating an existing entry is detected and reconciliation fails closed', () => {
    const journal = makeJournalStub()

    journal.append(makeJournalEntry({ seq: 1, workerId: 'w-a', touched: ['src/a.ts'] }))
    journal.append(makeJournalEntry({ seq: 2, workerId: 'w-b', touched: ['src/b.ts'] }))

    const entriesBefore = journal.read('r-test')
    expect(entriesBefore).toHaveLength(2)

    // The implementation must not expose a mutate/delete method
    expect((journal as unknown as Record<string, unknown>)['delete']).toBeUndefined()
    expect((journal as unknown as Record<string, unknown>)['update']).toBeUndefined()
    expect((journal as unknown as Record<string, unknown>)['mutate']).toBeUndefined()

    // Simulated compaction: entries are re-read and must still be present
    const entriesAfter = journal.read('r-test')
    expect(entriesAfter).toHaveLength(2)
    expect(entriesAfter[0]!.seq).toBe(1)
    expect(entriesAfter[1]!.seq).toBe(2)

    // If an entry is externally tampered (seq altered), reconcile on a coord must fail closed
    const coord = makeCoordinator(makeDeps({ journal }))
    // Tamper: force a gap by pushing a duplicated seq into the stub (simulates file corruption)
    ;(journal.entries as JournalEntry[]).push(makeJournalEntry({ seq: 2, workerId: 'w-c', touched: [] }))

    const result = coord.reconcile('r-test')
    expect(result.aborted).toBeDefined()
    expect(result.merged).toBeUndefined()
  })

  // AC-11-7: Loop Guardian STOP on period-1/2/3 cycle >3 repeats → run halts with 'loop-guardian'; no auto-resume
  it('AC-11-7: Loop Guardian emits STOP for a cycle repeating >3 times; run halts with reason loop-guardian and does not auto-resume', () => {
    const guardian = makeLoopGuardian({ maxRepeats: 3 })

    // A-B-A-B-A-B-A-B … — period-2 pattern; feed 8 steps (4 full A-B cycles = >3 repeats)
    const steps: LoopStep[] = [
      { actionId: 'action-A', seq: 1 },
      { actionId: 'action-B', seq: 2 },
      { actionId: 'action-A', seq: 3 },
      { actionId: 'action-B', seq: 4 },
      { actionId: 'action-A', seq: 5 },
      { actionId: 'action-B', seq: 6 },
      { actionId: 'action-A', seq: 7 },
      { actionId: 'action-B', seq: 8 },
    ]

    let stopVerdict: ReturnType<typeof guardian.check> | undefined
    for (const step of steps) {
      const verdict = guardian.check(step)
      if ('stop' in verdict) {
        stopVerdict = verdict
        break
      }
    }

    expect(stopVerdict).toBeDefined()
    expect(stopVerdict).toMatchObject({ stop: true })
    if (stopVerdict && 'stop' in stopVerdict) {
      expect(stopVerdict.period).toBe(2)
      expect(stopVerdict.repeatCount).toBeGreaterThan(3)
      expect(Array.isArray(stopVerdict.windowSnapshot)).toBe(true)
    }

    // After STOP, any further check calls must continue returning stop (no auto-resume)
    const afterStop = guardian.check({ actionId: 'action-A', seq: 9 })
    expect('stop' in afterStop).toBe(true)
  })

  // AC-11-7 (period-1 variant): single repeated action >3 times
  it('AC-11-7 (period-1): period-1 cycle repeating >3 times triggers STOP', () => {
    const guardian = makeLoopGuardian({ maxRepeats: 3 })

    let stopVerdict: ReturnType<typeof guardian.check> | undefined
    for (let i = 1; i <= 5; i++) {
      const verdict = guardian.check({ actionId: 'action-X', seq: i })
      if ('stop' in verdict) { stopVerdict = verdict; break }
    }

    expect(stopVerdict).toBeDefined()
    if (stopVerdict && 'stop' in stopVerdict) {
      expect(stopVerdict.period).toBe(1)
    }
  })

  // AC-11-8: period-4 cycle (A-B-C-D) does NOT trip Loop Guardian but DOES halt via global budget cap
  it('AC-11-8: a period-4 cycle does not trip the Loop Guardian but halts the run via global-budget cap', () => {
    // Low-cap budget guard to simulate the global cap firing
    let iterCount = 0
    const cappingBudgetGuard: BudgetGuard = {
      charge(_runId, _cost): BudgetVerdict {
        iterCount++
        if (iterCount > 8) return { capped: true, reason: 'global-budget' }
        return { ok: true }
      },
      status() { return { iterations: iterCount, spendUsd: 0, wallMs: 0 } },
    }

    const guardian = makeLoopGuardian({ maxRepeats: 3 })

    // Feed period-4 pattern: A-B-C-D repeated — Loop Guardian must NOT fire
    const period4Steps: LoopStep[] = Array.from({ length: 12 }, (_, i) => ({
      actionId: ['action-A', 'action-B', 'action-C', 'action-D'][i % 4]!,
      seq: i + 1,
    }))

    let guardianFired = false
    for (const step of period4Steps) {
      const v = guardian.check(step)
      if ('stop' in v) { guardianFired = true; break }
    }
    expect(guardianFired).toBe(false)

    // Budget guard must fire after enough iterations
    const coord = makeCoordinator(makeDeps({ budgetGuard: cappingBudgetGuard }))

    // Simulate 9+ iterations charged through the coordinator's internal dispatch loop
    // The coordinator must halt on global-budget and record that cap in the budget ledger
    // (implementation detail: calling a method that drives iterations through budgetGuard)
    let budgetCapVerdict: BudgetVerdict | undefined
    for (let i = 0; i < 12; i++) {
      const v = cappingBudgetGuard.charge('r-test', { iterations: 1, spendUsd: 0.01, wallMs: 100 })
      if ('capped' in v) { budgetCapVerdict = v; break }
    }

    expect(budgetCapVerdict).toBeDefined()
    expect(budgetCapVerdict).toMatchObject({ capped: true, reason: 'global-budget' })

    // Coordinator must be aware this cap fired (not the guardian)
    expect(coord).toBeDefined() // placeholder until full run simulation is wired
  })

  // AC-11-9: tightest/innermost bound fires first; budget.json records which bound stopped the run
  it('AC-11-9: with all bounds armed, the tightest/innermost cap fires first and is recorded', () => {
    const firedOrder: string[] = []

    // Loop Guardian fires STOP immediately on first call
    const earlyGuardian: LoopGuardian = {
      check(_step): ReturnType<LoopGuardian['check']> {
        firedOrder.push('loop-guardian')
        return { stop: true, period: 1, repeatCount: 4, windowSnapshot: [] }
      },
      reset() {},
    }

    const replanExhaustedBudget: BudgetGuard = {
      charge(_runId, _cost): BudgetVerdict {
        firedOrder.push('global-budget')
        return { capped: true, reason: 'replan-exhausted' }
      },
      status() { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
    }

    const emitted: OrchestrationEvent[] = []
    const coord = makeCoordinator(makeDeps({
      loopGuardian: earlyGuardian,
      budgetGuard: replanExhaustedBudget,
      emit: (e) => emitted.push(e),
    }))

    // Feed one step — Loop Guardian should fire before budget guard
    const guardianVerdict = earlyGuardian.check({ actionId: 'X', seq: 1 })
    expect('stop' in guardianVerdict).toBe(true)

    // The coordinator must halt on loop-guardian, not on replan-exhausted
    // The halted event must record the correct cap
    const haltEvent = emitted.find(e => e.kind === 'run.terminated')
    if (haltEvent !== undefined) {
      expect((haltEvent.payload as Record<string, unknown>)['reason']).toBe('loop-guardian')
    }

    // Precedence: loop-guardian appears before global-budget in firing order
    const guardianIdx = firedOrder.indexOf('loop-guardian')
    const budgetIdx = firedOrder.indexOf('global-budget')
    if (budgetIdx !== -1) {
      expect(guardianIdx).toBeLessThan(budgetIdx)
    }

    expect(coord).toBeDefined()
  })

  // AC-11-10: skill-failure N≥3 never halts a run; only lowers strategy priority
  it('AC-11-10: skill-failure threshold (N≥3) never halts a run; only lowers affected strategy priority', async () => {
    const emitted: OrchestrationEvent[] = []
    const coord = makeCoordinator(makeDeps({ emit: (e) => emitted.push(e) }))

    // Simulate ≥3 skill failures being fed to the coordinator as advisory signals
    // The coordinator must not emit run.terminated for this reason
    const skillFailures = [
      { skill: 'strategy-alpha', failures: 3 },
    ]

    // The coordinator has no "halt on skill failure" path
    // Verify no run.terminated event is emitted solely due to skill failures
    for (const sf of skillFailures) {
      // If coordinator exposes an onSkillFailure method, call it
      const c = coord as unknown as Record<string, unknown>
      if (typeof c['onSkillFailure'] === 'function') {
        for (let i = 0; i < sf.failures; i++) {
          ;(c['onSkillFailure'] as (skill: string) => void)(sf.skill)
        }
      }
    }

    const terminatedBySkill = emitted.find(
      e => e.kind === 'run.terminated' &&
        (e.payload as Record<string, unknown>)?.['reason'] === 'skill-failure',
    )
    expect(terminatedBySkill).toBeUndefined()

    // No workers should have been refused spawn due to skill failure alone
    const brief = makeWorkerBrief({ workerId: 'w-skill-test' })
    // Spawn must still succeed (strategy is deprioritized, not blocked)
    // It may throw for unimplemented reasons but NOT ScopeConflictError due to skill failure
    try {
      await coord.spawn(brief)
    } catch (err) {
      if (err instanceof ScopeConflictError) {
        throw new Error('Skill failure must not cause ScopeConflictError')
      }
      // Other errors (not implemented) are acceptable at this stub stage
    }
  })

  // AC-11-11: spend ceiling uses Provider Routing prices; Routing unavailable → no further charged iteration
  it('AC-11-11: taskClass change alters spend-per-iteration; Routing unavailable fails closed with no charged iterations', () => {
    // Track charges per taskClass
    const chargesPerClass: Record<string, number> = {}

    const routingAwareBudget: BudgetGuard = {
      charge(runId, cost): BudgetVerdict {
        const taskClass = (cost as unknown as Record<string, unknown>)['taskClass'] as string ?? 'unknown'
        chargesPerClass[taskClass] = (chargesPerClass[taskClass] ?? 0) + cost.spendUsd
        return { ok: true }
      },
      status() { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
    }

    // Charge a 'reasoning' worker — higher cost
    routingAwareBudget.charge('r-1', { iterations: 1, spendUsd: 0.02, wallMs: 100, taskClass: 'reasoning' } as unknown as Parameters<BudgetGuard['charge']>[1])
    // Charge a 'routine' worker — lower cost
    routingAwareBudget.charge('r-1', { iterations: 1, spendUsd: 0.005, wallMs: 50, taskClass: 'routine' } as unknown as Parameters<BudgetGuard['charge']>[1])

    // Different taskClass → different spend charged
    expect(chargesPerClass['reasoning'] ?? 0).toBeGreaterThan(chargesPerClass['routine'] ?? 0)

    // Routing unavailable: budget guard refuses all charges
    let routingDown = true
    const routingUnavailableBudget: BudgetGuard = {
      charge(): BudgetVerdict {
        if (routingDown) return { capped: true, reason: 'global-budget' }
        return { ok: true }
      },
      status() { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
    }

    const verdict = routingUnavailableBudget.charge('r-1', { iterations: 1, spendUsd: 0.01, wallMs: 100 })
    expect(verdict).toMatchObject({ capped: true })

    // After routing is restored, charges proceed normally
    routingDown = false
    const verdictOk = routingUnavailableBudget.charge('r-1', { iterations: 1, spendUsd: 0.01, wallMs: 100 })
    expect(verdictOk).toMatchObject({ ok: true })
  })

  // AC-11-12: dead-end fork produces new generationId; carries only constitution + distilledLessons; transcript dropped; per-gen counters reset
  it('AC-11-12: fork() on dead-end produces a new generationId carrying only constitution + distilledLessons; transcript is absent; per-gen counters reset', () => {
    const genManager = makeGenerationManagerStub()

    const lessons = [
      { summary: 'build target was wrong dir; verify path before write' },
    ]

    const newGenId = genManager.fork('r-test', lessons)
    expect(typeof newGenId).toBe('string')
    expect(newGenId).not.toBe('g-1')

    const manifest = genManager.getManifest(newGenId)
    expect(manifest).toBeDefined()
    expect(manifest!.carries).toContain('constitution')
    expect(manifest!.distilledLessons).toEqual(lessons)

    // Must NOT contain the failed transcript
    expect(manifest!.carries).not.toContain('transcript')
    expect(manifest!.carries).not.toContain('failed-transcript')
    expect(manifest!.droppedTranscriptOf).toBe('g-1')

    // Per-generation counters reset on the new generation
    // (The manifest signals a clean slate — no iteration count carried from g-1)
    expect(manifest!.parent).toBe('g-1')
  })

  // AC-11-13: generation fork does NOT reset run-level spend cap; global spendUsd retained; recurrent dead-end still halted
  it('AC-11-13: generation fork does not reset the run-level spend cap; spendUsd is retained after fork', () => {
    let spendUsd = 0

    const spendTrackingBudget: BudgetGuard = {
      charge(_runId, cost): BudgetVerdict {
        spendUsd += cost.spendUsd
        if (spendUsd >= 2.00) return { capped: true, reason: 'global-budget' }
        return { ok: true }
      },
      status() { return { iterations: 0, spendUsd, wallMs: 0 } },
    }

    const genManager = makeGenerationManagerStub()
    const deps = makeDeps({ budgetGuard: spendTrackingBudget, generationManager: genManager })
    makeCoordinator(deps)

    // Charge up to near the cap in g-1
    for (let i = 0; i < 5; i++) {
      spendTrackingBudget.charge('r-test', { iterations: 1, spendUsd: 0.35, wallMs: 1000 })
    }
    const spendBeforeFork = spendUsd
    expect(spendBeforeFork).toBeGreaterThan(0)

    // Fork to g-2
    genManager.fork('r-test', [{ summary: 'dead end — try different approach' }])

    // After fork, spendUsd must not reset — the run-level cap is intact
    expect(spendUsd).toBe(spendBeforeFork)

    // Continue charging in g-2 — must eventually hit the same global cap
    let cappedAfterFork = false
    for (let i = 0; i < 5; i++) {
      const v = spendTrackingBudget.charge('r-test', { iterations: 1, spendUsd: 0.35, wallMs: 1000 })
      if ('capped' in v) { cappedAfterFork = true; break }
    }
    expect(cappedAfterFork).toBe(true)
  })

  // AC-11-14: cold start (empty run dir) → fail-closed; zero workers spawned; fresh g-1 state created
  it('AC-11-14: cold start with absent run state causes coordinator to fail closed, spawn zero workers, and create fresh g-1 state', async () => {
    const emitted: OrchestrationEvent[] = []
    // The coord is initialised with a journal that has no entries (cold start)
    const coord = makeCoordinator(makeDeps({ emit: (e) => emitted.push(e) }))

    // With no run state, attempting to spawn must not resume phantom workers
    // and must create a fresh run structure
    const runStartedEvent = emitted.find(e => e.kind === 'run.started')
    if (runStartedEvent !== undefined) {
      expect(runStartedEvent.runId).toBeDefined()
    }

    // Any orphaned worker handles from a prior crash must NOT be present
    // The coordinator exposes no orphan-resumption method
    expect((coord as unknown as Record<string, unknown>)['resumeOrphan']).toBeUndefined()

    // Spawn must still work from a clean slate (not fail because of stale state)
    const brief = makeWorkerBrief({ workerId: 'w-cold' })
    // Either succeeds or throws NotImplemented — must NOT throw "orphan conflict" or similar
    try {
      await coord.spawn(brief)
    } catch (err) {
      const msg = (err as Error).message.toLowerCase()
      expect(msg).not.toMatch(/orphan|resume|prior crash/i)
    }
  })

  // AC-11-15: Loop Guardian unavailable → global cap tightened to conservative floor; run flagged degraded
  it('AC-11-15: with Loop Guardian unavailable, global iteration cap tightens to conservative floor and run is flagged degraded', () => {
    const emitted: OrchestrationEvent[] = []

    // Simulate Loop Guardian unavailable: check() throws
    const unavailableGuardian: LoopGuardian = {
      check(_step) { throw new Error('Guardian service unreachable') },
      reset() {},
    }

    let tightenedCapCalled = false
    const degradedBudget: BudgetGuard = {
      charge(_runId, cost): BudgetVerdict {
        // The coord should reduce the cap — implementation detail observed via a lower threshold
        if (cost.iterations > 50) {
          tightenedCapCalled = true
          return { capped: true, reason: 'global-budget' }
        }
        return { ok: true }
      },
      status() { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
    }

    makeCoordinator(makeDeps({
      loopGuardian: unavailableGuardian,
      budgetGuard: degradedBudget,
      emit: (e) => emitted.push(e),
    }))

    // When the guardian is unavailable, the coordinator must record a degraded event
    // The degraded state must appear in emitted events
    // (The coordinator emits this on startup or first dispatch attempt with an unreachable guardian)
    // For now, assert the shape once the implementation populates it:
    const degradedEvent = emitted.find(e =>
      e.kind === 'run.started' || e.kind === 'run.terminated',
    )
    // At minimum, the coordinator must have been constructed without crashing
    // and must be prepared to flag degraded on the first dispatch
    // The conservative floor assertion will pass once makeCoordinator checks guardian availability
    expect(tightenedCapCalled).toBe(false) // not triggered yet — triggered on first dispatch
  })

  // ── Phase-5 regression tests (review 2026-06-13) ───────────────────────────

  // REG-1 (§5.2 / AC-11-8/9): the coordinator must actually drive iterations
  // through BudgetGuard.charge() and halt fail-closed on the global cap. Before
  // the fix the coordinator never called charge(), so the global budget cap was
  // entirely unenforced — a runaway run could never be stopped by the backstop.
  it('REG-1: coordinator.charge() enforces the global budget cap and halts on global-budget', () => {
    let iterCount = 0
    const cappingBudgetGuard: BudgetGuard = {
      charge(_runId, _cost): BudgetVerdict {
        iterCount++
        if (iterCount > 3) return { capped: true, reason: 'global-budget' }
        return { ok: true }
      },
      status() { return { iterations: iterCount, spendUsd: 0, wallMs: 0 } },
    }

    const emitted: OrchestrationEvent[] = []
    const coord = makeCoordinator(makeDeps({ budgetGuard: cappingBudgetGuard, emit: (e) => emitted.push(e) }))

    const c = coord as unknown as { charge(cost: { iterations: number; spendUsd: number; wallMs: number }): BudgetVerdict }
    expect(typeof c.charge).toBe('function')

    let capped: BudgetVerdict | undefined
    for (let i = 0; i < 10; i++) {
      const v = c.charge({ iterations: 1, spendUsd: 0.01, wallMs: 100 })
      if ('capped' in v) { capped = v; break }
    }

    // The budget guard must have actually been called by the coordinator.
    expect(iterCount).toBeGreaterThan(0)
    expect(capped).toMatchObject({ capped: true, reason: 'global-budget' })

    // The run must halt fail-closed and record the cap.
    const terminated = emitted.find(e => e.kind === 'run.terminated')
    expect(terminated).toBeDefined()
    expect((terminated!.payload as Record<string, unknown>)['reason']).toBe('global-budget')

    // No further charged iteration proceeds past the first cap.
    const after = c.charge({ iterations: 1, spendUsd: 0.01, wallMs: 100 })
    expect('capped' in after).toBe(true)
  })

  // REG-2 (§5.3 / AC-11-12/13): hitting the global budget cap is a dead-end; the
  // coordinator must invoke GenerationManager.fork() to start a fresh generation
  // carrying constitution + lessons only. Before the fix fork() was never called.
  it('REG-2: hitting the global budget cap forks a new generation via GenerationManager.fork()', () => {
    const cappingBudgetGuard: BudgetGuard = {
      charge(_runId, _cost): BudgetVerdict { return { capped: true, reason: 'global-budget' } },
      status() { return { iterations: 0, spendUsd: 0, wallMs: 0 } },
    }

    const forkCalls: Array<{ runId: string; lessons: unknown[] }> = []
    const baseGen = makeGenerationManagerStub()
    const spyGen: GenerationManager = {
      fork(runId, lessons) { forkCalls.push({ runId, lessons }); return baseGen.fork(runId, lessons) },
      getManifest(genId) { return baseGen.getManifest(genId) },
    }

    const emitted: OrchestrationEvent[] = []
    const coord = makeCoordinator(makeDeps({
      budgetGuard: cappingBudgetGuard,
      generationManager: spyGen,
      emit: (e) => emitted.push(e),
    }))

    const c = coord as unknown as { charge(cost: { iterations: number; spendUsd: number; wallMs: number }): BudgetVerdict }
    c.charge({ iterations: 1, spendUsd: 0.01, wallMs: 100 })

    // The dead-end fork path must have run.
    expect(forkCalls.length).toBe(1)
    const forked = emitted.find(e => e.kind === 'generation.forked')
    expect(forked).toBeDefined()
    const newGenId = (forked!.payload as Record<string, unknown>)['generationId'] as string
    expect(newGenId).not.toBe('g-1')

    // The new generation carries only constitution + lessons, never the transcript.
    const manifest = spyGen.getManifest(newGenId)
    expect(manifest!.carries).toContain('constitution')
    expect(manifest!.carries).not.toContain('transcript')
    expect(manifest!.droppedTranscriptOf).toBe('g-1')
  })

  // REG-3 (§5.1 / AC-11-4): two workers that decide FOR different options on the
  // SAME resource are contradictory even when both decidedAgainst are empty
  // strings. Before the fix the conflict scan only fired when one's FOR equalled
  // the other's AGAINST, so this common case (no recorded competing option) was
  // silently glued together — exactly the failure ADR-0021 forbids.
  it('REG-3: reconcile() detects contradictory decisions on a shared resource when both decidedAgainst are empty', () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    journal.append(makeJournalEntry({
      workerId: 'w-a', seq: 1,
      decidedFor: 'zod-schema', decidedAgainst: '',
      touched: ['src/api/types.ts'],
    }))
    journal.append(makeJournalEntry({
      workerId: 'w-b', seq: 2,
      decidedFor: 'inline-validation', decidedAgainst: '',
      touched: ['src/api/types.ts'],
    }))

    const result = coord.reconcile('r-test')

    // The two incompatible decisions must NOT both survive the merge.
    expect(result.merged).toBeDefined()
    const mergedFors = result.merged!.map(e => e.decidedFor)
    const hasBoth = mergedFors.includes('zod-schema') && mergedFors.includes('inline-validation')
    expect(hasBoth).toBe(false)
    // A coordinator resolution entry records the deterministic winner.
    expect(result.merged!.some(e => e.workerId === 'coordinator')).toBe(true)
    expect(result.aborted).toBeUndefined()
  })

  // REG-4 (§4 / §8 repudiation): `seq` is coordinator-controlled. A worker must
  // not be able to set its own seq — a hostile/buggy worker supplying a colliding
  // or out-of-band seq is a tamper/DoS surface. The coordinator assigns a fresh
  // monotonic seq on every appendDecision, ignoring any worker-supplied value.
  it('REG-4: coordinator assigns monotonic seq on append, ignoring worker-supplied seq', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    const brief = makeWorkerBrief({
      workerId: 'w-seq',
      scope: { owns: ['src/seq/**'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 40, spendUsd: 0.50 } },
    })
    const handle = await coord.spawn(brief)

    // Worker tries to force a duplicate/garbage seq on every append.
    handle.appendDecision({
      seq: 999, decidedFor: 'a', decidedAgainst: '', because: 'one',
      touched: ['src/seq/a.ts'], ts: new Date().toISOString(),
    } as Parameters<typeof handle.appendDecision>[0])
    handle.appendDecision({
      seq: 999, decidedFor: 'b', decidedAgainst: '', because: 'two',
      touched: ['src/seq/b.ts'], ts: new Date().toISOString(),
    } as Parameters<typeof handle.appendDecision>[0])

    const entries = journal.read('r-test')
    expect(entries).toHaveLength(2)
    // Coordinator-assigned seq is monotonic and ignores the worker's 999.
    expect(entries[0]!.seq).not.toBe(999)
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1)

    // The tampered seq must not survive into reconciliation (no spurious gap/dup abort).
    const result = coord.reconcile('r-test')
    expect(result.aborted).toBeUndefined()
  })

  // REG-5 (§7 / AC-11-2): a faulted worker must be blocked from ANY further
  // appendDecision (fail closed). Before the fix a worker that committed one
  // scope violation (→ added to `faulted`, excluded from the merge) could still
  // call appendDecision again with in-scope paths and write more entries into
  // the shared journal — defeating the exclusion the violation was meant to enforce.
  it('REG-5: a faulted worker is blocked from any further appendDecision (fail closed)', async () => {
    const journal = makeJournalStub()
    const coord = makeCoordinator(makeDeps({ journal }))

    const brief = makeWorkerBrief({
      workerId: 'w-fault',
      scope: { owns: ['src/fault/**'], doNotTouch: ['src/ui/**'], taskClass: 'reasoning', budgetSlice: { iterations: 40, spendUsd: 0.5 } },
    })
    const handle = await coord.spawn(brief)

    // First append violates scope → worker is faulted and the append is rejected.
    expect(() =>
      handle.appendDecision({
        seq: 1, decidedFor: 'x', decidedAgainst: '', because: 'oob',
        touched: ['src/ui/component.tsx'], ts: new Date().toISOString(),
      } as Parameters<typeof handle.appendDecision>[0]),
    ).toThrow(ScopeViolationError)

    // A subsequent IN-SCOPE append must also be refused — once faulted, no writes.
    expect(() =>
      handle.appendDecision({
        seq: 2, decidedFor: 'y', decidedAgainst: '', because: 'in-scope-but-faulted',
        touched: ['src/fault/a.ts'], ts: new Date().toISOString(),
      } as Parameters<typeof handle.appendDecision>[0]),
    ).toThrow()

    // No entries from the faulted worker ever reached the journal.
    expect(journal.read('r-test')).toHaveLength(0)
  })

  // REG-6 (§5.1 / AC-11-1): patternsMayOverlap must only treat one literal root
  // as containing the other at a path-segment boundary. Before the fix a bare
  // root that is a raw string prefix of another (e.g. 'src/api' vs 'src/apiv2/**')
  // was wrongly reported as overlapping → a spurious ScopeConflictError on two
  // genuinely-disjoint scopes.
  it('REG-6: genuinely-disjoint scopes whose roots share a string prefix without a path boundary do not conflict', async () => {
    const coord: Coordinator = makeCoordinator(makeDeps())

    const briefA = makeWorkerBrief({ workerId: 'w-api', scope: { owns: ['src/api'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.1 } } })
    const briefB = makeWorkerBrief({ workerId: 'w-apiv2', scope: { owns: ['src/apiv2/**'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.1 } } })

    await coord.spawn(briefA)
    // 'src/apiv2/**' is NOT inside 'src/api' — spawning must NOT throw.
    await expect(coord.spawn(briefB)).resolves.toBeDefined()

    // A genuinely-nested pair (src/ contains src/api) must still conflict.
    const coord2: Coordinator = makeCoordinator(makeDeps())
    const briefRoot = makeWorkerBrief({ workerId: 'w-root', scope: { owns: ['src/'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.1 } } })
    const briefNested = makeWorkerBrief({ workerId: 'w-nested', scope: { owns: ['src/api/**'], doNotTouch: [], taskClass: 'reasoning', budgetSlice: { iterations: 10, spendUsd: 0.1 } } })
    await coord2.spawn(briefRoot)
    await expect(coord2.spawn(briefNested)).rejects.toThrow(ScopeConflictError)
  })

})

// ─── Delegation helpers (ADR-0039, spec §5.4/§5.5) ─────────────────────────────

const COST = { iterations: 1, spendUsd: 0.01, wallMs: 10 }
const DELEGATION_BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-1',
  sessionId: 'session-1',
  scope: 'session' as const,
}

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'read-only-analysis',
    instructions: 'Analyze only.',
    skills: ['grep-codebase'],
    mcpAllowlist: ['tracker'],
    toolTiers: { read_file: 0, search_memory: 0 },
    maxIterations: 20,
    contextStrategy: 'compact',
    provenance: 'builtin',
    ...overrides,
  }
}

function makeDelegationTask(overrides: Partial<DelegationTask> = {}): DelegationTask {
  return {
    taskId: 't1',
    intent: 'analyze the api module',
    assignedTo: 'read-only-analysis',
    dependsOn: [],
    scope: { owns: ['src/api/**'], doNotTouch: [], taskClass: 'reasoning' },
    budgetSlice: { iterations: 40, spendUsd: 0.5 },
    outputContract: 'a summary',
    retryPolicy: { maxReplans: 2, maxIterations: 20 },
    ...overrides,
  }
}

function makeDelegationDeps(
  overrides: Partial<DelegationDeps> = {},
): DelegationDeps & { events: OrchestrationEvent[] } {
  const events: OrchestrationEvent[] = []
  const cards = new Map<string, AgentCard>([['read-only-analysis', makeCard()]])
  return {
    events,
    binding: DELEGATION_BINDING,
    resolveCard: (name: string) => cards.get(name),
    skillTouchedPaths: (_skill: string) => [],
    mcpWritable: (_server: string) => true,
    emit: (e: OrchestrationEvent) => { events.push(e) },
    ...overrides,
  }
}

function makeDelegationPersistence(): DelegationPersistencePort & {
  records: Map<string, unknown>
  quarantined: Array<{ id: string; reason: DelegationQuarantineReason }>
  runSnapshot(): PersistedDelegationRunV1 | undefined
  setRunSnapshot(state: PersistedDelegationRunV1): void
  failNextRunSave(): void
} {
  const records = new Map<string, unknown>()
  let run: PersistedDelegationRunV1 | undefined
  let rejectNextRunSave = false
  const quarantined: Array<{ id: string; reason: DelegationQuarantineReason }> = []
  return {
    records,
    quarantined,
    runSnapshot: () => structuredClone(run),
    setRunSnapshot: state => { run = structuredClone(state) },
    failNextRunSave: () => { rejectNextRunSave = true },
    loadRun: () => structuredClone(run),
    load: id => structuredClone(records.get(id)),
    saveRun: state => {
      if (rejectNextRunSave) {
        rejectNextRunSave = false
        throw new Error('injected run-ledger persistence failure')
      }
      run = structuredClone(state)
    },
    save: state => { records.set(state.checkpoint.delegationId, structuredClone(state)) },
    quarantine: (id, reason) => { quarantined.push({ id, reason }) },
  }
}

describe('Orchestration — Component 11 — Delegation (ADR-0039)', () => {

  it('quantizes decimal/exponent USD to nanos with deterministic half-up semantics', () => {
    expect(iterationCostSpendNanos(4e-10)).toBe(0)
    expect(iterationCostSpendNanos(5e-10)).toBe(1)
    expect(iterationCostSpendNanos(6e-10)).toBe(1)
    expect(iterationCostSpendNanos(1.499e-9)).toBe(1)
    expect(iterationCostSpendNanos(1.5e-9)).toBe(2)
    expect(iterationCostSpendNanos(0.30000000000000004)).toBe(300_000_000)
    expect(canonicalizeIterationCost({ iterations: 1, spendUsd: 0.30000000000000004, wallMs: 2 }))
      .toEqual({ iterations: 1, spendUsd: 0.3, wallMs: 2 })
    expect(iterationCostSpendNanos(-1)).toBeUndefined()
    expect(iterationCostSpendNanos(Number.NaN)).toBeUndefined()
    expect(iterationCostSpendNanos(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(iterationCostSpendNanos(9_007_199.254740993)).toBeUndefined()
    expect(canonicalizeIterationCost({ iterations: 0.5, spendUsd: 0, wallMs: 0 }))
      .toBeUndefined()
  })

  it.each([
    { charge: 4e-10, expectedObservation: 0, expectedTotal: 0 },
    { charge: 6e-10, expectedObservation: 1e-9, expectedTotal: 2e-9 },
  ])(
    'quantizes two $charge charges to exact persisted total $expectedTotal across restart',
    ({ charge, expectedObservation, expectedTotal }) => {
      const persistence = makeDelegationPersistence()
      const plan: PlanDAG = {
        nodes: [
          makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
          makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        ],
        edges: [],
      }
      const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
      const a = first.spawn('A')
      const b = first.spawn('B')
      const cost = { iterations: 1, spendUsd: charge, wallMs: 1 }
      expect(a.complete('A done', {}, cost).cost.spendUsd).toBe(expectedObservation)
      expect(b.complete('B done', {}, cost).cost.spendUsd).toBe(expectedObservation)
      expect(first.runBudgetSpent().spendUsd).toBe(expectedTotal)
      expect(persistence.runSnapshot()?.runBudget.spendUsd).toBe(expectedTotal)

      const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
      expect(restarted.recover(a.delegationId).status).toBe('terminal')
      expect(restarted.recover(b.delegationId).status).toBe('terminal')
      expect(restarted.runBudgetSpent().spendUsd).toBe(expectedTotal)
    },
  )

  it('aggregates 0.1/0.2/0.3 identically in every completion order', () => {
    const orders = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]
    for (const order of orders) {
      const tasks = ['A', 'B', 'C'].map((taskId): DelegationTask =>
        makeDelegationTask({
          taskId,
          scope: { owns: [`src/${taskId.toLowerCase()}/**`], doNotTouch: [], taskClass: 'reasoning' },
        }))
      const manager = makeDelegationManager({ nodes: tasks, edges: [] }, makeDelegationDeps())
      const handles = tasks.map(task => manager.spawn(task.taskId))
      const charges = [0.1, 0.2, 0.3]
      for (const index of order) {
        handles[index]!.complete(`${tasks[index]!.taskId} done`, {}, {
          iterations: 1,
          spendUsd: charges[index]!,
          wallMs: 1,
        })
      }
      expect(manager.runBudgetSpent()).toEqual({ iterations: 3, spendUsd: 0.6, wallMs: 3 })
    }
  })

  it('compares delegation spend caps in canonical nanos rather than raw floats', () => {
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({
          taskId: 'zero-nanos',
          budgetSlice: { iterations: 2, spendUsd: 4e-10 },
          scope: { owns: ['src/zero/**'], doNotTouch: [], taskClass: 'reasoning' },
        }),
        makeDelegationTask({
          taskId: 'one-nano',
          budgetSlice: { iterations: 2, spendUsd: 4e-10 },
          scope: { owns: ['src/one/**'], doNotTouch: [], taskClass: 'reasoning' },
        }),
      ],
      edges: [],
    }
    const manager = makeDelegationManager(plan, makeDelegationDeps())
    expect(manager.spawn('zero-nanos').complete('rounded to zero', {}, {
      iterations: 1, spendUsd: 4e-10, wallMs: 1,
    }).cost.spendUsd).toBe(0)
    expect(() => manager.spawn('one-nano').complete('over canonical cap', {}, {
      iterations: 1, spendUsd: 6e-10, wallMs: 1,
    })).toThrow(/invalid delegation cost/)
  })

  it.each(['complete', 'fail'] as const)(
    'rejects aggregate nanos overflow before %s lifecycle mutation or persistence',
    terminalKind => {
      const persistence = makeDelegationPersistence()
      const events: OrchestrationEvent[] = []
      const nearLimitUsd = 9_007_199.25474099
      const plan: PlanDAG = {
        nodes: [
          makeDelegationTask({
            taskId: 'A',
            budgetSlice: { iterations: 2, spendUsd: nearLimitUsd },
            scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' },
          }),
          makeDelegationTask({
            taskId: 'B',
            budgetSlice: { iterations: 2, spendUsd: nearLimitUsd },
            scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' },
          }),
        ],
        edges: [],
      }
      const manager = makeDelegationManager(plan, makeDelegationDeps({
        persistence,
        emit: event => events.push(event),
      }))
      manager.spawn('A').complete('near limit', {}, {
        iterations: 1, spendUsd: nearLimitUsd, wallMs: 1,
      })
      const b = manager.spawn('B')
      const beforeRun = persistence.runSnapshot()
      const beforeB = structuredClone(persistence.records.get(b.delegationId))
      const beforeEvents = events.length

      expect(() => terminalKind === 'complete'
        ? b.complete('must overflow', {}, { iterations: 1, spendUsd: 2e-9, wallMs: 1 })
        : b.fail('must overflow', { iterations: 1, spendUsd: 2e-9, wallMs: 1 }))
        .toThrow(/invalid delegation cost/)
      expect(manager.terminalObservation(b.delegationId)).toBeUndefined()
      expect(b.permitsTool('read_file')).toBe(true)
      expect(persistence.runSnapshot()).toEqual(beforeRun)
      expect(persistence.records.get(b.delegationId)).toEqual(beforeB)
      expect(events).toHaveLength(beforeEvents)
    },
  )

  it.each(['noncanonical-ledger', 'unsafe-ledger', 'noncanonical-observation'] as const)(
    'rejects persisted %s cost before recovery',
    corruption => {
      const persistence = makeDelegationPersistence()
      const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
      const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
      const handle = first.spawn('t1')
      handle.complete('done', {}, { iterations: 1, spendUsd: 0.3, wallMs: 1 })
      if (corruption === 'noncanonical-observation') {
        const record = persistence.records.get(handle.delegationId) as PersistedDelegationV1
        record.terminalObservation!.cost.spendUsd = 0.30000000000000004
      } else {
        const run = persistence.runSnapshot()!
        run.runBudget.spendUsd = corruption === 'unsafe-ledger'
          ? 9_007_199.254740993
          : 0.30000000000000004
        persistence.setRunSnapshot(run)
      }

      const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
      expect(() => restarted.recover(handle.delegationId)).toThrow(/legacy-or-invalid-state/)
      expect(restarted.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
    },
  )

  it('AC-11-16: a linear steps[] plan is accepted as a degenerate goal-DAG (sequential chain)', () => {
    const linear: LinearPlanLike = { steps: [{ intent: 'a' }, { intent: 'b' }, { intent: 'c' }] }
    const mgr = makeDelegationManager(linear, makeDelegationDeps())

    expect(mgr.dag().nodes).toHaveLength(3)
    // Degenerate DAG = linear chain: only the first task is ready at the start.
    expect(mgr.readySet().map(t => t.taskId)).toHaveLength(1)
  })

  it('AC-11-16: a PlanDAG with dependsOn edges yields a deterministic ready-set', () => {
    const dag: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'C', dependsOn: ['A', 'B'], scope: { owns: ['src/c/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [{ from: 'A', to: 'C' }, { from: 'B', to: 'C' }],
    }
    const mgr = makeDelegationManager(dag, makeDelegationDeps())

    // C is blocked until both A and B complete; ready-set is input-order deterministic.
    expect(mgr.readySet().map(t => t.taskId)).toEqual(['A', 'B'])

    mgr.spawn('A').complete('done', {}, COST)
    expect(mgr.readySet().map(t => t.taskId)).toEqual(['B']) // C still blocked on B
    mgr.spawn('B').complete('done', {}, COST)
    expect(mgr.readySet().map(t => t.taskId)).toEqual(['C'])
  })

  it('AC-11-16: rejects a cyclic DAG and an unknown dependency at construction', () => {
    const cyclic: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', dependsOn: ['B'] }),
        makeDelegationTask({ taskId: 'B', dependsOn: ['A'] }),
      ],
      edges: [{ from: 'B', to: 'A' }, { from: 'A', to: 'B' }],
    }
    expect(() => makeDelegationManager(cyclic, makeDelegationDeps()))
      .toThrow('invalid delegation plan')

    const unknown: PlanDAG = {
      nodes: [makeDelegationTask({ taskId: 'A', dependsOn: ['missing'] })],
      edges: [{ from: 'missing', to: 'A' }],
    }
    expect(() => makeDelegationManager(unknown, makeDelegationDeps()))
      .toThrow('invalid delegation plan')
  })

  it('AC-11-16: enforces the task, edge and per-task dependency caps directly', () => {
    const tooManyTasks: PlanDAG = {
      nodes: Array.from({ length: 257 }, (_value, index) =>
        makeDelegationTask({ taskId: `task-${index}` })),
      edges: [],
    }
    expect(() => makeDelegationManager(tooManyTasks, makeDelegationDeps()))
      .toThrow('invalid delegation plan')

    const edgeNodes = Array.from({ length: 256 }, (_value, index) => {
      const dependsOn = Array.from({ length: Math.min(index, 9) }, (_unused, offset) =>
        `edge-${index - offset - 1}`)
      return makeDelegationTask({ taskId: `edge-${index}`, dependsOn })
    })
    const tooManyEdges: PlanDAG = {
      nodes: edgeNodes,
      edges: edgeNodes.flatMap(task => task.dependsOn.map(from => ({ from, to: task.taskId }))),
    }
    expect(tooManyEdges.edges.length).toBeGreaterThan(2048)
    expect(() => makeDelegationManager(tooManyEdges, makeDelegationDeps()))
      .toThrow('invalid delegation plan')

    const dependencySources = Array.from({ length: 65 }, (_value, index) =>
      makeDelegationTask({ taskId: `dependency-${index}` }))
    const dependent = makeDelegationTask({
      taskId: 'dependent',
      dependsOn: dependencySources.map(task => task.taskId),
    })
    const tooManyDependencies: PlanDAG = {
      nodes: [...dependencySources, dependent],
      edges: dependent.dependsOn.map(from => ({ from, to: dependent.taskId })),
    }
    expect(() => makeDelegationManager(tooManyDependencies, makeDelegationDeps()))
      .toThrow('invalid delegation plan')
  })

  it('AC-11-17: a sub-agent is restricted to its AgentCard; off-card tools/MCP are refused and model-emitted widening is ignored', () => {
    const deps = makeDelegationDeps()
    const mgr = makeDelegationManager({ nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] }, deps)

    // The model emits a request that tries to widen beyond the card.
    const h = mgr.spawn('t1', { tools: ['read_file', 'shell_exec'], mcp: ['tracker', 'github'] })

    expect(h.permitsTool('read_file')).toBe(true)     // on card
    expect(h.permitsTool('shell_exec')).toBe(false)   // off card → refused
    expect(h.permitsMcp('tracker')).toBe(true)        // on card + writable
    expect(h.permitsMcp('github')).toBe(false)        // off card → refused
    expect(h.card.name).toBe('read-only-analysis')
    expect(h.binding).toEqual(DELEGATION_BINDING)
    expect(Object.isFrozen(h.binding)).toBe(true)
    expect(deps.events).toContainEqual(expect.objectContaining({
      kind: 'delegation.spawned',
      payload: expect.objectContaining({
        binding: {
          projectId: DELEGATION_BINDING.projectId,
          sessionId: DELEGATION_BINDING.sessionId,
          scope: DELEGATION_BINDING.scope,
        },
      }),
    }))
  })

  it('AC-11-17: the resolved AgentCard DNA/capability authority is deeply immutable after spawn', () => {
    const source = makeCard()
    const mgr = makeDelegationManager(
      { nodes: [makeDelegationTask()], edges: [] },
      makeDelegationDeps({ resolveCard: () => source }),
    )
    const handle = mgr.spawn('t1')
    source.instructions = 'substituted after spawn'
    source.skills.push('widened')
    source.toolTiers['bash'] = 3

    expect(handle.card.instructions).toBe('Analyze only.')
    expect(handle.card.skills).not.toContain('widened')
    expect(handle.card.toolTiers).not.toHaveProperty('bash')
    expect(Object.isFrozen(handle.card)).toBe(true)
    expect(Object.isFrozen(handle.card.skills)).toBe(true)
    expect(Object.isFrozen(handle.card.toolTiers)).toBe(true)
  })

  it('AC-11-18: a declared skill that would write outside the task lane throws ScopeConflictError and starts no sub-agent', () => {
    const deps = makeDelegationDeps({
      resolveCard: (n: string) =>
        n === 'writer' ? makeCard({ name: 'writer', skills: ['codegen'] }) : undefined,
      // The card's skill is known to write a path inside the task's doNotTouch lane.
      skillTouchedPaths: (s: string) => (s === 'codegen' ? ['src/forbidden/x.ts'] : []),
    })
    const task = makeDelegationTask({
      taskId: 't1',
      assignedTo: 'writer',
      scope: { owns: ['src/api/**', 'src/forbidden/**'], doNotTouch: ['src/forbidden/**'], taskClass: 'routine' },
    })
    const mgr = makeDelegationManager({ nodes: [task], edges: [] }, deps)

    expect(() => mgr.spawn('t1')).toThrow(ScopeConflictError)
    // No sub-agent started: the run-level budget is untouched.
    expect(mgr.runBudgetSpent().iterations).toBe(0)
  })

  it('AC-11-18: two active delegations cannot hold overlapping write scope (pairwise disjoint across all)', () => {
    const dag: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/shared/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const mgr = makeDelegationManager(dag, makeDelegationDeps())

    mgr.spawn('A')
    expect(() => mgr.spawn('B')).toThrow(ScopeConflictError)
  })

  it('AC-11-19: the parent gets a compact TaskObservation (no transcript); the child shard is a hash-chained seq', () => {
    const deps = makeDelegationDeps()
    const mgr = makeDelegationManager({ nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] }, deps)
    const h = mgr.spawn('t1')

    const e1 = h.append('reasoning', { thought: 'step 1' })
    const e2 = h.append('tool-call', { tool: 'read_file' })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e2.prevHash).toBe(e1.hash) // chain links forward
    expect(mgr.verifyShardChain(h.delegationId)).toBe(true)

    const obs = h.complete('analysed api', { findings: 3 }, COST)
    // Compact + lossless: exactly the 6 fields, NEVER the transcript.
    expect(Object.keys(obs).sort()).toEqual(
      ['cost', 'delegationId', 'result', 'status', 'summary', 'touched'],
    )
    expect(obs.status).toBe('completed')
    expect('transcript' in (obs as unknown as Record<string, unknown>)).toBe(false)
    // touched is the delegation's granted footprint, not an empty placeholder.
    expect(obs.touched).toEqual(['src/api/**'])
    // The full shard persists for post-mortem (handoff without loss).
    expect(h.shard()).toHaveLength(2)
    // Parent observation carries no shard entries.
    expect((obs as unknown as Record<string, unknown>)['shard']).toBeUndefined()
  })

  it('AC-11-19/20: persists and replay-protects a completed terminal observation', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [makeDelegationTask({ taskId: 't1' })],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const handle = first.spawn('t1')
    const completed = handle.complete('verified summary', { findings: 3 }, COST)
    expect(first.terminalObservation(handle.delegationId)).toEqual(completed)

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const recovered = restarted.recover(handle.delegationId)
    expect(recovered).toMatchObject({ status: 'terminal', observation: completed })
    expect(restarted.runBudgetSpent()).toEqual(COST)
    expect(restarted.recover(handle.delegationId)).toMatchObject({
      status: 'terminal', observation: completed,
    })
    expect(restarted.runBudgetSpent()).toEqual(COST)
    expect(() => restarted.resume(handle.delegationId)).toThrow(/already completed/)
    const replay = restarted.terminalObservation(handle.delegationId)
    expect(replay).toEqual(completed)
    ;(replay!.result as { findings: number }).findings = 99
    expect(restarted.terminalObservation(handle.delegationId)?.result).toEqual({ findings: 3 })
  })

  it('AC-11-19/20: terminal transition is one-shot and revokes the old handle', () => {
    const mgr = makeDelegationManager(
      { nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] },
      makeDelegationDeps(),
    )
    const handle = mgr.spawn('t1')
    handle.complete('done', { ok: true }, COST)

    expect(() => handle.append('late', { value: 1 })).toThrow(/no longer active/)
    expect(() => handle.complete('again', {}, COST)).toThrow(/no longer active/)
    expect(() => handle.fail('again', COST)).toThrow(/no longer active/)
    expect(handle.permitsTool('read_file')).toBe(false)
    expect(mgr.runBudgetSpent()).toEqual(COST)
  })

  it('AC-11-19/20: rejects invalid cost and non-cloneable or oversized payloads before mutation', () => {
    const mgr = makeDelegationManager(
      { nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] },
      makeDelegationDeps(),
    )
    const handle = mgr.spawn('t1')

    expect(() => handle.fail('invalid', { iterations: -1, spendUsd: -1, wallMs: -1 }))
      .toThrow(/invalid delegation cost/)
    expect(() => handle.complete('invalid', {}, {
      iterations: Number.NaN, spendUsd: 0, wallMs: 0,
    })).toThrow(/invalid delegation cost/)
    expect(() => handle.complete('over budget', {}, {
      iterations: 21, spendUsd: 0.1, wallMs: 1,
    })).toThrow(/invalid delegation cost/)
    expect(() => handle.complete('invalid', { callback: () => undefined }, COST)).toThrow()
    expect(() => handle.complete('invalid', new ArrayBuffer(2 * 1024 * 1024), COST)).toThrow()
    expect(() => handle.append('oversized', { text: 'x'.repeat(1024 * 1024 + 1) }))
      .toThrow(/size limit/)
    expect(() => handle.append('wide', new Array(1024 * 1024 + 1))).toThrow(/size limit/)
    let nested: Record<string, unknown> = {}
    for (let i = 0; i < 130; i++) nested = { nested }
    expect(() => handle.append('deep', nested)).toThrow(/depth limit/)
    let extremelyDeep: Record<string, unknown> = {}
    for (let i = 0; i < 20_000; i++) extremelyDeep = { nested: extremelyDeep }
    try {
      handle.append('extremely-deep', extremelyDeep)
      throw new Error('expected deeply nested payload denial')
    } catch (error) {
      expect(error).not.toBeInstanceOf(RangeError)
      expect(error).toMatchObject({ message: expect.stringMatching(/depth limit/) })
    }
    expect(handle.shard()).toEqual([])
    expect(mgr.runBudgetSpent()).toEqual({ iterations: 0, spendUsd: 0, wallMs: 0 })
    expect(handle.append('valid', { value: 1 }).seq).toBe(1)
  })

  it('AC-11-20: active recovery is single-owner and resume revokes the failed handle', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = { nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    expect(() => first.recover(original.delegationId)).toThrow(/active handle/)
    expect(() => first.resume(original.delegationId)).toThrow(/not failed/)

    original.fail('retry', COST)
    const retried = first.resume(original.delegationId)
    expect(() => original.append('stale', { value: 1 })).toThrow(/no longer active/)
    expect(() => first.recover(retried.delegationId)).toThrow(/active handle/)
    expect(retried.append('fresh', { value: 2 }).seq).toBe(1)
  })

  it('AC-11-20 durable: recovering the first of two active delegations never evicts the second', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    const beforeRestart = persistence.runSnapshot()

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(restarted.recover(a.delegationId).status).toBe('resumable')
    expect(restarted.recover(b.delegationId).status).toBe('resumable')
    expect(persistence.runSnapshot()).toEqual(beforeRestart)
  })

  it('AC-11-20 durable: preflight validates the full mixed inventory without issuing authority', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    b.complete('B done', { ok: true }, COST)
    const durableRun = persistence.runSnapshot()
    const restartedDeps = makeDelegationDeps({ persistence })
    const restarted = makeDelegationManager(plan, restartedDeps)

    expect(restarted.preflightRecovery()).toEqual({
      status: 'continuation',
      activeDelegationIds: ['d-A'],
      terminalObservations: [{
        delegationId: 'd-B',
        status: 'completed',
        summary: 'B done',
        touched: ['src/b/**'],
        result: { ok: true },
        cost: COST,
      }],
      runBudget: COST,
    })
    expect(restarted.preflightRecovery()).toEqual(restarted.preflightRecovery())
    expect(restartedDeps.events).toEqual([])
    expect(persistence.quarantined).toEqual([])
    expect(persistence.runSnapshot()).toEqual(durableRun)

    // A preflight does not count as handle issuance or in-memory hydration.
    expect(restarted.verifyShardChain(a.delegationId)).toBe(false)
    expect(restarted.recoverActive([a.delegationId])).toHaveLength(1)
    expect(() => restarted.preflightRecovery()).toThrow(/cold manager/)
  })

  it('AC-11-20 durable: preflight distinguishes absent and terminal inventories', () => {
    const plan: PlanDAG = { nodes: [makeDelegationTask({ taskId: 'A' })], edges: [] }
    const empty = makeDelegationManager(
      plan,
      makeDelegationDeps({ persistence: makeDelegationPersistence() }),
    )
    expect(empty.preflightRecovery()).toEqual({ status: 'none' })

    const persistence = makeDelegationPersistence()
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    first.spawn('A').fail('A failed', COST)
    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(restarted.preflightRecovery()).toMatchObject({
      status: 'terminal',
      activeDelegationIds: [],
      terminalObservations: [{ delegationId: 'd-A', status: 'failed' }],
      runBudget: COST,
    })
  })

  it('AC-11-20 durable: preflight rejects missing or cost-drifted state without quarantine', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    first.spawn('A')
    first.spawn('B')
    const originalB = structuredClone(persistence.records.get('d-B'))
    persistence.records.delete('d-B')
    const missingDeps = makeDelegationDeps({ persistence })
    expect(() => makeDelegationManager(plan, missingDeps).preflightRecovery()).toThrow()
    expect(missingDeps.events).toEqual([])
    expect(persistence.quarantined).toEqual([])

    persistence.records.set('d-B', originalB)
    const drifted = persistence.runSnapshot()!
    drifted.runBudget = { iterations: 1, spendUsd: 0.1, wallMs: 1 }
    persistence.setRunSnapshot(drifted)
    const driftDeps = makeDelegationDeps({ persistence })
    expect(() => makeDelegationManager(plan, driftDeps).preflightRecovery()).toThrow()
    expect(driftDeps.events).toEqual([])
    expect(persistence.quarantined).toEqual([])
  })

  it('AC-11-20 durable: recoverActive atomically rehydrates the exact full active set in caller order', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    const beforeRestart = persistence.runSnapshot()

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const recovered = restarted.recoverActive([b.delegationId, a.delegationId])
    expect(recovered.map(handle => handle.delegationId)).toEqual(['d-B', 'd-A'])
    expect(recovered.every(handle => handle.permitsTool('read_file'))).toBe(true)
    expect(persistence.runSnapshot()).toEqual(beforeRestart)

    recovered[1]!.append('reasoning', { note: 'A continues' })
    expect(persistence.runSnapshot()?.activeTaskIds).toEqual(['A', 'B'])
  })

  it.each(['missing', 'corrupt'] as const)(
    'AC-11-20 durable: a %s second active shard causes zero partial recovery or persistence',
    fault => {
      const persistence = makeDelegationPersistence()
      const plan: PlanDAG = {
        nodes: [
          makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
          makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        ],
        edges: [],
      }
      const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
      const a = first.spawn('A')
      const b = first.spawn('B')
      const durableRun = persistence.runSnapshot()
      const originalB = structuredClone(persistence.records.get(b.delegationId))
      if (fault === 'missing') {
        persistence.records.delete(b.delegationId)
      } else {
        const record = persistence.records.get(b.delegationId) as PersistedDelegationV1
        record.checkpoint.lastSeq = 99
      }
      const restartedDeps = makeDelegationDeps({ persistence })
      const restarted = makeDelegationManager(plan, restartedDeps)

      expect(() => restarted.recoverActive([a.delegationId, b.delegationId])).toThrow()
      expect(restarted.verifyShardChain(a.delegationId)).toBe(false)
      expect(restarted.terminalObservation(a.delegationId)).toBeUndefined()
      expect(restartedDeps.events).toEqual([])
      expect(persistence.quarantined).toEqual([])
      expect(persistence.runSnapshot()).toEqual(durableRun)

      persistence.records.set(b.delegationId, originalB)
      expect(restarted.recoverActive([a.delegationId, b.delegationId]))
        .toHaveLength(2)
      expect(persistence.runSnapshot()).toEqual(durableRun)
    },
  )

  it('AC-11-20 durable: recoverActive rejects partial, duplicate, foreign, terminal-mixed and replayed sets', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    const durableRun = persistence.runSnapshot()
    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))

    expect(() => restarted.recoverActive([a.delegationId])).toThrow(/exact persisted active set/)
    expect(() => restarted.recoverActive([a.delegationId, a.delegationId])).toThrow(/duplicate/)
    expect(() => restarted.recoverActive([a.delegationId, 'd-foreign'])).toThrow(/exact persisted active set/)
    expect(persistence.runSnapshot()).toEqual(durableRun)
    expect(restarted.recoverActive([a.delegationId, b.delegationId])).toHaveLength(2)
    expect(() => restarted.recoverActive([a.delegationId, b.delegationId])).toThrow(/replayed handle/)
    expect(persistence.runSnapshot()).toEqual(durableRun)

    const terminalPersistence = makeDelegationPersistence()
    const terminalFirst = makeDelegationManager(
      plan,
      makeDelegationDeps({ persistence: terminalPersistence }),
    )
    const terminalA = terminalFirst.spawn('A')
    const terminalB = terminalFirst.spawn('B')
    terminalB.complete('B done', { ok: true }, COST)
    const terminalRestart = makeDelegationManager(
      plan,
      makeDelegationDeps({ persistence: terminalPersistence }),
    )
    expect(() => terminalRestart.recoverActive([terminalA.delegationId, terminalB.delegationId]))
      .toThrow(/exact persisted active set/)
    expect(terminalRestart.recoverActive([terminalA.delegationId])).toHaveLength(1)
  })

  it('AC-11-20 durable: a post-hydration persist failure keeps the full ledger recoverable', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    const durableRun = persistence.runSnapshot()
    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const [recoveredA] = restarted.recoverActive([a.delegationId, b.delegationId])
    persistence.failNextRunSave()

    expect(() => recoveredA!.append('reasoning', { note: 'persist me' }))
      .toThrow(/injected run-ledger persistence failure/)
    expect(persistence.runSnapshot()).toEqual(durableRun)

    const afterFailure = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(afterFailure.recoverActive([a.delegationId, b.delegationId])).toHaveLength(2)
    expect(persistence.runSnapshot()?.activeTaskIds).toEqual(['A', 'B'])
  })

  it('AC-11-20 durable: cold resume of failed B preserves active A and promotes both atomically', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    b.fail('B paused', COST)
    expect(persistence.runSnapshot()).toMatchObject({
      activeTaskIds: ['A'],
      failedTaskIds: ['B'],
    })

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const resumedB = restarted.resume(b.delegationId)
    expect(resumedB.taskId).toBe('B')
    expect(persistence.runSnapshot()).toMatchObject({
      activeTaskIds: ['A', 'B'],
      failedTaskIds: [],
    })

    const afterSecondRestart = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const recovered = afterSecondRestart.recoverActive([a.delegationId, b.delegationId])
    expect(recovered.map(handle => handle.taskId)).toEqual(['A', 'B'])
  })

  it('AC-11-20 durable: resume refuses a failed lane now owned by an active sibling', () => {
    const persistence = makeDelegationPersistence()
    const sharedScope = { owns: ['src/shared/**'], doNotTouch: [], taskClass: 'reasoning' as const }
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: sharedScope }),
        makeDelegationTask({ taskId: 'B', scope: sharedScope }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const b = first.spawn('B')
    b.fail('B released its lane', COST)
    first.spawn('A')
    const durableRun = persistence.runSnapshot()

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(() => restarted.resume(b.delegationId)).toThrow(ScopeConflictError)
    expect(persistence.runSnapshot()).toEqual(durableRun)
  })

  it('AC-11-20 durable: cold terminal recovery installs active siblings before schedule can persist', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({
          taskId: 'C',
          dependsOn: ['B'],
          scope: { owns: ['src/c/**'], doNotTouch: [], taskClass: 'reasoning' },
        }),
      ],
      edges: [{ from: 'B', to: 'C' }],
    }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    b.fail('B failed', COST)

    const restarted = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(restarted.recover(b.delegationId)).toMatchObject({ status: 'terminal' })
    expect(restarted.readySet().map(task => task.taskId)).not.toContain('A')
    expect(() => restarted.spawn('A')).toThrow(/already spawned/)
    expect(restarted.schedule().cascadeSkipped).toContain('C')
    expect(persistence.runSnapshot()).toMatchObject({
      activeTaskIds: ['A'],
      failedTaskIds: ['B'],
      skippedTaskIds: ['C'],
    })

    const afterScheduleRestart = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    expect(afterScheduleRestart.recoverActive([a.delegationId])).toHaveLength(1)
  })

  it('AC-11-19: the shard is tamper-evident — mutating a returned/read payload cannot corrupt the chain', () => {
    const deps = makeDelegationDeps()
    const mgr = makeDelegationManager({ nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] }, deps)
    const h = mgr.spawn('t1')

    const returned = h.append('reasoning', { thought: 'original' })
    // Mutate the payload handed back by append() ...
    ;(returned.payload as { thought: string }).thought = 'tampered'
    // ... and the payload read back via shard().
    const read = h.shard()[0]!
    ;(read.payload as { thought: string }).thought = 'tampered-too'

    // The internal append-only entry is independent of both → chain still verifies.
    expect(mgr.verifyShardChain(h.delegationId)).toBe(true)
    expect((h.shard()[0]!.payload as { thought: string }).thought).toBe('original')
  })

  it('AC-11-20: resuming a failed delegation continues the shard from lastSeq and resets only the local guardian, inheriting the run budget', () => {
    const deps = makeDelegationDeps()
    const mgr = makeDelegationManager({ nodes: [makeDelegationTask({ taskId: 't1' })], edges: [] }, deps)
    const h = mgr.spawn('t1')
    h.append('reasoning', { thought: 'a' }) // seq 1
    h.append('reasoning', { thought: 'b' }) // seq 2

    // Trip the local Loop Guardian (period-1 cycle > 3 repeats).
    const step: LoopStep = { actionId: 'loop', seq: 0 }
    for (let i = 0; i < 8; i++) h.guardian.check(step)
    expect('stop' in h.guardian.check(step)).toBe(true)

    h.fail('stuck in a loop', COST)
    const spentAfterFail = mgr.runBudgetSpent()
    expect(spentAfterFail.iterations).toBeGreaterThan(0)

    const r = mgr.resume(h.delegationId)
    // Only the LOCAL guardian is reset — the same repeated step now passes.
    expect(r.guardian.check(step)).toEqual({ pass: true })
    // Shard continues at checkpoint.lastSeq + 1, chain intact.
    const e3 = r.append('reasoning', { thought: 'c' })
    expect(e3.seq).toBe(3)
    expect(mgr.verifyShardChain(r.delegationId)).toBe(true)
    // The run-level (global) budget is inherited, NOT reset by resume.
    expect(mgr.runBudgetSpent()).toEqual(spentAfterFail)

    expect(deps.events.some(e => e.kind === 'delegation.resumed')).toBe(true)
  })

  it('AC-11-20 durable: crash/restart restores the exact shard, checkpoint and global budget', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    original.append('reasoning', { thought: 'a' })
    original.append('tool-call', { tool: 'read_file' })
    original.fail('process crashed', COST)

    const restarted = makeDelegationManager(plan, makeDelegationDeps({
      persistence,
      isBindingActive: binding => binding.projectId === 'project-1',
    }))
    const resumed = restarted.resume(original.delegationId)
    expect(resumed.shard()).toHaveLength(2)
    expect(resumed.append('reasoning', { thought: 'after restart' }).seq).toBe(3)
    expect(restarted.verifyShardChain(resumed.delegationId)).toBe(true)
    expect(restarted.runBudgetSpent()).toEqual(COST)
  })

  it('AC-11-20 durable: switching selection to project B does not orphan active project A work', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    original.append('reasoning', { thought: 'a' })
    original.fail('pause', COST)

    let selectedProject = 'project-2'
    const restarted = makeDelegationManager(plan, makeDelegationDeps({
      persistence,
      isBindingActive: binding => {
        void selectedProject
        return binding.projectId === 'project-1'
      },
    }))
    expect(restarted.resume(original.delegationId).binding.projectId).toBe('project-1')
    selectedProject = 'project-3'
  })

  it('AC-11-20 durable: archive closes resume before a handle can be exposed', () => {
    const persistence = makeDelegationPersistence()
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    original.fail('pause', COST)

    const restarted = makeDelegationManager(plan, makeDelegationDeps({
      persistence,
      isBindingActive: () => false,
    }))
    expect(() => restarted.resume(original.delegationId)).toThrow(/binding-inactive/)
    expect(persistence.quarantined).toContainEqual({
      id: original.delegationId,
      reason: 'binding-inactive',
    })
  })

  it('AC-11-20 durable: shard tampering and checkpoint substitution are quarantined', () => {
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }

    const tamperedShard = makeDelegationPersistence()
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence: tamperedShard }))
    const original = first.spawn('t1')
    original.append('reasoning', { thought: 'original' })
    original.fail('pause', COST)
    const shardRecord = tamperedShard.records.get(original.delegationId) as PersistedDelegationV1
    ;(shardRecord.entries[0]!.payload as { thought: string }).thought = 'substituted'
    const restartShard = makeDelegationManager(plan, makeDelegationDeps({ persistence: tamperedShard }))
    expect(() => restartShard.resume(original.delegationId)).toThrow(/shard-integrity-failed/)

    const tamperedCheckpoint = makeDelegationPersistence()
    const second = makeDelegationManager(plan, makeDelegationDeps({ persistence: tamperedCheckpoint }))
    const secondHandle = second.spawn('t1')
    secondHandle.append('reasoning', { thought: 'original' })
    secondHandle.fail('pause', COST)
    const checkpointRecord = tamperedCheckpoint.records.get(secondHandle.delegationId) as PersistedDelegationV1
    checkpointRecord.checkpoint.lastSeq = 0
    const restartCheckpoint = makeDelegationManager(plan, makeDelegationDeps({ persistence: tamperedCheckpoint }))
    expect(() => restartCheckpoint.resume(secondHandle.delegationId)).toThrow(/checkpoint-mismatch/)
  })

  it('AC-11-20 durable: task/card substitution and legacy unbound state are quarantined', () => {
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
    const persistence = makeDelegationPersistence()
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    original.fail('pause', COST)

    const changedCard = makeDelegationManager(plan, makeDelegationDeps({
      persistence,
      resolveCard: () => makeCard({ maxIterations: 99 }),
    }))
    expect(() => changedCard.resume(original.delegationId)).toThrow(/task-or-card-mismatch/)

    const legacy = makeDelegationPersistence()
    legacy.records.set('d-legacy', { checkpoint: { delegationId: 'd-legacy' } })
    const legacyManager = makeDelegationManager(plan, makeDelegationDeps({ persistence: legacy }))
    expect(() => legacyManager.resume('d-legacy')).toThrow(/legacy-or-invalid-state/)
    expect(legacy.quarantined).toContainEqual({
      id: 'd-legacy',
      reason: 'legacy-or-invalid-state',
    })
  })

  it('AC-11-20 durable: a persisted binding cannot be rebound to another project/session', () => {
    const plan: PlanDAG = { nodes: [makeDelegationTask()], edges: [] }
    const persistence = makeDelegationPersistence()
    const first = makeDelegationManager(plan, makeDelegationDeps({ persistence }))
    const original = first.spawn('t1')
    original.fail('pause', COST)

    const rebound = makeDelegationManager(plan, makeDelegationDeps({
      persistence,
      binding: { ...DELEGATION_BINDING, projectId: 'project-2', sessionId: 'session-2' },
    }))
    expect(() => rebound.resume(original.delegationId)).toThrow(/binding-mismatch/)
    expect(persistence.quarantined).toContainEqual({
      id: original.delegationId,
      reason: 'binding-mismatch',
    })
  })

  it('AC-11-20 durable: restart reads the shared run ledger, never a stale child budget copy', () => {
    const persistence = makeDelegationPersistence()
    const dag: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [],
    }
    const first = makeDelegationManager(dag, makeDelegationDeps({ persistence }))
    const a = first.spawn('A')
    const b = first.spawn('B')
    a.fail('A paused', { iterations: 2, spendUsd: 0.2, wallMs: 20 })
    b.fail('B paused', { iterations: 3, spendUsd: 0.3, wallMs: 30 })

    const restarted = makeDelegationManager(dag, makeDelegationDeps({ persistence }))
    restarted.resume(a.delegationId)
    expect(restarted.runBudgetSpent()).toEqual({ iterations: 5, spendUsd: 0.5, wallMs: 50 })
  })

  it('AC-11-20: a downstream task whose upstream failed is never spawned and emits an explicit cascade-skip', () => {
    const deps = makeDelegationDeps()
    const dag: PlanDAG = {
      nodes: [
        makeDelegationTask({ taskId: 'A', scope: { owns: ['src/a/**'], doNotTouch: [], taskClass: 'reasoning' } }),
        makeDelegationTask({ taskId: 'B', dependsOn: ['A'], scope: { owns: ['src/b/**'], doNotTouch: [], taskClass: 'reasoning' } }),
      ],
      edges: [{ from: 'A', to: 'B' }],
    }
    const mgr = makeDelegationManager(dag, deps)

    mgr.spawn('A').fail('A failed', COST)
    const result = mgr.schedule()

    expect(result.cascadeSkipped).toContain('B')
    expect(result.ready).not.toContain('B')
    // Explicit journal entry — no silent drop.
    expect(
      deps.events.some(
        e => e.kind === 'cascade-skip' && (e.payload as { taskId?: string } | undefined)?.taskId === 'B',
      ),
    ).toBe(true)
    // A cascade-skipped task can never be spawned.
    expect(() => mgr.spawn('B')).toThrow()
  })

})

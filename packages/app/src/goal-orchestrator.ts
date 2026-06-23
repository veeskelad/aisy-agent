// Tier-7 Phase C — goal-orchestrator loop.
// Pure, fully-injected: no Node fs, no Telegram, no real timers.
// Three loop modes: until (loop until done), budget (loop until ceiling), every (one tick/call).

import type { GoalSpec, GoalStore, GoalUsage, VerificationTrace } from '@aisy/core'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface GoalRunTurnResult {
  /** Mirrors TurnResult.state */
  state: 'ok' | 'awaiting-clarification' | 'awaiting-approval' | 'halted'
  haltReason?: string
  planHash?: string
  usage?: GoalUsage
  /** Set by the goal executor wrapper (Phase D) when goal_done was called this turn. */
  claimedDone: boolean
  reply: string
}

export interface GoalOrchestratorDeps {
  store: GoalStore
  runGoalTurn: (input: {
    objective: string
    feedback?: string
    approvalToken?: string
    signal: AbortSignal
  }) => Promise<GoalRunTurnResult>
  probeRunner: (trace: VerificationTrace) => Promise<boolean>
  recordGrant: (tool: string) => void
  sendProgress: (text: string) => Promise<void>
  clock: { now: () => string }
  sleep?: (ms: number) => Promise<void>
  emit?: (event: string, payload: unknown) => void
}

export interface GoalOrchestrator {
  /** until/budget: loops here until non-continue */
  start(spec: GoalSpec, signal: AbortSignal): Promise<void>
  /** every: one iterate per scheduler tick */
  tick(signal: AbortSignal): Promise<void>
  /** Returns the current active spec, or null */
  status(): GoalSpec | null
  /** boot: re-enter an active goal (persisted counters continue) */
  resume(signal: AbortSignal): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeGoalOrchestrator(deps: GoalOrchestratorDeps): GoalOrchestrator {
  const { store, runGoalTurn, probeRunner, recordGrant, sendProgress, clock, emit } = deps

  let current: GoalSpec | null = null

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function touch(spec: GoalSpec): void {
    spec.updatedAt = clock.now()
  }

  function addUsage(spec: GoalSpec, usage: GoalUsage): void {
    spec.usageSpent.inputTokens += usage.inputTokens
    spec.usageSpent.outputTokens += usage.outputTokens
    spec.usageSpent.dollars += usage.dollars
  }

  // Generation guard: superseded loops must never overwrite the newly active goal.
  const persist = async (s: GoalSpec): Promise<void> => {
    if (current?.id === s.id) await store.save(s)
  }

  // -------------------------------------------------------------------------
  // Core iterate — one turn attempt
  // -------------------------------------------------------------------------

  async function iterate(
    spec: GoalSpec,
    signal: AbortSignal,
  ): Promise<'done' | 'continue' | 'halted' | 'stopped'> {

    // Step 1: abort check
    if (signal.aborted) {
      spec.status = 'stopped'
      spec.haltReason = 'stopped'
      touch(spec)
      await persist(spec)
      return 'stopped'
    }

    // Step 2: backstop pre-check (BEFORE the turn)
    const bs = spec.backstop
    if (spec.iterationsSpent >= bs.maxIterations) {
      spec.status = 'halted'
      spec.haltReason = 'max-iterations'
      touch(spec)
      await persist(spec)
      return 'halted'
    }
    const totalTokens = spec.usageSpent.inputTokens + spec.usageSpent.outputTokens
    if (spec.usageSpent.dollars >= bs.dollarCeiling || totalTokens >= bs.tokenCeiling) {
      spec.status = 'halted'
      spec.haltReason = 'backstop-budget'
      touch(spec)
      await persist(spec)
      return 'halted'
    }
    // Budget-mode ceiling check
    if (spec.mode.kind === 'budget') {
      const m = spec.mode
      const budgetTokens = spec.usageSpent.inputTokens + spec.usageSpent.outputTokens
      if (
        (m.dollarCeiling !== undefined && spec.usageSpent.dollars >= m.dollarCeiling) ||
        (m.tokenCeiling !== undefined && budgetTokens >= m.tokenCeiling)
      ) {
        spec.status = 'halted'
        spec.haltReason = 'budget-ceiling'
        touch(spec)
        await persist(spec)
        return 'halted'
      }
    }

    // Step 3: run the turn
    const objective = spec.objective
    const r = await runGoalTurn({
      objective,
      ...(spec.lastFeedback !== undefined ? { feedback: spec.lastFeedback } : {}),
      signal,
    })

    // Step 4: account for iteration + persist
    spec.iterationsSpent++
    if (r.usage !== undefined) addUsage(spec, r.usage)
    touch(spec)
    await persist(spec)

    // Step 5: awaiting-approval (tier-3 plan gate) — HALT; never self-issue the token.
    // Self-issuing approvalToken = planHash would bypass the mandatory operator tap.
    if (r.state === 'awaiting-approval') {
      spec.status = 'halted'
      spec.haltReason = 'awaiting-approval'
      touch(spec)
      await persist(spec)
      await sendProgress('⏸ Цель остановлена: шаг требует ручного подтверждения (tier-3). Авто-одобрение отключено — выполни шаг сам или перезапусти цель.')
      return 'halted'
    }

    // Step 6: halted
    if (r.state === 'halted') {
      spec.status = r.haltReason === 'stopped' ? 'stopped' : 'halted'
      if (r.haltReason !== undefined) spec.haltReason = r.haltReason
      touch(spec)
      await persist(spec)
      return r.haltReason === 'stopped' ? 'stopped' : 'halted'
    }

    // Step 7: awaiting-clarification
    if (r.state === 'awaiting-clarification') {
      spec.lastFeedback = 'Предыдущая итерация запросила уточнение: ' + r.reply
      await sendProgress('⏸ Цель ждёт уточнения.')
      touch(spec)
      await persist(spec)
      return 'continue'
    }

    // Step 8: completion (state === 'ok')
    if (r.claimedDone) {
      if (spec.mode.kind === 'until' && spec.mode.probe !== undefined) {
        const pass = await probeRunner(spec.mode.probe)
        if (pass) {
          spec.status = 'completed'
          touch(spec)
          await persist(spec)
          return 'done'
        } else {
          spec.lastFeedback = 'Ты пометил цель выполненной, но проба не прошла — продолжай.'
          emit?.('goal.probe_failed', { specId: spec.id })
          touch(spec)
          await persist(spec)
          return 'continue'
        }
      } else {
        // no probe (or non-until mode with claim) → complete on claim
        spec.status = 'completed'
        touch(spec)
        await persist(spec)
        return 'done'
      }
    }

    // Not claimed done → store reply as feedback and continue
    spec.lastFeedback = r.reply.slice(0, 500)
    touch(spec)
    await persist(spec)
    return 'continue'
  }

  // -------------------------------------------------------------------------
  // Terminal announce helper
  // -------------------------------------------------------------------------

  async function announce(outcome: 'done' | 'halted' | 'stopped', spec: GoalSpec): Promise<void> {
    if (outcome === 'done') {
      await sendProgress('✅ Цель достигнута.')
    } else if (outcome === 'stopped') {
      await sendProgress('⏹ Остановлено.')
    } else {
      const reason = spec.haltReason ?? 'backstop'
      if (reason === 'max-iterations') {
        await sendProgress('🛑 Остановлено бэкстопом (лимит итераций).')
      } else if (reason === 'backstop-budget') {
        await sendProgress('🛑 Остановлено бэкстопом (лимит бюджета).')
      } else if (reason === 'budget-ceiling') {
        await sendProgress('🛑 Достигнут потолок бюджета.')
      } else {
        await sendProgress(`🛑 Остановлено: ${reason}.`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  return {
    status(): GoalSpec | null {
      return current
    },

    async start(spec: GoalSpec, signal: AbortSignal): Promise<void> {
      current = spec

      // Pre-grant: authorize each tool in grantedScope exactly once
      for (const tool of spec.grantedScope) {
        recordGrant(tool)
      }

      // Initial persist
      touch(spec)
      await persist(spec)

      // Loop until non-continue (until / budget modes)
      for (;;) {
        const outcome = await iterate(spec, signal)
        if (outcome !== 'continue') {
          await announce(outcome, spec)
          break
        }
      }
    },

    async tick(signal: AbortSignal): Promise<void> {
      if (current === null) return
      if (current.mode.kind !== 'every') return
      if (current.status !== 'active') return

      const outcome = await iterate(current, signal)
      if (outcome !== 'continue') {
        await announce(outcome, current)
        // status is already set on spec by iterate(); leave current in place
      }
    },

    async resume(signal: AbortSignal): Promise<void> {
      const spec = await store.load()
      if (spec === null) return
      current = spec

      if (spec.mode.kind !== 'every') {
        // start() pre-grants each tool in grantedScope — do NOT recordGrant here too
        void this.start(spec, signal)
      } else {
        // For 'every' mode: start() is never called, so grant scope here
        for (const tool of spec.grantedScope) {
          recordGrant(tool)
        }
        // Leave for the scheduler to call tick()
      }
    },
  }
}

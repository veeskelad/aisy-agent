import type {
  ContextSpan,
  Phase1Outcome,
  TriggerBudget,
  TriggerEngine,
  TriggerEngineDeps,
  TriggerFiring,
  TriggerSpec,
  VerificationTrace,
} from './types.js'

export type {
  TriggerKind,
  TriggerBudget,
  TriggerSpec,
  Phase1Outcome,
  TriggerFiring,
  TriggerStore,
  TriggerEngineDeps,
  TriggerEngine,
} from './types.js'

// ---------------------------------------------------------------------------
// Registration validation — reuse plan-linter R3/R4 (spec 14 AC-14-13).
// A watch probe must assert something about the world and not read back the
// plan's own files. Pure code; no model.
// ---------------------------------------------------------------------------

const VACUOUS_ARGV0 = new Set(['echo', 'true', ':', 'printf'])
const SELF_REFERENTIAL_FILES = ['PLAN.md', 'TODO.md']

function rejectBadProbe(probe: VerificationTrace): void {
  // R3 — vacuous trace
  if (probe.kind === 'exit' && VACUOUS_ARGV0.has(probe.argv[0] ?? '')) {
    throw new Error('watch probe rejected: vacuous trace (R3)')
  }
  if (probe.kind === 'http' && /localhost|127\.0\.0\.1/.test(probe.url) && ['GET', 'HEAD'].includes(probe.method.toUpperCase())) {
    throw new Error('watch probe rejected: vacuous trace (R3)')
  }
  // R4 — self-referential trace
  if (probe.kind === 'file' && SELF_REFERENTIAL_FILES.some(f => probe.path === f || probe.path.endsWith(`/${f}`))) {
    throw new Error('watch probe rejected: self-referential trace (R4)')
  }
}

// ---------------------------------------------------------------------------
// Due-slot derivation — the idempotency key per fire (AC-14-3/14).
// All time comes from the injected Clock string; Date.parse only parses that
// string (no wall-clock read) so tick() stays deterministic.
// ---------------------------------------------------------------------------

function cronSlot(cron: string, nowIso: string): string | null {
  if (cron === '@minutely') return nowIso.slice(0, 16) // YYYY-MM-DDTHH:MM
  if (cron === '@hourly') return nowIso.slice(0, 13)    // YYYY-MM-DDTHH
  if (cron === '@daily') return nowIso.slice(0, 10)     // YYYY-MM-DD
  const m = /^(\d{2}):(\d{2})$/.exec(cron)              // daily at HH:MM
  if (m) return nowIso.slice(11, 16) >= cron ? nowIso.slice(0, 10) : null
  return null
}

const budgetExhausted = (b: TriggerBudget): boolean =>
  b.tokensSpent >= b.tokenCeiling || b.dollarsSpent >= b.dollarCeiling

// ---------------------------------------------------------------------------
// makeTriggerEngine — deterministic two-phase scheduler (ADR-0038).
// Phase 1 (due/cron/probe) costs zero model tokens; phase 2 (startTurn) is
// budget-gated per trigger AND globally (anti heartbeat-drain).
// ---------------------------------------------------------------------------

export function makeTriggerEngine(deps: TriggerEngineDeps): TriggerEngine {
  const triggers = new Map<string, TriggerSpec>()
  let loaded = false
  const pauseReported = new Set<string>()
  const lastOutcome = new Map<string, Phase1Outcome>()

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return
    for (const s of await deps.store.load()) triggers.set(s.id, s)
    loaded = true
  }

  const persist = async (spec: TriggerSpec): Promise<void> => {
    triggers.set(spec.id, spec)
    await deps.store.save(spec)
  }

  const recordSlot = (spec: TriggerSpec, slot: string): void => {
    spec.firedSlots = [...(spec.firedSlots ?? []), slot]
  }
  const slotFired = (spec: TriggerSpec, slot: string): boolean =>
    (spec.firedSlots ?? []).includes(slot)

  /** Phase 1: deterministic, zero model tokens. Returns the candidate slot to
   *  fire (and the outcome), or a non-firing outcome. */
  const phase1 = async (
    spec: TriggerSpec,
    now: string,
  ): Promise<{ outcome: 'due' | 'condition-met'; slot: string; spans: ContextSpan[] } | { outcome: 'no-change' }> => {
    if (spec.kind === 'remind' && spec.fireAt) {
      const slot = spec.fireAt
      if (Date.parse(spec.fireAt) <= Date.parse(now) && !slotFired(spec, slot)) {
        return { outcome: 'due', slot, spans: [] }
      }
      return { outcome: 'no-change' }
    }
    if (spec.kind === 'schedule' && spec.cron) {
      const slot = cronSlot(spec.cron, now)
      if (slot && !slotFired(spec, slot)) return { outcome: 'due', slot, spans: [] }
      return { outcome: 'no-change' }
    }
    if (spec.kind === 'watch' && spec.probe) {
      // interval gate (optional): probe at most once per bucket
      if (spec.intervalMs && spec.intervalMs > 0) {
        const bucket = String(Math.floor(Date.parse(now) / spec.intervalMs))
        if (slotFired(spec, bucket)) return { outcome: 'no-change' }
        recordSlot(spec, bucket)
      }
      const hit = await deps.probeRunner(spec.probe)   // 0 model tokens (ADR-0017 probe)
      if (!hit) return { outcome: 'no-change' }
      // Observed content enters the woken turn as UNTRUSTED (ADR-0027).
      const text = deps.observe ? await deps.observe(spec.probe) : ''
      const spans: ContextSpan[] = [{ role: 'tool', provenance: 'untrusted', text }]
      return { outcome: 'condition-met', slot: now, spans }
    }
    return { outcome: 'no-change' }
  }

  const emitOnce = (spec: TriggerSpec, outcome: Phase1Outcome, payload: unknown): void => {
    // 'trigger.fired' always; 'trigger.budget_paused' once per pause;
    // 'trigger.no_change' only on a state change (suppressed otherwise).
    if (outcome === 'budget-paused') {
      if (pauseReported.has(spec.id)) return
      pauseReported.add(spec.id)
      deps.emitEvent('trigger.budget_paused', payload)
      return
    }
    if (outcome === 'no-change') {
      if (lastOutcome.get(spec.id) === 'no-change') return
      deps.emitEvent('trigger.no_change', payload)
      return
    }
    deps.emitEvent('trigger.fired', payload)
    pauseReported.delete(spec.id) // a successful fire clears the pause latch
  }

  return {
    async register(input): Promise<TriggerSpec> {
      await ensureLoaded()
      if (input.kind === 'watch' && input.probe) rejectBadProbe(input.probe)
      const spec: TriggerSpec = {
        ...input,
        // operator triggers are active immediately; agent-created pend a card (ADR-0029)
        confirmed: input.createdBy === 'operator',
        enabled: true,
        firedSlots: input.firedSlots ?? [],
      }
      await persist(spec)
      deps.emitEvent('trigger.registered', { id: spec.id, kind: spec.kind, confirmed: spec.confirmed })
      return spec
    },

    async confirm(triggerId): Promise<void> {
      await ensureLoaded()
      const spec = triggers.get(triggerId)
      if (!spec) return
      spec.confirmed = true
      await persist(spec)
      deps.emitEvent('trigger.confirmed', { id: triggerId })
    },

    async cancel(triggerId): Promise<void> {
      await ensureLoaded()
      triggers.delete(triggerId)
      await deps.store.remove(triggerId)
      deps.emitEvent('trigger.cancelled', { id: triggerId })
    },

    async list(): Promise<TriggerSpec[]> {
      await ensureLoaded()
      return [...triggers.values()].map(s => ({ ...s }))
    },

    async tick(): Promise<TriggerFiring[]> {
      await ensureLoaded()
      const now = deps.clock.now()
      const firings: TriggerFiring[] = []

      for (const spec of triggers.values()) {
        // Eligibility gates — code-only, no model.
        if (!spec.enabled || !spec.confirmed) continue
        if (spec.expiresAt && Date.parse(spec.expiresAt) <= Date.parse(now)) continue

        const p1 = await phase1(spec, now)
        let outcome: Phase1Outcome = p1.outcome
        let turnStarted = false

        if (p1.outcome === 'due' || p1.outcome === 'condition-met') {
          // §5.3 cap precedence: phase-2 is gated per-trigger AND globally.
          if (budgetExhausted(spec.budget) || budgetExhausted(deps.globalBackgroundBudget)) {
            outcome = 'budget-paused'
          } else {
            await deps.startTurn({ triggerId: spec.id, prompt: spec.prompt, spans: p1.spans, budget: spec.budget })
            turnStarted = true
            recordSlot(spec, p1.slot)
            if (spec.kind === 'remind') spec.enabled = false // one-shot
            await persist(spec)
          }
        }

        emitOnce(spec, outcome, { id: spec.id, outcome, firedAt: now })
        lastOutcome.set(spec.id, outcome)
        firings.push({ triggerId: spec.id, firedAt: now, phase1: outcome, turnStarted })
      }
      return firings
    },
  }
}

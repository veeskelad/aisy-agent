// In-process scheduler with missed-slot catch-up (app, Tier-4 proactivity).
//
// pump() ticks triggers every cycle and runs the nightly once per day if the
// current local time has passed nightlyAt. start() fires pump() immediately on
// boot (catch-up: if the process starts after nightlyAt and today's run is
// missing, it runs now) then schedules pump() every tickMs.

import { wallClockIso } from '@aisy/core'
import type { ResolvedWorkBinding } from '@aisy/core'

export interface SchedulerDeps {
  now: () => Date
  /** The local HH:MM the nightly should run at (default '03:30'). */
  nightlyAt: string
  /**
   * The operator's IANA zone, read per tick. Absent keeps the host's own zone,
   * which is only right when the server happens to live where the operator does.
   */
  timeZone?: () => string | undefined
  /** Returns the last nightly run date (YYYY-MM-DD) or null. */
  lastNightlyRun: () => string | null
  /** Persist that the nightly ran for this YYYY-MM-DD. */
  markNightlyRun: (date: string) => void
  /** Resolve the persisted Workspace/system-session binding; null means paused. */
  resolveNightlyBinding: () => Promise<ResolvedWorkBinding | null> | ResolvedWorkBinding | null
  /** Run the nightly pipeline (idempotent per day; the scheduler gates the call). */
  runNightly: (binding: ResolvedWorkBinding) => Promise<void>
  /** Runs only after the daily high-water has been durably published. */
  afterNightlyRun?: (date: string) => Promise<void>
  /** Retries post-mark lifecycle work, such as a supervised restart. */
  tickNightlyRecovery?: () => Promise<void>
  /** One trigger scan. */
  tickTriggers: () => Promise<void>
  /** One goal tick (every-mode scheduler dispatch); optional. */
  tickGoal?: () => Promise<void>
  /** One deterministic monitoring collection/delivery tick; optional and inactive by default. */
  tickMonitoring?: () => Promise<void>
  /** Injected timer (setInterval) for tests; default real setInterval. */
  setInterval?: (fn: () => void, ms: number) => unknown
  /** Tick period; default 60_000. */
  tickMs?: number
}

export interface Scheduler {
  start(): void
  /** Run the due-check once (for tests + startup catch-up). */
  pump(): Promise<void>
}

export function makeScheduler(deps: SchedulerDeps): Scheduler {
  const pump = async (): Promise<void> => {
    try { await deps.tickTriggers() } catch { /* swallow — loop must survive */ }
    if (deps.tickGoal) {
      try { await deps.tickGoal() } catch { /* swallow */ }
    }
    if (deps.tickMonitoring) {
      try { await deps.tickMonitoring() } catch { /* swallow */ }
    }
    try {
      const n = deps.now()
      const zone = deps.timeZone?.()
      const local = zone === undefined
        ? `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}` +
          `T${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`
        : wallClockIso(n.toISOString(), zone)
      const today = local.slice(0, 10)
      const hm = local.slice(11, 16)
      if (hm >= deps.nightlyAt && deps.lastNightlyRun() !== today) {
        const binding = await deps.resolveNightlyBinding()
        if (binding === null) return
        await deps.runNightly(binding)
        deps.markNightlyRun(today)
        await deps.afterNightlyRun?.(today)
      }
    } catch { /* swallow */ }
    try { await deps.tickNightlyRecovery?.() } catch { /* retry on the next pump */ }
  }

  return {
    pump,
    start() {
      void pump()
      ;(deps.setInterval ?? setInterval)(() => { void pump() }, deps.tickMs ?? 60_000)
    },
  }
}

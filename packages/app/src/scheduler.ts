// In-process scheduler with missed-slot catch-up (app, Tier-4 proactivity).
//
// pump() ticks triggers every cycle and runs the nightly once per day if the
// current local time has passed nightlyAt. start() fires pump() immediately on
// boot (catch-up: if the process starts after nightlyAt and today's run is
// missing, it runs now) then schedules pump() every tickMs.

export interface SchedulerDeps {
  now: () => Date
  /** The local HH:MM the nightly should run at (default '03:30'). */
  nightlyAt: string
  /** Returns the last nightly run date (YYYY-MM-DD) or null. */
  lastNightlyRun: () => string | null
  /** Persist that the nightly ran for this YYYY-MM-DD. */
  markNightlyRun: (date: string) => void
  /** Run the nightly pipeline (idempotent per day; the scheduler gates the call). */
  runNightly: () => Promise<void>
  /** One trigger scan. */
  tickTriggers: () => Promise<void>
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
    try {
      const n = deps.now()
      const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
      const hm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`
      if (hm >= deps.nightlyAt && deps.lastNightlyRun() !== today) {
        await deps.runNightly()
        deps.markNightlyRun(today)
      }
    } catch { /* swallow */ }
  }

  return {
    pump,
    start() {
      void pump()
      ;(deps.setInterval ?? setInterval)(() => { void pump() }, deps.tickMs ?? 60_000)
    },
  }
}

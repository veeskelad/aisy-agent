// Daily spend budget with a warning and a pause (ADR-0082).
//
// The per-agent cap in ADR-0050 is cumulative for all time, which says nothing
// about today. This counter is per calendar day: it warns once at 80 % and
// pauses turns at 100 % until the date changes.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Share of the daily cap that triggers the single warning. */
export const DAILY_BUDGET_WARN_SHARE = 0.8

export interface DailyBudgetState {
  date: string
  spent: number
  cap: number
  /** Fraction of the cap spent; Infinity is never returned. */
  share: number
  paused: boolean
}

export interface DailyBudget {
  /** Add a charge. Reports the state after it lands. */
  record(dollars: number): DailyBudgetState
  state(): DailyBudgetState
  /** True when today's cap is reached; clears itself when the date changes. */
  paused(): boolean
  /**
   * Set today's cap, in dollars; 0 or less removes it. Persisted, because a cap
   * the operator chose in the bot must outlive the next restart — otherwise the
   * button silently reverts to whatever the environment said at boot.
   */
  setCap(dollars: number): DailyBudgetState
}

interface Persisted {
  schemaVersion: 1
  date: string
  spent: number
  warned: boolean
  /** Operator-chosen cap; absent means "use the configured default". */
  cap?: number
}

function decode(raw: string): Persisted | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const input = value as Record<string, unknown>
  if (input['schemaVersion'] !== 1) return null
  if (typeof input['date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input['date'])) return null
  const spent = input['spent']
  if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0) return null
  const cap = input['cap']
  return {
    schemaVersion: 1,
    date: input['date'],
    spent,
    warned: input['warned'] === true,
    ...(typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? { cap } : {}),
  }
}

export function makeDailyBudget(deps: {
  path: string
  /** Daily cap in USD; 0 or less means no limit at all. */
  capUsd: number
  nowIso: () => string
  /** Fired once per day when the warning threshold is crossed. */
  onWarning?: (state: DailyBudgetState) => void
  /** Fired once per day when turns are paused. */
  onPause?: (state: DailyBudgetState) => void
}): DailyBudget {
  let cap = Number.isFinite(deps.capUsd) && deps.capUsd > 0 ? deps.capUsd : 0
  const today = (): string => deps.nowIso().slice(0, 10)

  let state: Persisted = { schemaVersion: 1, date: today(), spent: 0, warned: false }
  let pauseReported = false

  if (existsSync(deps.path)) {
    try {
      const loaded = decode(readFileSync(deps.path, 'utf8'))
      if (loaded !== null) {
        state = loaded
        if (loaded.cap !== undefined) cap = loaded.cap
      }
    } catch { /* an unreadable counter starts the day at zero */ }
  }

  const persist = (): void => {
    try {
      mkdirSync(dirname(deps.path), { recursive: true, mode: 0o700 })
      const temporary = `${deps.path}.tmp`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, deps.path)
    } catch { /* a full disk must not cost the operator a turn */ }
  }

  /** A new calendar day clears the spend, the warning and the pause together. */
  const rollOver = (): void => {
    const date = today()
    if (date === state.date) return
    state = { schemaVersion: 1, date, spent: 0, warned: false, ...(state.cap === undefined ? {} : { cap: state.cap }) }
    pauseReported = false
    persist()
  }

  const snapshot = (): DailyBudgetState => ({
    date: state.date,
    spent: state.spent,
    cap,
    share: cap > 0 ? state.spent / cap : 0,
    paused: cap > 0 && state.spent >= cap,
  })

  return {
    record(dollars) {
      rollOver()
      if (Number.isFinite(dollars) && dollars > 0) {
        state = { ...state, spent: state.spent + dollars }
        persist()
      }
      const current = snapshot()

      if (cap > 0 && !state.warned && current.share >= DAILY_BUDGET_WARN_SHARE) {
        state = { ...state, warned: true }
        persist()
        try {
          deps.onWarning?.(current)
        } catch { /* reporting must not cost the turn */ }
      }
      if (current.paused && !pauseReported) {
        pauseReported = true
        try {
          deps.onPause?.(current)
        } catch { /* reporting must not cost the turn */ }
      }
      return current
    },

    state() {
      rollOver()
      return snapshot()
    },

    paused() {
      rollOver()
      return snapshot().paused
    },

    setCap(dollars) {
      rollOver()
      const next = Number.isFinite(dollars) && dollars > 0 ? dollars : 0
      cap = next
      state = { ...state, cap: next }
      // Raising the cap must also lift today's pause and re-arm the warning,
      // or the operator would set a bigger limit and stay blocked until midnight.
      if (state.spent < next * DAILY_BUDGET_WARN_SHARE) state = { ...state, warned: false }
      pauseReported = snapshot().paused
      persist()
      return snapshot()
    },
  }
}

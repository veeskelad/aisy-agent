// Settings store (runtime, ADR-0050 Phase 2).
//
// A tiny typed key/value of operator preferences, persisted to
// ~/.aisy/settings.json. The defaults are conservative: the per-turn cost
// summary is OFF (spend is viewed on demand, not spammed in the main chat), and
// budget enforcement is OFF. Toggled from the Settings ⚙️ menu.

export interface Settings {
  /** Send a cost summary after every turn (default off — view spend on demand). */
  showCostPerTurn: boolean
  /** Enforce per-agent budgets (Phase 3); the toggle lives here from Phase 2. */
  budgetEnabled: boolean
  /** Append a compact per-turn debug footer after replies (default off). */
  debug: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  showCostPerTurn: false,
  budgetEnabled: false,
  debug: false,
}

/** Persistence seam — load a (possibly partial) settings object, save the full. */
export interface SettingsPersistencePort {
  load(): Partial<Settings>
  save(settings: Settings): void
}

export interface SettingsStore {
  get(): Settings
  set<K extends keyof Settings>(key: K, value: Settings[K]): void
  /** Flip a boolean flag; returns the new value (convenient for menu taps). */
  toggle(key: keyof Settings): boolean
}

export function makeSettingsStore(deps: { persistence?: SettingsPersistencePort }): SettingsStore {
  const state: Settings = { ...DEFAULT_SETTINGS, ...(deps.persistence?.load() ?? {}) }

  const persist = (): void => deps.persistence?.save({ ...state })

  return {
    get: () => ({ ...state }),
    set(key, value) {
      state[key] = value
      persist()
    },
    toggle(key) {
      const next = !state[key]
      state[key] = next
      persist()
      return next
    },
  }
}

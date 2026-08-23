// Four execution modes. The first three tighten code-owned approvals
// (ADR-0083); explicit `bypass` grants only host Bash its ADR-0091 escape hatch.
//
// `auto`, `confirm` and `plan` may only tighten. `bypass` is the named,
// operator-visible exception for exact host Bash and nothing else.

import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, normalize } from 'node:path'

import { RUNTIME_TOOL_CATALOG, type GrantStore, type ToolTier } from '@aisy/core'

export type ExecutionMode = 'auto' | 'confirm' | 'plan' | 'bypass'

export const EXECUTION_MODES: readonly ExecutionMode[] = ['auto', 'confirm', 'plan', 'bypass']

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value)
}

/** Effects that change something outside the conversation. */
const ACTING_EFFECTS = new Set(['write', 'execute', 'delegate'])

function actingTools(): readonly string[] {
  return RUNTIME_TOOL_CATALOG.filter((tool) => ACTING_EFFECTS.has(tool.effect)).map((t) => t.name)
}

export interface ExecutionModeStore {
  get(): ExecutionMode
  set(mode: ExecutionMode): void
  /** Tier floor per tool for this mode; merged with the catalog by the runner. */
  toolTiers(): Readonly<Record<string, ToolTier>>
  /** True when legacy tool-wide grants must not suppress a fresh exact check. */
  ignoreGrants(): boolean
  /** True when even narrow v3 similar grants must be ignored. */
  ignoreSimilarGrants(): boolean
  /** Exact ADR-0091 switch: only host Bash may consult this. */
  bypassesHostBash(): boolean
}

/** Mode overlay: Plan accepts only v3 similar grants, Confirm accepts none. */
export function makeExecutionModeGrantStore(
  grants: GrantStore,
  mode: Pick<ExecutionModeStore, 'ignoreGrants' | 'ignoreSimilarGrants'>,
): GrantStore {
  const overlay: GrantStore = {
    ...grants,
    has: (tool, binding) => !mode.ignoreGrants() && grants.has(tool, binding),
    hasSimilar: (call, risk, binding) =>
      !mode.ignoreSimilarGrants() && grants.hasSimilar(call, risk, binding),
    canRememberSimilar: (call, risk) =>
      !mode.ignoreSimilarGrants() && grants.canRememberSimilar(call, risk),
    recordSimilar: (call, risk, scope, binding) =>
      grants.recordSimilar(call, risk, scope, binding),
  }
  return Object.freeze(overlay)
}

interface PersistedV2 {
  schemaVersion: 2
  mode: ExecutionMode
}

export function makeExecutionModeStore(deps: {
  path: string
  /** Mode used when nothing is stored yet. */
  fallback?: ExecutionMode
}): ExecutionModeStore {
  const fallback = deps.fallback === 'bypass' ? 'auto' : (deps.fallback ?? 'auto')
  if (!isAbsolute(deps.path) || normalize(deps.path) !== deps.path || deps.path.includes('\0')) {
    throw new Error('invalid execution mode path')
  }
  const parent = dirname(deps.path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentStat = lstatSync(parent)
  const parentOwner = typeof process.getuid !== 'function' || parentStat.uid === process.getuid()
  if (realpathSync(parent) !== parent || !parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    !parentOwner || (parentStat.mode & 0o077) !== 0) {
    throw new Error('insecure execution mode directory')
  }
  const guardPath = `${deps.path}.safe`

  const pathExists = (path: string): boolean => {
    try {
      lstatSync(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  const syncDirectory = (): void => {
    const fd = openSync(parent, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  const writeAtomic = (path: string, value: string): void => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | null = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, value, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(temporary, path)
      syncDirectory()
    } catch (error) {
      if (fd !== null) try { closeSync(fd) } catch { /* already closed */ }
      try { unlinkSync(temporary) } catch { /* absent or already published */ }
      throw error
    }
  }

  const writeGuard = (): void => {
    writeAtomic(guardPath, '{"schemaVersion":1,"state":"safe"}\n')
  }

  const removeGuard = (): void => {
    unlinkSync(guardPath)
    // A crash that resurrects the marker only narrows to auto, so directory
    // fsync failure after the visible unlink is safe and need not fake failure.
    try { syncDirectory() } catch { /* safe marker resurrection */ }
  }

  const safeStoredMode = (): ExecutionMode => {
    if (pathExists(guardPath) || !pathExists(deps.path)) return fallback
    try {
      const stat = lstatSync(deps.path)
      const owner = typeof process.getuid !== 'function' || stat.uid === process.getuid()
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !owner ||
        (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 4096) return fallback
      const raw: unknown = JSON.parse(readFileSync(deps.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
        Object.getPrototypeOf(raw) !== Object.prototype ||
        Object.keys(raw).sort().join(',') !== 'mode,schemaVersion') return fallback
      const candidate = raw as Record<string, unknown>
      if (candidate['schemaVersion'] === 2 && isExecutionMode(candidate['mode'])) {
        return candidate['mode']
      }
      if (candidate['schemaVersion'] === 1 && candidate['mode'] !== 'bypass' &&
        isExecutionMode(candidate['mode'])) {
        return candidate['mode']
      }
    } catch { /* corrupt or unreadable state narrows to the safe fallback */ }
    return fallback
  }

  let guarded = pathExists(guardPath)
  let mode: ExecutionMode = safeStoredMode()

  const persist = (next: ExecutionMode): void => {
    const state: PersistedV2 = { schemaVersion: 2, mode: next }
    writeAtomic(deps.path, `${JSON.stringify(state, null, 2)}\n`)
  }

  const enterBypass = (): void => {
    writeGuard()
    guarded = true
    persist('bypass')
    removeGuard()
    guarded = false
    mode = 'bypass'
  }

  const leaveOrRepair = (next: Exclude<ExecutionMode, 'bypass'>): void => {
    if (!guarded) {
      writeGuard()
      guarded = true
    }
    // The durable marker already guarantees a safe restart. Fence new host
    // calls before a fallible rewrite; failure keeps the marker and this mode.
    mode = next
    persist(next)
    removeGuard()
    guarded = false
  }

  return {
    get: () => mode,

    set(next) {
      if (!isExecutionMode(next)) throw new Error('invalid execution mode')
      if (next === mode && !guarded) return
      if (next === 'bypass') { enterBypass(); return }
      if (mode === 'bypass' || guarded) { leaveOrRepair(next); return }
      persist(next)
      mode = next
    },

    toolTiers() {
      // Only `confirm` changes tiers, and only upward: every acting tool asks.
      if (mode !== 'confirm') return Object.freeze({})
      return Object.freeze(Object.fromEntries(
        actingTools().map((name) => [name, 2 as ToolTier]),
      ))
    },

    // Plan Mode may eventually use exact/similar grants from ADR-0092, but old
    // tool-wide grants are too broad and must not be silently upgraded.
    ignoreGrants: () => mode === 'confirm' || mode === 'plan',

    ignoreSimilarGrants: () => mode === 'confirm',

    bypassesHostBash: () => mode === 'bypass',
  }
}

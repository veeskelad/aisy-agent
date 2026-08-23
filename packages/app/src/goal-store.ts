// Versioned JSON GoalStore. Active legacy/unscoped records are preserved but
// quarantined paused; they are never returned to the goal orchestrator.

import {
  resolvedWorkBinding,
  type GoalSpec,
  type GoalStore,
} from '@aisy/core'

export interface GoalStoreDeps {
  path: string
  readFile: (p: string) => string
  writeFile: (p: string, c: string) => void
  exists: (p: string) => boolean
  removeFile?: (p: string) => void
}

export interface QuarantinedGoalRecord {
  id?: string
  status: 'paused'
  haltReason: 'unbound-context'
  quarantineReason: 'missing-or-invalid-work-binding'
}

export interface GoalStoreWithQuarantine extends GoalStore {
  loadQuarantined(): Promise<QuarantinedGoalRecord | null>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function decodeGoalSpec(value: unknown): GoalSpec | null {
  const input = record(value)
  if (!input || input['schemaVersion'] !== 2 ||
    typeof input['id'] !== 'string' || input['id'].trim().length === 0 ||
    typeof input['objective'] !== 'string' || input['objective'].trim().length === 0 ||
    !Array.isArray(input['grantedScope']) ||
    !input['grantedScope'].every((item) => typeof item === 'string') ||
    !['active', 'completed', 'halted', 'stopped'].includes(String(input['status'])) ||
    !Number.isSafeInteger(input['iterationsSpent']) || Number(input['iterationsSpent']) < 0 ||
    typeof input['createdAt'] !== 'string' || typeof input['updatedAt'] !== 'string') {
    return null
  }
  const mode = record(input['mode'])
  const backstop = record(input['backstop'])
  const usage = record(input['usageSpent'])
  if (!mode || !['until', 'every', 'budget'].includes(String(mode['kind'])) ||
    !backstop || !Number.isSafeInteger(backstop['maxIterations']) ||
    !finiteNonNegative(backstop['tokenCeiling']) ||
    !finiteNonNegative(backstop['dollarCeiling']) ||
    !usage || !finiteNonNegative(usage['inputTokens']) ||
    !finiteNonNegative(usage['outputTokens']) || !finiteNonNegative(usage['dollars'])) {
    return null
  }
  try {
    const binding = resolvedWorkBinding(input['binding'])
    return { ...input, binding } as unknown as GoalSpec
  } catch {
    return null
  }
}

function quarantine(value: Record<string, unknown>): QuarantinedGoalRecord & Record<string, unknown> {
  return {
    ...value,
    status: 'paused',
    haltReason: 'unbound-context',
    quarantineReason: 'missing-or-invalid-work-binding',
  }
}

export function makeGoalStore(deps: GoalStoreDeps): GoalStoreWithQuarantine {
  const { path, readFile, writeFile, exists, removeFile } = deps

  const read = (): unknown => {
    if (!exists(path)) return null
    try {
      return JSON.parse(readFile(path)) as unknown
    } catch {
      return null
    }
  }

  return {
    async load(): Promise<GoalSpec | null> {
      const parsed = read()
      const spec = decodeGoalSpec(parsed)
      if (spec) return spec.status === 'active' ? spec : null
      const raw = record(parsed)
      if (raw?.['status'] === 'active') {
        writeFile(path, JSON.stringify(quarantine(raw), null, 2))
      }
      return null
    },

    async loadQuarantined(): Promise<QuarantinedGoalRecord | null> {
      const raw = record(read())
      if (!raw || raw['status'] !== 'paused' || raw['haltReason'] !== 'unbound-context' ||
        raw['quarantineReason'] !== 'missing-or-invalid-work-binding') return null
      return raw as unknown as QuarantinedGoalRecord
    },

    async save(spec: GoalSpec): Promise<void> {
      const validated = decodeGoalSpec(spec)
      if (!validated) throw new Error('INVALID_GOAL_SPEC')
      writeFile(path, JSON.stringify(validated, null, 2))
    },

    async clear(): Promise<void> {
      if (removeFile) {
        removeFile(path)
      } else {
        writeFile(path, 'null')
      }
    },
  }
}

// Versioned JSON TriggerStore. Legacy/unscoped records are retained on disk,
// disabled, and excluded from the executable set until explicitly rebound.

import {
  resolvedWorkBinding,
  type TriggerSpec,
  type TriggerStore,
} from '@aisy/core'

export interface TriggerStoreDeps {
  path: string
  readFile: (p: string) => string
  writeFile: (p: string, c: string) => void
  exists: (p: string) => boolean
}

export interface QuarantinedTriggerRecord {
  id?: string
  enabled: false
  pauseReason: 'unbound-context'
  quarantineReason: 'missing-or-invalid-work-binding'
}

export interface TriggerStoreWithQuarantine extends TriggerStore {
  loadQuarantined(): Promise<QuarantinedTriggerRecord[]>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function decodeTriggerSpec(value: unknown): TriggerSpec | null {
  const input = record(value)
  const budget = record(input?.['budget'])
  if (!input || input['schemaVersion'] !== 2 ||
    typeof input['id'] !== 'string' || input['id'].trim().length === 0 ||
    !['remind', 'schedule', 'watch'].includes(String(input['kind'])) ||
    !['operator', 'agent'].includes(String(input['createdBy'])) ||
    typeof input['confirmed'] !== 'boolean' || typeof input['enabled'] !== 'boolean' ||
    typeof input['prompt'] !== 'string' || !budget ||
    !finiteNonNegative(budget['tokenCeiling']) ||
    !finiteNonNegative(budget['dollarCeiling']) ||
    !finiteNonNegative(budget['tokensSpent']) ||
    !finiteNonNegative(budget['dollarsSpent'])) return null
  try {
    const binding = resolvedWorkBinding(input['binding'])
    return { ...input, binding } as unknown as TriggerSpec
  } catch {
    return null
  }
}

function quarantined(value: Record<string, unknown>): QuarantinedTriggerRecord & Record<string, unknown> {
  return {
    ...value,
    enabled: false,
    pauseReason: 'unbound-context',
    quarantineReason: 'missing-or-invalid-work-binding',
  }
}

export function makeTriggerStore(deps: TriggerStoreDeps): TriggerStoreWithQuarantine {
  const { path, readFile, writeFile, exists } = deps

  const readAll = (): unknown[] => {
    if (!exists(path)) return []
    try {
      const parsed: unknown = JSON.parse(readFile(path))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  const saveAll = (specs: unknown[]): void => {
    writeFile(path, JSON.stringify(specs, null, 2))
  }

  const sanitize = (): { executable: TriggerSpec[]; records: unknown[] } => {
    const source = readAll()
    let changed = false
    const executable: TriggerSpec[] = []
    const records = source.map((item) => {
      const spec = decodeTriggerSpec(item)
      if (spec) {
        executable.push(spec)
        return spec
      }
      const raw = record(item)
      if (!raw || raw['quarantineReason'] === 'missing-or-invalid-work-binding') return item
      changed = true
      return quarantined(raw)
    })
    if (changed) saveAll(records)
    return { executable, records }
  }

  return {
    async load(): Promise<TriggerSpec[]> {
      return sanitize().executable
    },

    async loadQuarantined(): Promise<QuarantinedTriggerRecord[]> {
      return sanitize().records.flatMap((item) => {
        const raw = record(item)
        return raw?.['quarantineReason'] === 'missing-or-invalid-work-binding'
          ? [raw as unknown as QuarantinedTriggerRecord]
          : []
      })
    },

    async save(spec: TriggerSpec): Promise<void> {
      const validated = decodeTriggerSpec(spec)
      if (!validated) throw new Error('INVALID_TRIGGER_SPEC')
      const all = readAll()
      const idx = all.findIndex((item) => record(item)?.['id'] === validated.id)
      if (idx >= 0) all[idx] = validated
      else all.push(validated)
      saveAll(all)
    },

    async remove(id: string): Promise<void> {
      saveAll(readAll().filter((item) => record(item)?.['id'] !== id))
    },
  }
}

// JSONL-backed TriggerStore implementation (Tier-4 D1).
// Persists as a JSON array; load parses it, save/remove rewrite the whole file.

import type { TriggerSpec, TriggerStore } from '@aisy/core'

export interface TriggerStoreDeps {
  path: string
  readFile: (p: string) => string
  writeFile: (p: string, c: string) => void
  exists: (p: string) => boolean
}

export function makeTriggerStore(deps: TriggerStoreDeps): TriggerStore {
  const { path, readFile, writeFile, exists } = deps

  function loadAll(): TriggerSpec[] {
    if (!exists(path)) return []
    try {
      const raw = readFile(path)
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed as TriggerSpec[]
    } catch {
      return []
    }
  }

  function saveAll(specs: TriggerSpec[]): void {
    writeFile(path, JSON.stringify(specs, null, 2))
  }

  return {
    async load(): Promise<TriggerSpec[]> {
      return loadAll()
    },

    async save(spec: TriggerSpec): Promise<void> {
      const all = loadAll()
      const idx = all.findIndex((s) => s.id === spec.id)
      if (idx >= 0) {
        all[idx] = spec
      } else {
        all.push(spec)
      }
      saveAll(all)
    },

    async remove(id: string): Promise<void> {
      const all = loadAll().filter((s) => s.id !== id)
      saveAll(all)
    },
  }
}

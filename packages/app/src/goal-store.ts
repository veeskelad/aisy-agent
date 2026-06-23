// JSON single-object GoalStore (Tier-7 A).
// Stores one GoalSpec per file; load returns it only when status === 'active'.
// Near-copy of trigger-store.ts — keep the two in sync for the same dep shape.

import type { GoalSpec, GoalStore } from '@aisy/core'

export interface GoalStoreDeps {
  path: string
  readFile: (p: string) => string
  writeFile: (p: string, c: string) => void
  exists: (p: string) => boolean
  removeFile?: (p: string) => void
}

export function makeGoalStore(deps: GoalStoreDeps): GoalStore {
  const { path, readFile, writeFile, exists, removeFile } = deps

  return {
    async load(): Promise<GoalSpec | null> {
      if (!exists(path)) return null
      try {
        const raw = readFile(path)
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        const spec = parsed as GoalSpec
        if (spec.status !== 'active') return null
        return spec
      } catch {
        return null
      }
    },

    async save(spec: GoalSpec): Promise<void> {
      writeFile(path, JSON.stringify(spec))
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

// packages/core-ts/src/runtime/memory-adapter.ts
// Bridge the memory component (Memory) to the agent-loop ports. The two
// FrozenSnapshot shapes differ — memory yields {bytes, sha256}; the loop wants
// {prefixBytes, prefixHash, breakpoints, takenAt} — so this is a real translation.

import type { MemoryPort } from '../agent-loop/types.js'
import type { Memory, RankedHit } from '../memory/index.js'

export function makeMemoryPort(memory: Memory, nowIso: () => string): MemoryPort {
  return {
    snapshot: async () => {
      const snap = await memory.readFrozenSnapshot()
      return {
        prefixBytes: new Uint8Array(snap.bytes),
        prefixHash: snap.sha256,
        breakpoints: [],
        takenAt: nowIso(),
      }
    },
    forget: (factRef, humanConfirmed) => memory.forget(factRef, 'operator forget', humanConfirmed),
  }
}

/** Bridge Memory.search → the execute-tool searchMemory port (hits → text). */
export function makeMemorySearch(memory: Memory, limit = 8): (query: string) => Promise<string> {
  return async (query: string) => {
    const hits: RankedHit[] = await memory.search(query, { limit })
    if (hits.length === 0) return 'Память: ничего не найдено.'
    return hits.map((h) => `• [${h.factKey}] ${h.text}`).join('\n')
  }
}

// packages/core-ts/src/runtime/memory-adapter.ts
// Bridge the memory component (Memory) to the agent-loop ports. The two
// FrozenSnapshot shapes differ — memory yields {bytes, sha256}; the loop wants
// {prefixBytes, prefixHash, breakpoints, takenAt} — so this is a real translation.

import { createHash } from 'node:crypto'
import type { MemoryPort } from '../agent-loop/types.js'
import type { Memory, RankedHit } from '../memory/index.js'
import { AGENT_PROTOCOL } from './agent-protocol.js'

export function makeMemoryPort(memory: Memory, nowIso: () => string): MemoryPort {
  return {
    snapshot: async () => {
      const snap = await memory.readFrozenSnapshot()
      // Prepend the harness operating manual ahead of the persona/memory files.
      // Constant ⇒ the prefix stays KV-cache-stable; hash covers the full prefix.
      const bytes = Buffer.concat([Buffer.from(AGENT_PROTOCOL, 'utf8'), snap.bytes])
      return {
        prefixBytes: new Uint8Array(bytes),
        prefixHash: createHash('sha256').update(bytes).digest('hex'),
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
    let hits: RankedHit[]
    try {
      hits = await memory.search(query, { limit })
    } catch {
      // A cold start (no index on disk until the first write) or a transient
      // read error must NOT crash the turn — the loop's catch only handles its
      // own Halt and would otherwise surface as an unhandled rejection in the
      // transport. The model just gets "no memory" and continues.
      return 'Память: индекс пуст или недоступен.'
    }
    if (hits.length === 0) return 'Память: ничего не найдено.'
    return hits.map((h) => `• [${h.factKey}] ${h.text}`).join('\n')
  }
}

/**
 * Bridge Memory.search → a per-turn recall probe used to inject relevant facts
 * into the non-prefix span before each operator turn.
 *
 * Returns '' (empty string) when there are no hits OR on a cold start / search
 * error so the caller can skip the injection cheaply. Does NOT throw.
 */
export function makeMemoryRecall(memory: Memory, limit = 5): (query: string) => Promise<string> {
  return async (query: string) => {
    let hits: RankedHit[]
    try {
      hits = await memory.search(query, { limit })
    } catch {
      return ''
    }
    if (hits.length === 0) return ''
    return hits.map((h) => `• ${h.text}`).join('\n')
  }
}

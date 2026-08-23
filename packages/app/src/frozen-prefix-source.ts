// Frozen context prefix, separated from memory (ADR-0074 §1).
//
// The stable KV-cache prefix is a concatenation of operator-owned DNA files. It
// never was a ledger read, and after ADR-0074 it stops pretending to be one:
// memory owns facts, this owns the prefix bytes.
//
// `MEMORY.md` inside that list is the deterministic projection of live facts;
// producing it is the projection's job, reading it is this file's job.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { projectionHealth, truncateProjection } from '@aisy/core'
import type { MemoryProjectionHealth } from '@aisy/core'

export interface FrozenPrefix {
  bytes: Buffer
  sha256: string
}

export interface FrozenPrefixSource {
  read(): FrozenPrefix
}

const MAX_PREFIX_BYTES = 4 * 1024 * 1024

export class FrozenPrefixError extends Error {
  constructor(readonly reason: 'prefix-too-large' | 'unreadable') {
    super(`frozen prefix refused: ${reason}`)
    this.name = 'FrozenPrefixError'
  }
}

/**
 * Read the DNA prefix in the exact code-owned order. A missing file is simply
 * absent — the operator is not required to author every layer — but an
 * unreadable or oversized one fails closed rather than silently truncating the
 * agent's identity.
 */
export function makeFrozenPrefixSource(input: {
  memoryRoot: string
  /** Code-owned order of prefix files; pass `GLOBAL_DNA_PREFIX_FILES`. */
  files: readonly string[]
  /**
   * Generated sections appended after the DNA files — the knowledge catalogue
   * (ADR-0075) and anything else that is a projection rather than an authored
   * file. A section that throws is skipped: a broken projection must not cost
   * the agent its identity.
   */
  sections?: ReadonlyArray<() => string | null>
  /**
   * The fact projection among the DNA files (ADR-0078). It is capped at the
   * memory limit and truncated at a line boundary when it grows past it — the
   * ledger keeps every fact, only the view is cut. Its health is reported so
   * the per-turn self-check can tell the operator to consolidate.
   */
  projectionFile?: string
  onProjectionHealth?: (health: MemoryProjectionHealth & { truncated: boolean }) => void
}): FrozenPrefixSource {
  return {
    read(): FrozenPrefix {
      const parts: Buffer[] = []
      let total = 0
      for (const name of input.files) {
        const path = join(input.memoryRoot, name)
        if (!existsSync(path)) continue
        let bytes: Buffer
        try {
          if (statSync(path).size > MAX_PREFIX_BYTES) throw new FrozenPrefixError('prefix-too-large')
          bytes = readFileSync(path)
        } catch (error) {
          if (error instanceof FrozenPrefixError) throw error
          throw new FrozenPrefixError('unreadable')
        }
        if (name === input.projectionFile) {
          const raw = bytes.toString('utf8')
          const health = projectionHealth(raw)
          const cut = truncateProjection(raw)
          if (cut.truncated) bytes = Buffer.from(cut.content, 'utf8')
          // Reporting must never cost the agent its prefix.
          try {
            input.onProjectionHealth?.({ ...health, truncated: cut.truncated })
          } catch { /* the observer's problem, not the prefix's */ }
        }
        total += bytes.byteLength
        if (total > MAX_PREFIX_BYTES) throw new FrozenPrefixError('prefix-too-large')
        parts.push(bytes)
      }
      for (const section of input.sections ?? []) {
        let text: string | null
        try {
          text = section()
        } catch {
          continue
        }
        if (text === null || text === '') continue
        const encoded = Buffer.from(text, 'utf8')
        total += encoded.byteLength
        if (total > MAX_PREFIX_BYTES) throw new FrozenPrefixError('prefix-too-large')
        parts.push(encoded)
      }
      const bytes = Buffer.concat(parts)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
  }
}

// Component 15 — Context Engine. Pure types, no implementation.
// See docs/specs/15-context-engine.md §3 and ADR-0040.

import type { Provenance } from '../agent-loop/types.js'

export type { Provenance }

export type SegmentKind = 'pinned' | 'verbatim' | 'summary'
export type CompactionTier = 'none' | 'snip' | 'micro' | 'collapse' | 'auto'

export interface TranscriptEntry {
  seq: number // monotonic; matches the Observability journal seq
  role: 'system' | 'user' | 'assistant' | 'tool'
  provenance: Provenance
  text: string
  /** unresolved bug / open decision / pending TODO — survives compaction (recall-first). */
  loadBearing?: boolean
}

export interface ContextSegment {
  kind: SegmentKind
  provenance: Provenance // a summary inherits the STRICTEST provenance of its sources
  text: string
  coversSeq: [number, number] // the transcript range this segment projects
}

export interface CompactionView {
  segments: ContextSegment[] // [pinned] + [summary…] + [verbatim tail]
  breakpoints: number[] // ≤4, re-established post-projection (ADR-0019)
  tier: CompactionTier
  tokensEstimated: number
}

export interface ContextEngineDeps {
  /** Append-only transcript of record (Observability 12). */
  journalAppend(entry: TranscriptEntry): void
  journalRead(sessionId: string): TranscriptEntry[]
  /** Whether the durable journal is readable — fail-closed when false (spec §7). */
  journalAvailable?(): boolean
  /** Frozen Level-1 prefix (Core/Memory) — pinned, never compacted. */
  pinnedPrefix(): { text: string; breakpoints: number[] }
  budget: { windowTokens: number; compactAtFraction: number }
  /** Drafts a recall-first summary of a range; NEVER mutates the trace. May throw. */
  summarize(entries: TranscriptEntry[]): Promise<string>
  estimateTokens(text: string): number
  /** Observability sink (context.assembled / context.compacted). */
  emitEvent?(event: string, payload: unknown): void
}

export interface ContextEngine {
  /** Append a turn to the transcript of record (write-through). */
  record(sessionId: string, entry: Omit<TranscriptEntry, 'seq'>): void
  /** Project the transcript to the smallest recall-first view under budget. */
  assemble(sessionId: string): Promise<CompactionView>
  /** Current tier without re-projecting (introspection / `/context`). */
  currentTier(sessionId: string): CompactionTier
}

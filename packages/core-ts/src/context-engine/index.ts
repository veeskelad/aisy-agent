import type {
  CompactionTier,
  CompactionView,
  ContextEngine,
  ContextEngineDeps,
  ContextSegment,
  TranscriptEntry,
} from './types.js'

export type {
  SegmentKind,
  CompactionTier,
  TranscriptEntry,
  ContextSegment,
  CompactionView,
  ContextEngineDeps,
  ContextEngine,
  Provenance,
} from './types.js'

// ---------------------------------------------------------------------------
// makeContextEngine — projection over an append-only transcript (ADR-0040).
// Compaction is a VIEW: the journal (transcript of record) is never mutated;
// each tier produces fresh segments referencing transcript ranges.
// ---------------------------------------------------------------------------

const TIERS: CompactionTier[] = ['snip', 'micro', 'collapse', 'auto']
const TAIL_VERBATIM = 1 // most-recent turns always kept verbatim

export function makeContextEngine(deps: ContextEngineDeps): ContextEngine {
  const seqBy = new Map<string, number>()
  const lastTier = new Map<string, CompactionTier>()
  const est = (t: string): number => deps.estimateTokens(t)

  const verbatim = (e: TranscriptEntry): ContextSegment => ({
    kind: 'verbatim',
    provenance: e.provenance,
    text: e.text,
    coversSeq: [e.seq, e.seq],
  })

  // A summary inherits the STRICTEST provenance of its sources (ADR-0027):
  // any untrusted source → the summary is untrusted (cannot be laundered).
  const summarySeg = async (entries: TranscriptEntry[]): Promise<ContextSegment> => ({
    kind: 'summary',
    provenance: entries.some(e => e.provenance === 'untrusted') ? 'untrusted' : 'operator',
    text: await deps.summarize(entries),
    coversSeq: [entries[0]!.seq, entries[entries.length - 1]!.seq],
  })

  const totalTokens = (pinnedText: string, segs: ContextSegment[]): number =>
    est(pinnedText) + segs.reduce((n, s) => n + est(s.text), 0)

  // --- tier builders (recall-first: load-bearing entries never summarized) ---

  const buildSnip = (entries: TranscriptEntry[]): ContextSegment[] => {
    const seen = new Set<string>()
    return entries.filter(e => (seen.has(e.text) ? false : (seen.add(e.text), true))).map(verbatim)
  }

  const buildMicro = async (entries: TranscriptEntry[]): Promise<ContextSegment[]> => {
    const idx = entries.findIndex(e => !e.loadBearing && e.role === 'tool')
    if (idx < 0) return entries.map(verbatim)
    const out: ContextSegment[] = []
    for (let i = 0; i < entries.length; i++) {
      out.push(i === idx ? await summarySeg([entries[i]!]) : verbatim(entries[i]!))
    }
    return out
  }

  const buildCollapse = async (entries: TranscriptEntry[]): Promise<ContextSegment[]> => {
    const mid = Math.floor(entries.length / 2)
    const toSummarize = entries.slice(0, mid).filter(e => !e.loadBearing)
    const keep = [...entries.slice(0, mid).filter(e => e.loadBearing), ...entries.slice(mid)]
    const segs: ContextSegment[] = toSummarize.length ? [await summarySeg(toSummarize)] : []
    return [...segs, ...keep.map(verbatim)]
  }

  const buildAuto = async (entries: TranscriptEntry[]): Promise<ContextSegment[]> => {
    const tailStart = Math.max(0, entries.length - TAIL_VERBATIM)
    const keepVerbatim = entries.filter((e, i) => e.loadBearing || i >= tailStart)
    const toSummarize = entries.filter((e, i) => !e.loadBearing && i < tailStart)
    const segs: ContextSegment[] = toSummarize.length ? [await summarySeg(toSummarize)] : []
    return [...segs, ...keepVerbatim.map(verbatim)]
  }

  const buildTier = (tier: CompactionTier, entries: TranscriptEntry[]): Promise<ContextSegment[]> | ContextSegment[] => {
    switch (tier) {
      case 'snip': return buildSnip(entries)
      case 'micro': return buildMicro(entries)
      case 'collapse': return buildCollapse(entries)
      default: return buildAuto(entries)
    }
  }

  // Deterministic fallback (no model): drop oldest non-load-bearing entries
  // from the view until it fits — used when the summarizer is unavailable (§7).
  const trimDeterministic = (entries: TranscriptEntry[], pinnedText: string, windowTokens: number): ContextSegment[] => {
    const kept = [...entries]
    while (totalTokens(pinnedText, kept.map(verbatim)) > windowTokens) {
      const dropIdx = kept.findIndex(e => !e.loadBearing)
      if (dropIdx < 0) break // only load-bearing left — keep them (recall-first)
      kept.splice(dropIdx, 1)
    }
    return kept.map(verbatim)
  }

  return {
    record(sessionId, entry): void {
      const seq = (seqBy.get(sessionId) ?? 0) + 1
      seqBy.set(sessionId, seq)
      deps.journalAppend({ ...entry, seq })
    },

    currentTier(sessionId): CompactionTier {
      return lastTier.get(sessionId) ?? 'none'
    },

    async assemble(sessionId): Promise<CompactionView> {
      const entries = deps.journalRead(sessionId)
      const pinned = deps.pinnedPrefix()
      const pinnedSeg: ContextSegment = { kind: 'pinned', provenance: 'operator', text: pinned.text, coversSeq: [-1, -1] }
      const breakpoints = pinned.breakpoints.slice(0, 4) // ADR-0019: ≤4, re-pinned post-projection
      const { windowTokens, compactAtFraction } = deps.budget

      // Under budget → verbatim, no compaction.
      const verbatimTotal = totalTokens(pinned.text, entries.map(verbatim))
      if (verbatimTotal <= windowTokens * compactAtFraction) {
        const segments = [pinnedSeg, ...entries.map(verbatim)]
        lastTier.set(sessionId, 'none')
        deps.emitEvent?.('context.assembled', { tier: 'none', tokens: verbatimTotal })
        return { segments, breakpoints, tier: 'none', tokensEstimated: verbatimTotal }
      }

      // Compaction needed → require a durable trace (fail-closed, §7).
      if (deps.journalAvailable && !deps.journalAvailable()) {
        throw new Error('context-engine: journal unavailable — refusing to compact without a durable trace (fail-closed)')
      }

      const finalize = (tier: CompactionTier, segs: ContextSegment[]): CompactionView => {
        const segments = [pinnedSeg, ...segs]
        lastTier.set(sessionId, tier)
        deps.emitEvent?.('context.compacted', { tier, covers: segs.map(s => s.coversSeq) })
        return { segments, breakpoints, tier, tokensEstimated: totalTokens(pinned.text, segs) }
      }

      try {
        for (const tier of TIERS) {
          const segs = await buildTier(tier, entries)
          if (totalTokens(pinned.text, segs) <= windowTokens || tier === 'auto') {
            return finalize(tier, segs)
          }
        }
        // unreachable (auto always returns), but keep the type checker happy
        return finalize('auto', await buildAuto(entries))
      } catch {
        // Summarizer failed → degrade to deterministic trimming, never throw (AC-15-9).
        return finalize('auto', trimDeterministic(entries, pinned.text, windowTokens))
      }
    },
  }
}

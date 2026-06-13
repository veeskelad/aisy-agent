import { describe, it, expect } from 'vitest'
import { makeContextEngine } from './index.js'
import type { ContextEngineDeps, TranscriptEntry, Provenance } from './types.js'

// ---------------------------------------------------------------------------
// Helpers — token estimate = char length (deterministic).
// ---------------------------------------------------------------------------

interface H {
  deps: ContextEngineDeps
  stored: TranscriptEntry[]
  events: Array<{ event: string; payload: any }>
  setAvailable(b: boolean): void
}

function makeDeps(over: Partial<ContextEngineDeps> & { breakpoints?: number[] } = {}): H {
  const stored: TranscriptEntry[] = []
  const events: H['events'] = []
  let available = true
  const deps: ContextEngineDeps = {
    journalAppend: over.journalAppend ?? ((e) => { stored.push({ ...e }) }),
    journalRead: over.journalRead ?? (() => stored.map(e => ({ ...e }))),
    journalAvailable: over.journalAvailable ?? (() => available),
    pinnedPrefix: over.pinnedPrefix ?? (() => ({ text: 'PINNED', breakpoints: over.breakpoints ?? [0, 1, 2, 3] })),
    budget: over.budget ?? { windowTokens: 100, compactAtFraction: 0.8 },
    summarize: over.summarize ?? (async (es) => `[summary ${es[0]?.seq ?? 0}-${es[es.length - 1]?.seq ?? 0}]`),
    estimateTokens: over.estimateTokens ?? ((t) => t.length),
    emitEvent: over.emitEvent ?? ((event, payload) => events.push({ event, payload })),
  }
  return { deps, stored, events, setAvailable: (b) => { available = b } }
}

function add(eng: ReturnType<typeof makeContextEngine>, text: string, opts: { provenance?: Provenance; loadBearing?: boolean; role?: TranscriptEntry['role'] } = {}): void {
  eng.record('s', { role: opts.role ?? 'tool', provenance: opts.provenance ?? 'operator', text, ...(opts.loadBearing ? { loadBearing: true } : {}) })
}

// ---------------------------------------------------------------------------
// AC-15-1 .. AC-15-11
// ---------------------------------------------------------------------------

describe('Context Engine (15)', () => {
  it('AC-15-1: under budget → tier none, every entry verbatim in order', async () => {
    const h = makeDeps()
    const eng = makeContextEngine(h.deps)
    add(eng, 'alpha'); add(eng, 'beta')
    const view = await eng.assemble('s')
    expect(view.tier).toBe('none')
    expect(view.segments.map(s => s.text)).toEqual(['PINNED', 'alpha', 'beta'])
    expect(view.segments.map(s => s.kind)).toEqual(['pinned', 'verbatim', 'verbatim'])
  })

  it('AC-15-2: after compaction, journalRead returns the full transcript unchanged (view, not write)', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 10; i++) add(eng, `entry-${i}-xxxx`)
    const before = h.deps.journalRead('s')
    const view = await eng.assemble('s')
    expect(view.tier).not.toBe('none')          // compaction happened
    const after = h.deps.journalRead('s')
    expect(after).toEqual(before)                // trace untouched
    expect(after).toHaveLength(10)
  })

  it('AC-15-3a: escalates to the CHEAPEST tier that fits — snip suffices when duplicates dominate', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 10; i++) add(eng, 'DUPLICATED!')   // 11 chars × 10 identical
    const view = await eng.assemble('s')
    expect(view.tier).toBe('snip')
    expect(view.tokensEstimated).toBeLessThanOrEqual(50)
  })

  it('AC-15-3b: escalates to auto when only whole-middle summarization fits', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(eng, `distinct-${i}-yyyy`)  // all distinct, no dup help
    const view = await eng.assemble('s')
    expect(view.tier).toBe('auto')
    expect(view.tokensEstimated).toBeLessThanOrEqual(50)
  })

  it('AC-15-4: a load-bearing entry is preserved verbatim through auto compaction', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 10; i++) add(eng, `noise-${i}-zzzz`)
    add(eng, 'UNRESOLVED_BUG_42', { loadBearing: true })
    for (let i = 0; i < 10; i++) add(eng, `more-${i}-zzzz`)
    const view = await eng.assemble('s')
    expect(view.tier).toBe('auto')
    expect(view.segments.some(s => s.text.includes('UNRESOLVED_BUG_42'))).toBe(true)
  })

  it('AC-15-5: the pinned prefix is present verbatim in every view (none and auto)', async () => {
    const none = makeContextEngine(makeDeps().deps)
    add(none, 'x')
    const v1 = await none.assemble('s')
    expect(v1.segments[0]).toMatchObject({ kind: 'pinned', text: 'PINNED' })

    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const auto = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(auto, `e-${i}-qqqq`)
    const v2 = await auto.assemble('s')
    expect(v2.tier).toBe('auto')
    expect(v2.segments[0]).toMatchObject({ kind: 'pinned', text: 'PINNED' })
  })

  it('AC-15-6: a summary covering an untrusted source is untrusted; narrowing matches the full transcript', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 10; i++) add(eng, `clean-${i}-wwww`)
    add(eng, 'INJECTED page content', { provenance: 'untrusted' })
    for (let i = 0; i < 10; i++) add(eng, `clean2-${i}-wwww`)
    const view = await eng.assemble('s')
    const entries = h.deps.journalRead('s')
    const narrowedTranscript = entries.some(e => e.provenance === 'untrusted')
    const narrowedView = view.segments.some(s => s.provenance === 'untrusted')
    expect(narrowedView).toBe(narrowedTranscript)
    expect(narrowedView).toBe(true)
  })

  it('AC-15-7: the view exposes at most 4 cache breakpoints', async () => {
    const h = makeDeps({ breakpoints: [0, 1, 2, 3, 4, 5], budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(eng, `e-${i}-pppp`)
    const view = await eng.assemble('s')
    expect(view.breakpoints.length).toBeLessThanOrEqual(4)
  })

  it('AC-15-8: projection is deterministic for a fixed (transcript, tier)', async () => {
    const mk = () => {
      const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
      const eng = makeContextEngine(h.deps)
      for (let i = 0; i < 20; i++) add(eng, `det-${i}-rrrr`)
      return eng
    }
    const v1 = await mk().assemble('s')
    const v2 = await mk().assemble('s')
    expect(v1).toEqual(v2)
  })

  it('AC-15-9: when summarize throws, assemble degrades deterministically and never throws', async () => {
    const h = makeDeps({
      budget: { windowTokens: 50, compactAtFraction: 0.8 },
      summarize: async () => { throw new Error('summarizer down') },
    })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(eng, `e-${i}-ssss`)
    const view = await eng.assemble('s')          // must NOT throw
    expect(view.segments[0]).toMatchObject({ kind: 'pinned' })
    expect(view.tokensEstimated).toBeLessThanOrEqual(50)  // deterministic trim still fit it
  })

  it('AC-15-10: journal unavailable + over budget → fail-closed (no compaction): assemble throws', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(eng, `e-${i}-tttt`)
    h.setAvailable(false)
    await expect(eng.assemble('s')).rejects.toThrow(/journal|durable|fail-closed/i)
  })

  it('AC-15-11: context.compacted is emitted with the tier and coversSeq ranges', async () => {
    const h = makeDeps({ budget: { windowTokens: 50, compactAtFraction: 0.8 } })
    const eng = makeContextEngine(h.deps)
    for (let i = 0; i < 20; i++) add(eng, `e-${i}-uuuu`)
    await eng.assemble('s')
    const ev = h.events.find(e => e.event === 'context.compacted')
    expect(ev).toBeDefined()
    expect(ev!.payload.tier).toBe('auto')
    expect(Array.isArray(ev!.payload.covers)).toBe(true)
    expect(ev!.payload.covers.every((c: unknown) => Array.isArray(c) && (c as number[]).length === 2)).toBe(true)
  })
})

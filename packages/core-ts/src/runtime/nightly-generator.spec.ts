// packages/core-ts/src/runtime/nightly-generator.spec.ts
import { describe, it, expect } from 'vitest'
import { makeNightlyGenerator, makeNightlyJudge } from './nightly-generator.js'
import type { ProviderAdapter } from '../agent-loop/types.js'
import type { Fact, NormalizedDayLog, QuarantinedDiff } from '../nightly/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeProvider(reply: string): ProviderAdapter {
  return {
    complete: async () => ({ reply }),
  }
}

const emptyLog: NormalizedDayLog = { date: '2026-06-22', records: [] }

const liveFacts: Fact[] = [
  {
    id: 'f1',
    factKey: { entity: 'fact', relation: 'asserts', object: 'user-location' },
    text: 'lives in Berlin',
    invalidAt: null,
    isHumanConfirmed: false,
  },
  {
    id: 'f2',
    factKey: { entity: 'fact', relation: 'asserts', object: 'user-lang' },
    text: 'speaks English',
    invalidAt: null,
    isHumanConfirmed: false,
  },
]

// ---------------------------------------------------------------------------
// makeNightlyGenerator — proposeMemoryOps
// ---------------------------------------------------------------------------

describe('makeNightlyGenerator – proposeMemoryOps', () => {
  it('case 1: provider returns a valid MemOp JSON array — parsed ops + correct diff split', async () => {
    const payload = JSON.stringify([
      { kind: 'ADD', factKey: 'user-city', text: 'moved to Hamburg' },
      { kind: 'UPDATE', factId: 'f1', factKey: 'user-location', text: 'Hamburg now' },
      { kind: 'DELETE', factId: 'f2', reason: 'outdated' },
      { kind: 'NOOP', factId: 'f1' },
    ])
    const gen = makeNightlyGenerator({ provider: fakeProvider(payload), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops, diff } = await gen.proposeMemoryOps(emptyLog, liveFacts)

    // Should have 4 ops (including NOOP)
    expect(ops).toHaveLength(4)

    // Diff: ADD and UPDATE separated; NOOP excluded
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0]!.kind).toBe('ADD')

    expect(diff.updated).toHaveLength(1)
    expect(diff.updated[0]!.kind).toBe('UPDATE')

    expect(diff.removed).toHaveLength(1)
    expect(diff.removed[0]).toBe('f2')
  })

  it('case 2: provider returns prose-wrapped JSON — array still extracted', async () => {
    const payload = `Here are my proposed changes:\n\n[{"kind":"ADD","factKey":"pref-theme","text":"dark mode"}]\n\nLet me know if these look good.`
    const gen = makeNightlyGenerator({ provider: fakeProvider(payload), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.kind).toBe('ADD')
  })

  it('case 3: malformed JSON → {ops:[], empty diff}', async () => {
    const gen = makeNightlyGenerator({ provider: fakeProvider('not json at all'), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops, diff } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(0)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.updated).toHaveLength(0)
  })

  it('case 4: >50 ops → capped at 50', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      kind: 'ADD',
      factKey: `slug-${i}`,
      text: `fact ${i}`,
    }))
    const gen = makeNightlyGenerator({
      provider: fakeProvider(JSON.stringify(many)),
      nowIso: () => '2026-06-22T03:30:00Z',
    })
    const { ops } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(50)
  })

  it('case 5: ADD slug wrapped into structured FactKey {entity:"fact",relation:"asserts",object:<slug>}', async () => {
    const payload = JSON.stringify([{ kind: 'ADD', factKey: 'user-city', text: 'Berlin' }])
    const gen = makeNightlyGenerator({ provider: fakeProvider(payload), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.kind).toBe('ADD')
    if (op.kind === 'ADD') {
      expect(op.factKey).toEqual({ entity: 'fact', relation: 'asserts', object: 'user-city' })
    }
  })

  it('case 6: UPDATE reuses live fact factKey when LLM omits factKey', async () => {
    // LLM emits UPDATE without a factKey field
    const payload = JSON.stringify([{ kind: 'UPDATE', factId: 'f1', text: 'now in Hamburg' }])
    const gen = makeNightlyGenerator({ provider: fakeProvider(payload), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.kind).toBe('UPDATE')
    if (op.kind === 'UPDATE') {
      // Should reuse f1's factKey from liveFacts
      expect(op.factKey).toEqual({ entity: 'fact', relation: 'asserts', object: 'user-location' })
    }
  })

  it('case 7: provider REJECTS → {ops:[], empty diff} (never rejects)', async () => {
    const throwingProvider: ProviderAdapter = {
      complete: async () => { throw new Error('provider unavailable') },
    }
    const gen = makeNightlyGenerator({ provider: throwingProvider, nowIso: () => '2026-06-22T03:30:00Z' })
    const result = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(result).toEqual({ ops: [], diff: { added: [], removed: [], updated: [] } })
  })

  it('case 8: preamble with brackets in string — correct array extracted (string-aware parse)', async () => {
    // The first "[" is inside a plain-text string, not JSON — the real array follows
    const payload = 'Sure! Here are [my notes]: [{"kind":"NOOP","factId":"f1"}]'
    const gen = makeNightlyGenerator({ provider: fakeProvider(payload), nowIso: () => '2026-06-22T03:30:00Z' })
    const { ops } = await gen.proposeMemoryOps(emptyLog, liveFacts)
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.kind).toBe('NOOP')
    if (op.kind === 'NOOP') {
      expect(op.factId).toBe('f1')
    }
  })
})

// ---------------------------------------------------------------------------
// makeNightlyGenerator — draftSkills
// ---------------------------------------------------------------------------

describe('makeNightlyGenerator – draftSkills', () => {
  it('returns empty array (deferred to a follow-up)', async () => {
    const gen = makeNightlyGenerator({ provider: fakeProvider('[]'), nowIso: () => '2026-06-22T03:30:00Z' })
    const drafts = await gen.draftSkills(emptyLog)
    expect(drafts).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// makeNightlyJudge
// ---------------------------------------------------------------------------

const sampleDiff: QuarantinedDiff = {
  quarantined: true,
  body: '[{"kind":"ADD","factKey":{"entity":"fact","relation":"asserts","object":"user-city"},"text":"Berlin"}]',
  diff: {
    added: [{ kind: 'ADD', factKey: { entity: 'fact', relation: 'asserts', object: 'user-city' }, text: 'Berlin' }],
    removed: [],
    updated: [],
  },
}

describe('makeNightlyJudge – grade', () => {
  it('case 7: provider returns {"verdict":"accept"} → accept', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('{"verdict":"accept"}') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('accept')
  })

  it('returns "reject" when provider returns {"verdict":"reject"}', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('{"verdict":"reject"}') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('reject')
  })

  it('returns "edit" when provider returns {"verdict":"edit"}', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('{"verdict":"edit"}') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('edit')
  })

  it('case 8: provider returns garbage → reject (fail-safe)', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('totally garbage not json') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('reject')
  })

  it('provider returns prose-wrapped JSON with accept → accept', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('Sure! Here is my verdict: {"verdict":"accept"} - looks good.') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('accept')
  })

  it('provider returns unknown verdict string → reject (fail-safe)', async () => {
    const judge = makeNightlyJudge({ provider: fakeProvider('{"verdict":"maybe"}') })
    const verdict = await judge.grade(sampleDiff)
    expect(verdict).toBe('reject')
  })
})

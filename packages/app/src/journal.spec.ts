import { describe, it, expect } from 'vitest'
import { makeJsonlJournal } from './journal.js'

describe('makeJsonlJournal', () => {
  it('appends one JSON line per event with ts/source/kind/payload', () => {
    const lines: string[] = []
    const j = makeJsonlJournal({ appendLine: (l) => lines.push(l), nowIso: () => '2026-06-22T00:00:00.000Z' })
    j.append('memory', 'memory.committed', { factId: 'f1' })
    expect(lines).toHaveLength(1)
    const e = JSON.parse(lines[0]!)
    expect(e).toEqual({ ts: '2026-06-22T00:00:00.000Z', source: 'memory', kind: 'memory.committed', payload: { factId: 'f1' } })
  })
  it('never throws when the writer fails', () => {
    const j = makeJsonlJournal({ appendLine: () => { throw new Error('disk full') }, nowIso: () => 't' })
    expect(() => j.append('x', 'y', {})).not.toThrow()
  })
})

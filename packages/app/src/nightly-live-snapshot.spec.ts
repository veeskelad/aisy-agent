import { describe, expect, it, vi } from 'vitest'

import type { MemoryFact } from '@aisy/core'
import { makeNightlyLiveSnapshotLoader } from './nightly-live-snapshot.js'

function fact(id: string, invalidAt: string | null = null): MemoryFact {
  return {
    id,
    text: `fact ${id}`,
    factKey: `key-${id}`,
    validAt: '2026-07-28T00:00:00.000Z',
    invalidAt,
    isHumanConfirmed: false,
    sourceAuthority: null,
    confidence: null,
    provenance: 'commit',
  }
}

describe('nightly live snapshot loader', () => {
  it('captures fresh facts and matching validator authority for every run', async () => {
    const snapshots = [
      [fact('fact-a')],
      [fact('fact-a'), fact('fact-b'), fact('forgotten', '2026-07-28T01:00:00.000Z')],
    ]
    const listLive = vi.fn(async () => snapshots.shift() ?? [])
    const load = makeNightlyLiveSnapshotLoader({ listLive })

    const first = await load()
    const second = await load()

    expect(first.facts.map((item) => item.id)).toEqual(['fact-a'])
    expect(first.validators.check({
      kind: 'UPDATE',
      factId: 'fact-b',
      factKey: { entity: 'fact-b', relation: 'memory', object: 'key-fact-b' },
      text: 'updated',
    })).toMatchObject({ ok: false })
    expect(second.facts.map((item) => item.id)).toEqual(['fact-a', 'fact-b', 'forgotten'])
    expect(second.validators.check({
      kind: 'UPDATE',
      factId: 'fact-b',
      factKey: { entity: 'fact-b', relation: 'memory', object: 'key-fact-b' },
      text: 'updated',
    })).toEqual({ ok: true })
    expect(second.validators.check({
      kind: 'DELETE',
      factId: 'forgotten',
      reason: 'stale',
    })).toMatchObject({ ok: false })
    expect(listLive).toHaveBeenCalledTimes(2)
  })
})

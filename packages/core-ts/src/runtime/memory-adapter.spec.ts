// packages/core-ts/src/runtime/memory-adapter.spec.ts
import { describe, it, expect } from 'vitest'
import { makeMemoryPort, makeMemorySearch } from './memory-adapter.js'
import type { Memory, RankedHit } from '../memory/index.js'

function fakeMemory(over: Partial<Memory> = {}): Memory {
  return {
    search: async () => [],
    load: async () => '',
    readFrozenSnapshot: async () => ({ bytes: Buffer.from('hello'), sha256: 'abc123' }),
    commit: async () => ({ verdict: 'ok' }) as never,
    forget: async () => {},
    reindex: async () => {},
    rebuildFromFiles: async () => {},
    serializeMemoryIndex: async () => ({ content: '', sha256: '' }),
    integrityCheck: async () => ({ ok: true }) as never,
    ...over,
  }
}

describe('makeMemoryPort', () => {
  it('bridges memory FrozenSnapshot {bytes,sha256} to the loop shape', async () => {
    const port = makeMemoryPort(fakeMemory(), () => '2026-06-16T00:00:00.000Z')
    const snap = await port.snapshot()
    expect(Array.from(snap.prefixBytes)).toEqual(Array.from(Buffer.from('hello')))
    expect(snap.prefixHash).toBe('abc123')
    expect(snap.breakpoints).toEqual([])
    expect(snap.takenAt).toBe('2026-06-16T00:00:00.000Z')
  })

  it('forwards forget with a reason', async () => {
    const seen: unknown[] = []
    const port = makeMemoryPort(
      fakeMemory({ forget: async (id, reason, human) => void seen.push([id, reason, human]) }),
      () => 'now',
    )
    await port.forget('fact-9', true)
    expect(seen[0]).toEqual(['fact-9', 'operator forget', true])
  })
})

describe('makeMemorySearch', () => {
  it('formats ranked hits as text lines', async () => {
    const hits: RankedHit[] = [
      { id: '1', factKey: 'project', text: 'Aisy is OSS', score: 1 },
      { id: '2', factKey: 'pref', text: 'reply in Russian', score: 0.5 },
    ]
    const search = makeMemorySearch(fakeMemory({ search: async () => hits }))
    expect(await search('q')).toBe('• [project] Aisy is OSS\n• [pref] reply in Russian')
  })

  it('reports the empty state', async () => {
    const search = makeMemorySearch(fakeMemory({ search: async () => [] }))
    expect(await search('q')).toBe('Память: ничего не найдено.')
  })

  it('degrades gracefully when the index is cold/unavailable (never throws)', async () => {
    const search = makeMemorySearch(
      fakeMemory({
        search: async () => {
          throw new Error('cold start: no index on disk')
        },
      }),
    )
    await expect(search('q')).resolves.toBe('Память: индекс пуст или недоступен.')
  })
})

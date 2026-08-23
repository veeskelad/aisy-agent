// packages/core-ts/src/runtime/memory-adapter.spec.ts
import { describe, it, expect } from 'vitest'
import { makeMemoryPort, makeMemorySearch, makeMemoryRecall } from './memory-adapter.js'
import { AGENT_PROTOCOL } from './agent-protocol.js'
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
    listLive: async () => [],
    serializeMemoryIndex: async () => ({ content: '', sha256: '' }),
    integrityCheck: async () => ({ ok: true }) as never,
    ...over,
  }
}

describe('makeMemoryPort', () => {
  it('prepends the operating protocol, then the memory files; hashes the full prefix', async () => {
    const port = makeMemoryPort(fakeMemory(), () => '2026-06-16T00:00:00.000Z')
    const snap = await port.snapshot()
    const text = Buffer.from(snap.prefixBytes).toString('utf8')
    expect(text.startsWith(AGENT_PROTOCOL)).toBe(true) // harness protocol first
    expect(text.endsWith('hello')).toBe(true) // then the persona/memory files
    expect(snap.prefixHash).not.toBe('abc123') // hash covers protocol + files, not files alone
    expect(snap.prefixHash).toMatch(/^[0-9a-f]{64}$/)
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

describe('makeMemoryRecall', () => {
  it('formats hits as bullet lines (text only, no factKey)', async () => {
    const hits: RankedHit[] = [
      { id: '1', factKey: 'pref', text: 'Replies in Russian', score: 1 },
      { id: '2', factKey: 'proj', text: 'Aisy is the main project', score: 0.8 },
    ]
    const recall = makeMemoryRecall(fakeMemory({ search: async () => hits }))
    expect(await recall('q')).toBe('• Replies in Russian\n• Aisy is the main project')
  })

  it('returns empty string when there are no hits', async () => {
    const recall = makeMemoryRecall(fakeMemory({ search: async () => [] }))
    expect(await recall('q')).toBe('')
  })

  it('returns empty string on cold start / search error (never throws)', async () => {
    const recall = makeMemoryRecall(
      fakeMemory({
        search: async () => {
          throw new Error('no index')
        },
      }),
    )
    await expect(recall('q')).resolves.toBe('')
  })

  it('respects the limit parameter', async () => {
    const hits: RankedHit[] = [
      { id: '1', factKey: 'a', text: 'one', score: 1 },
      { id: '2', factKey: 'b', text: 'two', score: 0.9 },
    ]
    let capturedLimit: number | undefined
    const recall = makeMemoryRecall(
      fakeMemory({
        search: async (_q, opts) => {
          capturedLimit = opts?.limit
          return hits
        },
      }),
      3,
    )
    await recall('test')
    expect(capturedLimit).toBe(3)
  })
})

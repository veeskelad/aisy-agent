// packages/core-ts/src/runtime/session-log.spec.ts
import { describe, it, expect } from 'vitest'
import { makeJsonlSessionLog } from './session-log.js'

describe('makeJsonlSessionLog', () => {
  it('appends each entry as one JSON line', () => {
    const lines: string[] = []
    const log = makeJsonlSessionLog({ appendLine: (l) => lines.push(l) })
    log.append({ seq: 1, ts: 't', kind: 'turn.start', payloadHash: 'h', payload: { a: 1 } })
    log.append({ seq: 2, ts: 't2', kind: 'turn.end', payloadHash: 'h2', payload: null })
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({ seq: 1, ts: 't', kind: 'turn.start', payloadHash: 'h', payload: { a: 1 } })
    expect(JSON.parse(lines[1]!).kind).toBe('turn.end')
  })

  it('resume returns null (crash-resume deferred)', () => {
    const log = makeJsonlSessionLog({ appendLine: () => {} })
    expect(log.resume('any-session')).toBeNull()
  })

  describe('recent', () => {
    it('returns one row per sessionId, newest-first, with correct turn count and lastAt', () => {
      const stored: string[] = []
      const log = makeJsonlSessionLog({
        appendLine: (l) => stored.push(l),
        readLines: () => stored,
      })

      // Session A: 2 turns
      log.append({ seq: 1, ts: '2024-01-01T10:00:00.000Z', kind: 'turn.start', payloadHash: 'h1', payload: { sessionId: 'sA' } })
      log.append({ seq: 2, ts: '2024-01-01T10:01:00.000Z', kind: 'turn.end', payloadHash: 'h2', payload: { sessionId: 'sA' } })
      // Session B: 1 turn (later)
      log.append({ seq: 3, ts: '2024-01-02T09:00:00.000Z', kind: 'turn.start', payloadHash: 'h3', payload: { sessionId: 'sB' } })

      const result = log.recent!(5)
      expect(result).toHaveLength(2)
      // sB is newer
      expect(result[0]!.sessionId).toBe('sB')
      expect(result[0]!.turns).toBe(1)
      expect(result[0]!.lastAt).toBe('2024-01-02T09:00:00.000Z')
      // sA is older
      expect(result[1]!.sessionId).toBe('sA')
      expect(result[1]!.turns).toBe(2)
      expect(result[1]!.lastAt).toBe('2024-01-01T10:01:00.000Z')
    })

    it('caps the result at n', () => {
      const stored: string[] = []
      const log = makeJsonlSessionLog({
        appendLine: (l) => stored.push(l),
        readLines: () => stored,
      })
      for (let i = 0; i < 5; i++) {
        log.append({ seq: i, ts: `2024-01-0${i + 1}T00:00:00.000Z`, kind: 'turn', payloadHash: 'h', payload: { sessionId: `s${i}` } })
      }
      expect(log.recent!(3)).toHaveLength(3)
    })

    it('returns empty array when no entries', () => {
      const log = makeJsonlSessionLog({
        appendLine: () => {},
        readLines: () => [],
      })
      expect(log.recent!(10)).toEqual([])
    })

    it('returns undefined-safe when readLines not provided', () => {
      const log = makeJsonlSessionLog({ appendLine: () => {} })
      // recent is defined even without readLines, returns empty
      expect(log.recent!(5)).toEqual([])
    })
  })
})

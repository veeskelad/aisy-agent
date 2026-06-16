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
})

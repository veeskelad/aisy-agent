import { describe, expect, it } from 'vitest'
import type {
  FrozenSnapshot,
  TranscriptRecordRequest,
  TranscriptRecorder,
  TranscriptSessionStartRequest,
} from '../agent-loop/types.js'
import { ContextLeaseError, makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeLeaseBoundTranscriptRecorder,
  TranscriptLeaseBindingError,
} from './lease-bound-transcript-recorder.js'

const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('prefix'),
  prefixHash: 'hash',
  breakpoints: [],
  takenAt: '2026-07-27T01:00:00.000Z',
}
const start: TranscriptSessionStartRequest = { sessionId: 'session-a', frozen }
const record: TranscriptRecordRequest = {
  sessionId: 'session-a',
  turnId: 'turn-1',
  turnTs: '2026-07-27T01:01:00.000Z',
  ordinal: 1,
  span: { role: 'user', provenance: 'operator', text: 'hello' },
}

function harness() {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `id-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: '/Users/operator/projects/a',
    generation: 7,
  })
  const binding = {
    operatorId: lease.operatorId,
    profileId: lease.profileId,
    projectId: lease.projectId,
    sessionId: lease.sessionId,
  }
  const calls: string[] = []
  const delegate: TranscriptRecorder = {
    async start() { calls.push('start'); return structuredClone(frozen) },
    async history() {
      calls.push('history')
      return [{ role: 'assistant', provenance: 'untrusted', text: 'prior' }]
    },
    async record() { calls.push('record') },
  }
  const recorder = makeLeaseBoundTranscriptRecorder({ lease, leases, binding, delegate })
  return { binding, calls, delegate, lease, leases, recorder }
}

describe('lease-bound transcript recorder', () => {
  it('runs start, history and append under the exact active lease', async () => {
    const h = harness()
    await expect(h.recorder.start(start)).resolves.toEqual(frozen)
    await expect(h.recorder.history({ sessionId: 'session-a' })).resolves.toEqual([
      { role: 'assistant', provenance: 'untrusted', text: 'prior' },
    ])
    await expect(h.recorder.record(record)).resolves.toBeUndefined()
    expect(h.calls).toEqual(['start', 'history', 'record'])
  })

  it('rejects a mismatched binding before creating a wrapper', () => {
    const h = harness()
    expect(() => makeLeaseBoundTranscriptRecorder({
      lease: h.lease,
      leases: h.leases,
      binding: { ...h.binding, projectId: 'project-b' },
      delegate: h.delegate,
    })).toThrow(TranscriptLeaseBindingError)
  })

  it('rejects a mismatched request session before delegate I/O', async () => {
    const h = harness()

    await expect(h.recorder.history({ sessionId: 'session-b' }))
      .rejects.toBeInstanceOf(TranscriptLeaseBindingError)
    expect(h.calls).toEqual([])
  })

  it('rejects a closed lease before delegate I/O', async () => {
    const h = harness()
    await h.leases.quiesceAndClose(h.lease)

    await expect(h.recorder.history({ sessionId: 'session-a' }))
      .rejects.toEqual(expect.objectContaining<Partial<ContextLeaseError>>({ code: 'STALE_CONTEXT' }))
    expect(h.calls).toEqual([])
  })

  it('lets an in-flight read drain while quiesce waits, then closes the lease', async () => {
    const h = harness()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const delegate: TranscriptRecorder = {
      ...h.delegate,
      async history() {
        h.calls.push('history-started')
        await waiting
        h.calls.push('history-finished')
        return []
      },
    }
    const recorder = makeLeaseBoundTranscriptRecorder({
      lease: h.lease, leases: h.leases, binding: h.binding, delegate,
    })

    const read = recorder.history({ sessionId: 'session-a' })
    expect(h.calls).toEqual(['history-started'])
    const closing = h.leases.quiesceAndClose(h.lease)
    expect(h.leases.status(h.lease)).toBe('cancelling')
    release()
    await read
    await closing
    expect(h.calls).toEqual(['history-started', 'history-finished'])
    expect(h.leases.status(h.lease)).toBe('closed')
  })
})

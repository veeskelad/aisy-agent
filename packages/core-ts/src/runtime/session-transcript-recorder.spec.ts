import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SessionTranscriptError,
  type SessionTranscriptManifestV1,
  type TranscriptAppendInput,
  type TranscriptEnvelope,
} from './session-transcript.js'
import {
  makeSessionTranscriptRecorder,
  SessionTranscriptRecorderError,
  transcriptTurnEventId,
} from './session-transcript-recorder.js'

const binding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}

function recorderHarness() {
  const appends: TranscriptAppendInput[] = []
  const starts: Array<{ binding: typeof binding; frozen: Uint8Array; now: string }> = []
  let manifest: SessionTranscriptManifestV1 | null = null
  const recorder = makeSessionTranscriptRecorder({
    binding,
    historyProjector: { project: async () => [] },
    transcript: {
      async createExactSession(inputBinding, frozen, now) {
        starts.push({ binding: structuredClone(inputBinding), frozen: frozen.prefixBytes.slice(), now })
        manifest = {
          schemaVersion: 1,
          ...inputBinding,
          nextSessionSeq: 1,
          hashHead: '0'.repeat(64),
          frozenPrefix: {
            bytesBase64: Buffer.from(frozen.prefixBytes).toString('base64'),
            prefixHash: createHash('sha256').update(frozen.prefixBytes).digest('hex'),
            breakpoints: [...frozen.breakpoints],
            takenAt: frozen.takenAt,
          },
          resumeCapability: 'exact-v2',
          createdAt: now,
          updatedAt: now,
        }
        return structuredClone(manifest)
      },
      async manifest() {
        if (manifest === null) throw new SessionTranscriptError('not-found', 'not found')
        return structuredClone(manifest)
      },
      async append(input) {
        appends.push(structuredClone(input))
        return { status: 'appended', row: input as TranscriptEnvelope }
      },
    },
  })
  return { appends, recorder, starts }
}

describe('session transcript recorder', () => {
  it('creates the manifest from the exact frozen snapshot and is idempotent at the transcript port', async () => {
    const { recorder, starts } = recorderHarness()
    const prefixBytes = new TextEncoder().encode('actual-prefix')
    const request = {
      sessionId: binding.sessionId,
      frozen: {
        prefixBytes,
        prefixHash: 'caller-hash-is-not-authority',
        breakpoints: [3],
        takenAt: '2026-07-27T01:00:00.000Z',
      },
    }

    const started = await recorder.start(request)
    prefixBytes.fill(0)

    expect(starts).toEqual([{
      binding,
      frozen: new TextEncoder().encode('actual-prefix'),
      now: request.frozen.takenAt,
    }])
    expect(new TextDecoder().decode(started.prefixBytes)).toBe('actual-prefix')

    const resumed = await recorder.start({
      sessionId: binding.sessionId,
      frozen: {
        ...request.frozen,
        prefixBytes: new TextEncoder().encode('changed-memory'),
      },
    })
    expect(new TextDecoder().decode(resumed.prefixBytes)).toBe('actual-prefix')
    expect(starts).toHaveLength(1)
  })

  it('maps a turn span to a deterministic content-independent event id', async () => {
    const { appends, recorder } = recorderHarness()
    const request = {
      sessionId: binding.sessionId,
      turnId: 'telegram-update-7',
      turnTs: '2026-07-27T01:02:03.000Z',
      ordinal: 2,
      span: { role: 'assistant' as const, provenance: 'untrusted' as const, text: 'exact reply' },
    }

    await recorder.record(request)
    await recorder.record(request)

    expect(appends).toHaveLength(2)
    expect(appends[0]).toEqual({
      ...binding,
      eventId: transcriptTurnEventId(binding.sessionId, request.turnId, request.ordinal),
      role: 'assistant',
      provenance: 'untrusted',
      content: 'exact reply',
      ts: request.turnTs,
    })
    expect(appends[1]).toEqual(appends[0])
  })

  it('does not open a metadata-only manifest as an exact session', async () => {
    const legacyHash = createHash('sha256').update('legacy').digest('hex')
    const recorder = makeSessionTranscriptRecorder({
      binding,
      historyProjector: { project: async () => [] },
      transcript: {
        async manifest() {
          return {
            schemaVersion: 1,
            ...binding,
            nextSessionSeq: 1,
            hashHead: '0'.repeat(64),
            frozenPrefix: null,
            resumeCapability: 'metadata-only',
            legacyLogSha256: legacyHash,
            createdAt: '2026-07-27T01:00:00.000Z',
            updatedAt: '2026-07-27T01:00:00.000Z',
          }
        },
        async createExactSession() { throw new Error('must not create') },
        async append() { throw new Error('must not append') },
      },
    })

    await expect(recorder.start({ sessionId: binding.sessionId, frozen: {
      prefixBytes: new TextEncoder().encode('candidate'),
      prefixHash: 'candidate',
      breakpoints: [],
      takenAt: '2026-07-27T01:00:00.000Z',
    } })).rejects.toBeInstanceOf(SessionTranscriptRecorderError)
  })

  it('changes the event id by ordinal without incorporating private content', async () => {
    const { appends, recorder } = recorderHarness()
    const base = {
      sessionId: binding.sessionId,
      turnId: 'turn-1',
      turnTs: '2026-07-27T01:02:03.000Z',
    }
    await recorder.record({
      ...base, ordinal: 1,
      span: { role: 'user', provenance: 'operator', text: 'private-a' },
    })
    await recorder.record({
      ...base, ordinal: 2,
      span: { role: 'user', provenance: 'operator', text: 'private-b' },
    })

    expect(appends[0]!.eventId).not.toBe(appends[1]!.eventId)
    expect(appends[0]!.eventId).not.toContain('private')
  })

  it('rejects a binding mismatch or hidden fields before append', async () => {
    const { appends, recorder } = recorderHarness()
    const valid = {
      sessionId: binding.sessionId,
      turnId: 'turn-1',
      turnTs: '2026-07-27T01:02:03.000Z',
      ordinal: 1,
      span: { role: 'user' as const, provenance: 'operator' as const, text: 'hello' },
    }

    await expect(recorder.record({ ...valid, sessionId: 'session-b' }))
      .rejects.toBeInstanceOf(SessionTranscriptRecorderError)
    await expect(recorder.record({ ...valid, hiddenAuthority: true } as never))
      .rejects.toBeInstanceOf(SessionTranscriptRecorderError)
    expect(appends).toEqual([])
  })
})

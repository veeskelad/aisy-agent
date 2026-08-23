import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { FrozenSnapshot } from '../agent-loop/types.js'
import {
  computeTranscriptRowHash,
  makeSessionTranscript,
  SessionTranscriptError,
  type SessionTranscriptManifestV1,
  type SessionTranscriptPersistencePort,
  type TranscriptBinding,
  type TranscriptCommit,
  type TranscriptEnvelope,
  type TranscriptQuarantineReason,
} from './session-transcript.js'

const binding: TranscriptBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}
const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('constitution\nSOUL'),
  prefixHash: 'caller-value-is-not-authority',
  breakpoints: [12],
  takenAt: '2026-07-27T00:00:00.000Z',
}

function memoryPort() {
  const manifests = new Map<string, SessionTranscriptManifestV1>()
  const rows = new Map<string, TranscriptEnvelope[]>()
  const events = new Map<string, TranscriptEnvelope>()
  const quarantined: Array<{ sessionId: string; reason: TranscriptQuarantineReason }> = []
  const clone = <T>(value: T): T => structuredClone(value)
  const port: SessionTranscriptPersistencePort = {
    async loadManifest(sessionId) { return manifests.has(sessionId) ? clone(manifests.get(sessionId)!) : null },
    async listRows(sessionId) { return clone(rows.get(sessionId) ?? []) },
    async findEvent(eventId) { return events.has(eventId) ? clone(events.get(eventId)!) : null },
    async createManifest(manifest) {
      if (manifests.has(manifest.sessionId)) throw new Error('exists')
      manifests.set(manifest.sessionId, clone(manifest))
      rows.set(manifest.sessionId, [])
    },
    async commit(input: TranscriptCommit) {
      const current = manifests.get(input.row.sessionId)
      if (!current || current.nextSessionSeq !== input.expectedNextSessionSeq ||
        current.hashHead !== input.expectedHashHead || events.has(input.row.eventId)) throw new Error('CAS')
      rows.get(input.row.sessionId)!.push(clone(input.row))
      events.set(input.row.eventId, clone(input.row))
      manifests.set(input.row.sessionId, clone(input.nextManifest))
    },
    async quarantine(sessionId, reason) { quarantined.push({ sessionId, reason }) },
  }
  return { port, manifests, rows, events, quarantined }
}

function service(state = memoryPort()) {
  return {
    ...state,
    transcript: makeSessionTranscript({
      persistence: state.port,
      classifyLoadBearing: (input) => ({
        loadBearing: /TODO|decision/i.test(input.content),
        classifierVersion: 'rules-v1',
      }),
    }),
  }
}

describe('session transcript v2', () => {
  it('creates an exact manifest with a code-computed frozen-prefix hash', async () => {
    const state = service()
    const manifest = await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    expect(manifest.resumeCapability).toBe('exact-v2')
    expect(manifest.nextSessionSeq).toBe(1)
    expect(manifest.hashHead).toBe('0'.repeat(64))
    expect(manifest.frozenPrefix?.prefixHash)
      .toBe(createHash('sha256').update(frozen.prefixBytes).digest('hex'))
    expect(manifest.frozenPrefix?.prefixHash).not.toBe(frozen.prefixHash)
  })

  it('appends full-fidelity rows with durable sequence, code-owned classification and a valid chain', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    const first = await state.transcript.append({
      ...binding, eventId: 'event-1', role: 'user', provenance: 'operator',
      content: 'TODO: preserve exact dialogue', ts: '2026-07-27T00:00:01.000Z',
    })
    const second = await state.transcript.append({
      ...binding, eventId: 'event-2', role: 'assistant', provenance: 'operator',
      content: 'Acknowledged', ts: '2026-07-27T00:00:02.000Z',
    })
    expect(first.row).toMatchObject({
      sessionSeq: 1, loadBearing: true, loadBearingClassifierVersion: 'rules-v1',
      prevSessionHash: '0'.repeat(64),
    })
    expect(second.row).toMatchObject({
      sessionSeq: 2, loadBearing: false, prevSessionHash: first.row.rowHash,
    })
    expect(computeTranscriptRowHash(first.row)).toBe(first.row.rowHash)
    expect((await state.transcript.manifest(binding)).hashHead).toBe(second.row.rowHash)
    expect(await state.transcript.read(binding)).toHaveLength(2)
  })

  it('survives a turn stamped before the session existed', async () => {
    // The operator's message is stamped when they sent it; the session is
    // created after that. Writing that earlier time as `updatedAt` would make
    // the manifest fail its own validity check on the very next load.
    const state = service()
    const created = await state.transcript.createExactSession(binding, frozen, '2026-07-27T00:00:10.000Z')
    await state.transcript.append({
      ...binding, eventId: 'event-early', role: 'user', provenance: 'operator',
      content: 'sent two seconds ago', ts: '2026-07-27T00:00:08.000Z',
    })

    const manifest = await state.transcript.manifest(binding)
    expect(Date.parse(manifest.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.createdAt))
    // And the row still carries the turn's own time — only the manifest clamps.
    expect((await state.transcript.read(binding))[0]?.ts).toBe('2026-07-27T00:00:08.000Z')
  })

  it('never walks its updated time backwards between appends', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, '2026-07-27T00:00:00.000Z')
    await state.transcript.append({
      ...binding, eventId: 'event-late', role: 'user', provenance: 'operator',
      content: 'later', ts: '2026-07-27T00:00:20.000Z',
    })
    await state.transcript.append({
      ...binding, eventId: 'event-earlier', role: 'user', provenance: 'operator',
      content: 'earlier', ts: '2026-07-27T00:00:05.000Z',
    })

    expect((await state.transcript.manifest(binding)).updatedAt).toBe('2026-07-27T00:00:20.000Z')
  })

  it('is idempotent by eventId but quarantines conflicting reuse', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    const input = {
      ...binding, eventId: 'event-idempotent', role: 'user' as const,
      provenance: 'operator' as const, content: 'same', ts: '2026-07-27T00:00:01.000Z',
    }
    expect((await state.transcript.append(input)).status).toBe('appended')
    expect((await state.transcript.append(input)).status).toBe('duplicate')
    await expect(state.transcript.append({ ...input, content: 'different' }))
      .rejects.toMatchObject({ code: 'event-id-conflict' })
    expect(state.quarantined).toContainEqual({ sessionId: binding.sessionId, reason: 'event-id-conflict' })
  })

  it('verifies the chain before returning an idempotent duplicate', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    const input = {
      ...binding, eventId: 'event-retry', role: 'user' as const,
      provenance: 'operator' as const, content: 'same', ts: '2026-07-27T00:00:01.000Z',
    }
    await state.transcript.append(input)
    state.rows.get(binding.sessionId)![0]!.content = 'tampered'
    await expect(state.transcript.append(input)).rejects.toMatchObject({ code: 'hash-chain-mismatch' })
  })

  it('serializes concurrent appends to one monotonic per-session chain', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => state.transcript.append({
      ...binding,
      eventId: `event-${index}`,
      role: 'tool',
      provenance: 'untrusted',
      content: `result ${index}`,
      ts: `2026-07-27T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
    })))
    expect(results.map(item => item.row.sessionSeq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect((await state.transcript.read(binding)).map(row => row.sessionSeq))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
  })

  it.each([
    ['sequence-gap', (row: TranscriptEnvelope) => { row.sessionSeq = 7 }],
    ['hash-chain-mismatch', (row: TranscriptEnvelope) => { row.content = 'tampered' }],
    ['invalid-row', (row: TranscriptEnvelope) => { Object.assign(row, { hiddenAuthority: true }) }],
  ] as const)('quarantines %s during exact read', async (reason, mutate) => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    await state.transcript.append({
      ...binding, eventId: 'event-1', role: 'user', provenance: 'operator',
      content: 'original', ts: '2026-07-27T00:00:01.000Z',
    })
    mutate(state.rows.get(binding.sessionId)![0]!)
    await expect(state.transcript.read(binding)).rejects.toMatchObject({ code: reason })
    expect(state.quarantined).toContainEqual({ sessionId: binding.sessionId, reason })
  })

  it('quarantines binding and manifest-head mismatches before resume', async () => {
    const state = service()
    await state.transcript.createExactSession(binding, frozen, frozen.takenAt)
    await expect(state.transcript.manifest({ ...binding, projectId: 'project-b' }))
      .rejects.toMatchObject({ code: 'binding-mismatch' })

    state.manifests.get(binding.sessionId)!.nextSessionSeq = 2
    await expect(state.transcript.read(binding)).rejects.toMatchObject({ code: 'manifest-head-mismatch' })
  })

  it('keeps legacy sessions metadata-only and creates an explicit v2 migration boundary', async () => {
    const state = service()
    const legacyHash = createHash('sha256').update('legacy bytes').digest('hex')
    await state.transcript.registerLegacyMetadata(binding, legacyHash, frozen.takenAt)
    expect(await state.transcript.read(binding)).toEqual([])
    await expect(state.transcript.append({
      ...binding, eventId: 'legacy-write', role: 'user', provenance: 'operator',
      content: 'must not fabricate', ts: '2026-07-27T00:00:01.000Z',
    })).rejects.toBeInstanceOf(SessionTranscriptError)

    const next = { ...binding, sessionId: 'session-v2' }
    const nextManifest = await state.transcript.continueLegacy({
      legacy: binding,
      next,
      legacyLogSha256: legacyHash,
      frozen,
      eventId: 'migration-boundary-1',
      ts: '2026-07-27T00:01:00.000Z',
    })
    expect(nextManifest).toMatchObject({
      resumeCapability: 'exact-v2', nextSessionSeq: 2,
      migrationBoundaryFrom: { sessionId: binding.sessionId, legacyLogSha256: legacyHash },
    })
    const rows = await state.transcript.read(next)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'system', loadBearing: true, loadBearingClassifierVersion: 'migration-boundary-v1' })
    expect(rows[0]!.content).toContain('MIGRATION_BOUNDARY')

    const retried = await state.transcript.continueLegacy({
      legacy: binding,
      next,
      legacyLogSha256: legacyHash,
      frozen,
      eventId: 'migration-boundary-1',
      ts: '2026-07-27T00:01:00.000Z',
    })
    expect(retried.nextSessionSeq).toBe(2)
    expect(await state.transcript.read(next)).toHaveLength(1)
  })

  it('quarantines rows hidden behind a metadata-only manifest', async () => {
    const state = service()
    const legacyHash = createHash('sha256').update('legacy bytes').digest('hex')
    await state.transcript.registerLegacyMetadata(binding, legacyHash, frozen.takenAt)
    state.rows.get(binding.sessionId)!.push({} as TranscriptEnvelope)
    await expect(state.transcript.read(binding)).rejects.toMatchObject({ code: 'invalid-row' })
  })

  it('rejects an oversized append before classification or persistence', async () => {
    const state = memoryPort()
    let classified = 0
    const transcript = makeSessionTranscript({
      persistence: state.port,
      classifyLoadBearing: () => { classified += 1; return { loadBearing: false, classifierVersion: 'v1' } },
    })
    await transcript.createExactSession(binding, frozen, frozen.takenAt)
    await expect(transcript.append({
      ...binding, eventId: 'huge', role: 'user', provenance: 'operator',
      content: 'x'.repeat(1024 * 1024 + 1), ts: '2026-07-27T00:00:01.000Z',
    })).rejects.toMatchObject({ code: 'invalid-input' })
    expect(classified).toBe(0)
    expect(state.rows.get(binding.sessionId)).toEqual([])
  })

  it('rejects caller-supplied authority fields outside the hash contract', async () => {
    const state = memoryPort()
    let classified = 0
    const transcript = makeSessionTranscript({
      persistence: state.port,
      classifyLoadBearing: () => { classified += 1; return { loadBearing: false, classifierVersion: 'v1' } },
    })
    await transcript.createExactSession(binding, frozen, frozen.takenAt)
    const injected = {
      ...binding, eventId: 'injected', role: 'user', provenance: 'operator',
      content: 'ordinary', ts: '2026-07-27T00:00:01.000Z',
      loadBearing: true,
    }
    await expect(transcript.append(injected as never)).rejects.toMatchObject({ code: 'invalid-input' })
    expect(classified).toBe(0)
    expect(state.rows.get(binding.sessionId)).toEqual([])
  })
})

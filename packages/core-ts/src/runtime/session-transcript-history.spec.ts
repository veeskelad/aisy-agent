import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  SessionTranscriptManifestV1,
  TranscriptBinding,
  TranscriptEnvelope,
} from './session-transcript.js'
import {
  makeSessionTranscriptHistoryProjector,
  SessionTranscriptHistoryError,
} from './session-transcript-history.js'

const binding: TranscriptBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
}
const prefix = new TextEncoder().encode('PINNED')
const manifest: SessionTranscriptManifestV1 = {
  schemaVersion: 1,
  ...binding,
  nextSessionSeq: 1,
  hashHead: '0'.repeat(64),
  frozenPrefix: {
    bytesBase64: Buffer.from(prefix).toString('base64'),
    prefixHash: createHash('sha256').update(prefix).digest('hex'),
    breakpoints: [0],
    takenAt: '2026-07-27T01:00:00.000Z',
  },
  resumeCapability: 'exact-v2',
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T01:00:00.000Z',
}

function row(
  sessionSeq: number,
  role: TranscriptEnvelope['role'],
  provenance: TranscriptEnvelope['provenance'],
  content: string,
  loadBearing = false,
): TranscriptEnvelope {
  return {
    ...binding,
    eventId: `event-${sessionSeq}`,
    sessionSeq,
    role,
    provenance,
    content,
    ts: `2026-07-27T01:00:0${sessionSeq}.000Z`,
    loadBearing,
    loadBearingClassifierVersion: 'rules-v1',
    prevSessionHash: '0'.repeat(64),
    rowHash: String(sessionSeq).padStart(64, '0'),
  }
}

function projector(rows: TranscriptEnvelope[], budget = { windowTokens: 1000, compactAtFraction: 0.8 }) {
  return makeSessionTranscriptHistoryProjector({
    transcript: {
      manifest: async () => structuredClone(manifest),
      read: async () => structuredClone(rows),
    },
    budget,
    summarize: async entries => `summary:${entries.map(entry => entry.seq).join(',')}`,
    estimateTokens: text => text.length,
  })
}

describe('session transcript history projector', () => {
  it('preserves verbatim role/order/provenance and excludes the pinned prefix span', async () => {
    const history = await projector([
      row(1, 'user', 'operator', 'question'),
      row(2, 'assistant', 'untrusted', 'answer'),
      row(3, 'tool', 'untrusted', 'read_file: output'),
    ]).project(binding)

    expect(history).toEqual([
      { role: 'user', provenance: 'operator', text: 'question' },
      { role: 'assistant', provenance: 'untrusted', text: 'answer' },
      { role: 'tool', provenance: 'untrusted', text: 'read_file: output' },
    ])
    expect(history.some(span => span.text === 'PINNED')).toBe(false)
  })

  it('projects compaction as a system span, keeps strict provenance and preserves load-bearing rows', async () => {
    const history = await projector([
      row(1, 'user', 'operator', 'old-question-xxxxxxxx'),
      row(2, 'tool', 'untrusted', 'external-output-xxxxxxxx'),
      row(3, 'system', 'operator', 'KEEP_DECISION', true),
      row(4, 'assistant', 'untrusted', 'recent-answer-xxxxxxxx'),
    ], { windowTokens: 45, compactAtFraction: 0.5 }).project(binding)

    expect(history.some(span =>
      span.role === 'user' && span.provenance === 'untrusted' && span.text.startsWith('summary:')))
      .toBe(true)
    expect(history).toContainEqual({ role: 'system', provenance: 'operator', text: 'KEEP_DECISION' })
  })

  it('rejects metadata-only history before reading rows', async () => {
    let read = false
    const history = makeSessionTranscriptHistoryProjector({
      transcript: {
        manifest: async () => ({
          ...manifest,
          frozenPrefix: null,
          resumeCapability: 'metadata-only',
          legacyLogSha256: 'a'.repeat(64),
        }),
        read: async () => { read = true; return [] },
      },
      budget: { windowTokens: 100, compactAtFraction: 0.8 },
      summarize: async () => '',
      estimateTokens: text => text.length,
    })

    await expect(history.project(binding)).rejects.toBeInstanceOf(SessionTranscriptHistoryError)
    expect(read).toBe(false)
  })
})

import { createHash } from 'node:crypto'
import type {
  FrozenSnapshot,
  TranscriptHistoryRequest,
  TranscriptRecordRequest,
  TranscriptRecorder,
  TranscriptSessionStartRequest,
} from '../agent-loop/types.js'
import type { SessionTranscriptHistoryProjector } from './session-transcript-history.js'
import {
  SessionTranscriptError,
  type SessionTranscript,
  type SessionTranscriptManifestV1,
  type TranscriptBinding,
} from './session-transcript.js'

const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const REQUEST_KEYS = new Set(['sessionId', 'turnId', 'turnTs', 'ordinal', 'span'])
const SPAN_KEYS = new Set(['role', 'provenance', 'text'])
const START_KEYS = new Set(['sessionId', 'frozen'])
const FROZEN_KEYS = new Set(['prefixBytes', 'prefixHash', 'breakpoints', 'takenAt'])
const HISTORY_KEYS = new Set(['sessionId'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length === keys.size && Object.keys(value).every(key => keys.has(key))
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

export class SessionTranscriptRecorderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTranscriptRecorderError'
  }
}

export function transcriptTurnEventId(sessionId: string, turnId: string, ordinal: number): string {
  return createHash('sha256')
    .update(JSON.stringify(['aisy.turn-event.v1', sessionId, turnId, ordinal]), 'utf8')
    .digest('hex')
}

export function makeSessionTranscriptRecorder(deps: {
  transcript: Pick<SessionTranscript, 'append' | 'createExactSession' | 'manifest'>
  historyProjector: SessionTranscriptHistoryProjector
  binding: TranscriptBinding
}): TranscriptRecorder {
  const binding = { ...deps.binding }

  const authoritativeSnapshot = (manifest: SessionTranscriptManifestV1): FrozenSnapshot => {
    if (manifest.resumeCapability !== 'exact-v2' || manifest.frozenPrefix === null) {
      throw new SessionTranscriptRecorderError('session does not have exact-v2 resume authority')
    }
    return {
      prefixBytes: new Uint8Array(Buffer.from(manifest.frozenPrefix.bytesBase64, 'base64')),
      prefixHash: manifest.frozenPrefix.prefixHash,
      breakpoints: [...manifest.frozenPrefix.breakpoints],
      takenAt: manifest.frozenPrefix.takenAt,
    }
  }

  return {
    async start(input: TranscriptSessionStartRequest): Promise<FrozenSnapshot> {
      if (!record(input) || !hasExactKeys(input, START_KEYS) ||
        input.sessionId !== binding.sessionId || !record(input.frozen) ||
        !hasExactKeys(input.frozen, FROZEN_KEYS) ||
        !(input.frozen.prefixBytes instanceof Uint8Array) ||
        typeof input.frozen.prefixHash !== 'string' ||
        !Array.isArray(input.frozen.breakpoints) ||
        typeof input.frozen.takenAt !== 'string') {
        throw new SessionTranscriptRecorderError('invalid or mismatched transcript session start')
      }
      const candidate: FrozenSnapshot = {
        prefixBytes: input.frozen.prefixBytes.slice(),
        prefixHash: input.frozen.prefixHash,
        breakpoints: [...input.frozen.breakpoints],
        takenAt: input.frozen.takenAt,
      }
      try {
        return authoritativeSnapshot(await deps.transcript.manifest(binding))
      } catch (error) {
        if (!(error instanceof SessionTranscriptError) || error.code !== 'not-found') throw error
      }
      try {
        return authoritativeSnapshot(
          await deps.transcript.createExactSession(binding, candidate, candidate.takenAt),
        )
      } catch (createError) {
        // A concurrent opener may have published the manifest after our
        // not-found read. Its exact-v2 snapshot is now the session authority.
        try {
          return authoritativeSnapshot(await deps.transcript.manifest(binding))
        } catch {
          throw createError
        }
      }
    },
    async record(input: TranscriptRecordRequest): Promise<void> {
      if (!record(input) || !hasExactKeys(input, REQUEST_KEYS) || !record(input.span) ||
        !hasExactKeys(input.span, SPAN_KEYS) || input.sessionId !== binding.sessionId ||
        !TURN_ID.test(input.turnId) || !validIso(input.turnTs) ||
        !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 ||
        !['system', 'user', 'assistant', 'tool'].includes(input.span.role) ||
        (input.span.provenance !== 'operator' && input.span.provenance !== 'untrusted') ||
        typeof input.span.text !== 'string') {
        throw new SessionTranscriptRecorderError('invalid or mismatched transcript record request')
      }

      await deps.transcript.append({
        ...binding,
        eventId: transcriptTurnEventId(input.sessionId, input.turnId, input.ordinal),
        role: input.span.role,
        provenance: input.span.provenance,
        content: input.span.text,
        ts: input.turnTs,
      })
    },
    async history(input: TranscriptHistoryRequest) {
      if (!record(input) || !hasExactKeys(input, HISTORY_KEYS) ||
        input.sessionId !== binding.sessionId) {
        throw new SessionTranscriptRecorderError('invalid or mismatched transcript history request')
      }
      return deps.historyProjector.project(binding)
    },
  }
}

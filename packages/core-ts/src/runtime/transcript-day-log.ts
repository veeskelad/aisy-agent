import type { NormalizedDayLog, NormalizedDayLogRecord } from '../nightly/types.js'
import {
  computeTranscriptRowHash,
  type TranscriptBinding,
  type TranscriptEnvelope,
} from './session-transcript.js'

export type TranscriptDayLogErrorCode =
  | 'INVALID_DATE'
  | 'BINDING_MISMATCH'
  | 'SEQUENCE_INVALID'
  | 'HASH_CHAIN_INVALID'
  | 'DUPLICATE_EVENT'
  | 'LIMIT_EXCEEDED'

export class TranscriptDayLogError extends Error {
  constructor(readonly code: TranscriptDayLogErrorCode) {
    super(`transcript day log rejected: ${code}`)
    this.name = 'TranscriptDayLogError'
  }
}

const ZERO_HASH = '0'.repeat(64)
const DEFAULT_MAX_RECORDS = 50_000
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const MAX_CONFIGURED_RECORDS = 1_000_000
const MAX_CONFIGURED_BYTES = 256 * 1024 * 1024

function sameBinding(left: TranscriptBinding, right: TranscriptBinding): boolean {
  return left.operatorId === right.operatorId && left.profileId === right.profileId &&
    left.projectId === right.projectId && left.sessionId === right.sessionId
}

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date
}

function positiveLimit(value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new TranscriptDayLogError('LIMIT_EXCEEDED')
  }
  return resolved
}

function utcDate(ts: string): string {
  const parsed = new Date(ts)
  if (!Number.isFinite(parsed.valueOf())) throw new TranscriptDayLogError('SEQUENCE_INVALID')
  return parsed.toISOString().slice(0, 10)
}

/**
 * Projects one hash-chain-verified exact Session into a bounded nightly input.
 * System rows are intentionally excluded: they contain DNA, skill bodies, and
 * code-owned action contracts rather than operator memories. Free-form tool
 * output is never parsed into a synthetic tool-call or decision-journal row.
 */
export function projectSessionTranscriptDayLog(input: {
  binding: TranscriptBinding
  date: string
  rows: readonly TranscriptEnvelope[]
  maxRecords?: number
  maxBytes?: number
}): NormalizedDayLog {
  if (!validDate(input.date)) throw new TranscriptDayLogError('INVALID_DATE')
  const maxRecords = positiveLimit(input.maxRecords, DEFAULT_MAX_RECORDS, MAX_CONFIGURED_RECORDS)
  const maxBytes = positiveLimit(input.maxBytes, DEFAULT_MAX_BYTES, MAX_CONFIGURED_BYTES)
  const seen = new Set<string>()
  let previousHash = ZERO_HASH
  const projected: Array<{ sessionSeq: number; record: NormalizedDayLogRecord }> = []

  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index]!
    if (!sameBinding(row, input.binding)) throw new TranscriptDayLogError('BINDING_MISMATCH')
    if (row.sessionSeq !== index + 1) throw new TranscriptDayLogError('SEQUENCE_INVALID')
    if (seen.has(row.eventId)) throw new TranscriptDayLogError('DUPLICATE_EVENT')
    seen.add(row.eventId)
    if (row.prevSessionHash !== previousHash || computeTranscriptRowHash(row) !== row.rowHash) {
      throw new TranscriptDayLogError('HASH_CHAIN_INVALID')
    }
    previousHash = row.rowHash
    if (utcDate(row.ts) !== input.date || row.role === 'system') continue

    const payload = row.role === 'tool'
      ? { provenance: row.provenance, content: row.content }
      : { role: row.role, provenance: row.provenance, content: row.content }
    projected.push({
      sessionSeq: row.sessionSeq,
      record: {
        kind: row.role === 'tool' ? 'tool-result' : 'utterance',
        ts: row.ts,
        payload,
      },
    })
  }

  projected.sort((left, right) =>
    left.record.ts.localeCompare(right.record.ts) || left.sessionSeq - right.sessionSeq)
  if (projected.length > maxRecords) throw new TranscriptDayLogError('LIMIT_EXCEEDED')
  const records = projected.map(item => item.record)
  if (Buffer.byteLength(JSON.stringify(records), 'utf8') > maxBytes) {
    throw new TranscriptDayLogError('LIMIT_EXCEEDED')
  }
  return { date: input.date, records }
}

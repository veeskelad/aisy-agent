import { createHash } from 'node:crypto'
import type { FrozenSnapshot, Provenance } from '../agent-loop/types.js'

export interface TranscriptBinding {
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
}

export interface TranscriptAppendInput extends TranscriptBinding {
  eventId: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  provenance: Provenance
  content: string
  ts: string
}

export interface TranscriptEnvelope extends TranscriptAppendInput {
  sessionSeq: number
  loadBearing: boolean
  loadBearingClassifierVersion: string
  prevSessionHash: string
  rowHash: string
}

export interface FrozenPrefixRecord {
  bytesBase64: string
  prefixHash: string
  breakpoints: number[]
  takenAt: string
}

export interface SessionTranscriptManifestV1 extends TranscriptBinding {
  schemaVersion: 1
  nextSessionSeq: number
  hashHead: string
  frozenPrefix: FrozenPrefixRecord | null
  resumeCapability: 'exact-v2' | 'metadata-only'
  legacyLogSha256?: string
  migrationBoundaryFrom?: { sessionId: string; legacyLogSha256: string }
  createdAt: string
  updatedAt: string
}

export type TranscriptQuarantineReason =
  | 'invalid-manifest'
  | 'binding-mismatch'
  | 'invalid-row'
  | 'sequence-gap'
  | 'hash-chain-mismatch'
  | 'manifest-head-mismatch'
  | 'event-id-conflict'
  | 'commit-conflict'

export interface TranscriptCommit {
  expectedNextSessionSeq: number
  expectedHashHead: string
  row: TranscriptEnvelope
  nextManifest: SessionTranscriptManifestV1
}

export interface SessionTranscriptPersistencePort {
  loadManifest(sessionId: string): Promise<unknown | null>
  listRows(sessionId: string): Promise<unknown[]>
  findEvent(eventId: string): Promise<unknown | null>
  createManifest(manifest: SessionTranscriptManifestV1): Promise<void>
  commit(input: TranscriptCommit): Promise<void>
  quarantine(sessionId: string, reason: TranscriptQuarantineReason): Promise<void>
}

export interface LoadBearingDecision {
  loadBearing: boolean
  classifierVersion: string
}

export interface SessionTranscript {
  createExactSession(binding: TranscriptBinding, frozen: FrozenSnapshot, now: string): Promise<SessionTranscriptManifestV1>
  registerLegacyMetadata(binding: TranscriptBinding, legacyLogSha256: string, now: string): Promise<SessionTranscriptManifestV1>
  continueLegacy(input: {
    legacy: TranscriptBinding
    next: TranscriptBinding
    legacyLogSha256: string
    frozen: FrozenSnapshot
    eventId: string
    ts: string
  }): Promise<SessionTranscriptManifestV1>
  append(input: TranscriptAppendInput): Promise<{ status: 'appended' | 'duplicate'; row: TranscriptEnvelope }>
  read(binding: TranscriptBinding): Promise<TranscriptEnvelope[]>
  manifest(binding: TranscriptBinding): Promise<SessionTranscriptManifestV1>
}

export class SessionTranscriptError extends Error {
  constructor(
    readonly code: TranscriptQuarantineReason | 'not-found' | 'metadata-only' | 'invalid-input',
    message: string,
  ) {
    super(message)
    this.name = 'SessionTranscriptError'
  }
}

export class TranscriptCommitUncertainError extends Error {
  constructor(message = 'session transcript commit outcome is uncertain; retry recovery') {
    super(message)
    this.name = 'TranscriptCommitUncertainError'
  }
}

const ZERO_HASH = '0'.repeat(64)
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const CLASSIFIER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_CONTENT_BYTES = 1024 * 1024
const MAX_PREFIX_BYTES = 4 * 1024 * 1024
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'operatorId', 'profileId', 'projectId', 'sessionId',
  'nextSessionSeq', 'hashHead', 'frozenPrefix', 'resumeCapability',
  'legacyLogSha256', 'migrationBoundaryFrom', 'createdAt', 'updatedAt',
])
const APPEND_KEYS = new Set([
  'eventId', 'operatorId', 'profileId', 'projectId', 'sessionId',
  'role', 'provenance', 'content', 'ts',
])
const ROW_KEYS = new Set([
  ...APPEND_KEYS,
  'sessionSeq', 'loadBearing', 'loadBearingClassifierVersion',
  'prevSessionHash', 'rowHash',
])
const PREFIX_KEYS = new Set(['bytesBase64', 'prefixHash', 'breakpoints', 'takenAt'])
const BOUNDARY_KEYS = new Set(['sessionId', 'legacyLogSha256'])

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function validBinding(value: TranscriptBinding): boolean {
  return [value.operatorId, value.profileId, value.projectId, value.sessionId]
    .every(part => typeof part === 'string' && ID.test(part))
}

function sameBinding(a: TranscriptBinding, b: TranscriptBinding): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId
}

function rowHashInput(row: Omit<TranscriptEnvelope, 'rowHash'>): string {
  return JSON.stringify([
    'aisy.transcript.v1', row.eventId, row.operatorId, row.profileId,
    row.projectId, row.sessionId, row.sessionSeq, row.role, row.provenance,
    row.content, row.ts, row.loadBearing, row.loadBearingClassifierVersion,
    row.prevSessionHash,
  ])
}

export function computeTranscriptRowHash(row: Omit<TranscriptEnvelope, 'rowHash'>): string {
  return createHash('sha256').update(rowHashInput(row), 'utf8').digest('hex')
}

function prefixRecord(frozen: FrozenSnapshot): FrozenPrefixRecord {
  if (!validIso(frozen.takenAt) || frozen.prefixBytes.byteLength > MAX_PREFIX_BYTES ||
    frozen.breakpoints.length > 4 ||
    frozen.breakpoints.some((point, index) => !Number.isInteger(point) || point < 0 ||
      point > frozen.prefixBytes.byteLength || (index > 0 && point <= frozen.breakpoints[index - 1]!))) {
    throw new SessionTranscriptError('invalid-input', 'invalid frozen prefix metadata')
  }
  return {
    bytesBase64: Buffer.from(frozen.prefixBytes).toString('base64'),
    prefixHash: createHash('sha256').update(frozen.prefixBytes).digest('hex'),
    breakpoints: [...frozen.breakpoints],
    takenAt: frozen.takenAt,
  }
}

function validManifest(value: unknown): value is SessionTranscriptManifestV1 {
  if (!record(value)) return false
  const item = value as unknown as SessionTranscriptManifestV1
  if (!exactKeys(value, MANIFEST_KEYS) ||
    item.schemaVersion !== 1 || !validBinding(item) ||
    !Number.isSafeInteger(item.nextSessionSeq) || item.nextSessionSeq < 1 ||
    !HASH.test(item.hashHead) || !validIso(item.createdAt) || !validIso(item.updatedAt) ||
    Date.parse(item.updatedAt) < Date.parse(item.createdAt) ||
    (item.resumeCapability !== 'exact-v2' && item.resumeCapability !== 'metadata-only')) return false
  if (item.resumeCapability === 'metadata-only') {
    return item.frozenPrefix === null && typeof item.legacyLogSha256 === 'string' &&
      HASH.test(item.legacyLogSha256) && item.migrationBoundaryFrom === undefined
  }
  if (item.frozenPrefix === null || !record(item.frozenPrefix) ||
    !exactKeys(item.frozenPrefix, PREFIX_KEYS) || !HASH.test(item.frozenPrefix.prefixHash) ||
    !validIso(item.frozenPrefix.takenAt) || !Array.isArray(item.frozenPrefix.breakpoints) ||
    typeof item.frozenPrefix.bytesBase64 !== 'string' ||
    item.frozenPrefix.bytesBase64.length > Math.ceil(MAX_PREFIX_BYTES / 3) * 4 + 4 ||
    item.legacyLogSha256 !== undefined) return false
  try {
    const bytes = Buffer.from(item.frozenPrefix.bytesBase64, 'base64')
    if (bytes.byteLength > MAX_PREFIX_BYTES || bytes.toString('base64') !== item.frozenPrefix.bytesBase64 ||
      createHash('sha256').update(bytes).digest('hex') !== item.frozenPrefix.prefixHash) return false
    if (item.frozenPrefix.breakpoints.length > 4 || item.frozenPrefix.breakpoints.some((point, index) =>
      !Number.isInteger(point) || point < 0 || point > bytes.byteLength ||
      (index > 0 && point <= item.frozenPrefix!.breakpoints[index - 1]!))) return false
  } catch {
    return false
  }
  return item.migrationBoundaryFrom === undefined ||
    (record(item.migrationBoundaryFrom) && exactKeys(item.migrationBoundaryFrom, BOUNDARY_KEYS) &&
      ID.test(item.migrationBoundaryFrom.sessionId) && HASH.test(item.migrationBoundaryFrom.legacyLogSha256))
}

function validRow(value: unknown): value is TranscriptEnvelope {
  if (!record(value) || !exactKeys(value, ROW_KEYS)) return false
  const row = value as unknown as TranscriptEnvelope
  return validBinding(row) && ID.test(row.eventId) &&
    Number.isSafeInteger(row.sessionSeq) && row.sessionSeq >= 1 &&
    ['system', 'user', 'assistant', 'tool'].includes(row.role) &&
    (row.provenance === 'operator' || row.provenance === 'untrusted') &&
    typeof row.content === 'string' && Buffer.byteLength(row.content, 'utf8') <= MAX_CONTENT_BYTES &&
    validIso(row.ts) && typeof row.loadBearing === 'boolean' &&
    CLASSIFIER_VERSION.test(row.loadBearingClassifierVersion) &&
    HASH.test(row.prevSessionHash) && HASH.test(row.rowHash)
}

function sameAppend(row: TranscriptEnvelope, input: TranscriptAppendInput): boolean {
  return sameBinding(row, input) && row.eventId === input.eventId && row.role === input.role &&
    row.provenance === input.provenance && row.content === input.content && row.ts === input.ts
}

function sameCreation(a: SessionTranscriptManifestV1, b: SessionTranscriptManifestV1): boolean {
  return sameBinding(a, b) && a.resumeCapability === b.resumeCapability &&
    JSON.stringify(a.frozenPrefix) === JSON.stringify(b.frozenPrefix) &&
    a.legacyLogSha256 === b.legacyLogSha256 &&
    JSON.stringify(a.migrationBoundaryFrom) === JSON.stringify(b.migrationBoundaryFrom) &&
    a.createdAt === b.createdAt
}

/**
 * When the manifest says it was last written.
 *
 * The row keeps the turn's own time; the manifest keeps this. They differ: a
 * turn is stamped when the operator sent the message, and the session is
 * created after that — so copying the turn time straight across can leave a
 * manifest "updated" before it was "created", the exact shape `validManifest`
 * refuses to load. It also must never walk backwards between appends.
 *
 * Both the service and the durable store compute the next manifest, and they
 * compare the results byte for byte. That makes this one function the rule,
 * not a convention either side is free to re-derive.
 */
export function transcriptUpdatedAt(
  manifest: Pick<SessionTranscriptManifestV1, 'createdAt' | 'updatedAt'>,
  rowTs: string,
): string {
  return [manifest.createdAt, manifest.updatedAt, rowTs]
    .reduce((latest, candidate) => Date.parse(candidate) > Date.parse(latest) ? candidate : latest)
}

export function makeSessionTranscript(deps: {
  persistence: SessionTranscriptPersistencePort
  classifyLoadBearing(input: TranscriptAppendInput): LoadBearingDecision | Promise<LoadBearingDecision>
}): SessionTranscript {
  const queues = new Map<string, Promise<void>>()
  const serialize = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(() => {}, () => {})
    queues.set(sessionId, tail)
    return result.finally(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId) })
  }
  const quarantine = async (sessionId: string, reason: TranscriptQuarantineReason): Promise<never> => {
    try { await deps.persistence.quarantine(sessionId, reason) } catch { /* original failure stays authoritative */ }
    throw new SessionTranscriptError(reason, `session transcript rejected: ${reason}`)
  }

  const loadManifest = async (binding: TranscriptBinding): Promise<SessionTranscriptManifestV1> => {
    const raw = await deps.persistence.loadManifest(binding.sessionId)
    if (raw === null) throw new SessionTranscriptError('not-found', 'session transcript manifest not found')
    if (!validManifest(raw)) return quarantine(binding.sessionId, 'invalid-manifest')
    if (!sameBinding(raw, binding)) return quarantine(binding.sessionId, 'binding-mismatch')
    return raw
  }

  const verifiedRows = async (
    binding: TranscriptBinding,
    manifest: SessionTranscriptManifestV1,
  ): Promise<TranscriptEnvelope[]> => {
    const raw = await deps.persistence.listRows(binding.sessionId)
    const rows: TranscriptEnvelope[] = []
    let previous = ZERO_HASH
    for (let index = 0; index < raw.length; index += 1) {
      const value = raw[index]
      if (!validRow(value) || !sameBinding(value, binding)) return quarantine(binding.sessionId, 'invalid-row')
      if (value.sessionSeq !== index + 1) return quarantine(binding.sessionId, 'sequence-gap')
      if (value.prevSessionHash !== previous || computeTranscriptRowHash(value) !== value.rowHash) {
        return quarantine(binding.sessionId, 'hash-chain-mismatch')
      }
      previous = value.rowHash
      rows.push(value)
    }
    if (manifest.nextSessionSeq !== rows.length + 1 || manifest.hashHead !== previous) {
      return quarantine(binding.sessionId, 'manifest-head-mismatch')
    }
    return rows
  }

  const create = async (
    binding: TranscriptBinding,
    now: string,
    options: Pick<SessionTranscriptManifestV1, 'frozenPrefix' | 'resumeCapability'> &
      Partial<Pick<SessionTranscriptManifestV1, 'legacyLogSha256' | 'migrationBoundaryFrom'>>,
  ): Promise<SessionTranscriptManifestV1> => {
    if (!validBinding(binding) || !validIso(now)) {
      throw new SessionTranscriptError('invalid-input', 'invalid transcript binding or timestamp')
    }
    const manifest: SessionTranscriptManifestV1 = {
      schemaVersion: 1,
      ...binding,
      nextSessionSeq: 1,
      hashHead: ZERO_HASH,
      frozenPrefix: options.frozenPrefix,
      resumeCapability: options.resumeCapability,
      ...(options.legacyLogSha256 === undefined ? {} : { legacyLogSha256: options.legacyLogSha256 }),
      ...(options.migrationBoundaryFrom === undefined ? {} : { migrationBoundaryFrom: options.migrationBoundaryFrom }),
      createdAt: now,
      updatedAt: now,
    }
    if (!validManifest(manifest)) throw new SessionTranscriptError('invalid-input', 'invalid session transcript manifest')
    const existingRaw = await deps.persistence.loadManifest(binding.sessionId)
    if (existingRaw !== null) {
      if (!validManifest(existingRaw)) return quarantine(binding.sessionId, 'invalid-manifest')
      if (!sameBinding(existingRaw, binding)) return quarantine(binding.sessionId, 'binding-mismatch')
      if (sameCreation(existingRaw, manifest)) return existingRaw
      throw new SessionTranscriptError('commit-conflict', 'session id already has different transcript authority')
    }
    try {
      await deps.persistence.createManifest(manifest)
      return manifest
    } catch {
      const raced = await deps.persistence.loadManifest(binding.sessionId)
      if (validManifest(raced) && sameCreation(raced, manifest)) return raced
      throw new SessionTranscriptError('commit-conflict', 'concurrent session transcript creation conflict')
    }
  }

  const append = (
    input: TranscriptAppendInput,
    forcedDecision?: LoadBearingDecision,
  ): Promise<{ status: 'appended' | 'duplicate'; row: TranscriptEnvelope }> =>
    serialize(input.sessionId, async () => {
      if (!record(input) || !exactKeys(input, APPEND_KEYS) ||
        !validBinding(input) || !ID.test(input.eventId) ||
        !['system', 'user', 'assistant', 'tool'].includes(input.role) ||
        (input.provenance !== 'operator' && input.provenance !== 'untrusted') ||
        typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES ||
        !validIso(input.ts)) throw new SessionTranscriptError('invalid-input', 'invalid transcript append input')

      const manifest = await loadManifest(input)
      if (manifest.resumeCapability !== 'exact-v2') {
        const unexpected = await deps.persistence.listRows(input.sessionId)
        if (unexpected.length > 0) return quarantine(input.sessionId, 'invalid-row')
        throw new SessionTranscriptError('metadata-only', 'legacy metadata-only session cannot accept transcript rows')
      }
      const rows = await verifiedRows(input, manifest)
      const existingRaw = await deps.persistence.findEvent(input.eventId)
      if (existingRaw !== null) {
        if (!validRow(existingRaw) || !sameAppend(existingRaw, input) ||
          !rows.some(row => row.eventId === existingRaw.eventId && row.rowHash === existingRaw.rowHash)) {
          return quarantine(input.sessionId, 'event-id-conflict')
        }
        return { status: 'duplicate' as const, row: existingRaw }
      }
      const decision = forcedDecision ?? await deps.classifyLoadBearing(input)
      if (typeof decision.loadBearing !== 'boolean' || !CLASSIFIER_VERSION.test(decision.classifierVersion)) {
        throw new SessionTranscriptError('invalid-input', 'invalid load-bearing classifier decision')
      }
      const rowWithoutHash: Omit<TranscriptEnvelope, 'rowHash'> = {
        ...input,
        sessionSeq: manifest.nextSessionSeq,
        loadBearing: decision.loadBearing,
        loadBearingClassifierVersion: decision.classifierVersion,
        prevSessionHash: manifest.hashHead,
      }
      const row: TranscriptEnvelope = { ...rowWithoutHash, rowHash: computeTranscriptRowHash(rowWithoutHash) }
      const nextManifest: SessionTranscriptManifestV1 = {
        ...manifest,
        nextSessionSeq: manifest.nextSessionSeq + 1,
        hashHead: row.rowHash,
        updatedAt: transcriptUpdatedAt(manifest, row.ts),
      }
      try {
        await deps.persistence.commit({
          expectedNextSessionSeq: manifest.nextSessionSeq,
          expectedHashHead: manifest.hashHead,
          row,
          nextManifest,
        })
      } catch (error) {
        if (error instanceof TranscriptCommitUncertainError) throw error
        return quarantine(input.sessionId, 'commit-conflict')
      }
      return { status: 'appended' as const, row }
    })

  return {
    createExactSession: (binding, frozen, now) => create(binding, now, {
      frozenPrefix: prefixRecord(frozen),
      resumeCapability: 'exact-v2',
    }),
    registerLegacyMetadata: (binding, legacyLogSha256, now) => create(binding, now, {
      frozenPrefix: null,
      resumeCapability: 'metadata-only',
      legacyLogSha256,
    }),
    async continueLegacy(input) {
      const legacy = await loadManifest(input.legacy)
      if (legacy.resumeCapability !== 'metadata-only' || legacy.legacyLogSha256 !== input.legacyLogSha256) {
        throw new SessionTranscriptError('metadata-only', 'legacy migration boundary does not match source')
      }
      await create(input.next, input.ts, {
        frozenPrefix: prefixRecord(input.frozen),
        resumeCapability: 'exact-v2',
        migrationBoundaryFrom: {
          sessionId: input.legacy.sessionId,
          legacyLogSha256: input.legacyLogSha256,
        },
      })
      await append({
        ...input.next,
        eventId: input.eventId,
        role: 'system',
        provenance: 'operator',
        content: `MIGRATION_BOUNDARY:${input.legacy.sessionId}:${input.legacyLogSha256}`,
        ts: input.ts,
      }, { loadBearing: true, classifierVersion: 'migration-boundary-v1' })
      return loadManifest(input.next)
    },
    append,
    async read(binding) {
      const current = await loadManifest(binding)
      if (current.resumeCapability !== 'exact-v2') {
        const unexpected = await deps.persistence.listRows(binding.sessionId)
        if (unexpected.length > 0) return quarantine(binding.sessionId, 'invalid-row')
        return []
      }
      return verifiedRows(binding, current)
    },
    manifest: loadManifest,
  }
}

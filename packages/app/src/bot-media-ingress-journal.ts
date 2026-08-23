import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { TelegramTransportBindingV1 } from './bot-streaming-activity-coordinator.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_MEDIA = 512
const MAX_ALBUMS = 64
const MAX_ALBUM_ITEMS = 10
const MAX_CAPPED_ALBUM_ITEMS = 54

export const MEDIA_INGRESS_JOURNAL_PREVIEW_ONLY = true

export type TelegramMediaKind = 'document' | 'audio' | 'photo' | 'video' | 'voice' | 'animation'
export type MediaIngressPhase =
  | 'accepted'
  | 'recorded'
  | 'transcribed'
  | 'degraded'
  | 'cancelled'
  | 'capped'
  | 'quarantined'
export type AlbumPhase = 'collecting' | 'sealed' | 'ack-pending' | 'ack-delivered' | 'quarantined'

export interface MediaIngressV1 {
  readonly schemaVersion: 1
  readonly mediaIngressId: string
  readonly binding: TelegramTransportBindingV1
  readonly updateId: number
  readonly messageId: number
  readonly messageTs: string
  readonly kind: TelegramMediaKind
  readonly sourceFingerprint: string
  readonly groupHash?: string
  readonly phase: MediaIngressPhase
  readonly provenance: 'untrusted'
  readonly fileId?: string
  readonly sha256?: string
  readonly sizeBytes?: number
  readonly transcriptHash?: string
  readonly revision: number
}

export interface MediaAlbumV1 {
  readonly schemaVersion: 1
  readonly groupHash: string
  readonly binding: TelegramTransportBindingV1
  readonly orderedMediaIngressIds: string[]
  readonly cappedMediaIngressIds: string[]
  readonly received: number
  readonly failed: number
  readonly phase: AlbumPhase
  readonly revision: number
}

type MutableAlbum = { -readonly [K in keyof MediaAlbumV1]: MediaAlbumV1[K] }

export interface MediaIngressJournalStateV1 {
  readonly schemaVersion: 1
  readonly binding: TelegramTransportBindingV1
  readonly revision: number
  readonly media: MediaIngressV1[]
  readonly albums: MediaAlbumV1[]
  readonly checksum: string
}

export type MediaIngressJournalLoad =
  | { status: 'missing' }
  | { status: 'ready'; value: unknown }
  | { status: 'quarantined' }

export interface MediaIngressJournalPersistence {
  load(binding: TelegramTransportBindingV1): Promise<MediaIngressJournalLoad>
  commit(input: {
    binding: TelegramTransportBindingV1
    expectedRevision: number | null
    expectedChecksum: string | null
    state: MediaIngressJournalStateV1
  }): Promise<void>
  quarantine(binding: TelegramTransportBindingV1, reason: string): Promise<void>
}

export type MediaIngressJournalCode =
  | 'INVALID_REQUEST'
  | 'BINDING_MISMATCH'
  | 'INGRESS_IDENTITY_CONFLICT'
  | 'MEDIA_LIMIT_EXCEEDED'
  | 'MEDIA_INTEGRITY_FAILED'
  | 'MEDIA_QUARANTINED'
  | 'STATE_UNAVAILABLE'

export class MediaIngressJournalError extends Error {
  constructor(readonly code: MediaIngressJournalCode) {
    super(code)
    this.name = 'MediaIngressJournalError'
  }
}

export interface TelegramMediaIngressJournal {
  accept(input: {
    binding: TelegramTransportBindingV1
    updateId: number
    messageId: number
    messageTs: string
    kind: TelegramMediaKind
    sourceFingerprint: string
    groupHash?: string
  }): Promise<{ status: 'accepted' | 'duplicate' | 'capped'; mediaIngressId: string }>
  record(input: {
    binding: TelegramTransportBindingV1
    mediaIngressId: string
    fileId: string
    sha256: string
    sizeBytes: number
  }): Promise<{ status: 'recorded' | 'duplicate'; media: MediaIngressV1 }>
  recordVoice(input: {
    binding: TelegramTransportBindingV1
    mediaIngressId: string
    outcome:
      | { kind: 'transcribed'; provenance: 'untrusted'; channel: 'voice'; transcriptHash: string }
      | { kind: 'degraded'; code: 'VOICE_UNAVAILABLE' }
      | { kind: 'cancelled' }
  }): Promise<MediaIngressV1>
  sealAlbum(input: {
    binding: TelegramTransportBindingV1
    groupHash: string
    orderedMediaIngressIds: readonly string[]
  }): Promise<MediaAlbumV1>
  markAlbumAck(input: {
    binding: TelegramTransportBindingV1
    groupHash: string
    expectedRevision: number
    delivery: 'pending' | 'delivered'
  }): Promise<MediaAlbumV1>
  snapshot(binding: TelegramTransportBindingV1): Promise<MediaIngressJournalStateV1>
}

function sameBinding(a: TelegramTransportBindingV1, b: TelegramTransportBindingV1): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId &&
    a.chatBindingHash === b.chatBindingHash
}

function strictBinding(value: TelegramTransportBindingV1): TelegramTransportBindingV1 {
  if (Object.keys(value).sort().join(',') !== 'chatBindingHash,operatorId,profileId,projectId,sessionId' ||
    !HASH.test(value.chatBindingHash) ||
    ![value.operatorId, value.profileId, value.projectId, value.sessionId].every(item => ID.test(item))) {
    throw new MediaIngressJournalError('INVALID_REQUEST')
  }
  return Object.freeze(structuredClone(value))
}

function hash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function telegramMediaIngressId(input: {
  binding: TelegramTransportBindingV1
  updateId: number
  messageId: number
  kind: TelegramMediaKind
  sourceFingerprint: string
}): string {
  const binding = strictBinding(input.binding)
  if (!Number.isSafeInteger(input.updateId) || input.updateId < 0 ||
    !Number.isSafeInteger(input.messageId) || input.messageId < 0 ||
    !['document', 'audio', 'photo', 'video', 'voice', 'animation'].includes(input.kind) ||
    !HASH.test(input.sourceFingerprint)) throw new MediaIngressJournalError('INVALID_REQUEST')
  return hash([
    'aisy.telegram.media-ingress.v1', binding.operatorId, binding.profileId,
    binding.projectId, binding.sessionId, binding.chatBindingHash, input.updateId,
    input.messageId, input.kind, input.sourceFingerprint,
  ])
}

export function telegramMediaGroupHash(input: {
  binding: TelegramTransportBindingV1
  mediaGroupId: string
}): string {
  const binding = strictBinding(input.binding)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.mediaGroupId)) {
    throw new MediaIngressJournalError('INVALID_REQUEST')
  }
  return hash([
    'aisy.telegram.media-group.v1', binding.operatorId, binding.profileId,
    binding.projectId, binding.sessionId, binding.chatBindingHash, input.mediaGroupId,
  ])
}

function checksum(value: Omit<MediaIngressJournalStateV1, 'checksum'>): string {
  return createHash('sha256').update('aisy.telegram.media-journal.v1\0')
    .update(JSON.stringify(value)).digest('hex')
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && new Date(value).toISOString() === value
}

function validateState(value: unknown, binding: TelegramTransportBindingV1): MediaIngressJournalStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
  const state = structuredClone(value) as MediaIngressJournalStateV1
  if (Object.keys(state).sort().join(',') !== 'albums,binding,checksum,media,revision,schemaVersion' ||
    state.schemaVersion !== 1 || !sameBinding(strictBinding(state.binding), binding) ||
    !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.media) ||
    state.media.length > MAX_MEDIA || !Array.isArray(state.albums) || state.albums.length > MAX_ALBUMS ||
    typeof state.checksum !== 'string' || !HASH.test(state.checksum)) throw new Error('invalid')
  const mediaIds = new Set<string>()
  const mediaById = new Map<string, MediaIngressV1>()
  for (const item of state.media) {
    const itemKeys = Object.keys(item)
    const required = [
      'schemaVersion', 'mediaIngressId', 'binding', 'updateId', 'messageId', 'messageTs',
      'kind', 'sourceFingerprint', 'phase', 'provenance', 'revision',
    ]
    if (required.some(key => !Object.hasOwn(item, key)) || itemKeys.some(key => ![
      'schemaVersion', 'mediaIngressId', 'binding', 'updateId', 'messageId', 'messageTs',
      'kind', 'sourceFingerprint', 'groupHash', 'phase', 'provenance', 'fileId', 'sha256',
      'sizeBytes', 'transcriptHash', 'revision',
    ].includes(key)) || item.schemaVersion !== 1 || !HASH.test(item.mediaIngressId) ||
      !sameBinding(strictBinding(item.binding), binding) || !Number.isSafeInteger(item.updateId) || item.updateId < 0 ||
      !Number.isSafeInteger(item.messageId) || item.messageId < 0 || !validIso(item.messageTs) ||
      !['document', 'audio', 'photo', 'video', 'voice', 'animation'].includes(item.kind) ||
      !HASH.test(item.sourceFingerprint) || (item.groupHash !== undefined && !HASH.test(item.groupHash)) ||
      !['accepted', 'recorded', 'transcribed', 'degraded', 'cancelled', 'capped', 'quarantined'].includes(item.phase) ||
      item.provenance !== 'untrusted' || !Number.isSafeInteger(item.revision) || item.revision < 1 ||
      (item.fileId !== undefined && !ID.test(item.fileId)) ||
      (item.sha256 !== undefined && !HASH.test(item.sha256)) ||
      (item.sizeBytes !== undefined && (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0)) ||
      (item.transcriptHash !== undefined && !HASH.test(item.transcriptHash)) || mediaIds.has(item.mediaIngressId)) {
      throw new Error('invalid')
    }
    if (telegramMediaIngressId({
      binding: item.binding,
      updateId: item.updateId,
      messageId: item.messageId,
      kind: item.kind,
      sourceFingerprint: item.sourceFingerprint,
    }) !== item.mediaIngressId) throw new Error('invalid')
    if (['recorded', 'transcribed', 'degraded', 'cancelled'].includes(item.phase) &&
      (item.fileId === undefined || item.sha256 === undefined || item.sizeBytes === undefined)) throw new Error('invalid')
    if (['accepted', 'capped'].includes(item.phase) &&
      (item.fileId !== undefined || item.sha256 !== undefined || item.sizeBytes !== undefined ||
        item.transcriptHash !== undefined)) throw new Error('invalid')
    if (item.phase === 'transcribed' && item.transcriptHash === undefined) throw new Error('invalid')
    if (item.phase !== 'transcribed' && item.transcriptHash !== undefined) throw new Error('invalid')
    if (item.phase === 'capped' && item.groupHash === undefined) throw new Error('invalid')
    mediaIds.add(item.mediaIngressId)
    mediaById.set(item.mediaIngressId, item)
  }
  const groups = new Set<string>()
  const albumMembership = new Set<string>()
  for (const album of state.albums) {
    if (Object.keys(album).sort().join(',') !==
      'binding,cappedMediaIngressIds,failed,groupHash,orderedMediaIngressIds,phase,received,revision,schemaVersion' ||
      album.schemaVersion !== 1 || !HASH.test(album.groupHash) || groups.has(album.groupHash) ||
      !sameBinding(strictBinding(album.binding), binding) || !Array.isArray(album.orderedMediaIngressIds) ||
      album.orderedMediaIngressIds.length > MAX_ALBUM_ITEMS ||
      new Set(album.orderedMediaIngressIds).size !== album.orderedMediaIngressIds.length ||
      album.orderedMediaIngressIds.some(id => {
        const media = mediaById.get(id)
        return media === undefined || media.phase === 'capped' ||
          media.groupHash !== album.groupHash || albumMembership.has(id)
      }) ||
      !Array.isArray(album.cappedMediaIngressIds) ||
      album.cappedMediaIngressIds.length > MAX_CAPPED_ALBUM_ITEMS ||
      new Set(album.cappedMediaIngressIds).size !== album.cappedMediaIngressIds.length ||
      album.cappedMediaIngressIds.some(id => {
        const media = mediaById.get(id)
        return !HASH.test(id) || media === undefined || media.phase !== 'capped' ||
          media.groupHash !== album.groupHash || albumMembership.has(id) ||
          album.orderedMediaIngressIds.includes(id)
      }) ||
      !Number.isSafeInteger(album.received) || album.received < album.orderedMediaIngressIds.length ||
      !Number.isSafeInteger(album.failed) || album.failed < 0 ||
      !['collecting', 'sealed', 'ack-pending', 'ack-delivered', 'quarantined'].includes(album.phase) ||
      !Number.isSafeInteger(album.revision) || album.revision < 1) throw new Error('invalid')
    for (const id of [...album.orderedMediaIngressIds, ...album.cappedMediaIngressIds]) {
      albumMembership.add(id)
    }
    groups.add(album.groupHash)
  }
  if (state.media.some(item =>
    item.groupHash === undefined ? albumMembership.has(item.mediaIngressId) : !albumMembership.has(item.mediaIngressId))) {
    throw new Error('invalid')
  }
  const { checksum: stored, ...body } = state
  if (checksum(body) !== stored) throw new Error('invalid')
  return Object.freeze(state)
}

function initial(binding: TelegramTransportBindingV1): MediaIngressJournalStateV1 {
  const body = { schemaVersion: 1 as const, binding, revision: 0, media: [], albums: [] }
  return { ...body, checksum: checksum(body) }
}

function withChecksum(state: Omit<MediaIngressJournalStateV1, 'checksum'>): MediaIngressJournalStateV1 {
  return Object.freeze({ ...state, checksum: checksum(state) })
}

export function makeTelegramMediaIngressJournal(input: {
  persistence: MediaIngressJournalPersistence
  maxMediaBytes: number
}): TelegramMediaIngressJournal {
  if (!Number.isSafeInteger(input.maxMediaBytes) || input.maxMediaBytes < 1 ||
    input.maxMediaBytes > 256 * 1024 * 1024) throw new MediaIngressJournalError('INVALID_REQUEST')
  let tail = Promise.resolve()
  const serialized = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolvePromise => { release = resolvePromise })
    await previous
    try { return await work() } finally { release() }
  }
  const load = async (binding: TelegramTransportBindingV1): Promise<MediaIngressJournalStateV1> => {
    let loaded: MediaIngressJournalLoad
    try { loaded = await input.persistence.load(binding) } catch {
      throw new MediaIngressJournalError('STATE_UNAVAILABLE')
    }
    if (loaded.status === 'quarantined') throw new MediaIngressJournalError('MEDIA_QUARANTINED')
    if (loaded.status === 'missing') return initial(binding)
    try { return validateState(loaded.value, binding) } catch {
      return quarantine(binding, 'invalid-state')
    }
  }
  const commit = async (
    binding: TelegramTransportBindingV1,
    previous: MediaIngressJournalStateV1,
    next: MediaIngressJournalStateV1,
  ): Promise<void> => {
    try {
      await input.persistence.commit({
        binding,
        expectedRevision: previous.revision === 0 && previous.media.length === 0 && previous.albums.length === 0
          ? null : previous.revision,
        expectedChecksum: previous.revision === 0 && previous.media.length === 0 && previous.albums.length === 0
          ? null : previous.checksum,
        state: next,
      })
    } catch {
      throw new MediaIngressJournalError('STATE_UNAVAILABLE')
    }
  }
  const quarantine = async (binding: TelegramTransportBindingV1, reason: string): Promise<never> => {
    try { await input.persistence.quarantine(binding, reason) } catch {
      throw new MediaIngressJournalError('STATE_UNAVAILABLE')
    }
    throw new MediaIngressJournalError('MEDIA_QUARANTINED')
  }

  return Object.freeze<TelegramMediaIngressJournal>({
    accept(request) {
      return serialized(async () => {
        const binding = strictBinding(request.binding)
        const mediaIngressId = telegramMediaIngressId({ ...request, binding })
        if (!validIso(request.messageTs) || (request.groupHash !== undefined && !HASH.test(request.groupHash))) {
          throw new MediaIngressJournalError('INVALID_REQUEST')
        }
        const state = await load(binding)
        const sameUpdate = state.media.find(item => item.updateId === request.updateId)
        if (sameUpdate !== undefined && sameUpdate.mediaIngressId !== mediaIngressId) {
          return quarantine(binding, 'identity-conflict')
        }
        const existing = state.media.find(item => item.mediaIngressId === mediaIngressId)
        if (existing !== undefined) {
          const exact = existing.updateId === request.updateId && existing.messageId === request.messageId &&
            existing.messageTs === request.messageTs && existing.kind === request.kind &&
            existing.sourceFingerprint === request.sourceFingerprint && existing.groupHash === request.groupHash
          if (!exact) return quarantine(binding, 'identity-conflict')
          return { status: existing.phase === 'capped' ? 'capped' as const : 'duplicate' as const, mediaIngressId }
        }
        if (state.media.length >= MAX_MEDIA) throw new MediaIngressJournalError('MEDIA_LIMIT_EXCEEDED')
        const media = [...state.media]
        const albums: MutableAlbum[] = state.albums.map(album => ({
          ...album,
          binding: structuredClone(album.binding),
          orderedMediaIngressIds: [...album.orderedMediaIngressIds],
          cappedMediaIngressIds: [...album.cappedMediaIngressIds],
        }))
        if (request.groupHash !== undefined) {
          let album = albums.find(item => item.groupHash === request.groupHash)
          if (album === undefined) {
            if (albums.length >= MAX_ALBUMS) throw new MediaIngressJournalError('MEDIA_LIMIT_EXCEEDED')
            album = {
              schemaVersion: 1, groupHash: request.groupHash, binding,
              orderedMediaIngressIds: [], cappedMediaIngressIds: [], received: 0, failed: 0,
              phase: 'collecting', revision: 1,
            }
            albums.push(album)
          }
          if (album.phase !== 'collecting') return quarantine(binding, 'late-album-item')
          if (album.cappedMediaIngressIds.includes(mediaIngressId)) {
            return { status: 'capped' as const, mediaIngressId }
          }
          album.received += 1
          album.revision += 1
          if (album.orderedMediaIngressIds.length >= MAX_ALBUM_ITEMS) {
            if (album.cappedMediaIngressIds.length >= MAX_CAPPED_ALBUM_ITEMS) {
              throw new MediaIngressJournalError('MEDIA_LIMIT_EXCEEDED')
            }
            album.cappedMediaIngressIds.push(mediaIngressId)
            album.failed += 1
            media.push({
              schemaVersion: 1, mediaIngressId, binding, updateId: request.updateId,
              messageId: request.messageId, messageTs: request.messageTs, kind: request.kind,
              sourceFingerprint: request.sourceFingerprint, groupHash: request.groupHash,
              phase: 'capped', provenance: 'untrusted', revision: 1,
            })
            const next = withChecksum({
              schemaVersion: 1, binding, revision: state.revision + 1, media, albums,
            })
            await commit(binding, state, next)
            return { status: 'capped' as const, mediaIngressId }
          }
          album.orderedMediaIngressIds.push(mediaIngressId)
        }
        media.push({
          schemaVersion: 1, mediaIngressId, binding, updateId: request.updateId,
          messageId: request.messageId, messageTs: request.messageTs, kind: request.kind,
          sourceFingerprint: request.sourceFingerprint,
          ...(request.groupHash === undefined ? {} : { groupHash: request.groupHash }),
          phase: 'accepted', provenance: 'untrusted', revision: 1,
        })
        const next = withChecksum({ schemaVersion: 1, binding, revision: state.revision + 1, media, albums })
        await commit(binding, state, next)
        return { status: 'accepted' as const, mediaIngressId }
      })
    },

    record(request) {
      return serialized(async () => {
        const binding = strictBinding(request.binding)
        if (!HASH.test(request.mediaIngressId) || !ID.test(request.fileId) || !HASH.test(request.sha256) ||
          !Number.isSafeInteger(request.sizeBytes) || request.sizeBytes < 0) {
          throw new MediaIngressJournalError('INVALID_REQUEST')
        }
        if (request.sizeBytes > input.maxMediaBytes) {
          throw new MediaIngressJournalError('MEDIA_LIMIT_EXCEEDED')
        }
        const state = await load(binding)
        const index = state.media.findIndex(item => item.mediaIngressId === request.mediaIngressId)
        if (index < 0) throw new MediaIngressJournalError('BINDING_MISMATCH')
        const current = state.media[index]!
        if (current.phase !== 'accepted') {
          if (current.fileId === request.fileId && current.sha256 === request.sha256 &&
            current.sizeBytes === request.sizeBytes) return { status: 'duplicate' as const, media: current }
          return quarantine(binding, 'record-conflict')
        }
        const media = [...state.media]
        const recorded: MediaIngressV1 = {
          ...current, phase: 'recorded', fileId: request.fileId, sha256: request.sha256,
          sizeBytes: request.sizeBytes, revision: current.revision + 1,
        }
        media[index] = recorded
        const next = withChecksum({
          schemaVersion: 1, binding, revision: state.revision + 1, media, albums: state.albums,
        })
        await commit(binding, state, next)
        return { status: 'recorded' as const, media: recorded }
      })
    },

    recordVoice(request) {
      return serialized(async () => {
        const binding = strictBinding(request.binding)
        if (request.outcome.kind === 'transcribed') {
          if (request.outcome.provenance !== 'untrusted' || request.outcome.channel !== 'voice' ||
            !HASH.test(request.outcome.transcriptHash)) {
            throw new MediaIngressJournalError('MEDIA_INTEGRITY_FAILED')
          }
        } else if (request.outcome.kind === 'degraded') {
          if (request.outcome.code !== 'VOICE_UNAVAILABLE') {
            throw new MediaIngressJournalError('MEDIA_INTEGRITY_FAILED')
          }
        } else if (request.outcome.kind !== 'cancelled') {
          throw new MediaIngressJournalError('MEDIA_INTEGRITY_FAILED')
        }
        const state = await load(binding)
        const index = state.media.findIndex(item => item.mediaIngressId === request.mediaIngressId)
        const current = state.media[index]
        if (current === undefined || current.kind !== 'voice') {
          throw new MediaIngressJournalError('BINDING_MISMATCH')
        }
        if (['transcribed', 'degraded', 'cancelled'].includes(current.phase)) {
          const exact =
            (current.phase === 'transcribed' && request.outcome.kind === 'transcribed' &&
              current.transcriptHash === request.outcome.transcriptHash) ||
            (current.phase === 'degraded' && request.outcome.kind === 'degraded') ||
            (current.phase === 'cancelled' && request.outcome.kind === 'cancelled')
          if (exact) return current
          return quarantine(binding, 'voice-outcome-conflict')
        }
        if (current.phase !== 'recorded') throw new MediaIngressJournalError('BINDING_MISMATCH')
        let updated: MediaIngressV1
        if (request.outcome.kind === 'transcribed') {
          updated = { ...current, phase: 'transcribed', transcriptHash: request.outcome.transcriptHash,
            revision: current.revision + 1 }
        } else if (request.outcome.kind === 'degraded') {
          updated = { ...current, phase: 'degraded', revision: current.revision + 1 }
        } else updated = { ...current, phase: 'cancelled', revision: current.revision + 1 }
        const media = [...state.media]
        media[index] = updated
        const next = withChecksum({
          schemaVersion: 1, binding, revision: state.revision + 1, media, albums: state.albums,
        })
        await commit(binding, state, next)
        return updated
      })
    },

    sealAlbum(request) {
      return serialized(async () => {
        const binding = strictBinding(request.binding)
        if (!HASH.test(request.groupHash)) throw new MediaIngressJournalError('INVALID_REQUEST')
        const state = await load(binding)
        const index = state.albums.findIndex(item => item.groupHash === request.groupHash)
        const album = state.albums[index]
        if (album === undefined) throw new MediaIngressJournalError('BINDING_MISMATCH')
        if (JSON.stringify(album.orderedMediaIngressIds) !== JSON.stringify(request.orderedMediaIngressIds)) {
          return quarantine(binding, 'album-order-conflict')
        }
        if (album.phase !== 'collecting' && album.phase !== 'sealed') return quarantine(binding, 'album-phase-conflict')
        if (album.phase === 'sealed') return album
        const albums = [...state.albums]
        const sealed = { ...album, phase: 'sealed' as const, revision: album.revision + 1 }
        albums[index] = sealed
        const next = withChecksum({
          schemaVersion: 1, binding, revision: state.revision + 1, media: state.media, albums,
        })
        await commit(binding, state, next)
        return sealed
      })
    },

    markAlbumAck(request) {
      return serialized(async () => {
        const binding = strictBinding(request.binding)
        const state = await load(binding)
        const index = state.albums.findIndex(item => item.groupHash === request.groupHash)
        const album = state.albums[index]
        if (album === undefined || album.revision !== request.expectedRevision ||
          (request.delivery === 'pending' && album.phase !== 'sealed') ||
          (request.delivery === 'delivered' && album.phase !== 'ack-pending')) {
          throw new MediaIngressJournalError('INGRESS_IDENTITY_CONFLICT')
        }
        const albums = [...state.albums]
        const updated = {
          ...album, phase: request.delivery === 'pending' ? 'ack-pending' as const : 'ack-delivered' as const,
          revision: album.revision + 1,
        }
        albums[index] = updated
        const next = withChecksum({
          schemaVersion: 1, binding, revision: state.revision + 1, media: state.media, albums,
        })
        await commit(binding, state, next)
        return updated
      })
    },

    snapshot(rawBinding) {
      return serialized(async () => load(strictBinding(rawBinding)))
    },
  })
}

function bindingKey(binding: TelegramTransportBindingV1): string {
  return hash([
    'aisy.telegram.media-journal.binding.v1', binding.operatorId, binding.profileId,
    binding.projectId, binding.sessionId, binding.chatBindingHash,
  ])
}

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function privateDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('unsafe')
}

function readPrivate(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STATE_BYTES ||
    (before.mode & 0o077) !== 0) throw new Error('unsafe')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = fstatSync(fd)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size > MAX_STATE_BYTES || (after.mode & 0o077) !== 0) throw new Error('unsafe')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

/** Preview store: atomic and CAS-shaped, but intentionally not a multi-process writer authority. */
export function makeNodeMediaIngressJournalPersistence(input: {
  root: string
}): MediaIngressJournalPersistence {
  const root = resolve(input.root)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  privateDirectory(root)
  const paths = (binding: TelegramTransportBindingV1) => {
    const directory = join(root, bindingKey(strictBinding(binding)))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    privateDirectory(directory)
    return { directory, state: join(directory, 'state.json'), quarantine: join(directory, 'quarantine.json') }
  }
  const save = (path: string, content: string): void => {
    if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) throw new Error('oversized')
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, path)
    syncPath(dirname(path))
  }
  return {
    async load(binding) {
      const path = paths(binding)
      if (existsSync(path.quarantine)) return { status: 'quarantined' }
      if (!existsSync(path.state)) return { status: 'missing' }
      try { return { status: 'ready', value: JSON.parse(readPrivate(path.state)) } } catch {
        return { status: 'ready', value: null }
      }
    },
    async commit({ binding, expectedRevision, expectedChecksum, state }) {
      const path = paths(binding)
      if (existsSync(path.quarantine)) throw new Error('quarantined')
      if (expectedRevision === null) {
        if (existsSync(path.state)) throw new Error('cas')
      } else {
        const current = JSON.parse(readPrivate(path.state)) as { revision?: unknown; checksum?: unknown }
        if (current.revision !== expectedRevision || current.checksum !== expectedChecksum) throw new Error('cas')
      }
      save(path.state, JSON.stringify(state, null, 2) + '\n')
    },
    async quarantine(binding, reason) {
      const path = paths(binding)
      if (!existsSync(path.quarantine)) {
        save(path.quarantine, JSON.stringify({ schemaVersion: 1, reason }, null, 2) + '\n')
      }
    },
  }
}

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

import type { InboxAttachmentV1, ResolvedWorkBinding } from '@aisy/core'
import {
  telegramAttachmentIdentity,
  type TelegramAttachmentDescriptor,
} from './telegram-attachment-inbox.js'
import type { TranscriptionAudioRequest } from './transcription-contract.js'

const HASH = /^[a-f0-9]{64}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/
const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export type VoiceMediaContentType = 'audio/ogg' | 'audio/opus' | 'audio/webm'

export interface TelegramVoiceMediaCapability {
  readonly kind: 'telegram-voice-media-capability-v1'
}

export interface VoiceMediaAuthorityView {
  readonly audioRoot: string
  readonly relativePath: string
  readonly expectedSha256: string
  readonly expectedSizeBytes: number
  readonly maxBytes: number
  readonly contentType: VoiceMediaContentType
  readonly language?: string
  readonly mediaBindingHash: string
}

interface CapabilityState extends VoiceMediaAuthorityView {
  readonly rootDev: number
  readonly rootIno: number
  readonly fileDev: number
  readonly fileIno: number
}

export class VoiceMediaCapabilityError extends Error {
  constructor(readonly code:
    | 'INVALID_REQUEST'
    | 'UNSAFE_MEDIA'
    | 'CAPABILITY_FORGED'
    | 'CAPABILITY_REPLAYED'
    | 'CAPABILITY_MISMATCH'
    | 'MEDIA_CHANGED') {
    super(code)
    this.name = 'VoiceMediaCapabilityError'
  }
}

export interface TelegramVoiceMediaCapabilityIssuer {
  issue(input: Readonly<{
    binding: ResolvedWorkBinding
    attachment: TelegramAttachmentDescriptor
    record: InboxAttachmentV1
    audioRoot: string
    contentType: VoiceMediaContentType
  }>): TelegramVoiceMediaCapability
  consume(
    capability: unknown,
    request: TranscriptionAudioRequest,
  ): Readonly<VoiceMediaAuthorityView>
}

function fail(code: VoiceMediaCapabilityError['code']): never {
  throw new VoiceMediaCapabilityError(code)
}

function safeText(value: string): boolean {
  return value.length > 0 && !value.includes('\0') &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function exactRoot(path: string): Stats {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) fail('INVALID_REQUEST')
  try {
    const info = lstatSync(path)
    const uid = process.geteuid?.()
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path ||
      (typeof uid === 'number' && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      fail('UNSAFE_MEDIA')
    }
    return info
  } catch (error) {
    if (error instanceof VoiceMediaCapabilityError) throw error
    return fail('UNSAFE_MEDIA')
  }
}

function exactFile(
  root: string,
  relativePath: string,
  rootDev: number,
): Readonly<{ info: Stats; sha256: string }> {
  if (!FILE_NAME.test(relativePath) || typeof constants.O_NOFOLLOW !== 'number') {
    fail('INVALID_REQUEST')
  }
  let descriptor: number
  try { descriptor = openSync(join(root, relativePath), constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
    return fail('UNSAFE_MEDIA')
  }
  try {
    const info = fstatSync(descriptor)
    const uid = process.geteuid?.()
    if (!info.isFile() || info.nlink !== 1 || info.dev !== rootDev ||
      (typeof uid === 'number' && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      fail('UNSAFE_MEDIA')
    }
    if (info.size < 1 || info.size > MAX_MEDIA_BYTES) fail('UNSAFE_MEDIA')
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, info.size))
    let offset = 0
    while (offset < info.size) {
      const length = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, info.size - offset), null)
      if (length === 0) fail('UNSAFE_MEDIA')
      hash.update(chunk.subarray(0, length))
      offset += length
    }
    const after = fstatSync(descriptor)
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size ||
      after.nlink !== 1) fail('UNSAFE_MEDIA')
    return Object.freeze({ info, sha256: hash.digest('hex') })
  } finally {
    closeSync(descriptor)
  }
}

function bindingHash(input: Readonly<{
  binding: ResolvedWorkBinding
  attachment: TelegramAttachmentDescriptor
  record: InboxAttachmentV1
  rootDev: number
  rootIno: number
  fileDev: number
  fileIno: number
  contentType: VoiceMediaContentType
}>): string {
  return createHash('sha256')
    .update('aisy.telegram.voice.media-capability.v1\0')
    .update(JSON.stringify({
      operatorId: input.binding.operatorId,
      profileId: input.binding.profileId,
      projectId: input.binding.projectId,
      sessionId: input.binding.sessionId,
      scope: input.binding.scope,
      updateId: input.attachment.updateId,
      messageId: input.attachment.messageId,
      chatId: input.attachment.chatId,
      telegramFileId: input.attachment.telegramFileId,
      telegramFileUniqueId: input.attachment.telegramFileUniqueId ?? null,
      fileId: input.record.fileId,
      provenanceRef: input.record.provenanceRef,
      receivedAt: input.record.receivedAt,
      sha256: input.record.sha256,
      sizeBytes: input.record.sizeBytes,
      rootDev: input.rootDev,
      rootIno: input.rootIno,
      fileDev: input.fileDev,
      fileIno: input.fileIno,
      contentType: input.contentType,
    }))
    .digest('hex')
}

function validIssue(input: Parameters<TelegramVoiceMediaCapabilityIssuer['issue']>[0]): boolean {
  const identity = telegramAttachmentIdentity(input.binding, input.attachment)
  return input.attachment.kind === 'voice' && input.record.source === 'telegram' &&
    input.record.operatorId === input.binding.operatorId &&
    input.record.profileId === input.binding.profileId &&
    input.record.sessionId === input.binding.sessionId &&
    input.record.originalName === input.attachment.originalName &&
    input.record.fileId === identity.fileId &&
    input.record.provenanceRef === identity.provenanceRef &&
    input.record.receivedAt === identity.receivedAt &&
    input.binding.operatorId === `telegram:${input.attachment.chatId}` &&
    (input.attachment.declaredSizeBytes === undefined ||
      input.attachment.declaredSizeBytes === input.record.sizeBytes) &&
    Number.isSafeInteger(input.attachment.updateId) && input.attachment.updateId >= 0 &&
    Number.isSafeInteger(input.attachment.messageId) && input.attachment.messageId >= 0 &&
    Number.isSafeInteger(input.attachment.chatId) && safeText(input.record.provenanceRef) &&
    HASH.test(input.record.sha256) && Number.isSafeInteger(input.record.sizeBytes) &&
    input.record.sizeBytes > 0 && input.record.sizeBytes <= MAX_MEDIA_BYTES &&
    FILE_NAME.test(input.record.fileId) &&
    ['audio/ogg', 'audio/opus', 'audio/webm'].includes(input.contentType)
}

function snapshotRequest(value: TranscriptionAudioRequest): TranscriptionAudioRequest {
  if (value === null || typeof value !== 'object' || isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail('CAPABILITY_MISMATCH')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set([
    'audioRoot', 'relativePath', 'expectedSha256', 'expectedSizeBytes', 'maxBytes',
    'language', 'signal', 'mediaCapability',
  ])
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.has(key)) ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    fail('CAPABILITY_MISMATCH')
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )) as TranscriptionAudioRequest
}

export function makeTelegramVoiceMediaCapabilityIssuer(): TelegramVoiceMediaCapabilityIssuer {
  const active = new WeakMap<object, CapabilityState>()
  const consumed = new WeakSet<object>()
  return Object.freeze({
    issue(input: Parameters<TelegramVoiceMediaCapabilityIssuer['issue']>[0]) {
      if (input === null || typeof input !== 'object' || isProxy(input) ||
        Object.getPrototypeOf(input) !== Object.prototype || !validIssue(input)) fail('INVALID_REQUEST')
      const root = exactRoot(input.audioRoot)
      const rootDev = Number(root.dev)
      const rootIno = Number(root.ino)
      if (!Number.isSafeInteger(rootDev) || !Number.isSafeInteger(rootIno)) fail('UNSAFE_MEDIA')
      const checked = exactFile(input.audioRoot, input.record.fileId, rootDev)
      const file = checked.info
      const fileDev = Number(file.dev)
      const fileIno = Number(file.ino)
      if (!Number.isSafeInteger(fileDev) || !Number.isSafeInteger(fileIno)) fail('UNSAFE_MEDIA')
      if (file.size !== input.record.sizeBytes || checked.sha256 !== input.record.sha256) {
        fail('UNSAFE_MEDIA')
      }
      const capability = Object.freeze<TelegramVoiceMediaCapability>({
        kind: 'telegram-voice-media-capability-v1',
      })
      active.set(capability, Object.freeze({
        audioRoot: input.audioRoot,
        relativePath: input.record.fileId,
        expectedSha256: input.record.sha256,
        expectedSizeBytes: input.record.sizeBytes,
        maxBytes: input.record.sizeBytes,
        contentType: input.contentType,
        mediaBindingHash: bindingHash({
          binding: input.binding,
          attachment: input.attachment,
          record: input.record,
          rootDev,
          rootIno,
          fileDev,
          fileIno,
          contentType: input.contentType,
        }),
        rootDev,
        rootIno,
        fileDev,
        fileIno,
      }))
      return capability
    },

    consume(capability: unknown, request: TranscriptionAudioRequest) {
      if (typeof capability !== 'object' || capability === null) fail('CAPABILITY_FORGED')
      const state = active.get(capability)
      if (state === undefined) {
        fail(consumed.has(capability) ? 'CAPABILITY_REPLAYED' : 'CAPABILITY_FORGED')
      }
      active.delete(capability)
      consumed.add(capability)
      const exact = snapshotRequest(request)
      const language = exact.language?.toLowerCase()
      if (exact.audioRoot !== state.audioRoot || exact.relativePath !== state.relativePath ||
        exact.expectedSha256 !== state.expectedSha256 ||
        exact.expectedSizeBytes !== state.expectedSizeBytes ||
        !Number.isSafeInteger(exact.maxBytes) || exact.maxBytes < state.expectedSizeBytes ||
        (language !== undefined && !LANGUAGE.test(language))) fail('CAPABILITY_MISMATCH')
      const root = exactRoot(state.audioRoot)
      const rootDev = Number(root.dev)
      const rootIno = Number(root.ino)
      if (!Number.isSafeInteger(rootDev) || !Number.isSafeInteger(rootIno)) fail('MEDIA_CHANGED')
      const checked = exactFile(state.audioRoot, state.relativePath, rootDev)
      const file = checked.info
      if (rootDev !== state.rootDev || rootIno !== state.rootIno ||
        Number(file.dev) !== state.fileDev || Number(file.ino) !== state.fileIno ||
        file.size !== state.expectedSizeBytes || checked.sha256 !== state.expectedSha256) {
        fail('MEDIA_CHANGED')
      }
      return Object.freeze({
        audioRoot: state.audioRoot,
        relativePath: state.relativePath,
        expectedSha256: state.expectedSha256,
        expectedSizeBytes: state.expectedSizeBytes,
        maxBytes: exact.maxBytes,
        contentType: state.contentType,
        ...(language === undefined ? {} : { language }),
        mediaBindingHash: state.mediaBindingHash,
      })
    },
  })
}

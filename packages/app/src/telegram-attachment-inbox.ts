import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  parseInboxAttachment,
  resolvedWorkBinding,
  type InboxAttachmentV1,
  type ResolvedWorkBinding,
  type TelegramUpdate,
} from '@aisy/core'

const MAX_CONTROL_BYTES = 1024 * 1024
const MAX_FILE_ID_BYTES = 4096
const MAX_ORIGINAL_NAME_BYTES = 1024
const MAX_GET_FILE_RESPONSE_BYTES = 256 * 1024
const TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const BOT_TOKEN = /^[A-Za-z0-9:_-]{8,256}$/

export type TelegramAttachmentKind =
  | 'document'
  | 'audio'
  | 'photo'
  | 'video'
  | 'voice'
  | 'animation'

export interface TelegramAttachmentDescriptor {
  updateId: number
  messageId: number
  chatId: number
  unixSeconds: number
  kind: TelegramAttachmentKind
  telegramFileId: string
  telegramFileUniqueId?: string
  originalName: string
  declaredSizeBytes?: number
}

export interface TelegramAttachmentDownload {
  body: AsyncIterable<Uint8Array>
  sizeBytes?: number
}

export interface TelegramAttachmentDownloadPort {
  download(telegramFileId: string): Promise<TelegramAttachmentDownload>
}

export interface TelegramAttachmentInbox {
  ingest(input: {
    binding: ResolvedWorkBinding
    attachment: TelegramAttachmentDescriptor
  }): Promise<InboxAttachmentV1>
}

export interface SingletonTelegramAttachmentInbox {
  readonly inbox: TelegramAttachmentInbox
  close(): void
}

export type TelegramAttachmentInboxFault =
  | 'after-download-temp'
  | 'after-object'
  | 'after-record'

export class TelegramAttachmentInboxError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'AUTHZ_REJECTED'
    | 'LIMIT_EXCEEDED'
    | 'DOWNLOAD_FAILED'
    | 'SIZE_MISMATCH'
    | 'STATE_CONFLICT'
    | 'STATE_CORRUPT'
    | 'WRITER_LOCK_HELD'
    | 'WRITER_BUSY'
    | 'UNSUPPORTED_PLATFORM') {
    super(code)
    this.name = 'TelegramAttachmentInboxError'
  }
}

interface InboxWriterToken {
  readonly version: 1
  readonly pid: number
  readonly nonce: string
  readonly acquiredAt: string
}

const MAX_WRITER_OWNER_BYTES = 4096

function encodeWriterToken(token: InboxWriterToken): string {
  return JSON.stringify(token) + '\n'
}

function readWriterOwner(path: string): string {
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | noFollow()) } catch {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  try {
    const info = fstatSync(descriptor)
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.nlink !== 1 || info.uid !== expectedUid ||
      (info.mode & 0o077) !== 0 || info.size > MAX_WRITER_OWNER_BYTES) {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
    return readFileSync(descriptor, 'utf8')
  } catch (error) {
    if (error instanceof TelegramAttachmentInboxError) throw error
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  } finally {
    try { closeSync(descriptor) } catch {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
  }
}

function acquireInboxWriter(root: string, input: {
  nowIso: () => string
  newNonce: () => string
  pid: number
}): { assertHeld(): void; release(): void } {
  const lockPath = join(root, '.writer.lock')
  const ownerPath = join(lockPath, 'owner.json')
  try {
    mkdirSync(lockPath, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TelegramAttachmentInboxError('WRITER_LOCK_HELD')
    }
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  let encoded = ''
  let ownerCreated = false
  try {
    const nonce = input.newNonce()
    const acquiredAt = input.nowIso()
    if (!Number.isSafeInteger(input.pid) || input.pid < 1 || !safeText(nonce, 256) ||
      !safeText(acquiredAt, 128) || !Number.isFinite(Date.parse(acquiredAt))) {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
    const token: InboxWriterToken = Object.freeze({
      version: 1,
      pid: input.pid,
      nonce,
      acquiredAt,
    })
    encoded = encodeWriterToken(token)
    if (Buffer.byteLength(encoded, 'utf8') > MAX_WRITER_OWNER_BYTES) {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
    const descriptor = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
    ownerCreated = true
    try {
      writeFileSync(descriptor, encoded, 'utf8')
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    syncPath(lockPath)
    syncPath(root)
  } catch (error) {
    if (ownerCreated) {
      try { unlinkSync(ownerPath) } catch { /* preserve initialization failure */ }
    }
    try { rmdirSync(lockPath) } catch { /* doctor will recover an ambiguous lock */ }
    if (error instanceof TelegramAttachmentInboxError) throw error
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  let released = false
  return Object.freeze({
    assertHeld() {
      if (released || readWriterOwner(ownerPath) !== encoded) {
        throw new TelegramAttachmentInboxError('STATE_CORRUPT')
      }
    },
    release() {
      if (released) return
      if (readWriterOwner(ownerPath) !== encoded) {
        throw new TelegramAttachmentInboxError('STATE_CORRUPT')
      }
      try {
        unlinkSync(ownerPath)
        syncPath(lockPath)
        rmdirSync(lockPath)
        syncPath(root)
        released = true
      } catch {
        throw new TelegramAttachmentInboxError('STATE_CORRUPT')
      }
    },
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    ![...value].some(character => character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127) && Buffer.byteLength(value, 'utf8') <= maximum
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function snapshotBinding(value: unknown): ResolvedWorkBinding {
  try { return Object.freeze(resolvedWorkBinding(structuredClone(value))) } catch {
    throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  }
}

function snapshotAttachment(value: unknown): Readonly<TelegramAttachmentDescriptor> {
  const input = record(value)
  if (input === null) throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  const required = new Set([
    'updateId', 'messageId', 'chatId', 'unixSeconds', 'kind', 'telegramFileId', 'originalName',
  ])
  const optional = new Set(['telegramFileUniqueId', 'declaredSizeBytes'])
  if (Object.keys(input).some(key => !required.has(key) && !optional.has(key)) ||
    [...required].some(key => !(key in input)) || !natural(input['updateId']) ||
    !natural(input['messageId']) || !Number.isSafeInteger(input['chatId']) ||
    !natural(input['unixSeconds']) ||
    !['document', 'audio', 'photo', 'video', 'voice', 'animation'].includes(
      String(input['kind']),
    ) || !safeText(input['telegramFileId'], MAX_FILE_ID_BYTES) ||
    !safeText(input['originalName'], MAX_ORIGINAL_NAME_BYTES) ||
    (input['telegramFileUniqueId'] !== undefined &&
      !safeText(input['telegramFileUniqueId'], MAX_FILE_ID_BYTES)) ||
    (input['declaredSizeBytes'] !== undefined && !natural(input['declaredSizeBytes']))) {
    throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  }
  const receivedAt = new Date((input['unixSeconds'] as number) * 1000)
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  }
  return Object.freeze({
    updateId: input['updateId'] as number,
    messageId: input['messageId'] as number,
    chatId: input['chatId'] as number,
    unixSeconds: input['unixSeconds'] as number,
    kind: input['kind'] as TelegramAttachmentKind,
    telegramFileId: input['telegramFileId'] as string,
    ...(input['telegramFileUniqueId'] === undefined
      ? {} : { telegramFileUniqueId: input['telegramFileUniqueId'] as string }),
    originalName: input['originalName'] as string,
    ...(input['declaredSizeBytes'] === undefined
      ? {} : { declaredSizeBytes: input['declaredSizeBytes'] as number }),
  })
}

function attachmentObject(message: Record<string, unknown>): {
  kind: TelegramAttachmentKind
  value: Record<string, unknown>
} | null {
  for (const kind of ['document', 'audio', 'video', 'voice', 'animation'] as const) {
    const value = record(message[kind])
    if (value !== null) return { kind, value }
  }
  if (Array.isArray(message['photo'])) {
    const candidates = message['photo'].map(record).filter(value => value !== null)
    const value = candidates
      .filter(candidate => safeText(candidate['file_id'], MAX_FILE_ID_BYTES))
      .sort((left, right) => {
        const leftSize = natural(left['file_size']) ? left['file_size'] : 0
        const rightSize = natural(right['file_size']) ? right['file_size'] : 0
        return leftSize - rightSize
      }).at(-1)
    if (value !== undefined) return { kind: 'photo', value }
  }
  return null
}

function fallbackName(kind: TelegramAttachmentKind, messageId: number): string {
  const extension: Record<TelegramAttachmentKind, string> = {
    document: 'bin',
    audio: 'audio',
    photo: 'jpg',
    video: 'mp4',
    voice: 'ogg',
    animation: 'mp4',
  }
  return `${kind}-${messageId}.${extension[kind]}`
}

/** Pure Telegram update parser. It never downloads bytes or assigns trust. */
export function parseTelegramAttachmentUpdate(
  update: TelegramUpdate,
): TelegramAttachmentDescriptor | null {
  const message = record(update['message'])
  const updateId = update['update_id']
  const messageId = message?.['message_id']
  const unixSeconds = message?.['date']
  const chatId = record(message?.['chat'])?.['id']
  if (message === null || !natural(updateId) || !natural(messageId) ||
    !natural(unixSeconds) || !Number.isSafeInteger(chatId)) return null
  const selected = attachmentObject(message)
  if (selected === null) return null
  const telegramFileId = selected.value['file_id']
  if (!safeText(telegramFileId, MAX_FILE_ID_BYTES)) return null
  const unique = selected.value['file_unique_id']
  if (unique !== undefined && !safeText(unique, MAX_FILE_ID_BYTES)) return null
  const size = selected.value['file_size']
  if (size !== undefined && !natural(size)) return null
  const rawName = selected.value['file_name']
  const originalName = safeText(rawName, MAX_ORIGINAL_NAME_BYTES)
    ? rawName
    : fallbackName(selected.kind, messageId)
  const receivedAt = new Date(unixSeconds * 1000)
  if (!Number.isFinite(receivedAt.getTime())) return null
  return {
    updateId,
    messageId,
    chatId: chatId as number,
    unixSeconds,
    kind: selected.kind,
    telegramFileId,
    ...(typeof unique === 'string' ? { telegramFileUniqueId: unique } : {}),
    originalName,
    ...(typeof size === 'number' ? { declaredSizeBytes: size } : {}),
  }
}

function ensureDirectory(path: string): void {
  const canonical = resolve(path)
  let ancestor = canonical
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    ancestor = parent
  }
  const ancestorInfo = lstatSync(ancestor)
  if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink() ||
    realpathSync(ancestor) !== ancestor) {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  mkdirSync(canonical, { recursive: true, mode: 0o700 })
  const finalInfo = lstatSync(canonical)
  if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink() ||
    realpathSync(canonical) !== canonical) {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  chmodSync(canonical, 0o700)
}

function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new TelegramAttachmentInboxError('UNSUPPORTED_PLATFORM')
  }
  return constants.O_NOFOLLOW
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | noFollow())
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
}

function strictFile(path: string, expectedLinks = 1): ReturnType<typeof lstatSync> {
  let info: ReturnType<typeof lstatSync>
  try { info = lstatSync(path) } catch {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== expectedLinks) {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  return info
}

function digestFile(path: string, maximum: number): { sha256: string; sizeBytes: number } {
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | noFollow()) } catch {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1) {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
    if (info.size > maximum) throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maximum + 1))
    let sizeBytes = 0
    while (true) {
      const length = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (length === 0) break
      sizeBytes += length
      if (sizeBytes > maximum) throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
      hash.update(buffer.subarray(0, length))
    }
    return { sha256: hash.digest('hex'), sizeBytes }
  } finally {
    closeSync(descriptor)
  }
}

function readInboxRecord(path: string): InboxAttachmentV1 | null {
  if (!entryExists(path)) return null
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | noFollow()) } catch {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONTROL_BYTES) {
      throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    }
    const parsed = parseInboxAttachment(JSON.parse(readFileSync(descriptor, 'utf8')))
    if (parsed === null) throw new TelegramAttachmentInboxError('STATE_CORRUPT')
    return parsed
  } catch (error) {
    if (error instanceof TelegramAttachmentInboxError) throw error
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  } finally {
    closeSync(descriptor)
  }
}

function encodeRecord(value: InboxAttachmentV1): string {
  const encoded = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CONTROL_BYTES) {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  return encoded
}

function createRecordOnce(path: string, value: InboxAttachmentV1): void {
  const directory = dirname(path)
  const temporary = `${path}.create-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, encodeRecord(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    try {
      linkSync(temporary, path)
      syncPath(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readInboxRecord(path)
      if (existing === null || !isDeepStrictEqual(existing, value)) {
        throw new TelegramAttachmentInboxError('STATE_CONFLICT')
      }
    }
  } finally {
    cleanupTemporary(temporary, path, directory)
  }
}

export function telegramAttachmentIdentity(
  binding: ResolvedWorkBinding,
  attachment: TelegramAttachmentDescriptor,
): { fileId: string; provenanceRef: string; receivedAt: string } {
  const sourceFingerprint = createHash('sha256').update(JSON.stringify([
    attachment.kind,
    attachment.telegramFileUniqueId ?? attachment.telegramFileId,
  ])).digest('hex')
  const digest = createHash('sha256').update(JSON.stringify([
    'aisy.telegram-attachment.v1',
    binding.operatorId,
    binding.profileId,
    binding.sessionId,
    attachment.updateId,
    attachment.messageId,
    attachment.kind,
    sourceFingerprint,
  ])).digest('hex')
  return {
    fileId: `tg-${digest}`,
    provenanceRef: `telegram:update:${attachment.updateId}:message:${attachment.messageId}:` +
      `${attachment.kind}:${sourceFingerprint.slice(0, 16)}`,
    receivedAt: new Date(attachment.unixSeconds * 1000).toISOString(),
  }
}

function sameAuthority(
  recordValue: InboxAttachmentV1,
  binding: ResolvedWorkBinding,
  attachment: TelegramAttachmentDescriptor,
  identity: ReturnType<typeof telegramAttachmentIdentity>,
): boolean {
  return recordValue.fileId === identity.fileId &&
    recordValue.operatorId === binding.operatorId &&
    recordValue.profileId === binding.profileId &&
    recordValue.sessionId === binding.sessionId &&
    recordValue.source === 'telegram' &&
    recordValue.originalName === attachment.originalName &&
    recordValue.provenanceRef === identity.provenanceRef &&
    recordValue.receivedAt === identity.receivedAt &&
    (attachment.declaredSizeBytes === undefined ||
      attachment.declaredSizeBytes === recordValue.sizeBytes)
}

function cleanupTemporary(temporary: string, final: string, directory: string): void {
  if (!entryExists(temporary)) return
  const tempInfo = lstatSync(temporary)
  if (entryExists(final)) {
    const finalInfo = lstatSync(final)
    if (tempInfo.isFile() && finalInfo.isFile() && tempInfo.nlink === 2 &&
      finalInfo.nlink === 2 && tempInfo.dev === finalInfo.dev && tempInfo.ino === finalInfo.ino) {
      unlinkSync(temporary)
      syncPath(directory)
      return
    }
  }
  strictFile(temporary)
  unlinkSync(temporary)
  syncPath(directory)
}

async function writeDownload(
  path: string,
  download: TelegramAttachmentDownload,
  maximum: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
  } catch {
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    for await (const rawChunk of download.body) {
      if (!(rawChunk instanceof Uint8Array)) {
        throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
      }
      const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength)
      sizeBytes += chunk.byteLength
      if (sizeBytes > maximum) throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = writeSync(descriptor, chunk, offset, chunk.byteLength - offset)
        if (written <= 0) throw new TelegramAttachmentInboxError('STATE_CORRUPT')
        offset += written
      }
    }
    fsyncSync(descriptor)
    return { sha256: hash.digest('hex'), sizeBytes }
  } catch (error) {
    if (error instanceof TelegramAttachmentInboxError) throw error
    throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
  } finally {
    closeSync(descriptor)
  }
}

export function makeTelegramAttachmentInbox(input: {
  inboxRoot: string
  allowedChatId: number
  maxAttachmentBytes: number
  download: TelegramAttachmentDownloadPort
  faultAt?: (point: TelegramAttachmentInboxFault) => void
}): TelegramAttachmentInbox {
  if (!Number.isSafeInteger(input.allowedChatId) ||
    !Number.isSafeInteger(input.maxAttachmentBytes) || input.maxAttachmentBytes < 1) {
    throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  }
  const root = resolve(input.inboxRoot)
  const objectsRoot = join(root, 'objects')
  const recordsRoot = join(root, 'records')
  try {
    for (const directory of [root, objectsRoot, recordsRoot]) ensureDirectory(directory)
  } catch (error) {
    if (error instanceof TelegramAttachmentInboxError) throw error
    throw new TelegramAttachmentInboxError('STATE_CORRUPT')
  }
  const tails = new Map<string, Promise<void>>()
  const serialize = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolvePromise => { release = resolvePromise })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try { return await work() } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

  return Object.freeze<TelegramAttachmentInbox>({
    async ingest({ binding, attachment }) {
      const bound = snapshotBinding(binding)
      const media = snapshotAttachment(attachment)
      if (media.chatId !== input.allowedChatId) {
        throw new TelegramAttachmentInboxError('AUTHZ_REJECTED')
      }
      const identity = telegramAttachmentIdentity(bound, media)
      try {
        return await serialize(identity.fileId, async () => {
          if (media.declaredSizeBytes !== undefined &&
            media.declaredSizeBytes > input.maxAttachmentBytes) {
            throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
          }
          const objectPath = join(objectsRoot, identity.fileId)
          const recordPath = join(recordsRoot, `${identity.fileId}.json`)
          const temporary = join(objectsRoot, `.aisy-inbox-${identity.fileId}.tmp`)
          cleanupTemporary(temporary, objectPath, objectsRoot)
          const existingRecord = readInboxRecord(recordPath)
          if (existingRecord !== null) {
            if (!sameAuthority(existingRecord, bound, media, identity) ||
              !entryExists(objectPath)) throw new TelegramAttachmentInboxError('STATE_CONFLICT')
            const actual = digestFile(objectPath, input.maxAttachmentBytes)
            if (actual.sha256 !== existingRecord.sha256 ||
              actual.sizeBytes !== existingRecord.sizeBytes) {
              throw new TelegramAttachmentInboxError('STATE_CORRUPT')
            }
            return existingRecord
          }

          let downloaded: TelegramAttachmentDownload
          try { downloaded = await input.download.download(media.telegramFileId) } catch (error) {
            if (error instanceof TelegramAttachmentInboxError) throw error
            throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
          }
          if (downloaded.sizeBytes !== undefined &&
            (!natural(downloaded.sizeBytes) || downloaded.sizeBytes > input.maxAttachmentBytes)) {
            throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
          }
          if (media.declaredSizeBytes !== undefined && downloaded.sizeBytes !== undefined &&
            media.declaredSizeBytes !== downloaded.sizeBytes) {
            throw new TelegramAttachmentInboxError('SIZE_MISMATCH')
          }
          let actual: { sha256: string; sizeBytes: number }
          try {
            actual = await writeDownload(temporary, downloaded, input.maxAttachmentBytes)
            input.faultAt?.('after-download-temp')
            if (media.declaredSizeBytes !== undefined &&
              actual.sizeBytes !== media.declaredSizeBytes) {
              throw new TelegramAttachmentInboxError('SIZE_MISMATCH')
            }
            if (downloaded.sizeBytes !== undefined && actual.sizeBytes !== downloaded.sizeBytes) {
              throw new TelegramAttachmentInboxError('SIZE_MISMATCH')
            }
            if (entryExists(objectPath)) {
              const existing = digestFile(objectPath, input.maxAttachmentBytes)
              if (existing.sha256 !== actual.sha256 || existing.sizeBytes !== actual.sizeBytes) {
                throw new TelegramAttachmentInboxError('STATE_CONFLICT')
              }
            } else {
              try {
                linkSync(temporary, objectPath)
                syncPath(objectsRoot)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                const existing = digestFile(objectPath, input.maxAttachmentBytes)
                if (existing.sha256 !== actual.sha256 || existing.sizeBytes !== actual.sizeBytes) {
                  throw new TelegramAttachmentInboxError('STATE_CONFLICT')
                }
              }
            }
          } finally {
            cleanupTemporary(temporary, objectPath, objectsRoot)
          }
          input.faultAt?.('after-object')
          const inboxRecord = parseInboxAttachment({
            schemaVersion: 1,
            fileId: identity.fileId,
            operatorId: bound.operatorId,
            profileId: bound.profileId,
            sessionId: bound.sessionId,
            source: 'telegram',
            originalName: media.originalName,
            sha256: actual.sha256,
            sizeBytes: actual.sizeBytes,
            provenanceRef: identity.provenanceRef,
            receivedAt: identity.receivedAt,
          })
          if (inboxRecord === null) throw new TelegramAttachmentInboxError('INVALID_REQUEST')
          createRecordOnce(recordPath, inboxRecord)
          input.faultAt?.('after-record')
          return inboxRecord
        })
      } catch (error) {
        if (error instanceof TelegramAttachmentInboxError ||
          !(error instanceof Error) || !('code' in error)) throw error
        throw new TelegramAttachmentInboxError('STATE_CORRUPT')
      }
    },
  })
}

/**
 * Process-lifetime writer ownership for the durable media inbox. The lock is
 * never reclaimed by age or PID: an abandoned lock requires explicit doctor
 * recovery so a second process cannot guess that the first writer is dead.
 */
export function makeSingletonTelegramAttachmentInbox(input: {
  inboxRoot: string
  allowedChatId: number
  maxAttachmentBytes: number
  download: TelegramAttachmentDownloadPort
  faultAt?: (point: TelegramAttachmentInboxFault) => void
  nowIso?: () => string
  newNonce?: () => string
  pid?: number
}): SingletonTelegramAttachmentInbox {
  const inbox = makeTelegramAttachmentInbox(input)
  const writer = acquireInboxWriter(resolve(input.inboxRoot), {
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
    newNonce: input.newNonce ?? randomUUID,
    pid: input.pid ?? process.pid,
  })
  let active = 0
  let closed = false
  const guardedInbox = Object.freeze<TelegramAttachmentInbox>({
    async ingest(request) {
      if (closed) throw new TelegramAttachmentInboxError('STATE_CORRUPT')
      writer.assertHeld()
      active += 1
      try { return await inbox.ingest(request) } finally { active -= 1 }
    },
  })
  return Object.freeze<SingletonTelegramAttachmentInbox>({
    inbox: guardedInbox,
    close() {
      if (closed) return
      if (active !== 0) throw new TelegramAttachmentInboxError('WRITER_BUSY')
      writer.release()
      closed = true
    },
  })
}

/** Transport seam: parse one Telegram media update and persist it without a model turn. */
export async function ingestTelegramAttachmentUpdate(input: {
  inbox: TelegramAttachmentInbox
  binding: ResolvedWorkBinding
  update: TelegramUpdate
}): Promise<InboxAttachmentV1> {
  const attachment = parseTelegramAttachmentUpdate(input.update)
  if (attachment === null) throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  return input.inbox.ingest({ binding: input.binding, attachment })
}

interface TelegramFetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: AsyncIterable<Uint8Array> | null
}

export type TelegramFetchPort = (
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; redirect: 'error' },
) => Promise<TelegramFetchResponse>

async function readBoundedResponse(
  response: TelegramFetchResponse,
  maximum: number,
): Promise<Uint8Array> {
  if (response.body === null) throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
  const chunks: Buffer[] = []
  let total = 0
  for await (const rawChunk of response.body) {
    if (!(rawChunk instanceof Uint8Array)) {
      throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
    }
    const chunk = Buffer.from(rawChunk.buffer, rawChunk.byteOffset, rawChunk.byteLength)
    total += chunk.byteLength
    if (total > maximum) throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeTelegramPath(value: unknown): value is string {
  if (!safeText(value, MAX_FILE_ID_BYTES) || value.startsWith('/')) return false
  const parts = value.split('/')
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Official Bot API adapter. Errors are deliberately redacted and never include the token. */
export function makeTelegramBotApiAttachmentDownloadPort(input: {
  token: string
  fetch?: TelegramFetchPort
}): TelegramAttachmentDownloadPort {
  if (!BOT_TOKEN.test(input.token)) throw new TelegramAttachmentInboxError('INVALID_REQUEST')
  const fetchPort: TelegramFetchPort = input.fetch ?? (async (url, init) => {
    return globalThis.fetch(url, init) as unknown as Promise<TelegramFetchResponse>
  })
  const apiRoot = 'https://api.telegram.org'
  return Object.freeze<TelegramAttachmentDownloadPort>({
    async download(telegramFileId) {
      if (!safeText(telegramFileId, MAX_FILE_ID_BYTES)) {
        throw new TelegramAttachmentInboxError('INVALID_REQUEST')
      }
      try {
        const metadata = await fetchPort(`${apiRoot}/bot${input.token}/getFile`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ file_id: telegramFileId }).toString(),
          redirect: 'error',
        })
        if (!metadata.ok) throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
        const parsed = JSON.parse(new TextDecoder().decode(
          await readBoundedResponse(metadata, MAX_GET_FILE_RESPONSE_BYTES),
        )) as unknown
        const envelope = record(parsed)
        const result = record(envelope?.['result'])
        const filePath = result?.['file_path']
        const fileSize = result?.['file_size']
        if (envelope?.['ok'] !== true || result === null || !safeTelegramPath(filePath) ||
          (fileSize !== undefined && !natural(fileSize))) {
          throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
        }
        if (typeof fileSize === 'number' && fileSize > TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES) {
          throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
        }
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
        const response = await fetchPort(`${apiRoot}/file/bot${input.token}/${encodedPath}`, {
          method: 'GET',
          redirect: 'error',
        })
        if (!response.ok || response.body === null) {
          throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
        }
        const contentLength = response.headers.get('content-length')
        const headerSize = contentLength === null ? undefined : Number(contentLength)
        if (headerSize !== undefined && !natural(headerSize)) {
          throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
        }
        if (headerSize !== undefined && headerSize > TELEGRAM_BOT_API_MAX_DOWNLOAD_BYTES) {
          throw new TelegramAttachmentInboxError('LIMIT_EXCEEDED')
        }
        if (typeof fileSize === 'number' && headerSize !== undefined && fileSize !== headerSize) {
          throw new TelegramAttachmentInboxError('SIZE_MISMATCH')
        }
        return {
          body: response.body,
          ...(typeof fileSize === 'number'
            ? { sizeBytes: fileSize }
            : headerSize === undefined ? {} : { sizeBytes: headerSize }),
        }
      } catch (error) {
        if (error instanceof TelegramAttachmentInboxError) throw error
        throw new TelegramAttachmentInboxError('DOWNLOAD_FAILED')
      }
    },
  })
}

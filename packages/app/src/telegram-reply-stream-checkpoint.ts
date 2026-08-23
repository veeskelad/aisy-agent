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
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ActivityBinding } from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_BYTES = 64 * 1024
const KEYS = new Set([
  'schemaVersion', 'bindingHash', 'dispatchId', 'ownerId', 'revision', 'phase',
  'delivery', 'messageId', 'locked', 'replyHash', 'document', 'updatedAt', 'checksum',
])
const INSPECTION_KEYS = new Set([
  'path', 'trustedRoot', 'bindingHash', 'dispatchId', 'ownerId', 'replyHash',
])

export type TelegramReplyPhase = 'prepared' | 'bound' | 'terminal'
export type TelegramReplyDelivery = 'pending' | 'delivered'
export type TelegramReplyDocumentDelivery = 'none' | 'pending' | 'delivered'

export interface TelegramReplyCheckpointV1 {
  readonly schemaVersion: 1
  readonly bindingHash: string
  readonly dispatchId: string
  readonly ownerId: string
  readonly revision: number
  readonly phase: TelegramReplyPhase
  readonly delivery: TelegramReplyDelivery
  readonly messageId?: number
  readonly locked: boolean
  readonly replyHash?: string
  readonly document: TelegramReplyDocumentDelivery
  readonly updatedAt: string
  readonly checksum: string
}

export type TelegramReplyCheckpointLoad =
  | { status: 'missing' }
  | { status: 'ready'; checkpoint: TelegramReplyCheckpointV1 }
  | { status: 'quarantined' }

export interface TelegramReplyCheckpointStore {
  load(): TelegramReplyCheckpointLoad
  begin(checkpoint: TelegramReplyCheckpointV1): void
  replace(checkpoint: TelegramReplyCheckpointV1, expected: {
    bindingHash: string
    dispatchId: string
    ownerId: string
    revision: number
  }): void
}

export interface TelegramReplyCheckpointAuthorityV1 {
  readonly bindingHash: string
  readonly dispatchId: string
  readonly ownerId: string
  assertHeld(): boolean
}

const NODE_STORE_CAPABILITIES = new WeakMap<TelegramReplyCheckpointStore, Readonly<{
  path: string
  trustedRoot: string
  identities: readonly PrivateDirectoryIdentity[]
}>>()
const BOUND_AUTHORITIES = new WeakSet<TelegramReplyCheckpointAuthorityV1>()

export type TelegramReplyRecoveryResult =
  | { kind: 'none' }
  | { kind: 'delivery-uncertain'; code: 'DELIVERY_UNCERTAIN'; messageId?: number }
  | { kind: 'denied'; code: 'BINDING_MISMATCH' }
  | { kind: 'quarantined'; code: 'REPLY_CHECKPOINT_QUARANTINED' }

export interface TelegramReplyDeliveryReceiptV1 {
  readonly schemaVersion: 1
  readonly bindingHash: string
  readonly dispatchId: string
  readonly ownerId: string
  readonly revision: number
  readonly messageId: number
  readonly replyHash: string
  readonly document: Exclude<TelegramReplyDocumentDelivery, 'pending'>
  readonly checkpointChecksum: string
}

export type TelegramReplyCheckpointInspectionV1 =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'delivered'; receipt: TelegramReplyDeliveryReceiptV1 }>
  | Readonly<{
      kind: 'delivery-uncertain'
      code: 'DELIVERY_UNCERTAIN'
      revision: number
      messageId?: number
    }>
  | Readonly<{ kind: 'denied'; code: 'REPLY_CHECKPOINT_IDENTITY_MISMATCH' }>
  | Readonly<{ kind: 'quarantined'; code: 'REPLY_CHECKPOINT_QUARANTINED' }>

export function makeTelegramReplyCheckpointAuthority(input: Readonly<{
  bindingHash: string
  dispatchId: string
  ownerId: string
  assertHeld(): boolean
}>): TelegramReplyCheckpointAuthorityV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('REPLY_CHECKPOINT_AUTHORITY_INVALID')
  }
  let bindingHash: unknown
  let dispatchId: unknown
  let ownerId: unknown
  let assertHeld: unknown
  try {
    bindingHash = input.bindingHash
    dispatchId = input.dispatchId
    ownerId = input.ownerId
    assertHeld = input.assertHeld
  } catch {
    throw new Error('REPLY_CHECKPOINT_AUTHORITY_INVALID')
  }
  if (typeof bindingHash !== 'string' || !HASH.test(bindingHash) ||
    typeof dispatchId !== 'string' || !HASH.test(dispatchId) ||
    typeof ownerId !== 'string' || !OWNER.test(ownerId) || typeof assertHeld !== 'function') {
    throw new Error('REPLY_CHECKPOINT_AUTHORITY_INVALID')
  }
  const authority = Object.freeze<TelegramReplyCheckpointAuthorityV1>({
    bindingHash,
    dispatchId,
    ownerId,
    assertHeld: () => assertHeld() === true,
  })
  BOUND_AUTHORITIES.add(authority)
  return authority
}

export type TelegramReplyReleaseConfirmationV1 =
  | Readonly<{ kind: 'unavailable' }>
  | TelegramReplyCheckpointInspectionV1

export function confirmTelegramReplyCheckpointForSupervisorRelease(input: Readonly<{
  store: TelegramReplyCheckpointStore
  authority: TelegramReplyCheckpointAuthorityV1 | undefined
  bindingHash: string
  dispatchId: string
  ownerId: string
  expectedReceipt: TelegramReplyDeliveryReceiptV1
}>): TelegramReplyReleaseConfirmationV1 {
  const capability = NODE_STORE_CAPABILITIES.get(input.store)
  if (capability === undefined || input.authority === undefined) return Object.freeze({ kind: 'unavailable' })
  if (!BOUND_AUTHORITIES.has(input.authority) || input.authority.bindingHash !== input.bindingHash ||
    input.authority.dispatchId !== input.dispatchId || input.authority.ownerId !== input.ownerId) {
    return Object.freeze({ kind: 'denied', code: 'REPLY_CHECKPOINT_IDENTITY_MISMATCH' })
  }
  const uncertain = (): TelegramReplyCheckpointInspectionV1 => Object.freeze({
    kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
    revision: input.expectedReceipt.revision, messageId: input.expectedReceipt.messageId,
  })
  try {
    if (!input.authority.assertHeld()) return uncertain()
  } catch {
    return uncertain()
  }
  if (!privateDirectoryChainIsUnchanged(capability.identities)) {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  const inspected = inspectNodeTelegramReplyCheckpointForSupervisorRelease({
    path: capability.path,
    trustedRoot: capability.trustedRoot,
    bindingHash: input.bindingHash,
    dispatchId: input.dispatchId,
    ownerId: input.ownerId,
    replyHash: input.expectedReceipt.replyHash,
  })
  if (!privateDirectoryChainIsUnchanged(capability.identities)) {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  try {
    if (!input.authority.assertHeld()) return uncertain()
  } catch {
    return uncertain()
  }
  if (inspected.kind !== 'delivered') return inspected
  const expected = input.expectedReceipt
  const actual = inspected.receipt
  if (actual.schemaVersion !== expected.schemaVersion || actual.bindingHash !== expected.bindingHash ||
    actual.dispatchId !== expected.dispatchId || actual.ownerId !== expected.ownerId ||
    actual.revision !== expected.revision || actual.messageId !== expected.messageId ||
    actual.replyHash !== expected.replyHash || actual.document !== expected.document ||
    actual.checkpointChecksum !== expected.checkpointChecksum) {
    return Object.freeze({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
      revision: actual.revision, messageId: actual.messageId,
    })
  }
  return inspected
}

export function isTelegramReplyCheckpointAuthorityGenuine(
  authority: TelegramReplyCheckpointAuthorityV1,
): boolean {
  return BOUND_AUTHORITIES.has(authority)
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function body(value: TelegramReplyCheckpointV1): Omit<TelegramReplyCheckpointV1, 'checksum'> {
  const { checksum: _, ...rest } = value
  return rest
}

export function computeTelegramReplyCheckpointChecksum(value: TelegramReplyCheckpointV1): string {
  return createHash('sha256')
    .update('aisy.telegram.reply-checkpoint.v1\0')
    .update(JSON.stringify(body(value)))
    .digest('hex')
}

export function makeTelegramReplyBindingHash(input: {
  binding: ActivityBinding
  chatBindingHash: string
  dispatchId: string
}): string {
  const binding = input.binding
  if (!HASH.test(input.chatBindingHash) || !HASH.test(input.dispatchId) ||
    [binding.operatorId, binding.profileId, binding.projectId, binding.sessionId]
      .some(value => typeof value !== 'string' || value.length < 1 || value.length > 128)) {
    throw new Error('REPLY_CHECKPOINT_BINDING_INVALID')
  }
  return createHash('sha256').update(JSON.stringify([
    'aisy.telegram.reply-binding.v1', binding.operatorId, binding.profileId,
    binding.projectId, binding.sessionId, input.chatBindingHash, input.dispatchId,
  ])).digest('hex')
}

export function replyContentHash(reply: string): string {
  return createHash('sha256').update('aisy.telegram.reply-content.v1\0').update(reply).digest('hex')
}

export function validateTelegramReplyCheckpoint(value: unknown): TelegramReplyCheckpointV1 {
  const record = object(value)
  if (record === null || Object.keys(record).some(key => !KEYS.has(key)) ||
    record['schemaVersion'] !== 1 || typeof record['bindingHash'] !== 'string' ||
    !HASH.test(record['bindingHash']) || typeof record['dispatchId'] !== 'string' ||
    !HASH.test(record['dispatchId']) || typeof record['ownerId'] !== 'string' ||
    !OWNER.test(record['ownerId']) || !Number.isSafeInteger(record['revision']) ||
    Number(record['revision']) < 1 || !['prepared', 'bound', 'terminal'].includes(String(record['phase'])) ||
    !['pending', 'delivered'].includes(String(record['delivery'])) ||
    typeof record['locked'] !== 'boolean' ||
    (record['replyHash'] !== undefined && (typeof record['replyHash'] !== 'string' || !HASH.test(record['replyHash']))) ||
    !['none', 'pending', 'delivered'].includes(String(record['document'])) ||
    typeof record['updatedAt'] !== 'string' || !ISO.test(record['updatedAt']) ||
    new Date(record['updatedAt']).toISOString() !== record['updatedAt'] ||
    typeof record['checksum'] !== 'string' || !HASH.test(record['checksum'])) {
    throw new Error('REPLY_CHECKPOINT_INVALID')
  }
  const checkpoint = structuredClone(value) as TelegramReplyCheckpointV1
  if ((checkpoint.phase === 'prepared') !== (checkpoint.messageId === undefined) ||
    (checkpoint.messageId !== undefined && (!Number.isSafeInteger(checkpoint.messageId) || checkpoint.messageId < 1)) ||
    (checkpoint.delivery === 'delivered' && checkpoint.messageId === undefined) ||
    (checkpoint.phase === 'terminal' && checkpoint.replyHash === undefined) ||
    (checkpoint.phase !== 'terminal' && checkpoint.document !== 'none') ||
    (checkpoint.document === 'delivered' && checkpoint.delivery !== 'delivered') ||
    (checkpoint.locked && (checkpoint.replyHash !== undefined || checkpoint.messageId !== undefined)) ||
    computeTelegramReplyCheckpointChecksum(checkpoint) !== checkpoint.checksum) {
    throw new Error('REPLY_CHECKPOINT_INVALID')
  }
  return Object.freeze(checkpoint)
}

export function makeTelegramReplyCheckpoint(input: Omit<TelegramReplyCheckpointV1, 'schemaVersion' | 'checksum'>): TelegramReplyCheckpointV1 {
  const candidate: TelegramReplyCheckpointV1 = { schemaVersion: 1, ...structuredClone(input), checksum: '' }
  ;(candidate as { checksum: string }).checksum = computeTelegramReplyCheckpointChecksum(candidate)
  return validateTelegramReplyCheckpoint(candidate)
}

function active(checkpoint: TelegramReplyCheckpointV1): boolean {
  return checkpoint.phase !== 'terminal' || checkpoint.delivery !== 'delivered' ||
    checkpoint.document === 'pending'
}

export function makeTelegramReplyDeliveryReceipt(
  value: TelegramReplyCheckpointV1,
): TelegramReplyDeliveryReceiptV1 | null {
  const checkpoint = validateTelegramReplyCheckpoint(value)
  if (checkpoint.phase !== 'terminal' || checkpoint.delivery !== 'delivered' ||
    checkpoint.messageId === undefined || checkpoint.replyHash === undefined ||
    checkpoint.document === 'pending') return null
  return Object.freeze({
    schemaVersion: 1,
    bindingHash: checkpoint.bindingHash,
    dispatchId: checkpoint.dispatchId,
    ownerId: checkpoint.ownerId,
    revision: checkpoint.revision,
    messageId: checkpoint.messageId,
    replyHash: checkpoint.replyHash,
    document: checkpoint.document,
    checkpointChecksum: checkpoint.checksum,
  })
}

export function makeJsonTelegramReplyCheckpointStore(input: {
  exists(): boolean
  read(): string
  saveAtomic(content: string): void
}): TelegramReplyCheckpointStore {
  const load = (): TelegramReplyCheckpointLoad => {
    if (!input.exists()) return { status: 'missing' }
    try {
      const raw = input.read()
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('oversized')
      return { status: 'ready', checkpoint: validateTelegramReplyCheckpoint(JSON.parse(raw)) }
    } catch {
      return { status: 'quarantined' }
    }
  }
  const save = (checkpoint: TelegramReplyCheckpointV1): void => {
    input.saveAtomic(JSON.stringify(validateTelegramReplyCheckpoint(checkpoint), null, 2) + '\n')
  }
  return {
    load,
    begin(checkpoint) {
      const current = load()
      if (current.status === 'quarantined') throw new Error('REPLY_CHECKPOINT_QUARANTINED')
      if (current.status === 'ready' && active(current.checkpoint)) throw new Error('REPLY_CHECKPOINT_ACTIVE')
      if (checkpoint.revision !== 1 || checkpoint.phase !== 'prepared' || checkpoint.delivery !== 'pending') {
        throw new Error('REPLY_CHECKPOINT_TRANSITION_INVALID')
      }
      save(checkpoint)
    },
    replace(checkpoint, expected) {
      const current = load()
      if (current.status !== 'ready' || current.checkpoint.bindingHash !== expected.bindingHash ||
        current.checkpoint.dispatchId !== expected.dispatchId || current.checkpoint.ownerId !== expected.ownerId ||
        current.checkpoint.revision !== expected.revision || checkpoint.bindingHash !== expected.bindingHash ||
        checkpoint.dispatchId !== expected.dispatchId || checkpoint.ownerId !== expected.ownerId ||
        checkpoint.revision !== expected.revision + 1) {
        throw new Error('REPLY_CHECKPOINT_STALE_OWNER')
      }
      save(checkpoint)
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function readPrivate(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || (before.mode & 0o077) !== 0) {
    throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = fstatSync(descriptor)
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
      after.size > MAX_BYTES || (after.mode & 0o077) !== 0) throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
    return readFileSync(descriptor, 'utf8')
  } finally { closeSync(descriptor) }
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

interface PrivateDirectoryIdentity {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly uid: number
  readonly mode: number
}

type PrivateDirectoryChainInspection =
  | Readonly<{ state: 'ready'; identities: readonly PrivateDirectoryIdentity[] }>
  | Readonly<{
      state: 'absent'
      identities: readonly PrivateDirectoryIdentity[]
      missingPath: string
    }>
  | Readonly<{ state: 'unsafe' }>

function inspectPrivateDirectory(
  path: string,
  uid: number,
): Readonly<{ state: 'ready'; identity: PrivateDirectoryIdentity }> |
  Readonly<{ state: 'absent' }> | Readonly<{ state: 'unsafe' }> {
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o077) !== 0) return { state: 'unsafe' }
    return {
      state: 'ready',
      identity: { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode },
    }
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT' ? { state: 'absent' } : { state: 'unsafe' }
  }
}

function inspectPrivateDirectoryChain(
  trustedRoot: string,
  directory: string,
  uid: number,
): PrivateDirectoryChainInspection {
  const relativeDirectory = relative(trustedRoot, directory)
  if (relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)) return { state: 'unsafe' }
  let current = trustedRoot
  const identities: PrivateDirectoryIdentity[] = []
  const root = inspectPrivateDirectory(current, uid)
  if (root.state === 'absent') return { state: 'absent', identities, missingPath: current }
  if (root.state === 'unsafe') return root
  identities.push(root.identity)
  if (relativeDirectory === '') return { state: 'ready', identities }
  for (const component of relativeDirectory.split(sep)) {
    if (component.length === 0 || component === '.' || component === '..') {
      return { state: 'unsafe' }
    }
    current = join(current, component)
    const inspected = inspectPrivateDirectory(current, uid)
    if (inspected.state === 'absent') {
      return { state: 'absent', identities, missingPath: current }
    }
    if (inspected.state === 'unsafe') return inspected
    identities.push(inspected.identity)
  }
  return { state: 'ready', identities }
}

function privateDirectoryChainIsUnchanged(
  identities: readonly PrivateDirectoryIdentity[],
): boolean {
  for (const identity of identities) {
    try {
      const stat = lstatSync(identity.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev ||
        stat.ino !== identity.ino || stat.uid !== identity.uid || stat.mode !== identity.mode) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

function pathIsStillAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return nodeErrorCode(error) === 'ENOENT'
  }
}

function privateDirectoryAbsenceIsUnchanged(
  inspection: Extract<PrivateDirectoryChainInspection, { state: 'absent' }>,
): boolean {
  return privateDirectoryChainIsUnchanged(inspection.identities) &&
    pathIsStillAbsent(inspection.missingPath)
}

function readPrivateForInspection(path: string, uid: number): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid || before.nlink !== 1 ||
    before.size > MAX_BYTES || (before.mode & 0o077) !== 0) {
    throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1 ||
      opened.size > MAX_BYTES || (opened.mode & 0o077) !== 0 ||
      before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size ||
      before.mtimeMs !== opened.mtimeMs || before.ctimeMs !== opened.ctimeMs) {
      throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
    }
    const bounded = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    let eof = false
    while (bytes < bounded.length) {
      const count = readSync(descriptor, bounded, bytes, bounded.length - bytes, null)
      if (count === 0) {
        eof = true
        break
      }
      bytes += count
    }
    const after = fstatSync(descriptor)
    let published: ReturnType<typeof lstatSync>
    try { published = lstatSync(path) } catch {
      throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
    }
    if (!eof || bytes > MAX_BYTES || bytes !== opened.size || !after.isFile() ||
      after.uid !== opened.uid || after.nlink !== opened.nlink || after.mode !== opened.mode ||
      opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
      !published.isFile() || published.isSymbolicLink() || published.dev !== opened.dev ||
      published.ino !== opened.ino || published.uid !== opened.uid ||
      published.nlink !== opened.nlink || published.mode !== opened.mode ||
      published.size !== opened.size ||
      published.mtimeMs !== opened.mtimeMs || published.ctimeMs !== opened.ctimeMs) {
      throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
    }
    return bounded.toString('utf8', 0, bytes)
  } finally {
    closeSync(descriptor)
  }
}

/** Exact, read-only evidence for supervisor release; it performs zero mutation. */
export function inspectNodeTelegramReplyCheckpointForSupervisorRelease(input: Readonly<{
  path: string
  trustedRoot: string
  bindingHash: string
  dispatchId: string
  ownerId: string
  replyHash: string
}>): TelegramReplyCheckpointInspectionV1 {
  let cloned: unknown
  try { cloned = structuredClone(input) } catch {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  const request = object(cloned)
  if (request === null || Object.keys(request).length !== INSPECTION_KEYS.size ||
    Object.keys(request).some(key => !INSPECTION_KEYS.has(key)) ||
    typeof request['path'] !== 'string' || !isAbsolute(request['path']) ||
    resolve(request['path']) !== request['path'] || typeof request['trustedRoot'] !== 'string' ||
    !isAbsolute(request['trustedRoot']) || resolve(request['trustedRoot']) !== request['trustedRoot'] ||
    typeof request['bindingHash'] !== 'string' || !HASH.test(request['bindingHash']) ||
    typeof request['dispatchId'] !== 'string' || !HASH.test(request['dispatchId']) ||
    typeof request['ownerId'] !== 'string' || !OWNER.test(request['ownerId']) ||
    typeof request['replyHash'] !== 'string' || !HASH.test(request['replyHash'])) {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  const path = request['path']
  const trustedRoot = request['trustedRoot']
  const bindingHash = request['bindingHash']
  const requestedDispatchId = request['dispatchId']
  const ownerId = request['ownerId']
  const requestedReplyHash = request['replyHash']
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid)) {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  try {
    if (realpathSync(trustedRoot) !== trustedRoot) {
      return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
    }
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') {
      return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
    }
  }
  const directory = inspectPrivateDirectoryChain(trustedRoot, dirname(path), Number(uid))
  if (directory.state === 'absent') {
    return privateDirectoryAbsenceIsUnchanged(directory)
      ? Object.freeze({ kind: 'missing' })
      : Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  if (directory.state === 'unsafe') {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  let raw: string
  try {
    raw = readPrivateForInspection(path, Number(uid))
  } catch (error) {
    if (!privateDirectoryChainIsUnchanged(directory.identities)) {
      return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
    }
    if (nodeErrorCode(error) === 'ENOENT') {
      return pathIsStillAbsent(path)
        ? Object.freeze({ kind: 'missing' })
        : Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
    }
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  let checkpoint: TelegramReplyCheckpointV1
  try {
    checkpoint = validateTelegramReplyCheckpoint(JSON.parse(raw) as unknown)
  } catch {
    if (!privateDirectoryChainIsUnchanged(directory.identities)) {
      return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
    }
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  if (!privateDirectoryChainIsUnchanged(directory.identities)) {
    return Object.freeze({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  }
  if (checkpoint.bindingHash !== bindingHash || checkpoint.dispatchId !== requestedDispatchId ||
    checkpoint.ownerId !== ownerId ||
    (checkpoint.replyHash !== undefined && checkpoint.replyHash !== requestedReplyHash)) {
    return Object.freeze({ kind: 'denied', code: 'REPLY_CHECKPOINT_IDENTITY_MISMATCH' })
  }
  const receipt = makeTelegramReplyDeliveryReceipt(checkpoint)
  if (receipt !== null && receipt.replyHash === requestedReplyHash) {
    return Object.freeze({ kind: 'delivered', receipt })
  }
  return Object.freeze({
    kind: 'delivery-uncertain',
    code: 'DELIVERY_UNCERTAIN',
    revision: checkpoint.revision,
    ...(checkpoint.messageId === undefined ? {} : { messageId: checkpoint.messageId }),
  })
}

export function makeNodeTelegramReplyCheckpointStore(input: {
  path: string
  trustedRoot?: string
}): TelegramReplyCheckpointStore {
  const path = resolve(input.path)
  const directory = dirname(path)
  const uid = process.getuid?.()
  const requestedTrustedRoot = input.trustedRoot
  let canonicalTrustedRoot: string | null = null
  if (typeof requestedTrustedRoot === 'string' && isAbsolute(requestedTrustedRoot) &&
    resolve(requestedTrustedRoot) === requestedTrustedRoot) {
    try {
      if (realpathSync(requestedTrustedRoot) === requestedTrustedRoot) {
        canonicalTrustedRoot = requestedTrustedRoot
      }
    } catch { /* absent roots remain legacy-only and never become release-safe */ }
  }
  const rootBeforeMutation = canonicalTrustedRoot !== null && Number.isSafeInteger(uid)
    ? inspectPrivateDirectory(canonicalTrustedRoot, Number(uid))
    : { state: 'unsafe' as const }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
  }
  const chain = canonicalTrustedRoot !== null && rootBeforeMutation.state === 'ready'
    ? inspectPrivateDirectoryChain(canonicalTrustedRoot, directory, Number(uid))
    : { state: 'unsafe' as const }
  const firstIdentity = chain.state === 'ready' ? chain.identities[0] : undefined
  const pinnedIdentities = chain.state === 'ready' && rootBeforeMutation.state === 'ready' &&
    firstIdentity !== undefined && firstIdentity.dev === rootBeforeMutation.identity.dev &&
    firstIdentity.ino === rootBeforeMutation.identity.ino &&
    firstIdentity.uid === rootBeforeMutation.identity.uid &&
    firstIdentity.mode === rootBeforeMutation.identity.mode
    ? chain.identities
    : null
  const store = Object.freeze(makeJsonTelegramReplyCheckpointStore({
    exists: () => existsSync(path),
    read: () => readPrivate(path),
    saveAtomic(content) {
      if (pinnedIdentities !== null && !privateDirectoryChainIsUnchanged(pinnedIdentities)) {
        throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
      }
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
      if (pinnedIdentities !== null && !privateDirectoryChainIsUnchanged(pinnedIdentities)) {
        throw new Error('REPLY_CHECKPOINT_PATH_UNSAFE')
      }
    },
  }))
  if (pinnedIdentities !== null && canonicalTrustedRoot !== null) {
    NODE_STORE_CAPABILITIES.set(store, Object.freeze({
      path,
      trustedRoot: canonicalTrustedRoot,
      identities: Object.freeze(pinnedIdentities.map(identity => Object.freeze({ ...identity }))),
    }))
  }
  return store
}

/** Read-only restart verdict. Without a quiescence authority it performs zero Telegram I/O. */
export function recoverTelegramReplyCheckpoint(input: {
  store: TelegramReplyCheckpointStore
  bindingHash: string
}): TelegramReplyRecoveryResult {
  const loaded = input.store.load()
  if (loaded.status === 'missing') return { kind: 'none' }
  if (loaded.status === 'quarantined') {
    return { kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' }
  }
  if (loaded.checkpoint.bindingHash !== input.bindingHash) {
    return { kind: 'denied', code: 'BINDING_MISMATCH' }
  }
  if (!active(loaded.checkpoint)) return { kind: 'none' }
  return {
    kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN',
    ...(loaded.checkpoint.messageId === undefined ? {} : { messageId: loaded.checkpoint.messageId }),
  }
}

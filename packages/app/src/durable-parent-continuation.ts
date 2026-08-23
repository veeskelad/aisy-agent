import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'

import type { Provenance, ResolvedWorkBinding } from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FILENAME = /^[a-z0-9][a-z0-9.-]{0,127}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_FILE_BYTES = 128 * 1024
const MAX_TEXT_BYTES = 96 * 1024
const MAX_SPANS = 128
const CONTINUATION_DOMAIN = 'aisy.durable-parent-continuation.v1\0'
const CHECKSUM_DOMAIN = 'aisy.durable-parent-continuation.checksum.v1\0'
const WORK_BINDING_DOMAIN = 'aisy.durable-turn.work-binding.v1\0'
const AMBIGUITY_DOMAIN = 'aisy.durable-parent-continuation.ambiguity.v1\0'

export interface DurableParentContinuationSpanV1 {
  readonly role: 'system' | 'user'
  readonly provenance: Provenance
  readonly text: string
}

export interface DurableParentContinuationIdentityV1 {
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly workBindingHash: string
  readonly sessionId: string
  readonly turnId: string
  readonly turnTs: string
  readonly supervisorBindingHash: string
  readonly policyRevision: string
  readonly spans: readonly Readonly<DurableParentContinuationSpanV1>[]
}

export interface DurableParentAmbiguityRequestV1 {
  readonly runRootHash: string
  readonly taskId: string
  readonly controlLogicalSlotHash: string
  readonly journalLogicalSlotHash: string
  readonly attempt: 1 | 2
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly retryClass: 'retry-once' | 'new-task-only'
}

export interface DurableParentAmbiguityV1 extends DurableParentAmbiguityRequestV1 {
  readonly operationHash: string
}

export interface DurableParentContinuationRecordV1 {
  readonly schemaVersion: 1
  readonly ownerId: string
  readonly revision: number
  readonly phase: 'active' | 'paused' | 'cancelling' | 'terminal'
  readonly continuationHash: string
  readonly identity: Readonly<DurableParentContinuationIdentityV1>
  readonly ambiguity?: Readonly<DurableParentAmbiguityV1>
  readonly cancellationReceiptHash?: string
  readonly terminalReceiptHash?: string
  readonly checksum: string
}

export type DurableParentContinuationLoadV1 =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ready'; record: DurableParentContinuationRecordV1 }>
  | Readonly<{ status: 'quarantined'; reason: 'corrupt-or-unsafe-continuation' }>

export type DurableParentContinuationCaptureV1 =
  | Readonly<{ kind: 'captured' | 'replayed'; record: DurableParentContinuationRecordV1 }>
  | Readonly<{ kind: 'terminal-replay'; record: DurableParentContinuationRecordV1 }>
  | Readonly<{
      kind: 'busy'
      continuationHash: string
      sessionId: string
      turnId: string
    }>

export interface DurableParentContinuationStoreV1 {
  load(): DurableParentContinuationLoadV1
  capture(input: Readonly<{
    ownerId: string
    identity: DurableParentContinuationIdentityV1
  }>): DurableParentContinuationCaptureV1
  pause(input: Readonly<{
    continuationHash: string
    ownerId: string
    expectedRevision: number
    request: DurableParentAmbiguityRequestV1
  }>): DurableParentContinuationRecordV1
  resume(input: Readonly<{
    continuationHash: string
    ownerId: string
    expectedRevision: number
    operationHash: string
  }>): DurableParentContinuationRecordV1
  beginCancellation(input: Readonly<{
    continuationHash: string
    ownerId: string
    expectedRevision: number
    operationHash: string
    cancellationReceiptHash: string
  }>): DurableParentContinuationRecordV1
  finishCancellation(input: Readonly<{
    continuationHash: string
    ownerId: string
    expectedRevision: number
    operationHash: string
    cancellationReceiptHash: string
  }>): DurableParentContinuationRecordV1
  retire(input: Readonly<{
    continuationHash: string
    ownerId: string
    expectedRevision: number
    terminalReceiptHash: string
  }>): DurableParentContinuationRecordV1
}

export type DurableParentContinuationErrorCode =
  | 'DURABLE_PARENT_CONTINUATION_INPUT_INVALID'
  | 'DURABLE_PARENT_CONTINUATION_STORE_UNSAFE'
  | 'DURABLE_PARENT_CONTINUATION_STORE_UNAVAILABLE'
  | 'DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED'

export class DurableParentContinuationError extends Error {
  constructor(readonly code: DurableParentContinuationErrorCode) {
    super(code)
    this.name = 'DurableParentContinuationError'
  }
}

function fail(code: DurableParentContinuationErrorCode): never {
  throw new DurableParentContinuationError(code)
}

function nodeCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' ? error.code : null
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    fail('DURABLE_PARENT_CONTINUATION_STORE_UNAVAILABLE')
  }
  return Number(uid)
}

function noFollow(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    fail('DURABLE_PARENT_CONTINUATION_STORE_UNAVAILABLE')
  }
  return constants.O_NOFOLLOW
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function privateRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key)) ||
    Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value') ||
      descriptor.get !== undefined || descriptor.set !== undefined)) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
}

function boundedText(value: unknown, maximumBytes = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return value
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return value
}

function owner(value: unknown): string {
  const result = boundedText(value, 128)
  if (!OWNER.test(result)) fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  return result
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return Number(value)
}

function cleanBinding(value: unknown): Readonly<ResolvedWorkBinding> {
  const raw = exactObject(value, ['operatorId', 'profileId', 'projectId', 'sessionId', 'scope'], ['botId'])
  if (raw['scope'] !== 'workspace' && raw['scope'] !== 'project' && raw['scope'] !== 'session') {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return Object.freeze({
    ...(raw['botId'] === undefined ? {} : { botId: boundedText(raw['botId']) }),
    operatorId: boundedText(raw['operatorId']),
    profileId: boundedText(raw['profileId']),
    projectId: boundedText(raw['projectId']),
    sessionId: boundedText(raw['sessionId']),
    scope: raw['scope'],
  })
}

export function durableParentContinuationWorkBindingHash(binding: ResolvedWorkBinding): string {
  const clean = cleanBinding(binding)
  return createHash('sha256').update(WORK_BINDING_DOMAIN, 'utf8')
    .update(JSON.stringify(clean), 'utf8').digest('hex')
}

function cleanIdentity(value: unknown): Readonly<DurableParentContinuationIdentityV1> {
  const raw = exactObject(value, [
    'binding', 'workBindingHash', 'sessionId', 'turnId', 'turnTs',
    'supervisorBindingHash', 'policyRevision', 'spans',
  ])
  const binding = cleanBinding(raw['binding'])
  const sessionId = boundedText(raw['sessionId'])
  const workBindingHash = hash(raw['workBindingHash'])
  const turnTs = boundedText(raw['turnTs'], 64)
  if (sessionId !== binding.sessionId ||
    workBindingHash !== durableParentContinuationWorkBindingHash(binding) ||
    !ISO_INSTANT.test(turnTs) || !Array.isArray(raw['spans']) ||
    raw['spans'].length === 0 || raw['spans'].length > MAX_SPANS) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  let textBytes = 0
  const spans = raw['spans'].map(value => {
    const span = exactObject(value, ['role', 'provenance', 'text'])
    if ((span['role'] !== 'system' && span['role'] !== 'user') ||
      (span['provenance'] !== 'operator' && span['provenance'] !== 'untrusted') ||
      typeof span['text'] !== 'string' || span['text'].includes('\0')) {
      fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
    }
    textBytes += Buffer.byteLength(span['text'], 'utf8')
    if (textBytes > MAX_TEXT_BYTES) fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
    return Object.freeze({
      role: span['role'],
      provenance: span['provenance'],
      text: span['text'],
    }) as Readonly<DurableParentContinuationSpanV1>
  })
  return Object.freeze({
    binding,
    workBindingHash,
    sessionId,
    turnId: boundedText(raw['turnId'], 512),
    turnTs,
    supervisorBindingHash: hash(raw['supervisorBindingHash']),
    policyRevision: boundedText(raw['policyRevision'], 128),
    spans: Object.freeze(spans),
  })
}

export function durableParentContinuationHash(
  identity: DurableParentContinuationIdentityV1,
): string {
  const clean = cleanIdentity(identity)
  return createHash('sha256').update(CONTINUATION_DOMAIN, 'utf8')
    .update(JSON.stringify(clean), 'utf8').digest('hex')
}

function cleanAmbiguityRequest(value: unknown): Readonly<DurableParentAmbiguityRequestV1> {
  const raw = exactObject(value, [
    'runRootHash', 'taskId', 'controlLogicalSlotHash', 'journalLogicalSlotHash',
    'attempt', 'phase', 'ordinal', 'retryClass',
  ])
  if ((raw['attempt'] !== 1 && raw['attempt'] !== 2) ||
    (raw['phase'] !== 'provider' && raw['phase'] !== 'tool') ||
    (raw['retryClass'] !== 'retry-once' && raw['retryClass'] !== 'new-task-only')) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return Object.freeze({
    runRootHash: hash(raw['runRootHash']),
    taskId: boundedText(raw['taskId'], 128),
    controlLogicalSlotHash: hash(raw['controlLogicalSlotHash']),
    journalLogicalSlotHash: hash(raw['journalLogicalSlotHash']),
    attempt: raw['attempt'],
    phase: raw['phase'],
    ordinal: positiveInteger(raw['ordinal']),
    retryClass: raw['retryClass'],
  })
}

export function durableParentAmbiguityOperationHash(
  request: DurableParentAmbiguityRequestV1,
): string {
  const clean = cleanAmbiguityRequest(request)
  return createHash('sha256').update(AMBIGUITY_DOMAIN, 'utf8')
    .update(JSON.stringify(clean), 'utf8').digest('hex')
}

function cleanAmbiguity(value: unknown): Readonly<DurableParentAmbiguityV1> {
  const raw = exactObject(value, [
    'runRootHash', 'taskId', 'controlLogicalSlotHash', 'journalLogicalSlotHash',
    'attempt', 'phase', 'ordinal', 'retryClass', 'operationHash',
  ])
  const request = cleanAmbiguityRequest({
    runRootHash: raw['runRootHash'],
    taskId: raw['taskId'],
    controlLogicalSlotHash: raw['controlLogicalSlotHash'],
    journalLogicalSlotHash: raw['journalLogicalSlotHash'],
    attempt: raw['attempt'],
    phase: raw['phase'],
    ordinal: raw['ordinal'],
    retryClass: raw['retryClass'],
  })
  const operationHash = hash(raw['operationHash'])
  if (operationHash !== durableParentAmbiguityOperationHash(request)) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return Object.freeze({ ...request, operationHash })
}

function withoutChecksum(record: DurableParentContinuationRecordV1): Omit<
DurableParentContinuationRecordV1,
'checksum'
> {
  return {
    schemaVersion: record.schemaVersion,
    ownerId: record.ownerId,
    revision: record.revision,
    phase: record.phase,
    continuationHash: record.continuationHash,
    identity: record.identity,
    ...(record.ambiguity === undefined ? {} : { ambiguity: record.ambiguity }),
    ...(record.cancellationReceiptHash === undefined
      ? {}
      : { cancellationReceiptHash: record.cancellationReceiptHash }),
    ...(record.terminalReceiptHash === undefined
      ? {}
      : { terminalReceiptHash: record.terminalReceiptHash }),
  }
}

function checksum(record: DurableParentContinuationRecordV1): string {
  return createHash('sha256').update(CHECKSUM_DOMAIN, 'utf8')
    .update(JSON.stringify(withoutChecksum(record)), 'utf8').digest('hex')
}

function cleanRecord(value: unknown): DurableParentContinuationRecordV1 {
  const raw = exactObject(value, [
    'schemaVersion', 'ownerId', 'revision', 'phase', 'continuationHash', 'identity', 'checksum',
  ], ['ambiguity', 'cancellationReceiptHash', 'terminalReceiptHash'])
  if (raw['schemaVersion'] !== 1 || (raw['phase'] !== 'active' &&
    raw['phase'] !== 'paused' && raw['phase'] !== 'cancelling' &&
    raw['phase'] !== 'terminal')) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  const identity = cleanIdentity(raw['identity'])
  const record: DurableParentContinuationRecordV1 = Object.freeze({
    schemaVersion: 1,
    ownerId: owner(raw['ownerId']),
    revision: positiveInteger(raw['revision']),
    phase: raw['phase'],
    continuationHash: hash(raw['continuationHash']),
    identity,
    ...(raw['ambiguity'] === undefined ? {} : { ambiguity: cleanAmbiguity(raw['ambiguity']) }),
    ...(raw['cancellationReceiptHash'] === undefined
      ? {}
      : { cancellationReceiptHash: hash(raw['cancellationReceiptHash']) }),
    ...(raw['terminalReceiptHash'] === undefined
      ? {}
      : { terminalReceiptHash: hash(raw['terminalReceiptHash']) }),
    checksum: hash(raw['checksum']),
  })
  if (record.continuationHash !== durableParentContinuationHash(identity) ||
    (record.phase === 'terminal') !== (record.terminalReceiptHash !== undefined) ||
    (record.phase === 'paused' && record.ambiguity === undefined) ||
    (record.phase === 'cancelling' && (record.ambiguity === undefined ||
      record.cancellationReceiptHash === undefined)) ||
    (record.phase !== 'cancelling' && record.phase !== 'terminal' &&
      record.cancellationReceiptHash !== undefined) ||
    (record.phase === 'terminal' &&
      ((record.cancellationReceiptHash === undefined) !== (record.ambiguity === undefined) ||
        (record.cancellationReceiptHash !== undefined &&
          record.cancellationReceiptHash !== record.terminalReceiptHash))) ||
    checksum(record) !== record.checksum) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  return record
}

function makeRecord(input: Omit<DurableParentContinuationRecordV1, 'checksum'>): DurableParentContinuationRecordV1 {
  const candidate = { ...input, checksum: '0'.repeat(64) } as DurableParentContinuationRecordV1
  return cleanRecord({ ...candidate, checksum: checksum(candidate) })
}

function ensurePrivateRoot(root: string, uid: number): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o700 || realpathSync.native(root) !== root) {
      fail('DURABLE_PARENT_CONTINUATION_STORE_UNSAFE')
    }
  } catch (error) {
    if (error instanceof DurableParentContinuationError) throw error
    fail('DURABLE_PARENT_CONTINUATION_STORE_UNAVAILABLE')
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow())
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeDurableParentContinuationStore(input: Readonly<{
  path: string
}>): DurableParentContinuationStoreV1 {
  if (!isAbsolute(input.path) || normalize(input.path) !== input.path ||
    !FILENAME.test(basename(input.path))) {
    fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  }
  const path = resolve(input.path)
  const root = dirname(path)
  const uid = currentUid()
  ensurePrivateRoot(root, uid)
  const rootIdentity = lstatSync(root)

  const assertRoot = (): void => {
    ensurePrivateRoot(root, uid)
    const current = lstatSync(root)
    if (!sameIdentity(rootIdentity, current)) {
      fail('DURABLE_PARENT_CONTINUATION_STORE_UNSAFE')
    }
  }

  const load = (): DurableParentContinuationLoadV1 => {
    let descriptor: number | null = null
    try {
      assertRoot()
      descriptor = openSync(path, constants.O_RDONLY | noFollow())
      const before = fstatSync(descriptor)
      if (!privateRegular(before, uid) || before.size <= 0 || before.size > MAX_FILE_BYTES) {
        return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
      }
      const encoded = readFileSync(descriptor, 'utf8')
      const after = fstatSync(descriptor)
      const current = lstatSync(path)
      if (!privateRegular(after, uid) || !privateRegular(current, uid) ||
        !sameIdentity(before, after) || !sameIdentity(after, current) ||
        after.size !== Buffer.byteLength(encoded, 'utf8') || !encoded.endsWith('\n')) {
        return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
      }
      let parsed: unknown
      try { parsed = JSON.parse(encoded.slice(0, -1)) as unknown } catch {
        return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
      }
      try {
        const record = cleanRecord(parsed)
        if (encoded !== JSON.stringify(record) + '\n') {
          return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
        }
        return Object.freeze({ status: 'ready', record })
      } catch {
        return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
      }
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return Object.freeze({ status: 'missing' })
      return Object.freeze({ status: 'quarantined', reason: 'corrupt-or-unsafe-continuation' })
    } finally {
      if (descriptor !== null) try { closeSync(descriptor) } catch { /* result already fixed */ }
    }
  }

  const write = (record: DurableParentContinuationRecordV1): void => {
    assertRoot()
    const encoded = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FILE_BYTES) {
      fail('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const tempStat = lstatSync(temporary)
      if (!privateRegular(tempStat, uid)) fail('DURABLE_PARENT_CONTINUATION_STORE_UNSAFE')
      const descriptor = openSync(temporary, constants.O_RDONLY | noFollow())
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
      renameSync(temporary, path)
      assertRoot()
      syncDirectory(root)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* absent after rename or best-effort cleanup */ }
      if (error instanceof DurableParentContinuationError) throw error
      fail('DURABLE_PARENT_CONTINUATION_STORE_UNAVAILABLE')
    }
  }

  return Object.freeze({
    load,
    capture(captureInput: Parameters<DurableParentContinuationStoreV1['capture']>[0]) {
      const raw = exactObject(captureInput, ['ownerId', 'identity'])
      const identity = cleanIdentity(raw['identity'])
      const continuationHash = durableParentContinuationHash(identity)
      const existing = load()
      if (existing.status === 'quarantined') {
        fail('DURABLE_PARENT_CONTINUATION_STORE_UNSAFE')
      }
      if (existing.status === 'ready') {
        if (existing.record.continuationHash !== continuationHash) {
          if (existing.record.phase !== 'terminal') {
            return Object.freeze({
              kind: 'busy' as const,
              continuationHash: existing.record.continuationHash,
              sessionId: existing.record.identity.sessionId,
              turnId: existing.record.identity.turnId,
            })
          }
        } else {
          return Object.freeze({
            kind: existing.record.phase !== 'terminal' ? 'replayed' as const : 'terminal-replay' as const,
            record: existing.record,
          })
        }
      }
      const record = makeRecord({
        schemaVersion: 1,
        ownerId: owner(raw['ownerId']),
        revision: 1,
        phase: 'active',
        continuationHash,
        identity,
      })
      write(record)
      return Object.freeze({ kind: 'captured' as const, record })
    },
    pause(pauseInput: Parameters<DurableParentContinuationStoreV1['pause']>[0]) {
      const raw = exactObject(pauseInput, [
        'continuationHash', 'ownerId', 'expectedRevision', 'request',
      ])
      const existing = load()
      if (existing.status !== 'ready' || existing.record.phase !== 'active' ||
        existing.record.continuationHash !== hash(raw['continuationHash']) ||
        existing.record.ownerId !== owner(raw['ownerId']) ||
        existing.record.revision !== positiveInteger(raw['expectedRevision'])) {
        fail('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
      }
      const request = cleanAmbiguityRequest(raw['request'])
      const ambiguity = Object.freeze({
        ...request,
        operationHash: durableParentAmbiguityOperationHash(request),
      })
      const record = makeRecord({
        ...withoutChecksum(existing.record),
        revision: existing.record.revision + 1,
        phase: 'paused',
        ambiguity,
      })
      write(record)
      return record
    },
    resume(resumeInput: Parameters<DurableParentContinuationStoreV1['resume']>[0]) {
      const raw = exactObject(resumeInput, [
        'continuationHash', 'ownerId', 'expectedRevision', 'operationHash',
      ])
      const existing = load()
      if (existing.status !== 'ready' || existing.record.phase !== 'paused' ||
        existing.record.continuationHash !== hash(raw['continuationHash']) ||
        existing.record.ownerId !== owner(raw['ownerId']) ||
        existing.record.revision !== positiveInteger(raw['expectedRevision']) ||
        existing.record.ambiguity?.operationHash !== hash(raw['operationHash'])) {
        fail('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
      }
      const record = makeRecord({
        ...withoutChecksum(existing.record),
        revision: existing.record.revision + 1,
        phase: 'active',
      })
      write(record)
      return record
    },
    beginCancellation(
      cancellationInput: Parameters<DurableParentContinuationStoreV1['beginCancellation']>[0],
    ) {
      const raw = exactObject(cancellationInput, [
        'continuationHash', 'ownerId', 'expectedRevision', 'operationHash',
        'cancellationReceiptHash',
      ])
      const existing = load()
      if (existing.status !== 'ready' ||
        (existing.record.phase !== 'paused' && existing.record.phase !== 'active') ||
        existing.record.continuationHash !== hash(raw['continuationHash']) ||
        existing.record.ownerId !== owner(raw['ownerId']) ||
        existing.record.revision !== positiveInteger(raw['expectedRevision']) ||
        existing.record.ambiguity?.operationHash !== hash(raw['operationHash'])) {
        fail('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
      }
      const record = makeRecord({
        ...withoutChecksum(existing.record),
        revision: existing.record.revision + 1,
        phase: 'cancelling',
        cancellationReceiptHash: hash(raw['cancellationReceiptHash']),
      })
      write(record)
      return record
    },
    finishCancellation(
      cancellationInput: Parameters<DurableParentContinuationStoreV1['finishCancellation']>[0],
    ) {
      const raw = exactObject(cancellationInput, [
        'continuationHash', 'ownerId', 'expectedRevision', 'operationHash',
        'cancellationReceiptHash',
      ])
      const existing = load()
      const receiptHash = hash(raw['cancellationReceiptHash'])
      if (existing.status !== 'ready' || existing.record.phase !== 'cancelling' ||
        existing.record.continuationHash !== hash(raw['continuationHash']) ||
        existing.record.ownerId !== owner(raw['ownerId']) ||
        existing.record.revision !== positiveInteger(raw['expectedRevision']) ||
        existing.record.ambiguity?.operationHash !== hash(raw['operationHash']) ||
        existing.record.cancellationReceiptHash !== receiptHash) {
        fail('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
      }
      const record = makeRecord({
        ...withoutChecksum(existing.record),
        revision: existing.record.revision + 1,
        phase: 'terminal',
        terminalReceiptHash: receiptHash,
      })
      write(record)
      return record
    },
    retire(retireInput: Parameters<DurableParentContinuationStoreV1['retire']>[0]) {
      const raw = exactObject(retireInput, [
        'continuationHash', 'ownerId', 'expectedRevision', 'terminalReceiptHash',
      ])
      const existing = load()
      if (existing.status !== 'ready' || existing.record.phase === 'terminal' ||
        existing.record.continuationHash !== hash(raw['continuationHash']) ||
        existing.record.ownerId !== owner(raw['ownerId']) ||
        existing.record.revision !== positiveInteger(raw['expectedRevision'])) {
        fail('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
      }
      const base = withoutChecksum(existing.record)
      const {
        ambiguity: _ambiguity,
        cancellationReceiptHash: _cancellationReceiptHash,
        ...withoutAmbiguity
      } = base
      const record = makeRecord({
        ...withoutAmbiguity,
        revision: existing.record.revision + 1,
        phase: 'terminal',
        terminalReceiptHash: hash(raw['terminalReceiptHash']),
      })
      write(record)
      return record
    },
  })
}

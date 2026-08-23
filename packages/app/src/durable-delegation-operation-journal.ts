// Manager-owned operation journal for durable delegation. It never calls a
// provider or tool itself: the supervised V2 adapter durably prepares here,
// performs exactly one external call, then settles with the process-local permit.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { types as utilTypes } from 'node:util'

const HASH = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const POLICY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_ORDINAL = 1_000_000
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 8_192
const MAX_JSON_TEXT_BYTES = 128 * 1024
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_PAYLOAD_BYTES = 64 * 1024
const MAX_STATE_BYTES = 128 * 1024
const MAX_TOKENS = 1_000_000_000
const MAX_SPEND_USD = 1_000_000
const MAX_WALL_MS = 24 * 60 * 60 * 1000
const ROOT_DOMAIN = 'aisy.durable-delegation.operation-root.v1\0'
const SLOT_DOMAIN = 'aisy.durable-delegation.operation-slot.v1\0'
const REQUEST_DOMAIN = 'aisy.durable-delegation.operation-request.v1\0'
const RECORD_DOMAIN = 'aisy.durable-delegation.operation-record.v1\0'
const RESULT_DOMAIN = 'aisy.durable-delegation.operation-result.v1\0'
const ROOT_V2_DOMAIN = 'aisy.durable-delegation.operation-root.v2\0'
const LOGICAL_SLOT_V2_DOMAIN = 'aisy.durable-delegation.operation-logical-slot.v2\0'
const ATTEMPT_SLOT_V2_DOMAIN = 'aisy.durable-delegation.operation-attempt-slot.v2\0'
const REQUEST_V2_DOMAIN = 'aisy.durable-delegation.operation-request.v2\0'
const RECORD_V2_DOMAIN = 'aisy.durable-delegation.operation-record.v2\0'
const RESULT_V2_DOMAIN = 'aisy.durable-delegation.operation-result.v2\0'
const MAX_V2_INVENTORY_ENTRIES = 4_096
const MAX_V2_INVENTORY_BYTES = 32 * 1024 * 1024
const V2_STATE_FILE = /^([a-f0-9]{64})\.json$/
const V2_COMPATIBILITY_BARRIER = 'aisy.durable-delegation.operations-cohort.v2\n'

export type DurableDelegationOperationPhase = 'provider' | 'tool'

export interface DurableDelegationOperationKeyV1 {
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly phase: DurableDelegationOperationPhase
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly authorityHash: string
  readonly policyRevision: string
}

export type DurableDelegationOperationEffect = 'none' | 'read' | 'mutation'

/** The journal injects the reserved receipt kind and result hash itself. */
export interface DurableDelegationOperationReceiptInputV1 {
  readonly spendUsd: number
  readonly wallMs: number
  readonly effect: DurableDelegationOperationEffect
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly evidenceHash?: string
}

export interface DurableDelegationOperationReceiptV1 {
  readonly receiptVersion: 1
  readonly kind: 'runtime.provider-receipt' | 'runtime.tool-receipt'
  readonly resultHash: string
  readonly spendUsd: number
  readonly wallMs: number
  readonly effect: DurableDelegationOperationEffect
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly evidenceHash?: string
}

export type DurableDelegationOperationDriftReason =
  | 'key-mismatch'
  | 'corrupt-or-unsafe-state'

export type DurableDelegationOperationStateV1 =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'ambiguous'
      key: Readonly<DurableDelegationOperationKeyV1>
    }>
  | Readonly<{
      state: 'settled'
      key: Readonly<DurableDelegationOperationKeyV1>
      payload: unknown
      receipt: Readonly<DurableDelegationOperationReceiptV1>
    }>
  | Readonly<{
      state: 'drift'
      reason: DurableDelegationOperationDriftReason
    }>

const settlementPermitBrand: unique symbol = Symbol('aisy.durable-delegation.settlement-permit')

/** Opaque at runtime too: structural copies are rejected by a WeakMap lookup. */
export interface DurableDelegationOperationSettlementPermitV1 {
  readonly [settlementPermitBrand]: true
  readonly kind: 'durable-delegation-operation-settlement-permit-v1'
}

export type DurableDelegationOperationPrepareResultV1 =
  | Readonly<{
      state: 'prepared'
      disposition: 'created'
      key: Readonly<DurableDelegationOperationKeyV1>
      permit: DurableDelegationOperationSettlementPermitV1
    }>
  | Extract<DurableDelegationOperationStateV1, { state: 'ambiguous' | 'settled' | 'drift' }>

export type DurableDelegationOperationJournalErrorCode =
  | 'DELEGATION_OPERATION_JOURNAL_INPUT_INVALID'
  | 'DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE'
  | 'DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE'
  | 'DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED'
  | 'DELEGATION_OPERATION_JOURNAL_COHORT_MIXED'
  | 'DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID'

export class DurableDelegationOperationJournalError extends Error {
  constructor(readonly code: DurableDelegationOperationJournalErrorCode) {
    super(code)
    this.name = 'DurableDelegationOperationJournalError'
  }
}

export interface DurableDelegationOperationJournalV1 {
  readonly runRootHash: string
  inspect(key: DurableDelegationOperationKeyV1): DurableDelegationOperationStateV1
  prepare(key: DurableDelegationOperationKeyV1): DurableDelegationOperationPrepareResultV1
  settle(
    permit: DurableDelegationOperationSettlementPermitV1,
    outcome: Readonly<{
      payload: unknown
      receipt: DurableDelegationOperationReceiptInputV1
    }>,
  ): Extract<DurableDelegationOperationStateV1, { state: 'settled' }>
}

export type DurableDelegationOperationAttemptV2 = 1 | 2

/**
 * V2 keeps the semantic request identity from V1, but addresses a retry as a
 * second attempt inside one immutable logical slot. `resolutionHash` is an
 * opaque hash of code-owned resolution evidence; this journal records and
 * compares it but never mints approval authority.
 */
export interface DurableDelegationOperationKeyV2 {
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly phase: DurableDelegationOperationPhase
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly logicalSlotHash: string
  readonly attempt: DurableDelegationOperationAttemptV2
  readonly resolutionHash: string
}

export type DurableDelegationOperationDriftReasonV2 =
  | DurableDelegationOperationDriftReason
  | 'attempt-sequence-invalid'

export type DurableDelegationOperationStateV2 =
  | Readonly<{ state: 'absent' }>
  | Readonly<{
      state: 'ambiguous'
      key: Readonly<DurableDelegationOperationKeyV2>
    }>
  | Readonly<{
      state: 'settled'
      key: Readonly<DurableDelegationOperationKeyV2>
      payload: unknown
      receipt: Readonly<DurableDelegationOperationReceiptV1>
    }>
  | Readonly<{
      state: 'drift'
      reason: DurableDelegationOperationDriftReasonV2
    }>

const settlementPermitV2Brand: unique symbol = Symbol(
  'aisy.durable-delegation.settlement-permit.v2',
)

export interface DurableDelegationOperationSettlementPermitV2 {
  readonly [settlementPermitV2Brand]: true
  readonly kind: 'durable-delegation-operation-settlement-permit-v2'
}

export type DurableDelegationOperationPrepareResultV2 =
  | Readonly<{
      state: 'prepared'
      disposition: 'created'
      key: Readonly<DurableDelegationOperationKeyV2>
      permit: DurableDelegationOperationSettlementPermitV2
    }>
  | Extract<DurableDelegationOperationStateV2, {
      state: 'ambiguous' | 'settled' | 'drift'
    }>

export type DurableDelegationOperationInventoryEntryV2 = Extract<
  DurableDelegationOperationStateV2,
  { state: 'ambiguous' | 'settled' }
>

export interface DurableDelegationOperationInventoryV2 {
  readonly cohortVersion: 2
  readonly runRootHash: string
  readonly entries: readonly DurableDelegationOperationInventoryEntryV2[]
}

export interface DurableDelegationOperationJournalV2 {
  readonly runRootHash: string
  scan(): DurableDelegationOperationInventoryV2
  inspect(key: DurableDelegationOperationKeyV2): DurableDelegationOperationStateV2
  prepare(key: DurableDelegationOperationKeyV2): DurableDelegationOperationPrepareResultV2
  settle(
    permit: DurableDelegationOperationSettlementPermitV2,
    outcome: Readonly<{
      payload: unknown
      receipt: DurableDelegationOperationReceiptInputV1
    }>,
  ): Extract<DurableDelegationOperationStateV2, { state: 'settled' }>
}

interface TrustedDirectory {
  readonly dev: number
  readonly ino: number
  readonly uid: number
}

interface PreparedRecordV1 {
  readonly kind: 'operation.prepared'
  readonly key: Readonly<DurableDelegationOperationKeyV1>
}

interface SettledRecordV1 {
  readonly kind: 'operation.settled'
  readonly key: Readonly<DurableDelegationOperationKeyV1>
  readonly payload: unknown
  readonly receipt: Readonly<DurableDelegationOperationReceiptV1>
}

type OperationRecordV1 = PreparedRecordV1 | SettledRecordV1

interface OperationEnvelopeV1 {
  readonly schemaVersion: 1
  readonly recordHash: string
  readonly record: OperationRecordV1
}

interface PermitState {
  readonly controller: object
  readonly slotHash: string
  readonly key: Readonly<DurableDelegationOperationKeyV1>
  readonly preparedHash: string
}

const permitStates = new WeakMap<object, PermitState>()
const consumedPermits = new WeakSet<object>()

function fail(code: DurableDelegationOperationJournalErrorCode): never {
  throw new DurableDelegationOperationJournalError(code)
}

function sha256(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update(value, 'utf8').digest('hex')
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  const captured: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
    captured[key] = descriptor.value
  }
  return captured
}

function canonicalJson(value: unknown, maximumBytes: number): string {
  let nodes = 0
  let textBytes = 0
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      return Object.is(candidate, -0) ? 0 : candidate
    }
    if (typeof candidate === 'string') {
      if (candidate.includes('\0')) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      textBytes += Buffer.byteLength(candidate, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      return candidate
    }
    if (Array.isArray(candidate)) {
      if (utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype ||
        Object.getOwnPropertySymbols(candidate).length !== 0) {
        fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const length = Reflect.getOwnPropertyDescriptor(candidate, 'length')?.value as unknown
      if (typeof length !== 'number' || !Number.isSafeInteger(length) ||
        length < 0 || length > MAX_JSON_NODES) {
        fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      }
      const keys = Object.keys(descriptors).filter(key => key !== 'length')
      if (keys.length !== length) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      const result: unknown[] = []
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
          descriptor.get !== undefined || descriptor.set !== undefined) {
          fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
        }
        result.push(visit(descriptor.value, depth + 1))
      }
      return result
    }
    if (typeof candidate !== 'object' || candidate === null || utilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      Object.getOwnPropertySymbols(candidate).length !== 0) {
      fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors).sort()) {
      if (key.includes('\0')) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      textBytes += Buffer.byteLength(key, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      const descriptor = descriptors[key]!
      if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
        descriptor.set !== undefined) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
      Object.defineProperty(result, key, {
        enumerable: true,
        configurable: true,
        value: visit(descriptor.value, depth + 1),
      })
    }
    return result
  }
  const encoded = JSON.stringify(visit(value, 0))
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return encoded
}

function jsonSnapshot(value: unknown, maximumBytes: number): unknown {
  return JSON.parse(canonicalJson(value, maximumBytes)) as unknown
}

function frozenSnapshot<T>(value: T, maximumBytes = MAX_STATE_BYTES): Readonly<T> {
  const snapshot = jsonSnapshot(value, maximumBytes) as T
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || Object.isFrozen(candidate)) return
    Object.freeze(candidate)
    for (const nested of Object.values(candidate)) freeze(nested)
  }
  freeze(snapshot)
  return snapshot
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('\0')
}

function captureKey(value: unknown): Readonly<DurableDelegationOperationKeyV1> {
  const key = exactRecord(value, [
    'runRootHash',
    'bindingHash',
    'delegationId',
    'taskId',
    'phase',
    'ordinal',
    'canonicalRequestHash',
    'authorityHash',
    'policyRevision',
  ])
  if (typeof key['runRootHash'] !== 'string' || !HASH.test(key['runRootHash']) ||
    typeof key['bindingHash'] !== 'string' || !HASH.test(key['bindingHash']) ||
    !boundedId(key['delegationId']) || !boundedId(key['taskId']) ||
    (key['phase'] !== 'provider' && key['phase'] !== 'tool') ||
    !Number.isSafeInteger(key['ordinal']) || Number(key['ordinal']) < 1 ||
    Number(key['ordinal']) > MAX_ORDINAL ||
    typeof key['canonicalRequestHash'] !== 'string' || !HASH.test(key['canonicalRequestHash']) ||
    typeof key['authorityHash'] !== 'string' || !HASH.test(key['authorityHash']) ||
    typeof key['policyRevision'] !== 'string' || !POLICY_REVISION.test(key['policyRevision'])) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return Object.freeze({
    runRootHash: key['runRootHash'],
    bindingHash: key['bindingHash'],
    delegationId: key['delegationId'],
    taskId: key['taskId'],
    phase: key['phase'],
    ordinal: Number(key['ordinal']),
    canonicalRequestHash: key['canonicalRequestHash'],
    authorityHash: key['authorityHash'],
    policyRevision: key['policyRevision'],
  }) as Readonly<DurableDelegationOperationKeyV1>
}

function keysEqual(
  left: Readonly<DurableDelegationOperationKeyV1>,
  right: Readonly<DurableDelegationOperationKeyV1>,
): boolean {
  return canonicalJson(left, MAX_STATE_BYTES) === canonicalJson(right, MAX_STATE_BYTES)
}

function slotHash(key: Readonly<DurableDelegationOperationKeyV1>): string {
  return sha256(SLOT_DOMAIN, JSON.stringify([
    key.delegationId,
    key.taskId,
    key.phase,
    key.ordinal,
  ]))
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TOKENS
}

function captureReceiptInput(
  value: unknown,
  phase: DurableDelegationOperationPhase,
  resultHash: string,
): Readonly<DurableDelegationOperationReceiptV1> {
  const receipt = exactRecord(
    value,
    ['spendUsd', 'wallMs', 'effect'],
    ['inputTokens', 'outputTokens', 'evidenceHash'],
  )
  const spendUsd = receipt['spendUsd']
  const wallMs = receipt['wallMs']
  const effect = receipt['effect']
  const inputTokens = receipt['inputTokens']
  const outputTokens = receipt['outputTokens']
  const evidenceHash = receipt['evidenceHash']
  if (typeof spendUsd !== 'number' || !Number.isFinite(spendUsd) || spendUsd < 0 ||
    spendUsd > MAX_SPEND_USD || !Number.isSafeInteger(wallMs) || Number(wallMs) < 0 ||
    Number(wallMs) > MAX_WALL_MS ||
    (effect !== 'none' && effect !== 'read' && effect !== 'mutation') ||
    (phase === 'provider' && effect === 'mutation') ||
    (inputTokens !== undefined && !validCounter(inputTokens)) ||
    (outputTokens !== undefined && !validCounter(outputTokens)) ||
    (evidenceHash !== undefined && (typeof evidenceHash !== 'string' || !HASH.test(evidenceHash)))) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return Object.freeze({
    receiptVersion: 1,
    kind: phase === 'provider' ? 'runtime.provider-receipt' : 'runtime.tool-receipt',
    resultHash,
    spendUsd,
    wallMs: Number(wallMs),
    effect,
    ...(inputTokens === undefined ? {} : { inputTokens: Number(inputTokens) }),
    ...(outputTokens === undefined ? {} : { outputTokens: Number(outputTokens) }),
    ...(evidenceHash === undefined ? {} : { evidenceHash }),
  })
}

function validateStoredReceipt(
  value: unknown,
  phase: DurableDelegationOperationPhase,
  payload: unknown,
): Readonly<DurableDelegationOperationReceiptV1> {
  const receipt = exactRecord(
    value,
    ['receiptVersion', 'kind', 'resultHash', 'spendUsd', 'wallMs', 'effect'],
    ['inputTokens', 'outputTokens', 'evidenceHash'],
  )
  if (receipt['receiptVersion'] !== 1 ||
    receipt['kind'] !== (phase === 'provider'
      ? 'runtime.provider-receipt'
      : 'runtime.tool-receipt') ||
    typeof receipt['resultHash'] !== 'string' || !HASH.test(receipt['resultHash']) ||
    receipt['resultHash'] !== sha256(RESULT_DOMAIN, canonicalJson(payload, MAX_PAYLOAD_BYTES))) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return captureReceiptInput({
    spendUsd: receipt['spendUsd'],
    wallMs: receipt['wallMs'],
    effect: receipt['effect'],
    ...(receipt['inputTokens'] === undefined ? {} : { inputTokens: receipt['inputTokens'] }),
    ...(receipt['outputTokens'] === undefined ? {} : { outputTokens: receipt['outputTokens'] }),
    ...(receipt['evidenceHash'] === undefined ? {} : { evidenceHash: receipt['evidenceHash'] }),
  }, phase, receipt['resultHash'])
}

function recordHash(record: OperationRecordV1): string {
  return sha256(RECORD_DOMAIN, canonicalJson(record, MAX_STATE_BYTES))
}

function envelope(record: OperationRecordV1): string {
  return canonicalJson({ schemaVersion: 1, recordHash: recordHash(record), record }, MAX_STATE_BYTES) + '\n'
}

function parseEnvelope(content: string): OperationRecordV1 {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID') }
  const stored = exactRecord(parsed, ['schemaVersion', 'recordHash', 'record'])
  if (stored['schemaVersion'] !== 1 || typeof stored['recordHash'] !== 'string' ||
    !HASH.test(stored['recordHash'])) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  const recordSource = exactRecord(stored['record'], ['kind', 'key'], ['payload', 'receipt'])
  const key = captureKey(recordSource['key'])
  let record: OperationRecordV1
  if (recordSource['kind'] === 'operation.prepared' &&
    recordSource['payload'] === undefined && recordSource['receipt'] === undefined) {
    record = Object.freeze({ kind: 'operation.prepared', key })
  } else if (recordSource['kind'] === 'operation.settled' &&
    Object.hasOwn(recordSource, 'payload') && Object.hasOwn(recordSource, 'receipt')) {
    const payload = frozenSnapshot(recordSource['payload'], MAX_PAYLOAD_BYTES)
    const receipt = validateStoredReceipt(recordSource['receipt'], key.phase, payload)
    record = Object.freeze({ kind: 'operation.settled', key, payload, receipt })
  } else {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  if (stored['recordHash'] !== recordHash(record)) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return record
}

function currentUid(): number {
  const uid = process.geteuid?.()
  if (typeof uid !== 'number') fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  return uid
}

function trustedDirectory(path: string): TrustedDirectory {
  try {
    if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0') ||
      realpathSync.native(path) !== path) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() ||
      (info.mode & 0o077) !== 0) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
    return Object.freeze({ dev: info.dev, ino: info.ino, uid: info.uid })
  } catch (error) {
    if (error instanceof DurableDelegationOperationJournalError) throw error
    fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  }
}

function sameDirectory(left: TrustedDirectory, right: TrustedDirectory): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
}

function assertDirectory(path: string, expected: TrustedDirectory): void {
  if (!sameDirectory(trustedDirectory(path), expected)) {
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  }
}

function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  }
  return constants.O_NOFOLLOW
}

function validStateDescriptor(descriptor: number, directory: TrustedDirectory): void {
  const info = fstatSync(descriptor)
  if (!info.isFile() || info.nlink !== 1 || info.dev !== directory.dev ||
    info.uid !== directory.uid || (info.mode & 0o777) !== 0o600 ||
    info.size > MAX_STATE_BYTES) fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
}

function syncDirectory(path: string, expected: TrustedDirectory): void {
  assertDirectory(path, expected)
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow(),
  )
  try {
    const info = fstatSync(descriptor)
    if (!info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino ||
      info.uid !== expected.uid) fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  assertDirectory(path, expected)
}

function readStateFile(
  path: string,
  directoryPath: string,
  directory: TrustedDirectory,
): string | undefined {
  assertDirectory(directoryPath, directory)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  }
  try {
    const before = fstatSync(descriptor)
    validStateDescriptor(descriptor, directory)
    const content = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
    assertDirectory(directoryPath, directory)
    return content
  } finally {
    closeSync(descriptor)
  }
}

function verifyPublishedState(
  path: string,
  directoryPath: string,
  directory: TrustedDirectory,
): void {
  const content = readStateFile(path, directoryPath, directory)
  if (content === undefined) fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  parseEnvelope(content)
}

function writePreparedExclusive(
  path: string,
  content: string,
  directoryPath: string,
  directory: TrustedDirectory,
): 'created' | 'exists' {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  assertDirectory(directoryPath, directory)
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  }
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    validStateDescriptor(descriptor, directory)
  } catch {
    // Never remove a possibly published prepare: a partial file must remain a
    // fail-closed drift checkpoint rather than become an apparently absent call.
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  } finally {
    closeSync(descriptor)
  }
  verifyPublishedState(path, directoryPath, directory)
  syncDirectory(directoryPath, directory)
  verifyPublishedState(path, directoryPath, directory)
  return 'created'
}

function replaceStateAtomic(
  path: string,
  content: string,
  directoryPath: string,
  directory: TrustedDirectory,
): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  assertDirectory(directoryPath, directory)
  const temporary = join(directoryPath, `.${randomUUID()}.operation.tmp`)
  let descriptor: number | null = null
  let published = false
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    validStateDescriptor(descriptor, directory)
    closeSync(descriptor)
    descriptor = null
    assertDirectory(directoryPath, directory)
    renameSync(temporary, path)
    published = true
    verifyPublishedState(path, directoryPath, directory)
    syncDirectory(directoryPath, directory)
    verifyPublishedState(path, directoryPath, directory)
  } catch (error) {
    if (error instanceof DurableDelegationOperationJournalError) throw error
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* own best-effort cleanup */ }
    }
    if (!published) {
      try { unlinkSync(temporary) } catch { /* own best-effort cleanup */ }
    }
  }
}

function captureOutcome(value: unknown, phase: DurableDelegationOperationPhase): Readonly<{
  payload: unknown
  receipt: Readonly<DurableDelegationOperationReceiptV1>
}> {
  const outcome = exactRecord(value, ['payload', 'receipt'])
  const payload = frozenSnapshot(outcome['payload'], MAX_PAYLOAD_BYTES)
  const resultHash = sha256(RESULT_DOMAIN, canonicalJson(payload, MAX_PAYLOAD_BYTES))
  const receipt = captureReceiptInput(outcome['receipt'], phase, resultHash)
  return Object.freeze({ payload, receipt })
}

function settledState(record: SettledRecordV1): Extract<
  DurableDelegationOperationStateV1,
  { state: 'settled' }
> {
  return Object.freeze({
    state: 'settled',
    key: frozenSnapshot(record.key),
    payload: frozenSnapshot(record.payload, MAX_PAYLOAD_BYTES),
    receipt: frozenSnapshot(record.receipt),
  })
}

/** Stable canonical request hashing shared by provider/tool wrappers. */
export function hashDurableDelegationOperationRequestV1(request: unknown): string {
  return sha256(REQUEST_DOMAIN, canonicalJson(request, MAX_REQUEST_BYTES))
}

/**
 * Creates only the private `operations` directory. No provider/tool port is
 * imported or invoked by this dormant foundation.
 */
export function makeNodeDurableDelegationOperationJournalV1(input: {
  readonly runRoot: string
}): DurableDelegationOperationJournalV1 {
  const options = exactRecord(input, ['runRoot'])
  const runRoot = options['runRoot']
  if (typeof runRoot !== 'string') fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  const runParentPath = dirname(runRoot)
  const runParent = trustedDirectory(runParentPath)
  const root = trustedDirectory(runRoot)
  if (root.dev !== runParent.dev) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  const operationRoot = join(runRoot, 'operations')
  try {
    mkdirSync(operationRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
  }
  const operations = trustedDirectory(operationRoot)
  if (operations.dev !== root.dev) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  // The run root may itself have been created by the existing persistence
  // adapter immediately before this journal. Persist the complete local chain
  // that can otherwise disappear after prepare + external I/O.
  syncDirectory(operationRoot, operations)
  syncDirectory(runRoot, root)
  syncDirectory(runParentPath, runParent)
  assertDirectory(runParentPath, runParent)
  assertDirectory(runRoot, root)
  assertDirectory(operationRoot, operations)
  const runRootHash = sha256(ROOT_DOMAIN, runRoot)
  const controller = Object.freeze({})

  const assertChain = (): void => {
    assertDirectory(runParentPath, runParent)
    assertDirectory(runRoot, root)
    assertDirectory(operationRoot, operations)
  }

  const inspectCaptured = (
    key: Readonly<DurableDelegationOperationKeyV1>,
  ): DurableDelegationOperationStateV1 => {
    try {
      assertChain()
      try {
        if (key.runRootHash !== runRootHash) {
          return Object.freeze({ state: 'drift', reason: 'key-mismatch' })
        }
        const expectedSlotHash = slotHash(key)
        const content = readStateFile(
          join(operationRoot, `${expectedSlotHash}.json`),
          operationRoot,
          operations,
        )
        if (content === undefined) return Object.freeze({ state: 'absent' })
        const record = parseEnvelope(content)
        if (slotHash(record.key) !== expectedSlotHash) {
          return Object.freeze({ state: 'drift', reason: 'corrupt-or-unsafe-state' })
        }
        if (!keysEqual(record.key, key)) {
          return Object.freeze({ state: 'drift', reason: 'key-mismatch' })
        }
        if (record.kind === 'operation.prepared') {
          return Object.freeze({ state: 'ambiguous', key: frozenSnapshot(record.key) })
        }
        return settledState(record)
      } finally {
        assertChain()
      }
    } catch {
      return Object.freeze({ state: 'drift', reason: 'corrupt-or-unsafe-state' })
    }
  }

  const journal: DurableDelegationOperationJournalV1 = {
    runRootHash,

    inspect(key) {
      return inspectCaptured(captureKey(key))
    },

    prepare(key) {
      const captured = captureKey(key)
      const current = inspectCaptured(captured)
      if (current.state !== 'absent') return current
      const record: PreparedRecordV1 = Object.freeze({ kind: 'operation.prepared', key: captured })
      const encoded = envelope(record)
      const expectedSlotHash = slotHash(captured)
      assertChain()
      const disposition = writePreparedExclusive(
        join(operationRoot, `${expectedSlotHash}.json`),
        encoded,
        operationRoot,
        operations,
      )
      assertChain()
      if (disposition === 'exists') {
        const raced = inspectCaptured(captured)
        if (raced.state === 'absent') {
          fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
        }
        return raced
      }
      const permit = Object.freeze({
        [settlementPermitBrand]: true as const,
        kind: 'durable-delegation-operation-settlement-permit-v1' as const,
      })
      permitStates.set(permit, {
        controller,
        slotHash: expectedSlotHash,
        key: captured,
        preparedHash: recordHash(record),
      })
      return Object.freeze({
        state: 'prepared',
        disposition: 'created',
        key: frozenSnapshot(captured),
        permit,
      })
    },

    settle(permit, outcome) {
      if (typeof permit !== 'object' || permit === null || consumedPermits.has(permit)) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const permitState = permitStates.get(permit)
      if (permitState === undefined || permitState.controller !== controller) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const captured = captureOutcome(outcome, permitState.key.phase)
      // Once a valid owned result reaches settlement, every persistence or
      // identity failure is ambiguous. The permit must never authorize a
      // second publication attempt in this process.
      consumedPermits.add(permit)
      assertChain()
      const current = inspectCaptured(permitState.key)
      if (current.state !== 'ambiguous') {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const prepared: PreparedRecordV1 = Object.freeze({
        kind: 'operation.prepared',
        key: permitState.key,
      })
      if (recordHash(prepared) !== permitState.preparedHash) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      assertChain()
      const record: SettledRecordV1 = Object.freeze({
        kind: 'operation.settled',
        key: permitState.key,
        payload: captured.payload,
        receipt: captured.receipt,
      })
      replaceStateAtomic(
        join(operationRoot, `${permitState.slotHash}.json`),
        envelope(record),
        operationRoot,
        operations,
      )
      assertChain()
      return settledState(record)
    },
  }
  return Object.freeze(journal)
}

interface PreparedRecordV2 {
  readonly kind: 'operation-v2.prepared'
  readonly key: Readonly<DurableDelegationOperationKeyV2>
}

interface SettledRecordV2 {
  readonly kind: 'operation-v2.settled'
  readonly key: Readonly<DurableDelegationOperationKeyV2>
  readonly payload: unknown
  readonly receipt: Readonly<DurableDelegationOperationReceiptV1>
}

type OperationRecordV2 = PreparedRecordV2 | SettledRecordV2

interface PermitStateV2 {
  readonly controller: object
  readonly attemptSlotHash: string
  readonly key: Readonly<DurableDelegationOperationKeyV2>
  readonly preparedHash: string
}

const permitStatesV2 = new WeakMap<object, PermitStateV2>()
const consumedPermitsV2 = new WeakSet<object>()

function logicalSlotProjection(value: unknown): Readonly<{
  delegationId: string
  taskId: string
  phase: DurableDelegationOperationPhase
  ordinal: number
}> {
  const slot = exactRecord(value, ['delegationId', 'taskId', 'phase', 'ordinal'])
  if (!boundedId(slot['delegationId']) || !boundedId(slot['taskId']) ||
    (slot['phase'] !== 'provider' && slot['phase'] !== 'tool') ||
    !Number.isSafeInteger(slot['ordinal']) || Number(slot['ordinal']) < 1 ||
    Number(slot['ordinal']) > MAX_ORDINAL) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return Object.freeze({
    delegationId: slot['delegationId'],
    taskId: slot['taskId'],
    phase: slot['phase'],
    ordinal: Number(slot['ordinal']),
  })
}

function logicalSlotHashV2(value: {
  readonly delegationId: string
  readonly taskId: string
  readonly phase: DurableDelegationOperationPhase
  readonly ordinal: number
}): string {
  const slot = logicalSlotProjection(value)
  return sha256(LOGICAL_SLOT_V2_DOMAIN, JSON.stringify([
    slot.delegationId,
    slot.taskId,
    slot.phase,
    slot.ordinal,
  ]))
}

/** Stable logical address shared by attempts one and two. */
export function hashDurableDelegationOperationLogicalSlotV2(value: {
  readonly delegationId: string
  readonly taskId: string
  readonly phase: DurableDelegationOperationPhase
  readonly ordinal: number
}): string {
  return logicalSlotHashV2(value)
}

/** V2 uses a separate request-hash domain; V1 records are never migrated. */
export function hashDurableDelegationOperationRequestV2(request: unknown): string {
  return sha256(REQUEST_V2_DOMAIN, canonicalJson(request, MAX_REQUEST_BYTES))
}

function captureKeyV2(value: unknown): Readonly<DurableDelegationOperationKeyV2> {
  const key = exactRecord(value, [
    'runRootHash',
    'bindingHash',
    'delegationId',
    'taskId',
    'phase',
    'ordinal',
    'canonicalRequestHash',
    'authorityHash',
    'policyRevision',
    'logicalSlotHash',
    'attempt',
    'resolutionHash',
  ])
  if (typeof key['runRootHash'] !== 'string' || !HASH.test(key['runRootHash']) ||
    typeof key['bindingHash'] !== 'string' || !HASH.test(key['bindingHash']) ||
    !boundedId(key['delegationId']) || !boundedId(key['taskId']) ||
    (key['phase'] !== 'provider' && key['phase'] !== 'tool') ||
    !Number.isSafeInteger(key['ordinal']) || Number(key['ordinal']) < 1 ||
    Number(key['ordinal']) > MAX_ORDINAL ||
    typeof key['canonicalRequestHash'] !== 'string' || !HASH.test(key['canonicalRequestHash']) ||
    typeof key['authorityHash'] !== 'string' || !HASH.test(key['authorityHash']) ||
    typeof key['policyRevision'] !== 'string' || !POLICY_REVISION.test(key['policyRevision']) ||
    typeof key['logicalSlotHash'] !== 'string' || !HASH.test(key['logicalSlotHash']) ||
    (key['attempt'] !== 1 && key['attempt'] !== 2) ||
    typeof key['resolutionHash'] !== 'string' || !HASH.test(key['resolutionHash'])) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  const captured = Object.freeze({
    runRootHash: key['runRootHash'],
    bindingHash: key['bindingHash'],
    delegationId: key['delegationId'],
    taskId: key['taskId'],
    phase: key['phase'],
    ordinal: Number(key['ordinal']),
    canonicalRequestHash: key['canonicalRequestHash'],
    authorityHash: key['authorityHash'],
    policyRevision: key['policyRevision'],
    logicalSlotHash: key['logicalSlotHash'],
    attempt: key['attempt'],
    resolutionHash: key['resolutionHash'],
  }) as Readonly<DurableDelegationOperationKeyV2>
  if (captured.logicalSlotHash !== logicalSlotHashV2({
    delegationId: captured.delegationId,
    taskId: captured.taskId,
    phase: captured.phase,
    ordinal: captured.ordinal,
  })) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return captured
}

function keysEqualV2(
  left: Readonly<DurableDelegationOperationKeyV2>,
  right: Readonly<DurableDelegationOperationKeyV2>,
): boolean {
  return canonicalJson(left, MAX_STATE_BYTES) === canonicalJson(right, MAX_STATE_BYTES)
}

function sameAttemptFamilyV2(
  first: Readonly<DurableDelegationOperationKeyV2>,
  second: Readonly<DurableDelegationOperationKeyV2>,
): boolean {
  const projection = (key: Readonly<DurableDelegationOperationKeyV2>): unknown => ({
    runRootHash: key.runRootHash,
    bindingHash: key.bindingHash,
    delegationId: key.delegationId,
    taskId: key.taskId,
    phase: key.phase,
    ordinal: key.ordinal,
    canonicalRequestHash: key.canonicalRequestHash,
    authorityHash: key.authorityHash,
    policyRevision: key.policyRevision,
    logicalSlotHash: key.logicalSlotHash,
  })
  return canonicalJson(projection(first), MAX_STATE_BYTES) ===
    canonicalJson(projection(second), MAX_STATE_BYTES)
}

function attemptSlotHashV2(key: Readonly<DurableDelegationOperationKeyV2>): string {
  return sha256(ATTEMPT_SLOT_V2_DOMAIN, JSON.stringify([
    key.logicalSlotHash,
    key.attempt,
  ]))
}

function recordHashV2(record: OperationRecordV2): string {
  return sha256(RECORD_V2_DOMAIN, canonicalJson(record, MAX_STATE_BYTES))
}

function envelopeV2(record: OperationRecordV2): string {
  return canonicalJson({ schemaVersion: 2, recordHash: recordHashV2(record), record },
    MAX_STATE_BYTES) + '\n'
}

function validateStoredReceiptV2(
  value: unknown,
  phase: DurableDelegationOperationPhase,
  payload: unknown,
): Readonly<DurableDelegationOperationReceiptV1> {
  const receipt = exactRecord(
    value,
    ['receiptVersion', 'kind', 'resultHash', 'spendUsd', 'wallMs', 'effect'],
    ['inputTokens', 'outputTokens', 'evidenceHash'],
  )
  if (receipt['receiptVersion'] !== 1 ||
    receipt['kind'] !== (phase === 'provider'
      ? 'runtime.provider-receipt'
      : 'runtime.tool-receipt') ||
    typeof receipt['resultHash'] !== 'string' || !HASH.test(receipt['resultHash']) ||
    receipt['resultHash'] !== sha256(RESULT_V2_DOMAIN, canonicalJson(payload, MAX_PAYLOAD_BYTES))) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return captureReceiptInput({
    spendUsd: receipt['spendUsd'],
    wallMs: receipt['wallMs'],
    effect: receipt['effect'],
    ...(receipt['inputTokens'] === undefined ? {} : { inputTokens: receipt['inputTokens'] }),
    ...(receipt['outputTokens'] === undefined ? {} : { outputTokens: receipt['outputTokens'] }),
    ...(receipt['evidenceHash'] === undefined ? {} : { evidenceHash: receipt['evidenceHash'] }),
  }, phase, receipt['resultHash'])
}

function parseEnvelopeV2(content: string): OperationRecordV2 {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  let parsed: unknown
  try { parsed = JSON.parse(content) } catch { fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID') }
  const stored = exactRecord(parsed, ['schemaVersion', 'recordHash', 'record'])
  if (stored['schemaVersion'] !== 2 || typeof stored['recordHash'] !== 'string' ||
    !HASH.test(stored['recordHash'])) fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  const source = exactRecord(stored['record'], ['kind', 'key'], ['payload', 'receipt'])
  const key = captureKeyV2(source['key'])
  let record: OperationRecordV2
  if (source['kind'] === 'operation-v2.prepared' &&
    source['payload'] === undefined && source['receipt'] === undefined) {
    record = Object.freeze({ kind: 'operation-v2.prepared', key })
  } else if (source['kind'] === 'operation-v2.settled' &&
    Object.hasOwn(source, 'payload') && Object.hasOwn(source, 'receipt')) {
    const payload = frozenSnapshot(source['payload'], MAX_PAYLOAD_BYTES)
    const receipt = validateStoredReceiptV2(source['receipt'], key.phase, payload)
    record = Object.freeze({ kind: 'operation-v2.settled', key, payload, receipt })
  } else {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  if (stored['recordHash'] !== recordHashV2(record)) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  return record
}

function captureOutcomeV2(value: unknown, phase: DurableDelegationOperationPhase): Readonly<{
  payload: unknown
  receipt: Readonly<DurableDelegationOperationReceiptV1>
}> {
  const outcome = exactRecord(value, ['payload', 'receipt'])
  const payload = frozenSnapshot(outcome['payload'], MAX_PAYLOAD_BYTES)
  const resultHash = sha256(RESULT_V2_DOMAIN, canonicalJson(payload, MAX_PAYLOAD_BYTES))
  const receipt = captureReceiptInput(outcome['receipt'], phase, resultHash)
  return Object.freeze({ payload, receipt })
}

function stateV2(record: OperationRecordV2): DurableDelegationOperationInventoryEntryV2 {
  if (record.kind === 'operation-v2.prepared') {
    return Object.freeze({
      state: 'ambiguous',
      key: frozenSnapshot(record.key),
    })
  }
  return Object.freeze({
    state: 'settled',
    key: frozenSnapshot(record.key),
    payload: frozenSnapshot(record.payload, MAX_PAYLOAD_BYTES),
    receipt: frozenSnapshot(record.receipt),
  })
}

function v2EntryOrder(
  left: DurableDelegationOperationInventoryEntryV2,
  right: DurableDelegationOperationInventoryEntryV2,
): number {
  const logical = left.key.logicalSlotHash.localeCompare(right.key.logicalSlotHash)
  if (logical !== 0) return logical
  return left.key.attempt - right.key.attempt
}

function validateAttemptInventoryV2(
  entries: readonly DurableDelegationOperationInventoryEntryV2[],
): void {
  const byLogical = new Map<string, DurableDelegationOperationInventoryEntryV2[]>()
  for (const entry of entries) {
    const current = byLogical.get(entry.key.logicalSlotHash) ?? []
    if (current.some(candidate => candidate.key.attempt === entry.key.attempt)) {
      fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
    }
    current.push(entry)
    byLogical.set(entry.key.logicalSlotHash, current)
  }
  for (const attempts of byLogical.values()) {
    const first = attempts.find(entry => entry.key.attempt === 1)
    const second = attempts.find(entry => entry.key.attempt === 2)
    if (second === undefined) continue
    if (first === undefined || first.state !== 'ambiguous' ||
      !sameAttemptFamilyV2(first.key, second.key)) {
      fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
    }
  }
}

function readDirectoryNames(
  path: string,
  expected: TrustedDirectory,
  maximum: number,
): string[] {
  assertDirectory(path, expected)
  let directory: ReturnType<typeof opendirSync>
  try { directory = opendirSync(path) } catch {
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  }
  const names: string[] = []
  let closeFailed = false
  try {
    while (true) {
      const entry = directory.readSync()
      if (entry === null) break
      if (names.length === maximum) {
        fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      }
      names.push(entry.name)
    }
  } catch (error) {
    if (error instanceof DurableDelegationOperationJournalError) throw error
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  } finally {
    try { directory.closeSync() } catch { closeFailed = true }
  }
  if (closeFailed) fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  assertDirectory(path, expected)
  return names.sort()
}

function verifyPublishedStateV2(
  path: string,
  directoryPath: string,
  directory: TrustedDirectory,
): void {
  const content = readStateFile(path, directoryPath, directory)
  if (content === undefined) fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  parseEnvelopeV2(content)
}

function writePreparedExclusiveV2(
  path: string,
  content: string,
  directoryPath: string,
  directory: TrustedDirectory,
): 'created' | 'exists' {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  assertDirectory(directoryPath, directory)
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  }
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    validStateDescriptor(descriptor, directory)
  } catch {
    // A published partial prepare is ambiguity evidence and is never removed.
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  } finally {
    closeSync(descriptor)
  }
  verifyPublishedStateV2(path, directoryPath, directory)
  syncDirectory(directoryPath, directory)
  verifyPublishedStateV2(path, directoryPath, directory)
  return 'created'
}

function replaceStateAtomicV2(
  path: string,
  content: string,
  directoryPath: string,
  directory: TrustedDirectory,
): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  }
  assertDirectory(directoryPath, directory)
  const temporary = join(directoryPath, `.${randomUUID()}.operation-v2.tmp`)
  let descriptor: number | null = null
  let published = false
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    validStateDescriptor(descriptor, directory)
    closeSync(descriptor)
    descriptor = null
    assertDirectory(directoryPath, directory)
    renameSync(temporary, path)
    published = true
    verifyPublishedStateV2(path, directoryPath, directory)
    syncDirectory(directoryPath, directory)
    verifyPublishedStateV2(path, directoryPath, directory)
  } catch (error) {
    if (error instanceof DurableDelegationOperationJournalError) throw error
    fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor) } catch { /* own best-effort cleanup */ }
    }
    if (!published) {
      try { unlinkSync(temporary) } catch { /* own best-effort cleanup */ }
    }
  }
}

/**
 * Additive V2 cohort. A durable compatibility barrier at the legacy path makes
 * every V1 implementation fail closed before it can issue a permit. Existing
 * V1 roots are never migrated; V2 requires a fresh, explicitly selected root.
 */
export function makeNodeDurableDelegationOperationJournalV2(input: {
  readonly runRoot: string
}): DurableDelegationOperationJournalV2 {
  const options = exactRecord(input, ['runRoot'])
  const runRoot = options['runRoot']
  if (typeof runRoot !== 'string') fail('DELEGATION_OPERATION_JOURNAL_INPUT_INVALID')
  const runParentPath = dirname(runRoot)
  const runParent = trustedDirectory(runParentPath)
  const root = trustedDirectory(runRoot)
  if (root.dev !== runParent.dev) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')

  const compatibilityBarrierPath = join(runRoot, 'operations')
  const assertCompatibilityBarrier = (): void => {
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(compatibilityBarrierPath) } catch {
      fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
    }
    if (info.isDirectory()) fail('DELEGATION_OPERATION_JOURNAL_COHORT_MIXED')
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
    }
    const content = readStateFile(compatibilityBarrierPath, runRoot, root)
    if (content !== V2_COMPATIBILITY_BARRIER) {
      fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
    }
  }
  const publishCompatibilityBarrier = (): void => {
    try {
      lstatSync(compatibilityBarrierPath)
      assertCompatibilityBarrier()
      return
    } catch (error) {
      if (error instanceof DurableDelegationOperationJournalError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
      }
    }
    let descriptor: number | null = null
    try {
      descriptor = openSync(
        compatibilityBarrierPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
        0o600,
      )
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, V2_COMPATIBILITY_BARRIER, 'utf8')
      fsyncSync(descriptor)
      validStateDescriptor(descriptor, root)
      closeSync(descriptor)
      descriptor = null
      syncDirectory(runRoot, root)
      assertCompatibilityBarrier()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        assertCompatibilityBarrier()
        return
      }
      if (error instanceof DurableDelegationOperationJournalError) throw error
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    } finally {
      if (descriptor !== null) {
        try { closeSync(descriptor) } catch { /* retain the primary failure */ }
      }
    }
  }
  publishCompatibilityBarrier()

  const operationRoot = join(runRoot, 'operations-v2')
  try {
    mkdirSync(operationRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
  }
  const operations = trustedDirectory(operationRoot)
  if (operations.dev !== root.dev) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  const mutationRoot = join(runRoot, 'operations-v2-locks')
  try {
    mkdirSync(mutationRoot, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
  }
  const mutations = trustedDirectory(mutationRoot)
  if (mutations.dev !== root.dev) fail('DELEGATION_OPERATION_JOURNAL_ROOT_UNSAFE')
  syncDirectory(operationRoot, operations)
  syncDirectory(mutationRoot, mutations)
  syncDirectory(runRoot, root)
  syncDirectory(runParentPath, runParent)
  const runRootHash = sha256(ROOT_V2_DOMAIN, runRoot)
  const controller = Object.freeze({})

  const assertChain = (): void => {
    assertDirectory(runParentPath, runParent)
    assertDirectory(runRoot, root)
    assertDirectory(operationRoot, operations)
    assertDirectory(mutationRoot, mutations)
    assertCompatibilityBarrier()
  }

  const withFamilyMutationLock = <T>(logicalSlotHash: string, action: () => T): T => {
    const lockPath = join(mutationRoot, `${logicalSlotHash}.lock`)
    assertChain()
    let descriptor: number
    try {
      descriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
        0o600,
      )
    } catch {
      // A live contender or a crash-left lock both require bounded manual
      // recovery. Never guess that a family mutation is no longer in flight.
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
    try {
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, randomUUID(), 'utf8')
      fsyncSync(descriptor)
      validStateDescriptor(descriptor, mutations)
      syncDirectory(mutationRoot, mutations)
    } catch {
      try { closeSync(descriptor) } catch { /* retain the primary failure */ }
      try { unlinkSync(lockPath) } catch { /* a stale lock remains fail-closed */ }
      fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
    }
    try {
      return action()
    } finally {
      let released = false
      let releaseFailed = false
      try {
        assertDirectory(mutationRoot, mutations)
        const held = fstatSync(descriptor)
        const published = lstatSync(lockPath)
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 ||
          published.dev !== held.dev || published.ino !== held.ino ||
          published.uid !== mutations.uid || (published.mode & 0o777) !== 0o600) {
          fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
        }
        unlinkSync(lockPath)
        syncDirectory(mutationRoot, mutations)
        released = true
      } catch {
        releaseFailed = true
      } finally {
        try { closeSync(descriptor) } catch { releaseFailed = true }
      }
      if (releaseFailed || !released) {
        fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
      }
    }
  }

  const scanCaptured = (): DurableDelegationOperationInventoryV2 => {
    assertChain()
    const names = readDirectoryNames(operationRoot, operations, MAX_V2_INVENTORY_ENTRIES)
    const entries: DurableDelegationOperationInventoryEntryV2[] = []
    let totalBytes = 0
    for (const name of names) {
      const match = V2_STATE_FILE.exec(name)
      if (match === null) fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      const content = readStateFile(join(operationRoot, name), operationRoot, operations)
      if (content === undefined) fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      totalBytes += Buffer.byteLength(content, 'utf8')
      if (totalBytes > MAX_V2_INVENTORY_BYTES) {
        fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      }
      let record: OperationRecordV2
      try { record = parseEnvelopeV2(content) } catch {
        fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      }
      if (record.key.runRootHash !== runRootHash ||
        attemptSlotHashV2(record.key) !== match[1]) {
        fail('DELEGATION_OPERATION_JOURNAL_INVENTORY_INVALID')
      }
      entries.push(stateV2(record))
    }
    entries.sort(v2EntryOrder)
    validateAttemptInventoryV2(entries)
    assertChain()
    return Object.freeze({
      cohortVersion: 2 as const,
      runRootHash,
      entries: Object.freeze(entries),
    })
  }

  const inspectFromInventory = (
    captured: Readonly<DurableDelegationOperationKeyV2>,
    inventory: DurableDelegationOperationInventoryV2,
  ): DurableDelegationOperationStateV2 => {
    if (captured.runRootHash !== runRootHash) {
      return Object.freeze({ state: 'drift', reason: 'key-mismatch' })
    }
    const current = inventory.entries.find(entry =>
      entry.key.logicalSlotHash === captured.logicalSlotHash &&
      entry.key.attempt === captured.attempt)
    if (current === undefined) return Object.freeze({ state: 'absent' })
    if (!keysEqualV2(current.key, captured)) {
      return Object.freeze({ state: 'drift', reason: 'key-mismatch' })
    }
    return current
  }

  const journal: DurableDelegationOperationJournalV2 = {
    runRootHash,

    scan() {
      return scanCaptured()
    },

    inspect(key) {
      const captured = captureKeyV2(key)
      return inspectFromInventory(captured, scanCaptured())
    },

    prepare(key) {
      const captured = captureKeyV2(key)
      return withFamilyMutationLock(captured.logicalSlotHash, () => {
      const inventory = scanCaptured()
      const current = inspectFromInventory(captured, inventory)
      if (current.state !== 'absent') return current

      if (captured.attempt === 1) {
        if (inventory.entries.some(entry => entry.key.logicalSlotHash === captured.logicalSlotHash)) {
          return Object.freeze({ state: 'drift', reason: 'attempt-sequence-invalid' })
        }
      } else {
        const first = inventory.entries.find(entry =>
          entry.key.logicalSlotHash === captured.logicalSlotHash && entry.key.attempt === 1)
        if (first === undefined || first.state !== 'ambiguous' ||
          !sameAttemptFamilyV2(first.key, captured)) {
          return Object.freeze({ state: 'drift', reason: 'attempt-sequence-invalid' })
        }
      }

      const record: PreparedRecordV2 = Object.freeze({
        kind: 'operation-v2.prepared',
        key: captured,
      })
      const expectedSlotHash = attemptSlotHashV2(captured)
      assertChain()
      const disposition = writePreparedExclusiveV2(
        join(operationRoot, `${expectedSlotHash}.json`),
        envelopeV2(record),
        operationRoot,
        operations,
      )
      assertChain()
      if (disposition === 'exists') {
        const raced = inspectFromInventory(captured, scanCaptured())
        if (raced.state === 'absent') {
          fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
        }
        return raced
      }
      const created = inspectFromInventory(captured, scanCaptured())
      if (created.state !== 'ambiguous') {
        fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
      }
      const permit = Object.freeze({
        [settlementPermitV2Brand]: true as const,
        kind: 'durable-delegation-operation-settlement-permit-v2' as const,
      })
      permitStatesV2.set(permit, {
        controller,
        attemptSlotHash: expectedSlotHash,
        key: captured,
        preparedHash: recordHashV2(record),
      })
      return Object.freeze({
        state: 'prepared',
        disposition: 'created',
        key: frozenSnapshot(captured),
        permit,
      })
      })
    },

    settle(permit, outcome) {
      if (typeof permit !== 'object' || permit === null || consumedPermitsV2.has(permit)) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const permitState = permitStatesV2.get(permit)
      if (permitState === undefined || permitState.controller !== controller) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const captured = captureOutcomeV2(outcome, permitState.key.phase)
      consumedPermitsV2.add(permit)
      return withFamilyMutationLock(permitState.key.logicalSlotHash, () => {
      const inventory = scanCaptured()
      const current = inspectFromInventory(permitState.key, inventory)
      const laterAttemptExists = permitState.key.attempt === 1 && inventory.entries.some(entry =>
        entry.key.logicalSlotHash === permitState.key.logicalSlotHash && entry.key.attempt === 2)
      if (current.state !== 'ambiguous' || laterAttemptExists) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const prepared: PreparedRecordV2 = Object.freeze({
        kind: 'operation-v2.prepared',
        key: permitState.key,
      })
      if (recordHashV2(prepared) !== permitState.preparedHash) {
        fail('DELEGATION_OPERATION_JOURNAL_SETTLEMENT_DENIED')
      }
      const record: SettledRecordV2 = Object.freeze({
        kind: 'operation-v2.settled',
        key: permitState.key,
        payload: captured.payload,
        receipt: captured.receipt,
      })
      replaceStateAtomicV2(
        join(operationRoot, `${permitState.attemptSlotHash}.json`),
        envelopeV2(record),
        operationRoot,
        operations,
      )
      const settled = inspectFromInventory(permitState.key, scanCaptured())
      if (settled.state !== 'settled') {
        fail('DELEGATION_OPERATION_JOURNAL_STATE_UNAVAILABLE')
      }
      return settled
      })
    },
  }
  return Object.freeze(journal)
}

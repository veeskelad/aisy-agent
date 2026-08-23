// Dormant installation-wide recovery envelope. It coordinates durable
// projections only; it owns no Telegram, actor, delegation or tool execution.

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'

import type { ResolvedWorkBinding } from '@aisy/core'
import Database from 'better-sqlite3'
import type { ExecutionMode } from './execution-mode.js'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FILENAME = /^[a-z0-9][a-z0-9.-]{0,127}$/
const MAX_TEXT_BYTES = 1024
const MAX_ENVELOPES = 4096
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024
const APPLICATION_ID = 0x4145_4e56 // AENV
const SCHEMA_VERSION = 1
const ENVELOPE_DOMAIN = 'aisy.durable-execution-envelope.identity.v1\0'
const WORK_BINDING_DOMAIN = 'aisy.durable-execution-envelope.work-binding.v1\0'
const RECORD_DOMAIN = 'aisy.durable-execution-envelope.record.v1\0'
const PLAN_DOMAIN = 'aisy.durable-execution-envelope.recovery-plan.v1\0'

const LEASE_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'durable-execution-envelope-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const LEASE_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'durable-execution-envelope-writer',
  filename: 'durable-execution-envelope-writer.sqlite3',
  applicationId: 0x4145_4c53, // AELS
  userVersion: 1,
  exactSchemaSql: LEASE_SCHEMA,
}

const ENVELOPE_SCHEMA = `CREATE TABLE durable_execution_envelopes (
  envelope_hash TEXT PRIMARY KEY NOT NULL CHECK (length(envelope_hash) = 64 AND envelope_hash NOT GLOB '*[^0-9a-f]*'),
  session_id TEXT NOT NULL,
  turn_id_hash TEXT NOT NULL CHECK (length(turn_id_hash) = 64 AND turn_id_hash NOT GLOB '*[^0-9a-f]*'),
  phase TEXT NOT NULL CHECK (phase IN ('running','paused-awaiting-approval','resume-ready','cancelling','terminal','quarantine')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  active_slot INTEGER UNIQUE CHECK (active_slot IS NULL OR active_slot = 1),
  record_json TEXT NOT NULL,
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID`

export type DurableExecutionEnvelopePhaseV1 =
  | 'running'
  | 'paused-awaiting-approval'
  | 'resume-ready'
  | 'cancelling'
  | 'terminal'
  | 'quarantine'

export interface DurableExecutionEnvelopeIdentityV1 {
  readonly schemaVersion: 1
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly sessionId: string
  readonly installationHash: string
  readonly mode: ExecutionMode
  readonly runLivenessHash: string
  readonly workBindingHash: string
  readonly chatBindingHash: string
  readonly replyBindingHash: string
  readonly dispatchId: string
  readonly turnIdHash: string
  readonly executionBindingHash: string
  readonly supervisorBindingHash: string
  readonly continuationHash: string
  readonly policyRevision: string
  readonly envelopeHash: string
}

export interface DurableExecutionTelegramDeliveryV1 {
  readonly revision: number
  readonly delivery: 'pending' | 'delivered'
  readonly executionBindingHash: string
  readonly replyBindingHash: string
  readonly dispatchId: string
  readonly checkpointHash: string
  readonly refHash: string | null
}

export interface DurableExecutionActorRefV1 {
  readonly actorId: string
  readonly actorHash: string
  readonly revision: number
  readonly envelopeHash: string
  readonly workBindingHash: string
  readonly executionBindingHash: string
  readonly policyRevision: string
}

export interface DurableExecutionControlRefV1 {
  readonly controlHash: string
  readonly revision: number
  readonly envelopeHash: string
  readonly supervisorBindingHash: string
  readonly policyRevision: string
}

export interface DurableExecutionDelegationInventoryRefV1 {
  readonly runRootHash: string
  readonly inventoryHash: string
  readonly authorityHash: string
  readonly revision: number
  readonly policyRevision: string
}

export interface DurableExecutionSupervisorReleaseV1 {
  readonly releaseReceiptHash: string
  readonly supervisorBindingHash: string
  readonly runLivenessHash: string
  readonly releasedAtMs: number
}

export interface DurableExecutionTerminalReceiptV1 {
  readonly kind: 'completed' | 'cancelled' | 'failed' | 'denied'
  readonly code: string
  readonly receiptHash: string
  readonly envelopeHash: string
  readonly workBindingHash: string
  readonly executionBindingHash: string
  readonly dispatchId: string
  readonly policyRevision: string
  readonly atMs: number
}

export type DurableExecutionTerminalReceiptInputV1 = DurableExecutionTerminalReceiptV1

export interface DurableExecutionEnvelopeRecordV1 {
  readonly schemaVersion: 1
  readonly revision: number
  readonly phase: DurableExecutionEnvelopePhaseV1
  readonly identity: Readonly<DurableExecutionEnvelopeIdentityV1>
  readonly telegramDelivery: Readonly<DurableExecutionTelegramDeliveryV1>
  readonly delegationInventory: readonly Readonly<DurableExecutionDelegationInventoryRefV1>[]
  /** Projection only: decision state remains owned by durable-turn-actor. */
  readonly actor: Readonly<DurableExecutionActorRefV1> | null
  readonly control: Readonly<DurableExecutionControlRefV1>
  readonly terminalReceipt: Readonly<DurableExecutionTerminalReceiptV1> | null
  readonly supervisorRelease: Readonly<DurableExecutionSupervisorReleaseV1> | null
  readonly retiredAtMs: number | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export type DurableExecutionRecoveryKindV1 =
  | 'inspect-running'
  | 'inspect-awaiting-approval'
  | 'inspect-resume-ready'
  | 'inspect-cancelling'
  | 'inspect-terminal'
  | 'manual-recovery'

export interface DurableExecutionRecoveryPlanV1 {
  readonly schemaVersion: 1
  readonly kind: DurableExecutionRecoveryKindV1
  readonly envelopeHash: string
  readonly revision: number
  readonly phase: DurableExecutionEnvelopePhaseV1
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly sessionId: string
  readonly installationHash: string
  readonly mode: ExecutionMode
  readonly runLivenessHash: string
  readonly workBindingHash: string
  readonly chatBindingHash: string
  readonly replyBindingHash: string
  readonly dispatchId: string
  readonly turnIdHash: string
  readonly executionBindingHash: string
  readonly supervisorBindingHash: string
  readonly continuationHash: string
  readonly policyRevision: string
  readonly telegramDelivery: Readonly<DurableExecutionTelegramDeliveryV1>
  readonly delegationInventory: readonly Readonly<DurableExecutionDelegationInventoryRefV1>[]
  readonly actor: Readonly<DurableExecutionActorRefV1> | null
  readonly control: Readonly<DurableExecutionControlRefV1>
  readonly terminalReceipt: Readonly<DurableExecutionTerminalReceiptV1> | null
  readonly supervisorRelease: Readonly<DurableExecutionSupervisorReleaseV1> | null
  readonly planHash: string
}

export type DurableExecutionEnvelopeErrorCode =
  | 'DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID'
  | 'DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE'
  | 'DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT'
  | 'DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE'
  | 'DURABLE_EXECUTION_ENVELOPE_STORE_CLOSED'
  | 'DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED'

export class DurableExecutionEnvelopeError extends Error {
  constructor(readonly code: DurableExecutionEnvelopeErrorCode) {
    super(code)
    this.name = 'DurableExecutionEnvelopeError'
  }
}

export interface DurableExecutionEnvelopeStartV1 {
  readonly identity: Omit<DurableExecutionEnvelopeIdentityV1, 'schemaVersion' | 'envelopeHash'> & {
    readonly envelopeHash: string
  }
  readonly telegramDelivery: DurableExecutionTelegramDeliveryV1
  readonly delegationInventory: readonly DurableExecutionDelegationInventoryRefV1[]
  readonly actor: DurableExecutionActorRefV1 | null
  readonly control: DurableExecutionControlRefV1
}

export interface DurableExecutionEnvelopeTransitionV1 {
  readonly envelopeHash: string
  readonly expectedRevision: number
  readonly expectedPhase: DurableExecutionEnvelopePhaseV1
  readonly nextPhase: DurableExecutionEnvelopePhaseV1
  readonly telegramDelivery: DurableExecutionTelegramDeliveryV1
  readonly delegationInventory: readonly DurableExecutionDelegationInventoryRefV1[]
  readonly actor: DurableExecutionActorRefV1 | null
  readonly control: DurableExecutionControlRefV1
  readonly terminalReceipt: DurableExecutionTerminalReceiptInputV1 | null
}

export type DurableExecutionEnvelopeStartResultV1 =
  | Readonly<{ kind: 'started'; record: DurableExecutionEnvelopeRecordV1 }>
  | Readonly<{ kind: 'busy'; plan: DurableExecutionRecoveryPlanV1 }>

export interface DurableExecutionEnvelopeManagerV1 {
  start(input: DurableExecutionEnvelopeStartV1): DurableExecutionEnvelopeStartResultV1
  transition(input: DurableExecutionEnvelopeTransitionV1): DurableExecutionEnvelopeRecordV1
  retireTerminal(input: Readonly<{
    envelopeHash: string
    expectedRevision: number
    receiptHash: string
    releaseReceiptHash: string
  }>): DurableExecutionEnvelopeRecordV1
  recordTelegramDelivery(input: Readonly<{
    envelopeHash: string
    expectedRevision: number
    delivery: DurableExecutionTelegramDeliveryV1
  }>): DurableExecutionEnvelopeRecordV1
  recordSupervisorRelease(input: Readonly<{
    envelopeHash: string
    expectedRevision: number
    release: DurableExecutionSupervisorReleaseV1
  }>): DurableExecutionEnvelopeRecordV1
}

export interface DurableExecutionEnvelopeInspectorV1 {
  inspect(envelopeHash: string): DurableExecutionEnvelopeRecordV1 | null
  recoveryPlan(): DurableExecutionRecoveryPlanV1 | null
}

export interface NodeDurableExecutionEnvelopeControllerV1 {
  readonly manager: DurableExecutionEnvelopeManagerV1
  readonly inspector: DurableExecutionEnvelopeInspectorV1
  close(): void
}

function fail(code: DurableExecutionEnvelopeErrorCode): never {
  throw new DurableExecutionEnvelopeError(code)
}

function sqliteCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function nodeCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function mapStoreError(error: unknown): DurableExecutionEnvelopeError {
  if (error instanceof DurableExecutionEnvelopeError) return error
  if (error instanceof PrivateSqliteLeaseError) {
    if (error.failure === 'unsafe') {
      return new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    }
    if (error.failure === 'corrupt') {
      return new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    }
    return new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  }
  const code = sqliteCode(error)
  if (code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_CORRUPT') === true ||
    code?.startsWith('SQLITE_SCHEMA') === true) {
    return new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
  }
  return new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
    result[key] = descriptor.value
  }
  return result
}

function text(value: unknown, maximumBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    value.includes('\0') || Buffer.byteLength(value, 'utf8') > maximumBytes ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return value
}

function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!ID.test(result)) fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return value
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return value
}

function phase(value: unknown): DurableExecutionEnvelopePhaseV1 {
  if (value !== 'running' && value !== 'paused-awaiting-approval' &&
    value !== 'resume-ready' && value !== 'cancelling' && value !== 'terminal' &&
    value !== 'quarantine') fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  return value
}

function sha256(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update(value, 'utf8').digest('hex')
}

function cleanBinding(value: unknown): Readonly<ResolvedWorkBinding> {
  const raw = exact(value, ['operatorId', 'profileId', 'projectId', 'sessionId', 'scope'], ['botId'])
  if (raw['scope'] !== 'workspace' && raw['scope'] !== 'project' && raw['scope'] !== 'session') {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze({
    ...(raw['botId'] === undefined ? {} : { botId: text(raw['botId'], 128) }),
    operatorId: text(raw['operatorId']),
    profileId: text(raw['profileId']),
    projectId: text(raw['projectId']),
    sessionId: text(raw['sessionId']),
    scope: raw['scope'],
  })
}

type DurableExecutionIdentityProjectionV1 = Omit<
DurableExecutionEnvelopeIdentityV1,
'schemaVersion' | 'envelopeHash'
>

function identityProjection(
  input: DurableExecutionIdentityProjectionV1,
): Readonly<DurableExecutionIdentityProjectionV1> {
  const raw = exact(input, [
    'binding', 'sessionId', 'installationHash', 'mode', 'runLivenessHash', 'workBindingHash',
    'chatBindingHash', 'replyBindingHash', 'dispatchId', 'turnIdHash', 'executionBindingHash',
    'supervisorBindingHash', 'continuationHash', 'policyRevision',
  ])
  const binding = cleanBinding(raw['binding'])
  const sessionId = text(raw['sessionId'])
  const workBindingHash = hash(raw['workBindingHash'])
  const executionBindingHash = hash(raw['executionBindingHash'])
  const supervisorBindingHash = hash(raw['supervisorBindingHash'])
  if (sessionId !== binding.sessionId ||
    workBindingHash !== sha256(WORK_BINDING_DOMAIN, JSON.stringify(binding)) ||
    executionBindingHash !== supervisorBindingHash ||
    (raw['mode'] !== 'auto' && raw['mode'] !== 'confirm' && raw['mode'] !== 'plan' &&
      raw['mode'] !== 'bypass')) fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  return Object.freeze({
    binding,
    sessionId,
    installationHash: hash(raw['installationHash']),
    mode: raw['mode'],
    runLivenessHash: hash(raw['runLivenessHash']),
    workBindingHash,
    chatBindingHash: hash(raw['chatBindingHash']),
    replyBindingHash: hash(raw['replyBindingHash']),
    dispatchId: hash(raw['dispatchId']),
    turnIdHash: hash(raw['turnIdHash']),
    executionBindingHash,
    supervisorBindingHash,
    continuationHash: hash(raw['continuationHash']),
    policyRevision: identifier(raw['policyRevision']),
  })
}

export function durableExecutionWorkBindingHash(binding: ResolvedWorkBinding): string {
  return sha256(WORK_BINDING_DOMAIN, JSON.stringify(cleanBinding(binding)))
}

export function durableExecutionEnvelopeHash(input: DurableExecutionIdentityProjectionV1): string {
  return sha256(ENVELOPE_DOMAIN, JSON.stringify(identityProjection(input)))
}

function cleanIdentity(value: unknown): Readonly<DurableExecutionEnvelopeIdentityV1> {
  const raw = exact(value, [
    'schemaVersion', 'binding', 'sessionId', 'installationHash', 'mode', 'runLivenessHash',
    'workBindingHash', 'chatBindingHash', 'replyBindingHash', 'dispatchId', 'turnIdHash',
    'executionBindingHash', 'supervisorBindingHash', 'continuationHash', 'policyRevision',
    'envelopeHash',
  ])
  if (raw['schemaVersion'] !== 1) fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  const { schemaVersion: _schemaVersion, envelopeHash: rawHash, ...projection } = raw
  const projected = identityProjection(projection as DurableExecutionIdentityProjectionV1)
  const envelopeHash = hash(rawHash)
  if (envelopeHash !== durableExecutionEnvelopeHash(projected)) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze({ schemaVersion: 1, ...projected, envelopeHash })
}

function cleanTelegram(value: unknown): Readonly<DurableExecutionTelegramDeliveryV1> {
  const raw = exact(value, [
    'revision', 'delivery', 'executionBindingHash', 'replyBindingHash', 'dispatchId',
    'checkpointHash', 'refHash',
  ])
  const delivery = raw['delivery']
  const refHash = raw['refHash'] === null ? null : hash(raw['refHash'])
  if ((delivery !== 'pending' && delivery !== 'delivered') ||
    (delivery === 'pending') !== (refHash === null)) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze({
    revision: integer(raw['revision'], 1),
    delivery,
    executionBindingHash: hash(raw['executionBindingHash']),
    replyBindingHash: hash(raw['replyBindingHash']),
    dispatchId: hash(raw['dispatchId']),
    checkpointHash: hash(raw['checkpointHash']),
    refHash,
  })
}

function cleanInventory(
  value: unknown,
): readonly Readonly<DurableExecutionDelegationInventoryRefV1>[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > 1024) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  const result = value.map(item => {
    const raw = exact(item, [
      'runRootHash', 'inventoryHash', 'authorityHash', 'revision', 'policyRevision',
    ])
    return Object.freeze({
      runRootHash: hash(raw['runRootHash']),
      inventoryHash: hash(raw['inventoryHash']),
      authorityHash: hash(raw['authorityHash']),
      revision: integer(raw['revision'], 1),
      policyRevision: identifier(raw['policyRevision']),
    })
  })
  if (result.some((item, index) => index > 0 &&
    result[index - 1]!.runRootHash >= item.runRootHash)) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze(result)
}

function cleanActor(value: unknown): Readonly<DurableExecutionActorRefV1> | null {
  if (value === null) return null
  const raw = exact(value, [
    'actorId', 'actorHash', 'revision', 'envelopeHash', 'workBindingHash',
    'executionBindingHash', 'policyRevision',
  ])
  return Object.freeze({
    actorId: identifier(raw['actorId']),
    actorHash: hash(raw['actorHash']),
    revision: integer(raw['revision'], 1),
    envelopeHash: hash(raw['envelopeHash']),
    workBindingHash: hash(raw['workBindingHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    policyRevision: identifier(raw['policyRevision']),
  })
}

function cleanControl(value: unknown): Readonly<DurableExecutionControlRefV1> {
  const raw = exact(value, [
    'controlHash', 'revision', 'envelopeHash', 'supervisorBindingHash', 'policyRevision',
  ])
  return Object.freeze({
    controlHash: hash(raw['controlHash']),
    revision: integer(raw['revision'], 1),
    envelopeHash: hash(raw['envelopeHash']),
    supervisorBindingHash: hash(raw['supervisorBindingHash']),
    policyRevision: identifier(raw['policyRevision']),
  })
}

function cleanTerminal(value: unknown): Readonly<DurableExecutionTerminalReceiptV1> | null {
  if (value === null) return null
  const raw = exact(value, [
    'kind', 'code', 'receiptHash', 'envelopeHash', 'workBindingHash',
    'executionBindingHash', 'dispatchId', 'policyRevision', 'atMs',
  ])
  if (raw['kind'] !== 'completed' && raw['kind'] !== 'cancelled' && raw['kind'] !== 'failed' &&
    raw['kind'] !== 'denied') {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze({
    kind: raw['kind'],
    code: identifier(raw['code']),
    receiptHash: hash(raw['receiptHash']),
    envelopeHash: hash(raw['envelopeHash']),
    workBindingHash: hash(raw['workBindingHash']),
    executionBindingHash: hash(raw['executionBindingHash']),
    dispatchId: hash(raw['dispatchId']),
    policyRevision: identifier(raw['policyRevision']),
    atMs: integer(raw['atMs']),
  })
}

function cleanTerminalInput(
  value: unknown,
): Readonly<DurableExecutionTerminalReceiptInputV1> | null {
  return cleanTerminal(value)
}

function cleanRelease(value: unknown): Readonly<DurableExecutionSupervisorReleaseV1> | null {
  if (value === null) return null
  const raw = exact(value, [
    'releaseReceiptHash', 'supervisorBindingHash', 'runLivenessHash', 'releasedAtMs',
  ])
  return Object.freeze({
    releaseReceiptHash: hash(raw['releaseReceiptHash']),
    supervisorBindingHash: hash(raw['supervisorBindingHash']),
    runLivenessHash: hash(raw['runLivenessHash']),
    releasedAtMs: integer(raw['releasedAtMs']),
  })
}

function cleanRecord(value: unknown): Readonly<DurableExecutionEnvelopeRecordV1> {
  const raw = exact(value, [
    'schemaVersion', 'revision', 'phase', 'identity', 'telegramDelivery',
    'delegationInventory', 'actor', 'control', 'terminalReceipt', 'supervisorRelease',
    'retiredAtMs', 'createdAtMs', 'updatedAtMs',
  ])
  if (raw['schemaVersion'] !== 1) fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  const recordPhase = phase(raw['phase'])
  const identity = cleanIdentity(raw['identity'])
  const telegramDelivery = cleanTelegram(raw['telegramDelivery'])
  const delegationInventory = cleanInventory(raw['delegationInventory'])
  const actor = cleanActor(raw['actor'])
  const control = cleanControl(raw['control'])
  const terminalReceipt = cleanTerminal(raw['terminalReceipt'])
  const supervisorRelease = cleanRelease(raw['supervisorRelease'])
  const retiredAtMs = raw['retiredAtMs'] === null ? null : integer(raw['retiredAtMs'])
  const createdAtMs = integer(raw['createdAtMs'])
  const updatedAtMs = integer(raw['updatedAtMs'])
  if (updatedAtMs < createdAtMs || (recordPhase === 'terminal') !== (terminalReceipt !== null) ||
    (retiredAtMs !== null && (recordPhase !== 'terminal' || retiredAtMs !== updatedAtMs)) ||
    ((recordPhase === 'paused-awaiting-approval' || recordPhase === 'resume-ready') &&
      actor === null) || (terminalReceipt !== null && terminalReceipt.atMs > updatedAtMs) ||
    (terminalReceipt !== null && terminalReceipt.atMs < createdAtMs) ||
    (terminalReceipt !== null && (terminalReceipt.envelopeHash !== identity.envelopeHash ||
      terminalReceipt.workBindingHash !== identity.workBindingHash ||
      terminalReceipt.executionBindingHash !== identity.executionBindingHash ||
      terminalReceipt.dispatchId !== identity.dispatchId ||
      terminalReceipt.policyRevision !== identity.policyRevision)) ||
    (supervisorRelease !== null && (recordPhase !== 'terminal' ||
      telegramDelivery.delivery !== 'delivered' || supervisorRelease.releasedAtMs > updatedAtMs ||
      supervisorRelease.releasedAtMs < createdAtMs)) ||
    (retiredAtMs !== null && (telegramDelivery.delivery !== 'delivered' ||
      supervisorRelease === null)) ||
    telegramDelivery.executionBindingHash !== identity.executionBindingHash ||
    telegramDelivery.replyBindingHash !== identity.replyBindingHash ||
    telegramDelivery.dispatchId !== identity.dispatchId ||
    delegationInventory.some(item => item.policyRevision !== identity.policyRevision) ||
    (actor !== null && (actor.envelopeHash !== identity.envelopeHash ||
      actor.workBindingHash !== identity.workBindingHash ||
      actor.executionBindingHash !== identity.executionBindingHash ||
      actor.policyRevision !== identity.policyRevision)) ||
    control.envelopeHash !== identity.envelopeHash ||
    control.supervisorBindingHash !== identity.supervisorBindingHash ||
    control.policyRevision !== identity.policyRevision ||
    (supervisorRelease !== null &&
      (supervisorRelease.supervisorBindingHash !== identity.supervisorBindingHash ||
        supervisorRelease.runLivenessHash !== identity.runLivenessHash))) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: integer(raw['revision'], 1),
    phase: recordPhase,
    identity,
    telegramDelivery,
    delegationInventory,
    actor,
    control,
    terminalReceipt,
    supervisorRelease,
    retiredAtMs,
    createdAtMs,
    updatedAtMs,
  })
}

function cloneRecord(record: Readonly<DurableExecutionEnvelopeRecordV1>): DurableExecutionEnvelopeRecordV1 {
  return deepFreeze(structuredClone(record))
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

function active(record: Readonly<DurableExecutionEnvelopeRecordV1>): 1 | null {
  return record.retiredAtMs === null ? 1 : null
}

function recoveryKind(phaseValue: DurableExecutionEnvelopePhaseV1): DurableExecutionRecoveryKindV1 {
  if (phaseValue === 'running') return 'inspect-running'
  if (phaseValue === 'paused-awaiting-approval') return 'inspect-awaiting-approval'
  if (phaseValue === 'resume-ready') return 'inspect-resume-ready'
  if (phaseValue === 'cancelling') return 'inspect-cancelling'
  if (phaseValue === 'quarantine') return 'manual-recovery'
  return 'inspect-terminal'
}

function recoveryPlan(record: Readonly<DurableExecutionEnvelopeRecordV1>): DurableExecutionRecoveryPlanV1 {
  // Informational snapshot only. A coordinator must independently attest the
  // referenced actor/control/delegation owners before choosing any action.
  const projection = {
    schemaVersion: 1 as const,
    kind: recoveryKind(record.phase),
    envelopeHash: record.identity.envelopeHash,
    revision: record.revision,
    phase: record.phase,
    binding: record.identity.binding,
    sessionId: record.identity.sessionId,
    installationHash: record.identity.installationHash,
    mode: record.identity.mode,
    runLivenessHash: record.identity.runLivenessHash,
    workBindingHash: record.identity.workBindingHash,
    chatBindingHash: record.identity.chatBindingHash,
    replyBindingHash: record.identity.replyBindingHash,
    dispatchId: record.identity.dispatchId,
    turnIdHash: record.identity.turnIdHash,
    executionBindingHash: record.identity.executionBindingHash,
    supervisorBindingHash: record.identity.supervisorBindingHash,
    continuationHash: record.identity.continuationHash,
    policyRevision: record.identity.policyRevision,
    telegramDelivery: record.telegramDelivery,
    delegationInventory: record.delegationInventory,
    actor: record.actor,
    control: record.control,
    terminalReceipt: record.terminalReceipt,
    supervisorRelease: record.supervisorRelease,
  }
  return deepFreeze({
    ...structuredClone(projection),
    planHash: sha256(PLAN_DOMAIN, JSON.stringify(projection)),
  })
}

function validTransition(
  from: DurableExecutionEnvelopePhaseV1,
  to: DurableExecutionEnvelopePhaseV1,
): boolean {
  const graph: Readonly<Record<DurableExecutionEnvelopePhaseV1, readonly DurableExecutionEnvelopePhaseV1[]>> = {
    running: ['paused-awaiting-approval', 'cancelling', 'terminal', 'quarantine'],
    'paused-awaiting-approval': ['resume-ready', 'cancelling', 'terminal', 'quarantine'],
    'resume-ready': ['running', 'cancelling', 'terminal', 'quarantine'],
    cancelling: ['terminal', 'quarantine'],
    quarantine: ['terminal'],
    terminal: [],
  }
  return graph[from].includes(to)
}

function sameRefEvolution<T extends { revision: number }>(
  before: T,
  next: T,
  identityKeys: readonly (keyof T)[],
): boolean {
  return next.revision >= before.revision && identityKeys.every(key => next[key] === before[key])
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  }
  return Number(uid)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function ensurePrivateDirectory(path: string, uid: number): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }) } catch {
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  }
  let stat: Stats
  try { stat = lstatSync(path) } catch { fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700) fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
}

function preparePrivateFile(path: string, uid: number): Stats {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    fchmodSync(descriptor, 0o600)
    const opened = fstatSync(descriptor)
    const current = lstatSync(path)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== uid || opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 || !sameIdentity(opened, current)) {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    }
    return opened
  } catch (error) {
    if (error instanceof DurableExecutionEnvelopeError) throw error
    throw new DurableExecutionEnvelopeError('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) try { closeSync(descriptor) } catch { /* stable error */ }
  }
}

function sidecarState(path: string, uid: number): 'absent' | 'private' | 'unsafe' {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 ? 'private' : 'unsafe'
  } catch (error) {
    if (nodeCode(error) === 'ENOENT') return 'absent'
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  }
}

function validateSidecars(path: string, uid: number, allowJournal: boolean): void {
  const journal = sidecarState(path + '-journal', uid)
  if (journal === 'unsafe') fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
  if (journal === 'private' && !allowJournal) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
  for (const suffix of ['-wal', '-shm']) {
    const state = sidecarState(path + suffix, uid)
    if (state === 'unsafe') fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    if (state === 'private') fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
  }
}

function validatePreopenJournal(path: string, uid: number): void {
  const journalPath = path + '-journal'
  if (sidecarState(journalPath, uid) === 'absent') return
  let descriptor: number | null = null
  try {
    descriptor = openSync(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor)
    const current = lstatSync(journalPath)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== uid || opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 || !sameIdentity(opened, current)) {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    }
    const header = Buffer.alloc(8)
    const bytes = readSync(descriptor, header, 0, header.length, 0)
    const zeroHeader = header.subarray(0, bytes).every(byte => byte === 0)
    const sqliteJournalMagic = bytes === 8 && header.equals(
      Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]),
    )
    if (!zeroHeader && !sqliteJournalMagic) {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    }
  } catch (error) {
    if (error instanceof DurableExecutionEnvelopeError) throw error
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) try { closeSync(descriptor) } catch { /* stable error */ }
  }
}

function removeRecoveredJournal(path: string, uid: number): void {
  const journalPath = path + '-journal'
  if (sidecarState(journalPath, uid) === 'absent') return
  let descriptor: number | null = null
  try {
    descriptor = openSync(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor)
    const current = lstatSync(journalPath)
    if (!opened.isFile() || opened.isSymbolicLink() || opened.uid !== uid || opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 || !sameIdentity(opened, current)) {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    }
    const header = Buffer.alloc(8)
    const bytes = readSync(descriptor, header, 0, header.length, 0)
    if (bytes > 0 && header.subarray(0, bytes).some(byte => byte !== 0)) {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    }
    closeSync(descriptor)
    descriptor = null
    const after = lstatSync(journalPath)
    if (!sameIdentity(opened, after)) fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
    unlinkSync(journalPath)
  } catch (error) {
    if (error instanceof DurableExecutionEnvelopeError) throw error
    if (nodeCode(error) === 'ENOENT') return
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) try { closeSync(descriptor) } catch { /* stable error */ }
  }
}

function assertPrivateFile(path: string, uid: number, expected: Stats): void {
  let current: Stats
  try { current = lstatSync(path) } catch { fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNAVAILABLE') }
  if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid || current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600 || !sameIdentity(current, expected)) {
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_UNSAFE')
  }
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function initializeOrValidate(db: Database.Database): void {
  const applicationId = Number(db.pragma('application_id', { simple: true }))
  const userVersion = Number(db.pragma('user_version', { simple: true }))
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ type: string; name: string; sql: string | null }>
  if (applicationId === 0 && userVersion === 0 && objects.length === 0) {
    db.pragma(`application_id = ${APPLICATION_ID}`)
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
    db.exec(ENVELOPE_SCHEMA)
    return
  }
  if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION ||
    String(db.pragma('quick_check', { simple: true })) !== 'ok' || objects.length !== 1) {
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
  }
  const table = objects[0]
  if (table?.type !== 'table' || table.name !== 'durable_execution_envelopes' ||
    table.sql === null || normalizeSql(table.sql) !== normalizeSql(ENVELOPE_SCHEMA)) {
    fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
  }
}

export function makeNodeDurableExecutionEnvelopeController(input: Readonly<{
  path: string
  nowMs?: () => number
}>): NodeDurableExecutionEnvelopeControllerV1 {
  const rawInput = exact(input, ['path'], ['nowMs'])
  if (typeof rawInput['path'] !== 'string' || !isAbsolute(rawInput['path']) ||
    !FILENAME.test(basename(rawInput['path'])) || basename(rawInput['path']) === LEASE_PROFILE.filename ||
    (rawInput['nowMs'] !== undefined && (typeof rawInput['nowMs'] !== 'function' ||
      utilTypes.isProxy(rawInput['nowMs'])))) {
    fail('DURABLE_EXECUTION_ENVELOPE_INPUT_INVALID')
  }
  const path = resolve(rawInput['path'])
  const root = dirname(path)
  const uid = currentUid()
  ensurePrivateDirectory(root, uid)
  let lease: PrivateSqliteLease
  try { lease = acquirePrivateSqliteLease({ root, profile: LEASE_PROFILE }) } catch (error) {
    throw mapStoreError(error)
  }
  let expectedFile: Stats
  try {
    validateSidecars(path, uid, true)
    validatePreopenJournal(path, uid)
    expectedFile = preparePrivateFile(path, uid)
  } catch (error) {
    lease.release()
    throw error
  }
  let database: Database.Database | null = null
  try {
    database = new Database(path, { timeout: 0 })
    database.pragma('busy_timeout = 0')
    database.pragma('journal_mode = DELETE')
    database.pragma('synchronous = FULL')
    database.pragma('trusted_schema = OFF')
    initializeOrValidate(database)
    // Only after the raw schema check and exclusive writer lease may SQLite
    // roll back a private hot journal left by a crashed manager.
    database.exec('BEGIN IMMEDIATE; COMMIT')
    initializeOrValidate(database)
    removeRecoveredJournal(path, uid)
    assertPrivateFile(path, uid, expectedFile)
    validateSidecars(path, uid, false)
  } catch (error) {
    try { database?.close() } catch { /* preserve error */ }
    lease.release()
    throw mapStoreError(error)
  }
  const db = database
  const now = rawInput['nowMs'] as (() => number) | undefined ?? (() => Date.now())
  let closed = false

  type Row = {
    envelope_hash: string
    session_id: string
    turn_id_hash: string
    phase: string
    revision: number
    active_slot: number | null
    record_json: string
    record_bytes: number
    record_hash: string
  }

  const boundedRecordProjection =
    `CAST(substr(CAST(record_json AS BLOB), 1, ${MAX_RECORD_BYTES + 1}) AS TEXT) AS record_json, `
    + 'length(CAST(record_json AS BLOB)) AS record_bytes, record_hash '
  const loadStatement = db.prepare(
    'SELECT envelope_hash, session_id, turn_id_hash, phase, revision, active_slot, '
      + boundedRecordProjection + 'FROM durable_execution_envelopes WHERE envelope_hash = ?',
  )
  const inventoryStatement = db.prepare(
    'SELECT envelope_hash, session_id, turn_id_hash, phase, revision, active_slot, '
      + boundedRecordProjection + 'FROM durable_execution_envelopes ORDER BY envelope_hash LIMIT 4097',
  )
  const insertStatement = db.prepare(
    'INSERT INTO durable_execution_envelopes (envelope_hash, session_id, turn_id_hash, phase, revision, '
      + 'active_slot, record_json, record_hash) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  )
  const updateStatement = db.prepare(
    'UPDATE durable_execution_envelopes SET phase = ?, revision = ?, active_slot = ?, '
      + 'record_json = ?, record_hash = ? WHERE envelope_hash = ? AND revision = ? '
      + 'AND phase = ? AND active_slot = 1',
  )
  const purgeRetiredStatement = db.prepare(
    'DELETE FROM durable_execution_envelopes WHERE active_slot IS NULL',
  )

  const guard = (): void => {
    if (closed || !db.open) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CLOSED')
    try { lease.assertHeld() } catch (error) { throw mapStoreError(error) }
    assertPrivateFile(path, uid, expectedFile)
    validateSidecars(path, uid, false)
    initializeOrValidate(db)
  }
  const parseRow = (row: Row | undefined): Readonly<DurableExecutionEnvelopeRecordV1> | null => {
    if (row === undefined) return null
    if (!Number.isSafeInteger(row.record_bytes) || row.record_bytes < 0 ||
      row.record_bytes > MAX_RECORD_BYTES || Buffer.byteLength(row.record_json, 'utf8') !==
      row.record_bytes) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    let parsed: unknown
    try { parsed = JSON.parse(row.record_json) as unknown } catch {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    }
    let record: Readonly<DurableExecutionEnvelopeRecordV1>
    try { record = cleanRecord(parsed) } catch {
      fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    }
    const canonical = JSON.stringify(record)
    if (canonical !== row.record_json || row.record_hash !== sha256(RECORD_DOMAIN, canonical) ||
      row.envelope_hash !== record.identity.envelopeHash ||
      row.session_id !== record.identity.sessionId || row.turn_id_hash !== record.identity.turnIdHash ||
      row.phase !== record.phase || row.revision !== record.revision ||
      row.active_slot !== active(record)) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    return record
  }
  const load = (envelopeHash: string): Readonly<DurableExecutionEnvelopeRecordV1> | null => {
    guard()
    return parseRow(loadStatement.get(hash(envelopeHash)) as Row | undefined)
  }
  const loadActive = (): Readonly<DurableExecutionEnvelopeRecordV1> | null => {
    guard()
    const records: Array<Readonly<DurableExecutionEnvelopeRecordV1> | null> = []
    let aggregateBytes = 0
    for (const rawRow of inventoryStatement.iterate()) {
      const row = rawRow as Row
      if (records.length >= MAX_ENVELOPES || !Number.isSafeInteger(row.record_bytes) ||
        row.record_bytes < 0) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
      aggregateBytes += row.record_bytes
      if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_INVENTORY_BYTES) {
        fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
      }
      records.push(parseRow(row))
    }
    const activeRecords = records.filter(record => record !== null && record.retiredAtMs === null)
    if (activeRecords.length > 1) fail('DURABLE_EXECUTION_ENVELOPE_STORE_CORRUPT')
    return activeRecords[0] ?? null
  }
  const clock = (floor = 0): number => {
    let value: number
    try { value = integer(now()) } catch {
      fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
    }
    if (value < floor) fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
    return value
  }
  const persistInsert = (record: Readonly<DurableExecutionEnvelopeRecordV1>): boolean => {
    const clean = cleanRecord(record)
    const json = JSON.stringify(clean)
    try {
      return insertStatement.run(
        clean.identity.envelopeHash,
        clean.identity.sessionId,
        clean.identity.turnIdHash,
        clean.phase,
        clean.revision,
        json,
        sha256(RECORD_DOMAIN, json),
      ).changes === 1
    } catch (error) {
      if (sqliteCode(error)?.startsWith('SQLITE_CONSTRAINT') === true) return false
      throw mapStoreError(error)
    }
  }
  const persistCas = (
    before: Readonly<DurableExecutionEnvelopeRecordV1>,
    next: Readonly<DurableExecutionEnvelopeRecordV1>,
  ): boolean => {
    if (next.revision !== before.revision + 1 ||
      JSON.stringify(next.identity) !== JSON.stringify(before.identity)) {
      fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
    }
    const clean = cleanRecord(next)
    const json = JSON.stringify(clean)
    try {
      return updateStatement.run(
        clean.phase,
        clean.revision,
        active(clean),
        json,
        sha256(RECORD_DOMAIN, json),
        clean.identity.envelopeHash,
        before.revision,
        before.phase,
      ).changes === 1
    } catch (error) { throw mapStoreError(error) }
  }

  const inspector: DurableExecutionEnvelopeInspectorV1 = Object.freeze({
    inspect(envelopeHash: string) {
      const record = load(envelopeHash)
      return record === null ? null : cloneRecord(record)
    },
    recoveryPlan() {
      const record = loadActive()
      return record === null ? null : recoveryPlan(record)
    },
  })

  const manager: DurableExecutionEnvelopeManagerV1 = Object.freeze({
    start(startInput: DurableExecutionEnvelopeStartV1) {
      const raw = exact(startInput, [
        'identity', 'telegramDelivery', 'delegationInventory', 'actor', 'control',
      ])
      const identityRaw = exact(raw['identity'], [
        'binding', 'sessionId', 'installationHash', 'mode', 'runLivenessHash',
        'workBindingHash', 'chatBindingHash', 'replyBindingHash', 'dispatchId', 'turnIdHash',
        'executionBindingHash', 'supervisorBindingHash', 'continuationHash', 'policyRevision',
        'envelopeHash',
      ])
      const identity = cleanIdentity({ schemaVersion: 1, ...identityRaw })
      const candidate = cleanRecord({
        schemaVersion: 1,
        revision: 1,
        phase: 'running',
        identity,
        telegramDelivery: raw['telegramDelivery'],
        delegationInventory: raw['delegationInventory'],
        actor: raw['actor'],
        control: raw['control'],
        terminalReceipt: null,
        supervisorRelease: null,
        retiredAtMs: null,
        createdAtMs: 0,
        updatedAtMs: 0,
      })
      if (candidate.telegramDelivery.delivery !== 'pending') {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const existing = loadActive()
      if (existing !== null) {
        return Object.freeze({ kind: 'busy', plan: recoveryPlan(existing) })
      }
      // Retired terminal evidence has already been acknowledged by the
      // coordinator. Keep the database bounded before admitting a new turn.
      purgeRetiredStatement.run()
      const startedAtMs = clock()
      const record = cleanRecord({
        ...candidate,
        createdAtMs: startedAtMs,
        updatedAtMs: startedAtMs,
      })
      if (!persistInsert(record)) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      return Object.freeze({ kind: 'started', record: cloneRecord(record) })
    },
    transition(transitionInput: DurableExecutionEnvelopeTransitionV1) {
      const raw = exact(transitionInput, [
        'envelopeHash', 'expectedRevision', 'expectedPhase', 'nextPhase', 'telegramDelivery',
        'delegationInventory', 'actor', 'control', 'terminalReceipt',
      ])
      const envelopeHash = hash(raw['envelopeHash'])
      const before = loadActive()
      const expectedRevision = integer(raw['expectedRevision'], 1)
      const expectedPhase = phase(raw['expectedPhase'])
      const nextPhase = phase(raw['nextPhase'])
      if (before === null || before.identity.envelopeHash !== envelopeHash ||
        before.revision !== expectedRevision || before.phase !== expectedPhase ||
        !validTransition(before.phase, nextPhase)) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const telegramDelivery = cleanTelegram(raw['telegramDelivery'])
      const delegationInventory = cleanInventory(raw['delegationInventory'])
      const actor = cleanActor(raw['actor'])
      const control = cleanControl(raw['control'])
      const terminalReceiptInput = cleanTerminalInput(raw['terminalReceipt'])
      const inventoryMonotonic = before.delegationInventory.every(previous => {
        const next = delegationInventory.find(item => item.runRootHash === previous.runRootHash)
        return next !== undefined && next.authorityHash === previous.authorityHash &&
          next.policyRevision === previous.policyRevision && next.revision >= previous.revision &&
          (next.revision === previous.revision
            ? next.inventoryHash === previous.inventoryHash
            : true)
      })
      const telegramUnchanged = JSON.stringify(telegramDelivery) ===
        JSON.stringify(before.telegramDelivery)
      const actorMonotonic = before.actor === null
        ? actor !== null || (nextPhase !== 'paused-awaiting-approval' && nextPhase !== 'resume-ready')
        : actor !== null && sameRefEvolution(before.actor, actor, [
          'actorId', 'envelopeHash', 'workBindingHash', 'executionBindingHash', 'policyRevision',
        ]) && (actor.revision !== before.actor.revision || actor.actorHash === before.actor.actorHash)
      const controlMonotonic = sameRefEvolution(before.control, control, [
        'envelopeHash', 'supervisorBindingHash', 'policyRevision',
      ]) && (control.revision !== before.control.revision ||
        control.controlHash === before.control.controlHash)
      const approvalAdvanced = before.phase !== 'paused-awaiting-approval' ||
        nextPhase !== 'resume-ready' || (actor !== null && before.actor !== null &&
          actor.revision > before.actor.revision)
      const terminalProvenance = terminalReceiptInput === null ||
        (terminalReceiptInput.envelopeHash === before.identity.envelopeHash &&
          terminalReceiptInput.workBindingHash === before.identity.workBindingHash &&
          terminalReceiptInput.executionBindingHash === before.identity.executionBindingHash &&
          terminalReceiptInput.dispatchId === before.identity.dispatchId &&
          terminalReceiptInput.policyRevision === before.identity.policyRevision)
      if (!inventoryMonotonic || !telegramUnchanged || !actorMonotonic || !controlMonotonic ||
        !approvalAdvanced || !terminalProvenance ||
        (nextPhase === 'terminal') !== (terminalReceiptInput !== null)) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const updatedAtMs = clock(before.updatedAtMs)
      if (terminalReceiptInput !== null &&
        (terminalReceiptInput.atMs < before.updatedAtMs || terminalReceiptInput.atMs > updatedAtMs)) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const next = cleanRecord({
        ...before,
        revision: before.revision + 1,
        phase: nextPhase,
        telegramDelivery,
        delegationInventory,
        actor,
        control,
        terminalReceipt: terminalReceiptInput,
        supervisorRelease: null,
        retiredAtMs: null,
        updatedAtMs,
      })
      if (!persistCas(before, next)) fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    retireTerminal(
      retireInput: Parameters<DurableExecutionEnvelopeManagerV1['retireTerminal']>[0],
    ) {
      const raw = exact(retireInput, [
        'envelopeHash', 'expectedRevision', 'receiptHash', 'releaseReceiptHash',
      ])
      const envelopeHash = hash(raw['envelopeHash'])
      const before = loadActive()
      if (before === null || before.identity.envelopeHash !== envelopeHash ||
        before.phase !== 'terminal' || before.retiredAtMs !== null ||
        before.revision !== integer(raw['expectedRevision'], 1) ||
        before.terminalReceipt?.receiptHash !== hash(raw['receiptHash']) ||
        before.telegramDelivery.delivery !== 'delivered' ||
        before.supervisorRelease?.releaseReceiptHash !== hash(raw['releaseReceiptHash'])) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const retiredAtMs = clock(before.updatedAtMs)
      const next = cleanRecord({
        ...before,
        revision: before.revision + 1,
        retiredAtMs,
        updatedAtMs: retiredAtMs,
      })
      if (!persistCas(before, next)) fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    recordTelegramDelivery(
      deliveryInput: Parameters<DurableExecutionEnvelopeManagerV1['recordTelegramDelivery']>[0],
    ) {
      const raw = exact(deliveryInput, ['envelopeHash', 'expectedRevision', 'delivery'])
      const before = loadActive()
      const delivery = cleanTelegram(raw['delivery'])
      if (before === null || before.identity.envelopeHash !== hash(raw['envelopeHash']) ||
        before.revision !== integer(raw['expectedRevision'], 1) ||
        delivery.executionBindingHash !== before.identity.executionBindingHash ||
        delivery.replyBindingHash !== before.identity.replyBindingHash ||
        delivery.dispatchId !== before.identity.dispatchId ||
        before.telegramDelivery.delivery === 'delivered' ||
        delivery.revision !== before.telegramDelivery.revision + 1 ||
        (delivery.delivery === 'delivered' && before.phase !== 'terminal')) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const updatedAtMs = clock(before.updatedAtMs)
      const next = cleanRecord({
        ...before,
        revision: before.revision + 1,
        telegramDelivery: delivery,
        updatedAtMs,
      })
      if (!persistCas(before, next)) fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    recordSupervisorRelease(
      releaseInput: Parameters<DurableExecutionEnvelopeManagerV1['recordSupervisorRelease']>[0],
    ) {
      const raw = exact(releaseInput, ['envelopeHash', 'expectedRevision', 'release'])
      const before = loadActive()
      const release = cleanRelease(raw['release'])
      if (before === null || release === null ||
        before.identity.envelopeHash !== hash(raw['envelopeHash']) ||
        before.revision !== integer(raw['expectedRevision'], 1) || before.phase !== 'terminal' ||
        before.telegramDelivery.delivery !== 'delivered' || before.supervisorRelease !== null ||
        release.supervisorBindingHash !== before.identity.supervisorBindingHash ||
        release.runLivenessHash !== before.identity.runLivenessHash) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const updatedAtMs = clock(before.updatedAtMs)
      if (release.releasedAtMs < Math.max(before.updatedAtMs, before.terminalReceipt!.atMs) ||
        release.releasedAtMs > updatedAtMs) {
        fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      }
      const next = cleanRecord({
        ...before,
        revision: before.revision + 1,
        supervisorRelease: release,
        updatedAtMs,
      })
      if (!persistCas(before, next)) fail('DURABLE_EXECUTION_ENVELOPE_TRANSITION_DENIED')
      return cloneRecord(next)
    },
  })

  return Object.freeze({
    manager,
    inspector,
    close() {
      if (closed) return
      closed = true
      try { db.close() } finally { lease.release() }
    },
  })
}

// Manager-owned inventory and budget authority for durable delegation. The
// supervised production importer is its only LIVE composition.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { types as utilTypes } from 'node:util'

import Database from 'better-sqlite3'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

const HASH = /^[a-f0-9]{64}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const POLICY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DAILY_EPOCH = /^\d{4}-\d{2}-\d{2}$/
const MAX_SEQUENCE = 4_096
const MAX_ORDINAL = 1_000_000
const MAX_WALL_MS = 24 * 60 * 60 * 1_000
const MAX_JSON_NODES = 8_192
const MAX_JSON_DEPTH = 32
const MAX_JSON_TEXT_BYTES = 128 * 1_024
const APPLICATION_ID = 0x4144_4f43
const USER_VERSION = 1
const LEDGER_FILENAME = 'durable-delegation-operation-control.sqlite3'
const GENESIS = '0'.repeat(64)

const META_SCHEMA = "CREATE TABLE control_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64), installation_hash TEXT NOT NULL CHECK (length(installation_hash) = 64), policy_revision TEXT NOT NULL, integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64))"
const SCOPE_SCHEMA = "CREATE TABLE budget_scopes (scope_kind TEXT NOT NULL CHECK (scope_kind IN ('task', 'run', 'global', 'daily')), scope_hash TEXT NOT NULL CHECK (length(scope_hash) = 64), maximum_iterations INTEGER CHECK (maximum_iterations IS NULL OR maximum_iterations >= 0), maximum_spend_usd_nanos INTEGER CHECK (maximum_spend_usd_nanos IS NULL OR maximum_spend_usd_nanos >= 0), daily_epoch TEXT, policy_revision TEXT NOT NULL, integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64), CHECK ((scope_kind = 'daily' AND daily_epoch IS NOT NULL) OR (scope_kind <> 'daily' AND daily_epoch IS NULL)), PRIMARY KEY (scope_kind, scope_hash))"
const TASK_SCHEMA = "CREATE TABLE task_inventories (run_root_hash TEXT NOT NULL CHECK (length(run_root_hash) = 64), task_id TEXT NOT NULL, binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64), delegation_id TEXT NOT NULL, authority_hash TEXT NOT NULL CHECK (length(authority_hash) = 64), policy_revision TEXT NOT NULL, task_scope_hash TEXT NOT NULL CHECK (length(task_scope_hash) = 64), run_scope_hash TEXT NOT NULL CHECK (length(run_scope_hash) = 64), global_scope_hash TEXT NOT NULL CHECK (length(global_scope_hash) = 64), daily_scope_hash TEXT NOT NULL CHECK (length(daily_scope_hash) = 64), inventory_state TEXT NOT NULL CHECK (inventory_state IN ('open', 'sealed')), sequence_length INTEGER NOT NULL CHECK (sequence_length >= 0), tail_hash TEXT NOT NULL CHECK (length(tail_hash) = 64), candidate_hash TEXT CHECK (candidate_hash IS NULL OR length(candidate_hash) = 64), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64), CHECK ((inventory_state = 'open' AND candidate_hash IS NULL) OR (inventory_state = 'sealed' AND candidate_hash IS NOT NULL)), PRIMARY KEY (run_root_hash, task_id), UNIQUE (run_root_hash, delegation_id))"
const SLOT_SCHEMA = "CREATE TABLE operation_slots (run_root_hash TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0), logical_slot_hash TEXT NOT NULL CHECK (length(logical_slot_hash) = 64), phase TEXT NOT NULL CHECK (phase IN ('provider', 'tool')), ordinal INTEGER NOT NULL CHECK (ordinal > 0), canonical_request_hash TEXT NOT NULL CHECK (length(canonical_request_hash) = 64), authority_hash TEXT NOT NULL CHECK (length(authority_hash) = 64), policy_revision TEXT NOT NULL, retry_class TEXT NOT NULL CHECK (retry_class IN ('retry-once', 'new-task-only')), resolution_decision TEXT CHECK (resolution_decision IS NULL OR resolution_decision IN ('retry-once', 'cancel')), resolution_hash TEXT CHECK (resolution_hash IS NULL OR length(resolution_hash) = 64), resolution_consumed INTEGER NOT NULL CHECK (resolution_consumed IN (0, 1)), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64), CHECK ((resolution_decision IS NULL AND resolution_hash IS NULL AND resolution_consumed = 0) OR (resolution_decision IS NOT NULL AND resolution_hash IS NOT NULL)), PRIMARY KEY (run_root_hash, task_id, sequence), UNIQUE (logical_slot_hash), UNIQUE (run_root_hash, task_id, phase, ordinal), FOREIGN KEY (run_root_hash, task_id) REFERENCES task_inventories(run_root_hash, task_id) ON DELETE CASCADE)"
const ATTEMPT_SCHEMA = "CREATE TABLE operation_attempts (run_root_hash TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL, attempt INTEGER NOT NULL CHECK (attempt IN (1, 2)), attempt_key_hash TEXT NOT NULL UNIQUE CHECK (length(attempt_key_hash) = 64), resolution_hash TEXT NOT NULL CHECK (length(resolution_hash) = 64), maximum_iterations INTEGER NOT NULL CHECK (maximum_iterations >= 0), maximum_spend_usd_nanos INTEGER NOT NULL CHECK (maximum_spend_usd_nanos >= 0), budget_state TEXT NOT NULL CHECK (budget_state IN ('held', 'charged', 'conservative', 'overrun')), prepared_hash TEXT CHECK (prepared_hash IS NULL OR length(prepared_hash) = 64), ambiguous INTEGER NOT NULL CHECK (ambiguous IN (0, 1)), receipt_hash TEXT CHECK (receipt_hash IS NULL OR length(receipt_hash) = 64), result_hash TEXT CHECK (result_hash IS NULL OR length(result_hash) = 64), actual_iterations INTEGER CHECK (actual_iterations IS NULL OR actual_iterations >= 0), actual_spend_usd_nanos INTEGER CHECK (actual_spend_usd_nanos IS NULL OR actual_spend_usd_nanos >= 0), wall_ms INTEGER CHECK (wall_ms IS NULL OR wall_ms >= 0), effect TEXT CHECK (effect IS NULL OR effect IN ('none', 'read', 'mutation')), evidence_hash TEXT CHECK (evidence_hash IS NULL OR length(evidence_hash) = 64), action_status TEXT CHECK (action_status IS NULL OR action_status IN ('verified', 'unverified')), outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'stopped')), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64), CHECK ((budget_state IN ('held', 'conservative') AND receipt_hash IS NULL AND result_hash IS NULL AND actual_iterations IS NULL AND actual_spend_usd_nanos IS NULL AND wall_ms IS NULL AND effect IS NULL AND evidence_hash IS NULL AND action_status IS NULL AND outcome IS NULL) OR (budget_state IN ('charged', 'overrun') AND receipt_hash IS NOT NULL AND result_hash IS NOT NULL AND actual_iterations IS NOT NULL AND actual_spend_usd_nanos IS NOT NULL AND wall_ms IS NOT NULL AND effect IS NOT NULL AND outcome IS NOT NULL)), PRIMARY KEY (run_root_hash, task_id, sequence, attempt), FOREIGN KEY (run_root_hash, task_id, sequence) REFERENCES operation_slots(run_root_hash, task_id, sequence) ON DELETE CASCADE)"
const WRITER_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'durable-delegation-operation-control-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const WRITER_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'durable-delegation-operation-control-writer',
  filename: 'writer.sqlite3',
  applicationId: 0x4144_4f57,
  userVersion: 1,
  exactSchemaSql: WRITER_SCHEMA,
}

export type DurableDelegationBudgetScopeKindV1 = 'task' | 'run' | 'global' | 'daily'

export interface DurableDelegationBudgetCeilingV1 {
  readonly scopeHash: string
  readonly maximumIterations: number | null
  readonly maximumSpendUsdNanos: number | null
  readonly dailyEpoch?: string
}

export interface DurableDelegationOperationControlBindingV1 {
  readonly schemaVersion: 1
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly ceilings: Readonly<{
    task: DurableDelegationBudgetCeilingV1
    run: DurableDelegationBudgetCeilingV1
    global: DurableDelegationBudgetCeilingV1
    daily: DurableDelegationBudgetCeilingV1
  }>
}

export interface DurableDelegationOperationControlScopeHashesV1 {
  readonly task: string
  readonly run: string
  readonly global: string
  readonly daily: string
}

export interface DurableDelegationLogicalOperationV2 {
  readonly schemaVersion: 2
  readonly sequence: number
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly retryClass: 'retry-once' | 'new-task-only'
  readonly maximumCharge: Readonly<{
    iterations: number
    spendUsdNanos: number
  }>
}

export type DurableDelegationOperationBudgetStateV1 =
  | 'held'
  | 'charged'
  | 'conservative'
  | 'overrun'

export interface DurableDelegationOperationAttemptViewV1 {
  readonly attempt: 1 | 2
  readonly attemptKeyHash: string
  readonly resolutionHash: string
  readonly maximumCharge: Readonly<{ iterations: number; spendUsdNanos: number }>
  readonly budgetState: DurableDelegationOperationBudgetStateV1
  readonly preparedHash?: string
  readonly ambiguous: boolean
  readonly receipt?: Readonly<DurableDelegationOperationReceiptEvidenceV1>
}

export interface DurableDelegationOperationSlotViewV1 {
  readonly sequence: number
  readonly logicalSlotHash: string
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly retryClass: 'retry-once' | 'new-task-only'
  readonly resolution?: Readonly<{
    decision: 'retry-once' | 'cancel'
    resolutionHash: string
    consumed: boolean
  }>
  readonly attempts: readonly DurableDelegationOperationAttemptViewV1[]
}

export interface DurableDelegationOperationInventorySnapshotV1 {
  readonly schemaVersion: 1
  readonly state: 'open' | 'sealed'
  readonly sequenceLength: number
  readonly tailHash: string
  readonly candidateHash?: string
  readonly slots: readonly DurableDelegationOperationSlotViewV1[]
}

export interface DurableDelegationOperationReceiptEvidenceV1 {
  readonly receiptHash: string
  readonly resultHash: string
  readonly iterations: number
  readonly spendUsdNanos: number
  readonly wallMs: number
  readonly effect: 'none' | 'read' | 'mutation'
  readonly evidenceHash?: string
  readonly actionStatus?: 'verified' | 'unverified'
  readonly outcome: 'completed' | 'stopped'
}

export interface DurableDelegationOperationEvidenceV2 {
  readonly sequence: number
  readonly logicalSlotHash: string
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly resolution?: Readonly<{
    decision: 'retry-once' | 'cancel'
    resolutionHash: string
  }>
  readonly attempts: readonly DurableDelegationOperationAttemptViewV1[]
}

const resolutionAuthorityBrand: unique symbol = Symbol(
  'aisy.durable-delegation-operation-resolution-authority-v1',
)

export interface DurableDelegationOperationResolutionAuthorityV1 {
  readonly [resolutionAuthorityBrand]: true
  readonly kind: 'durable-delegation-operation-resolution-authority-v1'
}

interface ResolutionAuthorityState {
  readonly runRootHash: string
  readonly taskId: string
  readonly logicalSlotHash: string
  readonly ambiguousAttempt: 1 | 2
  readonly decision: 'retry-once' | 'cancel'
  readonly resolutionHash: string
}

const resolutionAuthorities = new WeakMap<object, ResolutionAuthorityState>()
const consumedResolutionAuthorities = new WeakSet<object>()

export type DurableDelegationOperationControlErrorCode =
  | 'DELEGATION_OPERATION_CONTROL_INPUT_INVALID'
  | 'DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE'
  | 'DELEGATION_OPERATION_CONTROL_WRITER_BUSY'
  | 'DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE'
  | 'DELEGATION_OPERATION_CONTROL_STATE_CORRUPT'
  | 'DELEGATION_OPERATION_CONTROL_BINDING_DRIFT'
  | 'DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT'
  | 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED'
  | 'DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED'
  | 'DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED'
  | 'DELEGATION_OPERATION_CONTROL_SEAL_DENIED'

export class DurableDelegationOperationControlError extends Error {
  constructor(readonly code: DurableDelegationOperationControlErrorCode) {
    super(code)
    this.name = 'DurableDelegationOperationControlError'
  }
}

export interface DurableDelegationBoundOperationControlV1 {
  binding(): Readonly<DurableDelegationOperationControlBindingV1>
  snapshot(): DurableDelegationOperationInventorySnapshotV1
  expect(operation: DurableDelegationLogicalOperationV2): Readonly<{
    disposition: 'created' | 'replayed'
    slot: DurableDelegationOperationSlotViewV1
    attempt: DurableDelegationOperationAttemptViewV1
  }>
  markPrepared(input: Readonly<{
    logicalSlotHash: string
    attempt: 1 | 2
    preparedHash: string
  }>): DurableDelegationOperationAttemptViewV1
  markAmbiguous(input: Readonly<{
    logicalSlotHash: string
    attempt: 1 | 2
  }>): DurableDelegationOperationAttemptViewV1
  reconcileSettled(input: Readonly<{
    logicalSlotHash: string
    attempt: 1 | 2
    preparedHash: string
    receipt: DurableDelegationOperationReceiptEvidenceV1
  }>): DurableDelegationOperationAttemptViewV1
  resolve(
    authority: DurableDelegationOperationResolutionAuthorityV1,
  ): Readonly<{
    decision: 'retry-once' | 'cancel'
    slot: DurableDelegationOperationSlotViewV1
    attempt: DurableDelegationOperationAttemptViewV1
  }>
  seal(input: Readonly<{
    expectedLength: number
    candidateHash: string
  }>): DurableDelegationOperationInventorySnapshotV1
  readCost(): Readonly<{ iterations: number; spendUsdNanos: number; wallMs: number }>
  evidence(): readonly DurableDelegationOperationEvidenceV2[]
}

const boundControlAttestationBrand: unique symbol = Symbol(
  'aisy.durable-delegation-operation-control.bound-attestation-v1',
)

export interface DurableDelegationBoundOperationControlAttestationV1 {
  readonly [boundControlAttestationBrand]: true
  readonly kind: 'durable-delegation-operation-control-bound-attestation-v1'
}

export interface DurableDelegationOperationControlV1 {
  bindTask(
    binding: DurableDelegationOperationControlBindingV1,
  ): DurableDelegationBoundOperationControlV1
  attestBoundTask(
    bound: DurableDelegationBoundOperationControlV1,
  ): DurableDelegationBoundOperationControlAttestationV1
  close(): void
}

interface BoundControlProvenance {
  readonly controller: object
  readonly binding: Readonly<DurableDelegationOperationControlBindingV1>
  readonly assertReady: () => void
}

interface BoundControlAttestationState extends BoundControlProvenance {
  readonly bound: object
}

const boundControlProvenance = new WeakMap<object, BoundControlProvenance>()
const boundControlAttestations = new WeakMap<object, BoundControlAttestationState>()

/**
 * Returns the exact code-captured binding only for a module-issued attestation
 * tied to this precise bound control and its originating controller.
 */
export function assertDurableDelegationBoundOperationControlAttestationV1(
  bound: DurableDelegationBoundOperationControlV1,
  attestation: DurableDelegationBoundOperationControlAttestationV1,
): Readonly<DurableDelegationOperationControlBindingV1> {
  if (typeof bound !== 'object' || bound === null || utilTypes.isProxy(bound) ||
    typeof attestation !== 'object' || attestation === null || utilTypes.isProxy(attestation)) {
    fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
  }
  const provenance = boundControlProvenance.get(bound)
  const state = boundControlAttestations.get(attestation)
  if (provenance === undefined || state === undefined || state.bound !== bound ||
    state.controller !== provenance.controller || state.binding !== provenance.binding ||
    !Object.isFrozen(bound) || !Object.isFrozen(attestation) ||
    attestation.kind !== 'durable-delegation-operation-control-bound-attestation-v1') {
    fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
  }
  provenance.assertReady()
  return provenance.binding
}

interface LedgerHandle {
  readonly db: Database.Database
  readonly path: string
  readonly stat: Stats
  readonly uid: number
}

type DbRow = Record<string, unknown>

function fail(code: DurableDelegationOperationControlErrorCode): never {
  throw new DurableDelegationOperationControlError(code)
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' ? error.code : null
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  }
  return Number(uid)
}

function noFollow(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  }
  return constants.O_NOFOLLOW
}

function privateDirectory(path: string): void {
  try {
    if (!isAbsolute(path) || normalize(path) !== path || path === '/' || path.includes('\0') ||
      realpathSync.native(path) !== path) fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() ||
      (stat.mode & 0o777) !== 0o700) fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  } catch (error) {
    if (error instanceof DurableDelegationOperationControlError) throw error
    fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  }
}

function privateRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | noFollow())
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
    result[key] = descriptor.value
  }
  return result
}

function canonicalJson(value: unknown): string {
  let nodes = 0
  let textBytes = 0
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || !Number.isSafeInteger(candidate)) {
        fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      }
      return Object.is(candidate, -0) ? 0 : candidate
    }
    if (typeof candidate === 'string') {
      if (candidate.includes('\0')) fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      textBytes += Buffer.byteLength(candidate, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      return candidate
    }
    if (Array.isArray(candidate)) {
      if (utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype ||
        Object.getOwnPropertySymbols(candidate).length !== 0) {
        fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const length = Reflect.getOwnPropertyDescriptor(candidate, 'length')?.value as unknown
      if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > MAX_JSON_NODES ||
        Object.keys(descriptors).filter(key => key !== 'length').length !== length) {
        fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      }
      const result: unknown[] = []
      for (let index = 0; index < Number(length); index++) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
          descriptor.get !== undefined || descriptor.set !== undefined) {
          fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
        }
        result.push(visit(descriptor.value, depth + 1))
      }
      return result
    }
    if (typeof candidate !== 'object' || candidate === null || utilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      Object.getOwnPropertySymbols(candidate).length !== 0) {
      fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!
      if (key.includes('\0') || !Object.hasOwn(descriptor, 'value') ||
        descriptor.get !== undefined || descriptor.set !== undefined) {
        fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      }
      textBytes += Buffer.byteLength(key, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
      result[key] = visit(descriptor.value, depth + 1)
    }
    return result
  }
  return JSON.stringify(visit(value, 0))
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domain + '\0').update(canonicalJson(value)).digest('hex')
}

function frozen<T>(value: T): Readonly<T> {
  const copy = JSON.parse(canonicalJson(value)) as T
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || Object.isFrozen(candidate)) return
    Object.freeze(candidate)
    for (const nested of Object.values(candidate)) freeze(nested)
  }
  freeze(copy)
  return copy
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
}

export function deriveDurableDelegationOperationControlScopeHashesV1(input: Readonly<{
  installationHash: string
  runRootHash: string
  bindingHash: string
  taskId: string
  dailyEpoch: string
}>): Readonly<DurableDelegationOperationControlScopeHashesV1> {
  const raw = exactObject(input, [
    'installationHash', 'runRootHash', 'bindingHash', 'taskId', 'dailyEpoch',
  ])
  if (typeof raw['installationHash'] !== 'string' || !HASH.test(raw['installationHash']) ||
    typeof raw['runRootHash'] !== 'string' || !HASH.test(raw['runRootHash']) ||
    typeof raw['bindingHash'] !== 'string' || !HASH.test(raw['bindingHash']) ||
    typeof raw['taskId'] !== 'string' || !SAFE_ID.test(raw['taskId']) ||
    typeof raw['dailyEpoch'] !== 'string' || !DAILY_EPOCH.test(raw['dailyEpoch'])) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    task: digest('aisy.durable-delegation.operation-control.scope.task.v1', {
      installationHash: raw['installationHash'],
      runRootHash: raw['runRootHash'],
      bindingHash: raw['bindingHash'],
      taskId: raw['taskId'],
    }),
    run: digest('aisy.durable-delegation.operation-control.scope.run.v1', {
      installationHash: raw['installationHash'],
      runRootHash: raw['runRootHash'],
    }),
    global: digest('aisy.durable-delegation.operation-control.scope.global.v1', {
      installationHash: raw['installationHash'],
    }),
    daily: digest('aisy.durable-delegation.operation-control.scope.daily.v1', {
      installationHash: raw['installationHash'],
      dailyEpoch: raw['dailyEpoch'],
    }),
  })
}

function captureCeiling(
  value: unknown,
  kind: DurableDelegationBudgetScopeKindV1,
): Readonly<DurableDelegationBudgetCeilingV1> {
  const raw = exactObject(value, ['scopeHash', 'maximumIterations', 'maximumSpendUsdNanos'],
    ['dailyEpoch'])
  const iterations = raw['maximumIterations']
  const spend = raw['maximumSpendUsdNanos']
  const epoch = raw['dailyEpoch']
  if (typeof raw['scopeHash'] !== 'string' || !HASH.test(raw['scopeHash']) ||
    (iterations !== null && !safeInteger(iterations)) ||
    (spend !== null && !safeInteger(spend)) ||
    (kind === 'daily'
      ? typeof epoch !== 'string' || !DAILY_EPOCH.test(epoch)
      : epoch !== undefined)) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    scopeHash: raw['scopeHash'],
    maximumIterations: iterations as number | null,
    maximumSpendUsdNanos: spend as number | null,
    ...(kind === 'daily' ? { dailyEpoch: epoch as string } : {}),
  })
}

interface CapturedBinding {
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly ceilings: Readonly<Record<DurableDelegationBudgetScopeKindV1,
    Readonly<DurableDelegationBudgetCeilingV1>>>
}

function captureBinding(value: unknown): CapturedBinding {
  const raw = exactObject(value, [
    'schemaVersion', 'runRootHash', 'bindingHash', 'delegationId', 'taskId',
    'authorityHash', 'policyRevision', 'ceilings',
  ])
  const ceilings = exactObject(raw['ceilings'], ['task', 'run', 'global', 'daily'])
  if (raw['schemaVersion'] !== 1 || typeof raw['runRootHash'] !== 'string' ||
    !HASH.test(raw['runRootHash']) || typeof raw['bindingHash'] !== 'string' ||
    !HASH.test(raw['bindingHash']) || typeof raw['authorityHash'] !== 'string' ||
    !HASH.test(raw['authorityHash']) || typeof raw['delegationId'] !== 'string' ||
    !SAFE_ID.test(raw['delegationId']) || typeof raw['taskId'] !== 'string' ||
    !SAFE_ID.test(raw['taskId']) || typeof raw['policyRevision'] !== 'string' ||
    !POLICY_REVISION.test(raw['policyRevision'])) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    runRootHash: raw['runRootHash'],
    bindingHash: raw['bindingHash'],
    delegationId: raw['delegationId'],
    taskId: raw['taskId'],
    authorityHash: raw['authorityHash'],
    policyRevision: raw['policyRevision'],
    ceilings: Object.freeze({
      task: captureCeiling(ceilings['task'], 'task'),
      run: captureCeiling(ceilings['run'], 'run'),
      global: captureCeiling(ceilings['global'], 'global'),
      daily: captureCeiling(ceilings['daily'], 'daily'),
    }),
  })
}

function bindingView(
  binding: CapturedBinding,
): Readonly<DurableDelegationOperationControlBindingV1> {
  return frozen({
    schemaVersion: 1 as const,
    runRootHash: binding.runRootHash,
    bindingHash: binding.bindingHash,
    delegationId: binding.delegationId,
    taskId: binding.taskId,
    authorityHash: binding.authorityHash,
    policyRevision: binding.policyRevision,
    ceilings: binding.ceilings,
  })
}

interface CapturedLogicalOperation {
  readonly sequence: number
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly retryClass: 'retry-once' | 'new-task-only'
  readonly maximumIterations: number
  readonly maximumSpendUsdNanos: number
}

function captureLogicalOperation(value: unknown): CapturedLogicalOperation {
  const raw = exactObject(value, [
    'schemaVersion', 'sequence', 'phase', 'ordinal', 'canonicalRequestHash',
    'authorityHash', 'policyRevision', 'retryClass', 'maximumCharge',
  ])
  const maximum = exactObject(raw['maximumCharge'], ['iterations', 'spendUsdNanos'])
  if (raw['schemaVersion'] !== 2 || !safeInteger(raw['sequence'], MAX_SEQUENCE) ||
    Number(raw['sequence']) < 1 || (raw['phase'] !== 'provider' && raw['phase'] !== 'tool') ||
    !safeInteger(raw['ordinal'], MAX_ORDINAL) || Number(raw['ordinal']) < 1 ||
    typeof raw['canonicalRequestHash'] !== 'string' || !HASH.test(raw['canonicalRequestHash']) ||
    typeof raw['authorityHash'] !== 'string' || !HASH.test(raw['authorityHash']) ||
    typeof raw['policyRevision'] !== 'string' || !POLICY_REVISION.test(raw['policyRevision']) ||
    (raw['retryClass'] !== 'retry-once' && raw['retryClass'] !== 'new-task-only') ||
    !safeInteger(maximum['iterations']) || !safeInteger(maximum['spendUsdNanos'])) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    sequence: Number(raw['sequence']),
    phase: raw['phase'],
    ordinal: Number(raw['ordinal']),
    canonicalRequestHash: raw['canonicalRequestHash'],
    authorityHash: raw['authorityHash'],
    policyRevision: raw['policyRevision'],
    retryClass: raw['retryClass'],
    maximumIterations: Number(maximum['iterations']),
    maximumSpendUsdNanos: Number(maximum['spendUsdNanos']),
  })
}

function captureReceipt(value: unknown): Readonly<DurableDelegationOperationReceiptEvidenceV1> {
  const raw = exactObject(value, [
    'receiptHash', 'resultHash', 'iterations', 'spendUsdNanos', 'wallMs', 'effect', 'outcome',
  ], ['evidenceHash', 'actionStatus'])
  if (typeof raw['receiptHash'] !== 'string' || !HASH.test(raw['receiptHash']) ||
    typeof raw['resultHash'] !== 'string' || !HASH.test(raw['resultHash']) ||
    !safeInteger(raw['iterations']) || !safeInteger(raw['spendUsdNanos']) ||
    !safeInteger(raw['wallMs'], MAX_WALL_MS) ||
    (raw['effect'] !== 'none' && raw['effect'] !== 'read' && raw['effect'] !== 'mutation') ||
    (raw['outcome'] !== 'completed' && raw['outcome'] !== 'stopped') ||
    (raw['evidenceHash'] !== undefined &&
      (typeof raw['evidenceHash'] !== 'string' || !HASH.test(raw['evidenceHash']))) ||
    (raw['actionStatus'] !== undefined && raw['actionStatus'] !== 'verified' &&
      raw['actionStatus'] !== 'unverified')) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  return Object.freeze({
    receiptHash: raw['receiptHash'],
    resultHash: raw['resultHash'],
    iterations: Number(raw['iterations']),
    spendUsdNanos: Number(raw['spendUsdNanos']),
    wallMs: Number(raw['wallMs']),
    effect: raw['effect'],
    ...(raw['evidenceHash'] === undefined ? {} : { evidenceHash: raw['evidenceHash'] as string }),
    ...(raw['actionStatus'] === undefined ? {} : {
      actionStatus: raw['actionStatus'] as 'verified' | 'unverified',
    }),
    outcome: raw['outcome'],
  })
}

/** Code-owned constructor. Structural copies are rejected by `resolve`. */
export function makeDurableDelegationOperationResolutionAuthorityV1(input: Readonly<{
  runRootHash: string
  taskId: string
  logicalSlotHash: string
  ambiguousAttempt: 1 | 2
  decision: 'retry-once' | 'cancel'
  resolutionHash: string
}>): DurableDelegationOperationResolutionAuthorityV1 {
  const raw = exactObject(input, [
    'runRootHash', 'taskId', 'logicalSlotHash', 'ambiguousAttempt', 'decision', 'resolutionHash',
  ])
  if (typeof raw['runRootHash'] !== 'string' || !HASH.test(raw['runRootHash']) ||
    typeof raw['taskId'] !== 'string' || !SAFE_ID.test(raw['taskId']) ||
    typeof raw['logicalSlotHash'] !== 'string' || !HASH.test(raw['logicalSlotHash']) ||
    (raw['ambiguousAttempt'] !== 1 && raw['ambiguousAttempt'] !== 2) ||
    (raw['decision'] !== 'retry-once' && raw['decision'] !== 'cancel') ||
    typeof raw['resolutionHash'] !== 'string' || !HASH.test(raw['resolutionHash'])) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  const authority = Object.freeze({
    [resolutionAuthorityBrand]: true as const,
    kind: 'durable-delegation-operation-resolution-authority-v1' as const,
  })
  resolutionAuthorities.set(authority, Object.freeze({
    runRootHash: raw['runRootHash'],
    taskId: raw['taskId'],
    logicalSlotHash: raw['logicalSlotHash'],
    ambiguousAttempt: raw['ambiguousAttempt'],
    decision: raw['decision'],
    resolutionHash: raw['resolutionHash'],
  }))
  return authority
}

function configure(db: Database.Database): void {
  db.pragma('busy_timeout = 0')
  db.pragma('locking_mode = NORMAL')
  db.pragma('synchronous = FULL')
  db.pragma('trusted_schema = OFF')
  db.pragma('foreign_keys = ON')
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function validateArtifacts(path: string, uid: number): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const stat = lstatSync(path + suffix)
      if (!privateRegular(stat, uid) || suffix !== '-journal') {
        fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
      }
    } catch (error) {
      if (error instanceof DurableDelegationOperationControlError) throw error
      if (nodeErrorCode(error) !== 'ENOENT') fail('DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
    }
  }
}

function exactDatabaseObjects(db: Database.Database): void {
  const expected = new Map([
    ['budget_scopes', SCOPE_SCHEMA],
    ['control_meta', META_SCHEMA],
    ['operation_attempts', ATTEMPT_SCHEMA],
    ['operation_slots', SLOT_SCHEMA],
    ['task_inventories', TASK_SCHEMA],
  ])
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ type: string; name: string; sql: string | null }>
  if (objects.length !== expected.size || objects.some(object => object.type !== 'table' ||
    object.sql === null || normalizeSql(object.sql) !== normalizeSql(expected.get(object.name) ?? ''))) {
    fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
}

function rowWithoutIntegrity(row: DbRow): DbRow {
  const result: DbRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'integrity_hash') result[key] = value
  }
  return result
}

function integrity(domain: string, row: DbRow): string {
  return digest(`aisy.durable-delegation.operation-control.${domain}.v1`, rowWithoutIntegrity(row))
}

function validateRows(db: Database.Database): void {
  for (const [table, domain] of [
    ['control_meta', 'meta'],
    ['budget_scopes', 'scope'],
    ['task_inventories', 'task'],
    ['operation_slots', 'slot'],
    ['operation_attempts', 'attempt'],
  ] as const) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as DbRow[]
    for (const row of rows) {
      if (typeof row['integrity_hash'] !== 'string' || !HASH.test(row['integrity_hash']) ||
        row['integrity_hash'] !== integrity(domain, row)) {
        fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
      }
    }
  }
}

function validateDatabase(handle: LedgerHandle): void {
  configure(handle.db)
  const current = lstatSync(handle.path)
  if (!privateRegular(current, handle.uid) || !sameIdentity(handle.stat, current) ||
    String(handle.db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete' ||
    Number(handle.db.pragma('application_id', { simple: true })) !== APPLICATION_ID ||
    Number(handle.db.pragma('user_version', { simple: true })) !== USER_VERSION ||
    Number(handle.db.pragma('synchronous', { simple: true })) !== 2 ||
    Number(handle.db.pragma('trusted_schema', { simple: true })) !== 0 ||
    Number(handle.db.pragma('foreign_keys', { simple: true })) !== 1 ||
    String(handle.db.pragma('quick_check', { simple: true })) !== 'ok') {
    fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
  exactDatabaseObjects(handle.db)
  validateArtifacts(handle.path, handle.uid)
  validateRows(handle.db)
}

function openDatabase(
  root: string,
  installationHash: string,
  policyRevision: string,
): LedgerHandle {
  const path = join(root, LEDGER_FILENAME)
  const uid = currentUid()
  let created = false
  try {
    const descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    )
    try {
      fchmodSync(descriptor, 0o600)
      fsyncSync(descriptor)
      if (!privateRegular(fstatSync(descriptor), uid)) {
        fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
      }
    } finally {
      closeSync(descriptor)
    }
    syncDirectory(root)
    created = true
  } catch (error) {
    if (error instanceof DurableDelegationOperationControlError) throw error
    if (nodeErrorCode(error) !== 'EEXIST') fail('DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
  }
  let before: Stats
  try { before = lstatSync(path) } catch { fail('DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE') }
  if (!privateRegular(before, uid)) fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  validateArtifacts(path, uid)
  let db: Database.Database
  try { db = new Database(path, { timeout: 0, fileMustExist: true }) } catch {
    fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
  const after = lstatSync(path)
  if (!privateRegular(after, uid) || !sameIdentity(before, after)) {
    db.close()
    fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
  }
  const handle: LedgerHandle = { db, path, stat: after, uid }
  try {
    configure(db)
    if (created) {
      db.pragma('journal_mode = DELETE')
      db.pragma(`application_id = ${APPLICATION_ID}`)
      db.pragma(`user_version = ${USER_VERSION}`)
      const databaseId = randomBytes(32).toString('hex')
      const transaction = db.transaction(() => {
        db.exec(META_SCHEMA)
        db.exec(SCOPE_SCHEMA)
        db.exec(TASK_SCHEMA)
        db.exec(SLOT_SCHEMA)
        db.exec(ATTEMPT_SCHEMA)
        const meta: DbRow = {
          singleton: 1,
          schema_version: 1,
          database_id: databaseId,
          installation_hash: installationHash,
          policy_revision: policyRevision,
        }
        db.prepare('INSERT INTO control_meta VALUES (1, 1, ?, ?, ?, ?)').run(
          databaseId,
          installationHash,
          policyRevision,
          integrity('meta', meta),
        )
      })
      transaction.immediate()
      syncDirectory(root)
    }
    validateDatabase(handle)
    const meta = db.prepare(
      'SELECT installation_hash, policy_revision FROM control_meta',
    ).get() as { installation_hash?: unknown; policy_revision?: unknown } | undefined
    if (meta?.installation_hash !== installationHash || meta.policy_revision !== policyRevision) {
      fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    }
    return handle
  } catch (error) {
    db.close()
    if (error instanceof DurableDelegationOperationControlError) throw error
    fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
}

function mapLeaseError(error: unknown): never {
  if (error instanceof PrivateSqliteLeaseError) {
    if (error.failure === 'busy') fail('DELEGATION_OPERATION_CONTROL_WRITER_BUSY')
    if (error.failure === 'unsafe') fail('DELEGATION_OPERATION_CONTROL_ROOT_UNSAFE')
    if (error.failure === 'corrupt') fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
  fail('DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
}

function scopeRow(
  kind: DurableDelegationBudgetScopeKindV1,
  ceiling: Readonly<DurableDelegationBudgetCeilingV1>,
  policyRevision: string,
): DbRow {
  return {
    scope_kind: kind,
    scope_hash: ceiling.scopeHash,
    maximum_iterations: ceiling.maximumIterations,
    maximum_spend_usd_nanos: ceiling.maximumSpendUsdNanos,
    daily_epoch: kind === 'daily' ? ceiling.dailyEpoch! : null,
    policy_revision: policyRevision,
  }
}

function taskRow(binding: CapturedBinding): DbRow {
  return {
    run_root_hash: binding.runRootHash,
    task_id: binding.taskId,
    binding_hash: binding.bindingHash,
    delegation_id: binding.delegationId,
    authority_hash: binding.authorityHash,
    policy_revision: binding.policyRevision,
    task_scope_hash: binding.ceilings.task.scopeHash,
    run_scope_hash: binding.ceilings.run.scopeHash,
    global_scope_hash: binding.ceilings.global.scopeHash,
    daily_scope_hash: binding.ceilings.daily.scopeHash,
    inventory_state: 'open',
    sequence_length: 0,
    tail_hash: GENESIS,
    candidate_hash: null,
  }
}

function logicalSlotHash(binding: CapturedBinding, operation: CapturedLogicalOperation): string {
  return digest('aisy.durable-delegation.operation-control.logical-slot.v1', {
    runRootHash: binding.runRootHash,
    bindingHash: binding.bindingHash,
    delegationId: binding.delegationId,
    taskId: binding.taskId,
    sequence: operation.sequence,
    phase: operation.phase,
    ordinal: operation.ordinal,
    canonicalRequestHash: operation.canonicalRequestHash,
    authorityHash: operation.authorityHash,
    policyRevision: operation.policyRevision,
  })
}

function attemptKeyHash(logicalHash: string, attempt: 1 | 2, resolutionHash: string): string {
  return digest('aisy.durable-delegation.operation-control.attempt.v1', {
    logicalSlotHash: logicalHash,
    attempt,
    resolutionHash,
  })
}

function slotRow(
  binding: CapturedBinding,
  operation: CapturedLogicalOperation,
  logicalHash: string,
): DbRow {
  return {
    run_root_hash: binding.runRootHash,
    task_id: binding.taskId,
    sequence: operation.sequence,
    logical_slot_hash: logicalHash,
    phase: operation.phase,
    ordinal: operation.ordinal,
    canonical_request_hash: operation.canonicalRequestHash,
    authority_hash: operation.authorityHash,
    policy_revision: operation.policyRevision,
    retry_class: operation.retryClass,
    resolution_decision: null,
    resolution_hash: null,
    resolution_consumed: 0,
  }
}

function attemptRow(
  binding: CapturedBinding,
  operation: CapturedLogicalOperation,
  logicalHash: string,
  attempt: 1 | 2,
  resolutionHash: string,
): DbRow {
  return {
    run_root_hash: binding.runRootHash,
    task_id: binding.taskId,
    sequence: operation.sequence,
    attempt,
    attempt_key_hash: attemptKeyHash(logicalHash, attempt, resolutionHash),
    resolution_hash: resolutionHash,
    maximum_iterations: operation.maximumIterations,
    maximum_spend_usd_nanos: operation.maximumSpendUsdNanos,
    budget_state: 'held',
    prepared_hash: null,
    ambiguous: 0,
    receipt_hash: null,
    result_hash: null,
    actual_iterations: null,
    actual_spend_usd_nanos: null,
    wall_ms: null,
    effect: null,
    evidence_hash: null,
    action_status: null,
    outcome: null,
  }
}

function insertRow(db: Database.Database, table: string, row: DbRow, domain: string): void {
  const complete: DbRow = { ...row, integrity_hash: integrity(domain, row) }
  const keys = Object.keys(complete)
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...keys.map(key => complete[key]))
}

function updateRow(
  db: Database.Database,
  table: string,
  domain: string,
  row: DbRow,
  where: Readonly<Record<string, unknown>>,
): void {
  const complete: DbRow = { ...row, integrity_hash: integrity(domain, row) }
  const keys = Object.keys(complete)
  const whereKeys = Object.keys(where)
  const result = db.prepare(
    `UPDATE ${table} SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE ${whereKeys
      .map(key => `${key} = ?`).join(' AND ')}`,
  ).run(...keys.map(key => complete[key]), ...whereKeys.map(key => where[key]))
  if (result.changes !== 1) fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
}

function sameRow(left: DbRow, right: DbRow): boolean {
  return canonicalJson(rowWithoutIntegrity(left)) === canonicalJson(rowWithoutIntegrity(right))
}

function safeAdd(left: number, right: number): number {
  if (!safeInteger(left) || !safeInteger(right) || left > Number.MAX_SAFE_INTEGER - right) {
    fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
  }
  return left + right
}

function amountFor(row: DbRow): { iterations: number; spendUsdNanos: number; wallMs: number } {
  const state = row['budget_state']
  if (state === 'held' || state === 'conservative') {
    return {
      iterations: Number(row['maximum_iterations']),
      spendUsdNanos: Number(row['maximum_spend_usd_nanos']),
      wallMs: 0,
    }
  }
  return {
    iterations: Number(row['actual_iterations']),
    spendUsdNanos: Number(row['actual_spend_usd_nanos']),
    wallMs: Number(row['wall_ms']),
  }
}

function attemptsForScope(
  db: Database.Database,
  kind: DurableDelegationBudgetScopeKindV1,
  scopeHash: string,
): DbRow[] {
  const column = `${kind}_scope_hash`
  return db.prepare(
    `SELECT a.* FROM operation_attempts a JOIN task_inventories t ` +
    `ON a.run_root_hash = t.run_root_hash AND a.task_id = t.task_id ` +
    `WHERE t.${column} = ?`,
  ).all(scopeHash) as DbRow[]
}

function assertBudgetAvailable(
  db: Database.Database,
  binding: CapturedBinding,
  charge: Readonly<{ iterations: number; spendUsdNanos: number }>,
): void {
  for (const kind of ['task', 'run', 'global', 'daily'] as const) {
    const ceiling = binding.ceilings[kind]
    let iterations = 0
    let spendUsdNanos = 0
    for (const row of attemptsForScope(db, kind, ceiling.scopeHash)) {
      const amount = amountFor(row)
      iterations = safeAdd(iterations, amount.iterations)
      spendUsdNanos = safeAdd(spendUsdNanos, amount.spendUsdNanos)
    }
    const nextIterations = safeAdd(iterations, charge.iterations)
    const nextSpend = safeAdd(spendUsdNanos, charge.spendUsdNanos)
    if ((ceiling.maximumIterations !== null && nextIterations > ceiling.maximumIterations) ||
      (ceiling.maximumSpendUsdNanos !== null && nextSpend > ceiling.maximumSpendUsdNanos)) {
      fail('DELEGATION_OPERATION_CONTROL_BUDGET_DENIED')
    }
  }
}

function rowAttemptView(row: DbRow): DurableDelegationOperationAttemptViewV1 {
  const receipt = row['receipt_hash'] === null ? undefined : Object.freeze({
    receiptHash: row['receipt_hash'] as string,
    resultHash: row['result_hash'] as string,
    iterations: Number(row['actual_iterations']),
    spendUsdNanos: Number(row['actual_spend_usd_nanos']),
    wallMs: Number(row['wall_ms']),
    effect: row['effect'] as 'none' | 'read' | 'mutation',
    ...(row['evidence_hash'] === null ? {} : { evidenceHash: row['evidence_hash'] as string }),
    ...(row['action_status'] === null ? {} : {
      actionStatus: row['action_status'] as 'verified' | 'unverified',
    }),
    outcome: row['outcome'] as 'completed' | 'stopped',
  })
  return Object.freeze({
    attempt: Number(row['attempt']) as 1 | 2,
    attemptKeyHash: row['attempt_key_hash'] as string,
    resolutionHash: row['resolution_hash'] as string,
    maximumCharge: Object.freeze({
      iterations: Number(row['maximum_iterations']),
      spendUsdNanos: Number(row['maximum_spend_usd_nanos']),
    }),
    budgetState: row['budget_state'] as DurableDelegationOperationBudgetStateV1,
    ...(row['prepared_hash'] === null ? {} : { preparedHash: row['prepared_hash'] as string }),
    ambiguous: row['ambiguous'] === 1,
    ...(receipt === undefined ? {} : { receipt }),
  })
}

function rowsSlotView(db: Database.Database, row: DbRow): DurableDelegationOperationSlotViewV1 {
  const attempts = db.prepare(
    'SELECT * FROM operation_attempts WHERE run_root_hash = ? AND task_id = ? AND sequence = ? ORDER BY attempt',
  ).all(row['run_root_hash'], row['task_id'], row['sequence']) as DbRow[]
  return Object.freeze({
    sequence: Number(row['sequence']),
    logicalSlotHash: row['logical_slot_hash'] as string,
    phase: row['phase'] as 'provider' | 'tool',
    ordinal: Number(row['ordinal']),
    canonicalRequestHash: row['canonical_request_hash'] as string,
    authorityHash: row['authority_hash'] as string,
    policyRevision: row['policy_revision'] as string,
    retryClass: row['retry_class'] as 'retry-once' | 'new-task-only',
    ...(row['resolution_decision'] === null ? {} : {
      resolution: Object.freeze({
        decision: row['resolution_decision'] as 'retry-once' | 'cancel',
        resolutionHash: row['resolution_hash'] as string,
        consumed: row['resolution_consumed'] === 1,
      }),
    }),
    attempts: Object.freeze(attempts.map(rowAttemptView)),
  })
}

function taskSnapshot(db: Database.Database, binding: CapturedBinding):
DurableDelegationOperationInventorySnapshotV1 {
  const task = db.prepare(
    'SELECT * FROM task_inventories WHERE run_root_hash = ? AND task_id = ?',
  ).get(binding.runRootHash, binding.taskId) as DbRow | undefined
  if (task === undefined) fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
  const slots = db.prepare(
    'SELECT * FROM operation_slots WHERE run_root_hash = ? AND task_id = ? ORDER BY sequence',
  ).all(binding.runRootHash, binding.taskId) as DbRow[]
  return Object.freeze({
    schemaVersion: 1 as const,
    state: task['inventory_state'] as 'open' | 'sealed',
    sequenceLength: Number(task['sequence_length']),
    tailHash: task['tail_hash'] as string,
    ...(task['candidate_hash'] === null ? {} : { candidateHash: task['candidate_hash'] as string }),
    slots: Object.freeze(slots.map(row => rowsSlotView(db, row))),
  })
}

function taskMatches(row: DbRow, binding: CapturedBinding): boolean {
  const expected = taskRow(binding)
  return Object.entries(expected).every(([key, value]) => key === 'inventory_state' ||
    key === 'sequence_length' || key === 'tail_hash' || key === 'candidate_hash' ||
    row[key] === value)
}

function recoverInterruptedAttempts(handle: LedgerHandle, binding: CapturedBinding): void {
  const interrupted = handle.db.prepare(
    "SELECT * FROM operation_attempts WHERE budget_state = 'held' "
      + 'AND prepared_hash IS NOT NULL AND receipt_hash IS NULL AND ambiguous = 0 '
      + 'AND run_root_hash = ? AND task_id = ?',
  ).all(binding.runRootHash, binding.taskId) as DbRow[]
  if (interrupted.length === 0) return
  for (const attempt of interrupted) {
    updateRow(handle.db, 'operation_attempts', 'attempt', {
      ...rowWithoutIntegrity(attempt),
      ambiguous: 1,
    }, {
      run_root_hash: attempt['run_root_hash'],
      task_id: attempt['task_id'],
      sequence: attempt['sequence'],
      attempt: attempt['attempt'],
    })
  }
}

/**
 * Creates a dormant singleton writer. The caller supplies a private canonical
 * root dedicated to this ledger; no provider, tool, bot, or supervisor is used.
 */
export function makeNodeDurableDelegationOperationControlV1(input: Readonly<{
  root: string
  installationHash: string
  policyRevision: string
  dailyEpoch: string
}>): DurableDelegationOperationControlV1 {
  const raw = exactObject(input, ['root', 'installationHash', 'policyRevision', 'dailyEpoch'])
  if (typeof raw['root'] !== 'string' || typeof raw['installationHash'] !== 'string' ||
    !HASH.test(raw['installationHash']) || typeof raw['policyRevision'] !== 'string' ||
    !POLICY_REVISION.test(raw['policyRevision']) || typeof raw['dailyEpoch'] !== 'string' ||
    !DAILY_EPOCH.test(raw['dailyEpoch'])) {
    fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
  }
  const installationHash = raw['installationHash']
  const dailyEpoch = raw['dailyEpoch']
  privateDirectory(raw['root'])
  let writer: PrivateSqliteLease
  try {
    writer = acquirePrivateSqliteLease({
      root: join(raw['root'], '.operation-control-writer'),
      profile: WRITER_PROFILE,
    })
  } catch (error) {
    mapLeaseError(error)
  }
  let handle: LedgerHandle
  try {
    handle = openDatabase(raw['root'], raw['installationHash'], raw['policyRevision'])
  } catch (error) {
    writer.release()
    throw error
  }
  let closed = false
  const controller = Object.freeze({})

  const assertReady = (): void => {
    if (closed || !handle.db.open) fail('DELEGATION_OPERATION_CONTROL_STATE_UNAVAILABLE')
    try { writer.assertHeld() } catch (error) { mapLeaseError(error) }
    validateDatabase(handle)
  }

  const transaction = <T>(operation: () => T): T => {
    assertReady()
    try {
      const result = handle.db.transaction(operation).immediate() as T
      validateDatabase(handle)
      return result
    } catch (error) {
      if (error instanceof DurableDelegationOperationControlError) throw error
      fail('DELEGATION_OPERATION_CONTROL_STATE_CORRUPT')
    }
  }

  const bindTask = (
    inputBinding: DurableDelegationOperationControlBindingV1,
  ): DurableDelegationBoundOperationControlV1 => {
    const binding = captureBinding(inputBinding)
    const canonicalScopes = deriveDurableDelegationOperationControlScopeHashesV1({
      installationHash,
      runRootHash: binding.runRootHash,
      bindingHash: binding.bindingHash,
      taskId: binding.taskId,
      dailyEpoch,
    })
    if (binding.ceilings.daily.dailyEpoch !== dailyEpoch ||
      (['task', 'run', 'global', 'daily'] as const).some(kind =>
        binding.ceilings[kind].scopeHash !== canonicalScopes[kind])) {
      fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
    }
    transaction(() => {
      for (const kind of ['task', 'run', 'global', 'daily'] as const) {
        const candidate = scopeRow(kind, binding.ceilings[kind], binding.policyRevision)
        const existing = handle.db.prepare(
          'SELECT * FROM budget_scopes WHERE scope_kind = ? AND scope_hash = ?',
        ).get(kind, binding.ceilings[kind].scopeHash) as DbRow | undefined
        if (existing === undefined) insertRow(handle.db, 'budget_scopes', candidate, 'scope')
        else if (!sameRow(existing, candidate)) fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
      }
      const existing = handle.db.prepare(
        'SELECT * FROM task_inventories WHERE run_root_hash = ? AND task_id = ?',
      ).get(binding.runRootHash, binding.taskId) as DbRow | undefined
      if (existing === undefined) insertRow(handle.db, 'task_inventories', taskRow(binding), 'task')
      else if (!taskMatches(existing, binding)) fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
      recoverInterruptedAttempts(handle, binding)
    })

    const exactTask = (): DbRow => {
      const row = handle.db.prepare(
        'SELECT * FROM task_inventories WHERE run_root_hash = ? AND task_id = ?',
      ).get(binding.runRootHash, binding.taskId) as DbRow | undefined
      if (row === undefined) fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
      return row
    }

    const assertOpenTask = (): void => {
      if (exactTask()['inventory_state'] !== 'open') {
        fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
      }
    }

    const exactAttempt = (logicalHash: string, attempt: 1 | 2): DbRow => {
      const row = handle.db.prepare(
        'SELECT * FROM operation_attempts WHERE run_root_hash = ? AND task_id = ? AND sequence = '
          + '(SELECT sequence FROM operation_slots WHERE logical_slot_hash = ?) AND attempt = ?',
      ).get(binding.runRootHash, binding.taskId, logicalHash, attempt) as DbRow | undefined
      if (row === undefined) fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
      return row
    }

    const exactSlot = (logicalHash: string): DbRow => {
      const row = handle.db.prepare(
        'SELECT * FROM operation_slots WHERE run_root_hash = ? AND task_id = ? AND logical_slot_hash = ?',
      ).get(binding.runRootHash, binding.taskId, logicalHash) as DbRow | undefined
      if (row === undefined) fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
      return row
    }

    const bound: DurableDelegationBoundOperationControlV1 = {
      binding() {
        assertReady()
        return frozen({
          schemaVersion: 1 as const,
          runRootHash: binding.runRootHash,
          bindingHash: binding.bindingHash,
          delegationId: binding.delegationId,
          taskId: binding.taskId,
          authorityHash: binding.authorityHash,
          policyRevision: binding.policyRevision,
          ceilings: binding.ceilings,
        })
      },

      snapshot() {
        assertReady()
        return frozen(taskSnapshot(handle.db, binding))
      },

      expect(value) {
        const operation = captureLogicalOperation(value)
        if (operation.authorityHash !== binding.authorityHash ||
          operation.policyRevision !== binding.policyRevision) {
          fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
        }
        return transaction(() => {
          const task = handle.db.prepare(
            'SELECT * FROM task_inventories WHERE run_root_hash = ? AND task_id = ?',
          ).get(binding.runRootHash, binding.taskId) as DbRow
          const logicalHash = logicalSlotHash(binding, operation)
          const existing = handle.db.prepare(
            'SELECT * FROM operation_slots WHERE run_root_hash = ? AND task_id = ? AND sequence = ?',
          ).get(binding.runRootHash, binding.taskId, operation.sequence) as DbRow | undefined
          let disposition: 'created' | 'replayed' = 'replayed'
          if (existing === undefined) {
            if (task['inventory_state'] !== 'open' || operation.sequence !==
              Number(task['sequence_length']) + 1) {
              fail('DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
            }
            const previous = handle.db.prepare(
              'SELECT phase, ordinal FROM operation_slots WHERE run_root_hash = ? AND task_id = ? '
                + 'ORDER BY sequence',
            ).all(binding.runRootHash, binding.taskId) as Array<{ phase: string; ordinal: number }>
            const samePhase = previous.filter(item => item.phase === operation.phase)
            const priorOrdinal = samePhase.at(-1)?.ordinal
            if ((operation.phase === 'provider' && operation.ordinal !== (priorOrdinal ?? 0) + 1) ||
              (operation.phase === 'tool' && priorOrdinal !== undefined && operation.ordinal <= priorOrdinal)) {
              fail('DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
            }
            assertBudgetAvailable(handle.db, binding, {
              iterations: operation.maximumIterations,
              spendUsdNanos: operation.maximumSpendUsdNanos,
            })
            insertRow(handle.db, 'operation_slots', slotRow(binding, operation, logicalHash), 'slot')
            insertRow(handle.db, 'operation_attempts', attemptRow(
              binding,
              operation,
              logicalHash,
              1,
              GENESIS,
            ), 'attempt')
            const nextTask = {
              ...rowWithoutIntegrity(task),
              sequence_length: operation.sequence,
              tail_hash: digest('aisy.durable-delegation.operation-control.tail.v1', {
                previous: task['tail_hash'],
                logicalSlotHash: logicalHash,
              }),
            }
            updateRow(handle.db, 'task_inventories', 'task', nextTask, {
              run_root_hash: binding.runRootHash,
              task_id: binding.taskId,
            })
            disposition = 'created'
          } else if (existing['logical_slot_hash'] !== logicalHash ||
            existing['phase'] !== operation.phase || existing['ordinal'] !== operation.ordinal ||
            existing['canonical_request_hash'] !== operation.canonicalRequestHash ||
            existing['authority_hash'] !== operation.authorityHash ||
            existing['policy_revision'] !== operation.policyRevision ||
            existing['retry_class'] !== operation.retryClass) {
            fail('DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
          }
          const slot = existing ?? exactSlot(logicalHash)
          const firstAttempt = exactAttempt(logicalHash, 1)
          if (Number(firstAttempt['maximum_iterations']) !== operation.maximumIterations ||
            Number(firstAttempt['maximum_spend_usd_nanos']) !== operation.maximumSpendUsdNanos) {
            fail('DELEGATION_OPERATION_CONTROL_SEQUENCE_DRIFT')
          }
          const attempt = handle.db.prepare(
            'SELECT * FROM operation_attempts WHERE run_root_hash = ? AND task_id = ? '
              + 'AND sequence = ? ORDER BY attempt DESC LIMIT 1',
          ).get(binding.runRootHash, binding.taskId, slot['sequence']) as DbRow
          return Object.freeze({
            disposition,
            slot: rowsSlotView(handle.db, slot),
            attempt: rowAttemptView(attempt),
          })
        })
      },

      markPrepared(value) {
        const rawPrepared = exactObject(value, ['logicalSlotHash', 'attempt', 'preparedHash'])
        if (typeof rawPrepared['logicalSlotHash'] !== 'string' ||
          !HASH.test(rawPrepared['logicalSlotHash']) ||
          (rawPrepared['attempt'] !== 1 && rawPrepared['attempt'] !== 2) ||
          typeof rawPrepared['preparedHash'] !== 'string' || !HASH.test(rawPrepared['preparedHash'])) {
          fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
        }
        const logicalSlotHash = rawPrepared['logicalSlotHash']
        const attemptNumber = rawPrepared['attempt']
        const preparedHash = rawPrepared['preparedHash']
        return transaction(() => {
          assertOpenTask()
          const slot = exactSlot(logicalSlotHash)
          const attempt = exactAttempt(logicalSlotHash, attemptNumber)
          if (attempt['budget_state'] !== 'held' || attempt['receipt_hash'] !== null ||
            attempt['prepared_hash'] !== null || attempt['ambiguous'] !== 0) {
            fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
          }
          const nextAttempt = {
            ...rowWithoutIntegrity(attempt),
            prepared_hash: preparedHash,
          }
          updateRow(handle.db, 'operation_attempts', 'attempt', nextAttempt, {
            run_root_hash: binding.runRootHash,
            task_id: binding.taskId,
            sequence: slot['sequence'],
            attempt: attemptNumber,
          })
          if (attemptNumber === 2 && slot['resolution_decision'] === 'retry-once' &&
            slot['resolution_consumed'] === 0) {
            const nextSlot = { ...rowWithoutIntegrity(slot), resolution_consumed: 1 }
            updateRow(handle.db, 'operation_slots', 'slot', nextSlot, {
              run_root_hash: binding.runRootHash,
              task_id: binding.taskId,
              sequence: slot['sequence'],
            })
          }
          return rowAttemptView(nextAttempt)
        })
      },

      markAmbiguous(value) {
        const rawAmbiguous = exactObject(value, ['logicalSlotHash', 'attempt'])
        if (typeof rawAmbiguous['logicalSlotHash'] !== 'string' ||
          !HASH.test(rawAmbiguous['logicalSlotHash']) ||
          (rawAmbiguous['attempt'] !== 1 && rawAmbiguous['attempt'] !== 2)) {
          fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
        }
        const logicalSlotHash = rawAmbiguous['logicalSlotHash']
        const attemptNumber = rawAmbiguous['attempt']
        return transaction(() => {
          assertOpenTask()
          const slot = exactSlot(logicalSlotHash)
          const attempt = exactAttempt(logicalSlotHash, attemptNumber)
          if (attempt['budget_state'] !== 'held' || attempt['prepared_hash'] === null ||
            attempt['receipt_hash'] !== null) fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
          const next = { ...rowWithoutIntegrity(attempt), ambiguous: 1 }
          updateRow(handle.db, 'operation_attempts', 'attempt', next, {
            run_root_hash: binding.runRootHash,
            task_id: binding.taskId,
            sequence: slot['sequence'],
            attempt: attemptNumber,
          })
          return rowAttemptView(next)
        })
      },

      reconcileSettled(value) {
        const rawSettled = exactObject(value, [
          'logicalSlotHash', 'attempt', 'preparedHash', 'receipt',
        ])
        if (typeof rawSettled['logicalSlotHash'] !== 'string' ||
          !HASH.test(rawSettled['logicalSlotHash']) ||
          (rawSettled['attempt'] !== 1 && rawSettled['attempt'] !== 2) ||
          typeof rawSettled['preparedHash'] !== 'string' || !HASH.test(rawSettled['preparedHash'])) {
          fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
        }
        const receipt = captureReceipt(rawSettled['receipt'])
        const logicalSlotHash = rawSettled['logicalSlotHash']
        const attemptNumber = rawSettled['attempt']
        const preparedHash = rawSettled['preparedHash']
        return transaction(() => {
          assertOpenTask()
          const slot = exactSlot(logicalSlotHash)
          const attempt = exactAttempt(logicalSlotHash, attemptNumber)
          if (attempt['receipt_hash'] !== null) {
            if (attempt['receipt_hash'] !== receipt.receiptHash ||
              attempt['prepared_hash'] !== preparedHash) {
              fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
            }
            return rowAttemptView(attempt)
          }
          if (attempt['budget_state'] !== 'held' || attempt['prepared_hash'] !== preparedHash) {
            fail('DELEGATION_OPERATION_CONTROL_ATTEMPT_DENIED')
          }
          const overrun = receipt.iterations > Number(attempt['maximum_iterations']) ||
            receipt.spendUsdNanos > Number(attempt['maximum_spend_usd_nanos'])
          const next = {
            ...rowWithoutIntegrity(attempt),
            budget_state: overrun ? 'overrun' : 'charged',
            prepared_hash: preparedHash,
            ambiguous: 0,
            receipt_hash: receipt.receiptHash,
            result_hash: receipt.resultHash,
            actual_iterations: receipt.iterations,
            actual_spend_usd_nanos: receipt.spendUsdNanos,
            wall_ms: receipt.wallMs,
            effect: receipt.effect,
            evidence_hash: receipt.evidenceHash ?? null,
            action_status: receipt.actionStatus ?? null,
            outcome: receipt.outcome,
          }
          updateRow(handle.db, 'operation_attempts', 'attempt', next, {
            run_root_hash: binding.runRootHash,
            task_id: binding.taskId,
            sequence: slot['sequence'],
            attempt: attemptNumber,
          })
          return rowAttemptView(next)
        })
      },

      resolve(authority) {
        if (typeof authority !== 'object' || authority === null ||
          consumedResolutionAuthorities.has(authority)) {
          fail('DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
        }
        const state = resolutionAuthorities.get(authority)
        if (state === undefined || state.runRootHash !== binding.runRootHash ||
          state.taskId !== binding.taskId) fail('DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
        const result = transaction(() => {
          assertOpenTask()
          const slot = exactSlot(state.logicalSlotHash)
          const attempt = exactAttempt(state.logicalSlotHash, state.ambiguousAttempt)
          const secondAttemptCancellation = state.decision === 'cancel' &&
            state.ambiguousAttempt === 2 && slot['resolution_decision'] === 'retry-once' &&
            slot['resolution_consumed'] === 1
          if ((!secondAttemptCancellation && slot['resolution_decision'] !== null) ||
            attempt['budget_state'] !== 'held' || attempt['ambiguous'] !== 1 ||
            (state.decision === 'retry-once' && (state.ambiguousAttempt !== 1 ||
              slot['retry_class'] !== 'retry-once'))) {
            fail('DELEGATION_OPERATION_CONTROL_RESOLUTION_DENIED')
          }
          let selectedAttempt = attempt
          if (state.decision === 'retry-once') {
            assertBudgetAvailable(handle.db, binding, {
              iterations: Number(attempt['maximum_iterations']),
              spendUsdNanos: Number(attempt['maximum_spend_usd_nanos']),
            })
            const logical: CapturedLogicalOperation = {
              sequence: Number(slot['sequence']),
              phase: slot['phase'] as 'provider' | 'tool',
              ordinal: Number(slot['ordinal']),
              canonicalRequestHash: slot['canonical_request_hash'] as string,
              authorityHash: slot['authority_hash'] as string,
              policyRevision: slot['policy_revision'] as string,
              retryClass: slot['retry_class'] as 'retry-once' | 'new-task-only',
              maximumIterations: Number(attempt['maximum_iterations']),
              maximumSpendUsdNanos: Number(attempt['maximum_spend_usd_nanos']),
            }
            const second = attemptRow(
              binding,
              logical,
              state.logicalSlotHash,
              2,
              state.resolutionHash,
            )
            insertRow(handle.db, 'operation_attempts', second, 'attempt')
            selectedAttempt = second
          } else {
            const conservative = { ...rowWithoutIntegrity(attempt), budget_state: 'conservative' }
            updateRow(handle.db, 'operation_attempts', 'attempt', conservative, {
              run_root_hash: binding.runRootHash,
              task_id: binding.taskId,
              sequence: slot['sequence'],
              attempt: state.ambiguousAttempt,
            })
            selectedAttempt = conservative
          }
          const nextSlot = {
            ...rowWithoutIntegrity(slot),
            resolution_decision: state.decision,
            resolution_hash: state.resolutionHash,
            resolution_consumed: state.decision === 'cancel' ? 1 : 0,
          }
          updateRow(handle.db, 'operation_slots', 'slot', nextSlot, {
            run_root_hash: binding.runRootHash,
            task_id: binding.taskId,
            sequence: slot['sequence'],
          })
          return Object.freeze({
            decision: state.decision,
            slot: rowsSlotView(handle.db, nextSlot),
            attempt: rowAttemptView(selectedAttempt),
          })
        })
        consumedResolutionAuthorities.add(authority)
        return result
      },

      seal(value) {
        const rawSeal = exactObject(value, ['expectedLength', 'candidateHash'])
        if (!safeInteger(rawSeal['expectedLength'], MAX_SEQUENCE) ||
          typeof rawSeal['candidateHash'] !== 'string' || !HASH.test(rawSeal['candidateHash'])) {
          fail('DELEGATION_OPERATION_CONTROL_INPUT_INVALID')
        }
        return transaction(() => {
          const task = handle.db.prepare(
            'SELECT * FROM task_inventories WHERE run_root_hash = ? AND task_id = ?',
          ).get(binding.runRootHash, binding.taskId) as DbRow
          if (task['inventory_state'] === 'sealed') {
            if (task['sequence_length'] !== rawSeal['expectedLength'] ||
              task['candidate_hash'] !== rawSeal['candidateHash']) {
              fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
            }
            return taskSnapshot(handle.db, binding)
          }
          if (task['sequence_length'] !== rawSeal['expectedLength']) {
            fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
          }
          const slots = taskSnapshot(handle.db, binding).slots
          if (!slots.some(slot => slot.phase === 'provider')) {
            fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
          }
          for (const slot of slots) {
            if (slot.resolution?.decision === 'cancel') {
              fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
            }
            const finalAttempt = slot.attempts.find(item =>
              item.attempt === (slot.resolution?.decision === 'retry-once' ? 2 : 1))
            if (finalAttempt?.budgetState !== 'charged' || finalAttempt.receipt === undefined ||
              finalAttempt.receipt.outcome !== 'completed' || finalAttempt.ambiguous ||
              (slot.resolution?.decision === 'retry-once' && slot.resolution.consumed !== true) ||
              (slot.phase === 'tool' && finalAttempt.receipt.actionStatus !== 'verified') ||
              (finalAttempt.receipt.effect === 'mutation' &&
                finalAttempt.receipt.evidenceHash === undefined)) {
              fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
            }
            if (slot.attempts.some(attempt => attempt.budgetState === 'overrun' ||
              (attempt.receipt !== undefined && (attempt.receipt.outcome !== 'completed' ||
                (slot.phase === 'provider' && attempt.receipt.effect !== 'read') ||
                (slot.phase === 'tool' && attempt.receipt.actionStatus !== 'verified') ||
                (attempt.receipt.effect === 'mutation' &&
                  attempt.receipt.evidenceHash === undefined))))) {
              fail('DELEGATION_OPERATION_CONTROL_SEAL_DENIED')
            }
          }
          const nextTask = {
            ...rowWithoutIntegrity(task),
            inventory_state: 'sealed',
            candidate_hash: rawSeal['candidateHash'],
          }
          updateRow(handle.db, 'task_inventories', 'task', nextTask, {
            run_root_hash: binding.runRootHash,
            task_id: binding.taskId,
          })
          return taskSnapshot(handle.db, binding)
        })
      },

      readCost() {
        assertReady()
        const attempts = handle.db.prepare(
          'SELECT * FROM operation_attempts WHERE run_root_hash = ? AND task_id = ?',
        ).all(binding.runRootHash, binding.taskId) as DbRow[]
        let iterations = 0
        let spendUsdNanos = 0
        let wallMs = 0
        for (const attempt of attempts) {
          const amount = amountFor(attempt)
          iterations = safeAdd(iterations, amount.iterations)
          spendUsdNanos = safeAdd(spendUsdNanos, amount.spendUsdNanos)
          wallMs = safeAdd(wallMs, amount.wallMs)
        }
        return Object.freeze({ iterations, spendUsdNanos, wallMs })
      },

      evidence() {
        assertReady()
        return Object.freeze(taskSnapshot(handle.db, binding).slots.map(slot => Object.freeze({
          sequence: slot.sequence,
          logicalSlotHash: slot.logicalSlotHash,
          phase: slot.phase,
          ordinal: slot.ordinal,
          ...(slot.resolution === undefined ? {} : {
            resolution: Object.freeze({
              decision: slot.resolution.decision,
              resolutionHash: slot.resolution.resolutionHash,
            }),
          }),
          attempts: slot.attempts,
        })))
      },
    }
    const frozenBound = Object.freeze(bound)
    boundControlProvenance.set(frozenBound, Object.freeze({
      controller,
      binding: bindingView(binding),
      assertReady,
    }))
    return frozenBound
  }

  return Object.freeze({
    bindTask,
    attestBoundTask(bound: DurableDelegationBoundOperationControlV1) {
      if (typeof bound !== 'object' || bound === null || utilTypes.isProxy(bound) ||
        !Object.isFrozen(bound)) {
        fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
      }
      assertReady()
      const provenance = boundControlProvenance.get(bound)
      if (provenance === undefined || provenance.controller !== controller) {
        fail('DELEGATION_OPERATION_CONTROL_BINDING_DRIFT')
      }
      const attestation = Object.freeze({
        [boundControlAttestationBrand]: true as const,
        kind: 'durable-delegation-operation-control-bound-attestation-v1' as const,
      })
      boundControlAttestations.set(attestation, Object.freeze({
        ...provenance,
        bound,
      }))
      return attestation
    },
    close() {
      if (closed) return
      closed = true
      try { handle.db.close() } finally { writer.release() }
    },
  })
}

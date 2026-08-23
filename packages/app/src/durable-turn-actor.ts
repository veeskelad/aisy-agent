// Dormant durable state machine for a top-level turn paused on an approval.
// It deliberately owns no Telegram, provider, tool or process integration.

import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { types as utilTypes } from 'node:util'

import type { ResolvedWorkBinding } from '@aisy/core'
import Database from 'better-sqlite3'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'
import {
  isGenuineExecutionSupervisorRecoveryContextV1,
} from './execution-supervisor-ipc.js'
import type {
  ExecutionStartupRecoveryContextV1,
  ExecutionStartupRecoveryPortV1,
  ExecutionStartupRecoveryStepResultV1,
} from './execution-startup-recovery-coordinator.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FILENAME = /^[a-z0-9][a-z0-9.-]{0,127}$/
const MAX_TEXT_BYTES = 1024
const APPLICATION_ID = 0x4154_4152 // ATAR
const SCHEMA_VERSION = 1
const ACTOR_DOMAIN = 'aisy.durable-turn-actor.record.v1\0'
const BINDING_DOMAIN = 'aisy.durable-turn-actor.work-binding.v1\0'
const NONCE_DOMAIN = 'aisy.durable-turn-actor.nonce.v1\0'
const ACTION_DOMAIN = 'aisy.durable-turn-actor.action.v1\0'

const LEASE_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'durable-turn-actor-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const LEASE_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'durable-turn-actor-writer',
  filename: 'durable-turn-actor-writer.sqlite3',
  applicationId: 0x4154_414c, // ATAL
  userVersion: 1,
  exactSchemaSql: LEASE_SCHEMA,
}

const ACTOR_SCHEMA = `CREATE TABLE durable_turn_actors (
  actor_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('paused-awaiting-approval','resume-ready','cancelling','terminal')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  active_slot INTEGER UNIQUE CHECK (active_slot IS NULL OR active_slot = 1),
  record_json TEXT NOT NULL,
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID`

export type DurableTurnActorPhase =
  | 'paused-awaiting-approval'
  | 'resume-ready'
  | 'cancelling'
  | 'terminal'

export type DurableTurnApprovalTier = 'tier-1' | 'tier-2' | 'tier-3'
export type DurableTurnDecisionKind = 'confirmed' | 'rejected'

export interface DurableTurnBudgetV1 {
  readonly iterations: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly spendNanos: number
  readonly wallMs: number
  readonly ledgerRevision: number
}

export interface DurableTurnActorIdentityV1 {
  readonly schemaVersion: 1
  readonly actorId: string
  readonly operationId: string
  readonly operationHash: string
  readonly continuationHash: string
  readonly binding: Readonly<ResolvedWorkBinding>
  readonly workBindingHash: string
  readonly sessionId: string
  readonly turnId: string
  readonly supervisorBindingHash: string
  readonly policyRevision: string
  readonly budget: Readonly<DurableTurnBudgetV1>
}

export interface DurableTurnApprovalV1 {
  readonly actionId: string
  readonly actionHash: string
  readonly cardId: string
  readonly nonceHash: string
  readonly tier: DurableTurnApprovalTier
  readonly requiresStepUp: boolean
  readonly canRememberSimilar: boolean
  readonly operatorId: string
  readonly chatId: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
  readonly delivery: 'pending' | 'delivered'
  readonly messageId?: string
}

export interface DurableTurnDecisionV1 {
  readonly kind: DurableTurnDecisionKind
  readonly decidedAtMs: number
  readonly stepUpVerified: boolean
}

export interface DurableTurnClaimV1 {
  readonly claimId: string
  readonly ownerHash: string
  readonly claimedAtMs: number
}

export interface DurableTurnTerminalV1 {
  readonly kind: 'completed' | 'cancelled' | 'denied' | 'failed'
  readonly code: string
  readonly atMs: number
  readonly receiptHash?: string
}

export interface DurableTurnActorRecordV1 {
  readonly schemaVersion: 1
  readonly revision: number
  readonly phase: DurableTurnActorPhase
  readonly identity: Readonly<DurableTurnActorIdentityV1>
  readonly approval: Readonly<DurableTurnApprovalV1>
  readonly decision: Readonly<DurableTurnDecisionV1> | null
  readonly claim: Readonly<DurableTurnClaimV1> | null
  readonly terminal: Readonly<DurableTurnTerminalV1> | null
}

export interface DurableTurnOperationControlPort {
  /** Synchronous and side-effect free: mutation is denied unless authority is still held. */
  assertHeld(authority: Readonly<{
    operationId: string
    operationHash: string
    continuationHash: string
    workBindingHash: string
    sessionId: string
    turnId: string
    supervisorBindingHash: string
    policyRevision: string
    budget: Readonly<DurableTurnBudgetV1>
  }>): boolean
}

export interface DurableTurnCallbackAdmissionPort {
  assertAdmitted(authority: Readonly<{
    actorId: string
    actionId: string
    actionHash: string
    cardId: string
    operatorId: string
    chatId: string
    sessionId: string
    turnId: string
  }>): false | 'admitted' | 'step-up-admitted'
}

export interface DurableTurnCancellationControlPort {
  assertQuiesced(authority: Readonly<{
    actorId: string
    revision: number
    operationId: string
    operationHash: string
    continuationHash: string
    workBindingHash: string
    sessionId: string
    turnId: string
    supervisorBindingHash: string
    policyRevision: string
    budget: Readonly<DurableTurnBudgetV1>
    receiptHash: string
  }>): boolean
}

export interface DurableTurnClaimReconciliationControlPort {
  /**
   * True only after supervisor quiescence and exact operation inventory prove
   * that replaying the parent loop will re-enter code-owned reconciliation.
   */
  assertReplaySafe(authority: Readonly<{
    actorId: string
    revision: number
    operationId: string
    operationHash: string
    continuationHash: string
    workBindingHash: string
    sessionId: string
    turnId: string
    supervisorBindingHash: string
    policyRevision: string
    budget: Readonly<DurableTurnBudgetV1>
    priorClaim: Readonly<DurableTurnClaimV1>
    newOwnerHash: string
  }>): boolean
}

const resumePermitBrand: unique symbol = Symbol('aisy.durable-turn-resume-permit')

export interface DurableTurnResumePermitV1 {
  readonly [resumePermitBrand]: true
  readonly kind: 'durable-turn-resume-permit-v1'
}

const callbackAdmissionBrand: unique symbol = Symbol('aisy.durable-turn-callback-admission')

export interface DurableTurnCallbackAdmissionV1 {
  readonly [callbackAdmissionBrand]: true
  readonly kind: 'durable-turn-callback-admission-v1'
}

const cancellationAckBrand: unique symbol = Symbol('aisy.durable-turn-cancellation-ack')

export interface DurableTurnCancellationAckV1 {
  readonly [cancellationAckBrand]: true
  readonly kind: 'durable-turn-cancellation-ack-v1'
}

export type DurableTurnActorErrorCode =
  | 'DURABLE_TURN_INPUT_INVALID'
  | 'DURABLE_TURN_STORE_UNSAFE'
  | 'DURABLE_TURN_STORE_CORRUPT'
  | 'DURABLE_TURN_STORE_UNAVAILABLE'
  | 'DURABLE_TURN_STORE_CLOSED'
  | 'DURABLE_TURN_AUTHORITY_LOST'
  | 'DURABLE_TURN_TRANSITION_DENIED'

export class DurableTurnActorError extends Error {
  constructor(readonly code: DurableTurnActorErrorCode) {
    super(code)
    this.name = 'DurableTurnActorError'
  }
}

export type DurableTurnAdmissionV1 =
  | Readonly<{ kind: 'free' }>
  | Readonly<{ kind: 'busy-session'; actorId: string }>
  | Readonly<{ kind: 'busy-installation'; actorId: string; sessionId: string }>

export type DurableTurnRecoveryV1 =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'replace-card-required'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'awaiting-decision'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'resume-ready'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'rejection-ready'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'reconciliation-required'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'continue-cancelling'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'authority-lost'; record: DurableTurnActorRecordV1 }>

export interface DurableTurnPauseInputV1 {
  readonly identity: Omit<DurableTurnActorIdentityV1, 'actorId' | 'schemaVersion'>
  readonly approval: Readonly<{
    actionId: string
    tier: DurableTurnApprovalTier
    requiresStepUp: boolean
    canRememberSimilar: boolean
    chatId: string
    expiresAtMs: number
  }>
}

export interface DurableTurnApprovalCardV1 {
  readonly actorId: string
  readonly revision: number
  readonly actionId: string
  readonly actionHash: string
  readonly cardId: string
  readonly operatorId: string
  readonly chatId: string
  /** Ephemeral: only the hash is durable. */
  readonly nonce: string
  readonly expiresAtMs: number
}

export type DurableTurnPauseResultV1 =
  | Readonly<{ kind: 'paused'; record: DurableTurnActorRecordV1; card: DurableTurnApprovalCardV1 }>
  | Exclude<DurableTurnAdmissionV1, Readonly<{ kind: 'free' }>>

export type DurableTurnDecisionResultV1 =
  | Readonly<{ kind: 'recorded'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'replayed'; record: DurableTurnActorRecordV1 }>
  | Readonly<{ kind: 'stale' | 'expired' | 'cancelled' }>

export type DurableTurnClaimResultV1 =
  | Readonly<{
      kind: 'claimed'
      record: DurableTurnActorRecordV1
      permit: DurableTurnResumePermitV1
    }>
  | Readonly<{ kind: 'reconciliation-required'; record: DurableTurnActorRecordV1 }>

export interface DurableTurnApprovalCallbackV1 {
  recordDecision(input: Readonly<{
    admission: DurableTurnCallbackAdmissionV1
    nonce: string
    decision: DurableTurnDecisionKind
  }>): DurableTurnDecisionResultV1
}

export interface DurableTurnActorManagerV1 {
  admission(sessionId: string): DurableTurnAdmissionV1
  pause(input: DurableTurnPauseInputV1): DurableTurnPauseResultV1
  markCardDelivered(input: Readonly<{
    actorId: string
    expectedRevision: number
    messageId: string
  }>): DurableTurnActorRecordV1
  rotatePendingCard(input: Readonly<{
    actorId: string
    expectedRevision: number
  }>): Readonly<{ record: DurableTurnActorRecordV1; card: DurableTurnApprovalCardV1 }>
  /** Startup-only replacement: invalidates even a previously delivered card. */
  replaceCardAfterRecovery(input: Readonly<{
    actorId: string
    expectedRevision: number
  }>): Readonly<{ record: DurableTurnActorRecordV1; card: DurableTurnApprovalCardV1 }>
  admitCallback(input: Readonly<{
    actorId: string
    actionId: string
    actionHash: string
    cardId: string
    operatorId: string
    chatId: string
    sessionId: string
    turnId: string
  }>): DurableTurnCallbackAdmissionV1
  claimResume(input: Readonly<{
    actorId: string
    expectedRevision: number
    ownerHash: string
  }>): DurableTurnClaimResultV1
  reconcileClaim(input: Readonly<{
    actorId: string
    expectedRevision: number
    ownerHash: string
  }>): DurableTurnClaimResultV1
  terminalizeRejected(input: Readonly<{
    actorId: string
    expectedRevision: number
  }>): DurableTurnActorRecordV1
  requestCancel(input: Readonly<{
    actorId: string
    expectedRevision: number
  }>): DurableTurnActorRecordV1
  finishWithPermit(input: Readonly<{
    permit: DurableTurnResumePermitV1
    terminal: Omit<DurableTurnTerminalV1, 'atMs'>
  }>): DurableTurnActorRecordV1
  acknowledgeCancellation(input: Readonly<{
    actorId: string
    expectedRevision: number
    receiptHash: string
  }>): DurableTurnCancellationAckV1
  finishCancellation(input: Readonly<{
    acknowledgement: DurableTurnCancellationAckV1
    code: string
  }>): DurableTurnActorRecordV1
  recover(): DurableTurnRecoveryV1
}

/** Dormant approval/stop adapter for the unified supervisor recovery envelope. */
export function makeDurableTurnStartupRecoveryPortV1(
  manager: DurableTurnActorManagerV1,
): ExecutionStartupRecoveryPortV1 {
  if (typeof manager !== 'object' || manager === null || utilTypes.isProxy(manager)) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  const descriptor = Object.getOwnPropertyDescriptor(manager, 'recover')
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  const recover = descriptor.value as DurableTurnActorManagerV1['recover']
  return Object.freeze({
    async recover(
      context: ExecutionStartupRecoveryContextV1,
    ): Promise<ExecutionStartupRecoveryStepResultV1> {
      if (!isGenuineExecutionSupervisorRecoveryContextV1(context) ||
        context.schemaVersion !== 1 || !HASH.test(context.bindingHash) || !context.isHeld()) {
        return Object.freeze({ kind: 'denied', code: 'DURABLE_TURN_RECOVERY_AUTHORITY_INVALID' })
      }
      let result: DurableTurnRecoveryV1
      try { result = recover.call(manager) } catch {
        return Object.freeze({ kind: 'denied', code: 'DURABLE_TURN_RECOVERY_FAILED' })
      }
      if (result.kind === 'none') return Object.freeze({ kind: 'none' })
      if (result.record.identity.supervisorBindingHash !== context.bindingHash) {
        return Object.freeze({ kind: 'denied', code: 'DURABLE_TURN_RECOVERY_BINDING_MISMATCH' })
      }
      if (result.kind === 'authority-lost') {
        return Object.freeze({ kind: 'denied', code: 'DURABLE_TURN_RECOVERY_AUTHORITY_LOST' })
      }
      return Object.freeze({ kind: 'continuation', bindingHash: context.bindingHash })
    },
  })
}

export interface NodeDurableTurnActorControllerV1 {
  readonly manager: DurableTurnActorManagerV1
  readonly callback: DurableTurnApprovalCallbackV1
  close(): void
}

interface PermitState {
  readonly controller: object
  readonly actorId: string
  readonly revision: number
  readonly claimId: string
}

interface CallbackAdmissionState {
  readonly controller: object
  readonly actorId: string
  readonly revision: number
  readonly actionHash: string
  readonly stepUpVerified: boolean
}

interface CancellationAckState {
  readonly controller: object
  readonly actorId: string
  readonly revision: number
  readonly receiptHash: string
}

const permitStates = new WeakMap<object, PermitState>()
const consumedPermits = new WeakSet<object>()
const callbackAdmissions = new WeakMap<object, CallbackAdmissionState>()
const cancellationAcks = new WeakMap<object, CancellationAckState>()
const consumedCancellationAcks = new WeakSet<object>()

function fail(code: DurableTurnActorErrorCode): never {
  throw new DurableTurnActorError(code)
}

function sqliteCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function mapStoreError(error: unknown): DurableTurnActorError {
  if (error instanceof DurableTurnActorError) return error
  if (error instanceof PrivateSqliteLeaseError) {
    if (error.failure === 'unsafe') return new DurableTurnActorError('DURABLE_TURN_STORE_UNSAFE')
    if (error.failure === 'corrupt') return new DurableTurnActorError('DURABLE_TURN_STORE_CORRUPT')
    return new DurableTurnActorError('DURABLE_TURN_STORE_UNAVAILABLE')
  }
  const code = sqliteCode(error)
  if (code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_CORRUPT') === true ||
    code?.startsWith('SQLITE_SCHEMA') === true) {
    return new DurableTurnActorError('DURABLE_TURN_STORE_CORRUPT')
  }
  return new DurableTurnActorError('DURABLE_TURN_STORE_UNAVAILABLE')
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) fail('DURABLE_TURN_INPUT_INVALID')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail('DURABLE_TURN_INPUT_INVALID')
    }
    result[key] = descriptor.value
  }
  return result
}

function text(value: unknown, maximumBytes = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0') ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  return value
}

function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!ID.test(result)) fail('DURABLE_TURN_INPUT_INVALID')
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('DURABLE_TURN_INPUT_INVALID')
  return value
}

function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  return value
}

function sha256(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update(value, 'utf8').digest('hex')
}

function cleanBinding(value: unknown): Readonly<ResolvedWorkBinding> {
  const raw = exact(
    value,
    ['operatorId', 'profileId', 'projectId', 'sessionId', 'scope'],
    ['botId'],
  )
  if (raw['scope'] !== 'workspace' && raw['scope'] !== 'project' && raw['scope'] !== 'session') {
    fail('DURABLE_TURN_INPUT_INVALID')
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

export function durableTurnWorkBindingHash(binding: ResolvedWorkBinding): string {
  const clean = cleanBinding(binding)
  return sha256(BINDING_DOMAIN, JSON.stringify(clean))
}

function cleanBudget(value: unknown): Readonly<DurableTurnBudgetV1> {
  const raw = exact(value, [
    'iterations', 'inputTokens', 'outputTokens', 'spendNanos', 'wallMs', 'ledgerRevision',
  ])
  return Object.freeze({
    iterations: safeInteger(raw['iterations']),
    inputTokens: safeInteger(raw['inputTokens']),
    outputTokens: safeInteger(raw['outputTokens']),
    spendNanos: safeInteger(raw['spendNanos']),
    wallMs: safeInteger(raw['wallMs']),
    ledgerRevision: safeInteger(raw['ledgerRevision']),
  })
}

function cleanIdentity(value: unknown): Readonly<DurableTurnActorIdentityV1> {
  const raw = exact(value, [
    'schemaVersion', 'actorId', 'operationId', 'operationHash', 'continuationHash',
    'binding', 'workBindingHash', 'sessionId', 'turnId', 'supervisorBindingHash',
    'policyRevision', 'budget',
  ])
  if (raw['schemaVersion'] !== 1) fail('DURABLE_TURN_INPUT_INVALID')
  const binding = cleanBinding(raw['binding'])
  const workBindingHash = hash(raw['workBindingHash'])
  const sessionId = text(raw['sessionId'])
  if (sessionId !== binding.sessionId || workBindingHash !== durableTurnWorkBindingHash(binding)) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    actorId: identifier(raw['actorId']),
    operationId: identifier(raw['operationId']),
    operationHash: hash(raw['operationHash']),
    continuationHash: hash(raw['continuationHash']),
    binding,
    workBindingHash,
    sessionId,
    turnId: identifier(raw['turnId']),
    supervisorBindingHash: hash(raw['supervisorBindingHash']),
    policyRevision: identifier(raw['policyRevision']),
    budget: cleanBudget(raw['budget']),
  })
}

function cleanApproval(value: unknown): Readonly<DurableTurnApprovalV1> {
  const raw = exact(value, [
    'actionId', 'actionHash', 'cardId', 'nonceHash', 'tier', 'requiresStepUp',
    'canRememberSimilar', 'operatorId', 'chatId', 'issuedAtMs', 'expiresAtMs', 'delivery',
  ], ['messageId'])
  const hasMessageId = Object.hasOwn(raw, 'messageId')
  if (raw['tier'] !== 'tier-1' && raw['tier'] !== 'tier-2' && raw['tier'] !== 'tier-3' ||
    typeof raw['requiresStepUp'] !== 'boolean' || typeof raw['canRememberSimilar'] !== 'boolean' ||
    (raw['delivery'] !== 'pending' && raw['delivery'] !== 'delivered')) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  const issuedAtMs = safeInteger(raw['issuedAtMs'])
  const expiresAtMs = safeInteger(raw['expiresAtMs'], 1)
  if (expiresAtMs <= issuedAtMs || (raw['delivery'] === 'pending' && hasMessageId) ||
    (raw['delivery'] === 'delivered' && !hasMessageId)) fail('DURABLE_TURN_INPUT_INVALID')
  return Object.freeze({
    actionId: identifier(raw['actionId']),
    actionHash: hash(raw['actionHash']),
    cardId: identifier(raw['cardId']),
    nonceHash: hash(raw['nonceHash']),
    tier: raw['tier'],
    requiresStepUp: raw['requiresStepUp'],
    canRememberSimilar: raw['canRememberSimilar'],
    operatorId: text(raw['operatorId']),
    chatId: text(raw['chatId'], 128),
    issuedAtMs,
    expiresAtMs,
    delivery: raw['delivery'],
    ...(hasMessageId ? { messageId: identifier(raw['messageId']) } : {}),
  })
}

function cleanDecision(value: unknown): Readonly<DurableTurnDecisionV1> | null {
  if (value === null) return null
  const raw = exact(value, ['kind', 'decidedAtMs', 'stepUpVerified'])
  if ((raw['kind'] !== 'confirmed' && raw['kind'] !== 'rejected') ||
    typeof raw['stepUpVerified'] !== 'boolean') fail('DURABLE_TURN_INPUT_INVALID')
  return Object.freeze({
    kind: raw['kind'],
    decidedAtMs: safeInteger(raw['decidedAtMs']),
    stepUpVerified: raw['stepUpVerified'],
  })
}

function cleanClaim(value: unknown): Readonly<DurableTurnClaimV1> | null {
  if (value === null) return null
  const raw = exact(value, ['claimId', 'ownerHash', 'claimedAtMs'])
  return Object.freeze({
    claimId: identifier(raw['claimId']),
    ownerHash: hash(raw['ownerHash']),
    claimedAtMs: safeInteger(raw['claimedAtMs']),
  })
}

function cleanTerminal(value: unknown): Readonly<DurableTurnTerminalV1> | null {
  if (value === null) return null
  const raw = exact(value, ['kind', 'code', 'atMs'], ['receiptHash'])
  const hasReceipt = Object.hasOwn(raw, 'receiptHash')
  if (raw['kind'] !== 'completed' && raw['kind'] !== 'cancelled' &&
    raw['kind'] !== 'denied' && raw['kind'] !== 'failed') fail('DURABLE_TURN_INPUT_INVALID')
  return Object.freeze({
    kind: raw['kind'],
    code: identifier(raw['code']),
    atMs: safeInteger(raw['atMs']),
    ...(hasReceipt ? { receiptHash: hash(raw['receiptHash']) } : {}),
  })
}

function actionHash(
  identity: DurableTurnActorIdentityV1,
  approval: Pick<DurableTurnApprovalV1,
    | 'actionId'
    | 'cardId'
    | 'nonceHash'
    | 'tier'
    | 'requiresStepUp'
    | 'canRememberSimilar'
    | 'operatorId'
    | 'chatId'
    | 'issuedAtMs'
    | 'expiresAtMs'>,
): string {
  return sha256(ACTION_DOMAIN, JSON.stringify({
    actorId: identity.actorId,
    operationHash: identity.operationHash,
    continuationHash: identity.continuationHash,
    workBindingHash: identity.workBindingHash,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    supervisorBindingHash: identity.supervisorBindingHash,
    policyRevision: identity.policyRevision,
    budget: identity.budget,
    actionId: approval.actionId,
    cardId: approval.cardId,
    nonceHash: approval.nonceHash,
    tier: approval.tier,
    requiresStepUp: approval.requiresStepUp,
    canRememberSimilar: approval.canRememberSimilar,
    operatorId: approval.operatorId,
    chatId: approval.chatId,
    issuedAtMs: approval.issuedAtMs,
    expiresAtMs: approval.expiresAtMs,
  }))
}

function cleanRecord(value: unknown): DurableTurnActorRecordV1 {
  const raw = exact(value, ['schemaVersion', 'revision', 'phase', 'identity', 'approval', 'decision', 'claim', 'terminal'])
  if (raw['schemaVersion'] !== 1 || (raw['phase'] !== 'paused-awaiting-approval' &&
    raw['phase'] !== 'resume-ready' && raw['phase'] !== 'cancelling' && raw['phase'] !== 'terminal')) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  const identity = cleanIdentity(raw['identity'])
  const approval = cleanApproval(raw['approval'])
  const decision = cleanDecision(raw['decision'])
  const claim = cleanClaim(raw['claim'])
  const terminal = cleanTerminal(raw['terminal'])
  const revision = safeInteger(raw['revision'], 1)
  const expectedActionHash = actionHash(identity, {
    actionId: approval.actionId,
    cardId: approval.cardId,
    nonceHash: approval.nonceHash,
    tier: approval.tier,
    requiresStepUp: approval.requiresStepUp,
    canRememberSimilar: approval.canRememberSimilar,
    operatorId: approval.operatorId,
    chatId: approval.chatId,
    issuedAtMs: approval.issuedAtMs,
    expiresAtMs: approval.expiresAtMs,
  })
  if (approval.actionHash !== expectedActionHash ||
    (raw['phase'] === 'paused-awaiting-approval' && (decision !== null || claim !== null || terminal !== null)) ||
    (raw['phase'] === 'resume-ready' && (decision === null || terminal !== null)) ||
    (raw['phase'] === 'cancelling' && terminal !== null) ||
    (raw['phase'] === 'terminal' && terminal === null)) fail('DURABLE_TURN_INPUT_INVALID')
  if (approval.operatorId !== identity.binding.operatorId || approval.canRememberSimilar) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  if ((approval.tier === 'tier-3' && !approval.requiresStepUp) ||
    (decision?.kind === 'confirmed' && approval.requiresStepUp && !decision.stepUpVerified) ||
    (decision?.kind === 'rejected' && (decision.stepUpVerified || claim !== null))) {
    fail('DURABLE_TURN_INPUT_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    revision,
    phase: raw['phase'],
    identity,
    approval,
    decision,
    claim,
    terminal,
  })
}

function cloneRecord(record: DurableTurnActorRecordV1): DurableTurnActorRecordV1 {
  return structuredClone(record)
}

function held(control: DurableTurnOperationControlPort, identity: DurableTurnActorIdentityV1): boolean {
  try {
    return control.assertHeld(Object.freeze({
      operationId: identity.operationId,
      operationHash: identity.operationHash,
      continuationHash: identity.continuationHash,
      workBindingHash: identity.workBindingHash,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      supervisorBindingHash: identity.supervisorBindingHash,
      policyRevision: identity.policyRevision,
      budget: identity.budget,
    })) === true
  } catch { return false }
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) fail('DURABLE_TURN_STORE_UNAVAILABLE')
  return Number(uid)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function ensurePrivateDirectory(path: string, uid: number): void {
  try { mkdirSync(path, { recursive: true, mode: 0o700 }) } catch { fail('DURABLE_TURN_STORE_UNAVAILABLE') }
  let stat: Stats
  try { stat = lstatSync(path) } catch { fail('DURABLE_TURN_STORE_UNAVAILABLE') }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    fail('DURABLE_TURN_STORE_UNSAFE')
  }
}

function preparePrivateFile(path: string, uid: number): Stats {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    fchmodSync(descriptor, 0o600)
    const stat = fstatSync(descriptor)
    const current = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 || !sameIdentity(stat, current)) fail('DURABLE_TURN_STORE_UNSAFE')
    return stat
  } catch (error) {
    if (error instanceof DurableTurnActorError) throw error
    throw new DurableTurnActorError('DURABLE_TURN_STORE_UNAVAILABLE')
  } finally {
    if (descriptor !== null) try { closeSync(descriptor) } catch { /* stable result */ }
  }
}

function validateSidecars(path: string, uid: number): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const stat = lstatSync(path + suffix)
      const safeJournal = suffix === '-journal' && stat.isFile() && !stat.isSymbolicLink() &&
        stat.uid === uid && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
      if (!safeJournal) fail('DURABLE_TURN_STORE_UNSAFE')
    } catch (error) {
      if (error instanceof DurableTurnActorError) throw error
      if (nodeErrorCode(error) !== 'ENOENT') fail('DURABLE_TURN_STORE_UNAVAILABLE')
    }
  }
}

function assertPrivateFile(path: string, uid: number, expected: Stats): void {
  let current: Stats
  try { current = lstatSync(path) } catch { fail('DURABLE_TURN_STORE_UNAVAILABLE') }
  if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid || current.nlink !== 1 ||
    (current.mode & 0o777) !== 0o600 || !sameIdentity(current, expected)) {
    fail('DURABLE_TURN_STORE_UNSAFE')
  }
}

function initializeOrValidate(db: Database.Database): void {
  const applicationId = Number(db.pragma('application_id', { simple: true }))
  const userVersion = Number(db.pragma('user_version', { simple: true }))
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string; sql: string | null }>
  if (applicationId === 0 && userVersion === 0 && objects.length === 0) {
    db.pragma('application_id = ' + APPLICATION_ID)
    db.pragma('user_version = ' + SCHEMA_VERSION)
    db.exec(ACTOR_SCHEMA)
    return
  }
  if (applicationId !== APPLICATION_ID || userVersion !== SCHEMA_VERSION ||
    String(db.pragma('quick_check', { simple: true })) !== 'ok') fail('DURABLE_TURN_STORE_CORRUPT')
  if (objects.length !== 1) fail('DURABLE_TURN_STORE_CORRUPT')
  const table = objects.find(object => object.type === 'table' && object.name === 'durable_turn_actors')
  if (table?.sql === null || table?.sql === undefined ||
    table.sql.replace(/\s+/g, ' ').trim() !== ACTOR_SCHEMA.replace(/\s+/g, ' ').trim()) {
    fail('DURABLE_TURN_STORE_CORRUPT')
  }
}

function mintedId(prefix: string): string {
  return prefix + '-' + randomBytes(16).toString('hex')
}

export function makeNodeDurableTurnActorController(input: {
  readonly path: string
  readonly operationControl: DurableTurnOperationControlPort
  readonly callbackAdmission: DurableTurnCallbackAdmissionPort
  readonly cancellationControl: DurableTurnCancellationControlPort
  readonly claimReconciliation: DurableTurnClaimReconciliationControlPort
  readonly nowMs?: () => number
  readonly newActorId?: () => string
  readonly newCardId?: () => string
  readonly newNonce?: () => string
  readonly newClaimId?: () => string
}): NodeDurableTurnActorControllerV1 {
  if (!isAbsolute(input.path) || !FILENAME.test(basename(input.path)) ||
    basename(input.path) === LEASE_PROFILE.filename) fail('DURABLE_TURN_INPUT_INVALID')
  const path = resolve(input.path)
  const root = dirname(path)
  const uid = currentUid()
  ensurePrivateDirectory(root, uid)
  let lease: PrivateSqliteLease
  try { lease = acquirePrivateSqliteLease({ root, profile: LEASE_PROFILE }) } catch (error) {
    throw mapStoreError(error)
  }
  let expectedIdentity: Stats
  try {
    validateSidecars(path, uid)
    expectedIdentity = preparePrivateFile(path, uid)
  } catch (error) {
    lease.release()
    throw error
  }
  let database: Database.Database | null = null
  try {
    validateSidecars(path, uid)
    database = new Database(path, { timeout: 0 })
    database.pragma('busy_timeout = 0')
    database.pragma('journal_mode = DELETE')
    database.pragma('synchronous = FULL')
    database.pragma('trusted_schema = OFF')
    initializeOrValidate(database)
    assertPrivateFile(path, uid, expectedIdentity)
    validateSidecars(path, uid)
    if (database.pragma('journal_mode', { simple: true }) !== 'delete' ||
      Number(database.pragma('busy_timeout', { simple: true })) !== 0 ||
      Number(database.pragma('synchronous', { simple: true })) !== 2 ||
      Number(database.pragma('trusted_schema', { simple: true })) !== 0) {
      fail('DURABLE_TURN_STORE_CORRUPT')
    }
  } catch (error) {
    try { database?.close() } catch { /* preserve error */ }
    lease.release()
    throw mapStoreError(error)
  }
  const db = database
  const controller = Object.freeze({})
  const nowMs = input.nowMs ?? (() => Date.now())
  const newActorId = input.newActorId ?? (() => mintedId('actor'))
  const newCardId = input.newCardId ?? (() => mintedId('card'))
  const newNonce = input.newNonce ?? (() => randomBytes(32).toString('base64url'))
  const newClaimId = input.newClaimId ?? (() => mintedId('claim'))
  let closed = false

  type Row = {
    actor_id: string
    session_id: string
    phase: string
    revision: number
    active_slot: number | null
    record_json: string
    record_hash: string
  }

  const loadActiveStatement = db.prepare('SELECT actor_id, session_id, phase, revision, active_slot, record_json, record_hash FROM durable_turn_actors WHERE active_slot = 1')
  const loadActorStatement = db.prepare('SELECT actor_id, session_id, phase, revision, active_slot, record_json, record_hash FROM durable_turn_actors WHERE actor_id = ?')
  const insertStatement = db.prepare('INSERT INTO durable_turn_actors (actor_id, session_id, phase, revision, active_slot, record_json, record_hash) VALUES (?, ?, ?, ?, 1, ?, ?)')
  const updateStatement = db.prepare('UPDATE durable_turn_actors SET phase = ?, revision = ?, active_slot = ?, record_json = ?, record_hash = ? WHERE actor_id = ? AND revision = ? AND phase = ? AND active_slot = 1')

  const guard = (): void => {
    if (closed || !db.open) fail('DURABLE_TURN_STORE_CLOSED')
    try { lease.assertHeld() } catch (error) { throw mapStoreError(error) }
    assertPrivateFile(path, uid, expectedIdentity)
    validateSidecars(path, uid)
    initializeOrValidate(db)
  }
  const parseRow = (row: Row | undefined): DurableTurnActorRecordV1 | null => {
    if (row === undefined) return null
    let parsed: unknown
    try { parsed = JSON.parse(row.record_json) as unknown } catch { fail('DURABLE_TURN_STORE_CORRUPT') }
    let record: DurableTurnActorRecordV1
    try { record = cleanRecord(parsed) } catch { fail('DURABLE_TURN_STORE_CORRUPT') }
    const canonical = JSON.stringify(record)
    if (canonical !== row.record_json || row.record_hash !== sha256(ACTOR_DOMAIN, canonical) ||
      row.actor_id !== record.identity.actorId || row.session_id !== record.identity.sessionId ||
      row.phase !== record.phase || row.revision !== record.revision ||
      row.active_slot !== (record.phase === 'terminal' ? null : 1)) fail('DURABLE_TURN_STORE_CORRUPT')
    return record
  }
  const loadActive = (): DurableTurnActorRecordV1 | null => {
    guard()
    return parseRow(loadActiveStatement.get() as Row | undefined)
  }
  const loadActor = (actorId: unknown): DurableTurnActorRecordV1 | null => {
    guard()
    return parseRow(loadActorStatement.get(identifier(actorId)) as Row | undefined)
  }
  const persistInsert = (record: DurableTurnActorRecordV1): boolean => {
    const clean = cleanRecord(record)
    const json = JSON.stringify(clean)
    try {
      return insertStatement.run(
        clean.identity.actorId, clean.identity.sessionId, clean.phase, clean.revision,
        json, sha256(ACTOR_DOMAIN, json),
      ).changes === 1
    } catch (error) {
      if (sqliteCode(error)?.startsWith('SQLITE_CONSTRAINT') === true) return false
      throw mapStoreError(error)
    }
  }
  const persistCas = (before: DurableTurnActorRecordV1, candidate: DurableTurnActorRecordV1): boolean => {
    const next = cleanRecord(candidate)
    if (next.revision !== before.revision + 1 ||
      JSON.stringify(next.identity) !== JSON.stringify(before.identity)) fail('DURABLE_TURN_TRANSITION_DENIED')
    const json = JSON.stringify(next)
    try {
      return updateStatement.run(
        next.phase, next.revision, next.phase === 'terminal' ? null : 1,
        json, sha256(ACTOR_DOMAIN, json), next.identity.actorId, before.revision, before.phase,
      ).changes === 1
    } catch (error) { throw mapStoreError(error) }
  }
  const assertAuthority = (record: DurableTurnActorRecordV1): void => {
    if (!held(input.operationControl, record.identity)) fail('DURABLE_TURN_AUTHORITY_LOST')
  }
  const currentTime = (record?: DurableTurnActorRecordV1): number => {
    const current = safeInteger(nowMs())
    if (record !== undefined) {
      const floor = Math.max(
        record.approval.issuedAtMs,
        record.decision?.decidedAtMs ?? 0,
        record.claim?.claimedAtMs ?? 0,
        record.terminal?.atMs ?? 0,
      )
      if (current < floor) fail('DURABLE_TURN_TRANSITION_DENIED')
    }
    return current
  }
  const approvalCard = (record: DurableTurnActorRecordV1, nonce: string): DurableTurnApprovalCardV1 => Object.freeze({
    actorId: record.identity.actorId,
    revision: record.revision,
    actionId: record.approval.actionId,
    actionHash: record.approval.actionHash,
    cardId: record.approval.cardId,
    operatorId: record.approval.operatorId,
    chatId: record.approval.chatId,
    nonce,
    expiresAtMs: record.approval.expiresAtMs,
  })
  const admissionForSession = (sessionIdValue: string): DurableTurnAdmissionV1 => {
    const sessionId = text(sessionIdValue)
    const active = loadActive()
    if (active === null) return Object.freeze({ kind: 'free' })
    if (active.identity.sessionId === sessionId) {
      return Object.freeze({ kind: 'busy-session', actorId: active.identity.actorId })
    }
    return Object.freeze({
      kind: 'busy-installation', actorId: active.identity.actorId, sessionId: active.identity.sessionId,
    })
  }

  const manager: DurableTurnActorManagerV1 = Object.freeze({
    admission(sessionIdValue: string) {
      return admissionForSession(sessionIdValue)
    },
    pause(pauseInput: DurableTurnPauseInputV1) {
      const raw = exact(pauseInput, ['identity', 'approval'])
      const identityInput = exact(raw['identity'], [
        'operationId', 'operationHash', 'continuationHash', 'binding', 'workBindingHash',
        'sessionId', 'turnId', 'supervisorBindingHash', 'policyRevision', 'budget',
      ])
      const approvalInput = exact(raw['approval'], [
        'actionId', 'tier', 'requiresStepUp', 'canRememberSimilar', 'chatId', 'expiresAtMs',
      ])
      const actorId = identifier(newActorId())
      const cardId = identifier(newCardId())
      const nonce = text(newNonce(), 512)
      const issuedAtMs = currentTime()
      const expiresAtMs = safeInteger(approvalInput['expiresAtMs'], 1)
      if (expiresAtMs <= issuedAtMs || (approvalInput['tier'] !== 'tier-1' &&
        approvalInput['tier'] !== 'tier-2' && approvalInput['tier'] !== 'tier-3') ||
        typeof approvalInput['requiresStepUp'] !== 'boolean' ||
        approvalInput['canRememberSimilar'] !== false ||
        (approvalInput['tier'] === 'tier-3' && approvalInput['requiresStepUp'] !== true)) {
        fail('DURABLE_TURN_INPUT_INVALID')
      }
      const identity = cleanIdentity({ schemaVersion: 1, actorId, ...identityInput })
      if (!held(input.operationControl, identity)) fail('DURABLE_TURN_AUTHORITY_LOST')
      const tier = approvalInput['tier'] as DurableTurnApprovalTier
      const approvalWithoutHash: Omit<DurableTurnApprovalV1, 'actionHash'> = {
        actionId: identifier(approvalInput['actionId']),
        cardId,
        nonceHash: sha256(NONCE_DOMAIN, nonce),
        tier,
        requiresStepUp: approvalInput['requiresStepUp'],
        canRememberSimilar: approvalInput['canRememberSimilar'],
        operatorId: identity.binding.operatorId,
        chatId: text(approvalInput['chatId'], 128),
        issuedAtMs,
        expiresAtMs,
        delivery: 'pending' as const,
      }
      const record = cleanRecord({
        schemaVersion: 1,
        revision: 1,
        phase: 'paused-awaiting-approval',
        identity,
        approval: { ...approvalWithoutHash, actionHash: actionHash(identity, approvalWithoutHash) },
        decision: null,
        claim: null,
        terminal: null,
      })
      if (!persistInsert(record)) {
        const admission = admissionForSession(identity.sessionId)
        if (admission.kind === 'free') fail('DURABLE_TURN_TRANSITION_DENIED')
        return admission
      }
      return Object.freeze({ kind: 'paused', record: cloneRecord(record), card: approvalCard(record, nonce) })
    },
    markCardDelivered(deliveryInput: Parameters<DurableTurnActorManagerV1['markCardDelivered']>[0]) {
      const raw = exact(deliveryInput, ['actorId', 'expectedRevision', 'messageId'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'paused-awaiting-approval' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1) || record.approval.delivery !== 'pending') {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const approvalWithoutHash = {
        ...record.approval,
        delivery: 'delivered' as const,
        messageId: identifier(raw['messageId']),
      }
      const next = cleanRecord({
        ...record,
        revision: record.revision + 1,
        approval: { ...approvalWithoutHash, actionHash: actionHash(record.identity, approvalWithoutHash) },
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    rotatePendingCard(rotationInput: Parameters<DurableTurnActorManagerV1['rotatePendingCard']>[0]) {
      const raw = exact(rotationInput, ['actorId', 'expectedRevision'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'paused-awaiting-approval' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1) || record.approval.delivery !== 'pending') {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const nonce = text(newNonce(), 512)
      const approvalWithoutHash = {
        actionId: record.approval.actionId,
        cardId: identifier(newCardId()),
        nonceHash: sha256(NONCE_DOMAIN, nonce),
        tier: record.approval.tier,
        requiresStepUp: record.approval.requiresStepUp,
        canRememberSimilar: record.approval.canRememberSimilar,
        operatorId: record.approval.operatorId,
        chatId: record.approval.chatId,
        issuedAtMs: currentTime(record),
        expiresAtMs: record.approval.expiresAtMs,
        delivery: 'pending' as const,
      }
      if (approvalWithoutHash.issuedAtMs >= approvalWithoutHash.expiresAtMs) fail('DURABLE_TURN_TRANSITION_DENIED')
      const next = cleanRecord({
        ...record,
        revision: record.revision + 1,
        approval: { ...approvalWithoutHash, actionHash: actionHash(record.identity, approvalWithoutHash) },
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      return Object.freeze({ record: cloneRecord(next), card: approvalCard(next, nonce) })
    },
    replaceCardAfterRecovery(
      rotationInput: Parameters<DurableTurnActorManagerV1['replaceCardAfterRecovery']>[0],
    ) {
      const raw = exact(rotationInput, ['actorId', 'expectedRevision'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'paused-awaiting-approval' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1)) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const nonce = text(newNonce(), 512)
      const approvalWithoutHash = {
        actionId: record.approval.actionId,
        cardId: identifier(newCardId()),
        nonceHash: sha256(NONCE_DOMAIN, nonce),
        tier: record.approval.tier,
        requiresStepUp: record.approval.requiresStepUp,
        canRememberSimilar: record.approval.canRememberSimilar,
        operatorId: record.approval.operatorId,
        chatId: record.approval.chatId,
        issuedAtMs: currentTime(record),
        expiresAtMs: record.approval.expiresAtMs,
        delivery: 'pending' as const,
      }
      if (approvalWithoutHash.issuedAtMs >= approvalWithoutHash.expiresAtMs) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      const next = cleanRecord({
        ...record,
        revision: record.revision + 1,
        approval: { ...approvalWithoutHash, actionHash: actionHash(record.identity, approvalWithoutHash) },
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      return Object.freeze({ record: cloneRecord(next), card: approvalCard(next, nonce) })
    },
    admitCallback(admissionInput: Parameters<DurableTurnActorManagerV1['admitCallback']>[0]) {
      const raw = exact(admissionInput, [
        'actorId', 'actionId', 'actionHash', 'cardId', 'operatorId', 'chatId', 'sessionId', 'turnId',
      ])
      const record = loadActor(raw['actorId'])
      if (record === null || (record.phase !== 'paused-awaiting-approval' &&
        record.phase !== 'resume-ready') ||
        record.approval.delivery !== 'delivered' ||
        record.approval.actionId !== identifier(raw['actionId']) ||
        record.approval.actionHash !== hash(raw['actionHash']) ||
        record.approval.cardId !== identifier(raw['cardId']) ||
        record.approval.operatorId !== text(raw['operatorId']) ||
        record.approval.chatId !== text(raw['chatId'], 128) ||
        record.identity.sessionId !== text(raw['sessionId']) ||
        record.identity.turnId !== identifier(raw['turnId'])) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      let admitted: false | 'admitted' | 'step-up-admitted'
      try {
        admitted = input.callbackAdmission.assertAdmitted(Object.freeze({
          actorId: record.identity.actorId,
          actionId: record.approval.actionId,
          actionHash: record.approval.actionHash,
          cardId: record.approval.cardId,
          operatorId: record.approval.operatorId,
          chatId: record.approval.chatId,
          sessionId: record.identity.sessionId,
          turnId: record.identity.turnId,
        }))
      } catch { admitted = false }
      if (admitted !== 'admitted' && admitted !== 'step-up-admitted') {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      const admission = Object.freeze({
        [callbackAdmissionBrand]: true as const,
        kind: 'durable-turn-callback-admission-v1' as const,
      })
      callbackAdmissions.set(admission, Object.freeze({
        controller,
        actorId: record.identity.actorId,
        revision: record.revision,
        actionHash: record.approval.actionHash,
        stepUpVerified: admitted === 'step-up-admitted',
      }))
      return admission
    },
    claimResume(claimInput: Parameters<DurableTurnActorManagerV1['claimResume']>[0]) {
      const raw = exact(claimInput, ['actorId', 'expectedRevision', 'ownerHash'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'resume-ready' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1)) fail('DURABLE_TURN_TRANSITION_DENIED')
      assertAuthority(record)
      if (record.decision?.kind !== 'confirmed') fail('DURABLE_TURN_TRANSITION_DENIED')
      if (record.claim !== null) {
        return Object.freeze({ kind: 'reconciliation-required', record: cloneRecord(record) })
      }
      const claim: DurableTurnClaimV1 = Object.freeze({
        claimId: identifier(newClaimId()),
        ownerHash: hash(raw['ownerHash']),
        claimedAtMs: currentTime(record),
      })
      const next = cleanRecord({ ...record, revision: record.revision + 1, claim })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      const permit = Object.freeze({ kind: 'durable-turn-resume-permit-v1' }) as DurableTurnResumePermitV1
      permitStates.set(permit, {
        controller, actorId: next.identity.actorId, revision: next.revision, claimId: claim.claimId,
      })
      return Object.freeze({ kind: 'claimed', record: cloneRecord(next), permit })
    },
    reconcileClaim(reconcileInput: Parameters<DurableTurnActorManagerV1['reconcileClaim']>[0]) {
      const raw = exact(reconcileInput, ['actorId', 'expectedRevision', 'ownerHash'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'resume-ready' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1) ||
        record.decision?.kind !== 'confirmed' || record.claim === null) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const ownerHash = hash(raw['ownerHash'])
      let replaySafe = false
      try {
        replaySafe = input.claimReconciliation.assertReplaySafe(Object.freeze({
          actorId: record.identity.actorId,
          revision: record.revision,
          operationId: record.identity.operationId,
          operationHash: record.identity.operationHash,
          continuationHash: record.identity.continuationHash,
          workBindingHash: record.identity.workBindingHash,
          sessionId: record.identity.sessionId,
          turnId: record.identity.turnId,
          supervisorBindingHash: record.identity.supervisorBindingHash,
          policyRevision: record.identity.policyRevision,
          budget: record.identity.budget,
          priorClaim: record.claim,
          newOwnerHash: ownerHash,
        })) === true
      } catch { replaySafe = false }
      if (!replaySafe) fail('DURABLE_TURN_TRANSITION_DENIED')
      const claim: DurableTurnClaimV1 = Object.freeze({
        claimId: identifier(newClaimId()),
        ownerHash,
        claimedAtMs: currentTime(record),
      })
      const next = cleanRecord({ ...record, revision: record.revision + 1, claim })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      const permit = Object.freeze({ kind: 'durable-turn-resume-permit-v1' }) as DurableTurnResumePermitV1
      permitStates.set(permit, {
        controller, actorId: next.identity.actorId, revision: next.revision, claimId: claim.claimId,
      })
      return Object.freeze({ kind: 'claimed', record: cloneRecord(next), permit })
    },
    terminalizeRejected(rejectionInput: Parameters<DurableTurnActorManagerV1['terminalizeRejected']>[0]) {
      const raw = exact(rejectionInput, ['actorId', 'expectedRevision'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'resume-ready' || record.claim !== null ||
        record.decision?.kind !== 'rejected' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1)) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const terminal = cleanTerminal({
        kind: 'denied', code: 'APPROVAL_REJECTED', atMs: currentTime(record),
      })
      const next = cleanRecord({
        ...record, revision: record.revision + 1, phase: 'terminal', terminal,
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    requestCancel(cancelInput: Parameters<DurableTurnActorManagerV1['requestCancel']>[0]) {
      const raw = exact(cancelInput, ['actorId', 'expectedRevision'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.revision !== safeInteger(raw['expectedRevision'], 1) ||
        record.phase === 'terminal') fail('DURABLE_TURN_TRANSITION_DENIED')
      assertAuthority(record)
      if (record.phase === 'cancelling') return cloneRecord(record)
      const next = cleanRecord({ ...record, revision: record.revision + 1, phase: 'cancelling' })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      return cloneRecord(next)
    },
    finishWithPermit(finishInput: Parameters<DurableTurnActorManagerV1['finishWithPermit']>[0]) {
      const raw = exact(finishInput, ['permit', 'terminal'])
      const permit = raw['permit'] as object
      const state = permitStates.get(permit)
      if (state === undefined || state.controller !== controller || consumedPermits.has(permit)) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      const record = loadActor(state.actorId)
      if (record === null || record.phase !== 'resume-ready' || record.revision !== state.revision ||
        record.claim?.claimId !== state.claimId) fail('DURABLE_TURN_TRANSITION_DENIED')
      assertAuthority(record)
      const terminalInput = exact(raw['terminal'], ['kind', 'code'], ['receiptHash'])
      if (terminalInput['kind'] === 'cancelled') fail('DURABLE_TURN_TRANSITION_DENIED')
      const terminal = cleanTerminal({ ...terminalInput, atMs: currentTime(record) })
      const next = cleanRecord({
        ...record, revision: record.revision + 1, phase: 'terminal', terminal,
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      consumedPermits.add(permit)
      return cloneRecord(next)
    },
    acknowledgeCancellation(ackInput: Parameters<DurableTurnActorManagerV1['acknowledgeCancellation']>[0]) {
      const raw = exact(ackInput, ['actorId', 'expectedRevision', 'receiptHash'])
      const record = loadActor(raw['actorId'])
      if (record === null || record.phase !== 'cancelling' ||
        record.revision !== safeInteger(raw['expectedRevision'], 1)) fail('DURABLE_TURN_TRANSITION_DENIED')
      assertAuthority(record)
      const receiptHash = hash(raw['receiptHash'])
      let quiesced = false
      try {
        quiesced = input.cancellationControl.assertQuiesced(Object.freeze({
          actorId: record.identity.actorId,
          revision: record.revision,
          operationId: record.identity.operationId,
          operationHash: record.identity.operationHash,
          continuationHash: record.identity.continuationHash,
          workBindingHash: record.identity.workBindingHash,
          sessionId: record.identity.sessionId,
          turnId: record.identity.turnId,
          supervisorBindingHash: record.identity.supervisorBindingHash,
          policyRevision: record.identity.policyRevision,
          budget: record.identity.budget,
          receiptHash,
        })) === true
      } catch { quiesced = false }
      if (!quiesced) fail('DURABLE_TURN_TRANSITION_DENIED')
      const acknowledgement = Object.freeze({
        [cancellationAckBrand]: true as const,
        kind: 'durable-turn-cancellation-ack-v1' as const,
      })
      cancellationAcks.set(acknowledgement, Object.freeze({
        controller, actorId: record.identity.actorId, revision: record.revision, receiptHash,
      }))
      return acknowledgement
    },
    finishCancellation(finishInput: Parameters<DurableTurnActorManagerV1['finishCancellation']>[0]) {
      const raw = exact(finishInput, ['acknowledgement', 'code'])
      const acknowledgement = raw['acknowledgement'] as object
      const state = cancellationAcks.get(acknowledgement)
      if (state === undefined || state.controller !== controller ||
        consumedCancellationAcks.has(acknowledgement)) fail('DURABLE_TURN_TRANSITION_DENIED')
      const record = loadActor(state.actorId)
      if (record === null || record.phase !== 'cancelling' || record.revision !== state.revision) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      assertAuthority(record)
      const terminal = cleanTerminal({
        kind: 'cancelled', code: identifier(raw['code']), atMs: currentTime(record),
        receiptHash: state.receiptHash,
      })
      const next = cleanRecord({
        ...record, revision: record.revision + 1, phase: 'terminal', terminal,
      })
      if (!persistCas(record, next)) fail('DURABLE_TURN_TRANSITION_DENIED')
      consumedCancellationAcks.add(acknowledgement)
      return cloneRecord(next)
    },
    recover() {
      const record = loadActive()
      if (record === null) return Object.freeze({ kind: 'none' })
      if (!held(input.operationControl, record.identity)) {
        return Object.freeze({ kind: 'authority-lost', record: cloneRecord(record) })
      }
      if (record.phase === 'paused-awaiting-approval') {
        return Object.freeze({
          kind: record.approval.delivery === 'pending' ? 'replace-card-required' : 'awaiting-decision',
          record: cloneRecord(record),
        }) as DurableTurnRecoveryV1
      }
      if (record.phase === 'resume-ready') {
        return Object.freeze({
          kind: record.decision?.kind === 'rejected' ? 'rejection-ready' :
            record.claim === null ? 'resume-ready' : 'reconciliation-required',
          record: cloneRecord(record),
        }) as DurableTurnRecoveryV1
      }
      return Object.freeze({ kind: 'continue-cancelling', record: cloneRecord(record) })
    },
  })

  const callback: DurableTurnApprovalCallbackV1 = Object.freeze({
    recordDecision(decisionInput: Parameters<DurableTurnApprovalCallbackV1['recordDecision']>[0]) {
      const raw = exact(decisionInput, ['admission', 'nonce', 'decision'])
      const admission = raw['admission'] as object
      const admitted = callbackAdmissions.get(admission)
      if (admitted === undefined || admitted.controller !== controller) {
        fail('DURABLE_TURN_TRANSITION_DENIED')
      }
      const record = loadActor(admitted.actorId)
      if (record === null) return Object.freeze({ kind: 'stale' })
      if (record.phase === 'cancelling') return Object.freeze({ kind: 'cancelled' })
      if (record.phase === 'terminal') {
        return Object.freeze({
          kind: record.terminal?.code === 'APPROVAL_EXPIRED' ? 'expired' : 'cancelled',
        })
      }
      const exactTap = record.approval.actionHash === admitted.actionHash &&
        record.approval.nonceHash === sha256(NONCE_DOMAIN, text(raw['nonce'], 512))
      if (!exactTap) return Object.freeze({ kind: 'stale' })
      if (record.phase === 'resume-ready') {
        const recordedDecision = record.decision
        const sameDecision = recordedDecision !== null && recordedDecision.kind === raw['decision'] &&
          recordedDecision.stepUpVerified ===
            (raw['decision'] === 'confirmed' && admitted.stepUpVerified)
        return sameDecision
          ? Object.freeze({ kind: 'replayed', record: cloneRecord(record) })
          : Object.freeze({ kind: 'stale' })
      }
      if (record.revision !== admitted.revision) return Object.freeze({ kind: 'stale' })
      assertAuthority(record)
      const atMs = currentTime(record)
      if (record.approval.delivery !== 'delivered') return Object.freeze({ kind: 'stale' })
      if (atMs >= record.approval.expiresAtMs) {
        const terminal = cleanTerminal({
          kind: 'denied', code: 'APPROVAL_EXPIRED', atMs,
        })
        const next = cleanRecord({
          ...record, revision: record.revision + 1, phase: 'terminal', terminal,
        })
        if (!persistCas(record, next)) {
          const winner = loadActor(admitted.actorId)
          if (winner?.phase === 'terminal' && winner.terminal?.code === 'APPROVAL_EXPIRED') {
            return Object.freeze({ kind: 'expired' })
          }
          return Object.freeze({ kind: winner?.phase === 'cancelling' ? 'cancelled' : 'stale' })
        }
        return Object.freeze({ kind: 'expired' })
      }
      if (raw['decision'] !== 'confirmed' && raw['decision'] !== 'rejected') {
        fail('DURABLE_TURN_INPUT_INVALID')
      }
      if (record.approval.requiresStepUp && raw['decision'] === 'confirmed' &&
        !admitted.stepUpVerified) fail('DURABLE_TURN_TRANSITION_DENIED')
      const decision = cleanDecision({
        kind: raw['decision'],
        decidedAtMs: atMs,
        stepUpVerified: raw['decision'] === 'confirmed' && admitted.stepUpVerified,
      })
      const next = cleanRecord({
        ...record, revision: record.revision + 1, phase: 'resume-ready', decision,
      })
      if (!persistCas(record, next)) {
        const winner = loadActor(admitted.actorId)
        if (winner?.phase === 'resume-ready' && exactTap &&
          winner.decision?.kind === raw['decision'] &&
          winner.decision.stepUpVerified ===
            (raw['decision'] === 'confirmed' && admitted.stepUpVerified)) {
          return Object.freeze({ kind: 'replayed', record: cloneRecord(winner) })
        }
        return Object.freeze({ kind: winner?.phase === 'cancelling' ? 'cancelled' : 'stale' })
      }
      return Object.freeze({ kind: 'recorded', record: cloneRecord(next) })
    },
  })

  return Object.freeze({
    manager,
    callback,
    close() {
      if (closed) return
      closed = true
      try { db.close() } finally { lease.release() }
    },
  })
}

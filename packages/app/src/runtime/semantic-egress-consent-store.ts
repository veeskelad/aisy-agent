import { timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import {
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
  semanticEgressBindingHash,
  semanticEgressConsentActionHash,
  semanticEgressOutboxEventId,
  semanticEgressRecoveryEventId,
  semanticEgressRequestEventId,
  semanticDescriptorId,
  type SemanticEgressConsentBinding,
  type SemanticEgressConsentNonceRecord,
  type SemanticEgressConsentRecordV1,
  type SemanticEgressConsentSlot,
  type SemanticEgressBootRecoveryV1,
  type SemanticEgressDurableStore,
  type SemanticEgressDurableUseStartV1,
  type SemanticEgressDurableTransitionResult,
  type SemanticEgressDurableTransitionV1,
  type SemanticEgressNonceMutationV1,
  type SemanticEgressOutboxEventV1,
} from '@aisy/core'
import Database from 'better-sqlite3'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseProfile,
} from '../private-sqlite-lease.js'

const APPLICATION_ID = 0x41535943 // ASYC
const SCHEMA_VERSION = 1
const LEASE_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'semantic-egress-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const LEASE_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'semantic-egress-writer',
  filename: 'semantic-egress-writer-lease.sqlite3',
  applicationId: 0x4153594c, // ASYL
  userVersion: 1,
  exactSchemaSql: LEASE_SCHEMA,
}
const PURPOSE = 'memory.semantic-embedding.v1'
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ACTIVE_STATES = new Set(['CONSENTED', 'ACTIVE', 'DEGRADED', 'SUSPENDED'])
const ALL_STATES = new Set([
  'AWAITING_CONSENT', ...ACTIVE_STATES, 'REVOKING', 'REVOKED', 'BLOCKED',
])
const OUTBOX_KINDS = new Set([
  'memory.semantic_egress.disclosure_issued',
  'memory.semantic_egress.consent_granted',
  'memory.semantic_egress.activated',
  'memory.semantic_egress.degraded',
  'memory.semantic_egress.suspended',
  'memory.semantic_egress.stale',
  'memory.semantic_egress.revoke_started',
  'memory.semantic_egress.purge_completed',
  'memory.semantic_egress.revoked',
  'memory.semantic_egress.blocked',
  'memory.semantic_egress.request_started',
  'memory.semantic_egress.request_completed',
])

const CONSENT_SCHEMA = `CREATE TABLE semantic_egress_consents (
  operator_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = '${PURPOSE}'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('AWAITING_CONSENT','CONSENTED','ACTIVE','DEGRADED','SUSPENDED','REVOKING','REVOKED','BLOCKED')),
  record_json TEXT NOT NULL,
  PRIMARY KEY (operator_id, profile_id, purpose)
) STRICT, WITHOUT ROWID`

const NONCE_SCHEMA = `CREATE TABLE semantic_egress_nonces (
  nonce_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('grant','use')),
  binding_hash TEXT NOT NULL CHECK (length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  invalidated_at TEXT,
  CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
) STRICT, WITHOUT ROWID`

const OUTBOX_SCHEMA = `CREATE TABLE semantic_egress_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (kind IN ('memory.semantic_egress.disclosure_issued','memory.semantic_egress.consent_granted','memory.semantic_egress.activated','memory.semantic_egress.degraded','memory.semantic_egress.suspended','memory.semantic_egress.stale','memory.semantic_egress.revoke_started','memory.semantic_egress.purge_completed','memory.semantic_egress.revoked','memory.semantic_egress.blocked','memory.semantic_egress.request_started','memory.semantic_egress.request_completed')),
  event_class TEXT NOT NULL CHECK (event_class IN ('lifecycle','request','recovery')),
  anchor_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  acked INTEGER NOT NULL CHECK (acked IN (0,1))
) STRICT`

export type SemanticEgressConsentSqliteStoreErrorCode =
  | 'INVALID_INPUT'
  | 'UNSAFE_PATH'
  | 'CORRUPT_STORE'
  | 'FUTURE_SCHEMA'
  | 'NONCE_CONFLICT'
  | 'STORE_CLOSED'
  | 'STORE_UNAVAILABLE'

export class SemanticEgressConsentSqliteStoreError extends Error {
  constructor(public readonly code: SemanticEgressConsentSqliteStoreErrorCode) {
    super(code)
    this.name = 'SemanticEgressConsentSqliteStoreError'
  }
}

export interface NodeSemanticEgressConsentStore {
  readonly durable: SemanticEgressDurableStore
  close(): void
}

function sqliteCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function unavailable(error: unknown): SemanticEgressConsentSqliteStoreError {
  if (error instanceof SemanticEgressConsentSqliteStoreError) return error
  const code = sqliteCode(error)
  if (code === 'SQLITE_NOTADB' || code?.startsWith('SQLITE_CORRUPT') === true ||
    code?.startsWith('SQLITE_SCHEMA') === true) {
    return new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
  }
  return new SemanticEgressConsentSqliteStoreError('STORE_UNAVAILABLE')
}

function leaseFailure(error: unknown): SemanticEgressConsentSqliteStoreError {
  if (!(error instanceof PrivateSqliteLeaseError)) return unavailable(error)
  if (error.failure === 'unsafe') {
    return new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  if (error.failure === 'corrupt') {
    return new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
  }
  return new SemanticEgressConsentSqliteStoreError('STORE_UNAVAILABLE')
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string')) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
    const actual = Object.keys(descriptors)
    const expected = new Set(keys)
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key)) ||
      actual.some((key) => {
        const descriptor = descriptors[key]
        return descriptor === undefined || !('value' in descriptor)
      })) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    const result = Object.create(null) as Record<string, unknown>
    for (const key of actual) result[key] = descriptors[key]!.value
    return result
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
}

function text(value: unknown, maxBytes = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > maxBytes || [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  return value
}

function identifier(value: unknown): string {
  const result = text(value, 128)
  if (!ID.test(result)) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return value
}

function exactDataClasses(value: unknown): readonly ['query', 'chunks'] {
  try {
    if (!Array.isArray(value)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 3 || keys[0] !== '0' || keys[1] !== '1' || keys[2] !== 'length') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const zero = Object.getOwnPropertyDescriptor(value, '0')
    const one = Object.getOwnPropertyDescriptor(value, '1')
    if (zero === undefined || one === undefined || !Object.hasOwn(zero, 'value') ||
      !Object.hasOwn(one, 'value') || zero.value !== 'query' || one.value !== 'chunks') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    return Object.freeze(['query', 'chunks'] as const)
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return value
}

function iso(value: unknown): string {
  if (typeof value !== 'string') throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return value
}

function cleanSlot(value: unknown): SemanticEgressConsentSlot {
  const raw = exact(value, ['operatorId', 'profileId', 'purpose'])
  if (raw['purpose'] !== PURPOSE) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  return Object.freeze({
    operatorId: text(raw['operatorId']),
    profileId: text(raw['profileId']),
    purpose: PURPOSE,
  })
}

function cleanDescriptor(value: unknown): SemanticEgressConsentBinding['descriptor'] {
  const raw = exact(value, [
    'provider', 'modelId', 'modelRevision', 'dimensions',
    'normalizationVersion', 'chunkerVersion',
  ])
  if (raw['provider'] !== 'openrouter' || typeof raw['dimensions'] !== 'number' ||
    !Number.isSafeInteger(raw['dimensions']) || raw['dimensions'] < 1 || raw['dimensions'] > 65_536) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    provider: 'openrouter',
    modelId: text(raw['modelId'], 512),
    modelRevision: text(raw['modelRevision'], 512),
    dimensions: raw['dimensions'],
    normalizationVersion: text(raw['normalizationVersion'], 512),
    chunkerVersion: text(raw['chunkerVersion'], 512),
  })
}

function cleanBinding(value: unknown): SemanticEgressConsentBinding {
  const raw = exact(value, [
    'operatorId', 'profileId', 'purpose', 'provider', 'connectionId', 'connectionRevision',
    'descriptor', 'semanticDescriptorId', 'scope', 'disclosure',
  ])
  const slotValue = cleanSlot({
    operatorId: raw['operatorId'], profileId: raw['profileId'], purpose: raw['purpose'],
  })
  if (raw['provider'] !== 'openrouter') {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const descriptor = cleanDescriptor(raw['descriptor'])
  const descriptorId = hash(raw['semanticDescriptorId'])
  if (semanticDescriptorId(descriptor) !== descriptorId) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const scope = exact(raw['scope'], [
    'kind', 'includeGlobal', 'includeOwnedProjects', 'includeFutureOwnedProjects',
    'includeArchived', 'excludedCategories',
  ])
  if (scope['kind'] !== 'profile-memory' || scope['includeGlobal'] !== true ||
    scope['includeOwnedProjects'] !== true || scope['includeFutureOwnedProjects'] !== true ||
    scope['includeArchived'] !== false) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const excludedCategories = exactArray(
    scope['excludedCategories'], SEMANTIC_EGRESS_EXCLUDED_CATEGORIES.length,
  )
  if (excludedCategories.some(
    (category, index) => category !== SEMANTIC_EGRESS_EXCLUDED_CATEGORIES[index],
  )) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const disclosure = exact(raw['disclosure'], [
    'revision', 'hash', 'destination', 'dataClasses', 'scopePolicy',
    'dataCollectionDenyRequested',
  ])
  if (disclosure['revision'] !== SEMANTIC_EGRESS_DISCLOSURE_REVISION ||
    disclosure['hash'] !== SEMANTIC_EGRESS_DISCLOSURE_HASH ||
    disclosure['destination'] !== 'openrouter' ||
    disclosure['scopePolicy'] !== 'profile-global-and-owned-projects' ||
    disclosure['dataCollectionDenyRequested'] !== true) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const dataClasses = exactDataClasses(disclosure['dataClasses'])
  return Object.freeze({
    ...slotValue,
    provider: 'openrouter',
    connectionId: text(raw['connectionId'], 512),
    connectionRevision: text(raw['connectionRevision'], 512),
    descriptor,
    semanticDescriptorId: descriptorId,
    scope: Object.freeze({
      kind: 'profile-memory',
      includeGlobal: true,
      includeOwnedProjects: true,
      includeFutureOwnedProjects: true,
      includeArchived: false,
      excludedCategories: SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
    }),
    disclosure: Object.freeze({
      revision: SEMANTIC_EGRESS_DISCLOSURE_REVISION,
      hash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
      destination: 'openrouter',
      dataClasses,
      scopePolicy: 'profile-global-and-owned-projects',
      dataCollectionDenyRequested: true,
    }),
  })
}

function sameSlot(left: SemanticEgressConsentSlot, right: SemanticEgressConsentSlot): boolean {
  return left.operatorId === right.operatorId && left.profileId === right.profileId &&
    left.purpose === right.purpose
}

function slotFromBinding(binding: SemanticEgressConsentBinding): SemanticEgressConsentSlot {
  return {
    operatorId: binding.operatorId,
    profileId: binding.profileId,
    purpose: binding.purpose,
  }
}

function cleanRecord(value: unknown): SemanticEgressConsentRecordV1 {
  let state: unknown
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'state')
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    state = descriptor.value
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  if (typeof state !== 'string' || !ALL_STATES.has(state)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const common = [
    'schemaVersion', 'authorityId', 'revision', 'generation', 'state', 'binding',
    'createdAt', 'updatedAt',
  ]
  const extra = state === 'AWAITING_CONSENT' ? ['pending']
    : state === 'REVOKING' ? ['approval', 'authorityNonce', 'revokeStartedAt']
    : state === 'REVOKED' ? ['revokeStartedAt', 'purgeCompletedAt', 'revokedAt']
      : state === 'BLOCKED' ? ['approval', 'authorityNonce', 'blockedAt', 'blockedCode']
        : ['approval', 'authorityNonce']
  if (state === 'REVOKED') extra.unshift('approval', 'authorityNonce')
  const raw = exact(value, [...common, ...extra])
  if (raw['schemaVersion'] !== 1) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const binding = cleanBinding(raw['binding'])
  const authorityId = identifier(raw['authorityId'])
  const revision = positiveInteger(raw['revision'])
  const generation = positiveInteger(raw['generation'])
  const createdAt = iso(raw['createdAt'])
  const updatedAt = iso(raw['updatedAt'])
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const commonBase = {
    schemaVersion: 1 as const,
    authorityId,
    revision,
    generation,
    binding,
    createdAt,
    updatedAt,
  }
  if (state === 'AWAITING_CONSENT') {
    const pending = exact(raw['pending'], [
      'bootId', 'authorityRevision', 'generation', 'actionId', 'actionHash', 'cardId', 'nonceId',
      'issuedAt', 'expiresAt', 'invalidatedAt',
    ])
    const issuedAt = iso(pending['issuedAt'])
    const expiresAt = iso(pending['expiresAt'])
    const invalidatedAt = pending['invalidatedAt'] === null
      ? null
      : iso(pending['invalidatedAt'])
    if (Date.parse(expiresAt) <= Date.parse(issuedAt) || issuedAt !== createdAt ||
      (invalidatedAt === null && updatedAt !== createdAt) ||
      (invalidatedAt !== null &&
        (Date.parse(invalidatedAt) < Date.parse(issuedAt) || invalidatedAt !== updatedAt))) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const bootId = identifier(pending['bootId'])
    const authorityRevision = positiveInteger(pending['authorityRevision'])
    const pendingGeneration = positiveInteger(pending['generation'])
    const actionId = identifier(pending['actionId'])
    const cardId = identifier(pending['cardId'])
    const nonceId = identifier(pending['nonceId'])
    const actionHash = hash(pending['actionHash'])
    let expectedActionHash: string
    try {
      expectedActionHash = semanticEgressConsentActionHash({
        authorityId,
        authorityRevision,
        generation: pendingGeneration,
        binding,
        bootId,
        actionId,
        cardId,
        nonceId,
        issuedAt,
        expiresAt,
      })
    } catch {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const transitionDelta = revision - authorityRevision
    if (transitionDelta !== generation - pendingGeneration ||
      (invalidatedAt === null && transitionDelta !== 0) ||
      (invalidatedAt !== null && transitionDelta !== 1) ||
      actionHash !== expectedActionHash) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    return Object.freeze({
      ...commonBase,
      state,
      pending: Object.freeze({
        bootId,
        authorityRevision,
        generation: pendingGeneration,
        actionId,
        actionHash,
        cardId,
        nonceId,
        issuedAt,
        expiresAt,
        invalidatedAt,
      }),
    })
  }
  const approval = exact(raw['approval'], [
    'bootId', 'authorityRevision', 'generation', 'actionId', 'actionHash',
    'cardId', 'acceptedAt', 'expiresAt',
  ])
  const authorityNonce = exact(raw['authorityNonce'], ['nonceId', 'issuedAt', 'consumedAt'])
  const acceptedAt = iso(approval['acceptedAt'])
  const approvalExpiresAt = iso(approval['expiresAt'])
  const nonceIssuedAt = iso(authorityNonce['issuedAt'])
  const nonceConsumedAt = iso(authorityNonce['consumedAt'])
  const actionHash = hash(approval['actionHash'])
  const approvalBootId = identifier(approval['bootId'])
  const approvalAuthorityRevision = positiveInteger(approval['authorityRevision'])
  const approvalGeneration = positiveInteger(approval['generation'])
  const approvalActionId = identifier(approval['actionId'])
  const approvalCardId = identifier(approval['cardId'])
  const authorityNonceId = identifier(authorityNonce['nonceId'])
  let expectedActionHash: string
  try {
    expectedActionHash = semanticEgressConsentActionHash({
      authorityId,
      authorityRevision: approvalAuthorityRevision,
      generation: approvalGeneration,
      binding,
      bootId: approvalBootId,
      actionId: approvalActionId,
      cardId: approvalCardId,
      nonceId: authorityNonceId,
      issuedAt: nonceIssuedAt,
      expiresAt: approvalExpiresAt,
    })
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const transitionDelta = revision - approvalAuthorityRevision
  if (nonceIssuedAt !== createdAt || Date.parse(acceptedAt) < Date.parse(nonceIssuedAt) ||
    Date.parse(nonceConsumedAt) < Date.parse(acceptedAt) ||
    Date.parse(acceptedAt) >= Date.parse(approvalExpiresAt) ||
    Date.parse(nonceConsumedAt) >= Date.parse(approvalExpiresAt) ||
    Date.parse(updatedAt) < Date.parse(nonceConsumedAt) || transitionDelta < 1 ||
    transitionDelta !== generation - approvalGeneration || actionHash !== expectedActionHash) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const base = {
    ...commonBase,
    approval: Object.freeze({
      bootId: approvalBootId,
      authorityRevision: approvalAuthorityRevision,
      generation: approvalGeneration,
      actionId: approvalActionId,
      actionHash,
      cardId: approvalCardId,
      acceptedAt,
      expiresAt: approvalExpiresAt,
    }),
    authorityNonce: Object.freeze({
      nonceId: authorityNonceId,
      issuedAt: nonceIssuedAt,
      consumedAt: nonceConsumedAt,
    }),
  }
  if (ACTIVE_STATES.has(state)) {
    return Object.freeze({ ...base, state }) as SemanticEgressConsentRecordV1
  }
  if (state === 'REVOKING') {
    const revokeStartedAt = iso(raw['revokeStartedAt'])
    if (Date.parse(revokeStartedAt) < Date.parse(createdAt) || revokeStartedAt !== updatedAt) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    return Object.freeze({ ...base, state, revokeStartedAt })
  }
  if (state === 'REVOKED') {
    const revokeStartedAt = iso(raw['revokeStartedAt'])
    const purgeCompletedAt = iso(raw['purgeCompletedAt'])
    const revokedAt = iso(raw['revokedAt'])
    if (Date.parse(revokeStartedAt) < Date.parse(createdAt) ||
      Date.parse(purgeCompletedAt) < Date.parse(revokeStartedAt) ||
      Date.parse(revokedAt) < Date.parse(purgeCompletedAt) || revokedAt !== updatedAt) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    return Object.freeze({
      ...base,
      state,
      revokeStartedAt,
      purgeCompletedAt,
      revokedAt,
    })
  }
  const blockedCode = text(raw['blockedCode'], 64)
  const blockedAt = iso(raw['blockedAt'])
  if (!SAFE_CODE.test(blockedCode)) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  if (Date.parse(blockedAt) < Date.parse(createdAt) || blockedAt !== updatedAt) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    ...base, state: 'BLOCKED', blockedAt, blockedCode,
  })
}

function cleanNonce(value: unknown): SemanticEgressConsentNonceRecord {
  const raw = exact(value, ['nonceId', 'kind', 'bindingHash', 'issuedAt', 'expiresAt'])
  if (raw['kind'] !== 'grant' && raw['kind'] !== 'use') {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const issuedAt = iso(raw['issuedAt'])
  const expiresAt = iso(raw['expiresAt'])
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    nonceId: identifier(raw['nonceId']),
    kind: raw['kind'],
    bindingHash: hash(raw['bindingHash']),
    issuedAt,
    expiresAt,
  })
}

function exactArray(value: unknown, maxItems: number): unknown[] {
  try {
    if (!Array.isArray(value)) throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxItems) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const length = Number(lengthDescriptor.value)
    const keys = Reflect.ownKeys(value)
    const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), 'length']
    if (keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      result.push(descriptor.value)
    }
    return result
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
}

function cleanOutboxEvent(value: unknown): SemanticEgressOutboxEventV1 {
  let hasCode: boolean
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    hasCode = Object.getOwnPropertyDescriptor(value, 'code') !== undefined
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const keys = [
    'schemaVersion', 'eventId', 'kind', 'operatorId', 'profileId', 'purpose',
    'authorityId', 'authorityRevision', 'generation', 'connectionId',
    'connectionRevision', 'semanticDescriptorId', 'disclosureRevision', 'at',
    'disclosureHash',
    ...(hasCode ? ['code'] : []),
  ]
  const raw = exact(value, keys)
  if (raw['schemaVersion'] !== 1 || typeof raw['kind'] !== 'string' ||
    !OUTBOX_KINDS.has(raw['kind']) || raw['purpose'] !== PURPOSE) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const code = hasCode ? text(raw['code'], 64) : undefined
  if (code !== undefined && !SAFE_CODE.test(code)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    schemaVersion: 1,
    eventId: identifier(raw['eventId']),
    kind: raw['kind'] as SemanticEgressOutboxEventV1['kind'],
    operatorId: text(raw['operatorId']),
    profileId: text(raw['profileId']),
    purpose: PURPOSE,
    authorityId: identifier(raw['authorityId']),
    authorityRevision: positiveInteger(raw['authorityRevision']),
    generation: positiveInteger(raw['generation']),
    connectionId: text(raw['connectionId'], 512),
    connectionRevision: text(raw['connectionRevision'], 512),
    semanticDescriptorId: hash(raw['semanticDescriptorId']),
    disclosureRevision: positiveInteger(raw['disclosureRevision']),
    disclosureHash: hash(raw['disclosureHash']),
    ...(code === undefined ? {} : { code }),
    at: iso(raw['at']),
  })
}

type OutboxEventClass = 'lifecycle' | 'request' | 'recovery'

interface OutboxAnchorEnvelope {
  eventClass: OutboxEventClass
  anchorJson: string
}

function canonicalOutboxAnchor(
  eventClass: unknown,
  anchorJson: unknown,
  event: SemanticEgressOutboxEventV1,
): string {
  if (eventClass !== 'lifecycle' && eventClass !== 'request' && eventClass !== 'recovery') {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  if (typeof anchorJson !== 'string' || Buffer.byteLength(anchorJson, 'utf8') > 4096) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  let parsed: unknown
  try { parsed = JSON.parse(anchorJson) as unknown } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  let canonical: Record<string, unknown>
  let expectedEventId: string
  if (eventClass === 'lifecycle') {
    const raw = exact(parsed, ['authorityId', 'authorityRevision', 'kind'])
    const kind = raw['kind']
    if (typeof kind !== 'string' || !OUTBOX_KINDS.has(kind) ||
      kind === 'memory.semantic_egress.stale' ||
      kind === 'memory.semantic_egress.request_started' ||
      kind === 'memory.semantic_egress.request_completed') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    canonical = {
      authorityId: identifier(raw['authorityId']),
      authorityRevision: positiveInteger(raw['authorityRevision']),
      kind,
    }
    expectedEventId = semanticEgressOutboxEventId({
      authorityId: canonical['authorityId'] as string,
      authorityRevision: canonical['authorityRevision'] as number,
      kind: kind as SemanticEgressOutboxEventV1['kind'],
    })
    if (event.authorityId !== canonical['authorityId'] ||
      event.authorityRevision !== canonical['authorityRevision'] || event.kind !== kind) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
  } else if (eventClass === 'request') {
    const raw = exact(parsed, ['phase', 'nonceId'])
    if (raw['phase'] !== 'started' && raw['phase'] !== 'completed') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    canonical = { phase: raw['phase'], nonceId: identifier(raw['nonceId']) }
    expectedEventId = semanticEgressRequestEventId(
      raw['phase'], canonical['nonceId'] as string,
    )
    const expectedKind = raw['phase'] === 'started'
      ? 'memory.semantic_egress.request_started'
      : 'memory.semantic_egress.request_completed'
    if (event.kind !== expectedKind) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
  } else {
    const raw = exact(parsed, [
      'bootId', 'kind', 'slot', 'priorRevision', 'nextRevision',
    ])
    if (raw['kind'] !== 'memory.semantic_egress.stale' &&
      raw['kind'] !== 'memory.semantic_egress.suspended') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const anchorSlot = cleanSlot(raw['slot'])
    canonical = {
      bootId: identifier(raw['bootId']),
      kind: raw['kind'],
      slot: anchorSlot,
      priorRevision: positiveInteger(raw['priorRevision']),
      nextRevision: positiveInteger(raw['nextRevision']),
    }
    expectedEventId = semanticEgressRecoveryEventId({
      bootId: canonical['bootId'] as string,
      kind: raw['kind'],
      slot: anchorSlot,
      priorRevision: canonical['priorRevision'] as number,
      nextRevision: canonical['nextRevision'] as number,
    })
    if (!sameSlot(anchorSlot, {
      operatorId: event.operatorId,
      profileId: event.profileId,
      purpose: event.purpose,
    }) || event.kind !== raw['kind'] || event.authorityRevision !== raw['nextRevision']) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
  }
  const result = JSON.stringify(canonical)
  if (result !== anchorJson || event.eventId !== expectedEventId) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return result
}

function cleanNonceMutation(value: unknown): SemanticEgressNonceMutationV1 {
  let operation: unknown
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'operation')
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    operation = descriptor.value
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  if (operation === 'none') {
    exact(value, ['operation'])
    return Object.freeze({ operation })
  }
  if (operation === 'issue') {
    const raw = exact(value, ['operation', 'record'])
    return Object.freeze({ operation, record: cleanNonce(raw['record']) })
  }
  if (operation !== 'consume' && operation !== 'assert-consumed' && operation !== 'invalidate') {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const raw = exact(value, [
    'operation', 'nonceId', 'kind', 'bindingHash',
    ...(operation === 'consume' ? ['consumedAt'] : []),
    ...(operation === 'invalidate' ? ['invalidatedAt'] : []),
  ])
  if (raw['kind'] !== 'grant' && raw['kind'] !== 'use') {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const nonceId = identifier(raw['nonceId'])
  const kind = raw['kind']
  const bindingHashValue = hash(raw['bindingHash'])
  if (operation === 'consume') {
    return Object.freeze({
      operation, nonceId, kind, bindingHash: bindingHashValue,
      consumedAt: iso(raw['consumedAt']),
    })
  }
  if (operation === 'invalidate') {
    return Object.freeze({
      operation, nonceId, kind, bindingHash: bindingHashValue,
      invalidatedAt: iso(raw['invalidatedAt']),
    })
  }
  return Object.freeze({ operation, nonceId, kind, bindingHash: bindingHashValue })
}

function cleanTransition(value: unknown): SemanticEgressDurableTransitionV1 {
  const raw = exact(value, ['slot', 'expectedRevision', 'nextRecord', 'nonce', 'outbox'])
  const expectedRevision = raw['expectedRevision']
  if (expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const slot = cleanSlot(raw['slot'])
  const nextRecord = raw['nextRecord'] === null ? null : cleanRecord(raw['nextRecord'])
  if (nextRecord !== null && (!sameSlot(slotFromBinding(nextRecord.binding), slot) ||
    nextRecord.revision !== (Number(expectedRevision ?? 0) + 1))) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  const outbox = exactArray(raw['outbox'], 128).map(cleanOutboxEvent)
  if (outbox.some((event) => event.operatorId !== slot.operatorId ||
    event.profileId !== slot.profileId || event.purpose !== slot.purpose)) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    slot,
    expectedRevision: expectedRevision === null ? null : Number(expectedRevision),
    nextRecord,
    nonce: cleanNonceMutation(raw['nonce']),
    outbox: Object.freeze(outbox),
  })
}

function cleanUseStart(value: unknown): SemanticEgressDurableUseStartV1 {
  const raw = exact(value, [
    'slot', 'authorityId', 'authorityRevision', 'generation', 'bindingHash',
    'nonceId', 'consumedAt', 'outbox',
  ])
  const slot = cleanSlot(raw['slot'])
  const authorityId = identifier(raw['authorityId'])
  const authorityRevision = positiveInteger(raw['authorityRevision'])
  const generation = positiveInteger(raw['generation'])
  const bindingHashValue = hash(raw['bindingHash'])
  const nonceId = identifier(raw['nonceId'])
  const consumedAt = iso(raw['consumedAt'])
  const outbox = cleanOutboxEvent(raw['outbox'])
  if (outbox.kind !== 'memory.semantic_egress.request_started' ||
    outbox.eventId !== semanticEgressRequestEventId('started', nonceId) ||
    outbox.at !== consumedAt || outbox.operatorId !== slot.operatorId ||
    outbox.profileId !== slot.profileId || outbox.purpose !== slot.purpose ||
    outbox.authorityId !== authorityId || outbox.authorityRevision !== authorityRevision ||
    outbox.generation !== generation) {
    throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
  }
  return Object.freeze({
    slot,
    authorityId,
    authorityRevision,
    generation,
    bindingHash: bindingHashValue,
    nonceId,
    consumedAt,
    outbox,
  })
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  return Number(uid)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function canonicalPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || !isAbsolute(rawPath)) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  let requested = resolve(rawPath)
  if (process.platform === 'darwin' && (requested === '/var' || requested.startsWith('/var' + sep))) {
    const canonicalVar = realpathSync('/var')
    requested = join(canonicalVar, relative('/var', requested))
  }
  const parsed = parse(requested)
  let current = parsed.root
  for (const component of requested.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (!existsSync(current)) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  return requested
}

function ensurePrivateDirectory(path: string, uid: number): void {
  const parsed = parse(path)
  let current = parsed.root
  for (const component of path.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
    }
  }
  const target = lstatSync(path)
  if (target.uid !== uid || (target.mode & 0o777) !== 0o700 || realpathSync(path) !== path) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
}

function assertPrivateFile(path: string, uid: number, expected?: Stats): Stats {
  const before = lstatIfExists(path)
  if (before === null) throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid ||
    (before.mode & 0o777) !== 0o600 || realpathSync(path) !== path ||
    (expected !== undefined && !sameIdentity(before, expected))) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW) } catch {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
  try {
    const opened = fstatSync(descriptor)
    if (!sameIdentity(before, opened) || (expected !== undefined && !sameIdentity(opened, expected))) {
      throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
    }
  } finally {
    closeSync(descriptor)
  }
  return before
}

function preparePrivateFile(path: string, uid: number): Stats {
  if (!existsSync(path)) {
    let descriptor: number
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      )
    } catch {
      throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
    }
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o777) !== 0o600) {
        throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
      }
    } finally {
      closeSync(descriptor)
    }
  }
  return assertPrivateFile(path, uid)
}

function assertNoWalOrShm(path: string): void {
  if (lstatIfExists(path + '-wal') !== null || lstatIfExists(path + '-shm') !== null) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
}

function assertNoSqliteSidecars(path: string): void {
  assertNoWalOrShm(path)
  if (lstatIfExists(path + '-journal') !== null) {
    throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  }
}

function assertStartupSqliteSidecars(path: string, uid: number, databaseExists: boolean): void {
  assertNoWalOrShm(path)
  const journalPath = path + '-journal'
  if (lstatIfExists(journalPath) === null) return
  if (!databaseExists) throw new SemanticEgressConsentSqliteStoreError('UNSAFE_PATH')
  assertPrivateFile(journalPath, uid)
}

function scalar(db: Database.Database, pragma: string): number {
  const value = db.pragma(pragma, { simple: true })
  return typeof value === 'number' ? value : Number.NaN
}

function validateSchema(db: Database.Database): void {
  const version = scalar(db, 'user_version')
  if (version > SCHEMA_VERSION) throw new SemanticEgressConsentSqliteStoreError('FUTURE_SCHEMA')
  if (version !== SCHEMA_VERSION || scalar(db, 'application_id') !== APPLICATION_ID) {
    throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
  }
  const objects = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>
  const expected = new Map<string, { tblName: string; sql: string | null }>([
    ['index:sqlite_autoindex_semantic_egress_outbox_1', {
      tblName: 'semantic_egress_outbox', sql: null,
    }],
    ['table:semantic_egress_consents', {
      tblName: 'semantic_egress_consents', sql: CONSENT_SCHEMA,
    }],
    ['table:semantic_egress_nonces', {
      tblName: 'semantic_egress_nonces', sql: NONCE_SCHEMA,
    }],
    ['table:semantic_egress_outbox', {
      tblName: 'semantic_egress_outbox', sql: OUTBOX_SCHEMA,
    }],
    ['table:sqlite_sequence', {
      tblName: 'sqlite_sequence', sql: 'CREATE TABLE sqlite_sequence(name,seq)',
    }],
  ])
  if (objects.length !== expected.size || objects.some((object) => {
    const exactObject = expected.get(`${object.type}:${object.name}`)
    return exactObject === undefined || exactObject.tblName !== object.tbl_name ||
      exactObject.sql !== object.sql
  })) {
    throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
  }
}

function initializeOrValidate(db: Database.Database): void {
  const version = scalar(db, 'user_version')
  const applicationId = scalar(db, 'application_id')
  const objects = db.prepare(`
    SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
  `).get() as { count: number }
  if (version === 0 && applicationId === 0 && objects.count === 0) {
    const initialize = db.transaction(() => {
      db.exec(CONSENT_SCHEMA)
      db.exec(NONCE_SCHEMA)
      db.exec(OUTBOX_SCHEMA)
      db.pragma(`application_id = ${APPLICATION_ID}`)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })
    initialize.immediate()
  }
  validateSchema(db)
}

function hashMatches(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

interface PersistedNonceRow {
  kind: 'grant' | 'use'
  binding_hash: string
  issued_at: string
  expires_at: string
  consumed_at: string | null
  invalidated_at: string | null
}

function validatePersistedNonceRow(value: unknown): PersistedNonceRow {
  try {
    const raw = exact(value, [
      'kind', 'binding_hash', 'issued_at', 'expires_at', 'consumed_at', 'invalidated_at',
    ])
    if (raw['kind'] !== 'grant' && raw['kind'] !== 'use') {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const issuedAt = iso(raw['issued_at'])
    const expiresAt = iso(raw['expires_at'])
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    let consumedAt: string | null = null
    if (raw['consumed_at'] !== null) {
      consumedAt = iso(raw['consumed_at'])
      if (Date.parse(consumedAt) < Date.parse(issuedAt) ||
        Date.parse(consumedAt) >= Date.parse(expiresAt)) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
    }
    let invalidatedAt: string | null = null
    if (raw['invalidated_at'] !== null) {
      invalidatedAt = iso(raw['invalidated_at'])
      if (Date.parse(invalidatedAt) < Date.parse(issuedAt)) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
    }
    if (consumedAt !== null && invalidatedAt !== null) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    return {
      kind: raw['kind'],
      binding_hash: hash(raw['binding_hash']),
      issued_at: issuedAt,
      expires_at: expiresAt,
      consumed_at: consumedAt,
      invalidated_at: invalidatedAt,
    }
  } catch {
    throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
  }
}

export function makeNodeSemanticEgressConsentStore(input: {
  path: string
}): NodeSemanticEgressConsentStore {
  const path = canonicalPath(input.path)
  const directory = dirname(path)
  const uid = currentUid()
  ensurePrivateDirectory(directory, uid)
  let lease: PrivateSqliteLease
  try { lease = acquirePrivateSqliteLease({ root: directory, profile: LEASE_PROFILE }) } catch (error) {
    throw leaseFailure(error)
  }
  let databaseExists: boolean
  let expectedIdentity: Stats
  try {
    databaseExists = lstatIfExists(path) !== null
    assertStartupSqliteSidecars(path, uid, databaseExists)
    expectedIdentity = preparePrivateFile(path, uid)
  } catch (error) {
    lease.release()
    throw error
  }

  let db: Database.Database | null = null
  try {
    db = new Database(path)
    assertPrivateFile(path, uid, expectedIdentity)
    assertNoWalOrShm(path)
    db.pragma('busy_timeout = 0')
    db.pragma('journal_mode = DELETE')
    db.pragma('synchronous = FULL')
    db.pragma('foreign_keys = ON')
    db.pragma('trusted_schema = OFF')
    initializeOrValidate(db)
    assertPrivateFile(path, uid, expectedIdentity)
    assertNoSqliteSidecars(path)
    if (db.pragma('journal_mode', { simple: true }) !== 'delete' ||
      scalar(db, 'busy_timeout') !== 0 || scalar(db, 'synchronous') !== 2 ||
      scalar(db, 'foreign_keys') !== 1 ||
      scalar(db, 'trusted_schema') !== 0) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
  } catch (error) {
    try { db?.close() } catch { /* preserve initialization error */ }
    lease.release()
    throw unavailable(error)
  }
  const database = db

  let closed = false
  const assertOpen = (): void => {
    if (closed || !database.open) throw new SemanticEgressConsentSqliteStoreError('STORE_CLOSED')
  }
  const guardOperation = (): void => {
    assertOpen()
    try { lease.assertHeld() } catch (error) { throw leaseFailure(error) }
    assertPrivateFile(path, uid, expectedIdentity)
    assertNoSqliteSidecars(path)
  }
  const loadRow = database.prepare(`
    SELECT schema_version, revision, state, record_json
    FROM semantic_egress_consents
    WHERE operator_id = ? AND profile_id = ? AND purpose = ?
  `)
  const listRows = database.prepare(`
    SELECT operator_id, profile_id, purpose, schema_version, revision, state, record_json
    FROM semantic_egress_consents
    ORDER BY operator_id, profile_id, purpose
  `)
  const insertRecord = database.prepare(`
    INSERT INTO semantic_egress_consents (
      operator_id, profile_id, purpose, schema_version, revision, state, record_json
    ) VALUES (?, ?, ?, 1, ?, ?, ?)
  `)
  const updateRecord = database.prepare(`
    UPDATE semantic_egress_consents
    SET revision = ?, state = ?, record_json = ?
    WHERE operator_id = ? AND profile_id = ? AND purpose = ? AND revision = ?
  `)
  const insertNonce = database.prepare(`
    INSERT INTO semantic_egress_nonces (
      nonce_id, kind, binding_hash, issued_at, expires_at, consumed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `)
  const loadNonce = database.prepare(`
    SELECT kind, binding_hash, issued_at, expires_at, consumed_at, invalidated_at
    FROM semantic_egress_nonces WHERE nonce_id = ?
  `)
  const consumeNonce = database.prepare(`
    UPDATE semantic_egress_nonces SET consumed_at = ?
    WHERE nonce_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
  `)
  const invalidateNonce = database.prepare(`
    UPDATE semantic_egress_nonces SET invalidated_at = ?
    WHERE nonce_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
  `)
  const insertOutbox = database.prepare(`
    INSERT INTO semantic_egress_outbox (
      event_id, schema_version, kind, event_class, anchor_json, created_at, payload, acked
    ) VALUES (?, 1, ?, ?, ?, ?, ?, 0)
  `)
  const loadOutboxByEventId = database.prepare(`
    SELECT sequence, event_id, schema_version, kind, event_class, anchor_json,
      created_at, payload, acked
    FROM semantic_egress_outbox WHERE event_id = ?
  `)
  const loadOutboxHead = database.prepare(`
    SELECT sequence, event_id, schema_version, kind, event_class, anchor_json,
      created_at, payload, acked
    FROM semantic_egress_outbox WHERE acked = 0 ORDER BY sequence LIMIT 1
  `)
  const readOutboxRows = database.prepare(`
    SELECT sequence, event_id, schema_version, kind, event_class, anchor_json,
      created_at, payload, acked
    FROM semantic_egress_outbox WHERE acked = 0 ORDER BY sequence LIMIT ?
  `)
  const acknowledgeOutbox = database.prepare(`
    UPDATE semantic_egress_outbox SET acked = 1 WHERE event_id = ? AND acked = 0
  `)

  type ConsentRow = {
    operator_id?: string
    profile_id?: string
    purpose?: string
    schema_version: number
    revision: number
    state: string
    record_json: string
  }

  type OutboxRow = {
    sequence: number
    event_id: string
    schema_version: number
    kind: string
    event_class: string
    anchor_json: string
    created_at: string
    payload: string
    acked: number
  }

  const parseOutboxRow = (
    row: OutboxRow,
    expectedAcked?: 0 | 1,
  ): SemanticEgressOutboxEventV1 => {
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
      row.schema_version !== 1 || (row.acked !== 0 && row.acked !== 1) ||
      (expectedAcked !== undefined && row.acked !== expectedAcked)) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    let parsed: unknown
    try { parsed = JSON.parse(row.payload) as unknown } catch {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    let event: SemanticEgressOutboxEventV1
    try { event = cleanOutboxEvent(parsed) } catch {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    if (row.event_id !== event.eventId || row.kind !== event.kind ||
      row.created_at !== event.at || row.payload !== JSON.stringify(event)) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    try { canonicalOutboxAnchor(row.event_class, row.anchor_json, event) } catch {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    return structuredClone(event)
  }

  const parseRecordRow = (
    row: ConsentRow,
    expectedSlot?: SemanticEgressConsentSlot,
  ): SemanticEgressConsentRecordV1 => {
    let parsed: unknown
    try { parsed = JSON.parse(row.record_json) as unknown } catch {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    let record: SemanticEgressConsentRecordV1
    try { record = cleanRecord(parsed) } catch {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    const recordSlot = slotFromBinding(record.binding)
    if (row.schema_version !== 1 || row.revision !== record.revision ||
      row.state !== record.state || (expectedSlot !== undefined && !sameSlot(recordSlot, expectedSlot)) ||
      (row.operator_id !== undefined && row.operator_id !== recordSlot.operatorId) ||
      (row.profile_id !== undefined && row.profile_id !== recordSlot.profileId) ||
      (row.purpose !== undefined && row.purpose !== recordSlot.purpose)) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    return record
  }

  const nonceRow = (nonceId: string): PersistedNonceRow => {
    const raw = loadNonce.get(nonceId) as unknown
    if (raw === undefined) throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    return validatePersistedNonceRow(raw)
  }

  const validateRecordNonceLink = (record: SemanticEgressConsentRecordV1): void => {
    if (record.state === 'AWAITING_CONSENT') {
      const nonce = nonceRow(record.pending.nonceId)
      if (nonce.kind !== 'grant' || !hashMatches(nonce.binding_hash, record.pending.actionHash) ||
        nonce.issued_at !== record.pending.issuedAt || nonce.expires_at !== record.pending.expiresAt ||
        nonce.consumed_at !== null || nonce.invalidated_at !== record.pending.invalidatedAt) {
        throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
      }
      return
    }
    const nonce = nonceRow(record.authorityNonce.nonceId)
    if (nonce.kind !== 'grant' || !hashMatches(nonce.binding_hash, record.approval.actionHash) ||
      nonce.issued_at !== record.authorityNonce.issuedAt ||
      nonce.expires_at !== record.approval.expiresAt ||
      nonce.consumed_at !== record.authorityNonce.consumedAt || nonce.invalidated_at !== null) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
  }

  const storeOutboxEvent = (
    event: SemanticEgressOutboxEventV1,
    anchor: OutboxAnchorEnvelope,
  ): void => {
    canonicalOutboxAnchor(anchor.eventClass, anchor.anchorJson, event)
    const payload = JSON.stringify(event)
    const existing = loadOutboxByEventId.get(event.eventId) as {
      schema_version: number
      kind: string
      event_class: string
      anchor_json: string
      created_at: string
      payload: string
      acked: number
    } | undefined
    if (existing !== undefined) {
      if (existing.schema_version !== 1 || existing.kind !== event.kind ||
        existing.event_class !== anchor.eventClass || existing.anchor_json !== anchor.anchorJson ||
        existing.created_at !== event.at || existing.payload !== payload ||
        (existing.acked !== 0 && existing.acked !== 1)) {
        throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
      }
      return
    }
    insertOutbox.run(
      event.eventId,
      event.kind,
      anchor.eventClass,
      anchor.anchorJson,
      event.at,
      payload,
    )
  }

  const applyNonceMutation = (mutation: SemanticEgressNonceMutationV1): boolean => {
    if (mutation.operation === 'none') return true
    if (mutation.operation === 'issue') {
      try {
        insertNonce.run(
          mutation.record.nonceId,
          mutation.record.kind,
          mutation.record.bindingHash,
          mutation.record.issuedAt,
          mutation.record.expiresAt,
        )
        return true
      } catch (error) {
        if (sqliteCode(error)?.startsWith('SQLITE_CONSTRAINT') === true) return false
        throw error
      }
    }
    const nonce = nonceRow(mutation.nonceId)
    if (nonce.kind !== mutation.kind || !hashMatches(nonce.binding_hash, mutation.bindingHash)) {
      return false
    }
    if (mutation.operation === 'assert-consumed') {
      return nonce.consumed_at !== null && nonce.invalidated_at === null
    }
    if (mutation.operation === 'invalidate') {
      if (nonce.consumed_at !== null || nonce.invalidated_at !== null ||
        Date.parse(mutation.invalidatedAt) < Date.parse(nonce.issued_at)) return false
      return invalidateNonce.run(mutation.invalidatedAt, mutation.nonceId).changes === 1
    }
    if (nonce.consumed_at !== null || nonce.invalidated_at !== null ||
      Date.parse(mutation.consumedAt) < Date.parse(nonce.issued_at) ||
      Date.parse(mutation.consumedAt) >= Date.parse(nonce.expires_at)) return false
    return consumeNonce.run(mutation.consumedAt, mutation.nonceId).changes === 1
  }

  const transitionTransaction = database.transaction((
    transition: SemanticEgressDurableTransitionV1,
  ): SemanticEgressDurableTransitionResult => {
    const rawCurrent = loadRow.get(
      transition.slot.operatorId, transition.slot.profileId, transition.slot.purpose,
    ) as ConsentRow | undefined
    const current = rawCurrent === undefined ? null : parseRecordRow(rawCurrent, transition.slot)
    if ((current?.revision ?? null) !== transition.expectedRevision) {
      return { status: 'cas-conflict' }
    }
    if (current !== null) validateRecordNonceLink(current)
    const nextState = transition.nextRecord?.state ?? null
    const stateTransitionAllowed = (() => {
      if (nextState === null) return current?.state === 'ACTIVE'
      if (current === null) return nextState === 'AWAITING_CONSENT'
      const allowed: Record<SemanticEgressConsentRecordV1['state'], readonly string[]> = {
        AWAITING_CONSENT: ['AWAITING_CONSENT', 'CONSENTED'],
        CONSENTED: ['ACTIVE', 'SUSPENDED', 'REVOKING', 'BLOCKED'],
        ACTIVE: ['ACTIVE', 'DEGRADED', 'SUSPENDED', 'REVOKING', 'BLOCKED'],
        DEGRADED: ['ACTIVE', 'DEGRADED', 'SUSPENDED', 'REVOKING', 'BLOCKED'],
        SUSPENDED: ['ACTIVE', 'SUSPENDED', 'REVOKING', 'BLOCKED'],
        REVOKING: ['REVOKED'],
        REVOKED: ['AWAITING_CONSENT'],
        BLOCKED: ['BLOCKED', 'REVOKING'],
      }
      return allowed[current.state].includes(nextState)
    })()
    if (!stateTransitionAllowed) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    if (transition.nextRecord !== null) {
      if (transition.nextRecord.generation !== (current?.generation ?? 0) + 1) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      if (transition.nextRecord.state === 'AWAITING_CONSENT') {
        const pending = transition.nextRecord.pending
        if (pending.invalidatedAt !== null || transition.nonce.operation !== 'issue' ||
          transition.nonce.record.kind !== 'grant' ||
          transition.nonce.record.nonceId !== pending.nonceId ||
          transition.nonce.record.bindingHash !== pending.actionHash ||
          transition.nonce.record.issuedAt !== pending.issuedAt ||
          transition.nonce.record.expiresAt !== pending.expiresAt) {
          throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
        }
        if (current !== null && current.state !== 'REVOKED' &&
          !(current.state === 'AWAITING_CONSENT' && current.pending.invalidatedAt !== null)) {
          throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
        }
      }
      if (current?.state === 'AWAITING_CONSENT' &&
        transition.nextRecord.state !== 'AWAITING_CONSENT') {
        const pending = current.pending
        const next = transition.nextRecord
        if (pending.invalidatedAt !== null || transition.nonce.operation !== 'consume' ||
          transition.nonce.kind !== 'grant' || transition.nonce.nonceId !== pending.nonceId ||
          transition.nonce.bindingHash !== pending.actionHash ||
          next.approval.bootId !== pending.bootId ||
          next.approval.authorityRevision !== pending.authorityRevision ||
          next.approval.generation !== pending.generation ||
          next.approval.actionId !== pending.actionId || next.approval.actionHash !== pending.actionHash ||
          next.approval.cardId !== pending.cardId || next.authorityNonce.nonceId !== pending.nonceId ||
          next.approval.expiresAt !== pending.expiresAt ||
          next.authorityNonce.issuedAt !== pending.issuedAt ||
          next.authorityNonce.consumedAt !== transition.nonce.consumedAt) {
          throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
        }
      }
      if (current === null && transition.nextRecord.state !== 'AWAITING_CONSENT') {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      if (current !== null && current.state !== 'AWAITING_CONSENT' &&
        transition.nextRecord.state !== 'AWAITING_CONSENT' &&
        (JSON.stringify(transition.nextRecord.approval) !== JSON.stringify(current.approval) ||
          JSON.stringify(transition.nextRecord.authorityNonce) !==
            JSON.stringify(current.authorityNonce))) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      const isConsentConfirmation = current?.state === 'AWAITING_CONSENT' &&
        transition.nextRecord.state === 'CONSENTED'
      if (transition.nextRecord.state !== 'AWAITING_CONSENT' && !isConsentConfirmation &&
        transition.nonce.operation !== 'none') {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
    } else if (current?.state !== 'ACTIVE' ||
      (transition.nonce.operation !== 'issue' && transition.nonce.operation !== 'consume' &&
        transition.nonce.operation !== 'assert-consumed') ||
      (transition.nonce.operation === 'issue'
        ? transition.nonce.record.kind !== 'use'
        : transition.nonce.kind !== 'use')) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    if (transition.nextRecord === null && transition.nonce.operation === 'consume' &&
      transition.nonce.kind === 'use') {
      // Starting provider I/O has a stricter exact-authority transaction below.
      // Keeping it out of the generic transition prevents a same-revision bypass.
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const anchor = transition.nextRecord ?? current
    if (transition.outbox.some((event) => anchor === null ||
      event.authorityId !== anchor.authorityId || event.authorityRevision !== anchor.revision ||
      event.generation !== anchor.generation || event.connectionId !== anchor.binding.connectionId ||
      event.connectionRevision !== anchor.binding.connectionRevision ||
      event.semanticDescriptorId !== anchor.binding.semanticDescriptorId ||
      event.disclosureRevision !== anchor.binding.disclosure.revision ||
      event.disclosureHash !== anchor.binding.disclosure.hash)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    let expectedKinds: SemanticEgressOutboxEventV1['kind'][]
    if (transition.nextRecord !== null) {
      switch (transition.nextRecord.state) {
        case 'AWAITING_CONSENT':
          expectedKinds = ['memory.semantic_egress.disclosure_issued']
          break
        case 'CONSENTED':
          expectedKinds = ['memory.semantic_egress.consent_granted']
          break
        case 'ACTIVE':
          expectedKinds = ['memory.semantic_egress.activated']
          break
        case 'DEGRADED':
          expectedKinds = ['memory.semantic_egress.degraded']
          break
        case 'SUSPENDED':
          expectedKinds = ['memory.semantic_egress.suspended']
          break
        case 'BLOCKED':
          expectedKinds = ['memory.semantic_egress.blocked']
          break
        case 'REVOKING':
          expectedKinds = ['memory.semantic_egress.revoke_started']
          break
        case 'REVOKED':
          expectedKinds = [
            'memory.semantic_egress.purge_completed',
            'memory.semantic_egress.revoked',
          ]
          break
      }
    } else if (transition.nonce.operation === 'consume' && transition.nonce.kind === 'use') {
      expectedKinds = ['memory.semantic_egress.request_started']
    } else if (transition.nonce.operation === 'assert-consumed' && transition.nonce.kind === 'use') {
      expectedKinds = ['memory.semantic_egress.request_completed']
    } else if (transition.nonce.operation === 'issue' && transition.nonce.record.kind === 'use') {
      expectedKinds = []
    } else {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    if (transition.outbox.length !== expectedKinds.length ||
      transition.outbox.some((event, index) => event.kind !== expectedKinds[index])) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    if (transition.nextRecord !== null) {
      if (transition.outbox.some((event) => event.at !== transition.nextRecord!.updatedAt ||
        event.eventId !== semanticEgressOutboxEventId({
          authorityId: transition.nextRecord!.authorityId,
          authorityRevision: transition.nextRecord!.revision,
          kind: event.kind,
        }))) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
    } else if (transition.nonce.operation === 'consume') {
      if (transition.outbox[0]?.eventId !==
        semanticEgressRequestEventId('started', transition.nonce.nonceId)) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
    } else if (transition.nonce.operation === 'assert-consumed' &&
      transition.outbox[0]?.eventId !==
        semanticEgressRequestEventId('completed', transition.nonce.nonceId)) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    if (!applyNonceMutation(transition.nonce)) return { status: 'nonce-conflict' }
    if (transition.nextRecord !== null) {
      const serialized = JSON.stringify(transition.nextRecord)
      if (current === null) {
        insertRecord.run(
          transition.slot.operatorId,
          transition.slot.profileId,
          transition.slot.purpose,
          transition.nextRecord.revision,
          transition.nextRecord.state,
          serialized,
        )
      } else if (updateRecord.run(
        transition.nextRecord.revision,
        transition.nextRecord.state,
        serialized,
        transition.slot.operatorId,
        transition.slot.profileId,
        transition.slot.purpose,
        transition.expectedRevision,
      ).changes !== 1) {
        throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
      }
    }
    for (const event of transition.outbox) {
      let anchor: OutboxAnchorEnvelope
      if (transition.nextRecord !== null) {
        anchor = {
          eventClass: 'lifecycle',
          anchorJson: JSON.stringify({
            authorityId: transition.nextRecord.authorityId,
            authorityRevision: transition.nextRecord.revision,
            kind: event.kind,
          }),
        }
      } else {
        const mutation = transition.nonce
        if (mutation.operation !== 'consume' && mutation.operation !== 'assert-consumed') {
          throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
        }
        anchor = {
          eventClass: 'request',
          anchorJson: JSON.stringify({
            phase: mutation.operation === 'consume' ? 'started' : 'completed',
            nonceId: mutation.nonceId,
          }),
        }
      }
      storeOutboxEvent(event, anchor)
    }
    return { status: 'committed' }
  })

  const consumeUseIfActiveTransaction = database.transaction((
    input: SemanticEgressDurableUseStartV1,
  ): SemanticEgressDurableTransitionResult => {
    const rawCurrent = loadRow.get(
      input.slot.operatorId, input.slot.profileId, input.slot.purpose,
    ) as ConsentRow | undefined
    if (rawCurrent === undefined) return { status: 'cas-conflict' }
    const current = parseRecordRow(rawCurrent, input.slot)
    validateRecordNonceLink(current)
    if (current.state !== 'ACTIVE' || current.authorityId !== input.authorityId ||
      current.revision !== input.authorityRevision || current.generation !== input.generation ||
      !hashMatches(semanticEgressBindingHash(current.binding), input.bindingHash)) {
      return { status: 'cas-conflict' }
    }
    const outbox = input.outbox
    if (outbox.connectionId !== current.binding.connectionId ||
      outbox.connectionRevision !== current.binding.connectionRevision ||
      outbox.semanticDescriptorId !== current.binding.semanticDescriptorId ||
      outbox.disclosureRevision !== current.binding.disclosure.revision ||
      outbox.disclosureHash !== current.binding.disclosure.hash) {
      throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
    }
    const rawNonce = loadNonce.get(input.nonceId) as unknown
    if (rawNonce === undefined) return { status: 'nonce-conflict' }
    const nonce = validatePersistedNonceRow(rawNonce)
    if (nonce.kind !== 'use' || !hashMatches(nonce.binding_hash, input.bindingHash) ||
      nonce.consumed_at !== null || nonce.invalidated_at !== null ||
      Date.parse(input.consumedAt) < Date.parse(nonce.issued_at) ||
      Date.parse(input.consumedAt) >= Date.parse(nonce.expires_at)) {
      return { status: 'nonce-conflict' }
    }
    if (consumeNonce.run(input.consumedAt, input.nonceId).changes !== 1) {
      return { status: 'nonce-conflict' }
    }
    storeOutboxEvent(outbox, {
      eventClass: 'request',
      anchorJson: JSON.stringify({ phase: 'started', nonceId: input.nonceId }),
    })
    return { status: 'committed' }
  })

  const loadTransaction = database.transaction((slot: SemanticEgressConsentSlot): unknown | null => {
    const row = loadRow.get(slot.operatorId, slot.profileId, slot.purpose) as ConsentRow | undefined
    if (row === undefined) return null
    const record = parseRecordRow(row, slot)
    validateRecordNonceLink(record)
    return structuredClone(record)
  })

  const recoveryEvent = (
    bootId: string,
    priorRevision: number,
    record: SemanticEgressConsentRecordV1,
    kind: 'memory.semantic_egress.stale' | 'memory.semantic_egress.suspended',
    code: 'STALE_BOOT' | 'BOOT_REACTIVATION_REQUIRED',
    at: string,
  ): SemanticEgressOutboxEventV1 => {
    const slot = slotFromBinding(record.binding)
    const eventId = semanticEgressRecoveryEventId({
      bootId,
      kind,
      slot,
      priorRevision,
      nextRevision: record.revision,
    })
    return cleanOutboxEvent({
      schemaVersion: 1,
      eventId,
      kind,
      operatorId: slot.operatorId,
      profileId: slot.profileId,
      purpose: slot.purpose,
      authorityId: record.authorityId,
      authorityRevision: record.revision,
      generation: record.generation,
      connectionId: record.binding.connectionId,
      connectionRevision: record.binding.connectionRevision,
      semanticDescriptorId: record.binding.semanticDescriptorId,
      disclosureRevision: record.binding.disclosure.revision,
      disclosureHash: record.binding.disclosure.hash,
      code,
      at,
    })
  }

  const recoverTransaction = database.transaction((
    bootId: string,
    at: string,
  ): SemanticEgressBootRecoveryV1 => {
    const invalidatedCards: SemanticEgressBootRecoveryV1['invalidatedCards'] = []
    const revoking: SemanticEgressConsentSlot[] = []
    const rows = listRows.all() as ConsentRow[]
    for (const row of rows) {
      const current = parseRecordRow(row)
      validateRecordNonceLink(current)
      const slot = slotFromBinding(current.binding)
      if (current.state === 'REVOKING') {
        revoking.push(slot)
        continue
      }
      if (current.state === 'AWAITING_CONSENT') {
        if (current.pending.bootId === bootId || current.pending.invalidatedAt !== null) continue
        if (Date.parse(at) < Date.parse(current.updatedAt) ||
          current.revision >= Number.MAX_SAFE_INTEGER ||
          current.generation >= Number.MAX_SAFE_INTEGER) {
          throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
        }
        if (invalidateNonce.run(at, current.pending.nonceId).changes !== 1) {
          throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
        }
        const next = cleanRecord({
          ...current,
          revision: current.revision + 1,
          generation: current.generation + 1,
          updatedAt: at,
          pending: { ...current.pending, invalidatedAt: at },
        })
        if (updateRecord.run(
          next.revision,
          next.state,
          JSON.stringify(next),
          slot.operatorId,
          slot.profileId,
          slot.purpose,
          current.revision,
        ).changes !== 1) {
          throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
        }
        const staleEvent = recoveryEvent(
          bootId,
          current.revision,
          next,
          'memory.semantic_egress.stale',
          'STALE_BOOT',
          at,
        )
        storeOutboxEvent(staleEvent, {
          eventClass: 'recovery',
          anchorJson: JSON.stringify({
            bootId,
            kind: staleEvent.kind,
            slot,
            priorRevision: current.revision,
            nextRevision: next.revision,
          }),
        })
        invalidatedCards.push({
          cardId: current.pending.cardId,
          actionId: current.pending.actionId,
        })
        continue
      }
      if (current.state !== 'ACTIVE' && current.state !== 'DEGRADED') continue
      if (Date.parse(at) < Date.parse(current.updatedAt) ||
        current.revision >= Number.MAX_SAFE_INTEGER ||
        current.generation >= Number.MAX_SAFE_INTEGER) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      const next = cleanRecord({
        ...current,
        state: 'SUSPENDED',
        revision: current.revision + 1,
        generation: current.generation + 1,
        updatedAt: at,
      })
      if (updateRecord.run(
        next.revision,
        next.state,
        JSON.stringify(next),
        slot.operatorId,
        slot.profileId,
        slot.purpose,
        current.revision,
      ).changes !== 1) {
        throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
      }
      const suspendedEvent = recoveryEvent(
        bootId,
        current.revision,
        next,
        'memory.semantic_egress.suspended',
        'BOOT_REACTIVATION_REQUIRED',
        at,
      )
      storeOutboxEvent(suspendedEvent, {
        eventClass: 'recovery',
        anchorJson: JSON.stringify({
          bootId,
          kind: suspendedEvent.kind,
          slot,
          priorRevision: current.revision,
          nextRevision: next.revision,
        }),
      })
    }
    return { invalidatedCards, revoking }
  })

  const ackHeadTransaction = database.transaction((
    eventId: string,
  ): 'acked' | 'already-acked' | 'not-head' | 'unknown' => {
    const row = loadOutboxByEventId.get(eventId) as OutboxRow | undefined
    if (row === undefined) return 'unknown'
    parseOutboxRow(row)
    if (row.acked === 1) return 'already-acked'
    const head = loadOutboxHead.get() as OutboxRow | undefined
    if (head === undefined) throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    parseOutboxRow(head, 0)
    if (head.event_id !== eventId) return 'not-head'
    if (acknowledgeOutbox.run(eventId).changes !== 1) {
      throw new SemanticEgressConsentSqliteStoreError('CORRUPT_STORE')
    }
    return 'acked'
  })

  const durable = Object.freeze<SemanticEgressDurableStore>({
    async load(rawSlot) {
      guardOperation()
      const slot = cleanSlot(rawSlot)
      try { return loadTransaction.deferred(slot) } catch (error) { throw unavailable(error) }
    },

    async transition(rawTransition) {
      guardOperation()
      const transition = cleanTransition(rawTransition)
      try { return transitionTransaction.immediate(transition) } catch (error) {
        throw unavailable(error)
      }
    },

    async consumeUseIfActive(rawInput) {
      guardOperation()
      const input = cleanUseStart(rawInput)
      try { return consumeUseIfActiveTransaction.immediate(input) } catch (error) {
        throw unavailable(error)
      }
    },

    async recoverForBoot(rawInput) {
      guardOperation()
      const inputValue = exact(rawInput, ['bootId', 'at'])
      const bootId = identifier(inputValue['bootId'])
      const at = iso(inputValue['at'])
      try { return recoverTransaction.immediate(bootId, at) } catch (error) {
        throw unavailable(error)
      }
    },

    async readOutbox(rawLimit) {
      guardOperation()
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 1_000) {
        throw new SemanticEgressConsentSqliteStoreError('INVALID_INPUT')
      }
      try {
        const rows = readOutboxRows.all(rawLimit) as OutboxRow[]
        return rows.map(row => parseOutboxRow(row, 0))
      } catch (error) {
        throw unavailable(error)
      }
    },

    async ackOutboxHead(rawEventId) {
      guardOperation()
      const eventId = identifier(rawEventId)
      try { return ackHeadTransaction.immediate(eventId) } catch (error) {
        throw unavailable(error)
      }
    },
  })

  return Object.freeze({
    durable,
    close() {
      if (closed) return
      closed = true
      let firstError: unknown
      try { lease.assertHeld() } catch (error) { firstError = leaseFailure(error) }
      try {
        assertPrivateFile(path, uid, expectedIdentity)
        assertNoSqliteSidecars(path)
      } catch (error) {
        firstError = error
      }
      try { database.close() } catch (error) { firstError ??= unavailable(error) }
      try { assertPrivateFile(path, uid, expectedIdentity) } catch (error) { firstError ??= error }
      try { assertNoSqliteSidecars(path) } catch (error) { firstError ??= error }
      try { lease.release() } catch (error) { firstError ??= leaseFailure(error) }
      if (firstError !== undefined) throw firstError
    },
  })
}

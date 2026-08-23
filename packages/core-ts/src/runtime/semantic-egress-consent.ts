import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { ApprovalProof } from '../gateway/index.js'
import type { EmbeddingDescriptor } from './hybrid-retrieval.js'
import { semanticDescriptorId as computeSemanticDescriptorId } from './protected-memory-semantic-reconciler.js'

export type SemanticEgressConsentPurpose = 'memory.semantic-embedding.v1'

export type SemanticEgressConsentState =
  | 'AWAITING_CONSENT'
  | 'CONSENTED'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'SUSPENDED'
  | 'REVOKING'
  | 'REVOKED'
  | 'BLOCKED'

export interface SemanticEgressConsentSlot {
  operatorId: string
  profileId: string
  purpose: SemanticEgressConsentPurpose
}

export interface SemanticEgressConsentScope {
  kind: 'profile-memory'
  includeGlobal: true
  includeOwnedProjects: true
  includeFutureOwnedProjects: true
  includeArchived: false
  excludedCategories: typeof SEMANTIC_EGRESS_EXCLUDED_CATEGORIES
}

export interface SemanticEgressDisclosureVersion {
  revision: typeof SEMANTIC_EGRESS_DISCLOSURE_REVISION
  hash: string
  destination: 'openrouter'
  dataClasses: readonly ['query', 'chunks']
  scopePolicy: 'profile-global-and-owned-projects'
  dataCollectionDenyRequested: true
}

export interface SemanticEgressConsentBinding extends SemanticEgressConsentSlot {
  provider: 'openrouter'
  connectionId: string
  connectionRevision: string
  descriptor: Readonly<EmbeddingDescriptor>
  semanticDescriptorId: string
  scope: SemanticEgressConsentScope
  disclosure: SemanticEgressDisclosureVersion
}

interface SemanticEgressConsentRecordCommonV1 {
  schemaVersion: 1
  authorityId: string
  revision: number
  generation: number
  binding: SemanticEgressConsentBinding
  createdAt: string
  updatedAt: string
}

export interface SemanticEgressPendingConsentV1 {
  bootId: string
  authorityRevision: number
  generation: number
  actionId: string
  actionHash: string
  cardId: string
  nonceId: string
  issuedAt: string
  expiresAt: string
  invalidatedAt: string | null
}

export interface SemanticEgressAwaitingConsentRecordV1
  extends SemanticEgressConsentRecordCommonV1 {
  state: 'AWAITING_CONSENT'
  pending: SemanticEgressPendingConsentV1
}

interface SemanticEgressConsentRecordBaseV1
  extends SemanticEgressConsentRecordCommonV1 {
  approval: {
    bootId: string
    authorityRevision: number
    generation: number
    actionId: string
    actionHash: string
    cardId: string
    acceptedAt: string
    expiresAt: string
  }
  authorityNonce: {
    nonceId: string
    issuedAt: string
    consumedAt: string
  }
}

export interface SemanticEgressActiveConsentRecordV1
  extends SemanticEgressConsentRecordBaseV1 {
  state: 'CONSENTED' | 'ACTIVE' | 'DEGRADED' | 'SUSPENDED'
}

export interface SemanticEgressRevokingConsentRecordV1
  extends SemanticEgressConsentRecordBaseV1 {
  state: 'REVOKING'
  revokeStartedAt: string
}

export interface SemanticEgressRevokedConsentRecordV1
  extends SemanticEgressConsentRecordBaseV1 {
  state: 'REVOKED'
  revokeStartedAt: string
  purgeCompletedAt: string
  revokedAt: string
}

export interface SemanticEgressBlockedConsentRecordV1
  extends SemanticEgressConsentRecordBaseV1 {
  state: 'BLOCKED'
  blockedAt: string
  blockedCode: string
}

export type SemanticEgressConsentRecordV1 =
  | SemanticEgressAwaitingConsentRecordV1
  | SemanticEgressActiveConsentRecordV1
  | SemanticEgressRevokingConsentRecordV1
  | SemanticEgressRevokedConsentRecordV1
  | SemanticEgressBlockedConsentRecordV1

export interface SemanticEgressConsentChallengeV1 {
  schemaVersion: 1
  authorityId: string
  authorityRevision: number
  generation: number
  binding: SemanticEgressConsentBinding
  bootId: string
  actionId: string
  actionHash: string
  cardId: string
  nonceId: string
  issuedAt: string
  expiresAt: string
  summary: string
}

export interface SemanticEgressConsentNonceRecord {
  nonceId: string
  kind: 'grant' | 'use'
  bindingHash: string
  issuedAt: string
  expiresAt: string
}

export interface SemanticEgressOutboxEventV1 {
  schemaVersion: 1
  eventId: string
  kind:
    | 'memory.semantic_egress.disclosure_issued'
    | 'memory.semantic_egress.consent_granted'
    | 'memory.semantic_egress.activated'
    | 'memory.semantic_egress.degraded'
    | 'memory.semantic_egress.suspended'
    | 'memory.semantic_egress.stale'
    | 'memory.semantic_egress.revoke_started'
    | 'memory.semantic_egress.purge_completed'
    | 'memory.semantic_egress.revoked'
    | 'memory.semantic_egress.blocked'
    | 'memory.semantic_egress.request_started'
    | 'memory.semantic_egress.request_completed'
  operatorId: string
  profileId: string
  purpose: SemanticEgressConsentPurpose
  authorityId: string
  authorityRevision: number
  generation: number
  connectionId: string
  connectionRevision: string
  semanticDescriptorId: string
  disclosureRevision: number
  disclosureHash: string
  code?: string
  at: string
}

export type SemanticEgressNonceMutationV1 =
  | { operation: 'none' }
  | { operation: 'issue'; record: SemanticEgressConsentNonceRecord }
  | {
      operation: 'consume'
      nonceId: string
      kind: SemanticEgressConsentNonceRecord['kind']
      bindingHash: string
      consumedAt: string
    }
  | {
      operation: 'assert-consumed'
      nonceId: string
      kind: SemanticEgressConsentNonceRecord['kind']
      bindingHash: string
    }
  | {
      operation: 'invalidate'
      nonceId: string
      kind: SemanticEgressConsentNonceRecord['kind']
      bindingHash: string
      invalidatedAt: string
    }

export interface SemanticEgressDurableTransitionV1 {
  slot: SemanticEgressConsentSlot
  expectedRevision: number | null
  nextRecord: SemanticEgressConsentRecordV1 | null
  nonce: SemanticEgressNonceMutationV1
  outbox: readonly SemanticEgressOutboxEventV1[]
}

export interface SemanticEgressDurableUseStartV1 {
  slot: SemanticEgressConsentSlot
  authorityId: string
  authorityRevision: number
  generation: number
  bindingHash: string
  nonceId: string
  consumedAt: string
  outbox: SemanticEgressOutboxEventV1
}

export type SemanticEgressDurableTransitionResult =
  | { status: 'committed' }
  | { status: 'cas-conflict' }
  | { status: 'nonce-conflict' }

export interface SemanticEgressBootRecoveryV1 {
  invalidatedCards: Array<{ cardId: string; actionId: string }>
  revoking: SemanticEgressConsentSlot[]
}

export interface SemanticEgressDurableStore {
  load(slot: SemanticEgressConsentSlot): Promise<unknown | null>
  transition(input: SemanticEgressDurableTransitionV1): Promise<SemanticEgressDurableTransitionResult>
  /** Atomically checks exact ACTIVE authority/binding, consumes the use nonce and stores request_started. */
  consumeUseIfActive(input: SemanticEgressDurableUseStartV1): Promise<SemanticEgressDurableTransitionResult>
  recoverForBoot(input: { bootId: string; at: string }): Promise<SemanticEgressBootRecoveryV1>
  /** Returns only unacknowledged events in durable insertion-sequence order. */
  readOutbox(limit: number): Promise<SemanticEgressOutboxEventV1[]>
  /** Acknowledges only the current head; an exact already-acked retry is idempotent. */
  ackOutboxHead(eventId: string): Promise<'acked' | 'already-acked' | 'not-head' | 'unknown'>
}

export interface SemanticEgressUseProofV1 {
  schemaVersion: 1
  proofId: string
  nonceId: string
  authorityId: string
  authorityRevision: number
  generation: number
  bindingHash: string
  issuedAt: string
  expiresAt: string
  mac: string
}

export interface SemanticEgressUseLease {
  readonly proofId: string
  readonly signal: AbortSignal
  /** Runs the only allowed derived-state publication while revoke is excluded. */
  publish<T>(publisher: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Closes an unsuccessful request without publishing derived state. */
  release(): Promise<void>
}

export interface SemanticEgressConsentAuthority {
  load(slot: SemanticEgressConsentSlot): Promise<SemanticEgressConsentRecordV1 | null>
  beginConsent(
    binding: SemanticEgressConsentBinding,
    expectedRevision: number | null,
  ): Promise<SemanticEgressConsentChallengeV1>
  confirmConsent(
    slot: SemanticEgressConsentSlot,
    expectedRevision: number,
    proof: ApprovalProof,
  ): Promise<SemanticEgressActiveConsentRecordV1>
  recoverForBoot(): Promise<SemanticEgressBootRecoveryV1>
  activate(input: {
    binding: SemanticEgressConsentBinding
    expectedRevision: number
  }): Promise<SemanticEgressActiveConsentRecordV1 | SemanticEgressBlockedConsentRecordV1>
  issueUseProof(input: {
    binding: SemanticEgressConsentBinding
    expectedRevision: number
    ttlMs: number
  }): Promise<SemanticEgressUseProofV1>
  consumeUseProof(
    proof: SemanticEgressUseProofV1,
    binding: SemanticEgressConsentBinding,
  ): Promise<SemanticEgressUseLease>
  completeUse(
    proof: SemanticEgressUseProofV1,
    binding: SemanticEgressConsentBinding,
  ): Promise<void>
  setDegraded(slot: SemanticEgressConsentSlot, expectedRevision: number): Promise<SemanticEgressActiveConsentRecordV1>
  suspend(slot: SemanticEgressConsentSlot, expectedRevision: number): Promise<SemanticEgressActiveConsentRecordV1>
  beginRevoke(slot: SemanticEgressConsentSlot, expectedRevision: number): Promise<SemanticEgressRevokingConsentRecordV1>
  completeRevoke(slot: SemanticEgressConsentSlot, expectedRevision: number): Promise<SemanticEgressRevokedConsentRecordV1>
  block(slot: SemanticEgressConsentSlot, expectedRevision: number, code: string): Promise<SemanticEgressBlockedConsentRecordV1>
}

export class SemanticEgressConsentError extends Error {
  constructor(public readonly code:
    | 'INVALID_AUTHORITY_SECRET'
    | 'INVALID_INPUT'
    | 'INVALID_PERSISTED_STATE'
    | 'BINDING_MISMATCH'
    | 'APPROVAL_REQUIRED'
    | 'APPROVAL_MISMATCH'
    | 'APPROVAL_STALE'
    | 'APPROVAL_UNAVAILABLE'
    | 'NONCE_CONSUME_FAILED'
    | 'INVALID_STATE'
    | 'HEALTH_UNAVAILABLE'
    | 'PURGE_FAILED'
    | 'CAS_CONFLICT'
    | 'PROOF_EXPIRED'
    | 'PROOF_INVALID'
    | 'REPLAYED_OR_UNKNOWN'
    | 'STORE_UNAVAILABLE'
    | 'NONCE_UNAVAILABLE'
    | 'EVENT_UNAVAILABLE'
    | 'BOOT_RECOVERY_REQUIRED'
    | 'BOOT_ACTIVATION_REQUIRED',
  ) {
    super(code)
    this.name = 'SemanticEgressConsentError'
  }
}

const PURPOSE: SemanticEgressConsentPurpose = 'memory.semantic-embedding.v1'
export const SEMANTIC_EGRESS_DISCLOSURE_REVISION = 1 as const
export const SEMANTIC_EGRESS_EXCLUDED_CATEGORIES = Object.freeze([
  'monitoring',
  'transcripts',
  'dna-config',
  'attachments',
  'knowledge-zones',
  'archive',
] as const)
export const SEMANTIC_EGRESS_DISCLOSURE_HASH = createHash('sha256')
  .update(JSON.stringify([
    'aisy.semantic-egress.disclosure.v1',
    SEMANTIC_EGRESS_DISCLOSURE_REVISION,
    'openrouter',
    ['query', 'chunks'],
    'profile-global-and-owned-projects',
    true,
    'data_collection=deny is requested by Aisy but is not guaranteed by the provider',
    false,
    [...SEMANTIC_EGRESS_EXCLUDED_CATEGORIES],
  ]), 'utf8')
  .digest('hex')
export const SEMANTIC_EGRESS_SCOPE_V1: SemanticEgressConsentScope = Object.freeze({
  kind: 'profile-memory',
  includeGlobal: true,
  includeOwnedProjects: true,
  includeFutureOwnedProjects: true,
  includeArchived: false,
  excludedCategories: SEMANTIC_EGRESS_EXCLUDED_CATEGORIES,
})
export const SEMANTIC_EGRESS_DISCLOSURE_V1: SemanticEgressDisclosureVersion = Object.freeze({
  revision: SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  hash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
  destination: 'openrouter',
  dataClasses: Object.freeze(['query', 'chunks'] as const),
  scopePolicy: 'profile-global-and-owned-projects',
  dataCollectionDenyRequested: true,
})
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_DATE_MS = 8_640_000_000_000_000
const MAX_APPROVAL_AGE_MS = 15 * 60_000
const GRANT_NONCE_TTL_MS = 5 * 60_000
const MAX_USE_PROOF_TTL_MS = 60_000

const SLOT_KEYS = new Set(['operatorId', 'profileId', 'purpose'])
const BINDING_KEYS = new Set([
  ...SLOT_KEYS,
  'provider',
  'connectionId',
  'connectionRevision',
  'descriptor',
  'semanticDescriptorId',
  'scope',
  'disclosure',
])
const DESCRIPTOR_KEYS = new Set([
  'provider', 'modelId', 'modelRevision', 'dimensions',
  'normalizationVersion', 'chunkerVersion',
])
const SCOPE_KEYS = new Set([
  'kind', 'includeGlobal', 'includeOwnedProjects', 'includeFutureOwnedProjects',
  'includeArchived', 'excludedCategories',
])
const DISCLOSURE_KEYS = new Set([
  'revision', 'hash', 'destination', 'dataClasses', 'scopePolicy',
  'dataCollectionDenyRequested',
])
const APPROVAL_KEYS = new Set([
  'bootId', 'authorityRevision', 'generation', 'actionId', 'actionHash',
  'cardId', 'acceptedAt', 'expiresAt',
])
const APPROVAL_PROOF_KEYS = new Set([
  'cardId', 'actionId', 'actionHash', 'confirmedAt', 'stepUpVerified',
])
const AUTHORITY_NONCE_KEYS = new Set(['nonceId', 'issuedAt', 'consumedAt'])
const BASE_RECORD_KEYS = new Set([
  'schemaVersion', 'authorityId', 'revision', 'generation', 'binding', 'state',
  'approval', 'authorityNonce', 'createdAt', 'updatedAt',
])
const AWAITING_RECORD_KEYS = new Set([
  'schemaVersion', 'authorityId', 'revision', 'generation', 'binding', 'state',
  'pending', 'createdAt', 'updatedAt',
])
const PENDING_KEYS = new Set([
  'bootId', 'authorityRevision', 'generation', 'actionId', 'actionHash',
  'cardId', 'nonceId', 'issuedAt', 'expiresAt', 'invalidatedAt',
])
const USE_PROOF_KEYS = new Set([
  'schemaVersion', 'proofId', 'nonceId', 'authorityId', 'authorityRevision',
  'generation', 'bindingHash', 'issuedAt', 'expiresAt', 'mac',
])
const OUTBOX_KINDS = new Set<SemanticEgressOutboxEventV1['kind']>([
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

function fail(code: SemanticEgressConsentError['code']): never {
  throw new SemanticEgressConsentError(code)
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('INVALID_INPUT')
  }
  return value as Record<string, unknown>
}

function exactObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  try {
    const result = object(value)
    const actual = Reflect.ownKeys(result)
    if (actual.length !== keys.size ||
      actual.some(key => typeof key !== 'string' || !keys.has(key))) {
      return fail('INVALID_INPUT')
    }
    const descriptors = Object.getOwnPropertyDescriptors(result)
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return fail('INVALID_INPUT')
      }
      copy[key] = descriptor.value
    }
    return copy
  } catch (error) {
    if (error instanceof SemanticEgressConsentError) throw error
    return fail('INVALID_INPUT')
  }
}

function clean(value: unknown, maxBytes = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    return fail('INVALID_INPUT')
  }
  return value
}

function id(value: unknown): string {
  const result = clean(value, 128)
  if (!ID.test(result)) return fail('INVALID_INPUT')
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return fail('INVALID_INPUT')
  return value
}

function stableCode(value: unknown): string {
  if (typeof value !== 'string' || !STABLE_CODE.test(value)) return fail('INVALID_INPUT')
  return value
}

function exactDataClasses(value: unknown): readonly ['query', 'chunks'] {
  try {
    if (!Array.isArray(value)) return fail('INVALID_INPUT')
    const keys = Reflect.ownKeys(value)
    if (keys.length !== 3 || keys[0] !== '0' || keys[1] !== '1' || keys[2] !== 'length') {
      return fail('INVALID_INPUT')
    }
    const zero = Object.getOwnPropertyDescriptor(value, '0')
    const one = Object.getOwnPropertyDescriptor(value, '1')
    if (zero === undefined || one === undefined || !Object.hasOwn(zero, 'value') ||
      !Object.hasOwn(one, 'value') || zero.value !== 'query' || one.value !== 'chunks') {
      return fail('INVALID_INPUT')
    }
    return Object.freeze(['query', 'chunks'] as const)
  } catch (error) {
    if (error instanceof SemanticEgressConsentError) throw error
    return fail('INVALID_INPUT')
  }
}

function exactExcludedCategories(value: unknown): typeof SEMANTIC_EGRESS_EXCLUDED_CATEGORIES {
  try {
    if (!Array.isArray(value)) return fail('INVALID_INPUT')
    const keys = Reflect.ownKeys(value)
    if (keys.length !== SEMANTIC_EGRESS_EXCLUDED_CATEGORIES.length + 1 ||
      keys.at(-1) !== 'length') return fail('INVALID_INPUT')
    for (let index = 0; index < SEMANTIC_EGRESS_EXCLUDED_CATEGORIES.length; index += 1) {
      if (keys[index] !== String(index)) return fail('INVALID_INPUT')
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
        descriptor.value !== SEMANTIC_EGRESS_EXCLUDED_CATEGORIES[index]) {
        return fail('INVALID_INPUT')
      }
    }
    return SEMANTIC_EGRESS_EXCLUDED_CATEGORIES
  } catch (error) {
    if (error instanceof SemanticEgressConsentError) throw error
    return fail('INVALID_INPUT')
  }
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail('INVALID_INPUT')
  return Number(value)
}

function instant(value: unknown): string {
  if (typeof value !== 'string') return fail('INVALID_INPUT')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return fail('INVALID_INPUT')
  }
  return value
}

function nowIso(nowMs: () => number): string {
  const now = nowMs()
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
    return fail('INVALID_INPUT')
  }
  return new Date(now).toISOString()
}

function validateSlot(value: unknown): SemanticEgressConsentSlot {
  const raw = exactObject(value, SLOT_KEYS)
  if (raw['purpose'] !== PURPOSE) return fail('INVALID_INPUT')
  return {
    operatorId: clean(raw['operatorId']),
    profileId: clean(raw['profileId']),
    purpose: PURPOSE,
  }
}

function validateDescriptor(value: unknown): Readonly<EmbeddingDescriptor> {
  const raw = exactObject(value, DESCRIPTOR_KEYS)
  if (raw['provider'] !== 'openrouter') return fail('INVALID_INPUT')
  const descriptor: EmbeddingDescriptor = {
    provider: 'openrouter',
    modelId: clean(raw['modelId'], 512),
    modelRevision: clean(raw['modelRevision'], 512),
    dimensions: positiveInteger(raw['dimensions']),
    normalizationVersion: clean(raw['normalizationVersion'], 512),
    chunkerVersion: clean(raw['chunkerVersion'], 512),
  }
  if (descriptor.dimensions > 65_536) return fail('INVALID_INPUT')
  return Object.freeze(descriptor)
}

function validateScope(value: unknown): SemanticEgressConsentScope {
  const raw = exactObject(value, SCOPE_KEYS)
  if (raw['kind'] !== 'profile-memory' || raw['includeGlobal'] !== true ||
    raw['includeOwnedProjects'] !== true || raw['includeFutureOwnedProjects'] !== true ||
    raw['includeArchived'] !== false) {
    return fail('INVALID_INPUT')
  }
  exactExcludedCategories(raw['excludedCategories'])
  return SEMANTIC_EGRESS_SCOPE_V1
}

function validateDisclosure(value: unknown): SemanticEgressDisclosureVersion {
  const raw = exactObject(value, DISCLOSURE_KEYS)
  if (raw['revision'] !== SEMANTIC_EGRESS_DISCLOSURE_REVISION ||
    raw['hash'] !== SEMANTIC_EGRESS_DISCLOSURE_HASH ||
    raw['destination'] !== 'openrouter' ||
    raw['scopePolicy'] !== 'profile-global-and-owned-projects' ||
    raw['dataCollectionDenyRequested'] !== true) {
    return fail('INVALID_INPUT')
  }
  exactDataClasses(raw['dataClasses'])
  return SEMANTIC_EGRESS_DISCLOSURE_V1
}

function validateBinding(value: unknown): SemanticEgressConsentBinding {
  const raw = exactObject(value, BINDING_KEYS)
  if (raw['purpose'] !== PURPOSE || raw['provider'] !== 'openrouter') {
    return fail('INVALID_INPUT')
  }
  const descriptor = validateDescriptor(raw['descriptor'])
  const descriptorId = hash(raw['semanticDescriptorId'])
  if (descriptorId !== computeSemanticDescriptorId(descriptor)) return fail('INVALID_INPUT')
  return Object.freeze({
    operatorId: clean(raw['operatorId']),
    profileId: clean(raw['profileId']),
    purpose: PURPOSE,
    provider: 'openrouter',
    connectionId: clean(raw['connectionId'], 512),
    connectionRevision: clean(raw['connectionRevision'], 512),
    descriptor,
    semanticDescriptorId: descriptorId,
    scope: validateScope(raw['scope']),
    disclosure: validateDisclosure(raw['disclosure']),
  })
}

function slotOf(binding: SemanticEgressConsentBinding): SemanticEgressConsentSlot {
  return {
    operatorId: binding.operatorId,
    profileId: binding.profileId,
    purpose: binding.purpose,
  }
}

function bindingFields(binding: SemanticEgressConsentBinding): readonly unknown[] {
  return [
    'aisy.semantic-egress.binding.v1',
    binding.operatorId,
    binding.profileId,
    binding.purpose,
    binding.provider,
    binding.connectionId,
    binding.connectionRevision,
    binding.descriptor.provider,
    binding.descriptor.modelId,
    binding.descriptor.modelRevision,
    binding.descriptor.dimensions,
    binding.descriptor.normalizationVersion,
    binding.descriptor.chunkerVersion,
    binding.semanticDescriptorId,
    binding.scope.kind,
    binding.scope.includeGlobal,
    binding.scope.includeOwnedProjects,
    binding.scope.includeFutureOwnedProjects,
    binding.scope.includeArchived,
    [...binding.scope.excludedCategories],
    binding.disclosure.revision,
    binding.disclosure.hash,
    binding.disclosure.destination,
    [...binding.disclosure.dataClasses],
    binding.disclosure.scopePolicy,
    binding.disclosure.dataCollectionDenyRequested,
  ]
}

export function semanticEgressBindingHash(rawBinding: SemanticEgressConsentBinding): string {
  const binding = validateBinding(rawBinding)
  return createHash('sha256').update(JSON.stringify(bindingFields(binding)), 'utf8').digest('hex')
}

const bindingHash = semanticEgressBindingHash

function sameBinding(left: SemanticEgressConsentBinding, right: SemanticEgressConsentBinding): boolean {
  return bindingHash(left) === bindingHash(right)
}

function validateApproval(value: unknown): SemanticEgressConsentRecordBaseV1['approval'] {
  const raw = exactObject(value, APPROVAL_KEYS)
  return {
    bootId: id(raw['bootId']),
    authorityRevision: positiveInteger(raw['authorityRevision']),
    generation: positiveInteger(raw['generation']),
    actionId: id(raw['actionId']),
    actionHash: hash(raw['actionHash']),
    cardId: id(raw['cardId']),
    acceptedAt: instant(raw['acceptedAt']),
    expiresAt: instant(raw['expiresAt']),
  }
}

function validateApprovalProof(value: unknown): {
  actionId: string
  actionHash: string
  cardId: string
  acceptedAt: string
} {
  try {
    const raw = exactObject(value, APPROVAL_PROOF_KEYS)
    if (raw['stepUpVerified'] !== true) return fail('APPROVAL_MISMATCH')
    return {
      actionId: id(raw['actionId']),
      actionHash: hash(raw['actionHash']),
      cardId: id(raw['cardId']),
      acceptedAt: instant(raw['confirmedAt']),
    }
  } catch {
    throw new SemanticEgressConsentError('APPROVAL_MISMATCH')
  }
}

function validateAuthorityNonce(value: unknown): SemanticEgressConsentRecordBaseV1['authorityNonce'] {
  const raw = exactObject(value, AUTHORITY_NONCE_KEYS)
  const issuedAt = instant(raw['issuedAt'])
  const consumedAt = instant(raw['consumedAt'])
  if (Date.parse(consumedAt) < Date.parse(issuedAt)) return fail('INVALID_INPUT')
  return { nonceId: id(raw['nonceId']), issuedAt, consumedAt }
}

function validatePendingConsent(value: unknown): SemanticEgressPendingConsentV1 {
  const raw = exactObject(value, PENDING_KEYS)
  const issuedAt = instant(raw['issuedAt'])
  const expiresAt = instant(raw['expiresAt'])
  const invalidatedAt = raw['invalidatedAt'] === null ? null : instant(raw['invalidatedAt'])
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    (invalidatedAt !== null && Date.parse(invalidatedAt) < Date.parse(issuedAt))) {
    return fail('INVALID_INPUT')
  }
  return {
    bootId: id(raw['bootId']),
    authorityRevision: positiveInteger(raw['authorityRevision']),
    generation: positiveInteger(raw['generation']),
    actionId: id(raw['actionId']),
    actionHash: hash(raw['actionHash']),
    cardId: id(raw['cardId']),
    nonceId: id(raw['nonceId']),
    issuedAt,
    expiresAt,
    invalidatedAt,
  }
}

function validatePersistedRecord(value: unknown): SemanticEgressConsentRecordV1 {
  try {
    const candidate = object(value)
    const stateDescriptor = Object.getOwnPropertyDescriptor(candidate, 'state')
    if (stateDescriptor === undefined || !Object.hasOwn(stateDescriptor, 'value')) {
      return fail('INVALID_INPUT')
    }
    const state = stateDescriptor.value
    const stateKeys = state === 'AWAITING_CONSENT'
      ? AWAITING_RECORD_KEYS
      : state === 'REVOKING'
      ? new Set([...BASE_RECORD_KEYS, 'revokeStartedAt'])
      : state === 'REVOKED'
        ? new Set([...BASE_RECORD_KEYS, 'revokeStartedAt', 'purgeCompletedAt', 'revokedAt'])
        : state === 'BLOCKED'
          ? new Set([...BASE_RECORD_KEYS, 'blockedAt', 'blockedCode'])
          : BASE_RECORD_KEYS
    const raw = exactObject(candidate, stateKeys)
    if (raw['schemaVersion'] !== 1 || ![
      'AWAITING_CONSENT', 'CONSENTED', 'ACTIVE', 'DEGRADED', 'SUSPENDED',
      'REVOKING', 'REVOKED', 'BLOCKED',
    ].includes(String(state))) {
      return fail('INVALID_INPUT')
    }
    if (state === 'AWAITING_CONSENT') {
      const authorityId = id(raw['authorityId'])
      const revision = positiveInteger(raw['revision'])
      const generation = positiveInteger(raw['generation'])
      const binding = validateBinding(raw['binding'])
      const createdAt = instant(raw['createdAt'])
      const updatedAt = instant(raw['updatedAt'])
      const pending = validatePendingConsent(raw['pending'])
      const transitionDelta = revision - pending.authorityRevision
      if (pending.issuedAt !== createdAt || Date.parse(updatedAt) < Date.parse(createdAt) ||
        transitionDelta !== generation - pending.generation ||
        (pending.invalidatedAt === null && transitionDelta !== 0) ||
        (pending.invalidatedAt !== null && transitionDelta !== 1) ||
        (pending.invalidatedAt === null && updatedAt !== createdAt) ||
        (pending.invalidatedAt !== null && updatedAt !== pending.invalidatedAt) ||
        pending.actionHash !== semanticEgressConsentActionHash({
          authorityId,
          authorityRevision: pending.authorityRevision,
          generation: pending.generation,
          binding,
          bootId: pending.bootId,
          actionId: pending.actionId,
          cardId: pending.cardId,
          nonceId: pending.nonceId,
          issuedAt: pending.issuedAt,
          expiresAt: pending.expiresAt,
        })) {
        return fail('INVALID_INPUT')
      }
      return {
        schemaVersion: 1,
        authorityId,
        revision,
        generation,
        binding,
        state,
        pending,
        createdAt,
        updatedAt,
      }
    }
    const common: SemanticEgressConsentRecordBaseV1 = {
      schemaVersion: 1,
      authorityId: id(raw['authorityId']),
      revision: positiveInteger(raw['revision']),
      generation: positiveInteger(raw['generation']),
      binding: validateBinding(raw['binding']),
      approval: validateApproval(raw['approval']),
      authorityNonce: validateAuthorityNonce(raw['authorityNonce']),
      createdAt: instant(raw['createdAt']),
      updatedAt: instant(raw['updatedAt']),
    }
    const acceptedAtMs = Date.parse(common.approval.acceptedAt)
    const nonceIssuedAtMs = Date.parse(common.authorityNonce.issuedAt)
    const nonceConsumedAtMs = Date.parse(common.authorityNonce.consumedAt)
    const createdAtMs = Date.parse(common.createdAt)
    const updatedAtMs = Date.parse(common.updatedAt)
    const expiresAtMs = Date.parse(common.approval.expiresAt)
    const transitionDelta = common.revision - common.approval.authorityRevision
    if (nonceIssuedAtMs !== createdAtMs || acceptedAtMs < nonceIssuedAtMs ||
      nonceConsumedAtMs < acceptedAtMs || updatedAtMs < nonceConsumedAtMs ||
      expiresAtMs <= nonceIssuedAtMs || acceptedAtMs >= expiresAtMs ||
      nonceConsumedAtMs >= expiresAtMs || transitionDelta < 1 ||
      transitionDelta !== common.generation - common.approval.generation ||
      common.approval.actionHash !== semanticEgressConsentActionHash({
        authorityId: common.authorityId,
        authorityRevision: common.approval.authorityRevision,
        generation: common.approval.generation,
        binding: common.binding,
        bootId: common.approval.bootId,
        actionId: common.approval.actionId,
        cardId: common.approval.cardId,
        nonceId: common.authorityNonce.nonceId,
        issuedAt: common.authorityNonce.issuedAt,
        expiresAt: common.approval.expiresAt,
      })) {
      return fail('INVALID_INPUT')
    }
    if (state === 'REVOKING') {
      const revokeStartedAt = instant(raw['revokeStartedAt'])
      if (Date.parse(revokeStartedAt) < createdAtMs || revokeStartedAt !== common.updatedAt) {
        return fail('INVALID_INPUT')
      }
      return { ...common, state, revokeStartedAt }
    }
    if (state === 'REVOKED') {
      const revokeStartedAt = instant(raw['revokeStartedAt'])
      const purgeCompletedAt = instant(raw['purgeCompletedAt'])
      const revokedAt = instant(raw['revokedAt'])
      if (Date.parse(revokeStartedAt) < createdAtMs ||
        Date.parse(purgeCompletedAt) < Date.parse(revokeStartedAt) ||
        Date.parse(revokedAt) < Date.parse(purgeCompletedAt) ||
        revokedAt !== common.updatedAt) return fail('INVALID_INPUT')
      return { ...common, state, revokeStartedAt, purgeCompletedAt, revokedAt }
    }
    if (state === 'BLOCKED') {
      const blockedAt = instant(raw['blockedAt'])
      if (Date.parse(blockedAt) < createdAtMs || blockedAt !== common.updatedAt) {
        return fail('INVALID_INPUT')
      }
      return {
        ...common,
        state,
        blockedAt,
        blockedCode: stableCode(raw['blockedCode']),
      }
    }
    return { ...common, state: state as SemanticEgressActiveConsentRecordV1['state'] }
  } catch {
    throw new SemanticEgressConsentError('INVALID_PERSISTED_STATE')
  }
}

function cloneRecord<T extends SemanticEgressConsentRecordV1>(record: T): T {
  return structuredClone(record)
}

function validateUseProof(value: unknown): SemanticEgressUseProofV1 {
  try {
    const raw = exactObject(value, USE_PROOF_KEYS)
    if (raw['schemaVersion'] !== 1) return fail('PROOF_INVALID')
    const issuedAt = instant(raw['issuedAt'])
    const expiresAt = instant(raw['expiresAt'])
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return fail('PROOF_INVALID')
    return {
      schemaVersion: 1,
      proofId: id(raw['proofId']),
      nonceId: id(raw['nonceId']),
      authorityId: id(raw['authorityId']),
      authorityRevision: positiveInteger(raw['authorityRevision']),
      generation: positiveInteger(raw['generation']),
      bindingHash: hash(raw['bindingHash']),
      issuedAt,
      expiresAt,
      mac: hash(raw['mac']),
    }
  } catch {
    throw new SemanticEgressConsentError('PROOF_INVALID')
  }
}

function useProofPayload(proof: Omit<SemanticEgressUseProofV1, 'mac'>): string {
  return JSON.stringify([
    'aisy.semantic-egress.use-proof.v1',
    proof.proofId,
    proof.nonceId,
    proof.authorityId,
    proof.authorityRevision,
    proof.generation,
    proof.bindingHash,
    proof.issuedAt,
    proof.expiresAt,
  ])
}

function safeHashEqual(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function nextRecord<T extends SemanticEgressConsentRecordV1>(
  current: Exclude<SemanticEgressConsentRecordV1, SemanticEgressAwaitingConsentRecordV1>,
  state: SemanticEgressConsentState,
  at: string,
  extra: Record<string, unknown> = {},
): T {
  if (Date.parse(at) < Date.parse(current.updatedAt) ||
    current.revision >= Number.MAX_SAFE_INTEGER || current.generation >= Number.MAX_SAFE_INTEGER) {
    return fail('INVALID_INPUT')
  }
  const base: SemanticEgressConsentRecordBaseV1 = {
    schemaVersion: 1,
    authorityId: current.authorityId,
    revision: current.revision + 1,
    generation: current.generation + 1,
    binding: current.binding,
    approval: current.approval,
    authorityNonce: current.authorityNonce,
    createdAt: current.createdAt,
    updatedAt: at,
  }
  return { ...base, state, ...extra } as T
}

export function semanticEgressOutboxEventId(input: {
  authorityId: string
  authorityRevision: number
  kind: SemanticEgressOutboxEventV1['kind']
}): string {
  if (!OUTBOX_KINDS.has(input.kind)) return fail('INVALID_INPUT')
  return createHash('sha256')
    .update(JSON.stringify([
      'aisy.semantic-egress.outbox-event.v1',
      id(input.authorityId),
      positiveInteger(input.authorityRevision),
      input.kind,
    ]), 'utf8')
    .digest('hex')
}

export function semanticEgressRecoveryEventId(input: {
  bootId: string
  kind: 'memory.semantic_egress.stale' | 'memory.semantic_egress.suspended'
  slot: SemanticEgressConsentSlot
  priorRevision: number
  nextRevision: number
}): string {
  const slot = validateSlot(input.slot)
  const priorRevision = positiveInteger(input.priorRevision)
  const nextRevision = positiveInteger(input.nextRevision)
  if (nextRevision !== priorRevision + 1) return fail('INVALID_INPUT')
  if (input.kind !== 'memory.semantic_egress.stale' &&
    input.kind !== 'memory.semantic_egress.suspended') return fail('INVALID_INPUT')
  return createHash('sha256')
    .update(JSON.stringify([
      'aisy.semantic-egress.recovery-event.v1',
      id(input.bootId),
      input.kind,
      [slot.operatorId, slot.profileId, slot.purpose],
      priorRevision,
      nextRevision,
    ]), 'utf8')
    .digest('hex')
}

export function semanticEgressRequestEventId(
  phase: 'started' | 'completed',
  nonceId: string,
): string {
  if (phase !== 'started' && phase !== 'completed') return fail('INVALID_INPUT')
  return createHash('sha256')
    .update(JSON.stringify([
      'aisy.semantic-egress.request-event.v1',
      phase,
      id(nonceId),
    ]), 'utf8')
    .digest('hex')
}

function consentSummary(binding: SemanticEgressConsentBinding): string {
  return [
    'Разрешить semantic egress памяти',
    `Профиль: ${binding.profileId}`,
    `Назначение: ${binding.purpose}`,
    `Получатель: ${binding.disclosure.destination}`,
    `Подключение: ${binding.connectionId} @ ${binding.connectionRevision}`,
    `Модель: ${binding.descriptor.modelId} @ ${binding.descriptor.modelRevision}`,
    `Размерность: ${binding.descriptor.dimensions}`,
    `Semantic descriptor: ${binding.semanticDescriptorId}`,
    `Disclosure: revision ${binding.disclosure.revision}, hash ${binding.disclosure.hash}`,
    'Данные: query + chunks опубликованной live protected memory',
    'Scope: Global + все текущие и будущие принадлежащие профилю Projects',
    `Исключено: ${binding.scope.excludedCategories.join(', ')}; archive=${binding.scope.includeArchived}`,
    'data_collection=deny запрашивается Aisy, но не гарантируется третьей стороной',
  ].join('\n')
}

export function semanticEgressConsentActionHash(input: {
  authorityId: string
  authorityRevision: number
  generation: number
  binding: SemanticEgressConsentBinding
  bootId: string
  actionId: string
  cardId: string
  nonceId: string
  issuedAt: string
  expiresAt: string
}): string {
  const authorityId = id(input.authorityId)
  const authorityRevision = positiveInteger(input.authorityRevision)
  const generation = positiveInteger(input.generation)
  const binding = validateBinding(input.binding)
  const bootId = id(input.bootId)
  const actionId = id(input.actionId)
  const cardId = id(input.cardId)
  const nonceId = id(input.nonceId)
  const issuedAt = instant(input.issuedAt)
  const expiresAt = instant(input.expiresAt)
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) return fail('INVALID_INPUT')
  return createHash('sha256')
    .update(JSON.stringify([
      'aisy.semantic-egress.consent-action.v1',
      authorityId,
      authorityRevision,
      generation,
      bindingFields(binding),
      bootId,
      actionId,
      cardId,
      nonceId,
      issuedAt,
      expiresAt,
    ]), 'utf8')
    .digest('hex')
}

function strictArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return fail('INVALID_INPUT')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.at(-1) !== 'length') return fail('INVALID_INPUT')
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) return fail('INVALID_INPUT')
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_INPUT')
  }
  return [...value]
}

function validateBootRecovery(value: unknown): SemanticEgressBootRecoveryV1 {
  try {
    const raw = exactObject(value, new Set(['invalidatedCards', 'revoking']))
    const invalidatedCards = strictArray(raw['invalidatedCards']).map(item => {
      const card = exactObject(item, new Set(['cardId', 'actionId']))
      return { cardId: id(card['cardId']), actionId: id(card['actionId']) }
    })
    const revoking = strictArray(raw['revoking']).map(validateSlot)
    const cardKeys = new Set(invalidatedCards.map(item => `${item.cardId}:${item.actionId}`))
    const revokeKeys = new Set(revoking.map(item => JSON.stringify(item)))
    if (cardKeys.size !== invalidatedCards.length || revokeKeys.size !== revoking.length) {
      return fail('INVALID_INPUT')
    }
    return { invalidatedCards, revoking }
  } catch {
    throw new SemanticEgressConsentError('INVALID_PERSISTED_STATE')
  }
}

export function makeSemanticEgressConsentAuthority(deps: {
  secret: Uint8Array
  bootId: string
  durable: SemanticEgressDurableStore
  nowMs(): number
  newId(): string
  health(binding: SemanticEgressConsentBinding): Promise<'healthy' | 'unavailable' | 'revoked'>
  purgeAndVerify(record: SemanticEgressRevokingConsentRecordV1): Promise<boolean>
}): SemanticEgressConsentAuthority {
  if (deps.secret.byteLength < 32) {
    throw new SemanticEgressConsentError('INVALID_AUTHORITY_SECRET')
  }
  const bootId = id(deps.bootId)
  const secret = Buffer.from(deps.secret)
  let recoveryReady = false
  let bootRecoveryRun: Promise<SemanticEgressBootRecoveryV1> | null = null
  interface SlotMutexState {
    tail: Promise<void>
    pending: number
  }
  interface InternalUseLease {
    readonly proof: SemanticEgressUseProofV1
    readonly binding: SemanticEgressConsentBinding
    readonly controller: AbortController
    closed: boolean
    settled: boolean
    readonly settledPromise: Promise<void>
    readonly resolveSettled: () => void
    readonly publicLease: SemanticEgressUseLease
  }
  const activationLeases = new Map<string, {
    authorityId: string
    revision: number
    generation: number
    bindingHash: string
  }>()
  const slotMutexes = new Map<string, SlotMutexState>()
  const inFlightUses = new Map<string, Map<string, InternalUseLease>>()

  const slotKey = (slot: SemanticEgressConsentSlot): string => JSON.stringify([
    slot.operatorId, slot.profileId, slot.purpose,
  ])
  const withSlotLock = async <T>(slot: SemanticEgressConsentSlot, work: () => Promise<T>): Promise<T> => {
    const key = slotKey(slot)
    let state = slotMutexes.get(key)
    if (state === undefined) {
      state = { tail: Promise.resolve(), pending: 0 }
      slotMutexes.set(key, state)
    }
    const previous = state.tail
    let release!: () => void
    state.tail = new Promise<void>(resolve => { release = resolve })
    state.pending += 1
    await previous
    try {
      return await work()
    } finally {
      state.pending -= 1
      release()
      if (state.pending === 0 && slotMutexes.get(key) === state) slotMutexes.delete(key)
    }
  }
  const withSlotLocks = async <T>(
    slots: readonly SemanticEgressConsentSlot[],
    work: () => Promise<T>,
    index = 0,
  ): Promise<T> => {
    const current = slots[index]
    if (current === undefined) return work()
    return withSlotLock(current, () => withSlotLocks(slots, work, index + 1))
  }
  const settleUse = (key: string, lease: InternalUseLease): void => {
    if (lease.settled) return
    lease.closed = true
    lease.settled = true
    const leases = inFlightUses.get(key)
    if (leases?.get(lease.proof.nonceId) === lease) leases.delete(lease.proof.nonceId)
    if (leases?.size === 0) inFlightUses.delete(key)
    lease.resolveSettled()
  }
  const abortUses = (slot: SemanticEgressConsentSlot): void => {
    const key = slotKey(slot)
    const leases = inFlightUses.get(key)
    if (leases === undefined) return
    for (const lease of leases.values()) {
      lease.closed = true
      lease.controller.abort(new SemanticEgressConsentError('INVALID_STATE'))
    }
  }
  const drainUses = async (slot: SemanticEgressConsentSlot): Promise<void> => {
    const leases = inFlightUses.get(slotKey(slot))
    if (leases === undefined) return
    await Promise.all([...leases.values()].map(lease => lease.settledPromise))
  }
  const abortAllUses = (): void => {
    for (const leases of inFlightUses.values()) {
      for (const lease of leases.values()) {
        lease.closed = true
        lease.controller.abort(new SemanticEgressConsentError('INVALID_STATE'))
      }
    }
  }
  const clearActivation = (slot: SemanticEgressConsentSlot): void => {
    activationLeases.delete(slotKey(slot))
  }
  const markActivated = (record: SemanticEgressActiveConsentRecordV1): void => {
    activationLeases.set(slotKey(slotOf(record.binding)), {
      authorityId: record.authorityId,
      revision: record.revision,
      generation: record.generation,
      bindingHash: bindingHash(record.binding),
    })
  }
  const assertActivated = (record: SemanticEgressActiveConsentRecordV1): void => {
    const lease = activationLeases.get(slotKey(slotOf(record.binding)))
    if (lease === undefined || lease.authorityId !== record.authorityId ||
      lease.revision !== record.revision || lease.generation !== record.generation ||
      lease.bindingHash !== bindingHash(record.binding)) {
      throw new SemanticEgressConsentError('BOOT_ACTIVATION_REQUIRED')
    }
  }

  const newId = (): string => id(deps.newId())
  const assertRecoveryReady = (): void => {
    if (!recoveryReady) throw new SemanticEgressConsentError('BOOT_RECOVERY_REQUIRED')
  }
  const signUseProof = (proof: Omit<SemanticEgressUseProofV1, 'mac'>): string =>
    createHmac('sha256', secret).update(useProofPayload(proof), 'utf8').digest('hex')

  const load = async (
    rawSlot: SemanticEgressConsentSlot,
  ): Promise<SemanticEgressConsentRecordV1 | null> => {
    const slot = validateSlot(rawSlot)
    let raw: unknown | null
    try { raw = await deps.durable.load(slot) } catch {
      throw new SemanticEgressConsentError('STORE_UNAVAILABLE')
    }
    if (raw === null) return null
    const record = validatePersistedRecord(raw)
    const persistedSlot = slotOf(record.binding)
    if (JSON.stringify(persistedSlot) !== JSON.stringify(slot)) {
      throw new SemanticEgressConsentError('INVALID_PERSISTED_STATE')
    }
    return cloneRecord(record)
  }

  const requireCurrent = async (
    rawSlot: SemanticEgressConsentSlot,
    expectedRevision: number,
  ): Promise<SemanticEgressConsentRecordV1> => {
    const revision = positiveInteger(expectedRevision)
    const current = await load(rawSlot)
    if (current === null || current.revision !== revision) {
      throw new SemanticEgressConsentError('CAS_CONFLICT')
    }
    return current
  }

  const commit = async (
    slot: SemanticEgressConsentSlot,
    expectedRevision: number | null,
    record: SemanticEgressConsentRecordV1 | null,
    nonce: SemanticEgressNonceMutationV1,
    outbox: readonly SemanticEgressOutboxEventV1[],
  ): Promise<void> => {
    let status: SemanticEgressDurableTransitionResult['status']
    try {
      const result = await deps.durable.transition({
        slot: validateSlot(slot),
        expectedRevision,
        nextRecord: record === null ? null : cloneRecord(record),
        nonce: structuredClone(nonce),
        outbox: structuredClone(outbox),
      })
      const raw = exactObject(result, new Set(['status']))
      if (raw['status'] !== 'committed' && raw['status'] !== 'cas-conflict' &&
        raw['status'] !== 'nonce-conflict') throw new Error('invalid durable result')
      status = raw['status']
    } catch {
      throw new SemanticEgressConsentError('STORE_UNAVAILABLE')
    }
    if (status === 'cas-conflict') throw new SemanticEgressConsentError('CAS_CONFLICT')
    if (status === 'nonce-conflict') {
      throw new SemanticEgressConsentError('REPLAYED_OR_UNKNOWN')
    }
  }

  const commitUseStart = async (input: SemanticEgressDurableUseStartV1): Promise<void> => {
    let status: SemanticEgressDurableTransitionResult['status']
    try {
      const result = await deps.durable.consumeUseIfActive(structuredClone(input))
      const raw = exactObject(result, new Set(['status']))
      if (raw['status'] !== 'committed' && raw['status'] !== 'cas-conflict' &&
        raw['status'] !== 'nonce-conflict') throw new Error('invalid durable result')
      status = raw['status']
    } catch {
      throw new SemanticEgressConsentError('STORE_UNAVAILABLE')
    }
    if (status === 'cas-conflict') throw new SemanticEgressConsentError('CAS_CONFLICT')
    if (status === 'nonce-conflict') {
      throw new SemanticEgressConsentError('REPLAYED_OR_UNKNOWN')
    }
  }

  const event = (
    record: SemanticEgressConsentRecordV1,
    kind: SemanticEgressOutboxEventV1['kind'],
    at: string,
    code?: string,
    eventId?: string,
  ): SemanticEgressOutboxEventV1 => Object.freeze({
      schemaVersion: 1,
      eventId: eventId === undefined
        ? semanticEgressOutboxEventId({
            authorityId: record.authorityId,
            authorityRevision: record.revision,
            kind,
          })
        : hash(eventId),
      kind,
      operatorId: record.binding.operatorId,
      profileId: record.binding.profileId,
      purpose: record.binding.purpose,
      authorityId: record.authorityId,
      authorityRevision: record.revision,
      generation: record.generation,
      connectionId: record.binding.connectionId,
      connectionRevision: record.binding.connectionRevision,
      semanticDescriptorId: record.binding.semanticDescriptorId,
      disclosureRevision: record.binding.disclosure.revision,
      disclosureHash: record.binding.disclosure.hash,
      ...(code === undefined ? {} : { code: stableCode(code) }),
      at,
    })

  const persist = async <T extends SemanticEgressConsentRecordV1>(
    expectedRevision: number | null,
    record: T,
    events: readonly SemanticEgressOutboxEventV1[],
    nonce: SemanticEgressNonceMutationV1 = { operation: 'none' },
  ): Promise<T> => {
    await commit(slotOf(record.binding), expectedRevision, record, nonce, events)
    return cloneRecord(record)
  }

  const persistBlocked = async (
    current: Exclude<SemanticEgressConsentRecordV1, SemanticEgressAwaitingConsentRecordV1>,
    code: string,
    at: string,
  ): Promise<SemanticEgressBlockedConsentRecordV1> => {
    const record = nextRecord<SemanticEgressBlockedConsentRecordV1>(
      current,
      'BLOCKED',
      at,
      { blockedAt: at, blockedCode: stableCode(code) },
    )
    const saved = await persist(current.revision, record, [
      event(record, 'memory.semantic_egress.blocked', at, code),
    ])
    return saved
  }

  const signedProofContext = async (
    rawProof: SemanticEgressUseProofV1,
    rawBinding: SemanticEgressConsentBinding,
  ): Promise<{
    proof: SemanticEgressUseProofV1
    binding: SemanticEgressConsentBinding
    current: SemanticEgressActiveConsentRecordV1
    expiresAtMs: number
  }> => {
    const proof = validateUseProof(rawProof)
    const binding = validateBinding(rawBinding)
    const current = await load(slotOf(binding))
    if (current === null || current.state !== 'ACTIVE') {
      throw new SemanticEgressConsentError('INVALID_STATE')
    }
    assertActivated(current)
    const expectedBindingHash = bindingHash(binding)
    if (!sameBinding(current.binding, binding) ||
      proof.authorityId !== current.authorityId ||
      proof.authorityRevision !== current.revision ||
      proof.generation !== current.generation ||
      proof.bindingHash !== expectedBindingHash) {
      throw new SemanticEgressConsentError('BINDING_MISMATCH')
    }
    const issuedAtMs = Date.parse(proof.issuedAt)
    const expiresAtMs = Date.parse(proof.expiresAt)
    if (expiresAtMs - issuedAtMs > MAX_USE_PROOF_TTL_MS) {
      throw new SemanticEgressConsentError('PROOF_INVALID')
    }
    const unsigned: Omit<SemanticEgressUseProofV1, 'mac'> = {
      schemaVersion: 1,
      proofId: proof.proofId,
      nonceId: proof.nonceId,
      authorityId: proof.authorityId,
      authorityRevision: proof.authorityRevision,
      generation: proof.generation,
      bindingHash: proof.bindingHash,
      issuedAt: proof.issuedAt,
      expiresAt: proof.expiresAt,
    }
    if (!safeHashEqual(proof.mac, signUseProof(unsigned))) {
      throw new SemanticEgressConsentError('PROOF_INVALID')
    }
    return { proof, binding, current, expiresAtMs }
  }

  return Object.freeze<SemanticEgressConsentAuthority>({
    load,

    async beginConsent(rawBinding, rawExpectedRevision) {
      assertRecoveryReady()
      const binding = validateBinding(rawBinding)
      const slot = slotOf(binding)
      const expectedRevision = rawExpectedRevision === null
        ? null
        : positiveInteger(rawExpectedRevision)
      clearActivation(slot)
      const current = await load(slot)
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new SemanticEgressConsentError('CAS_CONFLICT')
      }
      if (current !== null && current.state !== 'REVOKED' &&
        !(current.state === 'AWAITING_CONSENT' && current.pending.invalidatedAt !== null)) {
        throw new SemanticEgressConsentError('INVALID_STATE')
      }
      const now = deps.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS - GRANT_NONCE_TTL_MS) {
        throw new SemanticEgressConsentError('INVALID_INPUT')
      }
      const issuedAt = new Date(now).toISOString()
      const expiresAt = new Date(now + GRANT_NONCE_TTL_MS).toISOString()
      const authorityId = newId()
      const revision = current === null ? 1 : current.revision + 1
      const generation = current === null ? 1 : current.generation + 1
      const actionId = newId()
      const cardId = newId()
      const nonceId = newId()
      const actionHash = semanticEgressConsentActionHash({
        authorityId,
        authorityRevision: revision,
        generation,
        binding,
        bootId,
        actionId,
        cardId,
        nonceId,
        issuedAt,
        expiresAt,
      })
      const record: SemanticEgressAwaitingConsentRecordV1 = {
        schemaVersion: 1,
        authorityId,
        revision,
        generation,
        binding,
        state: 'AWAITING_CONSENT',
        pending: {
          bootId,
          authorityRevision: revision,
          generation,
          actionId,
          actionHash,
          cardId,
          nonceId,
          issuedAt,
          expiresAt,
          invalidatedAt: null,
        },
        createdAt: issuedAt,
        updatedAt: issuedAt,
      }
      await persist(expectedRevision, record, [
        event(record, 'memory.semantic_egress.disclosure_issued', issuedAt),
      ], {
        operation: 'issue',
        record: { nonceId, kind: 'grant', bindingHash: actionHash, issuedAt, expiresAt },
      })
      return Object.freeze({
        schemaVersion: 1,
        authorityId,
        authorityRevision: revision,
        generation,
        binding,
        bootId,
        actionId,
        actionHash,
        cardId,
        nonceId,
        issuedAt,
        expiresAt,
        summary: consentSummary(binding),
      })
    },

    async confirmConsent(rawSlot, rawExpectedRevision, rawProof) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      const expectedRevision = positiveInteger(rawExpectedRevision)
      const proof = validateApprovalProof(rawProof)
      const current = await requireCurrent(slot, expectedRevision)
      if (current.state !== 'AWAITING_CONSENT' || current.pending.invalidatedAt !== null) {
        throw new SemanticEgressConsentError('INVALID_STATE')
      }
      const pending = current.pending
      if (pending.bootId !== bootId || proof.actionId !== pending.actionId ||
        proof.actionHash !== pending.actionHash || proof.cardId !== pending.cardId) {
        throw new SemanticEgressConsentError('APPROVAL_MISMATCH')
      }
      const now = deps.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
        throw new SemanticEgressConsentError('INVALID_INPUT')
      }
      const confirmedAtMs = Date.parse(proof.acceptedAt)
      if (confirmedAtMs < Date.parse(pending.issuedAt) || confirmedAtMs > now ||
        confirmedAtMs >= Date.parse(pending.expiresAt) || now >= Date.parse(pending.expiresAt)) {
        throw new SemanticEgressConsentError('APPROVAL_STALE')
      }
      const consumedAt = new Date(now).toISOString()
      const record: SemanticEgressActiveConsentRecordV1 = {
        schemaVersion: 1,
        authorityId: current.authorityId,
        revision: current.revision + 1,
        generation: current.generation + 1,
        binding: current.binding,
        state: 'CONSENTED',
        approval: {
          bootId: pending.bootId,
          authorityRevision: pending.authorityRevision,
          generation: pending.generation,
          actionId: pending.actionId,
          actionHash: pending.actionHash,
          cardId: pending.cardId,
          acceptedAt: proof.acceptedAt,
          expiresAt: pending.expiresAt,
        },
        authorityNonce: {
          nonceId: pending.nonceId,
          issuedAt: pending.issuedAt,
          consumedAt,
        },
        createdAt: current.createdAt,
        updatedAt: consumedAt,
      }
      return persist(current.revision, record, [
        event(record, 'memory.semantic_egress.consent_granted', consumedAt),
      ], {
        operation: 'consume',
        nonceId: pending.nonceId,
        kind: 'grant',
        bindingHash: pending.actionHash,
        consumedAt,
      })
    },

    async recoverForBoot() {
      if (bootRecoveryRun !== null) return structuredClone(await bootRecoveryRun)
      activationLeases.clear()
      recoveryReady = false
      // Signal already-running code immediately; slot locks below prevent its
      // publication callback from crossing the durable recovery boundary.
      abortAllUses()
      const slots = [...inFlightUses.values()]
        .map(leases => leases.values().next().value as InternalUseLease | undefined)
        .filter((lease): lease is InternalUseLease => lease !== undefined)
        .map(lease => slotOf(lease.binding))
        .sort((left, right) => slotKey(left).localeCompare(slotKey(right)))
      const run = withSlotLocks(slots, async () => {
        abortAllUses()
        const at = nowIso(deps.nowMs)
        let recovery: SemanticEgressBootRecoveryV1
        try {
          recovery = await deps.durable.recoverForBoot({ bootId, at })
        } catch {
          throw new SemanticEgressConsentError('STORE_UNAVAILABLE')
        }
        const validated = structuredClone(validateBootRecovery(recovery))
        recoveryReady = true
        return validated
      })
      bootRecoveryRun = run
      try {
        return structuredClone(await run)
      } finally {
        if (bootRecoveryRun === run) bootRecoveryRun = null
      }
    },

    async activate(input) {
      assertRecoveryReady()
      const binding = validateBinding(input.binding)
      const slot = slotOf(binding)
      clearActivation(slot)
      const current = await requireCurrent(slot, input.expectedRevision)
      if (current.state === 'AWAITING_CONSENT') {
        throw new SemanticEgressConsentError('INVALID_STATE')
      }
      if (!sameBinding(current.binding, binding)) {
        return persistBlocked(current, 'BINDING_MISMATCH', nowIso(deps.nowMs))
      }
      if (!['CONSENTED', 'ACTIVE', 'DEGRADED', 'SUSPENDED'].includes(current.state)) {
        throw new SemanticEgressConsentError('INVALID_STATE')
      }
      const activatable = current as SemanticEgressActiveConsentRecordV1
      let health: 'healthy' | 'unavailable' | 'revoked'
      try { health = await deps.health(binding) } catch { health = 'unavailable' }
      if (health === 'revoked') {
        return persistBlocked(current, 'CONNECTION_REVOKED', nowIso(deps.nowMs))
      }
      if (health !== 'healthy') {
        if (activatable.state === 'DEGRADED') return cloneRecord(activatable)
        if (activatable.state !== 'ACTIVE') {
          throw new SemanticEgressConsentError('HEALTH_UNAVAILABLE')
        }
        const at = nowIso(deps.nowMs)
        const next = nextRecord<SemanticEgressActiveConsentRecordV1>(activatable, 'DEGRADED', at)
        const saved = await persist(activatable.revision, next, [
          event(next, 'memory.semantic_egress.degraded', at, 'HEALTH_UNAVAILABLE'),
        ])
        return saved
      }
      const at = nowIso(deps.nowMs)
      const next = nextRecord<SemanticEgressActiveConsentRecordV1>(activatable, 'ACTIVE', at)
      const saved = await persist(activatable.revision, next, [
        event(next, 'memory.semantic_egress.activated', at),
      ])
      markActivated(saved)
      return saved
    },

    async issueUseProof(input) {
      assertRecoveryReady()
      const binding = validateBinding(input.binding)
      const current = await requireCurrent(slotOf(binding), input.expectedRevision)
      if (current.state !== 'ACTIVE') throw new SemanticEgressConsentError('INVALID_STATE')
      assertActivated(current)
      if (!sameBinding(current.binding, binding)) {
        throw new SemanticEgressConsentError('BINDING_MISMATCH')
      }
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 ||
        input.ttlMs > MAX_USE_PROOF_TTL_MS) {
        throw new SemanticEgressConsentError('INVALID_INPUT')
      }
      const now = deps.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS - input.ttlMs) {
        throw new SemanticEgressConsentError('INVALID_INPUT')
      }
      const issuedAt = new Date(now).toISOString()
      const expiresAt = new Date(now + input.ttlMs).toISOString()
      const unsigned: Omit<SemanticEgressUseProofV1, 'mac'> = {
        schemaVersion: 1,
        proofId: newId(),
        nonceId: newId(),
        authorityId: current.authorityId,
        authorityRevision: current.revision,
        generation: current.generation,
        bindingHash: bindingHash(binding),
        issuedAt,
        expiresAt,
      }
      const proof: SemanticEgressUseProofV1 = { ...unsigned, mac: signUseProof(unsigned) }
      await commit(slotOf(binding), current.revision, null, {
        operation: 'issue',
        record: {
          nonceId: proof.nonceId,
          kind: 'use',
          bindingHash: proof.bindingHash,
          issuedAt,
          expiresAt,
        },
      }, [])
      return Object.freeze({ ...proof })
    },

    async consumeUseProof(rawProof, rawBinding) {
      assertRecoveryReady()
      const binding = validateBinding(rawBinding)
      const slot = slotOf(binding)
      return withSlotLock(slot, async () => {
        assertRecoveryReady()
        const { proof, current, expiresAtMs } = await signedProofContext(rawProof, binding)
        const now = deps.nowMs()
        if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
          throw new SemanticEgressConsentError('PROOF_INVALID')
        }
        if (now < Date.parse(proof.issuedAt)) {
          throw new SemanticEgressConsentError('PROOF_INVALID')
        }
        if (now >= expiresAtMs) throw new SemanticEgressConsentError('PROOF_EXPIRED')
        const consumedAt = new Date(now).toISOString()
        const key = slotKey(slot)
        const controller = new AbortController()
        let resolveSettled!: () => void
        const settledPromise = new Promise<void>(resolve => { resolveSettled = resolve })
        let internal!: InternalUseLease
        const completeRequest = async (
          requestRecord: SemanticEgressActiveConsentRecordV1,
          code?: string,
        ): Promise<void> => {
          const at = nowIso(deps.nowMs)
          await commit(slot, requestRecord.revision, null, {
            operation: 'assert-consumed',
            nonceId: proof.nonceId,
            kind: 'use',
            bindingHash: proof.bindingHash,
          }, [event(
            requestRecord,
            'memory.semantic_egress.request_completed',
            at,
            code,
            semanticEgressRequestEventId('completed', proof.nonceId),
          )])
        }
        const publicLease = Object.freeze<SemanticEgressUseLease>({
          proofId: proof.proofId,
          signal: controller.signal,
          async publish<T>(publisher: (signal: AbortSignal) => Promise<T>): Promise<T> {
            if (typeof publisher !== 'function') throw new SemanticEgressConsentError('INVALID_INPUT')
            return withSlotLock(slot, async () => {
              const leases = inFlightUses.get(key)
              if (internal.closed || controller.signal.aborted ||
                leases?.get(proof.nonceId) !== internal) {
                settleUse(key, internal)
                throw new SemanticEgressConsentError('INVALID_STATE')
              }
              let context: Awaited<ReturnType<typeof signedProofContext>>
              try {
                context = await signedProofContext(proof, binding)
              } catch (error) {
                settleUse(key, internal)
                throw error
              }
              let result: T
              try {
                result = await publisher(controller.signal)
              } catch (error) {
                try {
                  await completeRequest(context.current, 'PUBLISH_FAILED')
                } finally {
                  settleUse(key, internal)
                }
                throw error
              }
              try {
                await completeRequest(context.current)
              } finally {
                settleUse(key, internal)
              }
              return result
            })
          },
          async release(): Promise<void> {
            await withSlotLock(slot, async () => {
              if (internal.settled) return
              if (internal.closed) {
                settleUse(key, internal)
                return
              }
              try {
                const context = await signedProofContext(proof, binding)
                await completeRequest(context.current, 'REQUEST_RELEASED')
              } finally {
                settleUse(key, internal)
              }
            })
          },
        })
        internal = {
          proof,
          binding,
          controller,
          closed: false,
          settled: false,
          settledPromise,
          resolveSettled,
          publicLease,
        }
        let leases = inFlightUses.get(key)
        if (leases === undefined) {
          leases = new Map()
          inFlightUses.set(key, leases)
        }
        if (leases.has(proof.nonceId)) {
          throw new SemanticEgressConsentError('REPLAYED_OR_UNKNOWN')
        }
        leases.set(proof.nonceId, internal)
        try {
          await commitUseStart({
            slot,
            authorityId: current.authorityId,
            authorityRevision: current.revision,
            generation: current.generation,
            bindingHash: proof.bindingHash,
            nonceId: proof.nonceId,
            consumedAt,
            outbox: event(
              current,
              'memory.semantic_egress.request_started',
              consumedAt,
              undefined,
              semanticEgressRequestEventId('started', proof.nonceId),
            ),
          })
        } catch (error) {
          settleUse(key, internal)
          throw error
        }
        return publicLease
      })
    },

    async completeUse(rawProof, rawBinding) {
      assertRecoveryReady()
      const proof = validateUseProof(rawProof)
      const binding = validateBinding(rawBinding)
      const lease = inFlightUses.get(slotKey(slotOf(binding)))?.get(proof.nonceId)
      if (lease === undefined || JSON.stringify(lease.proof) !== JSON.stringify(proof)) {
        throw new SemanticEgressConsentError('REPLAYED_OR_UNKNOWN')
      }
      if (!sameBinding(lease.binding, binding)) {
        throw new SemanticEgressConsentError('BINDING_MISMATCH')
      }
      await lease.publicLease.publish(async () => undefined)
    },

    async setDegraded(rawSlot, expectedRevision) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      clearActivation(slot)
      abortUses(slot)
      return withSlotLock(slot, async () => {
        clearActivation(slot)
        try {
          const current = await requireCurrent(slot, expectedRevision)
          if (current.state !== 'ACTIVE' && current.state !== 'DEGRADED') {
            throw new SemanticEgressConsentError('INVALID_STATE')
          }
          const at = nowIso(deps.nowMs)
          const next = nextRecord<SemanticEgressActiveConsentRecordV1>(current, 'DEGRADED', at)
          return await persist(current.revision, next, [
            event(next, 'memory.semantic_egress.degraded', at, 'HEALTH_UNAVAILABLE'),
          ])
        } finally {
          abortUses(slot)
        }
      })
    },

    async suspend(rawSlot, expectedRevision) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      clearActivation(slot)
      abortUses(slot)
      return withSlotLock(slot, async () => {
        clearActivation(slot)
        try {
          const current = await requireCurrent(slot, expectedRevision)
          if (!['CONSENTED', 'ACTIVE', 'DEGRADED', 'SUSPENDED'].includes(current.state)) {
            throw new SemanticEgressConsentError('INVALID_STATE')
          }
          const suspendable = current as SemanticEgressActiveConsentRecordV1
          const at = nowIso(deps.nowMs)
          const next = nextRecord<SemanticEgressActiveConsentRecordV1>(suspendable, 'SUSPENDED', at)
          return await persist(suspendable.revision, next, [
            event(next, 'memory.semantic_egress.suspended', at),
          ])
        } finally {
          abortUses(slot)
        }
      })
    },

    async beginRevoke(rawSlot, expectedRevision) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      clearActivation(slot)
      abortUses(slot)
      return withSlotLock(slot, async () => {
        clearActivation(slot)
        try {
          const current = await requireCurrent(slot, expectedRevision)
          if (current.state === 'REVOKING') return cloneRecord(current)
          if (current.state === 'REVOKED' || current.state === 'AWAITING_CONSENT') {
            throw new SemanticEgressConsentError('INVALID_STATE')
          }
          const at = nowIso(deps.nowMs)
          const next = nextRecord<SemanticEgressRevokingConsentRecordV1>(
            current,
            'REVOKING',
            at,
            { revokeStartedAt: at },
          )
          // The generation-changing REVOKING record is the durable terminal fence for
          // request_started entries whose owners now settle without publishing.
          return await persist(current.revision, next, [
            event(next, 'memory.semantic_egress.revoke_started', at),
          ])
        } finally {
          // A failed or ambiguous durable write still closes the process-local gate.
          abortUses(slot)
        }
      })
    },

    async completeRevoke(rawSlot, expectedRevision) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      await withSlotLock(slot, async () => {
        clearActivation(slot)
        const current = await requireCurrent(slot, expectedRevision)
        if (current.state !== 'REVOKING') throw new SemanticEgressConsentError('INVALID_STATE')
        abortUses(slot)
      })
      await drainUses(slot)
      return withSlotLock(slot, async () => {
        clearActivation(slot)
        const current = await requireCurrent(slot, expectedRevision)
        if (current.state !== 'REVOKING') throw new SemanticEgressConsentError('INVALID_STATE')
        let purged: boolean
        try { purged = await deps.purgeAndVerify(cloneRecord(current)) } catch { purged = false }
        if (purged !== true) throw new SemanticEgressConsentError('PURGE_FAILED')
        const at = nowIso(deps.nowMs)
        const next = nextRecord<SemanticEgressRevokedConsentRecordV1>(
          current,
          'REVOKED',
          at,
          {
            revokeStartedAt: current.revokeStartedAt,
            purgeCompletedAt: at,
            revokedAt: at,
          },
        )
        const saved = await persist(current.revision, next, [
          event(next, 'memory.semantic_egress.purge_completed', at),
          event(next, 'memory.semantic_egress.revoked', at),
        ])
        return saved
      })
    },

    async block(rawSlot, expectedRevision, rawCode) {
      assertRecoveryReady()
      const slot = validateSlot(rawSlot)
      const code = stableCode(rawCode)
      clearActivation(slot)
      abortUses(slot)
      return withSlotLock(slot, async () => {
        clearActivation(slot)
        try {
          const current = await requireCurrent(slot, expectedRevision)
          if (current.state === 'REVOKED' || current.state === 'AWAITING_CONSENT') {
            throw new SemanticEgressConsentError('INVALID_STATE')
          }
          if (current.state === 'BLOCKED' && current.blockedCode === code) {
            return cloneRecord(current)
          }
          return await persistBlocked(current, code, nowIso(deps.nowMs))
        } finally {
          abortUses(slot)
        }
      })
    },
  })
}

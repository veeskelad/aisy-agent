// Dormant manager-owned provider/tool adapter for durable delegation operations.
// Nothing in the production import graph imports this module yet.

import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import {
  canonicalizeIterationCost,
  isGenuineToolExecutionContextFor,
  iterationCostSpendNanos,
  runtimeToolDefinition,
  validateDelegationExecutionAuthority,
  type DelegationAuthorityJournal,
  type DelegationExecutionAuthorityV1,
  type IterationCost,
  type ModelProgressSink,
  type ModelRequest,
  type ModelResponse,
  type ProviderAdapter,
  type ShardEntry,
  type ToolCall,
  type ToolExecutionContext,
  type ToolResult,
} from '@aisy/core'
import {
  makeDurableDelegationRecoverableInterruption,
  type DurableDelegationVerification,
} from './durable-delegation-runtime.js'
import {
  hashDurableDelegationOperationLogicalSlotV2,
  hashDurableDelegationOperationRequestV2,
  hashDurableDelegationOperationRequestV1,
  type DurableDelegationOperationJournalV1,
  type DurableDelegationOperationJournalV2,
  type DurableDelegationOperationKeyV1,
  type DurableDelegationOperationKeyV2,
  type DurableDelegationOperationReceiptV1,
  type DurableDelegationOperationStateV1,
} from './durable-delegation-operation-journal.js'
import {
  assertDurableDelegationBoundOperationControlAttestationV1,
  DurableDelegationOperationControlError,
  type DurableDelegationBoundOperationControlAttestationV1,
  type DurableDelegationBoundOperationControlV1,
  type DurableDelegationLogicalOperationV2,
  type DurableDelegationOperationAttemptViewV1,
  type DurableDelegationOperationControlBindingV1,
  type DurableDelegationOperationEvidenceV2,
  type DurableDelegationOperationReceiptEvidenceV1,
  type DurableDelegationOperationResolutionAuthorityV1,
  type DurableDelegationOperationSlotViewV1,
} from './durable-delegation-operation-control.js'

export type DurableDelegationLiveAdapterErrorCode =
  | 'DURABLE_DELEGATION_LIVE_CONFIG_INVALID'
  | 'DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID'
  | 'DURABLE_DELEGATION_LIVE_CONTEXT_INVALID'
  | 'DURABLE_DELEGATION_LIVE_OPERATION_STOPPED'
  | 'DURABLE_DELEGATION_LIVE_OPERATION_DRIFT'
  | 'DURABLE_DELEGATION_LIVE_QUOTE_REQUIRED'
  | 'DURABLE_DELEGATION_LIVE_COST_EXCEEDED'
  | 'DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED'

export class DurableDelegationLiveAdapterError extends Error {
  constructor(readonly code: DurableDelegationLiveAdapterErrorCode) {
    super(code)
    this.name = 'DurableDelegationLiveAdapterError'
  }
}

export interface DurableDelegationOperationEvidenceV1 {
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly canonicalRequestHash: string
  readonly resultHash: string
  readonly spendUsdNanos: number
  readonly wallMs: number
  readonly effect: 'none' | 'read' | 'mutation'
  readonly evidenceHash?: string
  readonly actionStatus?: 'verified' | 'unverified'
  readonly outcome: 'completed' | 'stopped'
}

export interface DurableDelegationVerifierInputV1 {
  readonly schemaVersion: 1
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly candidate: unknown
  readonly shard: readonly ShardEntry[]
  readonly cost: Readonly<IterationCost>
  readonly operations: readonly DurableDelegationOperationEvidenceV1[]
}

export interface DurableDelegationLiveAdapterV1 {
  readonly provider: ProviderAdapter
  executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>
  readCost(): IterationCost
  verify(candidate: unknown, signal?: AbortSignal): Promise<DurableDelegationVerification>
}

export interface DurableDelegationCancellationReceiptV1 {
  readonly spendUsdNanos: number
  readonly wallMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface DurableDelegationProviderReceiptV1 {
  readonly spendUsdNanos: number
  readonly wallMs: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export interface DurableDelegationProviderFinalizedV1 {
  readonly output: ModelResponse
  readonly receipt: DurableDelegationProviderReceiptV1
}

export interface DurableDelegationToolReceiptV1 {
  readonly spendUsdNanos: number
  readonly wallMs: number
  readonly effect: 'none' | 'read' | 'mutation'
  readonly evidenceHash?: string
  readonly actionStatus: 'verified' | 'unverified'
}

export interface DurableDelegationToolFinalizedV1 {
  readonly output: ToolResult
  readonly receipt: DurableDelegationToolReceiptV1
}

export type DurableDelegationCancellationAckV1 =
  | Readonly<{
      kind: 'durable-delegation-cancellation-ack-v1'
      state: 'stopped'
      receipt: Readonly<DurableDelegationCancellationReceiptV1>
    }>
  | Readonly<{
      kind: 'durable-delegation-cancellation-ack-v1'
      state: 'ambiguous'
    }>

export interface DurableDelegationOwnedOperationV1<T> {
  /** Resolves only after the owned external operation has finished cleanup. */
  readonly result: Promise<T>
  /** Returns a module-issued acknowledgement only after interrupt + cleanup. */
  cancel(): Promise<DurableDelegationCancellationAckV1>
}

export interface DurableDelegationProviderOperationPortV1 {
  start(
    request: ModelRequest,
    signal?: AbortSignal,
    onProgress?: ModelProgressSink,
  ): DurableDelegationOwnedOperationV1<DurableDelegationProviderFinalizedV1>
}

export interface DurableDelegationToolOperationPortV1 {
  start(
    call: ToolCall,
    context: ToolExecutionContext,
  ): DurableDelegationOwnedOperationV1<DurableDelegationToolFinalizedV1>
}

export interface DurableDelegationLiveAdapterInputV1 {
  readonly journal: DurableDelegationOperationJournalV1
  readonly authority: DelegationExecutionAuthorityV1
  readonly authorityJournal: DelegationAuthorityJournal
  readonly childTurnId: string
  readonly providerIdentityHash: string
  readonly policyRevision: string
  readonly provider: DurableDelegationProviderOperationPortV1
  readonly tool: DurableDelegationToolOperationPortV1
  readonly verifier: (
    input: DurableDelegationVerifierInputV1,
    signal?: AbortSignal,
  ) => Promise<DurableDelegationVerification>
}

export interface DurableDelegationOperationQuoteV2 {
  readonly iterations: number
  readonly spendUsdNanos: number
  readonly retryClass?: 'retry-once' | 'new-task-only'
}

export interface DurableDelegationQuotePortV2 {
  provider(request: ModelRequest): DurableDelegationOperationQuoteV2 | undefined
  tool(call: ToolCall, context: ToolExecutionContext): DurableDelegationOperationQuoteV2 | undefined
}

export interface DurableDelegationResolutionRequestV2 {
  readonly runRootHash: string
  readonly taskId: string
  readonly controlLogicalSlotHash: string
  readonly journalLogicalSlotHash: string
  readonly attempt: 1 | 2
  readonly phase: 'provider' | 'tool'
  readonly ordinal: number
  readonly retryClass: 'retry-once' | 'new-task-only'
}

export interface DurableDelegationVerifierInputV2 {
  readonly schemaVersion: 2
  readonly runRootHash: string
  readonly bindingHash: string
  readonly delegationId: string
  readonly taskId: string
  readonly authorityHash: string
  readonly policyRevision: string
  readonly candidateHash: string
  readonly candidate: unknown
  readonly shard: readonly ShardEntry[]
  readonly cost: Readonly<IterationCost>
  readonly operations: readonly DurableDelegationOperationEvidenceV2[]
}

export interface DurableDelegationLiveAdapterInputV2 {
  readonly journal: DurableDelegationOperationJournalV2
  readonly control: DurableDelegationBoundOperationControlV1
  readonly controlAttestation: DurableDelegationBoundOperationControlAttestationV1
  readonly authority: DelegationExecutionAuthorityV1
  readonly authorityJournal: DelegationAuthorityJournal
  readonly childTurnId: string
  readonly providerIdentityHash: string
  readonly policyRevision: string
  readonly provider: DurableDelegationProviderOperationPortV1
  readonly tool: DurableDelegationToolOperationPortV1
  readonly quotes: DurableDelegationQuotePortV2
  /** Persists the exact pause request; it cannot return execution authority. */
  readonly onAmbiguity: (request: DurableDelegationResolutionRequestV2) => void
  /** Manager recovery actor is the only allowed source of genuine authorities. */
  readonly resolveAmbiguity: (
    request: DurableDelegationResolutionRequestV2,
  ) => DurableDelegationOperationResolutionAuthorityV1 | undefined
  /** Idempotent durable acknowledgement after operation-control consumed a decision. */
  readonly onResolutionApplied?: (
    request: DurableDelegationResolutionRequestV2,
    decision: 'retry-once' | 'cancel',
  ) => void
  readonly verifier: (
    input: DurableDelegationVerifierInputV2,
    signal?: AbortSignal,
  ) => Promise<DurableDelegationVerification>
}

export interface DurableDelegationLiveAdapterV2 {
  readonly provider: ProviderAdapter
  executeTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>
  readCost(): IterationCost
  verify(candidate: unknown, signal?: AbortSignal): Promise<DurableDelegationVerification>
}

const HASH = /^[a-f0-9]{64}$/
const POLICY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const AUTHORITY_SEAL_KIND = 'runtime.agent-authority.v1'
const GENESIS = '0'.repeat(64)
const MAX_JSON_DEPTH = 32
const MAX_JSON_NODES = 8_192
const MAX_JSON_TEXT_BYTES = 128 * 1024
const MAX_PAYLOAD_BYTES = 64 * 1024
const MAX_WALL_MS = 24 * 60 * 60 * 1000
const BINDING_DOMAIN = 'aisy.durable-delegation.operation-binding.v1\0'
const PREFIX_DOMAIN = 'aisy.durable-delegation.provider-prefix.v1\0'
const PREPARED_V2_DOMAIN = 'aisy.durable-delegation.live-adapter.prepared.v2\0'
const RECEIPT_V2_DOMAIN = 'aisy.durable-delegation.live-adapter.receipt.v2\0'
const CANDIDATE_V2_DOMAIN = 'aisy.durable-delegation.live-adapter.candidate.v2\0'
const INVENTORY_V2_DOMAIN = 'aisy.durable-delegation.live-adapter.inventory.v2\0'
const STOPPED_PAYLOAD = Object.freeze({
  schemaVersion: 1 as const,
  kind: 'runtime.operation-stopped' as const,
})
const cancellationAcks = new WeakSet<object>()

function fail(code: DurableDelegationLiveAdapterErrorCode): never {
  throw new DurableDelegationLiveAdapterError(code)
}

function ambiguous(): never {
  throw makeDurableDelegationRecoverableInterruption('DELEGATION_OPERATION_AMBIGUOUS')
}

function manualRecovery(): never {
  throw makeDurableDelegationRecoverableInterruption('DELEGATION_MANUAL_RECOVERY_REQUIRED')
}

function sha256(domain: string, value: string): string {
  return createHash('sha256').update(domain, 'utf8').update(value, 'utf8').digest('hex')
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !keys.includes(key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
    result[key] = descriptor.value
  }
  return result
}

function captureMethod<T extends (...args: never[]) => unknown>(
  owner: unknown,
  name: string,
): T {
  if (typeof owner !== 'object' || owner === null || utilTypes.isProxy(owner)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, name)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return descriptor.value as T
}

function captureFunction<T extends (...args: never[]) => unknown>(value: unknown): T {
  if (typeof value !== 'function' || utilTypes.isProxy(value)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return value as T
}

function captureCancellationReceipt(
  value: unknown,
): Readonly<DurableDelegationCancellationReceiptV1> {
  const raw = exactObject(value, ['spendUsdNanos', 'wallMs'], ['inputTokens', 'outputTokens'])
  const spendUsdNanos = raw['spendUsdNanos']
  const wallMs = raw['wallMs']
  const inputTokens = raw['inputTokens']
  const outputTokens = raw['outputTokens']
  if (!validNanos(spendUsdNanos) || !validWallMs(wallMs) ||
    (inputTokens !== undefined && (!Number.isSafeInteger(inputTokens) || Number(inputTokens) < 0)) ||
    (outputTokens !== undefined && (!Number.isSafeInteger(outputTokens) || Number(outputTokens) < 0))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return Object.freeze({
    spendUsdNanos: Number(spendUsdNanos),
    wallMs: Number(wallMs),
    ...(inputTokens === undefined ? {} : { inputTokens: Number(inputTokens) }),
    ...(outputTokens === undefined ? {} : { outputTokens: Number(outputTokens) }),
  })
}

/** Manager-side constructor: structural copies are not valid cancellation acknowledgements. */
export function makeDurableDelegationStoppedAckV1(
  receipt: DurableDelegationCancellationReceiptV1,
): DurableDelegationCancellationAckV1 {
  const ack = Object.freeze({
    kind: 'durable-delegation-cancellation-ack-v1' as const,
    state: 'stopped' as const,
    receipt: captureCancellationReceipt(receipt),
  })
  cancellationAcks.add(ack)
  return ack
}

/** Manager-side constructor for a cleanup result that cannot prove no effect. */
export function makeDurableDelegationAmbiguousAckV1(): DurableDelegationCancellationAckV1 {
  const ack = Object.freeze({
    kind: 'durable-delegation-cancellation-ack-v1' as const,
    state: 'ambiguous' as const,
  })
  cancellationAcks.add(ack)
  return ack
}

function canonicalJson(value: unknown, maximumBytes: number): string {
  let nodes = 0
  let textBytes = 0
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      return Object.is(candidate, -0) ? 0 : candidate
    }
    if (typeof candidate === 'string') {
      if (candidate.includes('\0')) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      textBytes += Buffer.byteLength(candidate, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      return candidate
    }
    if (Array.isArray(candidate)) {
      if (utilTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype ||
        Object.getOwnPropertySymbols(candidate).length !== 0) {
        fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate)
      const length = Reflect.getOwnPropertyDescriptor(candidate, 'length')?.value as unknown
      if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > MAX_JSON_NODES ||
        Object.keys(descriptors).filter(key => key !== 'length').length !== length) {
        fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      }
      const result: unknown[] = []
      for (let index = 0; index < Number(length); index++) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
          descriptor.get !== undefined || descriptor.set !== undefined) {
          fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
        }
        result.push(visit(descriptor.value, depth + 1))
      }
      return result
    }
    if (typeof candidate !== 'object' || candidate === null || utilTypes.isProxy(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      Object.getOwnPropertySymbols(candidate).length !== 0) {
      fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(descriptors).sort()) {
      if (key.includes('\0')) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      textBytes += Buffer.byteLength(key, 'utf8')
      if (textBytes > MAX_JSON_TEXT_BYTES) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
      const descriptor = descriptors[key]!
      if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
        descriptor.set !== undefined) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
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
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return encoded
}

function frozenJson<T>(value: T, maximumBytes = MAX_PAYLOAD_BYTES): Readonly<T> {
  const snapshot = JSON.parse(canonicalJson(value, maximumBytes)) as T
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || Object.isFrozen(candidate)) return
    Object.freeze(candidate)
    for (const nested of Object.values(candidate)) freeze(nested)
  }
  freeze(snapshot)
  return snapshot
}

function requestSnapshot(request: ModelRequest): {
  readonly request: ModelRequest
  readonly hashInput: unknown
  readonly markToolAttempt?: NonNullable<ModelRequest['markToolAttempt']>
} {
  const raw = exactObject(request, ['sessionId', 'prefixBytes', 'spans'], [
    'turnId', 'toolOrdinalBase', 'markToolAttempt',
  ])
  if (typeof raw['sessionId'] !== 'string' || raw['sessionId'].length === 0 ||
    (raw['turnId'] !== undefined && (typeof raw['turnId'] !== 'string' || raw['turnId'].length === 0)) ||
    (raw['toolOrdinalBase'] !== undefined && (!Number.isSafeInteger(raw['toolOrdinalBase']) ||
      (raw['toolOrdinalBase'] as number) < 0))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const attemptDescriptor = Object.getOwnPropertyDescriptor(request, 'markToolAttempt')
  if (raw['markToolAttempt'] !== undefined &&
    (typeof raw['markToolAttempt'] !== 'function' || utilTypes.isProxy(raw['markToolAttempt']) ||
      attemptDescriptor === undefined || attemptDescriptor.enumerable ||
      !Object.hasOwn(attemptDescriptor, 'value'))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const prefix = raw['prefixBytes']
  if (!(prefix instanceof Uint8Array) || utilTypes.isProxy(prefix) ||
    Object.getPrototypeOf(prefix) !== Uint8Array.prototype ||
    Object.getOwnPropertySymbols(prefix).length !== 0 ||
    !(prefix.buffer instanceof ArrayBuffer)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  let prefixCopy: Uint8Array
  try {
    prefixCopy = new Uint8Array(prefix.byteLength)
    prefixCopy.set(new Uint8Array(prefix.buffer, prefix.byteOffset, prefix.byteLength))
  } catch {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const spans = frozenJson(raw['spans']) as ModelRequest['spans']
  const snapshot = Object.freeze({
    sessionId: raw['sessionId'],
    ...(raw['turnId'] === undefined ? {} : { turnId: raw['turnId'] }),
    ...(raw['toolOrdinalBase'] === undefined ? {} : { toolOrdinalBase: raw['toolOrdinalBase'] }),
    prefixBytes: prefixCopy,
    spans,
  }) as ModelRequest
  return Object.freeze({
    request: snapshot,
    ...(raw['markToolAttempt'] === undefined
      ? {}
      : { markToolAttempt: raw['markToolAttempt'] as NonNullable<ModelRequest['markToolAttempt']> }),
    hashInput: Object.freeze({
      sessionId: snapshot.sessionId,
      ...(snapshot.turnId === undefined ? {} : { turnId: snapshot.turnId }),
      ...(snapshot.toolOrdinalBase === undefined
        ? {}
        : { toolOrdinalBase: snapshot.toolOrdinalBase }),
      prefixSha256: sha256(PREFIX_DOMAIN, Buffer.from(prefixCopy).toString('base64')),
      spans,
    }),
  })
}

function providerRequestWithAttempt(
  captured: ReturnType<typeof requestSnapshot>,
): ModelRequest {
  const clean = requestSnapshot(captured.request).request
  if (captured.markToolAttempt === undefined) return clean
  const request: ModelRequest = { ...clean }
  Object.defineProperty(request, 'markToolAttempt', {
    value: captured.markToolAttempt,
    enumerable: false,
  })
  return Object.freeze(request)
}

function toolSnapshot(call: ToolCall): ToolCall {
  const raw = exactObject(call, ['name', 'args'], ['sourceSpanProvenance'])
  if (typeof raw['name'] !== 'string' || raw['name'].length === 0 ||
    (raw['sourceSpanProvenance'] !== undefined && raw['sourceSpanProvenance'] !== 'operator' &&
      raw['sourceSpanProvenance'] !== 'untrusted')) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return Object.freeze({
    name: raw['name'],
    args: frozenJson(raw['args']) as Record<string, unknown>,
    ...(raw['sourceSpanProvenance'] === undefined
      ? {}
      : { sourceSpanProvenance: raw['sourceSpanProvenance'] }),
  }) as ToolCall
}

function responseSnapshot(value: ModelResponse): ModelResponse {
  return frozenJson(value) as ModelResponse
}

function toolResultSnapshot(value: ToolResult): ToolResult {
  const result = frozenJson(value) as ToolResult
  if (typeof result.ok !== 'boolean' || typeof result.output !== 'string' ||
    Object.keys(result).sort().join(',') !== 'ok,output') {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return result
}

function validNanos(value: unknown): value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return false
  const usd = Number(value) / 1_000_000_000
  return iterationCostSpendNanos(usd) === value
}

function validWallMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_WALL_MS
}

function journalSpendUsd(nanos: number): number {
  if (!validNanos(nanos)) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  return nanos / 1_000_000_000
}

function providerFinalizedSnapshot(value: unknown): Readonly<DurableDelegationProviderFinalizedV1> {
  const raw = exactObject(value, ['output', 'receipt'])
  const receipt = exactObject(raw['receipt'], [
    'spendUsdNanos',
    'wallMs',
    'inputTokens',
    'outputTokens',
  ])
  if (!validNanos(receipt['spendUsdNanos']) || !validWallMs(receipt['wallMs']) ||
    !Number.isSafeInteger(receipt['inputTokens']) || Number(receipt['inputTokens']) < 0 ||
    !Number.isSafeInteger(receipt['outputTokens']) || Number(receipt['outputTokens']) < 0) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const capturedReceipt = Object.freeze({
    spendUsdNanos: Number(receipt['spendUsdNanos']),
    wallMs: Number(receipt['wallMs']),
    inputTokens: Number(receipt['inputTokens']),
    outputTokens: Number(receipt['outputTokens']),
  })
  const rawOutput = responseSnapshot(raw['output'] as ModelResponse)
  // The child loop may observe ModelResponse.usage, so replace any provider
  // body value with the same code-owned receipt used by the durable meter.
  const output = responseSnapshot({
    ...rawOutput,
    usage: {
      inputTokens: capturedReceipt.inputTokens,
      outputTokens: capturedReceipt.outputTokens,
      dollars: journalSpendUsd(capturedReceipt.spendUsdNanos),
    },
  })
  return Object.freeze({ output, receipt: capturedReceipt })
}

function toolFinalizedSnapshot(value: unknown): Readonly<DurableDelegationToolFinalizedV1> {
  const raw = exactObject(value, ['output', 'receipt'])
  const receipt = exactObject(
    raw['receipt'],
    ['spendUsdNanos', 'wallMs', 'effect', 'actionStatus'],
    ['evidenceHash'],
  )
  if (!validNanos(receipt['spendUsdNanos']) || !validWallMs(receipt['wallMs']) ||
    (receipt['effect'] !== 'none' && receipt['effect'] !== 'read' &&
      receipt['effect'] !== 'mutation') ||
    (receipt['actionStatus'] !== 'verified' && receipt['actionStatus'] !== 'unverified') ||
    (receipt['evidenceHash'] !== undefined &&
      (typeof receipt['evidenceHash'] !== 'string' || !HASH.test(receipt['evidenceHash'])))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return Object.freeze({
    output: toolResultSnapshot(raw['output'] as ToolResult),
    receipt: Object.freeze({
      spendUsdNanos: Number(receipt['spendUsdNanos']),
      wallMs: Number(receipt['wallMs']),
      effect: receipt['effect'],
      actionStatus: receipt['actionStatus'],
      ...(receipt['evidenceHash'] === undefined ? {} : { evidenceHash: receipt['evidenceHash'] }),
    }),
  }) as Readonly<DurableDelegationToolFinalizedV1>
}

function providerPayload(output: ModelResponse): unknown {
  return Object.freeze({ schemaVersion: 1, kind: 'runtime.provider-output', output })
}

function toolPayload(
  output: ToolResult,
  actionStatus: 'verified' | 'unverified',
): unknown {
  return Object.freeze({ schemaVersion: 1, kind: 'runtime.tool-output', output, actionStatus })
}

function storedProviderOutput(value: unknown): ModelResponse {
  const raw = exactObject(value, ['schemaVersion', 'kind', 'output'])
  if (raw['schemaVersion'] !== 1 || raw['kind'] !== 'runtime.provider-output') {
    fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
  }
  return responseSnapshot(raw['output'] as ModelResponse)
}

function storedToolOutput(value: unknown): {
  readonly output: ToolResult
  readonly actionStatus: 'verified' | 'unverified'
} {
  const raw = exactObject(value, ['schemaVersion', 'kind', 'output', 'actionStatus'])
  if (raw['schemaVersion'] !== 1 || raw['kind'] !== 'runtime.tool-output' ||
    (raw['actionStatus'] !== 'verified' && raw['actionStatus'] !== 'unverified')) {
    fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
  }
  return Object.freeze({
    output: toolResultSnapshot(raw['output'] as ToolResult),
    actionStatus: raw['actionStatus'],
  })
}

function isStoppedPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false
  }
  const raw = value as Record<string, unknown>
  return Object.keys(raw).sort().join(',') === 'kind,schemaVersion' &&
    raw['schemaVersion'] === 1 && raw['kind'] === 'runtime.operation-stopped'
}

interface CapturedOwnedOperation<T> {
  readonly result: Promise<T>
  cancel(): Promise<DurableDelegationCancellationAckV1>
}

function captureOwnedOperation<T>(value: unknown): CapturedOwnedOperation<T> {
  const raw = exactObject(value, ['result', 'cancel'])
  if (!(raw['result'] instanceof Promise) || utilTypes.isProxy(raw['result']) ||
    Object.getPrototypeOf(raw['result']) !== Promise.prototype) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const cancel = captureFunction<() => Promise<DurableDelegationCancellationAckV1>>(raw['cancel'])
  const owner = value as DurableDelegationOwnedOperationV1<T>
  return Object.freeze({
    result: raw['result'] as Promise<T>,
    cancel: () => cancel.call(owner),
  })
}

type OwnedCompletion<T> =
  | Readonly<{ state: 'result'; value: T }>
  | Readonly<{ state: 'stopped'; receipt: Readonly<DurableDelegationCancellationReceiptV1> }>
  | Readonly<{ state: 'ambiguous' }>

async function awaitOwnedOperation<T>(
  operation: CapturedOwnedOperation<T>,
  signal?: AbortSignal,
): Promise<OwnedCompletion<T>> {
  let abortListener: (() => void) | undefined
  const aborted = new Promise<'aborted'>(resolve => {
    abortListener = () => resolve('aborted')
    signal?.addEventListener('abort', abortListener, { once: true })
  })
  try {
    const result = operation.result.then(
      value => Object.freeze({ state: 'result' as const, value }),
      () => Object.freeze({ state: 'ambiguous' as const }),
    )
    const first = signal === undefined
      ? await result
      : signal.aborted
        ? 'aborted' as const
        : await Promise.race([result, aborted])
    if (first !== 'aborted') return first
    let ack: DurableDelegationCancellationAckV1
    try {
      // The acknowledgement is allowed to resolve only after interrupt and
      // cleanup. Waiting here prevents a background effect escaping the turn.
      ack = await operation.cancel()
    } catch {
      return Object.freeze({ state: 'ambiguous' })
    }
    if (typeof ack !== 'object' || ack === null || !cancellationAcks.has(ack) ||
      !Object.isFrozen(ack) || ack.kind !== 'durable-delegation-cancellation-ack-v1') {
      return Object.freeze({ state: 'ambiguous' })
    }
    if (ack.state === 'ambiguous') return Object.freeze({ state: 'ambiguous' })
    if (!Object.isFrozen(ack.receipt)) return Object.freeze({ state: 'ambiguous' })
    return Object.freeze({ state: 'stopped', receipt: ack.receipt })
  } finally {
    if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener)
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function authorityBindingHash(authority: DelegationExecutionAuthorityV1): string {
  return sha256(BINDING_DOMAIN, canonicalJson(authority.identity.binding, MAX_PAYLOAD_BYTES))
}

function slot(key: DurableDelegationOperationKeyV1): string {
  return `${key.phase}:${key.ordinal}`
}

function receiptEvidence(
  key: DurableDelegationOperationKeyV1,
  receipt: DurableDelegationOperationReceiptV1,
  outcome: 'completed' | 'stopped',
  actionStatus?: 'verified' | 'unverified',
): DurableDelegationOperationEvidenceV1 {
  const nanos = iterationCostSpendNanos(receipt.spendUsd)
  if (nanos === undefined) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  return Object.freeze({
    phase: key.phase,
    ordinal: key.ordinal,
    canonicalRequestHash: key.canonicalRequestHash,
    resultHash: receipt.resultHash,
    spendUsdNanos: nanos,
    wallMs: receipt.wallMs,
    effect: receipt.effect,
    ...(receipt.evidenceHash === undefined ? {} : { evidenceHash: receipt.evidenceHash }),
    ...(actionStatus === undefined ? {} : { actionStatus }),
    outcome,
  })
}

/**
 * Builds dormant wrappers only. The returned provider/executor are not imported
 * by `aisy run`, `aisy supervise`, the bot, or any production composition.
 */
export function makeDurableDelegationLiveAdapterV1(
  input: DurableDelegationLiveAdapterInputV1,
): DurableDelegationLiveAdapterV1 {
  const raw = exactObject(input, [
    'journal',
    'authority',
    'authorityJournal',
    'childTurnId',
    'providerIdentityHash',
    'policyRevision',
    'provider',
    'tool',
    'verifier',
  ])
  if (typeof raw['policyRevision'] !== 'string' || !POLICY_REVISION.test(raw['policyRevision']) ||
    typeof raw['childTurnId'] !== 'string' || raw['childTurnId'].length === 0 ||
    raw['childTurnId'].includes('\0') ||
    typeof raw['providerIdentityHash'] !== 'string' || !HASH.test(raw['providerIdentityHash'])) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  // Reject Proxy/accessor/mutable structural authority before Core validation
  // can observe it. Core returns the only authority snapshot used below.
  canonicalJson(raw['authority'], MAX_JSON_TEXT_BYTES)
  let authority: DelegationExecutionAuthorityV1
  try {
    authority = validateDelegationExecutionAuthority(raw['authority'])
  } catch {
    fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
  }

  const journal = raw['journal']
  const authorityJournal = raw['authorityJournal']
  const providerOwner = raw['provider']
  const toolOwner = raw['tool']
  const inspect = captureMethod<DurableDelegationOperationJournalV1['inspect']>(journal, 'inspect')
  const prepare = captureMethod<DurableDelegationOperationJournalV1['prepare']>(journal, 'prepare')
  const settle = captureMethod<DurableDelegationOperationJournalV1['settle']>(journal, 'settle')
  const providerStart = captureMethod<DurableDelegationProviderOperationPortV1['start']>(
    providerOwner,
    'start',
  )
  const toolStart = captureMethod<DurableDelegationToolOperationPortV1['start']>(toolOwner, 'start')
  const verifier = captureFunction<DurableDelegationLiveAdapterInputV1['verifier']>(raw['verifier'])
  const shard = captureMethod<DelegationAuthorityJournal['shard']>(authorityJournal, 'shard')
  const verifyShardChain = captureMethod<DelegationAuthorityJournal['verifyShardChain']>(
    authorityJournal,
    'verifyShardChain',
  )
  if (typeof journal !== 'object' || journal === null || utilTypes.isProxy(journal) ||
    typeof authorityJournal !== 'object' || authorityJournal === null ||
    utilTypes.isProxy(authorityJournal) || typeof providerOwner !== 'object' ||
    providerOwner === null || utilTypes.isProxy(providerOwner) || typeof toolOwner !== 'object' ||
    toolOwner === null || utilTypes.isProxy(toolOwner)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const runRootHash = (journal as DurableDelegationOperationJournalV1).runRootHash
  if (typeof runRootHash !== 'string' || !HASH.test(runRootHash)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const policyRevision = raw['policyRevision']
  const childTurnId = raw['childTurnId']
  const providerIdentityHash = raw['providerIdentityHash']
  const bindingHash = authorityBindingHash(authority)

  const settled = new Map<string, DurableDelegationOperationEvidenceV1>()
  const unresolved = new Set<string>()
  let providerOrdinal = 0

  const assertAuthoritySealed = (): readonly ShardEntry[] => {
    let entries: ShardEntry[]
    try {
      if (!verifyShardChain.call(authorityJournal)) {
        fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
      }
      entries = shard.call(authorityJournal)
    } catch (error) {
      if (error instanceof DurableDelegationLiveAdapterError) throw error
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    const seals = entries.filter(entry => entry.kind === AUTHORITY_SEAL_KIND)
    const seal = seals[0]
    if (seals.length !== 1 || seal?.seq !== 1 || seal.prevHash !== GENESIS ||
      seal.delegationId !== authority.identity.delegationId ||
      typeof seal.payload !== 'object' || seal.payload === null || Array.isArray(seal.payload)) {
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    const payload = seal.payload as Record<string, unknown>
    if (Object.keys(payload).sort().join(',') !== 'authorityHash,schemaVersion' ||
      payload['schemaVersion'] !== 1 || payload['authorityHash'] !== authority.authorityHash) {
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    return frozenJson(entries) as readonly ShardEntry[]
  }

  const keyFor = (
    phase: 'provider' | 'tool',
    ordinal: number,
    requestHash: string,
  ): DurableDelegationOperationKeyV1 => Object.freeze({
    runRootHash,
    bindingHash,
    delegationId: authority.identity.delegationId,
    taskId: authority.identity.taskId,
    phase,
    ordinal,
    canonicalRequestHash: requestHash,
    authorityHash: authority.authorityHash,
    policyRevision,
  })

  const recordSettled = (
    state: Extract<DurableDelegationOperationStateV1, { state: 'settled' }>,
  ): void => {
    let evidence: DurableDelegationOperationEvidenceV1
    if (isStoppedPayload(state.payload)) {
      evidence = receiptEvidence(state.key, state.receipt, 'stopped')
    } else if (state.key.phase === 'provider') {
      storedProviderOutput(state.payload)
      evidence = receiptEvidence(state.key, state.receipt, 'completed')
    } else {
      const stored = storedToolOutput(state.payload)
      evidence = receiptEvidence(state.key, state.receipt, 'completed', stored.actionStatus)
    }
    settled.set(slot(state.key), evidence)
    unresolved.delete(slot(state.key))
  }

  const currentCost = (): IterationCost => {
    let iterations = 0
    let spendUsdNanos = 0
    let wallMs = 0
    for (const evidence of settled.values()) {
      if (evidence.phase === 'provider' && evidence.outcome === 'completed') iterations += 1
      if (spendUsdNanos > Number.MAX_SAFE_INTEGER - evidence.spendUsdNanos ||
        wallMs > Number.MAX_SAFE_INTEGER - evidence.wallMs) {
        fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
      }
      spendUsdNanos += evidence.spendUsdNanos
      wallMs += evidence.wallMs
    }
    const cost = canonicalizeIterationCost({
      iterations,
      spendUsd: spendUsdNanos / 1_000_000_000,
      wallMs,
    })
    if (cost === undefined) fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
    return cost
  }

  const inspected = (
    key: DurableDelegationOperationKeyV1,
  ): DurableDelegationOperationStateV1 => {
    assertAuthoritySealed()
    let state: DurableDelegationOperationStateV1
    try {
      state = inspect.call(journal, key)
    } catch {
      unresolved.add(slot(key))
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    if (state.state === 'settled') {
      recordSettled(state)
      return state
    }
    if (state.state === 'ambiguous') {
      unresolved.add(slot(key))
      ambiguous()
    }
    if (state.state === 'drift') {
      unresolved.add(slot(key))
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    return state
  }

  const prepareExact = (key: DurableDelegationOperationKeyV1) => {
    let prepared: ReturnType<DurableDelegationOperationJournalV1['prepare']>
    try {
      prepared = prepare.call(journal, key)
    } catch {
      unresolved.add(slot(key))
      ambiguous()
    }
    if (prepared.state === 'settled') {
      recordSettled(prepared)
      return prepared
    }
    if (prepared.state === 'ambiguous') {
      unresolved.add(slot(key))
      ambiguous()
    }
    if (prepared.state === 'drift') {
      unresolved.add(slot(key))
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    return prepared
  }

  const provider: ProviderAdapter = Object.freeze({
    async complete(
      request: ModelRequest,
      signal?: AbortSignal,
      onProgress?: ModelProgressSink,
    ): Promise<ModelResponse> {
      const captured = requestSnapshot(request)
      if (captured.request.sessionId !== authority.identity.childSessionId ||
        captured.request.turnId !== childTurnId) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      providerOrdinal += 1
      const key = keyFor(
        'provider',
        providerOrdinal,
        hashDurableDelegationOperationRequestV1({
          providerIdentityHash,
          ...captured.hashInput as Record<string, unknown>,
        }),
      )
      const state = inspected(key)
      if (state.state === 'settled') {
        if (isStoppedPayload(state.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
        return storedProviderOutput(state.payload)
      }
      if (isAborted(signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      const prepared = prepareExact(key)
      if (prepared.state === 'settled') {
        if (isStoppedPayload(prepared.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
        return storedProviderOutput(prepared.payload)
      }
      if (isAborted(signal)) {
        // No external port was started: this is the only cancellation point
        // this dormant slice can prove effect-free by itself.
        let stopped: Extract<DurableDelegationOperationStateV1, { state: 'settled' }>
        try {
          stopped = settle.call(journal, prepared.permit, {
            payload: STOPPED_PAYLOAD,
            receipt: { spendUsd: 0, wallMs: 0, effect: 'none' },
          })
        } catch {
          unresolved.add(slot(key))
          ambiguous()
        }
        recordSettled(stopped)
        fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      }
      let operation: CapturedOwnedOperation<DurableDelegationProviderFinalizedV1>
      try {
        // The exact signal/progress functions cross this boundary unchanged.
        operation = captureOwnedOperation(providerStart.call(
          providerOwner,
          providerRequestWithAttempt(captured),
          signal,
          onProgress,
        ))
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      const completion = await awaitOwnedOperation(operation, signal)
      if (completion.state !== 'result') {
        // Even a genuine cleanup acknowledgement cannot prove whether a paid
        // provider request completed before interruption. Approval/attempt
        // resolution is a later slice, so prepared remains ambiguous.
        unresolved.add(slot(key))
        ambiguous()
      }
      let finalized: Readonly<DurableDelegationProviderFinalizedV1>
      try {
        finalized = providerFinalizedSnapshot(completion.value)
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      let settledState: Extract<DurableDelegationOperationStateV1, { state: 'settled' }>
      try {
        settledState = settle.call(journal, prepared.permit, {
          payload: providerPayload(finalized.output),
          receipt: {
            spendUsd: journalSpendUsd(finalized.receipt.spendUsdNanos),
            wallMs: finalized.receipt.wallMs,
            effect: 'read',
            inputTokens: finalized.receipt.inputTokens,
            outputTokens: finalized.receipt.outputTokens,
          },
        })
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      recordSettled(settledState)
      return storedProviderOutput(settledState.payload)
    },
  })

  const adapter: DurableDelegationLiveAdapterV1 = {
    provider,

    async executeTool(call, context): Promise<ToolResult> {
      const captured = toolSnapshot(call)
      if (!isGenuineToolExecutionContextFor(context, captured.name) ||
        !Number.isSafeInteger(context.ordinal) || context.ordinal < 1 ||
        context.sessionId !== authority.identity.childSessionId || context.turnId !== childTurnId) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      const definition = runtimeToolDefinition(captured.name)
      if (definition === undefined ||
        (definition.effect !== 'read' && definition.effect !== 'sentinel' &&
          definition.scopedPathArg === undefined)) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      const key = keyFor(
        'tool',
        context.ordinal,
        hashDurableDelegationOperationRequestV1({
          name: captured.name,
          args: captured.args,
          ...(captured.sourceSpanProvenance === undefined
            ? {}
            : { sourceSpanProvenance: captured.sourceSpanProvenance }),
          sessionId: context.sessionId,
          turnId: context.turnId,
          ordinal: context.ordinal,
        }),
      )
      const state = inspected(key)
      if (state.state === 'settled') {
        if (isStoppedPayload(state.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
        return storedToolOutput(state.payload).output
      }
      if (isAborted(context.signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      const prepared = prepareExact(key)
      if (prepared.state === 'settled') {
        if (isStoppedPayload(prepared.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
        return storedToolOutput(prepared.payload).output
      }
      if (isAborted(context.signal)) {
        let stopped: Extract<DurableDelegationOperationStateV1, { state: 'settled' }>
        try {
          stopped = settle.call(journal, prepared.permit, {
            payload: STOPPED_PAYLOAD,
            receipt: { spendUsd: 0, wallMs: 0, effect: 'none' },
          })
        } catch {
          unresolved.add(slot(key))
          ambiguous()
        }
        recordSettled(stopped)
        fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      }
      let operation: CapturedOwnedOperation<DurableDelegationToolFinalizedV1>
      try {
        // `context` is the genuine Core object, not a structural reconstruction.
        // Its exact signal therefore also reaches the external tool unchanged.
        operation = captureOwnedOperation(toolStart.call(toolOwner, captured, context))
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      const completion = await awaitOwnedOperation(operation, context.signal)
      if (completion.state !== 'result') {
        unresolved.add(slot(key))
        ambiguous()
      }
      let finalized: Readonly<DurableDelegationToolFinalizedV1>
      try {
        finalized = toolFinalizedSnapshot(completion.value)
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      const expectedEffect = definition.effect === 'read'
        ? 'read' as const
        : definition.effect === 'sentinel'
          ? 'none' as const
          : 'mutation' as const
      const actionStatus = finalized.receipt.effect === expectedEffect
        ? finalized.receipt.actionStatus
        : 'unverified' as const
      let settledState: Extract<DurableDelegationOperationStateV1, { state: 'settled' }>
      try {
        settledState = settle.call(journal, prepared.permit, {
          payload: toolPayload(finalized.output, actionStatus),
          receipt: {
            spendUsd: journalSpendUsd(finalized.receipt.spendUsdNanos),
            wallMs: finalized.receipt.wallMs,
            effect: expectedEffect,
            ...(finalized.receipt.evidenceHash === undefined
              ? {}
              : { evidenceHash: finalized.receipt.evidenceHash }),
          },
        })
      } catch {
        unresolved.add(slot(key))
        ambiguous()
      }
      recordSettled(settledState)
      return storedToolOutput(settledState.payload).output
    },

    readCost(): IterationCost {
      return Object.freeze({ ...currentCost() })
    },

    async verify(candidate, signal): Promise<DurableDelegationVerification> {
      const entries = assertAuthoritySealed()
      if (unresolved.size !== 0) fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      const cost = Object.freeze({ ...currentCost() })
      const operations = Object.freeze(
        [...settled.values()]
          .sort((left, right) => left.phase.localeCompare(right.phase) || left.ordinal - right.ordinal)
          .map(item => Object.freeze({ ...item })),
      )
      if (operations.some(operation => operation.outcome !== 'completed' ||
        (operation.phase === 'tool' && operation.actionStatus !== 'verified') ||
        (operation.effect === 'mutation' && operation.evidenceHash === undefined))) {
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
      try {
        return await verifier(Object.freeze({
          schemaVersion: 1 as const,
          runRootHash,
          bindingHash,
          delegationId: authority.identity.delegationId,
          taskId: authority.identity.taskId,
          authorityHash: authority.authorityHash,
          policyRevision,
          candidate: frozenJson(candidate),
          shard: entries,
          cost,
          operations,
        }), signal)
      } catch (error) {
        if (error instanceof DurableDelegationLiveAdapterError) throw error
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
    },
  }
  return Object.freeze(adapter)
}

function captureQuoteV2(value: unknown): Readonly<DurableDelegationOperationQuoteV2> {
  if (value === undefined) fail('DURABLE_DELEGATION_LIVE_QUOTE_REQUIRED')
  const raw = exactObject(value, ['iterations', 'spendUsdNanos'], ['retryClass'])
  if (!Number.isSafeInteger(raw['iterations']) || Number(raw['iterations']) < 0 ||
    !validNanos(raw['spendUsdNanos']) ||
    (raw['retryClass'] !== undefined && raw['retryClass'] !== 'retry-once' &&
      raw['retryClass'] !== 'new-task-only')) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  return Object.freeze({
    iterations: Number(raw['iterations']),
    spendUsdNanos: Number(raw['spendUsdNanos']),
    ...(raw['retryClass'] === undefined ? {} : { retryClass: raw['retryClass'] }),
  })
}

function preparedHashV2(key: Readonly<DurableDelegationOperationKeyV2>): string {
  return sha256(PREPARED_V2_DOMAIN, canonicalJson(key, MAX_PAYLOAD_BYTES))
}

function controlReceiptV2(
  key: Readonly<DurableDelegationOperationKeyV2>,
  payload: unknown,
  receipt: Readonly<DurableDelegationOperationReceiptV1>,
): Readonly<DurableDelegationOperationReceiptEvidenceV1> {
  const spendUsdNanos = iterationCostSpendNanos(receipt.spendUsd)
  if (spendUsdNanos === undefined) fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
  let outcome: 'completed' | 'stopped' = 'completed'
  let actionStatus: 'verified' | 'unverified' | undefined
  if (isStoppedPayload(payload)) outcome = 'stopped'
  else if (key.phase === 'provider') storedProviderOutput(payload)
  else actionStatus = storedToolOutput(payload).actionStatus
  const result = Object.freeze({
    receiptHash: sha256(RECEIPT_V2_DOMAIN, canonicalJson({
      key,
      payload,
      receipt,
      outcome,
      ...(actionStatus === undefined ? {} : { actionStatus }),
    }, MAX_JSON_TEXT_BYTES)),
    resultHash: receipt.resultHash,
    iterations: key.phase === 'provider' && outcome === 'completed' ? 1 : 0,
    spendUsdNanos,
    wallMs: receipt.wallMs,
    effect: receipt.effect,
    ...(receipt.evidenceHash === undefined ? {} : { evidenceHash: receipt.evidenceHash }),
    ...(actionStatus === undefined ? {} : { actionStatus }),
    outcome,
  })
  return result
}

function sameControlReceiptV2(
  left: Readonly<DurableDelegationOperationReceiptEvidenceV1>,
  right: Readonly<DurableDelegationOperationReceiptEvidenceV1>,
): boolean {
  return canonicalJson(left, MAX_PAYLOAD_BYTES) === canonicalJson(right, MAX_PAYLOAD_BYTES)
}

function captureVerificationV2(value: unknown): DurableDelegationVerification {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
  }
  const verified = (value as Record<string, unknown>)['verified']
  if (verified === false) {
    const raw = exactObject(value, ['verified', 'reasonCode'])
    if (raw['reasonCode'] !== 'EVIDENCE_MISSING' &&
      raw['reasonCode'] !== 'POSTCONDITION_FAILED' && raw['reasonCode'] !== 'SCOPE_NOT_PROVEN') {
      fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
    }
    return Object.freeze({ verified: false, reasonCode: raw['reasonCode'] })
  }
  const raw = exactObject(value, ['verified', 'evidenceId', 'summary', 'result'])
  if (raw['verified'] !== true || typeof raw['evidenceId'] !== 'string' ||
    !EVIDENCE_ID.test(raw['evidenceId']) || typeof raw['summary'] !== 'string' ||
    raw['summary'].trim().length === 0 ||
    raw['summary'].includes('\0') || Buffer.byteLength(raw['summary'], 'utf8') > 8 * 1024) {
    fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
  }
  return Object.freeze({
    verified: true,
    evidenceId: raw['evidenceId'],
    summary: raw['summary'],
    result: frozenJson(raw['result']),
  })
}

function inventoryFingerprintV2(
  entries: ReturnType<DurableDelegationOperationJournalV2['scan']>['entries'],
): string {
  const hash = createHash('sha256').update(INVENTORY_V2_DOMAIN, 'utf8')
  for (const entry of entries) {
    hash.update(canonicalJson({
      state: entry.state,
      key: entry.key,
      ...(entry.state === 'settled' ? { resultHash: entry.receipt.resultHash } : {}),
    }, MAX_PAYLOAD_BYTES), 'utf8')
  }
  return hash.digest('hex')
}

/**
 * V2 composition. It owns ordering between the budget authority, journal and
 * external ports. Production may construct it only through the supervised
 * importer in durable-delegation-production.ts.
 */
export function makeDurableDelegationLiveAdapterV2(
  input: DurableDelegationLiveAdapterInputV2,
): DurableDelegationLiveAdapterV2 {
  const raw = exactObject(input, [
    'journal',
    'control',
    'controlAttestation',
    'authority',
    'authorityJournal',
    'childTurnId',
    'providerIdentityHash',
    'policyRevision',
    'provider',
    'tool',
    'quotes',
    'onAmbiguity',
    'resolveAmbiguity',
    'verifier',
  ], ['onResolutionApplied'])
  if (typeof raw['policyRevision'] !== 'string' || !POLICY_REVISION.test(raw['policyRevision']) ||
    typeof raw['childTurnId'] !== 'string' || raw['childTurnId'].length === 0 ||
    raw['childTurnId'].includes('\0') || typeof raw['providerIdentityHash'] !== 'string' ||
    !HASH.test(raw['providerIdentityHash'])) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  canonicalJson(raw['authority'], MAX_JSON_TEXT_BYTES)
  let authority: DelegationExecutionAuthorityV1
  try { authority = validateDelegationExecutionAuthority(raw['authority']) } catch {
    fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
  }

  const journal = raw['journal']
  const control = raw['control']
  const controlAttestation = raw['controlAttestation']
  const authorityJournal = raw['authorityJournal']
  const providerOwner = raw['provider']
  const toolOwner = raw['tool']
  const quoteOwner = raw['quotes']
  if ([journal, control, controlAttestation, authorityJournal, providerOwner, toolOwner, quoteOwner]
    .some(value =>
    typeof value !== 'object' || value === null || utilTypes.isProxy(value))) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const structuralRunRootHash = (journal as DurableDelegationOperationJournalV2).runRootHash
  let controlBinding: Readonly<DurableDelegationOperationControlBindingV1>
  try {
    controlBinding = assertDurableDelegationBoundOperationControlAttestationV1(
      control as DurableDelegationBoundOperationControlV1,
      controlAttestation as DurableDelegationBoundOperationControlAttestationV1,
    )
  } catch {
    fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
  }
  const expectedBindingHash = authorityBindingHash(authority)
  if (typeof structuralRunRootHash !== 'string' || !HASH.test(structuralRunRootHash) ||
    controlBinding.runRootHash !== structuralRunRootHash ||
    controlBinding.bindingHash !== expectedBindingHash ||
    controlBinding.delegationId !== authority.identity.delegationId ||
    controlBinding.taskId !== authority.identity.taskId ||
    controlBinding.authorityHash !== authority.authorityHash ||
    controlBinding.policyRevision !== raw['policyRevision']) {
    fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
  }
  const scan = captureMethod<DurableDelegationOperationJournalV2['scan']>(journal, 'scan')
  const prepare = captureMethod<DurableDelegationOperationJournalV2['prepare']>(journal, 'prepare')
  const settle = captureMethod<DurableDelegationOperationJournalV2['settle']>(journal, 'settle')
  const snapshot = captureMethod<DurableDelegationBoundOperationControlV1['snapshot']>(
    control,
    'snapshot',
  )
  const expectOperation = captureMethod<DurableDelegationBoundOperationControlV1['expect']>(
    control,
    'expect',
  )
  const markPrepared = captureMethod<DurableDelegationBoundOperationControlV1['markPrepared']>(
    control,
    'markPrepared',
  )
  const markAmbiguous = captureMethod<DurableDelegationBoundOperationControlV1['markAmbiguous']>(
    control,
    'markAmbiguous',
  )
  const reconcileSettled = captureMethod<
    DurableDelegationBoundOperationControlV1['reconcileSettled']
  >(control, 'reconcileSettled')
  const resolve = captureMethod<DurableDelegationBoundOperationControlV1['resolve']>(
    control,
    'resolve',
  )
  const seal = captureMethod<DurableDelegationBoundOperationControlV1['seal']>(control, 'seal')
  const readControlCost = captureMethod<DurableDelegationBoundOperationControlV1['readCost']>(
    control,
    'readCost',
  )
  const readEvidence = captureMethod<DurableDelegationBoundOperationControlV1['evidence']>(
    control,
    'evidence',
  )
  const providerStart = captureMethod<DurableDelegationProviderOperationPortV1['start']>(
    providerOwner,
    'start',
  )
  const toolStart = captureMethod<DurableDelegationToolOperationPortV1['start']>(toolOwner, 'start')
  const quoteProvider = captureMethod<DurableDelegationQuotePortV2['provider']>(
    quoteOwner,
    'provider',
  )
  const quoteTool = captureMethod<DurableDelegationQuotePortV2['tool']>(quoteOwner, 'tool')
  const onAmbiguity = captureFunction<DurableDelegationLiveAdapterInputV2['onAmbiguity']>(
    raw['onAmbiguity'],
  )
  const resolveAmbiguity = captureFunction<
    DurableDelegationLiveAdapterInputV2['resolveAmbiguity']
  >(raw['resolveAmbiguity'])
  const onResolutionApplied = raw['onResolutionApplied'] === undefined
    ? (() => {})
    : captureFunction<NonNullable<DurableDelegationLiveAdapterInputV2['onResolutionApplied']>>(
        raw['onResolutionApplied'],
      )
  const verifier = captureFunction<DurableDelegationLiveAdapterInputV2['verifier']>(raw['verifier'])
  const shard = captureMethod<DelegationAuthorityJournal['shard']>(authorityJournal, 'shard')
  const verifyShardChain = captureMethod<DelegationAuthorityJournal['verifyShardChain']>(
    authorityJournal,
    'verifyShardChain',
  )

  const runRootHash = structuralRunRootHash
  if (typeof runRootHash !== 'string' || !HASH.test(runRootHash)) {
    fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
  }
  const policyRevision = raw['policyRevision']
  const childTurnId = raw['childTurnId']
  const providerIdentityHash = raw['providerIdentityHash']
  const bindingHash = expectedBindingHash
  let replayCursor = 1
  const inFlightSequences = new Set<number>()

  const assertAuthoritySealed = (): readonly ShardEntry[] => {
    let entries: ShardEntry[]
    try {
      if (!verifyShardChain.call(authorityJournal)) {
        fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
      }
      entries = shard.call(authorityJournal)
    } catch (error) {
      if (error instanceof DurableDelegationLiveAdapterError) throw error
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    const seals = entries.filter(entry => entry.kind === AUTHORITY_SEAL_KIND)
    const authoritySeal = seals[0]
    if (seals.length !== 1 || authoritySeal?.seq !== 1 || authoritySeal.prevHash !== GENESIS ||
      authoritySeal.delegationId !== authority.identity.delegationId ||
      typeof authoritySeal.payload !== 'object' || authoritySeal.payload === null ||
      Array.isArray(authoritySeal.payload)) {
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    const payload = authoritySeal.payload as Record<string, unknown>
    if (Object.keys(payload).sort().join(',') !== 'authorityHash,schemaVersion' ||
      payload['schemaVersion'] !== 1 || payload['authorityHash'] !== authority.authorityHash) {
      fail('DURABLE_DELEGATION_LIVE_AUTHORITY_INVALID')
    }
    return frozenJson(entries) as readonly ShardEntry[]
  }

  const journalKey = (
    phase: 'provider' | 'tool',
    ordinal: number,
    canonicalRequestHash: string,
    attempt: 1 | 2,
    resolutionHash: string,
  ): Readonly<DurableDelegationOperationKeyV2> => {
    const logical = {
      delegationId: authority.identity.delegationId,
      taskId: authority.identity.taskId,
      phase,
      ordinal,
    } as const
    return Object.freeze({
      runRootHash,
      bindingHash,
      ...logical,
      canonicalRequestHash,
      authorityHash: authority.authorityHash,
      policyRevision,
      logicalSlotHash: hashDurableDelegationOperationLogicalSlotV2(logical),
      attempt,
      resolutionHash,
    })
  }

  const exactJournalKey = (
    key: Readonly<DurableDelegationOperationKeyV2>,
    slot: Readonly<DurableDelegationOperationSlotViewV1>,
    attempt: Readonly<DurableDelegationOperationAttemptViewV1>,
  ): void => {
    const expected = journalKey(
      slot.phase,
      slot.ordinal,
      slot.canonicalRequestHash,
      attempt.attempt,
      attempt.resolutionHash,
    )
    if (canonicalJson(key, MAX_PAYLOAD_BYTES) !== canonicalJson(expected, MAX_PAYLOAD_BYTES)) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
  }

  const hydrate = () => {
    assertAuthoritySealed()
    let inventory: ReturnType<DurableDelegationOperationJournalV2['scan']>
    let controlState: ReturnType<DurableDelegationBoundOperationControlV1['snapshot']>
    try {
      inventory = scan.call(journal)
      controlState = snapshot.call(control)
    } catch (error) {
      if (error instanceof DurableDelegationLiveAdapterError) throw error
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    if (inventory.runRootHash !== runRootHash || controlState.sequenceLength !==
      controlState.slots.length || controlState.slots.some((item, index) =>
      item.sequence !== index + 1 || item.authorityHash !== authority.authorityHash ||
      item.policyRevision !== policyRevision) || inventory.entries.some((entry, index) => {
      const previous = inventory.entries[index - 1]
      return previous !== undefined && (previous.key.logicalSlotHash > entry.key.logicalSlotHash ||
        (previous.key.logicalSlotHash === entry.key.logicalSlotHash &&
          previous.key.attempt >= entry.key.attempt))
    })) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    const entryByAttempt = new Map<string, (typeof inventory.entries)[number]>()
    for (const entry of inventory.entries) {
      const operationSlot = controlState.slots.find(item =>
        item.phase === entry.key.phase && item.ordinal === entry.key.ordinal)
      const attempt = operationSlot?.attempts.find(item => item.attempt === entry.key.attempt)
      if (operationSlot === undefined || attempt === undefined) {
        fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
      }
      exactJournalKey(entry.key, operationSlot, attempt)
      const mapKey = `${operationSlot.sequence}:${attempt.attempt}`
      if (entryByAttempt.has(mapKey)) fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
      entryByAttempt.set(mapKey, entry)
      const expectedPreparedHash = preparedHashV2(entry.key)
      if (attempt.preparedHash === undefined) {
        try {
          markPrepared.call(control, {
            logicalSlotHash: operationSlot.logicalSlotHash,
            attempt: attempt.attempt,
            preparedHash: expectedPreparedHash,
          })
        } catch { fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT') }
      } else if (attempt.preparedHash !== expectedPreparedHash) {
        fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
      }
      if (entry.state === 'ambiguous') {
        if (!attempt.ambiguous) {
          try {
            markAmbiguous.call(control, {
              logicalSlotHash: operationSlot.logicalSlotHash,
              attempt: attempt.attempt,
            })
          } catch { fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT') }
        }
      } else {
        const expectedReceipt = controlReceiptV2(entry.key, entry.payload, entry.receipt)
        if (attempt.receipt === undefined) {
          try {
            reconcileSettled.call(control, {
              logicalSlotHash: operationSlot.logicalSlotHash,
              attempt: attempt.attempt,
              preparedHash: expectedPreparedHash,
              receipt: expectedReceipt,
            })
          } catch { fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT') }
        } else if (!sameControlReceiptV2(attempt.receipt, expectedReceipt)) {
          fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
        }
      }
    }
    controlState = snapshot.call(control)
    for (const operationSlot of controlState.slots) {
      for (const attempt of operationSlot.attempts) {
        const entry = entryByAttempt.get(`${operationSlot.sequence}:${attempt.attempt}`)
        if (entry === undefined) {
          const expectedKey = journalKey(
            operationSlot.phase,
            operationSlot.ordinal,
            operationSlot.canonicalRequestHash,
            attempt.attempt,
            attempt.resolutionHash,
          )
          const exactPrePermitRestart = attempt.attempt === 1 &&
            operationSlot.attempts.length === 1 && operationSlot.resolution === undefined &&
            attempt.budgetState === 'held' && attempt.receipt === undefined && attempt.ambiguous &&
            attempt.preparedHash === preparedHashV2(expectedKey)
          const firstJournalEntry = entryByAttempt.get(`${operationSlot.sequence}:1`)
          const exactRetryPrePermitRestart = attempt.attempt === 2 &&
            operationSlot.attempts.length === 2 &&
            operationSlot.resolution?.decision === 'retry-once' &&
            operationSlot.resolution.consumed === true &&
            operationSlot.resolution.resolutionHash === attempt.resolutionHash &&
            firstJournalEntry?.state === 'ambiguous' && attempt.budgetState === 'held' &&
            attempt.receipt === undefined && attempt.ambiguous &&
            attempt.preparedHash === preparedHashV2(expectedKey)
          if (attempt.receipt !== undefined || (attempt.ambiguous && !exactPrePermitRestart &&
            !exactRetryPrePermitRestart)) {
            fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
          }
          if (attempt.preparedHash !== undefined) {
            if (attempt.preparedHash !== preparedHashV2(expectedKey)) {
              fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
            }
          }
        }
        if (attempt.receipt !== undefined && entry?.state !== 'settled') {
          fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
        }
        if ((attempt.budgetState === 'charged' || attempt.budgetState === 'overrun') &&
          entry?.state !== 'settled') {
          fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
        }
      }
    }
    return Object.freeze({ inventory, controlState })
  }

  const currentCost = (): IterationCost => {
    const cost = readControlCost.call(control)
    const canonical = canonicalizeIterationCost({
      iterations: cost.iterations,
      spendUsd: cost.spendUsdNanos / 1_000_000_000,
      wallMs: cost.wallMs,
    })
    if (canonical === undefined || iterationCostSpendNanos(canonical.spendUsd) !==
      cost.spendUsdNanos) fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
    return Object.freeze({ ...canonical })
  }

  const requestResolution = (
    operationSlot: Readonly<DurableDelegationOperationSlotViewV1>,
    attempt: Readonly<DurableDelegationOperationAttemptViewV1>,
    key: Readonly<DurableDelegationOperationKeyV2>,
  ): Readonly<{
    decision: 'retry-once' | 'cancel'
    slot: DurableDelegationOperationSlotViewV1
    attempt: DurableDelegationOperationAttemptViewV1
  }> => {
    try {
      onAmbiguity(Object.freeze({
        runRootHash,
        taskId: authority.identity.taskId,
        controlLogicalSlotHash: operationSlot.logicalSlotHash,
        journalLogicalSlotHash: key.logicalSlotHash,
        attempt: attempt.attempt,
        phase: operationSlot.phase,
        ordinal: operationSlot.ordinal,
        retryClass: operationSlot.retryClass,
      }))
    } catch { /* unresolved operation remains fail-closed */ }
    if (operationSlot.retryClass === 'new-task-only') manualRecovery()
    let authorityPermit: DurableDelegationOperationResolutionAuthorityV1 | undefined
    try {
      authorityPermit = resolveAmbiguity(Object.freeze({
        runRootHash,
        taskId: authority.identity.taskId,
        controlLogicalSlotHash: operationSlot.logicalSlotHash,
        journalLogicalSlotHash: key.logicalSlotHash,
        attempt: attempt.attempt,
        phase: operationSlot.phase,
        ordinal: operationSlot.ordinal,
        retryClass: operationSlot.retryClass,
      }))
    } catch { ambiguous() }
    if (authorityPermit === undefined) ambiguous()
    let resolved: ReturnType<DurableDelegationBoundOperationControlV1['resolve']>
    try { resolved = resolve.call(control, authorityPermit) } catch (error) {
      if (error instanceof DurableDelegationOperationControlError &&
        error.code === 'DELEGATION_OPERATION_CONTROL_BUDGET_DENIED') throw error
      ambiguous()
    }
    try { onResolutionApplied(interruptionRequest(operationSlot, attempt, key), resolved.decision) } catch {
      ambiguous()
    }
    return resolved
  }

  const interruptionRequest = (
    operationSlot: Readonly<DurableDelegationOperationSlotViewV1>,
    attempt: Readonly<DurableDelegationOperationAttemptViewV1>,
    key: Readonly<DurableDelegationOperationKeyV2>,
  ): DurableDelegationResolutionRequestV2 => Object.freeze({
    runRootHash,
    taskId: authority.identity.taskId,
    controlLogicalSlotHash: operationSlot.logicalSlotHash,
    journalLogicalSlotHash: key.logicalSlotHash,
    attempt: attempt.attempt,
    phase: operationSlot.phase,
    ordinal: operationSlot.ordinal,
    retryClass: operationSlot.retryClass,
  })

  const interruptAmbiguous = (
    operationSlot: Readonly<DurableDelegationOperationSlotViewV1>,
    attempt: Readonly<DurableDelegationOperationAttemptViewV1>,
    key: Readonly<DurableDelegationOperationKeyV2>,
  ): never => {
    try { onAmbiguity(interruptionRequest(operationSlot, attempt, key)) } catch {
      // Persistence failure cannot turn ambiguity into a retry.
    }
    if (operationSlot.retryClass === 'new-task-only') manualRecovery()
    ambiguous()
  }

  const runOperation = async <T>(input: Readonly<{
    sequence: number
    phase: 'provider' | 'tool'
    ordinal: number
    canonicalRequestHash: string
    quote: Readonly<DurableDelegationOperationQuoteV2>
    start: () => CapturedOwnedOperation<T>
    capture: (value: T) => Readonly<DurableDelegationProviderFinalizedV1> |
      Readonly<DurableDelegationToolFinalizedV1>
    signal?: AbortSignal
    toolName?: string
  }>): Promise<ModelResponse | ToolResult> => {
    let hydrated = hydrate()
    if (input.sequence !== replayCursor || input.sequence > hydrated.controlState.sequenceLength + 1) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    let operationSlot = hydrated.controlState.slots[input.sequence - 1]
    if (operationSlot !== undefined && (operationSlot.phase !== input.phase ||
      operationSlot.ordinal !== input.ordinal ||
      operationSlot.canonicalRequestHash !== input.canonicalRequestHash)) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    if (operationSlot === undefined && input.sequence !== hydrated.controlState.sequenceLength + 1) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    if (isAborted(input.signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
    const logical: DurableDelegationLogicalOperationV2 = Object.freeze({
      schemaVersion: 2,
      sequence: input.sequence,
      phase: input.phase,
      ordinal: input.ordinal,
      canonicalRequestHash: input.canonicalRequestHash,
      authorityHash: authority.authorityHash,
      policyRevision,
      retryClass: input.quote.retryClass ?? 'retry-once',
      maximumCharge: Object.freeze({
        iterations: input.quote.iterations,
        spendUsdNanos: input.quote.spendUsdNanos,
      }),
    })
    let expected: ReturnType<DurableDelegationBoundOperationControlV1['expect']>
    try { expected = expectOperation.call(control, logical) } catch (error) {
      if (error instanceof DurableDelegationLiveAdapterError ||
        error instanceof DurableDelegationOperationControlError) throw error
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    operationSlot = expected.slot
    let attempt = expected.attempt
    let key = journalKey(
      operationSlot.phase,
      operationSlot.ordinal,
      operationSlot.canonicalRequestHash,
      attempt.attempt,
      attempt.resolutionHash,
    )
    if (operationSlot.resolution?.decision === 'cancel') {
      try {
        onResolutionApplied(interruptionRequest(operationSlot, attempt, key), 'cancel')
      } catch { ambiguous() }
      fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
    }
    if (operationSlot.resolution?.decision === 'retry-once' && attempt.attempt === 2) {
      const first = operationSlot.attempts.find(item => item.attempt === 1)
      if (first === undefined) fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
      const firstKey = journalKey(
        operationSlot.phase,
        operationSlot.ordinal,
        operationSlot.canonicalRequestHash,
        1,
        first.resolutionHash,
      )
      try {
        onResolutionApplied(interruptionRequest(operationSlot, first, firstKey), 'retry-once')
      } catch { ambiguous() }
    }
    const existing = hydrated.inventory.entries.find(entry =>
      entry.key.logicalSlotHash === key.logicalSlotHash && entry.key.attempt === key.attempt)
    if (existing?.state === 'settled') {
      if (isStoppedPayload(existing.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      if (attempt.budgetState === 'overrun') fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
      replayCursor += 1
      return input.phase === 'provider'
        ? storedProviderOutput(existing.payload)
        : storedToolOutput(existing.payload).output
    }
    if (existing?.state === 'ambiguous') {
      const resolution = requestResolution(operationSlot, attempt, key)
      if (resolution.decision === 'cancel') fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      operationSlot = resolution.slot
      attempt = resolution.attempt
      key = journalKey(
        operationSlot.phase,
        operationSlot.ordinal,
        operationSlot.canonicalRequestHash,
        attempt.attempt,
        attempt.resolutionHash,
      )
    }
    if (attempt.preparedHash === undefined) {
      try {
        attempt = markPrepared.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
          preparedHash: preparedHashV2(key),
        })
      } catch { ambiguous() }
    } else if (attempt.preparedHash !== preparedHashV2(key)) {
      fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    }
    let prepared: ReturnType<DurableDelegationOperationJournalV2['prepare']>
    try { prepared = prepare.call(journal, key) } catch { ambiguous() }
    if (prepared.state === 'drift') fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
    if (prepared.state === 'ambiguous') {
      try {
        markAmbiguous.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
        })
      } catch { /* the durable journal remains authoritative ambiguity */ }
      return interruptAmbiguous(operationSlot, attempt, key)
    }
    if (prepared.state === 'settled') {
      const recovered = hydrate()
      if (isStoppedPayload(prepared.payload)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      const recoveredAttempt = recovered.controlState.slots[input.sequence - 1]?.attempts.find(
        item => item.attempt === prepared.key.attempt,
      )
      if (recoveredAttempt?.budgetState === 'overrun') {
        fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
      }
      replayCursor += 1
      return input.phase === 'provider'
        ? storedProviderOutput(prepared.payload)
        : storedToolOutput(prepared.payload).output
    }
    let owned: CapturedOwnedOperation<T>
    try { owned = input.start() } catch {
      try {
        markAmbiguous.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
        })
      } catch { /* pause is still mandatory */ }
      return interruptAmbiguous(operationSlot, attempt, key)
    }
    const completion = await awaitOwnedOperation(owned, input.signal)
    if (completion.state === 'stopped') {
      let stoppedState: Extract<ReturnType<DurableDelegationOperationJournalV2['settle']>, {
        state: 'settled'
      }>
      try {
        stoppedState = settle.call(journal, prepared.permit, {
          payload: STOPPED_PAYLOAD,
          receipt: {
            spendUsd: journalSpendUsd(completion.receipt.spendUsdNanos),
            wallMs: completion.receipt.wallMs,
            effect: 'none',
            ...(completion.receipt.inputTokens === undefined
              ? {}
              : { inputTokens: completion.receipt.inputTokens }),
            ...(completion.receipt.outputTokens === undefined
              ? {}
              : { outputTokens: completion.receipt.outputTokens }),
          },
        })
      } catch { ambiguous() }
      try {
        reconcileSettled.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
          preparedHash: preparedHashV2(key),
          receipt: controlReceiptV2(key, stoppedState.payload, stoppedState.receipt),
        })
      } catch { ambiguous() }
      replayCursor += 1
      fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
    }
    if (completion.state === 'ambiguous') {
      try {
        markAmbiguous.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
        })
      } catch { /* pause is still mandatory */ }
      return interruptAmbiguous(operationSlot, attempt, key)
    }
    let finalized: ReturnType<typeof input.capture>
    try { finalized = input.capture(completion.value) } catch {
      try {
        markAmbiguous.call(control, {
          logicalSlotHash: operationSlot.logicalSlotHash,
          attempt: attempt.attempt,
        })
      } catch { /* pause is still mandatory */ }
      return interruptAmbiguous(operationSlot, attempt, key)
    }
    let payload: unknown
    let receiptInput: Readonly<{
      spendUsd: number
      wallMs: number
      effect: 'none' | 'read' | 'mutation'
      inputTokens?: number
      outputTokens?: number
      evidenceHash?: string
    }>
    if (input.phase === 'provider') {
      const providerFinalized = finalized as Readonly<DurableDelegationProviderFinalizedV1>
      payload = providerPayload(providerFinalized.output)
      receiptInput = Object.freeze({
        spendUsd: journalSpendUsd(providerFinalized.receipt.spendUsdNanos),
        wallMs: providerFinalized.receipt.wallMs,
        effect: 'read' as const,
        inputTokens: providerFinalized.receipt.inputTokens,
        outputTokens: providerFinalized.receipt.outputTokens,
      })
    } else {
      const toolFinalized = finalized as Readonly<DurableDelegationToolFinalizedV1>
      const definition = runtimeToolDefinition(input.toolName ?? '')
      const expectedEffect = definition?.effect === 'read'
        ? 'read' as const
        : definition?.effect === 'sentinel'
          ? 'none' as const
          : 'mutation' as const
      const actionStatus = toolFinalized.receipt.effect === expectedEffect
        ? toolFinalized.receipt.actionStatus
        : 'unverified' as const
      payload = toolPayload(toolFinalized.output, actionStatus)
      receiptInput = Object.freeze({
        spendUsd: journalSpendUsd(toolFinalized.receipt.spendUsdNanos),
        wallMs: toolFinalized.receipt.wallMs,
        effect: expectedEffect,
        ...(toolFinalized.receipt.evidenceHash === undefined
          ? {}
          : { evidenceHash: toolFinalized.receipt.evidenceHash }),
      })
    }
    let settledState: Extract<ReturnType<DurableDelegationOperationJournalV2['settle']>, {
      state: 'settled'
    }>
    try {
      settledState = settle.call(journal, prepared.permit, { payload, receipt: receiptInput })
    } catch { ambiguous() }
    let reconciled: DurableDelegationOperationAttemptViewV1
    try {
      reconciled = reconcileSettled.call(control, {
        logicalSlotHash: operationSlot.logicalSlotHash,
        attempt: attempt.attempt,
        preparedHash: preparedHashV2(key),
        receipt: controlReceiptV2(key, settledState.payload, settledState.receipt),
      })
    } catch { ambiguous() }
    if (reconciled.budgetState === 'overrun') {
      fail('DURABLE_DELEGATION_LIVE_COST_EXCEEDED')
    }
    replayCursor += 1
    return input.phase === 'provider'
      ? storedProviderOutput(settledState.payload)
      : storedToolOutput(settledState.payload).output
  }

  const provider: ProviderAdapter = Object.freeze({
    async complete(
      request: ModelRequest,
      signal?: AbortSignal,
      onProgress?: ModelProgressSink,
    ): Promise<ModelResponse> {
      const captured = requestSnapshot(request)
      if (captured.request.sessionId !== authority.identity.childSessionId ||
        captured.request.turnId !== childTurnId) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      const requestHash = hashDurableDelegationOperationRequestV2({
        providerIdentityHash,
        ...captured.hashInput as Record<string, unknown>,
      })
      if (isAborted(signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      const sequence = replayCursor
      if (inFlightSequences.has(sequence)) ambiguous()
      inFlightSequences.add(sequence)
      try {
        const hydrated = hydrate()
        const replay = hydrated.controlState.slots[sequence - 1]
        if (replay !== undefined && (replay.phase !== 'provider' ||
          replay.canonicalRequestHash !== requestHash)) {
          fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
        }
        const ordinal = replay?.ordinal ?? Math.max(0, ...hydrated.controlState.slots
          .filter(item => item.phase === 'provider').map(item => item.ordinal)) + 1
        let quote: Readonly<DurableDelegationOperationQuoteV2>
        try {
          // The quote owner gets an isolated byte copy, so it cannot rewrite
          // the exact request later handed to the external provider port.
          quote = captureQuoteV2(quoteProvider.call(
            quoteOwner,
            requestSnapshot(captured.request).request,
          ))
        } catch (error) {
          if (error instanceof DurableDelegationLiveAdapterError) throw error
          fail('DURABLE_DELEGATION_LIVE_QUOTE_REQUIRED')
        }
        if (quote.iterations !== 1) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
        return await runOperation<DurableDelegationProviderFinalizedV1>({
          sequence,
          phase: 'provider',
          ordinal,
          canonicalRequestHash: requestHash,
          quote,
          start: () => captureOwnedOperation(providerStart.call(
            providerOwner,
            providerRequestWithAttempt(captured),
            signal,
            onProgress,
          )),
          capture: providerFinalizedSnapshot,
          ...(signal === undefined ? {} : { signal }),
        }) as ModelResponse
      } finally {
        inFlightSequences.delete(sequence)
      }
    },
  })

  const adapter: DurableDelegationLiveAdapterV2 = {
    provider,

    async executeTool(call, context): Promise<ToolResult> {
      const captured = toolSnapshot(call)
      if (!isGenuineToolExecutionContextFor(context, captured.name) ||
        !Number.isSafeInteger(context.ordinal) || context.ordinal < 1 ||
        context.sessionId !== authority.identity.childSessionId || context.turnId !== childTurnId) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      const definition = runtimeToolDefinition(captured.name)
      if (definition === undefined || (definition.effect !== 'read' &&
        definition.effect !== 'sentinel' && definition.scopedPathArg === undefined)) {
        fail('DURABLE_DELEGATION_LIVE_CONTEXT_INVALID')
      }
      const requestHash = hashDurableDelegationOperationRequestV2({
        name: captured.name,
        args: captured.args,
        ...(captured.sourceSpanProvenance === undefined
          ? {}
          : { sourceSpanProvenance: captured.sourceSpanProvenance }),
        sessionId: context.sessionId,
        turnId: context.turnId,
        ordinal: context.ordinal,
      })
      if (isAborted(context.signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      const sequence = replayCursor
      if (inFlightSequences.has(sequence)) ambiguous()
      inFlightSequences.add(sequence)
      try {
        const hydrated = hydrate()
        const replay = hydrated.controlState.slots[sequence - 1]
        if (replay !== undefined && (replay.phase !== 'tool' ||
          replay.ordinal !== context.ordinal || replay.canonicalRequestHash !== requestHash)) {
          fail('DURABLE_DELEGATION_LIVE_OPERATION_DRIFT')
        }
        let quote: Readonly<DurableDelegationOperationQuoteV2>
        try { quote = captureQuoteV2(quoteTool.call(quoteOwner, captured, context)) } catch (error) {
          if (error instanceof DurableDelegationLiveAdapterError) throw error
          fail('DURABLE_DELEGATION_LIVE_QUOTE_REQUIRED')
        }
        if (quote.iterations !== 0) fail('DURABLE_DELEGATION_LIVE_CONFIG_INVALID')
        return await runOperation<DurableDelegationToolFinalizedV1>({
          sequence,
          phase: 'tool',
          ordinal: context.ordinal,
          canonicalRequestHash: requestHash,
          quote,
          start: () => captureOwnedOperation(toolStart.call(toolOwner, captured, context)),
          capture: toolFinalizedSnapshot,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          toolName: captured.name,
        }) as ToolResult
      } finally {
        inFlightSequences.delete(sequence)
      }
    },

    readCost(): IterationCost {
      if (inFlightSequences.size !== 0) ambiguous()
      hydrate()
      return currentCost()
    },

    async verify(candidate, signal): Promise<DurableDelegationVerification> {
      if (isAborted(signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      if (inFlightSequences.size !== 0) ambiguous()
      const entries = assertAuthoritySealed()
      const hydrated = hydrate()
      const current = hydrated.controlState
      const candidateSnapshot = frozenJson(candidate)
      const candidateHash = sha256(
        CANDIDATE_V2_DOMAIN,
        canonicalJson(candidateSnapshot, MAX_PAYLOAD_BYTES),
      )
      if (replayCursor !== current.sequenceLength + 1 || current.slots.length === 0 ||
        (current.state !== 'open' && (current.candidateHash !== candidateHash ||
          current.state !== 'sealed')) || current.slots.some(operationSlot => {
        const finalAttempt = operationSlot.attempts.find(item => item.attempt ===
          (operationSlot.resolution?.decision === 'retry-once' ? 2 : 1))
        return operationSlot.resolution?.decision === 'cancel' || finalAttempt?.receipt === undefined ||
          finalAttempt.budgetState !== 'charged' || finalAttempt.ambiguous ||
          finalAttempt.receipt.outcome !== 'completed'
      })) {
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
      const beforeInventory = inventoryFingerprintV2(hydrated.inventory.entries)
      const beforeSequenceLength = current.sequenceLength
      const wasSealed = current.state === 'sealed'
      const operations = Object.freeze(readEvidence.call(control).map(item => frozenJson(item)))
      let verification: DurableDelegationVerification
      try {
        verification = captureVerificationV2(await verifier(Object.freeze({
          schemaVersion: 2 as const,
          runRootHash,
          bindingHash,
          delegationId: authority.identity.delegationId,
          taskId: authority.identity.taskId,
          authorityHash: authority.authorityHash,
          policyRevision,
          candidateHash,
          candidate: candidateSnapshot,
          shard: entries,
          cost: currentCost(),
          operations,
        }), signal))
      } catch {
        if (wasSealed) {
          throw makeDurableDelegationRecoverableInterruption(
            'DELEGATION_MANUAL_RECOVERY_REQUIRED',
          )
        }
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
      if (isAborted(signal)) fail('DURABLE_DELEGATION_LIVE_OPERATION_STOPPED')
      if (!verification.verified) {
        if (wasSealed) {
          throw makeDurableDelegationRecoverableInterruption(
            'DELEGATION_MANUAL_RECOVERY_REQUIRED',
          )
        }
        return verification
      }
      const afterVerification = hydrate()
      if (afterVerification.controlState.state !== (wasSealed ? 'sealed' : 'open') ||
        (wasSealed && afterVerification.controlState.candidateHash !== candidateHash) ||
        afterVerification.controlState.sequenceLength !== beforeSequenceLength ||
        replayCursor !== beforeSequenceLength + 1 ||
        inventoryFingerprintV2(afterVerification.inventory.entries) !== beforeInventory) {
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
      if (wasSealed) return verification
      let sealed: ReturnType<DurableDelegationBoundOperationControlV1['seal']>
      try {
        sealed = seal.call(control, { expectedLength: beforeSequenceLength, candidateHash })
      } catch { fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED') }
      const afterSeal = hydrate()
      if (sealed.state !== 'sealed' || sealed.candidateHash !== candidateHash ||
        afterSeal.controlState.state !== 'sealed' ||
        afterSeal.controlState.candidateHash !== candidateHash ||
        afterSeal.controlState.sequenceLength !== beforeSequenceLength ||
        inventoryFingerprintV2(afterSeal.inventory.entries) !== beforeInventory) {
        fail('DURABLE_DELEGATION_LIVE_VERIFICATION_REFUSED')
      }
      return verification
    },
  }
  return Object.freeze(adapter)
}

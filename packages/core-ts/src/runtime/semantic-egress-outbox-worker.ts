import {
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  semanticEgressOutboxEventId,
  type SemanticEgressOutboxEventV1,
} from './semantic-egress-consent.js'

export type SemanticEgressOutboxDeliveryResult =
  | { status: 'accepted' }
  | { status: 'duplicate-exact' }

export type SemanticEgressOutboxAckHeadResult =
  | 'acked'
  | 'already-acked'
  | 'not-head'
  | 'unknown'

export interface SemanticEgressOutboxDurablePort {
  /**
   * Returns unacknowledged events in durable insertion-sequence order.
   * The durable boundary MUST verify canonical payload, private anchor and eventId
   * before returning. Recovery/request event IDs cannot be recomputed from their
   * deliberately redacted public envelope without that private anchor.
   */
  readOutbox(limit: number): Promise<SemanticEgressOutboxEventV1[]>
  /** Acknowledges only the current durable head; result is idempotent for the same exact event. */
  ackOutboxHead(eventId: string): Promise<SemanticEgressOutboxAckHeadResult>
}

export interface SemanticEgressOutboxSink {
  deliver(
    event: Readonly<SemanticEgressOutboxEventV1>,
    signal: AbortSignal,
  ): Promise<SemanticEgressOutboxDeliveryResult>
}

export interface SemanticEgressOutboxRunSummary {
  read: number
  accepted: number
  duplicates: number
  acknowledged: number
}

export interface SemanticEgressOutboxWorker {
  /** Concurrent calls are coalesced into the same bounded sequential pass. */
  run(signal?: AbortSignal): Promise<Readonly<SemanticEgressOutboxRunSummary>>
  /** Permanently stops this instance; only the instance owning a pass can abort it. */
  stop(): void
}

export class SemanticEgressOutboxWorkerError extends Error {
  constructor(public readonly code:
    | 'INVALID_INPUT'
    | 'READ_FAILED'
    | 'READ_TIMEOUT'
    | 'INVALID_EVENT'
    | 'DELIVERY_FAILED'
    | 'DELIVERY_TIMEOUT'
    | 'ACK_FAILED'
    | 'ACK_TIMEOUT'
    | 'RUN_ABORTED'
    | 'STOPPED',
  ) {
    super(code)
    this.name = 'SemanticEgressOutboxWorkerError'
  }
}

const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 1_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 15_000
const MAX_DELIVERY_TIMEOUT_MS = 120_000
const DEFAULT_DURABLE_TIMEOUT_MS = 5_000
const MAX_DURABLE_TIMEOUT_MS = 60_000
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const PURPOSE = 'memory.semantic-embedding.v1'
const EVENT_KEYS = new Set([
  'schemaVersion', 'eventId', 'kind', 'operatorId', 'profileId', 'purpose',
  'authorityId', 'authorityRevision', 'generation', 'connectionId',
  'connectionRevision', 'semanticDescriptorId', 'disclosureRevision',
  'disclosureHash', 'at',
])
const EVENT_KEYS_WITH_CODE = new Set([...EVENT_KEYS, 'code'])
const DELIVERY_KEYS = new Set(['status'])
const EVENT_KINDS = new Set<SemanticEgressOutboxEventV1['kind']>([
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
const LIFECYCLE_EVENT_KINDS = new Set<SemanticEgressOutboxEventV1['kind']>([
  'memory.semantic_egress.disclosure_issued',
  'memory.semantic_egress.consent_granted',
  'memory.semantic_egress.activated',
  'memory.semantic_egress.degraded',
  'memory.semantic_egress.revoke_started',
  'memory.semantic_egress.purge_completed',
  'memory.semantic_egress.revoked',
  'memory.semantic_egress.blocked',
])

type SharedAbortCode = 'RUN_ABORTED' | 'STOPPED'

interface SharedOutboxPass {
  readonly controller: AbortController
  readonly promise: Promise<Readonly<SemanticEgressOutboxRunSummary>>
  readonly cleanups: Array<() => void>
  abortCode: SharedAbortCode | null
  abort(code: SharedAbortCode): void
}

const ACTIVE_OUTBOX_PASSES = new WeakMap<object, SharedOutboxPass>()

function fail(code: SemanticEgressOutboxWorkerError['code']): never {
  throw new SemanticEgressOutboxWorkerError(code)
}

function exactObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail('INVALID_EVENT')
    }
    const actual = Reflect.ownKeys(value)
    if (actual.length !== keys.size ||
      actual.some(key => typeof key !== 'string' || !keys.has(key))) {
      return fail('INVALID_EVENT')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return fail('INVALID_EVENT')
      }
      copy[key] = descriptor.value
    }
    return copy
  } catch (error) {
    if (error instanceof SemanticEgressOutboxWorkerError) throw error
    return fail('INVALID_EVENT')
  }
}

function clean(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    return fail('INVALID_EVENT')
  }
  return value
}

function identifier(value: unknown): string {
  const result = clean(value, 128)
  if (!ID.test(result)) return fail('INVALID_EVENT')
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return fail('INVALID_EVENT')
  return value
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail('INVALID_EVENT')
  return Number(value)
}

function instant(value: unknown): string {
  if (typeof value !== 'string') return fail('INVALID_EVENT')
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return fail('INVALID_EVENT')
  }
  return value
}

function validateEvent(value: unknown): Readonly<SemanticEgressOutboxEventV1> {
  const hasCode = (() => {
    try {
      return typeof value === 'object' && value !== null && Object.hasOwn(value, 'code')
    } catch {
      return fail('INVALID_EVENT')
    }
  })()
  const raw = exactObject(value, hasCode ? EVENT_KEYS_WITH_CODE : EVENT_KEYS)
  if (raw['schemaVersion'] !== 1 || raw['purpose'] !== PURPOSE ||
    raw['disclosureRevision'] !== SEMANTIC_EGRESS_DISCLOSURE_REVISION ||
    raw['disclosureHash'] !== SEMANTIC_EGRESS_DISCLOSURE_HASH ||
    !EVENT_KINDS.has(raw['kind'] as SemanticEgressOutboxEventV1['kind'])) {
    return fail('INVALID_EVENT')
  }
  const kind = raw['kind'] as SemanticEgressOutboxEventV1['kind']
  const authorityId = identifier(raw['authorityId'])
  const authorityRevision = positiveInteger(raw['authorityRevision'])
  const eventId = hash(raw['eventId'])
  if (LIFECYCLE_EVENT_KINDS.has(kind) && eventId !== semanticEgressOutboxEventId({
    authorityId,
    authorityRevision,
    kind,
  })) {
    return fail('INVALID_EVENT')
  }
  const event: SemanticEgressOutboxEventV1 = {
    schemaVersion: 1,
    eventId,
    kind,
    operatorId: clean(raw['operatorId'], 1024),
    profileId: clean(raw['profileId'], 1024),
    purpose: PURPOSE,
    authorityId,
    authorityRevision,
    generation: positiveInteger(raw['generation']),
    connectionId: clean(raw['connectionId'], 512),
    connectionRevision: clean(raw['connectionRevision'], 512),
    semanticDescriptorId: hash(raw['semanticDescriptorId']),
    disclosureRevision: SEMANTIC_EGRESS_DISCLOSURE_REVISION,
    disclosureHash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
    ...(hasCode ? { code: cleanCode(raw['code']) } : {}),
    at: instant(raw['at']),
  }
  return Object.freeze(event)
}

function cleanCode(value: unknown): string {
  if (typeof value !== 'string' || !STABLE_CODE.test(value)) return fail('INVALID_EVENT')
  return value
}

function validateBatch(value: unknown, batchSize: number): ReadonlyArray<Readonly<SemanticEgressOutboxEventV1>> {
  try {
    if (!Array.isArray(value) || value.length > batchSize) return fail('INVALID_EVENT')
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.at(-1) !== 'length') return fail('INVALID_EVENT')
    const events: Array<Readonly<SemanticEgressOutboxEventV1>> = []
    for (let index = 0; index < value.length; index += 1) {
      if (keys[index] !== String(index)) return fail('INVALID_EVENT')
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return fail('INVALID_EVENT')
      }
      events.push(validateEvent(descriptor.value))
    }
    if (new Set(events.map(event => event.eventId)).size !== events.length) return fail('INVALID_EVENT')
    return Object.freeze(events)
  } catch (error) {
    if (error instanceof SemanticEgressOutboxWorkerError) throw error
    return fail('INVALID_EVENT')
  }
}

function validateDelivery(value: unknown): SemanticEgressOutboxDeliveryResult {
  let raw: Record<string, unknown>
  try {
    raw = exactObject(value, DELIVERY_KEYS)
  } catch {
    throw new SemanticEgressOutboxWorkerError('DELIVERY_FAILED')
  }
  if (raw['status'] !== 'accepted' && raw['status'] !== 'duplicate-exact') {
    throw new SemanticEgressOutboxWorkerError('DELIVERY_FAILED')
  }
  return { status: raw['status'] }
}

function sharedAbortError(pass: SharedOutboxPass): SemanticEgressOutboxWorkerError {
  return new SemanticEgressOutboxWorkerError(pass.abortCode ?? 'RUN_ABORTED')
}

function assertPassActive(pass: SharedOutboxPass): void {
  if (pass.controller.signal.aborted) throw sharedAbortError(pass)
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    return typeof value === 'object' && value !== null &&
      typeof (value as AbortSignal).aborted === 'boolean' &&
      typeof (value as AbortSignal).addEventListener === 'function' &&
      typeof (value as AbortSignal).removeEventListener === 'function'
  } catch {
    return false
  }
}

function runBoundedByAbort<T>(input: {
  pass: SharedOutboxPass
  operation(): Promise<T>
  failureCode: 'READ_FAILED' | 'ACK_FAILED'
  timeoutCode: 'READ_TIMEOUT' | 'ACK_TIMEOUT'
  timeoutMs: number
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.pass.controller.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(sharedAbortError(input.pass)))
    const timer = setTimeout(() => finish(() => reject(
      new SemanticEgressOutboxWorkerError(input.timeoutCode),
    )), input.timeoutMs)
    timer.unref()
    input.pass.controller.signal.addEventListener('abort', onAbort, { once: true })
    if (input.pass.controller.signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve()
      .then(() => {
        assertPassActive(input.pass)
        return input.operation()
      })
      .then(
        value => finish(() => resolve(value)),
        () => finish(() => reject(input.pass.controller.signal.aborted
          ? sharedAbortError(input.pass)
          : new SemanticEgressOutboxWorkerError(input.failureCode))),
      )
  })
}

function deliverWithTimeout(input: {
  event: Readonly<SemanticEgressOutboxEventV1>
  sink: SemanticEgressOutboxSink
  pass: SharedOutboxPass
  timeoutMs: number
}): Promise<SemanticEgressOutboxDeliveryResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const attempt = new AbortController()
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.pass.controller.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      attempt.abort(sharedAbortError(input.pass))
      finish(() => reject(sharedAbortError(input.pass)))
    }
    const timer = setTimeout(() => {
      const error = new SemanticEgressOutboxWorkerError('DELIVERY_TIMEOUT')
      attempt.abort(error)
      finish(() => reject(error))
    }, input.timeoutMs)
    timer.unref()
    input.pass.controller.signal.addEventListener('abort', onAbort, { once: true })
    if (input.pass.controller.signal.aborted) {
      onAbort()
      return
    }
    Promise.resolve()
      .then(() => {
        assertPassActive(input.pass)
        return input.sink.deliver(input.event, attempt.signal)
      })
      .then(
        value => finish(() => {
          try { resolve(validateDelivery(value)) } catch { reject(new SemanticEgressOutboxWorkerError('DELIVERY_FAILED')) }
        }),
        () => finish(() => reject(new SemanticEgressOutboxWorkerError('DELIVERY_FAILED'))),
      )
  })
}

export function makeSemanticEgressOutboxWorker(input: {
  durable: SemanticEgressOutboxDurablePort
  sink: SemanticEgressOutboxSink
  batchSize?: number
  deliveryTimeoutMs?: number
  durableTimeoutMs?: number
}): SemanticEgressOutboxWorker {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const deliveryTimeoutMs = input.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS
  const durableTimeoutMs = input.durableTimeoutMs ?? DEFAULT_DURABLE_TIMEOUT_MS
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE ||
    !Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 ||
    deliveryTimeoutMs > MAX_DELIVERY_TIMEOUT_MS ||
    !Number.isSafeInteger(durableTimeoutMs) || durableTimeoutMs < 1 ||
    durableTimeoutMs > MAX_DURABLE_TIMEOUT_MS ||
    typeof input.durable !== 'object' || input.durable === null ||
    typeof input.durable?.readOutbox !== 'function' ||
    typeof input.durable?.ackOutboxHead !== 'function' ||
    typeof input.sink?.deliver !== 'function') {
    throw new SemanticEgressOutboxWorkerError('INVALID_INPUT')
  }
  let stopped = false
  let ownedPass: SharedOutboxPass | null = null

  const runOnce = async (
    pass: SharedOutboxPass,
  ): Promise<Readonly<SemanticEgressOutboxRunSummary>> => {
    assertPassActive(pass)
    const rawBatch = await runBoundedByAbort({
      pass,
      operation: () => input.durable.readOutbox(batchSize),
      failureCode: 'READ_FAILED',
      timeoutCode: 'READ_TIMEOUT',
      timeoutMs: durableTimeoutMs,
    })
    const events = validateBatch(rawBatch, batchSize)
    let accepted = 0
    let duplicates = 0
    let acknowledged = 0
    for (const event of events) {
      assertPassActive(pass)
      const delivery = await deliverWithTimeout({
        event,
        sink: input.sink,
        pass,
        timeoutMs: deliveryTimeoutMs,
      })
      if (delivery.status === 'accepted') accepted += 1
      else duplicates += 1
      assertPassActive(pass)
      let acked: SemanticEgressOutboxAckHeadResult
      try {
        acked = await runBoundedByAbort({
          pass,
          operation: () => input.durable.ackOutboxHead(event.eventId),
          failureCode: 'ACK_FAILED',
          timeoutCode: 'ACK_TIMEOUT',
          timeoutMs: durableTimeoutMs,
        })
      } catch (error) {
        if (pass.controller.signal.aborted) throw sharedAbortError(pass)
        if (error instanceof SemanticEgressOutboxWorkerError && error.code === 'ACK_TIMEOUT') {
          throw error
        }
        throw new SemanticEgressOutboxWorkerError('ACK_FAILED')
      }
      if (acked !== 'acked' && acked !== 'already-acked') {
        throw new SemanticEgressOutboxWorkerError('ACK_FAILED')
      }
      acknowledged += 1
    }
    return Object.freeze({ read: events.length, accepted, duplicates, acknowledged })
  }

  const createPass = (): SharedOutboxPass => {
    const controller = new AbortController()
    let pass!: SharedOutboxPass
    const cleanups: Array<() => void> = []
    const task = Promise.resolve().then(() => runOnce(pass))
    const promise = task.finally(() => {
      for (const cleanup of cleanups.splice(0)) cleanup()
      if (ACTIVE_OUTBOX_PASSES.get(input.durable) === pass) {
        ACTIVE_OUTBOX_PASSES.delete(input.durable)
      }
    })
    pass = {
      controller,
      promise,
      cleanups,
      abortCode: null,
      abort(code) {
        if (pass.abortCode !== null) return
        pass.abortCode = code
        pass.controller.abort(new SemanticEgressOutboxWorkerError(code))
      },
    }
    return pass
  }

  const attachOwnerSignal = (pass: SharedOutboxPass, signal: AbortSignal): void => {
    const onAbort = (): void => pass.abort('RUN_ABORTED')
    signal.addEventListener('abort', onAbort, { once: true })
    pass.cleanups.push(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) onAbort()
  }

  return Object.freeze({
    run(signal?: AbortSignal): Promise<Readonly<SemanticEgressOutboxRunSummary>> {
      if (stopped) return Promise.reject(new SemanticEgressOutboxWorkerError('STOPPED'))
      const existing = ACTIVE_OUTBOX_PASSES.get(input.durable)
      // A joiner observes the owner's pass. Its signal cannot cancel work it does not own.
      if (existing !== undefined) return existing.promise
      if (signal !== undefined && !isAbortSignal(signal)) {
        return Promise.reject(new SemanticEgressOutboxWorkerError('INVALID_INPUT'))
      }
      if (signal?.aborted === true) {
        return Promise.reject(new SemanticEgressOutboxWorkerError('RUN_ABORTED'))
      }
      const pass = createPass()
      ownedPass = pass
      ACTIVE_OUTBOX_PASSES.set(input.durable, pass)
      if (signal !== undefined) attachOwnerSignal(pass, signal)
      return pass.promise
    },
    stop(): void {
      if (stopped) return
      stopped = true
      ownedPass?.abort('STOPPED')
    },
  })
}

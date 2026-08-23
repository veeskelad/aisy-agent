import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { isProxy } from 'node:util/types'

import {
  TranscriptionError,
  type TranscriptionAudioRequest,
  type TranscriptionErrorCode,
  type TranscriptionTranscript,
} from './transcription-contract.js'
import type { TranscriptionProvider } from './transcription-registry.js'

export type DeepgramEndpointHost = 'api.deepgram.com' | 'api.eu.deepgram.com'

export interface DeepgramHttpsResponse {
  readonly status: number
  /** Already collected by the code-owned transport; no iterator may outlive the request. */
  readonly body: Uint8Array | null
}

export interface DeepgramHttpsRequestPort {
  /**
   * Enforces the exact TLS destination, redirect policy and response bound.
   * Its promise settles only after abort handling and owned-resource cleanup.
   */
  request(input: Readonly<{
    method: 'POST'
    url: string
    headers: Readonly<Record<string, string>>
    body: Uint8Array
    maxResponseBytes: number
    redirect: 'error'
    signal: AbortSignal
  }>): Promise<DeepgramHttpsResponse>
}

export type DeepgramSpendOutcome =
  | Readonly<{ kind: 'settled'; billableDurationMs: number }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'released' }>

export interface DeepgramSpendReservation {
  /**
   * Idempotent first-terminal operation. Rejection guarantees zero terminal
   * commit; the authority retains durable recovery ownership until one succeeds.
   */
  settle(outcome: DeepgramSpendOutcome): Promise<void>
}

export interface DeepgramSpendAuthority {
  /**
   * Settles only after its cancellation cleanup. If a reservation was durably
   * created before abort, it must resolve that handle; committed-then-reject or
   * committed-then-null would orphan budget and is forbidden.
   */
  reserve(input: Readonly<{
    providerId: 'deepgram-cloud' | 'deepgram-eu'
    requestHash: string
    maximumBillableDurationMs: number
    signal: AbortSignal
  }>): Promise<DeepgramSpendReservation | null>
}

interface DeepgramProviderOptions {
  readonly endpointHost: DeepgramEndpointHost
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maximumBillableDurationMs: number
  readonly resolveSecret: (name: 'DEEPGRAM_API_KEY', signal: AbortSignal) => Promise<string | null>
  readonly http: DeepgramHttpsRequestPort
  readonly spend: DeepgramSpendAuthority
  readonly monotonicNow: () => number
}

interface ValidatedRequest {
  readonly audioRoot: string
  readonly relativePath: string
  readonly expectedSha256: string
  readonly expectedSizeBytes: number
  readonly maxBytes: number
  readonly language: string
  readonly signal?: AbortSignal
}

const HASH = /^[a-f0-9]{64}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SECRET = /^[\x21-\x7e]{8,512}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/
const NOVA_3_LANGUAGES = new Set(['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'])
const MAX_AUDIO_BYTES = 256 * 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const JSON_NODE_LIMIT = 4096
const JSON_DEPTH_LIMIT = 16

function fail(code: TranscriptionErrorCode): TranscriptionError {
  return new TranscriptionError(code)
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw fail('INVALID_REQUEST')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    throw fail('INVALID_REQUEST')
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}

function hasAccessor(value: object): boolean {
  return Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor === undefined || !('value' in descriptor)
  })
}

function snapshotHttpPort(value: unknown): DeepgramHttpsRequestPort | null {
  if (value === null || typeof value !== 'object' || isProxy(value) || hasAccessor(value)) return null
  const request = Object.getOwnPropertyDescriptor(value, 'request')?.value
  if (typeof request !== 'function' || isProxy(request)) return null
  return Object.freeze({
    request: (input: Parameters<DeepgramHttpsRequestPort['request']>[0]) => request(input),
  })
}

function snapshotSpendAuthority(value: unknown): DeepgramSpendAuthority | null {
  if (value === null || typeof value !== 'object' || isProxy(value) || hasAccessor(value)) return null
  const reserve = Object.getOwnPropertyDescriptor(value, 'reserve')?.value
  if (typeof reserve !== 'function' || isProxy(reserve)) return null
  return Object.freeze({
    reserve: (input: Parameters<DeepgramSpendAuthority['reserve']>[0]) => reserve(input),
  })
}

function snapshotReservation(value: DeepgramSpendReservation | null): DeepgramSpendReservation | null {
  if (value === null) return null
  if (typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some(key => key !== 'settle') || hasAccessor(value)) throw fail('QUOTA_EXCEEDED')
  const settle = Object.getOwnPropertyDescriptor(value, 'settle')?.value
  if (typeof settle !== 'function' || isProxy(settle)) throw fail('QUOTA_EXCEEDED')
  return Object.freeze({
    settle: (outcome: DeepgramSpendOutcome) => settle(outcome),
  })
}

function snapshotHttpResponse(value: DeepgramHttpsResponse, maximum: number): DeepgramHttpsResponse {
  if (value === null || typeof value !== 'object' || isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || hasAccessor(value) ||
    Reflect.ownKeys(value).some(key => key !== 'status' && key !== 'body')) {
    throw fail('PROTOCOL_ERROR')
  }
  const status = Object.getOwnPropertyDescriptor(value, 'status')?.value
  const body = Object.getOwnPropertyDescriptor(value, 'body')?.value
  if (!Number.isInteger(status) || status < 100 || status > 599 ||
    (body !== null && (!(body instanceof Uint8Array) || isProxy(body) ||
      Object.getPrototypeOf(body) !== Uint8Array.prototype)) ||
    (body instanceof Uint8Array &&
      ((typeof SharedArrayBuffer !== 'undefined' && body.buffer instanceof SharedArrayBuffer) ||
        body.byteLength > maximum))) throw fail('PROTOCOL_ERROR')
  const ownedBody = body === null ? null : new Uint8Array(body)
  if (ownedBody !== null && ownedBody.byteLength > maximum) throw fail('PROTOCOL_ERROR')
  return Object.freeze({
    status,
    body: ownedBody,
  })
}

function validatedOptions(value: unknown): DeepgramProviderOptions {
  const input = exactRecord(value, [
    'endpointHost', 'timeoutMs', 'maxResponseBytes', 'maximumBillableDurationMs',
    'resolveSecret', 'http', 'spend', 'monotonicNow',
  ])
  const http = snapshotHttpPort(input['http'])
  const spend = snapshotSpendAuthority(input['spend'])
  if ((input['endpointHost'] !== 'api.deepgram.com' && input['endpointHost'] !== 'api.eu.deepgram.com') ||
    !Number.isSafeInteger(input['timeoutMs']) || (input['timeoutMs'] as number) < 1_000 ||
    (input['timeoutMs'] as number) > 120_000 ||
    !Number.isSafeInteger(input['maxResponseBytes']) || (input['maxResponseBytes'] as number) < 1024 ||
    (input['maxResponseBytes'] as number) > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(input['maximumBillableDurationMs']) ||
    (input['maximumBillableDurationMs'] as number) < 1_000 ||
    (input['maximumBillableDurationMs'] as number) > 600_000 ||
    typeof input['resolveSecret'] !== 'function' || isProxy(input['resolveSecret']) ||
    (input['monotonicNow'] !== undefined &&
      (typeof input['monotonicNow'] !== 'function' || isProxy(input['monotonicNow']))) ||
    http === null || spend === null) {
    throw fail('INVALID_REQUEST')
  }
  return Object.freeze({
    ...input,
    http: http!,
    spend: spend!,
    monotonicNow: input['monotonicNow'] ?? (() => performance.now()),
  }) as unknown as DeepgramProviderOptions
}

function validateRequest(value: unknown): ValidatedRequest {
  const input = exactRecord(value, [
    'audioRoot', 'relativePath', 'expectedSha256', 'expectedSizeBytes', 'maxBytes', 'language', 'signal',
  ])
  if (typeof input['audioRoot'] !== 'string' || !isAbsolute(input['audioRoot']) ||
    normalize(input['audioRoot']) !== input['audioRoot'] || input['audioRoot'].includes('\0') ||
    typeof input['relativePath'] !== 'string' || !FILE_NAME.test(input['relativePath']) ||
    typeof input['expectedSha256'] !== 'string' || !HASH.test(input['expectedSha256']) ||
    !Number.isSafeInteger(input['expectedSizeBytes']) || (input['expectedSizeBytes'] as number) < 1 ||
    !Number.isSafeInteger(input['maxBytes']) || (input['maxBytes'] as number) < 1 ||
    (input['maxBytes'] as number) > MAX_AUDIO_BYTES ||
    (input['expectedSizeBytes'] as number) > (input['maxBytes'] as number) ||
    (input['signal'] !== undefined && !(input['signal'] instanceof AbortSignal))) {
    throw fail('INVALID_REQUEST')
  }
  let language = 'multi'
  if (input['language'] !== undefined) {
    if (typeof input['language'] !== 'string' || !LANGUAGE.test(input['language'].toLowerCase())) {
      throw fail('INVALID_REQUEST')
    }
    language = input['language'].toLowerCase().split('-', 1)[0]!
    if (!NOVA_3_LANGUAGES.has(language)) throw fail('INVALID_REQUEST')
  }
  return Object.freeze({
    audioRoot: input['audioRoot'],
    relativePath: input['relativePath'],
    expectedSha256: input['expectedSha256'],
    expectedSizeBytes: input['expectedSizeBytes'],
    maxBytes: input['maxBytes'],
    language,
    ...(input['signal'] instanceof AbortSignal ? { signal: input['signal'] } : {}),
  }) as ValidatedRequest
}

async function yieldForAbort(signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  if (signal.aborted) throw fail('ABORTED')
}

async function readVerifiedAudio(
  request: ValidatedRequest,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw fail('ABORTED')
  let rootInfo: ReturnType<typeof lstatSync>
  try {
    rootInfo = lstatSync(request.audioRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      realpathSync(request.audioRoot) !== request.audioRoot) throw fail('NOT_DIRECTORY')
  } catch (error) {
    if (error instanceof TranscriptionError) throw error
    throw fail('IO_FAILED')
  }
  if (typeof constants.O_NOFOLLOW !== 'number') throw fail('UNSUPPORTED_PLATFORM')
  const path = resolve(join(request.audioRoot, request.relativePath))
  if (path !== join(request.audioRoot, request.relativePath)) throw fail('INVALID_PATH')
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw fail('SYMLINK_DENIED')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw fail('NOT_FOUND')
    throw fail('IO_FAILED')
  }
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile()) throw fail('NOT_REGULAR')
    if (before.nlink !== 1) throw fail('HARDLINK_DENIED')
    if (before.dev !== rootInfo.dev) throw fail('CROSS_DEVICE_DENIED')
    if (before.size !== request.expectedSizeBytes || before.size > request.maxBytes) {
      throw fail('LIMIT_EXCEEDED')
    }
    const body = Buffer.allocUnsafe(before.size)
    let offset = 0
    while (offset < body.byteLength) {
      if (signal.aborted) throw fail('ABORTED')
      const length = readSync(
        descriptor,
        body,
        offset,
        Math.min(READ_CHUNK_BYTES, body.byteLength - offset),
        null,
      )
      if (length === 0) break
      offset += length
      if (offset < body.byteLength) await yieldForAbort(signal)
    }
    const after = fstatSync(descriptor)
    if (offset !== body.byteLength || after.dev !== before.dev || after.ino !== before.ino ||
      after.size !== before.size || after.nlink !== 1) throw fail('IO_FAILED')
    if (createHash('sha256').update(body).digest('hex') !== request.expectedSha256) {
      throw fail('HASH_MISMATCH')
    }
    return body
  } finally {
    closeSync(descriptor)
  }
}

function deadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  monotonicNow: () => number,
): Readonly<{
  signal: AbortSignal
  assert(): void
  timedOut(): boolean
  close(): void
}> {
  const controller = new AbortController()
  let expired = false
  const startedAt = monotonicNow()
  if (!Number.isFinite(startedAt) || startedAt < 0) throw fail('INVALID_REQUEST')
  const expiresAt = startedAt + timeoutMs
  const abort = (): void => controller.abort()
  const expireIfDue = (): boolean => {
    if (expired) return true
    const current = monotonicNow()
    if (!Number.isFinite(current) || current < startedAt) throw fail('PROCESS_FAILED')
    if (current < expiresAt) return false
    expired = true
    controller.abort()
    return true
  }
  if (parent?.aborted === true) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { expired = true; controller.abort() }, timeoutMs)
  timer.unref()
  return Object.freeze({
    signal: controller.signal,
    assert: () => {
      if (expireIfDue()) throw fail('TIMEOUT')
      if (parent?.aborted === true) throw fail('ABORTED')
    },
    timedOut: () => {
      try { return expireIfDue() } catch { return expired }
    },
    close: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  })
}

function readBoundedBody(
  response: DeepgramHttpsResponse,
  maximum: number,
): string {
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > maximum) {
    throw fail('PROTOCOL_ERROR')
  }
  return Buffer.from(
    response.body.buffer,
    response.body.byteOffset,
    response.body.byteLength,
  ).toString('utf8')
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function assertJsonBounds(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > JSON_NODE_LIMIT || current.depth > JSON_DEPTH_LIMIT) {
      throw fail('PROTOCOL_ERROR')
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 })
    } else {
      const record = object(current.value)
      if (record !== null) {
        for (const item of Object.values(record)) {
          pending.push({ value: item, depth: current.depth + 1 })
        }
      }
    }
  }
}

function parseResponse(
  body: string,
  requestLanguage: string,
  maximumBillableDurationMs: number,
): TranscriptionTranscript {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw fail('PROTOCOL_ERROR') }
  assertJsonBounds(parsed)
  const root = object(parsed)
  const metadata = object(root?.['metadata'])
  const results = object(root?.['results'])
  const channels = Array.isArray(results?.['channels']) ? results['channels'] : null
  const channel = channels?.length === 1 ? object(channels[0]) : null
  const alternatives = Array.isArray(channel?.['alternatives']) ? channel['alternatives'] : null
  const alternative = alternatives !== null && alternatives.length > 0 ? object(alternatives[0]) : null
  const text = alternative?.['transcript']
  const duration = metadata?.['duration']
  const detected = channel?.['detected_language']
  if (typeof text !== 'string' || text.length === 0 || text.includes('\0') ||
    Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES ||
    typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
    throw fail('PROTOCOL_ERROR')
  }
  const durationMs = Math.round(duration * 1000)
  if (!Number.isSafeInteger(durationMs) || durationMs > maximumBillableDurationMs) {
    throw fail('PROTOCOL_ERROR')
  }
  const language = typeof detected === 'string' && LANGUAGE.test(detected.toLowerCase())
    ? detected.toLowerCase()
    : requestLanguage === 'multi' ? undefined : requestLanguage
  return Object.freeze({
    text,
    provenance: 'untrusted' as const,
    channel: 'voice' as const,
    ...(language === undefined ? {} : { language }),
    durationMs,
  })
}

function requestHash(
  providerId: string,
  request: ValidatedRequest,
  options: DeepgramProviderOptions,
): string {
  return createHash('sha256')
    .update('aisy.deepgram.transcription.v1\0')
    .update(providerId).update('\0')
    .update(options.endpointHost).update('\0')
    .update(request.expectedSha256).update('\0')
    .update(String(request.expectedSizeBytes)).update('\0')
    .update(request.language).update('\0')
    .update(String(options.maximumBillableDurationMs))
    .digest('hex')
}

function statusError(status: number): TranscriptionError {
  if (status === 401 || status === 403) return fail('AUTHENTICATION_FAILED')
  if (status === 408) return fail('TIMEOUT')
  if (status === 429) return fail('QUOTA_EXCEEDED')
  if (status >= 500 && status <= 599) return fail('MODEL_UNAVAILABLE')
  return fail('TRANSCRIPTION_FAILED')
}

export function deepgramTranscriptionProviderMetadata(
  endpointHost: DeepgramEndpointHost,
): Readonly<{
  id: 'deepgram-cloud' | 'deepgram-eu'
  label: string
  audioLeavesHost: true
  privacyDisclosure: string
  privacyRevision: string
}> {
  const id = endpointHost === 'api.eu.deepgram.com' ? 'deepgram-eu' : 'deepgram-cloud'
  return Object.freeze({
    id,
    label: endpointHost === 'api.eu.deepgram.com' ? 'Deepgram Nova-3 (EU)' : 'Deepgram Nova-3',
    audioLeavesHost: true,
    privacyDisclosure: endpointHost === 'api.eu.deepgram.com'
      ? 'Аудио отправляется Deepgram через европейский API.'
      : 'Аудио отправляется Deepgram через основной API.',
    privacyRevision: `${id}-direct-bytes-mip-opt-out-v1`,
  })
}

export function makeDeepgramTranscriptionProvider(rawOptions: Readonly<{
  endpointHost: DeepgramEndpointHost
  timeoutMs: number
  maxResponseBytes: number
  maximumBillableDurationMs: number
  /** Honors `signal` and settles only after its owned cancellation cleanup. */
  resolveSecret(name: 'DEEPGRAM_API_KEY', signal: AbortSignal): Promise<string | null>
  http: DeepgramHttpsRequestPort
  spend: DeepgramSpendAuthority
  /** Test seam; production defaults to the monotonic Node performance clock. */
  monotonicNow?: () => number
}>): TranscriptionProvider {
  const options = validatedOptions(rawOptions)
  const metadata = deepgramTranscriptionProviderMetadata(options.endpointHost)
  const providerId = metadata.id
  let active = false

  return Object.freeze({
    ...metadata,
    async transcribe(rawRequest: TranscriptionAudioRequest): Promise<TranscriptionTranscript> {
      if (active) throw fail('QUOTA_EXCEEDED')
      active = true
      let reservation: DeepgramSpendReservation | null = null
      let dispatched = false
      let settlementCompleted = false
      let limit: ReturnType<typeof deadline> | null = null
      let thrown: unknown = null
      let callerSignal: AbortSignal | undefined
      try {
        const request = validateRequest(rawRequest)
        callerSignal = request.signal
        if (request.signal?.aborted === true) throw fail('ABORTED')
        limit = deadline(request.signal, options.timeoutMs, options.monotonicNow)
        const body = await readVerifiedAudio(request, limit.signal)
        limit.assert()
        const secret = await options.resolveSecret('DEEPGRAM_API_KEY', limit.signal)
        limit.assert()
        if (typeof secret !== 'string' || !SECRET.test(secret)) throw fail('MODEL_UNAVAILABLE')
        reservation = snapshotReservation(await options.spend.reserve({
          providerId,
          requestHash: requestHash(providerId, request, options),
          maximumBillableDurationMs: options.maximumBillableDurationMs,
          signal: limit.signal,
        }))
        limit.assert()
        if (reservation === null || typeof reservation.settle !== 'function') {
          throw fail('QUOTA_EXCEEDED')
        }
        const query = new URLSearchParams({
          model: 'nova-3',
          language: request.language,
          smart_format: 'true',
          mip_opt_out: 'true',
        })
        const httpRequest = Object.freeze({
          method: 'POST' as const,
          url: `https://${options.endpointHost}/v1/listen?${query.toString()}`,
          headers: Object.freeze({
            accept: 'application/json',
            authorization: `Token ${secret}`,
            'content-type': 'audio/ogg',
          }),
          body,
          maxResponseBytes: options.maxResponseBytes,
          redirect: 'error' as const,
          signal: limit.signal,
        })
        limit.assert()
        dispatched = true
        const response = snapshotHttpResponse(
          await options.http.request(httpRequest),
          options.maxResponseBytes,
        )
        limit.assert()
        if (response.status < 200 || response.status > 299) throw statusError(response.status)
        const transcript = parseResponse(
          readBoundedBody(response, options.maxResponseBytes),
          request.language,
          options.maximumBillableDurationMs,
        )
        limit.assert()
        await reservation.settle({ kind: 'settled', billableDurationMs: transcript.durationMs! })
        settlementCompleted = true
        limit.assert()
        return transcript
      } catch (error) {
        const normalized = limit?.timedOut() === true
          ? fail('TIMEOUT')
          : callerSignal?.aborted === true
            ? fail('ABORTED')
            : error instanceof TranscriptionError ? error : fail('PROCESS_FAILED')
        thrown = normalized
        throw normalized
      } finally {
        limit?.close()
        if (reservation !== null && !settlementCompleted) {
          try {
            await reservation.settle({ kind: dispatched ? 'ambiguous' : 'released' })
            settlementCompleted = true
          } catch {
            if (thrown === null) throw fail('QUOTA_EXCEEDED')
          }
        }
        active = false
      }
    },
  })
}

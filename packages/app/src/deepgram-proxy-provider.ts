import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isProxy } from 'node:util/types'

import {
  TranscriptionError,
  type TranscriptionAudioRequest,
  type TranscriptionErrorCode,
  type TranscriptionTranscript,
} from './transcription-contract.js'
import type { TranscriptionProvider } from './transcription-registry.js'
import type { VoiceMediaAuthorityView } from './telegram-voice-media-capability.js'

const OPAQUE = /^[A-Za-z0-9_-]{43,128}$/
const HASH = /^[a-f0-9]{64}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/
const MAX_TRANSCRIPT_BYTES = 60 * 1024

export const deepgramProxyProviderMetadata = Object.freeze({
  id: 'deepgram-cloud' as const,
  label: 'Deepgram Nova-3',
  audioLeavesHost: true,
  privacyDisclosure: 'Аудио отправляется Deepgram через основной API.',
  privacyRevision: 'deepgram-cloud-proxy-primary-v1',
})

export type DeepgramProxyErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'AUTH_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'PROTOCOL_REFUSED'

export type DeepgramProxyResult =
  | Readonly<{ ok: true; transcript: string; language?: string; durationMs: number }>
  | Readonly<{
      ok: false
      code: DeepgramProxyErrorCode
      dispatch: 'none' | 'attempted'
    }>

export interface DeepgramProxyPort {
  stageMedia(input: VoiceMediaAuthorityView & Readonly<{ signal: AbortSignal }>): Promise<
    | Readonly<{ ok: true; mediaTicket: string }>
    | Readonly<{ ok: false; code: DeepgramProxyErrorCode }>
  >
  cancelMedia(input: Readonly<{ mediaTicket: string }>): Promise<void>
  prepare(input: Readonly<{
    mediaTicket: string
    reservationRecoveryKey: string
    signal: AbortSignal
  }>): Promise<
    | Readonly<{ ok: true; dispatchPermitId: string }>
    | Readonly<{ ok: false; code: DeepgramProxyErrorCode }>
  >
  cancelPrepared(input: Readonly<{ dispatchPermitId: string }>): Promise<
    'cancelled' | 'claimed' | 'ambiguous'
  >
  dispatch(input: Readonly<{
    dispatchPermitId: string
    signal: AbortSignal
  }>): Promise<DeepgramProxyResult>
}

export type DeepgramProxySpendOutcome =
  | Readonly<{ kind: 'settled'; billableDurationMs: number }>
  | Readonly<{ kind: 'ambiguous' }>
  | Readonly<{ kind: 'released' }>

export interface DeepgramProxySpendReservation {
  readonly recoveryKey: string
  settle(outcome: DeepgramProxySpendOutcome): Promise<void>
}

export interface DeepgramProxySpendAuthority {
  reserve(input: Readonly<{
    providerId: 'deepgram-cloud'
    requestHash: string
    maximumBillableDurationMs: number
    signal: AbortSignal
  }>): Promise<DeepgramProxySpendReservation | null>
  /** Reclaims an open hold after restart without creating a second reservation. */
  recover(recoveryKey: string): Promise<DeepgramProxySpendReservation | null>
}

interface Options {
  readonly timeoutMs: number
  readonly maximumBillableDurationMs: number
  readonly consumeMediaCapability: (
    capability: unknown,
    request: TranscriptionAudioRequest,
  ) => Readonly<VoiceMediaAuthorityView>
  readonly proxy: DeepgramProxyPort
  readonly spend: DeepgramProxySpendAuthority
  readonly monotonicNow: () => number
}

function fail(code: TranscriptionErrorCode): TranscriptionError {
  return new TranscriptionError(code)
}

function plainMethod(value: unknown, name: string): ((...args: unknown[]) => unknown) | null {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) return null
  const method = descriptors[name]?.value
  return typeof method === 'function' && !isProxy(method) ? method : null
}

function options(raw: Readonly<{
  timeoutMs: number
  maximumBillableDurationMs: number
  consumeMediaCapability: Options['consumeMediaCapability']
  proxy: DeepgramProxyPort
  spend: DeepgramProxySpendAuthority
  monotonicNow?: () => number
}>): Options {
  if (raw === null || typeof raw !== 'object' || isProxy(raw) ||
    !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1_000 || raw.timeoutMs > 120_000 ||
    !Number.isSafeInteger(raw.maximumBillableDurationMs) ||
    raw.maximumBillableDurationMs < 1_000 || raw.maximumBillableDurationMs > 600_000 ||
    typeof raw.consumeMediaCapability !== 'function' || isProxy(raw.consumeMediaCapability) ||
    (raw.monotonicNow !== undefined &&
      (typeof raw.monotonicNow !== 'function' || isProxy(raw.monotonicNow)))) {
    throw fail('INVALID_REQUEST')
  }
  const stageMedia = plainMethod(raw.proxy, 'stageMedia') as DeepgramProxyPort['stageMedia'] | null
  const cancelMedia = plainMethod(raw.proxy, 'cancelMedia') as DeepgramProxyPort['cancelMedia'] | null
  const prepare = plainMethod(raw.proxy, 'prepare') as DeepgramProxyPort['prepare'] | null
  const cancelPrepared = plainMethod(raw.proxy, 'cancelPrepared') as
    DeepgramProxyPort['cancelPrepared'] | null
  const dispatch = plainMethod(raw.proxy, 'dispatch') as DeepgramProxyPort['dispatch'] | null
  const reserve = plainMethod(raw.spend, 'reserve') as DeepgramProxySpendAuthority['reserve'] | null
  const recover = plainMethod(raw.spend, 'recover') as DeepgramProxySpendAuthority['recover'] | null
  if (stageMedia === null || cancelMedia === null || prepare === null ||
    cancelPrepared === null || dispatch === null || reserve === null || recover === null) {
    throw fail('INVALID_REQUEST')
  }
  return Object.freeze({
    timeoutMs: raw.timeoutMs,
    maximumBillableDurationMs: raw.maximumBillableDurationMs,
    consumeMediaCapability: raw.consumeMediaCapability,
    proxy: Object.freeze({
      stageMedia: (input: Parameters<DeepgramProxyPort['stageMedia']>[0]) => stageMedia(input),
      cancelMedia: (input: Parameters<DeepgramProxyPort['cancelMedia']>[0]) => cancelMedia(input),
      prepare: (input: Parameters<DeepgramProxyPort['prepare']>[0]) => prepare(input),
      cancelPrepared: (input: Parameters<DeepgramProxyPort['cancelPrepared']>[0]) =>
        cancelPrepared(input),
      dispatch: (input: Parameters<DeepgramProxyPort['dispatch']>[0]) => dispatch(input),
    }),
    spend: Object.freeze({
      reserve: (input: Parameters<DeepgramProxySpendAuthority['reserve']>[0]) => reserve(input),
      recover: (recoveryKey: string) => recover(recoveryKey),
    }),
    monotonicNow: raw.monotonicNow ?? (() => performance.now()),
  })
}

function timeout(parent: AbortSignal | undefined, timeoutMs: number, now: () => number) {
  const controller = new AbortController()
  const started = now()
  if (!Number.isFinite(started) || started < 0) throw fail('INVALID_REQUEST')
  const expires = started + timeoutMs
  let timedOut = false
  const abort = (): void => controller.abort()
  if (parent?.aborted === true) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  timer.unref()
  return Object.freeze({
    signal: controller.signal,
    assert() {
      const current = now()
      if (!Number.isFinite(current) || current < started) throw fail('PROCESS_FAILED')
      if (current >= expires) { timedOut = true; controller.abort() }
      if (timedOut) throw fail('TIMEOUT')
      if (parent?.aborted === true) throw fail('ABORTED')
    },
    normalize(error: unknown): TranscriptionError {
      if (timedOut) return fail('TIMEOUT')
      if (parent?.aborted === true) return fail('ABORTED')
      return error instanceof TranscriptionError ? error : fail('PROCESS_FAILED')
    },
    close() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  })
}

function exactOpaque(value: unknown): string | null {
  return typeof value === 'string' && OPAQUE.test(value) ? value : null
}

function exactData(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw fail('PROTOCOL_ERROR')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    throw fail('PROTOCOL_ERROR')
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  )
}

function validProxyCode(value: unknown): value is DeepgramProxyErrorCode {
  return typeof value === 'string' && [
    'BACKEND_UNAVAILABLE', 'AUTH_REJECTED', 'QUOTA_EXCEEDED',
    'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'PROTOCOL_REFUSED',
  ].includes(value)
}

function snapshotStage(value: Awaited<ReturnType<DeepgramProxyPort['stageMedia']>>) {
  const record = exactData(value, ['ok', 'mediaTicket', 'code'])
  if (record['ok'] === true && Object.keys(record).length === 2 &&
    exactOpaque(record['mediaTicket']) !== null) {
    return Object.freeze({ ok: true as const, mediaTicket: record['mediaTicket'] as string })
  }
  if (record['ok'] === false && Object.keys(record).length === 2 &&
    validProxyCode(record['code'])) {
    return Object.freeze({ ok: false as const, code: record['code'] })
  }
  throw fail('PROTOCOL_ERROR')
}

function snapshotPrepare(value: Awaited<ReturnType<DeepgramProxyPort['prepare']>>) {
  const record = exactData(value, ['ok', 'dispatchPermitId', 'code'])
  if (record['ok'] === true && Object.keys(record).length === 2 &&
    exactOpaque(record['dispatchPermitId']) !== null) {
    return Object.freeze({
      ok: true as const,
      dispatchPermitId: record['dispatchPermitId'] as string,
    })
  }
  if (record['ok'] === false && Object.keys(record).length === 2 &&
    validProxyCode(record['code'])) {
    return Object.freeze({ ok: false as const, code: record['code'] })
  }
  throw fail('PROTOCOL_ERROR')
}

function proxyError(code: DeepgramProxyErrorCode): TranscriptionError {
  if (code === 'BACKEND_UNAVAILABLE' || code === 'UPSTREAM_UNAVAILABLE') {
    return fail('MODEL_UNAVAILABLE')
  }
  if (code === 'AUTH_REJECTED') return fail('AUTHENTICATION_FAILED')
  if (code === 'QUOTA_EXCEEDED') return fail('QUOTA_EXCEEDED')
  if (code === 'TIMEOUT') return fail('TIMEOUT')
  return fail('PROTOCOL_ERROR')
}

function snapshotResult(value: DeepgramProxyResult, maximumDuration: number): DeepgramProxyResult {
  const record = exactData(value, [
    'ok', 'transcript', 'language', 'durationMs', 'code', 'dispatch',
  ])
  if (record['ok'] === false) {
    if (Object.keys(record).length !== 3 || !validProxyCode(record['code']) ||
      (record['dispatch'] !== 'none' && record['dispatch'] !== 'attempted')) {
      throw fail('PROTOCOL_ERROR')
    }
    return Object.freeze({
      ok: false,
      code: record['code'],
      dispatch: record['dispatch'],
    })
  }
  if (record['ok'] !== true || (Object.keys(record).length !== 3 && Object.keys(record).length !== 4) ||
    typeof record['transcript'] !== 'string' ||
    record['transcript'].includes('\0') ||
    Buffer.byteLength(record['transcript'], 'utf8') > MAX_TRANSCRIPT_BYTES ||
    !Number.isSafeInteger(record['durationMs']) || Number(record['durationMs']) < 0 ||
    Number(record['durationMs']) > maximumDuration ||
    (record['language'] !== undefined &&
      (typeof record['language'] !== 'string' || !LANGUAGE.test(record['language'])))) {
    throw fail('PROTOCOL_ERROR')
  }
  return Object.freeze({
    ok: true,
    transcript: record['transcript'],
    ...(record['language'] === undefined ? {} : { language: record['language'] as string }),
    durationMs: Number(record['durationMs']),
  })
}

function snapshotReservation(value: DeepgramProxySpendReservation | null) {
  if (value === null) return null
  let record: Record<string, unknown>
  try { record = exactData(value, ['recoveryKey', 'settle']) } catch {
    throw fail('QUOTA_EXCEEDED')
  }
  if (Object.keys(record).length !== 2 || exactOpaque(record['recoveryKey']) === null) {
    throw fail('QUOTA_EXCEEDED')
  }
  const settle = plainMethod(value, 'settle') as DeepgramProxySpendReservation['settle'] | null
  if (settle === null) throw fail('QUOTA_EXCEEDED')
  return Object.freeze({
    recoveryKey: record['recoveryKey'] as string,
    settle: (outcome: DeepgramProxySpendOutcome) => settle(outcome),
  })
}

function requestHash(view: VoiceMediaAuthorityView, maximumDuration: number): string {
  return createHash('sha256').update('aisy.deepgram.proxy-request.v1\0')
    .update(view.mediaBindingHash).update('\0')
    .update(view.expectedSha256).update('\0')
    .update(String(view.expectedSizeBytes)).update('\0')
    .update(view.contentType).update('\0')
    .update(view.language ?? 'multi').update('\0')
    .update(String(maximumDuration)).digest('hex')
}

export function makeDeepgramProxyProvider(raw: Readonly<{
  timeoutMs: number
  maximumBillableDurationMs: number
  consumeMediaCapability: Options['consumeMediaCapability']
  proxy: DeepgramProxyPort
  spend: DeepgramProxySpendAuthority
  monotonicNow?: () => number
}>): TranscriptionProvider {
  const configured = options(raw)
  let active = false
  return Object.freeze({
    ...deepgramProxyProviderMetadata,
    async transcribe(request: TranscriptionAudioRequest): Promise<TranscriptionTranscript> {
      if (active) throw fail('QUOTA_EXCEEDED')
      active = true
      let mediaTicket: string | null = null
      let permit: string | null = null
      let reservation: ReturnType<typeof snapshotReservation> = null
      let terminal = false
      let dispatchCalled = false
      let limit: ReturnType<typeof timeout> | null = null
      let thrown: TranscriptionError | null = null
      try {
        let view: Readonly<VoiceMediaAuthorityView>
        try {
          view = configured.consumeMediaCapability(request.mediaCapability, request)
        } catch {
          throw fail('INVALID_REQUEST')
        }
        if (!HASH.test(view.mediaBindingHash) || !HASH.test(view.expectedSha256)) {
          throw fail('INVALID_REQUEST')
        }
        limit = timeout(request.signal, configured.timeoutMs, configured.monotonicNow)
        limit.assert()
        const staged = snapshotStage(await configured.proxy.stageMedia({ ...view, signal: limit.signal }))
        if (!staged.ok) throw proxyError(staged.code)
        mediaTicket = staged.mediaTicket
        limit.assert()
        reservation = snapshotReservation(await configured.spend.reserve({
          providerId: 'deepgram-cloud',
          requestHash: requestHash(view, configured.maximumBillableDurationMs),
          maximumBillableDurationMs: configured.maximumBillableDurationMs,
          signal: limit.signal,
        }))
        limit.assert()
        if (reservation === null) throw fail('QUOTA_EXCEEDED')
        const prepared = snapshotPrepare(await configured.proxy.prepare({
          mediaTicket,
          reservationRecoveryKey: reservation.recoveryKey,
          signal: limit.signal,
        }))
        if (!prepared.ok) throw proxyError(prepared.code)
        permit = prepared.dispatchPermitId
        limit.assert()
        dispatchCalled = true
        const result = snapshotResult(
          await configured.proxy.dispatch({ dispatchPermitId: permit, signal: limit.signal }),
          configured.maximumBillableDurationMs,
        )
        if (!result.ok) {
          await reservation.settle({ kind: result.dispatch === 'attempted' ? 'ambiguous' : 'released' })
          terminal = true
          throw proxyError(result.code)
        }
        await reservation.settle({ kind: 'settled', billableDurationMs: result.durationMs })
        terminal = true
        limit.assert()
        return Object.freeze({
          text: result.transcript,
          provenance: 'untrusted' as const,
          channel: 'voice' as const,
          ...(result.language === undefined ? {} : { language: result.language }),
          durationMs: result.durationMs,
        })
      } catch (error) {
        thrown = limit?.normalize(error) ??
          (error instanceof TranscriptionError ? error : fail('PROCESS_FAILED'))
        throw thrown
      } finally {
        limit?.close()
        if (reservation !== null && !terminal) {
          let outcome: DeepgramProxySpendOutcome = { kind: dispatchCalled ? 'ambiguous' : 'released' }
          if (!dispatchCalled && permit !== null) {
            try {
              const cancelled = await configured.proxy.cancelPrepared({ dispatchPermitId: permit })
              outcome = { kind: cancelled === 'cancelled' ? 'released' : 'ambiguous' }
            } catch {
              outcome = { kind: 'ambiguous' }
            }
          }
          try { await reservation.settle(outcome) } catch {
            if (thrown === null) throw fail('QUOTA_EXCEEDED')
          }
        }
        if (mediaTicket !== null && permit === null) {
          try { await configured.proxy.cancelMedia({ mediaTicket }) } catch { /* TTL remains fail-closed */ }
        }
        active = false
      }
    },
  })
}

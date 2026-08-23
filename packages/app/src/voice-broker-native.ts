import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { isProxy } from 'node:util/types'

import type {
  DeepgramProxyErrorCode,
  DeepgramProxyResult,
} from './deepgram-proxy-provider.js'

const HASH = /^[a-f0-9]{64}$/
const MEDIA_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const OPAQUE = /^[A-Za-z0-9_-]{43}$/
const MAX_TRANSCRIPT_BYTES = 60 * 1024

export interface VoiceBrokerNativePort {
  isHeld(): boolean
  stageMedia(input: Readonly<{
    descriptor: number
    mediaBindingHash: string
    expectedSha256: string
    expectedSizeBytes: number
    maxBytes: number
    contentType: 'audio/ogg' | 'audio/opus' | 'audio/webm'
    language: string | null
  }>): Promise<Readonly<{ ok: true; mediaTicket: string }> |
  Readonly<{ ok: false; code: DeepgramProxyErrorCode }>>
  cancelMedia(input: Readonly<{ mediaTicket: string }>): Promise<boolean>
  prepare(input: Readonly<{
    mediaTicket: string
    reservationRecoveryKey: string
  }>): Promise<Readonly<{ ok: true; dispatchPermitId: string }> |
  Readonly<{ ok: false; code: DeepgramProxyErrorCode }>>
  cancelPrepared(input: Readonly<{ dispatchPermitId: string }>): Promise<
  'cancelled' | 'claimed' | 'ambiguous'>
  dispatch(input: Readonly<{ dispatchPermitId: string }>): Promise<DeepgramProxyResult>
  close(): void
}

interface NativeAddon {
  open(socketPath: string, expectedUid: number, expectedPid: number): object
  exchange(session: object, frame: string, mediaDescriptor: number, maxResponseBytes: number): Promise<string>
  isHeld(session: object): boolean
  close(session: object): void
}

const genuine = new WeakSet<object>()

/** Brands a native-addon adapter without exposing its broker session descriptor. */
export function makeVoiceBrokerNativePort(port: VoiceBrokerNativePort): VoiceBrokerNativePort {
  if (port === null || typeof port !== 'object' || isProxy(port)) {
    throw new Error('VOICE_BROKER_BRIDGE_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(port)
  const methods = ['isHeld', 'stageMedia', 'cancelMedia', 'prepare', 'cancelPrepared', 'dispatch', 'close']
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !methods.includes(key)) ||
    methods.some(name => typeof descriptors[name]?.value !== 'function')) {
    throw new Error('VOICE_BROKER_BRIDGE_INVALID')
  }
  const isHeld = descriptors.isHeld!.value as VoiceBrokerNativePort['isHeld']
  const stageMedia = descriptors.stageMedia!.value as VoiceBrokerNativePort['stageMedia']
  const cancelMedia = descriptors.cancelMedia!.value as VoiceBrokerNativePort['cancelMedia']
  const prepare = descriptors.prepare!.value as VoiceBrokerNativePort['prepare']
  const cancelPrepared = descriptors.cancelPrepared!.value as VoiceBrokerNativePort['cancelPrepared']
  const dispatch = descriptors.dispatch!.value as VoiceBrokerNativePort['dispatch']
  const close = descriptors.close!.value as VoiceBrokerNativePort['close']
  const wrapped = Object.freeze<VoiceBrokerNativePort>({
    isHeld: () => isHeld.call(port),
    stageMedia: input => stageMedia.call(port, input),
    cancelMedia: input => cancelMedia.call(port, input),
    prepare: input => prepare.call(port, input),
    cancelPrepared: input => cancelPrepared.call(port, input),
    dispatch: input => dispatch.call(port, input),
    close: () => { close.call(port) },
  })
  genuine.add(wrapped)
  return wrapped
}

export function isVoiceBrokerNativePort(value: unknown): value is VoiceBrokerNativePort {
  return typeof value === 'object' && value !== null && genuine.has(value) && Object.isFrozen(value)
}

function response(raw: string, type: string, sequence: number): Record<string, unknown> {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_TRANSCRIPT_BYTES + 4096) {
    throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('VOICE_BROKER_PROTOCOL_REFUSED') }
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.type !== type || record.sequence !== sequence) {
    throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
  }
  return record
}

function voiceCode(value: unknown): value is DeepgramProxyErrorCode {
  return typeof value === 'string' && [
    'BACKEND_UNAVAILABLE', 'AUTH_REJECTED', 'QUOTA_EXCEEDED',
    'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'PROTOCOL_REFUSED',
  ].includes(value)
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record)
  return own.length === keys.length && own.every(key => keys.includes(key))
}

function assertRootOwnedAncestors(path: string): void {
  let current = dirname(path)
  for (;;) {
    const info = lstatSync(current)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 ||
      (info.mode & 0o022) !== 0) throw new Error('VOICE_BROKER_BRIDGE_INVALID')
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Loads the root-owned Linux addon only in the supervisor MainPID. */
export function openLinuxVoiceBrokerNativePort(input: Readonly<{
  addonPath: string
  bootstrapSocketPath: string
  expectedBrokerPid: number
  expectedBrokerUid?: number
}>): VoiceBrokerNativePort {
  if (process.platform !== 'linux' || !isAbsolute(input.addonPath) ||
    normalize(input.addonPath) !== input.addonPath || realpathSync(input.addonPath) !== input.addonPath ||
    !isAbsolute(input.bootstrapSocketPath) || normalize(input.bootstrapSocketPath) !== input.bootstrapSocketPath ||
    !Number.isSafeInteger(input.expectedBrokerPid) || input.expectedBrokerPid < 1 ||
    !Number.isSafeInteger(input.expectedBrokerUid ?? 0) || (input.expectedBrokerUid ?? 0) < 0) {
    throw new Error('VOICE_BROKER_BRIDGE_INVALID')
  }
  const addonInfo = lstatSync(input.addonPath)
  if (!addonInfo.isFile() || addonInfo.isSymbolicLink() || addonInfo.uid !== 0 ||
    (addonInfo.mode & 0o022) !== 0) throw new Error('VOICE_BROKER_BRIDGE_INVALID')
  assertRootOwnedAncestors(input.addonPath)
  const loaded = createRequire(import.meta.url)(input.addonPath) as Partial<NativeAddon>
  if (loaded === null || typeof loaded !== 'object' ||
    typeof loaded.open !== 'function' || typeof loaded.exchange !== 'function' ||
    typeof loaded.isHeld !== 'function' || typeof loaded.close !== 'function') {
    throw new Error('VOICE_BROKER_BRIDGE_INVALID')
  }
  const native = loaded as NativeAddon
  const session = native.open(
    input.bootstrapSocketPath,
    input.expectedBrokerUid ?? 0,
    input.expectedBrokerPid,
  )
  let sequence = 0
  const call = async (
    type: string,
    payload: Record<string, unknown>,
    descriptor = -1,
    maximum = 4096,
  ): Promise<Record<string, unknown>> => {
    sequence += 1
    if (!Number.isSafeInteger(sequence)) throw new Error('VOICE_BROKER_SESSION_LOST')
    const raw = await native.exchange(session, JSON.stringify({
      version: 1, type, sequence, ...payload,
    }), descriptor, maximum)
    return response(raw, `${type}-result`, sequence)
  }
  return makeVoiceBrokerNativePort({
    isHeld: () => native.isHeld(session),
    async stageMedia(stage) {
      const result = await call('stage-media', {
        mediaBindingHash: stage.mediaBindingHash,
        expectedSha256: stage.expectedSha256,
        expectedSizeBytes: stage.expectedSizeBytes,
        maxBytes: stage.maxBytes,
        contentType: stage.contentType,
        language: stage.language,
      }, stage.descriptor)
      if (exactKeys(result, ['version', 'type', 'sequence', 'ok', 'mediaTicket', 'code']) &&
        result.ok === true && typeof result.mediaTicket === 'string' && OPAQUE.test(result.mediaTicket) &&
        result.code === null) return { ok: true, mediaTicket: result.mediaTicket }
      if (exactKeys(result, ['version', 'type', 'sequence', 'ok', 'mediaTicket', 'code']) &&
        result.ok === false && result.mediaTicket === null && voiceCode(result.code)) {
        return { ok: false, code: result.code }
      }
      throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
    },
    async cancelMedia(cancel) {
      const result = await call('cancel-media', cancel)
      if (!exactKeys(result, ['version', 'type', 'sequence', 'cancelled']) ||
        typeof result.cancelled !== 'boolean') throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
      return result.cancelled
    },
    async prepare(prepare) {
      const result = await call('prepare', prepare)
      if (exactKeys(result, ['version', 'type', 'sequence', 'ok', 'dispatchPermitId', 'code']) &&
        result.ok === true && typeof result.dispatchPermitId === 'string' &&
        OPAQUE.test(result.dispatchPermitId) && result.code === null) {
        return { ok: true, dispatchPermitId: result.dispatchPermitId }
      }
      if (exactKeys(result, ['version', 'type', 'sequence', 'ok', 'dispatchPermitId', 'code']) &&
        result.ok === false && result.dispatchPermitId === null && voiceCode(result.code)) {
        return { ok: false, code: result.code }
      }
      throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
    },
    async cancelPrepared(cancel) {
      const result = await call('cancel-prepared', cancel)
      if (!exactKeys(result, ['version', 'type', 'sequence', 'outcome']) ||
        !['cancelled', 'claimed', 'ambiguous'].includes(String(result.outcome))) {
        throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
      }
      return result.outcome as 'cancelled' | 'claimed' | 'ambiguous'
    },
    async dispatch(dispatch) {
      const result = await call('dispatch', dispatch, -1, MAX_TRANSCRIPT_BYTES + 4096)
      if (result.ok === true &&
        exactKeys(result, ['version', 'type', 'sequence', 'ok', 'transcript', 'language', 'durationMs', 'code', 'dispatch']) &&
      typeof result.transcript === 'string' &&
        !result.transcript.includes('\0') &&
        Buffer.byteLength(result.transcript, 'utf8') <= MAX_TRANSCRIPT_BYTES &&
        (result.language === null || typeof result.language === 'string') &&
        Number.isSafeInteger(result.durationMs) && Number(result.durationMs) >= 0 &&
        result.code === null && result.dispatch === null) {
        return { ok: true, transcript: result.transcript,
          ...(result.language === null ? {} : { language: result.language }),
          durationMs: Number(result.durationMs) }
      }
      if (result.ok === false &&
        exactKeys(result, ['version', 'type', 'sequence', 'ok', 'transcript', 'language', 'durationMs', 'code', 'dispatch']) &&
        result.transcript === null && result.language === null && result.durationMs === null &&
        voiceCode(result.code) && (result.dispatch === 'none' || result.dispatch === 'attempted')) {
        return { ok: false, code: result.code, dispatch: result.dispatch }
      }
      throw new Error('VOICE_BROKER_PROTOCOL_REFUSED')
    },
    close: () => native.close(session),
  })
}

/** Parent-only reopen. The child sends only a basename, never an absolute path or fd. */
export function withVoiceMediaDescriptor<T>(input: Readonly<{
  mediaRoot: string
  relativePath: string
  expectedSha256: string
  expectedSizeBytes: number
  maxBytes: number
  use: (descriptor: number) => Promise<T>
}>): Promise<T> {
  if (!isAbsolute(input.mediaRoot) || normalize(input.mediaRoot) !== input.mediaRoot ||
    input.mediaRoot.includes('\0') || !MEDIA_FILE.test(input.relativePath) ||
    !HASH.test(input.expectedSha256) ||
    !Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1 ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < input.expectedSizeBytes ||
    input.maxBytes > MAX_MEDIA_BYTES || typeof constants.O_NOFOLLOW !== 'number') {
    return Promise.reject(new Error('VOICE_MEDIA_INVALID'))
  }
  const root = lstatSync(input.mediaRoot)
  const uid = process.geteuid?.()
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(input.mediaRoot) !== input.mediaRoot ||
    (typeof uid === 'number' && root.uid !== uid) || (root.mode & 0o077) !== 0) {
    return Promise.reject(new Error('VOICE_MEDIA_UNSAFE'))
  }
  let descriptor: number
  try {
    descriptor = openSync(join(input.mediaRoot, input.relativePath),
      constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return Promise.reject(new Error('VOICE_MEDIA_UNSAFE'))
  }
  const complete = async (): Promise<T> => {
    try {
      const file = fstatSync(descriptor)
      if (!file.isFile() || file.nlink !== 1 || file.dev !== root.dev ||
        file.size !== input.expectedSizeBytes || file.size > input.maxBytes ||
        (typeof uid === 'number' && file.uid !== uid) || (file.mode & 0o077) !== 0) {
        throw new Error('VOICE_MEDIA_UNSAFE')
      }
      return await input.use(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
  return complete()
}

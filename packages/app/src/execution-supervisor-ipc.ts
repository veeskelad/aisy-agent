// Authenticated direct parent/child IPC for execution authority (ADR-0071).
// The inherited Node IPC channel is the authority transport; environment state
// only selects supervised startup and can never authenticate a child session.

import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import type { DeepgramProxyPort } from './deepgram-proxy-provider.js'
import { makeVoiceSupervisorClient } from './voice-supervisor-client.js'

export const EXECUTION_SUPERVISOR_PROTOCOL_VERSION = 3 as const
export const EXECUTION_SUPERVISOR_SELECTOR_ENV = 'AISY_SUPERVISED' as const

const SUPERVISED_CHILD_ENV_ALLOWLIST = new Set([
  'AISY_BUDGET_USD',
  'AISY_DAILY_BUDGET_USD',
  'AISY_DB_PATH',
  'AISY_EMBEDDING_DIMENSIONS',
  'AISY_EMBEDDING_MODEL',
  'AISY_EMBEDDING_PROVIDER',
  'AISY_EMBEDDING_REVISION',
  'AISY_GOAL_DOLLAR_CEILING',
  'AISY_GOAL_MAX_ITERATIONS',
  'AISY_GOAL_SCOPE',
  'AISY_GOAL_TOKEN_CEILING',
  'AISY_HOME',
  'AISY_HOOKS_ROOT',
  'AISY_MAIN_AGENT_CARD',
  'AISY_MEMORY_ROOT',
  'AISY_MONITORING',
  'AISY_MONITORING_DIGEST_AT',
  'AISY_MONITORING_DIGEST_MAX_ITEMS',
  'AISY_MONITORING_DIGEST_MAX_PER_AUTHOR',
  'AISY_MONITORING_DIGEST_MAX_PER_SOURCE',
  'AISY_MONITORING_DIGEST_TTL_HOURS',
  'AISY_MONITORING_HALF_LIFE_HOURS',
  'AISY_MONITORING_MAX_DELIVERY_PER_TICK',
  'AISY_MONITORING_MAX_ITEMS_PER_TICK',
  'AISY_MONITORING_MAX_ROWS',
  'AISY_MONITORING_MAX_SCORING_PER_TICK',
  'AISY_MONITORING_MAX_SOURCES_PER_TICK',
  'AISY_MONITORING_RETENTION_DAYS',
  'AISY_MONITORING_WINDOW_HOURS',
  'AISY_NIGHTLY_AT',
  'AISY_NIGHTLY_EXACT_CACHE',
  'AISY_PREFIX_CACHE',
  'AISY_PROTECTED_MEMORY',
  'AISY_PROTECTED_MEMORY_ROOT',
  'AISY_PROVIDER_MODEL',
  'AISY_SESSION_JOURNAL',
  'AISY_TRIGGER_BUDGET_USD',
  'AISY_WORKSPACE',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'TMPDIR',
  'TZ',
  'XDG_STATE_HOME',
])

const SECRET_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i

/** Exact non-secret environment inherited by a supervised runtime child. */
export function makeExecutionSupervisorChildEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const child: Record<string, string> = {}
  for (const key of SUPERVISED_CHILD_ENV_ALLOWLIST) {
    const value = source[key]
    if (value !== undefined && !SECRET_ENV_NAME.test(key)) child[key] = value
  }
  return child
}

const HASH = /^[a-f0-9]{64}$/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/
const MEDIA_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/
const MAX_FRAME_BYTES = 4096
const MAX_VOICE_TRANSCRIPT_BYTES = 60 * 1024
const MAX_VOICE_RESULT_FRAME_BYTES = MAX_VOICE_TRANSCRIPT_BYTES + MAX_FRAME_BYTES
const MAX_DEADLINE_MS = 60_000
const MAX_VOICE_DISPATCH_DEADLINE_MS = 120_000

export type ExecutionSupervisorVoiceErrorCode =
  | 'BACKEND_UNAVAILABLE'
  | 'AUTH_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'PROTOCOL_REFUSED'

export type ExecutionSupervisorRefusalCode =
  | 'REQUEST_EXPIRED'
  | 'AUTHORITY_BUSY'
  | 'AUTHORITY_MISMATCH'
  | 'RECOVERY_ALREADY_LEASED'
  | 'SUPERVISOR_QUARANTINED'

export type ExecutionSupervisorFrameType =
  | 'hello-challenge'
  | 'hello'
  | 'hello-ack'
  | 'recovery-request'
  | 'recovery-lease'
  | 'capture'
  | 'capture-ack'
  | 'checkpoint-bound'
  | 'checkpoint-bound-ack'
  | 'release'
  | 'release-ack'
  | 'release-durable'
  | 'release-durable-ack'
  | 'release-receipt-consumed'
  | 'release-receipt-consumed-ack'
  | 'planned-restart'
  | 'planned-restart-ack'
  | 'voice-stage'
  | 'voice-stage-ack'
  | 'voice-cancel-media'
  | 'voice-cancel-media-ack'
  | 'voice-prepare'
  | 'voice-prepare-ack'
  | 'voice-cancel-prepared'
  | 'voice-cancel-prepared-ack'
  | 'voice-dispatch'
  | 'voice-dispatch-ack'
  | 'refusal'

interface FrameBase<T extends ExecutionSupervisorFrameType> {
  version: 3
  type: T
  requestId: string
  deadlineAtMs: number
}

interface SessionFrameBase<T extends ExecutionSupervisorFrameType> extends FrameBase<T> {
  sessionId: string
}

export type ExecutionSupervisorFrame =
  | (FrameBase<'hello-challenge'> & { parentNonce: string })
  | (FrameBase<'hello'> & { parentNonce: string; childNonce: string; livenessDescriptorHash: string })
  | (FrameBase<'hello-ack'> & { sessionId: string; sessionProof: string })
  | SessionFrameBase<'recovery-request'>
  | (SessionFrameBase<'recovery-lease'> & {
    bindingHash: string | null
    leaseId: string | null
    authorityPhase: ExecutionSupervisorAuthorityPhase | null
    releaseReceipt: ExecutionSupervisorReleaseReceiptViewV1 | null
  })
  | (SessionFrameBase<'capture'> & { bindingHash: string })
  | (SessionFrameBase<'capture-ack'> & { bindingHash: string; leaseId: string })
  | (SessionFrameBase<'checkpoint-bound'> & { bindingHash: string; leaseId: string })
  | (SessionFrameBase<'checkpoint-bound-ack'> & { bindingHash: string; leaseId: string })
  | (SessionFrameBase<'release'> & { bindingHash: string; leaseId: string })
  | (SessionFrameBase<'release-ack'> & { bindingHash: string; leaseId: string })
  | (SessionFrameBase<'release-durable'> & {
    bindingHash: string
    leaseId: string
    envelopeHash: string
    releaseIntentHash: string
  })
  | (SessionFrameBase<'release-durable-ack'> & {
    receipt: ExecutionSupervisorReleaseReceiptViewV1
  })
  | (SessionFrameBase<'release-receipt-consumed'> & {
    envelopeHash: string
    releaseIntentHash: string
    receiptHash: string
  })
  | (SessionFrameBase<'release-receipt-consumed-ack'> & {
    envelopeHash: string
    releaseIntentHash: string
    receiptHash: string
  })
  | (SessionFrameBase<'planned-restart'> & { intentHash: string })
  | (SessionFrameBase<'planned-restart-ack'> & { intentHash: string })
  | (SessionFrameBase<'voice-stage'> & {
    mediaBindingHash: string
    relativePath: string
    expectedSha256: string
    expectedSizeBytes: number
    maxBytes: number
    contentType: 'audio/ogg' | 'audio/opus' | 'audio/webm'
    language: string | null
  })
  | (SessionFrameBase<'voice-stage-ack'> & {
    mediaBindingHash: string
    ok: boolean
    mediaTicket: string | null
    code: ExecutionSupervisorVoiceErrorCode | null
  })
  | (SessionFrameBase<'voice-cancel-media'> & {
    mediaBindingHash: string
    mediaTicket: string
  })
  | (SessionFrameBase<'voice-cancel-media-ack'> & {
    mediaBindingHash: string
    ok: boolean
    code: ExecutionSupervisorVoiceErrorCode | null
  })
  | (SessionFrameBase<'voice-prepare'> & {
    mediaBindingHash: string
    mediaTicket: string
    reservationRecoveryKey: string
  })
  | (SessionFrameBase<'voice-prepare-ack'> & {
    mediaBindingHash: string
    ok: boolean
    dispatchPermitId: string | null
    code: ExecutionSupervisorVoiceErrorCode | null
  })
  | (SessionFrameBase<'voice-cancel-prepared'> & {
    mediaBindingHash: string
    dispatchPermitId: string
  })
  | (SessionFrameBase<'voice-cancel-prepared-ack'> & {
    mediaBindingHash: string
    outcome: 'cancelled' | 'claimed' | 'ambiguous'
  })
  | (SessionFrameBase<'voice-dispatch'> & {
    mediaBindingHash: string
    dispatchPermitId: string
  })
  | (SessionFrameBase<'voice-dispatch-ack'> & {
    mediaBindingHash: string
    ok: boolean
    transcript: string | null
    language: string | null
    durationMs: number | null
    code: ExecutionSupervisorVoiceErrorCode | null
    dispatch: 'none' | 'attempted' | null
  })
  | (SessionFrameBase<'refusal'> & { code: ExecutionSupervisorRefusalCode })

export type ExecutionSupervisorFrameRefusal =
  | 'oversized'
  | 'unparsable'
  | 'unknown-version'
  | 'unknown-type'
  | 'malformed'

export type ExecutionSupervisorParseResult =
  | { ok: true; frame: ExecutionSupervisorFrame }
  | { ok: false; reason: ExecutionSupervisorFrameRefusal }

export type ExecutionSupervisorAuthorityPhase = 'captured-unbound' | 'checkpoint-bound'

export interface ExecutionSupervisorReleaseReceiptViewV1 {
  readonly releaseIntentHash: string
  readonly envelopeHash: string
  readonly receiptHash: string
  readonly bindingHash: string
  readonly runLivenessHash: string
  readonly authorityPhase: ExecutionSupervisorAuthorityPhase
  readonly releasedAtMs: number
}

export interface ExecutionSupervisorReleaseReceiptV1
  extends ExecutionSupervisorReleaseReceiptViewV1 {
  readonly kind: 'execution-supervisor-release-receipt-v1'
}

const releaseReceiptStates = new WeakMap<object, Readonly<{
  session: object
  view: Readonly<ExecutionSupervisorReleaseReceiptViewV1>
  consumed: { value: boolean }
}>>()

interface ExecutionSupervisorLeaseState {
  readonly bindingHash: string
  readonly leaseId: string
  readonly sessionId: string
  readonly runLivenessHash: string
  authorityPhase(): ExecutionSupervisorAuthorityPhase
  isHeld(): boolean
}

const executionSupervisorLeaseStates = new WeakMap<object, ExecutionSupervisorLeaseState>()

const KEYS: Record<ExecutionSupervisorFrameType, readonly string[]> = {
  'hello-challenge': ['version', 'type', 'requestId', 'deadlineAtMs', 'parentNonce'],
  hello: ['version', 'type', 'requestId', 'deadlineAtMs', 'parentNonce', 'childNonce', 'livenessDescriptorHash'],
  'hello-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'sessionProof'],
  'recovery-request': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId'],
  'recovery-lease': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId', 'authorityPhase', 'releaseReceipt'],
  capture: ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash'],
  'capture-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId'],
  'checkpoint-bound': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId'],
  'checkpoint-bound-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId'],
  release: ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId'],
  'release-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId'],
  'release-durable': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'bindingHash', 'leaseId', 'envelopeHash', 'releaseIntentHash'],
  'release-durable-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'receipt'],
  'release-receipt-consumed': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'envelopeHash', 'releaseIntentHash', 'receiptHash'],
  'release-receipt-consumed-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'envelopeHash', 'releaseIntentHash', 'receiptHash'],
  'planned-restart': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'intentHash'],
  'planned-restart-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'intentHash'],
  'voice-stage': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'relativePath', 'expectedSha256', 'expectedSizeBytes', 'maxBytes', 'contentType', 'language'],
  'voice-stage-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'ok', 'mediaTicket', 'code'],
  'voice-cancel-media': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'mediaTicket'],
  'voice-cancel-media-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'ok', 'code'],
  'voice-prepare': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'mediaTicket', 'reservationRecoveryKey'],
  'voice-prepare-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'ok', 'dispatchPermitId', 'code'],
  'voice-cancel-prepared': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'dispatchPermitId'],
  'voice-cancel-prepared-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'outcome'],
  'voice-dispatch': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'dispatchPermitId'],
  'voice-dispatch-ack': ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'mediaBindingHash', 'ok', 'transcript', 'language', 'durationMs', 'code', 'dispatch'],
  refusal: ['version', 'type', 'requestId', 'deadlineAtMs', 'sessionId', 'code'],
}

function exactOwnKeys(value: object, allowed: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === allowed.length && own.every((key) => allowed.includes(key))
}

function validBase(frame: Record<string, unknown>): frame is Record<string, unknown> & {
  version: 3; type: ExecutionSupervisorFrameType; requestId: string; deadlineAtMs: number
} {
  return frame.version === 3
    && typeof frame.type === 'string'
    && Object.hasOwn(KEYS, frame.type)
    && typeof frame.requestId === 'string'
    && REQUEST_ID.test(frame.requestId)
    && Number.isSafeInteger(frame.deadlineAtMs)
    && Number(frame.deadlineAtMs) > 0
}

function validMediaHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value)
}

function validOpaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value)
}

function validVoiceCode(value: unknown): value is ExecutionSupervisorVoiceErrorCode {
  return typeof value === 'string' && [
    'BACKEND_UNAVAILABLE', 'AUTH_REJECTED', 'QUOTA_EXCEEDED',
    'TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'PROTOCOL_REFUSED',
  ].includes(value)
}

function validVoiceOutcome(ok: boolean, opaque: unknown, code: unknown): boolean {
  return ok ? validOpaque(opaque) && code === null : opaque === null && validVoiceCode(code)
}

function maxDeadline(frame: ExecutionSupervisorFrame): number {
  return frame.type === 'voice-dispatch' || frame.type === 'voice-dispatch-ack'
    ? MAX_VOICE_DISPATCH_DEADLINE_MS
    : MAX_DEADLINE_MS
}

function parseReleaseReceipt(value: unknown): ExecutionSupervisorReleaseReceiptViewV1 | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype || !exactOwnKeys(value, [
      'releaseIntentHash', 'envelopeHash', 'receiptHash', 'bindingHash',
      'runLivenessHash', 'authorityPhase', 'releasedAtMs',
    ])) return null
  const receipt = value as Record<string, unknown>
  if (typeof receipt.releaseIntentHash !== 'string' || !HASH.test(receipt.releaseIntentHash) ||
    typeof receipt.envelopeHash !== 'string' || !HASH.test(receipt.envelopeHash) ||
    typeof receipt.receiptHash !== 'string' || !HASH.test(receipt.receiptHash) ||
    typeof receipt.bindingHash !== 'string' || !HASH.test(receipt.bindingHash) ||
    typeof receipt.runLivenessHash !== 'string' || !HASH.test(receipt.runLivenessHash) ||
    (receipt.authorityPhase !== 'captured-unbound' && receipt.authorityPhase !== 'checkpoint-bound') ||
    !Number.isSafeInteger(receipt.releasedAtMs) || Number(receipt.releasedAtMs) < 0) return null
  return Object.freeze({
    releaseIntentHash: receipt.releaseIntentHash,
    envelopeHash: receipt.envelopeHash,
    receiptHash: receipt.receiptHash,
    bindingHash: receipt.bindingHash,
    runLivenessHash: receipt.runLivenessHash,
    authorityPhase: receipt.authorityPhase,
    releasedAtMs: Number(receipt.releasedAtMs),
  })
}

export function parseExecutionSupervisorFrame(raw: string): ExecutionSupervisorParseResult {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_VOICE_RESULT_FRAME_BYTES) {
    return { ok: false, reason: 'oversized' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return {
      ok: false,
      reason: Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES ? 'oversized' : 'unparsable',
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype) return { ok: false, reason: 'malformed' }
  const frame = parsed as Record<string, unknown>
  if (frame.version !== 3) return { ok: false, reason: 'unknown-version' }
  if (typeof frame.type !== 'string' || !Object.hasOwn(KEYS, frame.type)) {
    return { ok: false, reason: 'unknown-type' }
  }
  const type = frame.type as ExecutionSupervisorFrameType
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES && type !== 'voice-dispatch-ack') {
    return { ok: false, reason: 'oversized' }
  }
  if (!exactOwnKeys(frame, KEYS[type]) || !validBase(frame)) return { ok: false, reason: 'malformed' }
  const base = { version: 3 as const, type, requestId: frame.requestId, deadlineAtMs: Number(frame.deadlineAtMs) }

  if (type === 'hello-challenge') {
    if (typeof frame.parentNonce !== 'string' || !OPAQUE_ID.test(frame.parentNonce)) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...base, type, parentNonce: frame.parentNonce } }
  }
  if (type === 'hello') {
    if (typeof frame.parentNonce !== 'string' || !OPAQUE_ID.test(frame.parentNonce)
      || typeof frame.childNonce !== 'string' || !OPAQUE_ID.test(frame.childNonce)
      || typeof frame.livenessDescriptorHash !== 'string' || !HASH.test(frame.livenessDescriptorHash)) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...base, type, parentNonce: frame.parentNonce, childNonce: frame.childNonce, livenessDescriptorHash: frame.livenessDescriptorHash } }
  }
  if (type === 'hello-ack') {
    if (typeof frame.sessionId !== 'string' || !OPAQUE_ID.test(frame.sessionId)
      || typeof frame.sessionProof !== 'string' || !HASH.test(frame.sessionProof)) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...base, type, sessionId: frame.sessionId, sessionProof: frame.sessionProof } }
  }

  if (typeof frame.sessionId !== 'string' || !OPAQUE_ID.test(frame.sessionId)) return { ok: false, reason: 'malformed' }
  const session = { ...base, sessionId: frame.sessionId }
  if (type === 'recovery-request') return { ok: true, frame: { ...session, type } }
  if (type === 'recovery-lease') {
    const bindingHash = frame.bindingHash
    const leaseId = frame.leaseId
    const authorityPhase = frame.authorityPhase
    const releaseReceipt = frame.releaseReceipt === null ? null : parseReleaseReceipt(frame.releaseReceipt)
    const bothNull = bindingHash === null && leaseId === null && authorityPhase === null
    const bothValid = typeof bindingHash === 'string' && HASH.test(bindingHash)
      && typeof leaseId === 'string' && OPAQUE_ID.test(leaseId)
      && (authorityPhase === 'captured-unbound' || authorityPhase === 'checkpoint-bound')
    if ((!bothNull && !bothValid) || (bothValid && releaseReceipt !== null) ||
      (frame.releaseReceipt !== null && releaseReceipt === null)) {
      return { ok: false, reason: 'malformed' }
    }
    return {
      ok: true,
      frame: {
        ...session,
        type,
        bindingHash: bindingHash as string | null,
        leaseId: leaseId as string | null,
        authorityPhase: authorityPhase as ExecutionSupervisorAuthorityPhase | null,
        releaseReceipt,
      },
    }
  }
  if (type === 'capture') {
    if (typeof frame.bindingHash !== 'string' || !HASH.test(frame.bindingHash)) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...session, type, bindingHash: frame.bindingHash } }
  }
  if (type === 'release-durable') {
    if (typeof frame.bindingHash !== 'string' || !HASH.test(frame.bindingHash) ||
      typeof frame.leaseId !== 'string' || !OPAQUE_ID.test(frame.leaseId) ||
      typeof frame.envelopeHash !== 'string' || !HASH.test(frame.envelopeHash) ||
      typeof frame.releaseIntentHash !== 'string' || !HASH.test(frame.releaseIntentHash)) {
      return { ok: false, reason: 'malformed' }
    }
    return {
      ok: true,
      frame: {
        ...session, type, bindingHash: frame.bindingHash, leaseId: frame.leaseId,
        envelopeHash: frame.envelopeHash, releaseIntentHash: frame.releaseIntentHash,
      },
    }
  }
  if (type === 'release-durable-ack') {
    const receipt = parseReleaseReceipt(frame.receipt)
    if (receipt === null) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...session, type, receipt } }
  }
  if (type === 'release-receipt-consumed' || type === 'release-receipt-consumed-ack') {
    if (typeof frame.envelopeHash !== 'string' || !HASH.test(frame.envelopeHash) ||
      typeof frame.releaseIntentHash !== 'string' || !HASH.test(frame.releaseIntentHash) ||
      typeof frame.receiptHash !== 'string' || !HASH.test(frame.receiptHash)) {
      return { ok: false, reason: 'malformed' }
    }
    return {
      ok: true,
      frame: {
        ...session, type, envelopeHash: frame.envelopeHash,
        releaseIntentHash: frame.releaseIntentHash, receiptHash: frame.receiptHash,
      },
    }
  }
  if (type === 'capture-ack' || type === 'checkpoint-bound' || type === 'checkpoint-bound-ack'
    || type === 'release' || type === 'release-ack') {
    if (typeof frame.bindingHash !== 'string' || !HASH.test(frame.bindingHash)
      || typeof frame.leaseId !== 'string' || !OPAQUE_ID.test(frame.leaseId)) return { ok: false, reason: 'malformed' }
    return { ok: true, frame: { ...session, type, bindingHash: frame.bindingHash, leaseId: frame.leaseId } }
  }
  if (type === 'planned-restart' || type === 'planned-restart-ack') {
    if (typeof frame.intentHash !== 'string' || !HASH.test(frame.intentHash)) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type, intentHash: frame.intentHash } }
  }
  if (type === 'voice-stage') {
    if (typeof frame.mediaBindingHash !== 'string' || !HASH.test(frame.mediaBindingHash) ||
      typeof frame.relativePath !== 'string' || !MEDIA_FILE.test(frame.relativePath) ||
      typeof frame.expectedSha256 !== 'string' || !HASH.test(frame.expectedSha256) ||
      !Number.isSafeInteger(frame.expectedSizeBytes) || Number(frame.expectedSizeBytes) < 1 ||
      Number(frame.expectedSizeBytes) > 20 * 1024 * 1024 ||
      !Number.isSafeInteger(frame.maxBytes) || Number(frame.maxBytes) < Number(frame.expectedSizeBytes) ||
      Number(frame.maxBytes) > 20 * 1024 * 1024 ||
      !['audio/ogg', 'audio/opus', 'audio/webm'].includes(String(frame.contentType)) ||
      (frame.language !== null &&
        (typeof frame.language !== 'string' || !LANGUAGE.test(frame.language)))) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: {
      ...session, type, mediaBindingHash: frame.mediaBindingHash,
      relativePath: frame.relativePath, expectedSha256: frame.expectedSha256,
      expectedSizeBytes: Number(frame.expectedSizeBytes), maxBytes: Number(frame.maxBytes),
      contentType: frame.contentType as 'audio/ogg' | 'audio/opus' | 'audio/webm',
      language: frame.language as string | null,
    } }
  }
  if (type === 'voice-stage-ack') {
    if (!validMediaHash(frame.mediaBindingHash) || typeof frame.ok !== 'boolean' ||
      !validVoiceOutcome(frame.ok, frame.mediaTicket, frame.code)) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string, ok: frame.ok,
      mediaTicket: frame.mediaTicket as string | null,
      code: frame.code as ExecutionSupervisorVoiceErrorCode | null,
    } }
  }
  if (type === 'voice-cancel-media' || type === 'voice-prepare') {
    if (!validMediaHash(frame.mediaBindingHash) || !validOpaque(frame.mediaTicket) ||
      (type === 'voice-prepare' && !validOpaque(frame.reservationRecoveryKey))) {
      return { ok: false, reason: 'malformed' }
    }
    return type === 'voice-prepare'
      ? { ok: true, frame: { ...session, type,
        mediaBindingHash: frame.mediaBindingHash as string,
        mediaTicket: frame.mediaTicket as string,
        reservationRecoveryKey: frame.reservationRecoveryKey as string,
      } }
      : { ok: true, frame: { ...session, type,
        mediaBindingHash: frame.mediaBindingHash as string,
        mediaTicket: frame.mediaTicket as string,
      } }
  }
  if (type === 'voice-cancel-media-ack') {
    if (!validMediaHash(frame.mediaBindingHash) || typeof frame.ok !== 'boolean' ||
      (frame.ok ? frame.code !== null : !validVoiceCode(frame.code))) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string, ok: frame.ok,
      code: frame.code as ExecutionSupervisorVoiceErrorCode | null,
    } }
  }
  if (type === 'voice-prepare-ack') {
    if (!validMediaHash(frame.mediaBindingHash) || typeof frame.ok !== 'boolean' ||
      !validVoiceOutcome(frame.ok, frame.dispatchPermitId, frame.code)) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string, ok: frame.ok,
      dispatchPermitId: frame.dispatchPermitId as string | null,
      code: frame.code as ExecutionSupervisorVoiceErrorCode | null,
    } }
  }
  if (type === 'voice-cancel-prepared' || type === 'voice-dispatch') {
    if (!validMediaHash(frame.mediaBindingHash) || !validOpaque(frame.dispatchPermitId)) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string,
      dispatchPermitId: frame.dispatchPermitId as string,
    } }
  }
  if (type === 'voice-cancel-prepared-ack') {
    if (!validMediaHash(frame.mediaBindingHash) ||
      !['cancelled', 'claimed', 'ambiguous'].includes(String(frame.outcome))) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string,
      outcome: frame.outcome as 'cancelled' | 'claimed' | 'ambiguous',
    } }
  }
  if (type === 'voice-dispatch-ack') {
    if (!validMediaHash(frame.mediaBindingHash) || typeof frame.ok !== 'boolean') {
      return { ok: false, reason: 'malformed' }
    }
    if (frame.ok) {
      if (typeof frame.transcript !== 'string' ||
        frame.transcript.includes('\0') ||
        Buffer.byteLength(frame.transcript, 'utf8') > MAX_VOICE_TRANSCRIPT_BYTES ||
        (frame.language !== null &&
          (typeof frame.language !== 'string' || !LANGUAGE.test(frame.language))) ||
        !Number.isSafeInteger(frame.durationMs) || Number(frame.durationMs) < 0 ||
        frame.code !== null || frame.dispatch !== null) return { ok: false, reason: 'malformed' }
    } else if (frame.transcript !== null || frame.language !== null || frame.durationMs !== null ||
      !validVoiceCode(frame.code) ||
      (frame.dispatch !== 'none' && frame.dispatch !== 'attempted')) {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, frame: { ...session, type,
      mediaBindingHash: frame.mediaBindingHash as string, ok: frame.ok,
      transcript: frame.transcript as string | null, language: frame.language as string | null,
      durationMs: frame.durationMs as number | null,
      code: frame.code as ExecutionSupervisorVoiceErrorCode | null,
      dispatch: frame.dispatch as 'none' | 'attempted' | null,
    } }
  }
  if (typeof frame.code !== 'string' || ![
    'REQUEST_EXPIRED', 'AUTHORITY_BUSY', 'AUTHORITY_MISMATCH',
    'RECOVERY_ALREADY_LEASED', 'SUPERVISOR_QUARANTINED',
  ].includes(frame.code)) return { ok: false, reason: 'malformed' }
  return { ok: true, frame: { ...session, type: 'refusal', code: frame.code as ExecutionSupervisorRefusalCode } }
}

export function encodeExecutionSupervisorFrame(frame: ExecutionSupervisorFrame): string {
  return JSON.stringify(frame)
}

export function makeExecutionSupervisorSessionProof(input: {
  requestId: string
  parentNonce: string
  childNonce: string
  sessionId: string
  livenessDescriptorHash: string
}): string {
  if (!REQUEST_ID.test(input.requestId) || !OPAQUE_ID.test(input.parentNonce)
    || !OPAQUE_ID.test(input.childNonce) || !OPAQUE_ID.test(input.sessionId)
    || !HASH.test(input.livenessDescriptorHash)) {
    throw new ExecutionAuthorityUnavailableError()
  }
  return createHash('sha256').update(
    `aisy-supervisor-v3\0${input.requestId}\0${input.parentNonce}\0${input.childNonce}\0${input.sessionId}\0${input.livenessDescriptorHash}`,
    'utf8',
  ).digest('hex')
}

export function makeExecutionSupervisorReleaseReceiptHash(input: Readonly<{
  releaseIntentHash: string
  envelopeHash: string
  bindingHash: string
  runLivenessHash: string
  authorityPhase: ExecutionSupervisorAuthorityPhase
  leaseId: string
  releasedAtMs: number
}>): string {
  if (!HASH.test(input.releaseIntentHash) || !HASH.test(input.envelopeHash) ||
    !HASH.test(input.bindingHash) || !HASH.test(input.runLivenessHash) ||
    !OPAQUE_ID.test(input.leaseId) ||
    (input.authorityPhase !== 'captured-unbound' && input.authorityPhase !== 'checkpoint-bound') ||
    !Number.isSafeInteger(input.releasedAtMs) || input.releasedAtMs < 0) {
    throw new ExecutionAuthorityUnavailableError()
  }
  return createHash('sha256').update('aisy.execution-supervisor.release-receipt.v1\0')
    .update(JSON.stringify({
      releaseIntentHash: input.releaseIntentHash,
      envelopeHash: input.envelopeHash,
      bindingHash: input.bindingHash,
      runLivenessHash: input.runLivenessHash,
      authorityPhase: input.authorityPhase,
      leaseId: input.leaseId,
      releasedAtMs: input.releasedAtMs,
    }), 'utf8')
    .digest('hex')
}

export function assertExecutionSupervisorReleaseReceipt(
  receipt: ExecutionSupervisorReleaseReceiptV1,
): Readonly<ExecutionSupervisorReleaseReceiptViewV1> {
  if (typeof receipt !== 'object' || receipt === null || !Object.isFrozen(receipt)) {
    throw new ExecutionAuthorityUnavailableError()
  }
  const state = releaseReceiptStates.get(receipt)
  if (state === undefined || state.consumed.value || receipt.kind !==
    'execution-supervisor-release-receipt-v1') throw new ExecutionAuthorityUnavailableError()
  return state.view
}

export interface ExecutionSupervisorChannel {
  send(line: string): void
  receive(timeoutMs: number): Promise<string>
  onDisconnect(listener: () => void): () => void
  close(): void
}

export class ExecutionAuthorityUnavailableError extends Error {
  readonly code = 'EXECUTION_AUTHORITY_UNAVAILABLE'
  constructor() {
    super('EXECUTION_AUTHORITY_UNAVAILABLE')
    this.name = 'ExecutionAuthorityUnavailableError'
  }
}

export interface ExecutionSupervisorLease {
  readonly bindingHash: string
  readonly leaseId: string
  readonly authorityPhase: ExecutionSupervisorAuthorityPhase
  isHeld(): boolean
  bindCheckpoint(): Promise<void>
  release(): Promise<void>
  releaseDurably(input: Readonly<{
    releaseIntentHash: string
    envelopeHash: string
  }>): Promise<ExecutionSupervisorReleaseReceiptV1>
  /** Close the authenticated session after locally ambiguous durable state. */
  failClosed(): never
}

const executionSupervisorLeases = new WeakSet<object>()

/** Runtime provenance check; structural copies cannot carry recovery authority. */
export function isGenuineExecutionSupervisorLease(
  value: unknown,
): value is ExecutionSupervisorLease {
  return typeof value === 'object' && value !== null &&
    executionSupervisorLeases.has(value) && Object.isFrozen(value)
}

export interface ExecutionSupervisorRecoveryContextV1 {
  readonly schemaVersion: 1
  readonly bindingHash: string
  readonly authorityPhase: 'captured-unbound' | 'checkpoint-bound'
  isHeld(): boolean
}

const executionSupervisorRecoveryContexts = new WeakSet<object>()

/** Mints process-local recovery context only from a genuine held IPC lease. */
export function makeExecutionSupervisorRecoveryContextV1(
  lease: ExecutionSupervisorLease,
): ExecutionSupervisorRecoveryContextV1 | null {
  if (!isGenuineExecutionSupervisorLease(lease) ||
    !HASH.test(lease.bindingHash) || !lease.isHeld()) return null
  const context: ExecutionSupervisorRecoveryContextV1 = Object.freeze({
    schemaVersion: 1,
    bindingHash: lease.bindingHash,
    authorityPhase: lease.authorityPhase,
    isHeld: () => lease.isHeld(),
  })
  executionSupervisorRecoveryContexts.add(context)
  return context
}

/** Runtime provenance check; structural contexts cannot authorize recovery. */
export function isGenuineExecutionSupervisorRecoveryContextV1(
  value: unknown,
): value is ExecutionSupervisorRecoveryContextV1 {
  return typeof value === 'object' && value !== null &&
    executionSupervisorRecoveryContexts.has(value) && Object.isFrozen(value)
}

export interface ExecutionSupervisorLeaseAuthorityViewV1 {
  readonly bindingHash: string
  readonly leaseId: string
  readonly authorityPhase: ExecutionSupervisorAuthorityPhase
  readonly sessionId: string
  readonly runLivenessHash: string
}

/** Exact, live provenance for leases created by this authenticated IPC runtime. */
export function assertExecutionSupervisorLeaseAuthority(
  value: unknown,
): Readonly<ExecutionSupervisorLeaseAuthorityViewV1> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw new ExecutionAuthorityUnavailableError()
  }
  const state = executionSupervisorLeaseStates.get(value)
  if (state === undefined || !Object.isFrozen(value) || !state.isHeld()) {
    throw new ExecutionAuthorityUnavailableError()
  }
  return Object.freeze({
    bindingHash: state.bindingHash,
    leaseId: state.leaseId,
    authorityPhase: state.authorityPhase(),
    sessionId: state.sessionId,
    runLivenessHash: state.runLivenessHash,
  })
}

export interface ExecutionSupervisorSession {
  readonly sessionId: string
  readonly voiceProxy: DeepgramProxyPort
  isHeld(): boolean
  requestRecoveryState(): Promise<ExecutionSupervisorRecoveryStateV1>
  captureTurn(bindingHash: string): Promise<ExecutionSupervisorLease>
  authorizePlannedRestart(intentHash: string): Promise<void>
  consumeReleaseReceipt(receipt: ExecutionSupervisorReleaseReceiptV1): Promise<void>
  onLost(listener: () => void): () => void
}

export interface ExecutionSupervisorStartupSession extends ExecutionSupervisorSession {
  readonly recoveryLease: ExecutionSupervisorLease | null
  readonly recoveryReleaseReceipt: ExecutionSupervisorReleaseReceiptV1 | null
}

export type ExecutionSupervisorRecoveryStateV1 =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'lease'; lease: ExecutionSupervisorLease }>
  | Readonly<{ kind: 'release-receipt'; receipt: ExecutionSupervisorReleaseReceiptV1 }>

export interface AuthenticateExecutionSupervisorChildOptions {
  channel: ExecutionSupervisorChannel
  newRequestId: () => string
  randomNonce: () => string
  nowMs: () => number
  livenessDescriptorHash: string
  timeoutMs?: number
}

export async function authenticateExecutionSupervisorChild(
  options: AuthenticateExecutionSupervisorChildOptions,
): Promise<ExecutionSupervisorSession> {
  const timeoutMs = options.timeoutMs ?? 2_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_DEADLINE_MS) {
    throw new ExecutionAuthorityUnavailableError()
  }
  if (!HASH.test(options.livenessDescriptorHash)) throw new ExecutionAuthorityUnavailableError()
  let held = true
  let outstanding = false
  const used = new Set<string>()
  const sessionToken = Object.freeze({})
  const lostListeners = new Set<() => void>()
  const lose = (): never => {
    if (held) {
      held = false
      for (const listener of lostListeners) { try { listener() } catch { /* isolated */ } }
    }
    try { options.channel.close() } catch { /* stable error only */ }
    throw new ExecutionAuthorityUnavailableError()
  }
  options.channel.onDisconnect(() => {
    if (!held) return
    held = false
    for (const listener of lostListeners) { try { listener() } catch { /* isolated */ } }
  })

  const receive = async (waitMs = timeoutMs): Promise<ExecutionSupervisorFrame> => {
    let raw: string
    try { raw = await options.channel.receive(waitMs) } catch { return lose() }
    const parsed = parseExecutionSupervisorFrame(raw)
    if (!parsed.ok) return lose()
    return parsed.frame
  }

  const challenge = await receive()
  const challengeReceivedAt = options.nowMs()
  if (challenge.type !== 'hello-challenge'
    || challenge.deadlineAtMs <= challengeReceivedAt
    || challenge.deadlineAtMs > challengeReceivedAt + MAX_DEADLINE_MS) return lose()
  used.add(challenge.requestId)
  const childNonce = options.randomNonce()
  if (!OPAQUE_ID.test(childNonce)) return lose()
  try {
    options.channel.send(encodeExecutionSupervisorFrame({
      version: 3,
      type: 'hello',
      requestId: challenge.requestId,
      deadlineAtMs: challenge.deadlineAtMs,
      parentNonce: challenge.parentNonce,
      childNonce,
      livenessDescriptorHash: options.livenessDescriptorHash,
    }))
  } catch { return lose() }
  const helloAck = await receive()
  if (helloAck.type !== 'hello-ack'
    || helloAck.requestId !== challenge.requestId
    || helloAck.deadlineAtMs !== challenge.deadlineAtMs
    || options.nowMs() >= challenge.deadlineAtMs
    || helloAck.sessionProof !== makeExecutionSupervisorSessionProof({
      requestId: challenge.requestId,
      parentNonce: challenge.parentNonce,
      childNonce,
      sessionId: helloAck.sessionId,
      livenessDescriptorHash: options.livenessDescriptorHash,
    })) return lose()
  const sessionId = helloAck.sessionId

  const exchange = async (
    frame: ExecutionSupervisorFrame,
    expected: ExecutionSupervisorFrameType,
    waitMs = timeoutMs,
  ): Promise<ExecutionSupervisorFrame> => {
    if (!held || outstanding || !REQUEST_ID.test(frame.requestId) || used.has(frame.requestId)) return lose()
    if (frame.deadlineAtMs <= options.nowMs() ||
      frame.deadlineAtMs > options.nowMs() + maxDeadline(frame)) return lose()
    used.add(frame.requestId)
    outstanding = true
    let reply: ExecutionSupervisorFrame
    try {
      options.channel.send(encodeExecutionSupervisorFrame(frame))
      reply = await receive(waitMs)
    } catch { return lose() } finally { outstanding = false }
    if (reply.type === 'refusal') return lose()
    if (reply.type !== expected
      || !('sessionId' in reply) || reply.sessionId !== sessionId
      || reply.requestId !== frame.requestId
      || reply.deadlineAtMs !== frame.deadlineAtMs
      || options.nowMs() >= frame.deadlineAtMs) return lose()
    return reply
  }

  const request = (type: 'recovery-request' | 'capture', bindingHash?: string): ExecutionSupervisorFrame => {
    const requestId = options.newRequestId()
    const requestedAtMs = options.nowMs()
    const deadlineAtMs = requestedAtMs + timeoutMs
    if (type === 'recovery-request') return { version: 3, type, requestId, deadlineAtMs, sessionId }
    if (bindingHash === undefined || !HASH.test(bindingHash)) return lose()
    return { version: 3, type, requestId, deadlineAtMs, sessionId, bindingHash }
  }

  const receipt = (
    view: Readonly<ExecutionSupervisorReleaseReceiptViewV1>,
  ): ExecutionSupervisorReleaseReceiptV1 => {
    const frozenView = Object.freeze({ ...view })
    const value = Object.freeze({
      kind: 'execution-supervisor-release-receipt-v1' as const,
      ...frozenView,
    })
    releaseReceiptStates.set(value, Object.freeze({
      session: sessionToken,
      view: frozenView,
      consumed: { value: false },
    }))
    return value
  }

  const lease = (
    bindingHash: string,
    leaseId: string,
    initialPhase: ExecutionSupervisorAuthorityPhase,
  ): ExecutionSupervisorLease => {
    let leaseHeld = true
    let authorityPhase = initialPhase
    let bindAttempted = false
    const value = Object.freeze<ExecutionSupervisorLease>({
      bindingHash,
      leaseId,
      get authorityPhase() { return authorityPhase },
      isHeld: () => held && leaseHeld,
      async bindCheckpoint() {
        if (!held || !leaseHeld || bindAttempted || authorityPhase !== 'captured-unbound') return lose()
        bindAttempted = true
        const requestId = options.newRequestId()
        const requestedAtMs = options.nowMs()
        const deadlineAtMs = requestedAtMs + timeoutMs
        const reply = await exchange({
          version: 3,
          type: 'checkpoint-bound',
          requestId,
          deadlineAtMs,
          sessionId,
          bindingHash,
          leaseId,
        }, 'checkpoint-bound-ack')
        if (reply.type !== 'checkpoint-bound-ack' || reply.bindingHash !== bindingHash
          || reply.leaseId !== leaseId) return lose()
        authorityPhase = 'checkpoint-bound'
      },
      async release() {
        if (!held || !leaseHeld) return lose()
        const requestId = options.newRequestId()
        const requestedAtMs = options.nowMs()
        const deadlineAtMs = requestedAtMs + timeoutMs
        const reply = await exchange({
          version: 3, type: 'release', requestId, deadlineAtMs, sessionId, bindingHash, leaseId,
        }, 'release-ack')
        if (reply.type !== 'release-ack' || reply.bindingHash !== bindingHash || reply.leaseId !== leaseId) return lose()
        leaseHeld = false
      },
      async releaseDurably(releaseInput) {
        if (!held || !leaseHeld || typeof releaseInput !== 'object' || releaseInput === null ||
          Array.isArray(releaseInput) || utilTypes.isProxy(releaseInput) ||
          Object.getPrototypeOf(releaseInput) !== Object.prototype ||
          Object.getOwnPropertySymbols(releaseInput).length !== 0) {
          return lose()
        }
        const descriptors = Object.getOwnPropertyDescriptors(releaseInput)
        if (!exactOwnKeys(descriptors, ['releaseIntentHash', 'envelopeHash']) ||
          descriptors.releaseIntentHash?.get !== undefined ||
          descriptors.releaseIntentHash?.set !== undefined ||
          descriptors.envelopeHash?.get !== undefined || descriptors.envelopeHash?.set !== undefined ||
          typeof descriptors.releaseIntentHash?.value !== 'string' ||
          typeof descriptors.envelopeHash?.value !== 'string' ||
          !HASH.test(descriptors.releaseIntentHash.value) || !HASH.test(descriptors.envelopeHash.value)) {
          return lose()
        }
        const releaseIntentHash = descriptors.releaseIntentHash.value as string
        const envelopeHash = descriptors.envelopeHash.value as string
        const requestId = options.newRequestId()
        const requestedAtMs = options.nowMs()
        const deadlineAtMs = requestedAtMs + timeoutMs
        const reply = await exchange({
          version: 3,
          type: 'release-durable',
          requestId,
          deadlineAtMs,
          sessionId,
          bindingHash,
          leaseId,
          envelopeHash,
          releaseIntentHash,
        }, 'release-durable-ack')
        if (reply.type !== 'release-durable-ack' ||
          reply.receipt.bindingHash !== bindingHash ||
          reply.receipt.envelopeHash !== envelopeHash ||
          reply.receipt.releaseIntentHash !== releaseIntentHash ||
          reply.receipt.runLivenessHash !== options.livenessDescriptorHash ||
          reply.receipt.authorityPhase !== authorityPhase ||
          reply.receipt.receiptHash !== makeExecutionSupervisorReleaseReceiptHash({
            ...reply.receipt,
            leaseId,
          })) return lose()
        leaseHeld = false
        return receipt(reply.receipt)
      },
      failClosed() { return lose() },
    })
    executionSupervisorLeases.add(value)
    executionSupervisorLeaseStates.set(value, {
      bindingHash,
      leaseId,
      sessionId,
      runLivenessHash: options.livenessDescriptorHash,
      authorityPhase: () => authorityPhase,
      isHeld: () => held && leaseHeld,
    })
    return value
  }

  const voiceProxy = makeVoiceSupervisorClient({
    sessionId,
    timeoutMs: MAX_DEADLINE_MS,
    dispatchTimeoutMs: MAX_VOICE_DISPATCH_DEADLINE_MS,
    newRequestId: options.newRequestId,
    nowMs: options.nowMs,
    exchange: (frame, expected, waitMs) => exchange(frame, expected, waitMs),
  })

  return {
    sessionId,
    voiceProxy,
    isHeld: () => held,
    onLost(listener) {
      // Loss is latched. A caller can register after the disconnect event (for
      // example in the small gap between the startup barrier and composition),
      // so late registration must observe it synchronously.
      if (!held) {
        try { listener() } catch { /* isolated */ }
        return () => undefined
      }
      lostListeners.add(listener)
      return () => { lostListeners.delete(listener) }
    },
    async requestRecoveryState() {
      const reply = await exchange(request('recovery-request'), 'recovery-lease')
      if (reply.type !== 'recovery-lease') return lose()
      if (reply.bindingHash !== null) {
        return Object.freeze({
          kind: 'lease' as const,
          lease: lease(reply.bindingHash, reply.leaseId!, reply.authorityPhase!),
        })
      }
      if (reply.releaseReceipt !== null) {
        return Object.freeze({
          kind: 'release-receipt' as const,
          receipt: receipt(reply.releaseReceipt),
        })
      }
      return Object.freeze({ kind: 'empty' as const })
    },
    async captureTurn(bindingHash) {
      const reply = await exchange(request('capture', bindingHash), 'capture-ack')
      if (reply.type !== 'capture-ack' || reply.bindingHash !== bindingHash) return lose()
      return lease(bindingHash, reply.leaseId, 'captured-unbound')
    },
    async authorizePlannedRestart(intentHash) {
      if (!HASH.test(intentHash)) return lose()
      const requestId = options.newRequestId()
      const requestedAtMs = options.nowMs()
      const deadlineAtMs = requestedAtMs + timeoutMs
      const reply = await exchange({
        version: 3,
        type: 'planned-restart',
        requestId,
        deadlineAtMs,
        sessionId,
        intentHash,
      }, 'planned-restart-ack')
      if (reply.type !== 'planned-restart-ack' || reply.intentHash !== intentHash) return lose()
    },
    async consumeReleaseReceipt(value) {
      const state = typeof value === 'object' && value !== null
        ? releaseReceiptStates.get(value)
        : undefined
      if (state === undefined || state.session !== sessionToken || state.consumed.value ||
        !Object.isFrozen(value)) return lose()
      // The parent durably clears the receipt before it sends the ACK. From
      // this point onward any failure is therefore ambiguous locally and the
      // capability must never be replayed, even if no ACK reaches this child.
      state.consumed.value = true
      const requestId = options.newRequestId()
      const requestedAtMs = options.nowMs()
      const deadlineAtMs = requestedAtMs + timeoutMs
      const reply = await exchange({
        version: 3,
        type: 'release-receipt-consumed',
        requestId,
        deadlineAtMs,
        sessionId,
        envelopeHash: state.view.envelopeHash,
        releaseIntentHash: state.view.releaseIntentHash,
        receiptHash: state.view.receiptHash,
      }, 'release-receipt-consumed-ack')
      if (reply.type !== 'release-receipt-consumed-ack' ||
        reply.envelopeHash !== state.view.envelopeHash ||
        reply.releaseIntentHash !== state.view.releaseIntentHash ||
        reply.receiptHash !== state.view.receiptHash) return lose()
    },
  }
}

/**
 * Earliest supervised-child startup barrier. Direct `aisy run` remains valid;
 * selecting supervision without an inherited IPC channel fails before callers
 * may construct vault, provider, scheduler or Telegram state. A non-null lease
 * remains held by the returned startup session until the checkpoint recovery
 * composition has durably delivered terminal state and releases it.
 */
export async function establishExecutionSupervisorStartupBarrier(input: {
  selected: boolean
  channel: ExecutionSupervisorChannel | null
  newRequestId: () => string
  randomNonce: () => string
  nowMs: () => number
  livenessDescriptorHash?: string
  timeoutMs?: number
}): Promise<ExecutionSupervisorStartupSession | null> {
  if (!input.selected) return null
  if (input.channel === null) throw new ExecutionAuthorityUnavailableError()
  if (input.livenessDescriptorHash === undefined || !HASH.test(input.livenessDescriptorHash)) {
    throw new ExecutionAuthorityUnavailableError()
  }
  const session = await authenticateExecutionSupervisorChild({
    channel: input.channel,
    newRequestId: input.newRequestId,
    randomNonce: input.randomNonce,
    nowMs: input.nowMs,
    livenessDescriptorHash: input.livenessDescriptorHash,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  })
  const recovery = await session.requestRecoveryState()
  return Object.freeze({
    ...session,
    recoveryLease: recovery.kind === 'lease' ? recovery.lease : null,
    recoveryReleaseReceipt: recovery.kind === 'release-receipt' ? recovery.receipt : null,
  })
}

interface NodeIpcProcessPort {
  connected?: boolean
  send?: (message: string) => boolean
  on(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown
  off(event: 'message' | 'disconnect', listener: (...args: unknown[]) => void): unknown
  disconnect?: () => void
}

export function makeNodeExecutionSupervisorChildChannel(port: NodeIpcProcessPort): ExecutionSupervisorChannel {
  const queued: Array<{ ok: true; value: string } | { ok: false }> = []
  const waiters: Array<(value: { ok: true; value: string } | { ok: false }) => void> = []
  const disconnectListeners = new Set<() => void>()
  let closed = false
  const deliver = (value: { ok: true; value: string } | { ok: false }): void => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(value)
    else queued.push(value)
  }
  const onMessage = (message: unknown): void => deliver(
    typeof message === 'string' ? { ok: true, value: message } : { ok: false },
  )
  const onDisconnect = (): void => {
    if (closed) return
    closed = true
    while (waiters.length > 0) waiters.shift()!({ ok: false })
    for (const listener of disconnectListeners) { try { listener() } catch { /* isolated */ } }
  }
  port.on('message', onMessage)
  port.on('disconnect', onDisconnect)
  return {
    send(line) {
      if (closed || port.connected !== true || typeof port.send !== 'function') throw new ExecutionAuthorityUnavailableError()
      port.send(line)
    },
    async receive(waitMs) {
      const queuedValue = queued.shift()
      if (queuedValue !== undefined) {
        if (!queuedValue.ok) throw new ExecutionAuthorityUnavailableError()
        return queuedValue.value
      }
      if (closed) throw new ExecutionAuthorityUnavailableError()
      return new Promise<string>((resolve, reject) => {
        let settled = false
        let waiter: (value: { ok: true; value: string } | { ok: false }) => void
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new ExecutionAuthorityUnavailableError())
        }, waitMs)
        timer.unref?.()
        waiter = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (value.ok) resolve(value.value)
          else reject(new ExecutionAuthorityUnavailableError())
        }
        waiters.push(waiter)
      })
    },
    onDisconnect(listener) {
      disconnectListeners.add(listener)
      return () => { disconnectListeners.delete(listener) }
    },
    close() {
      if (closed) return
      closed = true
      port.off('message', onMessage)
      port.off('disconnect', onDisconnect)
      while (waiters.length > 0) waiters.shift()!({ ok: false })
      try { port.disconnect?.() } catch { /* stable error only */ }
    },
  }
}

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve, join } from 'node:path'
import {
  parseInboxAttachment,
  resolvedWorkBinding,
  type ResolvedWorkBinding,
  type TelegramUpdate,
} from '@aisy/core'

import {
  parseTelegramAttachmentUpdate,
  telegramAttachmentIdentity,
  type TelegramAttachmentInbox,
} from './telegram-attachment-inbox.js'
import { TranscriptionError, type Transcriber } from './transcription-contract.js'
import type { TelegramVoiceMediaCapabilityIssuer } from './telegram-voice-media-capability.js'

export type VoiceDegradePolicy = 'reject' | 'text-only'

export type TelegramVoiceIngressEvent =
  | 'voice.ingested'
  | 'voice.transcribed'
  | 'voice.degraded'
  | 'voice.cancelled'
  | 'voice.refused'

export type TelegramVoiceIngressOutcome =
  | {
      readonly kind: 'transcribed'
      readonly binding: ResolvedWorkBinding
      readonly span: {
        readonly provenance: 'untrusted'
        readonly channel: 'voice'
        readonly text: string
        readonly receivedAt: string
        readonly sourceRef: string
      }
      readonly language?: string
      readonly durationMs?: number
    }
  | {
      readonly kind: 'degraded'
      readonly policy: VoiceDegradePolicy
      readonly notice: string
    }
  | { readonly kind: 'cancelled' }

export type TelegramVoiceIngressErrorCode =
  | 'INVALID_REQUEST'
  | 'BINDING_MISMATCH'
  | 'INGEST_FAILED'
  | 'LIMIT_EXCEEDED'
  | 'TRANSCRIPTION_REJECTED'
  | 'STATE_CORRUPT'

export class TelegramVoiceIngressError extends Error {
  constructor(public readonly code: TelegramVoiceIngressErrorCode) {
    super(code)
    this.name = 'TelegramVoiceIngressError'
  }
}

export interface TelegramVoiceIngress {
  handle(input: {
    binding: ResolvedWorkBinding
    update: TelegramUpdate
    signal?: AbortSignal
    language?: string
  }): Promise<TelegramVoiceIngressOutcome>
}

const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const TEMPORARY_FAILURES = new Set([
  'MODEL_UNAVAILABLE', 'DOCKER_INCOMPATIBLE', 'PROCESS_FAILED', 'TIMEOUT',
  'QUOTA_EXCEEDED', 'CLEANUP_FAILED',
])

function privateObjectsRoot(inboxRoot: string): string {
  if (!isAbsolute(inboxRoot) || normalize(inboxRoot) !== inboxRoot || inboxRoot.includes('\0')) {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
  const objects = resolve(join(inboxRoot, 'objects'))
  try {
    if (!existsSync(objects)) throw new TelegramVoiceIngressError('STATE_CORRUPT')
    const info = lstatSync(objects)
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(objects) !== objects) {
      throw new TelegramVoiceIngressError('STATE_CORRUPT')
    }
    return objects
  } catch (error) {
    if (error instanceof TelegramVoiceIngressError) throw error
    throw new TelegramVoiceIngressError('STATE_CORRUPT')
  }
}

function snapshotBinding(value: unknown): ResolvedWorkBinding {
  try { return Object.freeze(resolvedWorkBinding(structuredClone(value))) } catch {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['binding', 'update', 'signal', 'language'].includes(key)) ||
    !('binding' in record) || !('update' in record)) {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
  return record
}

function notice(policy: VoiceDegradePolicy): string {
  return policy === 'text-only'
    ? '🎙 Не удалось обработать голос — отправьте сообщение текстом.'
    : '🎙 Голосовые сообщения временно недоступны.'
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function safeEmit(
  emit: ((event: TelegramVoiceIngressEvent, payload: Record<string, unknown>) => void) | undefined,
  event: TelegramVoiceIngressEvent,
  payload: Record<string, unknown>,
): void {
  try { emit?.(event, payload) } catch { /* observability cannot widen voice authority */ }
}

export function makeTelegramVoiceIngress(input: {
  inbox: TelegramAttachmentInbox
  inboxRoot: string
  transcriber: Transcriber
  degradePolicy: VoiceDegradePolicy
  maxAudioBytes: number
  mediaCapabilities?: Pick<TelegramVoiceMediaCapabilityIssuer, 'issue'>
  emit?: (event: TelegramVoiceIngressEvent, payload: Record<string, unknown>) => void
}): TelegramVoiceIngress {
  if (input.degradePolicy !== 'reject' && input.degradePolicy !== 'text-only') {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
  if (!Number.isSafeInteger(input.maxAudioBytes) || input.maxAudioBytes < 1 ||
    input.maxAudioBytes > 256 * 1024 * 1024) {
    throw new TelegramVoiceIngressError('INVALID_REQUEST')
  }
  const objectsRoot = privateObjectsRoot(input.inboxRoot)

  return Object.freeze<TelegramVoiceIngress>({
    async handle(raw) {
      const request = requestRecord(raw)
      const binding = snapshotBinding(request['binding'])
      const signal = request['signal']
      const language = request['language']
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new TelegramVoiceIngressError('INVALID_REQUEST')
      }
      if (language !== undefined &&
        (typeof language !== 'string' || !LANGUAGE.test(language.toLowerCase()))) {
        throw new TelegramVoiceIngressError('INVALID_REQUEST')
      }
      if (isAborted(signal as AbortSignal | undefined)) {
        safeEmit(input.emit, 'voice.cancelled', { phase: 'before-ingest' })
        return Object.freeze({ kind: 'cancelled' as const })
      }
      const attachment = parseTelegramAttachmentUpdate(request['update'] as TelegramUpdate)
      if (attachment === null || attachment.kind !== 'voice') {
        safeEmit(input.emit, 'voice.refused', { reason: 'INVALID_REQUEST' })
        throw new TelegramVoiceIngressError('INVALID_REQUEST')
      }

      let persisted: unknown
      try { persisted = await input.inbox.ingest({ binding, attachment }) } catch {
        safeEmit(input.emit, 'voice.refused', { reason: 'INGEST_FAILED' })
        throw new TelegramVoiceIngressError('INGEST_FAILED')
      }
      const record = parseInboxAttachment(persisted)
      if (record === null) {
        safeEmit(input.emit, 'voice.refused', { reason: 'STATE_CORRUPT' })
        throw new TelegramVoiceIngressError('STATE_CORRUPT')
      }
      const identity = telegramAttachmentIdentity(binding, attachment)
      if (record.operatorId !== binding.operatorId || record.profileId !== binding.profileId ||
        record.sessionId !== binding.sessionId || record.source !== 'telegram' ||
        record.fileId !== identity.fileId || record.provenanceRef !== identity.provenanceRef ||
        record.receivedAt !== identity.receivedAt || record.originalName !== attachment.originalName ||
        (attachment.declaredSizeBytes !== undefined &&
          attachment.declaredSizeBytes !== record.sizeBytes)) {
        safeEmit(input.emit, 'voice.refused', { reason: 'BINDING_MISMATCH' })
        throw new TelegramVoiceIngressError('BINDING_MISMATCH')
      }
      if (record.sizeBytes > input.maxAudioBytes) {
        safeEmit(input.emit, 'voice.refused', { reason: 'LIMIT_EXCEEDED' })
        throw new TelegramVoiceIngressError('LIMIT_EXCEEDED')
      }
      safeEmit(input.emit, 'voice.ingested', { source: 'telegram', kind: 'voice' })
      if (isAborted(signal as AbortSignal | undefined)) {
        safeEmit(input.emit, 'voice.cancelled', { phase: 'after-ingest' })
        return Object.freeze({ kind: 'cancelled' as const })
      }

      try {
        const mediaCapability = input.mediaCapabilities?.issue({
          binding,
          attachment,
          record,
          audioRoot: objectsRoot,
          contentType: 'audio/ogg',
        })
        const transcript = await input.transcriber.transcribe({
          audioRoot: objectsRoot,
          relativePath: record.fileId,
          expectedSha256: record.sha256,
          expectedSizeBytes: record.sizeBytes,
          maxBytes: input.maxAudioBytes,
          ...(typeof language === 'string' ? { language: language.toLowerCase() } : {}),
          ...(signal instanceof AbortSignal ? { signal } : {}),
          ...(mediaCapability === undefined ? {} : { mediaCapability }),
        })
        if (transcript.provenance !== 'untrusted' || transcript.channel !== 'voice' ||
          typeof transcript.text !== 'string' || transcript.text.length === 0 ||
          transcript.text.includes('\0') ||
          Buffer.byteLength(transcript.text, 'utf8') > MAX_TRANSCRIPT_BYTES ||
          (transcript.language !== undefined && !LANGUAGE.test(transcript.language)) ||
          (transcript.durationMs !== undefined && (!Number.isSafeInteger(transcript.durationMs) ||
            transcript.durationMs < 0 || transcript.durationMs > 86_400_000))) {
          throw new TelegramVoiceIngressError('TRANSCRIPTION_REJECTED')
        }
        safeEmit(input.emit, 'voice.transcribed', {
          provenance: 'untrusted', channel: 'voice', hasLanguage: transcript.language !== undefined,
        })
        return Object.freeze({
          kind: 'transcribed' as const,
          binding,
          span: Object.freeze({
            provenance: 'untrusted' as const,
            channel: 'voice' as const,
            text: transcript.text,
            receivedAt: record.receivedAt,
            sourceRef: record.provenanceRef,
          }),
          ...(transcript.language === undefined ? {} : { language: transcript.language }),
          ...(transcript.durationMs === undefined ? {} : { durationMs: transcript.durationMs }),
        })
      } catch (error) {
        if (error instanceof TranscriptionError && error.code === 'ABORTED') {
          safeEmit(input.emit, 'voice.cancelled', { phase: 'transcription' })
          return Object.freeze({ kind: 'cancelled' as const })
        }
        if (error instanceof TranscriptionError && TEMPORARY_FAILURES.has(error.code)) {
          safeEmit(input.emit, 'voice.degraded', {
            policy: input.degradePolicy, reason: error.code,
          })
          return Object.freeze({
            kind: 'degraded' as const,
            policy: input.degradePolicy,
            notice: notice(input.degradePolicy),
          })
        }
        safeEmit(input.emit, 'voice.refused', { reason: 'TRANSCRIPTION_REJECTED' })
        throw new TelegramVoiceIngressError('TRANSCRIPTION_REJECTED')
      }
    },
  })
}

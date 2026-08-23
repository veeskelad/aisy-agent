import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedWorkBinding, TelegramUpdate } from '@aisy/core'
import {
  makeTelegramAttachmentInbox,
  telegramAttachmentIdentity,
  type TelegramAttachmentInbox,
} from './telegram-attachment-inbox.js'
import {
  makeTelegramVoiceIngress,
  TelegramVoiceIngressError,
} from './telegram-voice-ingress.js'
import {
  WhisperSidecarError,
  type WhisperTranscriber,
} from './whisper-docker-sidecar.js'
import { TranscriptionError } from './transcription-contract.js'
import { makeTelegramVoiceMediaCapabilityIssuer } from './telegram-voice-media-capability.js'

const roots: string[] = []
const BINDING: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}
const AUDIO = Buffer.from('OggS voice bytes')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-voice-inbox-')))
  mkdirSync(join(value, 'objects'), { mode: 0o700 })
  roots.push(value)
  return value
}

function update(id = 1): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_785_000_000 + id,
      chat: { id: 42 },
      voice: {
        file_id: 'telegram-voice-file',
        file_unique_id: 'voice-unique-1',
        file_size: AUDIO.byteLength,
      },
    },
  }
}

function inbox(inboxRoot: string, downloads: { count: number }): TelegramAttachmentInbox {
  return makeTelegramAttachmentInbox({
    inboxRoot,
    allowedChatId: 42,
    maxAttachmentBytes: 1024 * 1024,
    download: {
      async download() {
        downloads.count += 1
        return { body: (async function* () { yield AUDIO })(), sizeBytes: AUDIO.byteLength }
      },
    },
  })
}

function successful(assertRequest?: (value: Parameters<WhisperTranscriber['transcribe']>[0]) => void): WhisperTranscriber {
  return {
    async transcribe(request) {
      assertRequest?.(request)
      return {
        text: 'Распознанный голос',
        provenance: 'untrusted',
        channel: 'voice',
        language: 'ru',
        durationMs: 750,
      }
    },
  }
}

describe('Telegram private-inbox to Whisper coordinator', () => {
  it('binds the exact persisted object/hash to one untrusted voice span', async () => {
    const inboxRoot = root()
    const downloads = { count: 0 }
    const emit = vi.fn()
    const mediaCapabilities = makeTelegramVoiceMediaCapabilityIssuer()
    let expectedObjectHash = ''
    const runtime = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads),
      inboxRoot,
      transcriber: successful(request => {
        expect(request.audioRoot).toBe(join(inboxRoot, 'objects'))
        expect(request.relativePath).toMatch(/^tg-[a-f0-9]{64}$/)
        expect(request.expectedSha256).toBe(createHash('sha256').update(AUDIO).digest('hex'))
        expect(request.expectedSizeBytes).toBe(AUDIO.byteLength)
        expect(request.language).toBe('ru')
        expect(mediaCapabilities.consume(request.mediaCapability, request)).toMatchObject({
          mediaBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          contentType: 'audio/ogg',
        })
        expectedObjectHash = request.expectedSha256
      }),
      mediaCapabilities,
      degradePolicy: 'text-only',
      maxAudioBytes: 1024 * 1024,
      emit,
    })

    const result = await runtime.handle({ binding: BINDING, update: update(), language: 'RU' })

    expect(result).toMatchObject({
      kind: 'transcribed',
      binding: BINDING,
      span: { provenance: 'untrusted', channel: 'voice', text: 'Распознанный голос' },
      language: 'ru', durationMs: 750,
    })
    expect(expectedObjectHash).toHaveLength(64)
    expect(downloads.count).toBe(1)
    expect(emit).toHaveBeenCalledWith('voice.transcribed', {
      provenance: 'untrusted', channel: 'voice', hasLanguage: true,
    })
  })

  it('survives coordinator/inbox restart without a second Telegram download', async () => {
    const inboxRoot = root()
    const downloads = { count: 0 }
    const first = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads), inboxRoot, transcriber: successful(),
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await first.handle({ binding: BINDING, update: update() })

    const restarted = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads), inboxRoot, transcriber: successful(),
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    const replay = await restarted.handle({ binding: BINDING, update: update() })

    expect(replay.kind).toBe('transcribed')
    expect(downloads.count).toBe(1)
  })

  it.each([
    ['text-only', '🎙 Не удалось обработать голос — отправьте сообщение текстом.'],
    ['reject', '🎙 Голосовые сообщения временно недоступны.'],
  ] as const)('applies explicit %s degradation without fabricating a span', async (policy, notice) => {
    const inboxRoot = root()
    const runtime = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, { count: 0 }), inboxRoot,
      transcriber: { async transcribe() { throw new TranscriptionError('MODEL_UNAVAILABLE') } },
      degradePolicy: policy, maxAudioBytes: 1024 * 1024,
    })

    await expect(runtime.handle({ binding: BINDING, update: update() })).resolves.toEqual({
      kind: 'degraded', policy, notice,
    })
  })

  it('separates cancellation before and after durable ingest and permits exact retry', async () => {
    const inboxRoot = root()
    const downloads = { count: 0 }
    const before = new AbortController()
    before.abort()
    const runtime = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads), inboxRoot, transcriber: successful(),
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(runtime.handle({ binding: BINDING, update: update(), signal: before.signal }))
      .resolves.toEqual({ kind: 'cancelled' })
    expect(downloads.count).toBe(0)

    const during = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads), inboxRoot,
      transcriber: { async transcribe() { throw new WhisperSidecarError('ABORTED') } },
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(during.handle({ binding: BINDING, update: update() }))
      .resolves.toEqual({ kind: 'cancelled' })
    expect(downloads.count).toBe(1)

    const retry = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, downloads), inboxRoot, transcriber: successful(),
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    expect((await retry.handle({ binding: BINDING, update: update() })).kind).toBe('transcribed')
    expect(downloads.count).toBe(1)
  })

  it('rejects non-voice, forged binding and integrity failures before a span', async () => {
    const inboxRoot = root()
    const transcriber = successful()
    const runtime = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, { count: 0 }), inboxRoot, transcriber,
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    const document = update()
    const message = document.message as Record<string, unknown>
    delete message.voice
    message.document = { file_id: 'document', file_size: 1 }
    await expect(runtime.handle({ binding: BINDING, update: document }))
      .rejects.toEqual(new TelegramVoiceIngressError('INVALID_REQUEST'))

    const forgedInbox: TelegramAttachmentInbox = {
      async ingest() {
        return {
          schemaVersion: 1, fileId: 'voice-1', operatorId: 'foreign', profileId: 'default',
          sessionId: 'session-a', source: 'telegram', originalName: 'voice.ogg',
          sha256: 'a'.repeat(64), sizeBytes: 1, provenanceRef: 'telegram:voice',
          receivedAt: '2026-07-28T00:00:00.000Z',
        }
      },
    }
    const forged = makeTelegramVoiceIngress({
      inbox: forgedInbox, inboxRoot, transcriber,
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(forged.handle({ binding: BINDING, update: update() }))
      .rejects.toEqual(new TelegramVoiceIngressError('BINDING_MISMATCH'))

    const substitutedInbox: TelegramAttachmentInbox = {
      async ingest() {
        return {
          schemaVersion: 1, fileId: 'tg-substituted', operatorId: BINDING.operatorId,
          profileId: BINDING.profileId, sessionId: BINDING.sessionId, source: 'telegram',
          originalName: 'voice-1.ogg', sha256: 'a'.repeat(64), sizeBytes: AUDIO.byteLength,
          provenanceRef: 'telegram:update:999:message:999:voice:substituted',
          receivedAt: '2026-07-28T00:00:00.000Z',
        }
      },
    }
    const substituted = makeTelegramVoiceIngress({
      inbox: substitutedInbox, inboxRoot, transcriber,
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(substituted.handle({ binding: BINDING, update: update() }))
      .rejects.toEqual(new TelegramVoiceIngressError('BINDING_MISMATCH'))

    const integrity = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, { count: 0 }), inboxRoot,
      transcriber: { async transcribe() { throw new WhisperSidecarError('HASH_MISMATCH') } },
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(integrity.handle({ binding: BINDING, update: update(2) }))
      .rejects.toEqual(new TelegramVoiceIngressError('TRANSCRIPTION_REJECTED'))
  })

  it('snapshots binding before async ingest to close caller mutation TOCTOU', async () => {
    const inboxRoot = root()
    let release!: () => void
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise })
    let captured: ResolvedWorkBinding | undefined
    const delayed: TelegramAttachmentInbox = {
      async ingest({ binding, attachment }) {
        captured = binding
        await gate
        const identity = telegramAttachmentIdentity(binding, attachment)
        return {
          schemaVersion: 1, fileId: identity.fileId, operatorId: binding.operatorId,
          profileId: binding.profileId, sessionId: binding.sessionId, source: 'telegram',
          originalName: attachment.originalName, sha256: 'a'.repeat(64),
          sizeBytes: attachment.declaredSizeBytes ?? 1,
          provenanceRef: identity.provenanceRef, receivedAt: identity.receivedAt,
        }
      },
    }
    const runtime = makeTelegramVoiceIngress({
      inbox: delayed, inboxRoot, transcriber: successful(),
      degradePolicy: 'text-only', maxAudioBytes: 1024,
    })
    const mutable = { ...BINDING }
    const pending = runtime.handle({ binding: mutable, update: update() })
    mutable.sessionId = 'session-b'
    release()
    const result = await pending

    expect(captured?.sessionId).toBe('session-a')
    expect(result.kind).toBe('transcribed')
    if (result.kind === 'transcribed') expect(result.binding.sessionId).toBe('session-a')
  })

  it('bounds persisted audio before launching Whisper', async () => {
    const inboxRoot = root()
    let called = false
    const oversizedInbox: TelegramAttachmentInbox = {
      async ingest({ binding, attachment }) {
        const identity = telegramAttachmentIdentity(binding, attachment)
        return {
          schemaVersion: 1, fileId: identity.fileId, operatorId: binding.operatorId,
          profileId: binding.profileId, sessionId: binding.sessionId, source: 'telegram',
          originalName: attachment.originalName, sha256: 'a'.repeat(64), sizeBytes: 2048,
          provenanceRef: identity.provenanceRef, receivedAt: identity.receivedAt,
        }
      },
    }
    const runtime = makeTelegramVoiceIngress({
      inbox: oversizedInbox, inboxRoot,
      transcriber: { async transcribe() { called = true; return successful().transcribe({} as never) } },
      degradePolicy: 'text-only', maxAudioBytes: 1024,
    })
    const withoutDeclaredSize = update()
    const voice = (withoutDeclaredSize.message as Record<string, unknown>)['voice'] as
      Record<string, unknown>
    delete voice['file_size']
    await expect(runtime.handle({ binding: BINDING, update: withoutDeclaredSize }))
      .rejects.toEqual(new TelegramVoiceIngressError('LIMIT_EXCEEDED'))
    expect(called).toBe(false)
  })

  it('revalidates an injected transcript before it becomes an untrusted span', async () => {
    const inboxRoot = root()
    const runtime = makeTelegramVoiceIngress({
      inbox: inbox(inboxRoot, { count: 0 }), inboxRoot,
      transcriber: {
        async transcribe() {
          return {
            text: 'x'.repeat(1024 * 1024 + 1),
            provenance: 'untrusted', channel: 'voice',
          }
        },
      },
      degradePolicy: 'text-only', maxAudioBytes: 1024 * 1024,
    })
    await expect(runtime.handle({ binding: BINDING, update: update() }))
      .rejects.toEqual(new TelegramVoiceIngressError('TRANSCRIPTION_REJECTED'))
  })
})

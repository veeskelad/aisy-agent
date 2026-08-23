import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { InboxAttachmentV1, ResolvedWorkBinding } from '@aisy/core'
import {
  telegramAttachmentIdentity,
  type TelegramAttachmentDescriptor,
} from './telegram-attachment-inbox.js'
import {
  VoiceMediaCapabilityError,
  makeTelegramVoiceMediaCapabilityIssuer,
} from './telegram-voice-media-capability.js'

const roots: string[] = []
const AUDIO = Buffer.from('OggS capability audio')
const BINDING: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
})
const ATTACHMENT: TelegramAttachmentDescriptor = Object.freeze({
  updateId: 17,
  messageId: 11,
  chatId: 42,
  unixSeconds: 1_786_000_000,
  kind: 'voice',
  telegramFileId: 'telegram-file',
  telegramFileUniqueId: 'telegram-unique',
  originalName: 'voice-11.ogg',
  declaredSizeBytes: AUDIO.byteLength,
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { audioRoot: string; record: InboxAttachmentV1 } {
  const inboxRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-media-cap-')))
  const audioRoot = join(inboxRoot, 'objects')
  mkdirSync(audioRoot, { mode: 0o700 })
  const identity = telegramAttachmentIdentity(BINDING, ATTACHMENT)
  const fileId = identity.fileId
  writeFileSync(join(audioRoot, fileId), AUDIO, { mode: 0o600 })
  roots.push(inboxRoot)
  return {
    audioRoot,
    record: Object.freeze({
      schemaVersion: 1,
      fileId,
      operatorId: BINDING.operatorId,
      profileId: BINDING.profileId,
      sessionId: BINDING.sessionId,
      source: 'telegram',
      originalName: ATTACHMENT.originalName,
      sha256: createHash('sha256').update(AUDIO).digest('hex'),
      sizeBytes: AUDIO.byteLength,
      provenanceRef: identity.provenanceRef,
      receivedAt: identity.receivedAt,
    }),
  }
}

describe('Telegram voice media capability', () => {
  it('consumes one genuine exact-bound capability into a redacted media view', () => {
    const media = fixture()
    const issuer = makeTelegramVoiceMediaCapabilityIssuer()
    const capability = issuer.issue({
      binding: BINDING,
      attachment: ATTACHMENT,
      record: media.record,
      audioRoot: media.audioRoot,
      contentType: 'audio/ogg',
    })

    const view = issuer.consume(capability, {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: media.record.sha256,
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
      language: 'ru',
    })

    expect(view).toMatchObject({
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: media.record.sha256,
      expectedSizeBytes: AUDIO.byteLength,
      contentType: 'audio/ogg',
      language: 'ru',
      mediaBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(view)).not.toContain(BINDING.operatorId)
    expect(JSON.stringify(view)).not.toContain('telegram-unique')
    expect(() => issuer.consume(capability, {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: media.record.sha256,
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
    })).toThrowError(new VoiceMediaCapabilityError('CAPABILITY_REPLAYED'))
  })

  it('rejects structural copies, foreign request fields and source replacement', () => {
    const media = fixture()
    const issuer = makeTelegramVoiceMediaCapabilityIssuer()
    expect(() => issuer.consume(Object.freeze({}), {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: media.record.sha256,
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
    })).toThrowError(new VoiceMediaCapabilityError('CAPABILITY_FORGED'))

    const foreign = issuer.issue({
      binding: BINDING, attachment: ATTACHMENT, record: media.record,
      audioRoot: media.audioRoot, contentType: 'audio/ogg',
    })
    expect(() => issuer.consume(foreign, {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: '0'.repeat(64),
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
    })).toThrowError(new VoiceMediaCapabilityError('CAPABILITY_MISMATCH'))

    const replaced = issuer.issue({
      binding: BINDING, attachment: ATTACHMENT, record: media.record,
      audioRoot: media.audioRoot, contentType: 'audio/ogg',
    })
    writeFileSync(join(media.audioRoot, media.record.fileId), Buffer.alloc(AUDIO.byteLength, 1))
    expect(() => issuer.consume(replaced, {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSha256: media.record.sha256,
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
    })).toThrowError(new VoiceMediaCapabilityError('MEDIA_CHANGED'))
  })

  it('rejects a hardlinked inbox object before authority leaves the issuer', () => {
    const media = fixture()
    linkSync(join(media.audioRoot, media.record.fileId), join(media.audioRoot, 'alias'))
    const issuer = makeTelegramVoiceMediaCapabilityIssuer()

    expect(() => issuer.issue({
      binding: BINDING, attachment: ATTACHMENT, record: media.record,
      audioRoot: media.audioRoot, contentType: 'audio/ogg',
    })).toThrowError(new VoiceMediaCapabilityError('UNSAFE_MEDIA'))
  })

  it('rejects request accessors without invoking them', () => {
    const media = fixture()
    const issuer = makeTelegramVoiceMediaCapabilityIssuer()
    const capability = issuer.issue({
      binding: BINDING, attachment: ATTACHMENT, record: media.record,
      audioRoot: media.audioRoot, contentType: 'audio/ogg',
    })
    let getterCalls = 0
    const request = {
      audioRoot: media.audioRoot,
      relativePath: media.record.fileId,
      expectedSizeBytes: media.record.sizeBytes,
      maxBytes: 1024,
    }
    Object.defineProperty(request, 'expectedSha256', {
      enumerable: true,
      get() { getterCalls += 1; return media.record.sha256 },
    })

    expect(() => issuer.consume(capability, request as never))
      .toThrowError(new VoiceMediaCapabilityError('CAPABILITY_MISMATCH'))
    expect(getterCalls).toBe(0)
  })
})

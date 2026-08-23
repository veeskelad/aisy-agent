import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { InboxAttachmentV1, ResolvedWorkBinding } from '@aisy/core'
import {
  telegramAttachmentIdentity,
  type TelegramAttachmentDescriptor,
} from './telegram-attachment-inbox.js'
import {
  makeDeepgramProxyProvider,
  type DeepgramProxyPort,
  type DeepgramProxySpendAuthority,
  type DeepgramProxySpendOutcome,
} from './deepgram-proxy-provider.js'
import { TranscriptionError } from './transcription-contract.js'
import { makeTelegramVoiceMediaCapabilityIssuer } from './telegram-voice-media-capability.js'

const roots: string[] = []
const AUDIO = Buffer.from('OggS proxy provider audio')
const TICKET = 'm'.repeat(43)
const PERMIT = 'p'.repeat(43)
const RECOVERY = 'r'.repeat(43)
const BINDING: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'session-a', scope: 'session',
})
const ATTACHMENT: TelegramAttachmentDescriptor = Object.freeze({
  updateId: 91, messageId: 51, chatId: 42, unixSeconds: 1_786_000_000,
  kind: 'voice', telegramFileId: 'tg-file', telegramFileUniqueId: 'tg-unique',
  originalName: 'voice-51.ogg', declaredSizeBytes: AUDIO.byteLength,
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function media() {
  const inboxRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-proxy-provider-')))
  const audioRoot = join(inboxRoot, 'objects')
  mkdirSync(audioRoot, { mode: 0o700 })
  const identity = telegramAttachmentIdentity(BINDING, ATTACHMENT)
  const relativePath = identity.fileId
  writeFileSync(join(audioRoot, relativePath), AUDIO, { mode: 0o600 })
  roots.push(inboxRoot)
  const record: InboxAttachmentV1 = Object.freeze({
    schemaVersion: 1, fileId: relativePath, operatorId: BINDING.operatorId,
    profileId: BINDING.profileId, sessionId: BINDING.sessionId, source: 'telegram',
    originalName: ATTACHMENT.originalName,
    sha256: createHash('sha256').update(AUDIO).digest('hex'),
    sizeBytes: AUDIO.byteLength,
    provenanceRef: identity.provenanceRef,
    receivedAt: identity.receivedAt,
  })
  const issuer = makeTelegramVoiceMediaCapabilityIssuer()
  const request = {
    audioRoot,
    relativePath,
    expectedSha256: record.sha256,
    expectedSizeBytes: record.sizeBytes,
    maxBytes: 1024 * 1024,
    language: 'ru-RU',
    mediaCapability: issuer.issue({
      binding: BINDING, attachment: ATTACHMENT, record, audioRoot, contentType: 'audio/ogg',
    }),
  }
  return { issuer, request }
}

function harness(over: Readonly<{
  stage?: DeepgramProxyPort['stageMedia']
  reserve?: DeepgramProxySpendAuthority['reserve']
  prepare?: DeepgramProxyPort['prepare']
  dispatch?: DeepgramProxyPort['dispatch']
  cancel?: DeepgramProxyPort['cancelPrepared']
}> = {}) {
  const calls: string[] = []
  const outcomes: DeepgramProxySpendOutcome[] = []
  const port: DeepgramProxyPort = {
    async stageMedia(input) {
      calls.push(`stage:${input.expectedSha256}`)
      return over.stage?.(input) ?? { ok: true, mediaTicket: TICKET }
    },
    async cancelMedia(input) { calls.push(`cancel-media:${input.mediaTicket}`) },
    async prepare(input) {
      calls.push(`prepare:${input.mediaTicket}:${input.reservationRecoveryKey}`)
      return over.prepare?.(input) ?? { ok: true, dispatchPermitId: PERMIT }
    },
    async cancelPrepared(input) {
      calls.push(`cancel-permit:${input.dispatchPermitId}`)
      return over.cancel?.(input) ?? 'cancelled'
    },
    async dispatch(input) {
      calls.push(`dispatch:${input.dispatchPermitId}`)
      return over.dispatch?.(input) ?? {
        ok: true, transcript: 'Привет через proxy', language: 'ru', durationMs: 750,
      }
    },
  }
  const spend: DeepgramProxySpendAuthority = {
    async reserve(input) {
      calls.push(`reserve:${input.requestHash}`)
      if (over.reserve !== undefined) return over.reserve(input)
      return {
        recoveryKey: RECOVERY,
        async settle(outcome) { calls.push(`settle:${outcome.kind}`); outcomes.push(outcome) },
      }
    },
    async recover() { return null },
  }
  const m = media()
  const provider = makeDeepgramProxyProvider({
    timeoutMs: 5_000,
    maximumBillableDurationMs: 60_000,
    consumeMediaCapability: (capability, request) => m.issuer.consume(capability, request),
    proxy: port,
    spend,
  })
  return { ...m, provider, calls, outcomes }
}

describe('Deepgram proxy provider', () => {
  it('uses stage-reserve-prepare-dispatch-settle and returns a typed transcript', async () => {
    const h = harness()

    await expect(h.provider.transcribe(h.request)).resolves.toEqual({
      text: 'Привет через proxy', provenance: 'untrusted', channel: 'voice',
      language: 'ru', durationMs: 750,
    })
    expect(h.provider).toMatchObject({
      id: 'deepgram-cloud', audioLeavesHost: true,
      privacyRevision: 'deepgram-cloud-proxy-primary-v1',
    })
    expect(h.calls.map(call => call.split(':', 1)[0])).toEqual([
      'stage', 'reserve', 'prepare', 'dispatch', 'settle',
    ])
    expect(h.outcomes).toEqual([{ kind: 'settled', billableDurationMs: 750 }])
  })

  it('rejects forged capability before stage or spend', async () => {
    const h = harness()

    await expect(h.provider.transcribe({ ...h.request, mediaCapability: Object.freeze({}) }))
      .rejects.toEqual(new TranscriptionError('INVALID_REQUEST'))
    expect(h.calls).toEqual([])
  })

  it('cancels staged media when reservation is denied', async () => {
    const h = harness({ reserve: async () => null })

    await expect(h.provider.transcribe(h.request))
      .rejects.toEqual(new TranscriptionError('QUOTA_EXCEEDED'))
    expect(h.calls.map(call => call.split(':', 1)[0])).toEqual([
      'stage', 'reserve', 'cancel-media',
    ])
  })

  it('cancels a returned media ticket when abort wins before reserve', async () => {
    const controller = new AbortController()
    const h = harness({
      stage: async () => {
        controller.abort()
        return { ok: true, mediaTicket: TICKET }
      },
    })

    await expect(h.provider.transcribe({ ...h.request, signal: controller.signal }))
      .rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(h.calls.map(call => call.split(':', 1)[0])).toEqual([
      'stage', 'cancel-media',
    ])
    expect(h.outcomes).toEqual([])
  })

  it('releases a returned reservation when abort wins before prepare', async () => {
    const controller = new AbortController()
    const h = harness({
      reserve: async () => {
        controller.abort()
        return {
          recoveryKey: RECOVERY,
          async settle(outcome) { h.outcomes.push(outcome) },
        }
      },
    })

    await expect(h.provider.transcribe({ ...h.request, signal: controller.signal }))
      .rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(h.calls.map(call => call.split(':', 1)[0])).toEqual([
      'stage', 'reserve', 'cancel-media',
    ])
    expect(h.outcomes).toEqual([{ kind: 'released' }])
  })

  it('releases spend on pre-dispatch refusal and marks attempted refusal ambiguous', async () => {
    const before = harness({
      dispatch: async () => ({ ok: false, code: 'BACKEND_UNAVAILABLE', dispatch: 'none' }),
    })
    await expect(before.provider.transcribe(before.request))
      .rejects.toEqual(new TranscriptionError('MODEL_UNAVAILABLE'))
    expect(before.outcomes).toEqual([{ kind: 'released' }])

    const after = harness({
      dispatch: async () => ({ ok: false, code: 'UPSTREAM_UNAVAILABLE', dispatch: 'attempted' }),
    })
    await expect(after.provider.transcribe(after.request))
      .rejects.toEqual(new TranscriptionError('MODEL_UNAVAILABLE'))
    expect(after.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('cancels a prepared permit after abort and releases only a proven cancellation', async () => {
    const controller = new AbortController()
    const h = harness({
      prepare: async () => {
        controller.abort()
        return { ok: true, dispatchPermitId: PERMIT }
      },
    })

    await expect(h.provider.transcribe({ ...h.request, signal: controller.signal }))
      .rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(h.calls.map(call => call.split(':', 1)[0])).toEqual([
      'stage', 'reserve', 'prepare', 'cancel-permit', 'settle',
    ])
    expect(h.outcomes).toEqual([{ kind: 'released' }])
  })

  it('treats lost dispatch response and unproven cancellation as ambiguous', async () => {
    const lost = harness({ dispatch: async () => { throw new Error('transport detail') } })
    await expect(lost.provider.transcribe(lost.request))
      .rejects.toEqual(new TranscriptionError('PROCESS_FAILED'))
    expect(lost.outcomes).toEqual([{ kind: 'ambiguous' }])

    const controller = new AbortController()
    const unproven = harness({
      prepare: async () => {
        controller.abort()
        return { ok: true, dispatchPermitId: PERMIT }
      },
      cancel: async () => 'ambiguous',
    })
    await expect(unproven.provider.transcribe({ ...unproven.request, signal: controller.signal }))
      .rejects.toEqual(new TranscriptionError('ABORTED'))
    expect(unproven.outcomes).toEqual([{ kind: 'ambiguous' }])
  })

  it('rejects accessor-rich proxy results without invoking getters', async () => {
    let getterCalls = 0
    const result = { ok: true, durationMs: 1 }
    Object.defineProperty(result, 'transcript', {
      enumerable: true,
      get() { getterCalls += 1; return 'must not be read' },
    })
    const h = harness({ dispatch: async () => result as never })

    await expect(h.provider.transcribe(h.request))
      .rejects.toEqual(new TranscriptionError('PROTOCOL_ERROR'))
    expect(getterCalls).toBe(0)
    expect(h.outcomes).toEqual([{ kind: 'ambiguous' }])
  })
})

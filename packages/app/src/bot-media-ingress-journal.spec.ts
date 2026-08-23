import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { TelegramTransportBindingV1 } from './bot-streaming-activity-coordinator.js'
import {
  makeNodeMediaIngressJournalPersistence,
  makeTelegramMediaIngressJournal,
  MediaIngressJournalError,
  telegramMediaGroupHash,
} from './bot-media-ingress-journal.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-media-journal-')))
  roots.push(value)
  return value
}

const BINDING: TelegramTransportBindingV1 = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'session-a', chatBindingHash: 'a'.repeat(64),
}
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex')

function journal(stateRoot = root()) {
  return makeTelegramMediaIngressJournal({
    persistence: makeNodeMediaIngressJournalPersistence({ root: stateRoot }),
    maxMediaBytes: 1024,
  })
}

function acceptedInput(overrides: Record<string, unknown> = {}) {
  return {
    binding: BINDING, updateId: 1, messageId: 10,
    messageTs: '2026-07-28T10:00:00.000Z', kind: 'document' as const,
    sourceFingerprint: fingerprint('telegram-file-1'), ...overrides,
  }
}

function rewriteStateWithValidChecksum(stateRoot: string, mutate: (state: any) => void): void {
  const directory = readdirSync(stateRoot)[0]
  if (directory === undefined) throw new Error('missing state directory')
  const path = join(stateRoot, directory, 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  mutate(state)
  const { checksum: _checksum, ...body } = state
  state.checksum = createHash('sha256').update('aisy.telegram.media-journal.v1\0')
    .update(JSON.stringify(body)).digest('hex')
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
}

describe('Telegram media ingress journal preview', () => {
  it('persists content-independent authority and exact record idempotently', async () => {
    const runtime = journal()
    const accepted = await runtime.accept(acceptedInput())
    await expect(runtime.accept(acceptedInput())).resolves.toEqual({
      status: 'duplicate', mediaIngressId: accepted.mediaIngressId,
    })
    const recorded = await runtime.record({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId, fileId: 'tg-file-1',
      sha256: fingerprint('bytes'), sizeBytes: 5,
    })
    expect(recorded.media).toMatchObject({
      binding: BINDING, phase: 'recorded', provenance: 'untrusted', sizeBytes: 5,
    })
    await expect(runtime.record({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId, fileId: 'tg-file-1',
      sha256: fingerprint('bytes'), sizeBytes: 5,
    })).resolves.toMatchObject({ status: 'duplicate' })
  })

  it('isolates equal Session ids in different Projects', async () => {
    const stateRoot = root()
    const runtime = journal(stateRoot)
    const first = await runtime.accept(acceptedInput())
    const other = { ...BINDING, projectId: 'project-b' }
    const second = await runtime.accept(acceptedInput({ binding: other }))
    expect(second.mediaIngressId).not.toBe(first.mediaIngressId)
    expect((await runtime.snapshot(BINDING)).media).toHaveLength(1)
    expect((await runtime.snapshot(other)).media).toHaveLength(1)
  })

  it('quarantines changed authority under the same ingress identity', async () => {
    const runtime = journal()
    await runtime.accept(acceptedInput())
    await expect(runtime.accept(acceptedInput({ messageTs: '2026-07-28T10:00:01.000Z' })))
      .rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
    await expect(runtime.snapshot(BINDING))
      .rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })

  it('quarantines a changed source fingerprint for the same Telegram update', async () => {
    const runtime = journal()
    await runtime.accept(acceptedInput())
    await expect(runtime.accept(acceptedInput({ sourceFingerprint: fingerprint('substituted') })))
      .rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })

  it('recomputes ingress identity while recovering a checksummed state', async () => {
    const stateRoot = root()
    const runtime = journal(stateRoot)
    await runtime.accept(acceptedInput())
    rewriteStateWithValidChecksum(stateRoot, state => { state.media[0].mediaIngressId = 'f'.repeat(64) })
    await expect(journal(stateRoot).snapshot(BINDING))
      .rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })

  it('verifies that recovered album members belong to the exact group', async () => {
    const stateRoot = root()
    const runtime = journal(stateRoot)
    const firstGroup = telegramMediaGroupHash({ binding: BINDING, mediaGroupId: 'album-a' })
    const secondGroup = telegramMediaGroupHash({ binding: BINDING, mediaGroupId: 'album-b' })
    await runtime.accept(acceptedInput({ groupHash: firstGroup }))
    await runtime.accept(acceptedInput({
      updateId: 2, messageId: 11, groupHash: secondGroup,
      sourceFingerprint: fingerprint('telegram-file-2'),
    }))
    rewriteStateWithValidChecksum(stateRoot, state => {
      const first = state.albums[0].orderedMediaIngressIds[0]
      state.albums[0].orderedMediaIngressIds[0] = state.albums[1].orderedMediaIngressIds[0]
      state.albums[1].orderedMediaIngressIds[0] = first
    })
    await expect(journal(stateRoot).snapshot(BINDING))
      .rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })

  it('redacts quarantine persistence failures to a stable state code', async () => {
    const runtime = makeTelegramMediaIngressJournal({
      maxMediaBytes: 1024,
      persistence: {
        async load() { return { status: 'ready' as const, value: null } },
        async commit() { throw new Error('must not commit') },
        async quarantine() { throw new Error('sensitive filesystem detail') },
      },
    })
    await expect(runtime.snapshot(BINDING))
      .rejects.toEqual(new MediaIngressJournalError('STATE_UNAVAILABLE'))
  })

  it('caps an album at ten ordered items and persists one ack FSM', async () => {
    const runtime = journal()
    const groupHash = telegramMediaGroupHash({ binding: BINDING, mediaGroupId: 'album-1' })
    const ids: string[] = []
    for (let index = 0; index < 11; index += 1) {
      const accepted = await runtime.accept(acceptedInput({
        updateId: index + 1, messageId: index + 10, kind: 'photo', groupHash,
        sourceFingerprint: fingerprint(`photo-${index}`),
      }))
      if (accepted.status !== 'capped') ids.push(accepted.mediaIngressId)
      else expect(index).toBe(10)
    }
    await expect(runtime.accept(acceptedInput({
      updateId: 11, messageId: 20, kind: 'photo', groupHash,
      sourceFingerprint: fingerprint('photo-10'),
    }))).resolves.toMatchObject({ status: 'capped' })
    const sealed = await runtime.sealAlbum({ binding: BINDING, groupHash, orderedMediaIngressIds: ids })
    expect(sealed).toMatchObject({ received: 11, failed: 1, phase: 'sealed' })
    const pending = await runtime.markAlbumAck({
      binding: BINDING, groupHash, expectedRevision: sealed.revision, delivery: 'pending',
    })
    const delivered = await runtime.markAlbumAck({
      binding: BINDING, groupHash, expectedRevision: pending.revision, delivery: 'delivered',
    })
    expect(delivered.phase).toBe('ack-delivered')
  })

  it('quarantines changed retry metadata for a durably capped album item', async () => {
    const runtime = journal()
    const groupHash = telegramMediaGroupHash({ binding: BINDING, mediaGroupId: 'album-capped-retry' })
    for (let index = 0; index < 11; index += 1) {
      await runtime.accept(acceptedInput({
        updateId: index + 1, messageId: index + 10, kind: 'photo', groupHash,
        sourceFingerprint: fingerprint(`capped-photo-${index}`),
      }))
    }
    await expect(runtime.accept(acceptedInput({
      updateId: 11, messageId: 20, kind: 'photo', groupHash,
      sourceFingerprint: fingerprint('changed-capped-photo'),
    }))).rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })

  it('accepts only exact untrusted voice evidence and enforces media bytes', async () => {
    const stateRoot = root()
    const runtime = journal(stateRoot)
    const accepted = await runtime.accept(acceptedInput({ kind: 'voice' }))
    await expect(runtime.record({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId, fileId: 'voice-1',
      sha256: fingerprint('voice'), sizeBytes: 1025,
    })).rejects.toEqual(new MediaIngressJournalError('MEDIA_LIMIT_EXCEEDED'))
    await runtime.record({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId, fileId: 'voice-1',
      sha256: fingerprint('voice'), sizeBytes: 5,
    })
    const outcome = {
      kind: 'transcribed' as const, provenance: 'untrusted' as const, channel: 'voice' as const,
      transcriptHash: fingerprint('text'),
    }
    const firstVoice = await runtime.recordVoice({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId,
      outcome,
    })
    expect(firstVoice).toMatchObject({ phase: 'transcribed', provenance: 'untrusted' })
    const retriedVoice = await journal(stateRoot).recordVoice({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId, outcome,
    })
    expect(retriedVoice).toEqual(firstVoice)
    await expect(journal(stateRoot).recordVoice({
      binding: BINDING, mediaIngressId: accepted.mediaIngressId,
      outcome: { ...outcome, transcriptHash: fingerprint('different text') },
    })).rejects.toEqual(new MediaIngressJournalError('MEDIA_QUARANTINED'))
  })
})

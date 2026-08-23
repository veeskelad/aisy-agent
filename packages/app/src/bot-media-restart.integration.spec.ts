import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { TelegramTransportBindingV1 } from './bot-streaming-activity-coordinator.js'
import {
  makeNodeMediaIngressJournalPersistence,
  makeTelegramMediaIngressJournal,
  telegramMediaGroupHash,
} from './bot-media-ingress-journal.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const BINDING: TelegramTransportBindingV1 = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'session-a', chatBindingHash: 'a'.repeat(64),
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe('Telegram media journal restart preview', () => {
  it('resumes exact album ordering and pending acknowledgement in a fresh runtime', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-media-restart-')))
    roots.push(stateRoot)
    const build = () => makeTelegramMediaIngressJournal({
      persistence: makeNodeMediaIngressJournalPersistence({ root: stateRoot }), maxMediaBytes: 1024,
    })
    const groupHash = telegramMediaGroupHash({ binding: BINDING, mediaGroupId: 'album-1' })
    const first = build()
    const ids: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const accepted = await first.accept({
        binding: BINDING, updateId: index + 1, messageId: index + 10,
        messageTs: `2026-07-28T10:00:0${index}.000Z`, kind: 'photo',
        sourceFingerprint: digest(`photo-${index}`), groupHash,
      })
      ids.push(accepted.mediaIngressId)
      await first.record({
        binding: BINDING, mediaIngressId: accepted.mediaIngressId, fileId: `photo-${index}`,
        sha256: digest(`bytes-${index}`), sizeBytes: 10,
      })
    }
    const sealed = await first.sealAlbum({ binding: BINDING, groupHash, orderedMediaIngressIds: ids })
    await first.markAlbumAck({
      binding: BINDING, groupHash, expectedRevision: sealed.revision, delivery: 'pending',
    })

    const restarted = build()
    const snapshot = await restarted.snapshot(BINDING)
    expect(snapshot.albums[0]).toMatchObject({
      orderedMediaIngressIds: ids, phase: 'ack-pending', received: 2,
    })
    const pending = snapshot.albums[0]!
    await expect(restarted.markAlbumAck({
      binding: BINDING, groupHash, expectedRevision: pending.revision, delivery: 'delivered',
    })).resolves.toMatchObject({ phase: 'ack-delivered' })
  })
})

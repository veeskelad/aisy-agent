import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeSessionActivityJournal } from '@aisy/core'
import {
  makeTelegramChatBindingHash,
  makeTelegramTurnActivityCoordinator,
} from './bot-streaming-activity-coordinator.js'
import { makeNodeSessionActivityJournalPersistence } from './session-activity-journal-store.js'
import { makeTelegramReplyStream } from './telegram-reply-stream.js'
import {
  makeNodeTelegramReplyCheckpointStore,
  makeTelegramReplyBindingHash,
  recoverTelegramReplyCheckpoint,
} from './telegram-reply-stream-checkpoint.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-stream-restart-')))
  roots.push(value)
  return value
}

describe('durable Telegram reply stream preview', () => {
  it('restores a prepared exact-bound dispatch through a fresh activity runtime', async () => {
    const stateRoot = join(root(), 'activity')
    const binding = {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a',
      chatBindingHash: makeTelegramChatBindingHash({
        botPublicId: 'aisy-bot', chatId: 42, operatorId: 'telegram:42',
      }),
    }
    const build = () => makeTelegramTurnActivityCoordinator({
      journal: makeSessionActivityJournal({
        persistence: makeNodeSessionActivityJournalPersistence({ root: stateRoot }),
        nowIso: () => '2026-07-28T10:00:00.000Z',
      }),
    })
    const first = build()
    const accepted = await first.accept({
      binding, updateId: 7, messageTs: '2026-07-28T09:00:00.000Z',
      span: { role: 'user', provenance: 'operator', text: 'продолжай' },
    })
    const sealed = await first.seal({
      binding, orderedIngressIds: [accepted.ingressId], sealedAt: '2026-07-28T10:00:00.000Z',
    })
    await expect(build().recover({
      binding, dispatchId: sealed.dispatch.dispatchId, updateIds: [7], transcript: [],
    }))
      .resolves.toMatchObject({ kind: 'ready', dispatch: { binding: {
        operatorId: binding.operatorId, profileId: binding.profileId,
        projectId: binding.projectId, sessionId: binding.sessionId,
      } } })
  })

  it('persists an accepted terminal reply and a fresh runtime observes it as clean', async () => {
    const path = join(root(), 'reply.json')
    const dispatchId = 'b'.repeat(64)
    const bindingHash = makeTelegramReplyBindingHash({
      binding: { operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a' },
      chatBindingHash: 'a'.repeat(64), dispatchId,
    })
    const output = {
      guard: vi.fn(async () => undefined),
      sendText: vi.fn(async () => 19),
      editText: vi.fn(async () => undefined),
      sendDocument: vi.fn(async () => undefined),
    }
    const stream = makeTelegramReplyStream({
      output, signal: new AbortController().signal, editIntervalMs: 0,
      checkpoint: {
        store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash, dispatchId,
        ownerId: 'owner-1', nowIso: () => '2026-07-28T10:00:00.000Z',
      },
    })
    stream.setLockout(false)
    await expect(stream.finalize('готово')).resolves.toBe(true)
    expect(recoverTelegramReplyCheckpoint({
      store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash,
    })).toEqual({ kind: 'none' })
    expect(output.sendText).toHaveBeenCalledTimes(1)
  })

  it('persists terminal state when final text equals the last streamed snapshot', async () => {
    const path = join(root(), 'reply.json')
    const dispatchId = '7'.repeat(64)
    const bindingHash = makeTelegramReplyBindingHash({
      binding: { operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a' },
      chatBindingHash: '8'.repeat(64), dispatchId,
    })
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal, editIntervalMs: 0,
      output: {
        async guard() {}, async sendText() { return 21 }, async editText() {}, async sendDocument() {},
      },
      checkpoint: {
        store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash, dispatchId,
        ownerId: 'owner-1', nowIso: () => '2026-07-28T10:00:00.000Z',
      },
    })
    stream.setLockout(false)
    await stream.append('тот же ответ')
    await expect(stream.finalize('тот же ответ')).resolves.toBe(true)
    expect(recoverTelegramReplyCheckpoint({
      store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash,
    })).toEqual({ kind: 'none' })
  })

  it('keeps ambiguous first send pending and restart performs zero Telegram I/O', async () => {
    const path = join(root(), 'reply.json')
    const dispatchId = 'd'.repeat(64)
    const bindingHash = makeTelegramReplyBindingHash({
      binding: { operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a' },
      chatBindingHash: 'c'.repeat(64), dispatchId,
    })
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal, editIntervalMs: 0,
      output: {
        async guard() {},
        async sendText() { throw new Error('accepted but response lost') },
        async editText() { throw new Error('unexpected') },
        async sendDocument() { throw new Error('unexpected') },
      },
      checkpoint: {
        store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash, dispatchId,
        ownerId: 'owner-1', nowIso: () => '2026-07-28T10:00:00.000Z',
      },
    })
    stream.setLockout(false)
    await expect(stream.finalize('ответ')).resolves.toBe(false)
    const network = vi.fn()
    const result = recoverTelegramReplyCheckpoint({
      store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash,
    })
    expect(result).toEqual({ kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN' })
    expect(network).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous streaming send during finalization', async () => {
    const path = join(root(), 'reply.json')
    const dispatchId = 'f'.repeat(64)
    const bindingHash = makeTelegramReplyBindingHash({
      binding: { operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a' },
      chatBindingHash: 'e'.repeat(64), dispatchId,
    })
    let sends = 0
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal, editIntervalMs: 0,
      output: {
        async guard() {}, async sendText() { sends += 1; throw new Error('ambiguous') },
        async editText() {}, async sendDocument() {},
      },
      checkpoint: {
        store: makeNodeTelegramReplyCheckpointStore({ path }), bindingHash, dispatchId,
        ownerId: 'owner-1', nowIso: () => '2026-07-28T10:00:00.000Z',
      },
    })
    stream.setLockout(false)
    await stream.append('часть')
    await expect(stream.finalize('финал')).resolves.toBe(false)
    expect(sends).toBe(1)
  })

  it('bounds buffered Unicode by UTF-8 bytes and emits no pre-verdict bytes', async () => {
    const sent: string[] = []
    const stream = makeTelegramReplyStream({
      signal: new AbortController().signal, editIntervalMs: 0,
      output: {
        async guard() {}, async sendText(text) { sent.push(text); return 1 },
        async editText(_id, text) { sent.push(text) }, async sendDocument() {},
      },
    })
    await stream.append('секрет до verdict')
    stream.setLockout(false)
    await stream.append('я'.repeat(2 * 1024 * 1024 + 1))
    await expect(stream.finalize('готово')).resolves.toBe(true)
    expect(sent).toEqual(['готово'])
  })
})

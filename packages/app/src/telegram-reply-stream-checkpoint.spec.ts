import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  confirmTelegramReplyCheckpointForSupervisorRelease,
  makeTelegramReplyCheckpointAuthority,
  makeTelegramReplyDeliveryReceipt,
  makeNodeTelegramReplyCheckpointStore,
  makeTelegramReplyBindingHash,
  makeTelegramReplyCheckpoint,
  inspectNodeTelegramReplyCheckpointForSupervisorRelease,
  recoverTelegramReplyCheckpoint,
  replyContentHash,
} from './telegram-reply-stream-checkpoint.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-reply-checkpoint-')))
  roots.push(value)
  return value
}

const binding = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a', sessionId: 'session-a',
}
const chatBindingHash = 'a'.repeat(64)
const dispatchId = 'b'.repeat(64)

function bindingHash(projectId = 'project-a'): string {
  return makeTelegramReplyBindingHash({ binding: { ...binding, projectId }, chatBindingHash, dispatchId })
}

describe('Telegram reply checkpoint v1 preview', () => {
  it('binds operator/profile/Project/Session and dispatch without raw values at rest', () => {
    expect(bindingHash()).toMatch(/^[a-f0-9]{64}$/)
    expect(bindingHash('project-b')).not.toBe(bindingHash())
  })

  it('persists pending before delivery and fences stale owners', () => {
    const store = makeNodeTelegramReplyCheckpointStore({ path: join(root(), 'reply.json') })
    const pending = makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, document: 'none',
      updatedAt: '2026-07-28T10:00:00.000Z',
    })
    store.begin(pending)
    const delivered = makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 2,
      phase: 'terminal', delivery: 'delivered', messageId: 17, locked: false,
      replyHash: replyContentHash('готово'), document: 'none',
      updatedAt: '2026-07-28T10:00:01.000Z',
    })
    expect(() => store.replace(delivered, {
      bindingHash: bindingHash(), dispatchId, ownerId: 'foreign', revision: 1,
    })).toThrow('REPLY_CHECKPOINT_STALE_OWNER')
    const stolen = makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'foreign', revision: 2,
      phase: 'terminal', delivery: 'delivered', messageId: 17, locked: false,
      replyHash: replyContentHash('готово'), document: 'none',
      updatedAt: '2026-07-28T10:00:01.000Z',
    })
    expect(() => store.replace(stolen, {
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
    })).toThrow('REPLY_CHECKPOINT_STALE_OWNER')
    store.replace(delivered, { bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1 })
    expect(store.load()).toEqual({ status: 'ready', checkpoint: delivered })
  })

  it('reports an ambiguous first send without blind resend after restart', () => {
    const path = join(root(), 'reply.json')
    const first = makeNodeTelegramReplyCheckpointStore({ path })
    first.begin(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, document: 'none',
      updatedAt: '2026-07-28T10:00:00.000Z',
    }))
    const restarted = makeNodeTelegramReplyCheckpointStore({ path })
    expect(recoverTelegramReplyCheckpoint({ store: restarted, bindingHash: bindingHash() }))
      .toEqual({ kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN' })
  })

  it('does not allow another Project to claim pending delivery', () => {
    const store = makeNodeTelegramReplyCheckpointStore({ path: join(root(), 'reply.json') })
    store.begin(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, document: 'none',
      updatedAt: '2026-07-28T10:00:00.000Z',
    }))
    expect(recoverTelegramReplyCheckpoint({ store, bindingHash: bindingHash('project-b') }))
      .toEqual({ kind: 'denied', code: 'BINDING_MISMATCH' })
  })

  it('returns an exact durable receipt only for the expected terminal reply', () => {
    const trustedRoot = root()
    const path = join(trustedRoot, 'reply.json')
    const store = makeNodeTelegramReplyCheckpointStore({ path, trustedRoot })
    const hash = replyContentHash('готово')
    store.begin(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, replyHash: hash,
      document: 'none', updatedAt: '2026-07-28T10:00:00.000Z',
    }))
    const delivered = makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 2,
      phase: 'terminal', delivery: 'delivered', messageId: 41, locked: false,
      replyHash: hash, document: 'none', updatedAt: '2026-07-28T10:00:01.000Z',
    })
    store.replace(delivered, { bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1 })

    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path, trustedRoot, bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', replyHash: hash,
    })).toMatchObject({
      kind: 'delivered',
      receipt: {
        schemaVersion: 1, bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1',
        revision: 2, messageId: 41, replyHash: hash, document: 'none',
      },
    })
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path, trustedRoot, bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1',
      replyHash: replyContentHash('другой'),
    })).toEqual({ kind: 'denied', code: 'REPLY_CHECKPOINT_IDENTITY_MISMATCH' })
    for (const mismatch of [
      { bindingHash: 'c'.repeat(64) },
      { dispatchId: 'd'.repeat(64) },
      { ownerId: 'owner-2' },
    ]) {
      expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
        path, trustedRoot, bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1',
        replyHash: hash, ...mismatch,
      })).toEqual({ kind: 'denied', code: 'REPLY_CHECKPOINT_IDENTITY_MISMATCH' })
    }
    const authority = makeTelegramReplyCheckpointAuthority({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', assertHeld: () => true,
    })
    const receipt = makeTelegramReplyDeliveryReceipt(delivered)!
    expect(confirmTelegramReplyCheckpointForSupervisorRelease({
      store, authority, bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1',
      expectedReceipt: { ...receipt, revision: 1 },
    })).toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', revision: 2, messageId: 41,
    })
  })

  it('keeps legacy prepared and pending document checkpoints uncertain', () => {
    const firstRoot = root()
    const firstPath = join(firstRoot, 'reply.json')
    makeNodeTelegramReplyCheckpointStore({ path: firstPath }).begin(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, document: 'none',
      updatedAt: '2026-07-28T10:00:00.000Z',
    }))
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path: firstPath, trustedRoot: firstRoot, bindingHash: bindingHash(), dispatchId,
      ownerId: 'owner-1', replyHash: replyContentHash('неизвестный старый ответ'),
    })).toEqual({ kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', revision: 1 })

    const documentRoot = root()
    const documentPath = join(documentRoot, 'reply.json')
    const documentStore = makeNodeTelegramReplyCheckpointStore({ path: documentPath })
    const hash = replyContentHash('длинный ответ')
    documentStore.begin(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1,
      phase: 'prepared', delivery: 'pending', locked: false, replyHash: hash,
      document: 'none', updatedAt: '2026-07-28T10:00:00.000Z',
    }))
    documentStore.replace(makeTelegramReplyCheckpoint({
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 2,
      phase: 'terminal', delivery: 'delivered', messageId: 43, locked: false,
      replyHash: hash, document: 'pending', updatedAt: '2026-07-28T10:00:01.000Z',
    }), { bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1', revision: 1 })
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path: documentPath, trustedRoot: documentRoot, bindingHash: bindingHash(), dispatchId,
      ownerId: 'owner-1', replyHash: hash,
    })).toEqual({
      kind: 'delivery-uncertain', code: 'DELIVERY_UNCERTAIN', revision: 2, messageId: 43,
    })
  })

  it('is read-only for absent state and rejects a symlinked directory chain', () => {
    const trustedRoot = root()
    const missingPath = join(trustedRoot, 'missing', 'reply.json')
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path: missingPath, trustedRoot, bindingHash: bindingHash(), dispatchId,
      ownerId: 'owner-1', replyHash: replyContentHash('готово'),
    })).toEqual({ kind: 'missing' })
    expect(existsSync(join(trustedRoot, 'missing'))).toBe(false)

    const outside = root()
    symlinkSync(outside, join(trustedRoot, 'linked'))
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path: join(trustedRoot, 'linked', 'reply.json'), trustedRoot,
      bindingHash: bindingHash(), dispatchId, ownerId: 'owner-1',
      replyHash: replyContentHash('готово'),
    })).toEqual({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  })

  it('reads at most the bounded checkpoint size', () => {
    const trustedRoot = root()
    const path = join(trustedRoot, 'reply.json')
    writeFileSync(path, 'x'.repeat(64 * 1024 + 1), { encoding: 'utf8', mode: 0o600 })

    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease({
      path, trustedRoot, bindingHash: bindingHash(), dispatchId,
      ownerId: 'owner-1', replyHash: replyContentHash('готово'),
    })).toEqual({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  })

  it('rejects hard-linked, public, corrupt and proxied inspection evidence', () => {
    const hardlinkRoot = root()
    const source = join(hardlinkRoot, 'source.json')
    const hardlink = join(hardlinkRoot, 'reply.json')
    writeFileSync(source, '{}', { encoding: 'utf8', mode: 0o600 })
    linkSync(source, hardlink)
    const inspect = (path: string, trustedRoot: string) =>
      inspectNodeTelegramReplyCheckpointForSupervisorRelease({
        path, trustedRoot, bindingHash: bindingHash(), dispatchId,
        ownerId: 'owner-1', replyHash: replyContentHash('готово'),
      })
    expect(inspect(hardlink, hardlinkRoot)).toEqual({
      kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED',
    })

    const publicRoot = root()
    const publicPath = join(publicRoot, 'reply.json')
    writeFileSync(publicPath, '{}', { encoding: 'utf8', mode: 0o600 })
    chmodSync(publicPath, 0o644)
    expect(inspect(publicPath, publicRoot)).toEqual({
      kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED',
    })

    const corruptRoot = root()
    const corruptPath = join(corruptRoot, 'reply.json')
    writeFileSync(corruptPath, '{', { encoding: 'utf8', mode: 0o600 })
    expect(inspect(corruptPath, corruptRoot)).toEqual({
      kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED',
    })

    const proxyTarget = {
      path: corruptPath,
      trustedRoot: corruptRoot,
      bindingHash: bindingHash(),
      dispatchId,
      ownerId: 'owner-1',
      replyHash: replyContentHash('готово'),
    }
    expect(inspectNodeTelegramReplyCheckpointForSupervisorRelease(
      new Proxy(proxyTarget, {}),
    )).toEqual({ kind: 'quarantined', code: 'REPLY_CHECKPOINT_QUARANTINED' })
  })
})

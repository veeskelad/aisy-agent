import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedWorkBinding } from '@aisy/core'
import {
  inspectMediaInboxWriterLock,
  makeDeadWriterQuiescence,
  makeMediaInboxWriterRecovery,
  unattendedRecoveryAuthorization,
  type MediaInboxWriterQuiescencePort,
  type MediaInboxWriterRecoveryAuthorizationPort,
} from './telegram-attachment-inbox-recovery.js'
import {
  makeSingletonTelegramAttachmentInbox,
  TelegramAttachmentInboxError,
  type TelegramAttachmentDescriptor,
} from './telegram-attachment-inbox.js'

const roots: string[] = []
const binding: ResolvedWorkBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'session',
}
const attachment: TelegramAttachmentDescriptor = {
  updateId: 1,
  messageId: 2,
  chatId: 42,
  unixSeconds: Date.parse('2026-07-28T06:00:00.000Z') / 1000,
  kind: 'voice',
  telegramFileId: 'file-id',
  telegramFileUniqueId: 'unique-id',
  originalName: 'voice.ogg',
  declaredSizeBytes: 1,
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-inbox-recovery-')))
  roots.push(root)
  return root
}

function writer(root: string, nonce = 'writer-a', calls: string[] = []) {
  return makeSingletonTelegramAttachmentInbox({
    inboxRoot: root,
    allowedChatId: 42,
    maxAttachmentBytes: 1024,
    download: {
      async download(fileId) {
        calls.push(fileId)
        return {
          sizeBytes: 1,
          body: (async function* () { yield Uint8Array.of(7) })(),
        }
      },
    },
    nowIso: () => '2026-07-28T06:00:00.000Z',
    newNonce: () => nonce,
    pid: 101,
  })
}

function ports(input: {
  authorized?: boolean
  quiescent?: boolean
  releaseFails?: boolean
} = {}) {
  const authorize = vi.fn((_: Parameters<MediaInboxWriterRecoveryAuthorizationPort['consume']>[0]) =>
    input.authorized ?? true)
  const authorization: MediaInboxWriterRecoveryAuthorizationPort = { consume: authorize }
  const release = vi.fn(() => {
    if (input.releaseFails === true) throw new Error('private service-manager error')
  })
  const quiescence: MediaInboxWriterQuiescencePort = {
    acquire: vi.fn(() => (input.quiescent ?? true)
      ? { assertHeld: () => true, release }
      : null),
  }
  return { authorization, authorize, quiescence, release }
}

describe('media inbox writer-lock recovery', () => {
  it('reports only redaction-safe owner evidence and archived recovery count', () => {
    const root = tempRoot()
    expect(inspectMediaInboxWriterLock({ inboxRoot: join(root, 'missing') }))
      .toEqual({ state: 'absent', archivedRecoveries: 0 })
    writer(root, 'private-owner-nonce')

    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })

    expect(finding).toMatchObject({
      state: 'held',
      ownerFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      acquiredAt: '2026-07-28T06:00:00.000Z',
      archivedRecoveries: 0,
    })
    expect(JSON.stringify(finding)).not.toContain('private-owner-nonce')
    expect(JSON.stringify(finding)).not.toContain(root)
  })

  // Оборванный захват на fr1 выключил приём вложений и голоса на сутки:
  // директория lock осталась пустой после рестарта, inspect читал её как
  // повреждённое состояние, и композиция сдавалась до ручного вмешательства.
  describe('оборванный захват', () => {
    const abandon = (root: string): void => {
      mkdirSync(join(root, '.writer.lock'), { mode: 0o700 })
    }

    it('отличается от повреждённого состояния', () => {
      const root = tempRoot()
      abandon(root)

      expect(inspectMediaInboxWriterLock({ inboxRoot: root }))
        .toEqual({ state: 'abandoned', archivedRecoveries: 0 })
    })

    it('убирается без approval — одобрять там нечего', () => {
      const root = tempRoot()
      abandon(root)
      const { authorization, authorize, quiescence } = ports()

      const discarded = makeMediaInboxWriterRecovery({ inboxRoot: root, authorization, quiescence })
        .discardAbandoned()

      expect(discarded).toBe(true)
      expect(authorize).not.toHaveBeenCalled()
      expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('absent')
      // Убрали — значит писать снова можно.
      expect(() => writer(root)).not.toThrow()
    })

    it('не трогает захват с живым владельцем', () => {
      const root = tempRoot()
      writer(root)
      const { authorization, quiescence } = ports()
      const recovery = makeMediaInboxWriterRecovery({ inboxRoot: root, authorization, quiescence })

      expect(recovery.discardAbandoned()).toBe(false)
      expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('held')
    })

    it('живой композиции хватает штатного порта тишины', () => {
      // Порт доказывает тишину мёртвым pid владельца. У оборванного захвата
      // владельца нет — и раньше он отвечал «занято», из-за чего уборка в
      // живой сборке не начиналась ни разу.
      const root = tempRoot()
      abandon(root)

      const discarded = makeMediaInboxWriterRecovery({
        inboxRoot: root,
        authorization: unattendedRecoveryAuthorization,
        quiescence: makeDeadWriterQuiescence({ inboxRoot: root }),
      }).discardAbandoned()

      expect(discarded).toBe(true)
      expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('absent')
    })

    it('отказывается убирать, пока рантайм не замолчал', () => {
      const root = tempRoot()
      abandon(root)
      const { authorization, quiescence } = ports({ quiescent: false })

      expect(() => makeMediaInboxWriterRecovery({ inboxRoot: root, authorization, quiescence })
        .discardAbandoned()).toThrow('RUNTIME_NOT_QUIESCENT')
      expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('abandoned')
    })

    it('архивации оборванного захвата нет: у него нет владельца', () => {
      const root = tempRoot()
      abandon(root)
      const { authorization, quiescence } = ports()

      expect(() => makeMediaInboxWriterRecovery({ inboxRoot: root, authorization, quiescence })
        .archive({
          expectedOwnerFingerprint: `sha256:${'0'.repeat(64)}`,
          approval: 'yes',
        })).toThrow('WRITER_LOCK_ABSENT')
    })
  })

  it('fails a broken symlink root closed instead of reporting it absent', () => {
    const parent = tempRoot()
    const inboxRoot = join(parent, 'media-inbox')
    symlinkSync(join(parent, 'missing-target'), inboxRoot)

    expect(inspectMediaInboxWriterLock({ inboxRoot }))
      .toEqual({ state: 'corrupt', archivedRecoveries: 0 })
  })

  it('requires both exact approval and an exclusive quiescence lease', () => {
    const root = tempRoot()
    writer(root)
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')

    const denied = ports({ authorized: false })
    expect(() => makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: denied.authorization,
      quiescence: denied.quiescence,
      newId: () => 'denied',
    }).archive({ expectedOwnerFingerprint: finding.ownerFingerprint, approval: 'no' }))
      .toThrow('RECOVERY_NOT_AUTHORIZED')

    const active = ports({ quiescent: false })
    expect(() => makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: active.authorization,
      quiescence: active.quiescence,
      newId: () => 'active',
    }).archive({ expectedOwnerFingerprint: finding.ownerFingerprint, approval: 'yes' }))
      .toThrow('RUNTIME_NOT_QUIESCENT')
    expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('held')
  })

  it('binds consumed approval action hashes to the canonical inbox root', () => {
    const firstRoot = tempRoot()
    const secondRoot = tempRoot()
    writer(firstRoot, 'same-owner')
    writer(secondRoot, 'same-owner')
    const firstFinding = inspectMediaInboxWriterLock({ inboxRoot: firstRoot })
    const secondFinding = inspectMediaInboxWriterLock({ inboxRoot: secondRoot })
    if (firstFinding.state !== 'held' || secondFinding.state !== 'held') {
      throw new Error('fixture lock missing')
    }
    expect(firstFinding.ownerFingerprint).toBe(secondFinding.ownerFingerprint)
    const firstPorts = ports()
    const secondPorts = ports()
    makeMediaInboxWriterRecovery({
      inboxRoot: firstRoot,
      authorization: firstPorts.authorization,
      quiescence: firstPorts.quiescence,
      newId: () => 'first-root',
    }).archive({ expectedOwnerFingerprint: firstFinding.ownerFingerprint, approval: 'one' })
    makeMediaInboxWriterRecovery({
      inboxRoot: secondRoot,
      authorization: secondPorts.authorization,
      quiescence: secondPorts.quiescence,
      newId: () => 'second-root',
    }).archive({ expectedOwnerFingerprint: secondFinding.ownerFingerprint, approval: 'two' })

    const firstHash = firstPorts.authorize.mock.calls[0]?.[0].actionHash
    const secondHash = secondPorts.authorize.mock.calls[0]?.[0].actionHash
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/)
    expect(secondHash).toMatch(/^[a-f0-9]{64}$/)
    expect(firstHash).not.toBe(secondHash)
  })

  it('archives exact abandoned ownership, fences the old runtime, and permits restart', async () => {
    const root = tempRoot()
    const oldCalls: string[] = []
    const oldRuntime = writer(root, 'old-owner', oldCalls)
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')
    const safe = ports()
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: safe.authorization,
      quiescence: safe.quiescence,
      newId: () => 'recovery-a',
    })

    expect(recovery.archive({
      expectedOwnerFingerprint: finding.ownerFingerprint,
      approval: { grant: 'operator-approved' },
    })).toEqual({
      recoveryId: 'recovery-a',
      ownerFingerprint: finding.ownerFingerprint,
    })
    expect(recovery.inspect()).toEqual({ state: 'absent', archivedRecoveries: 1 })
    expect(safe.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: 'archive-abandoned-writer-lock',
      actionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
    expect(safe.release).toHaveBeenCalledOnce()

    const restarted = writer(root, 'new-owner')
    await expect(oldRuntime.inbox.ingest({ binding, attachment }))
      .rejects.toEqual(new TelegramAttachmentInboxError('STATE_CORRUPT'))
    expect(oldCalls).toEqual([])
    restarted.close()
  })

  it('refuses changed evidence and corrupt archive content without raw detail', () => {
    const root = tempRoot()
    writer(root)
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')
    const safe = ports()
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: safe.authorization,
      quiescence: safe.quiescence,
      newId: () => 'recovery-b',
    })
    expect(() => recovery.archive({
      expectedOwnerFingerprint: `sha256:${'0'.repeat(64)}`,
      approval: 'yes',
    })).toThrow('WRITER_LOCK_CHANGED')
    recovery.archive({ expectedOwnerFingerprint: finding.ownerFingerprint, approval: 'yes' })
    const archivedOwner = join(
      root,
      '.writer-lock-recovery',
      'recovery-recovery-b',
      'owner.json',
    )
    writeFileSync(archivedOwner, '{corrupt', { mode: 0o600 })
    expect(recovery.inspect()).toEqual({ state: 'corrupt', archivedRecoveries: 0 })
    expect(() => recovery.restore({
      recoveryId: 'recovery-b',
      expectedOwnerFingerprint: finding.ownerFingerprint,
      approval: 'yes',
    })).toThrow('STATE_CORRUPT')
  })

  it('restores exact archived ownership without consuming the audit copy', () => {
    const root = tempRoot()
    const original = writer(root, 'restorable')
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')
    const safe = ports()
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: safe.authorization,
      quiescence: safe.quiescence,
      newId: () => 'restore-a',
    })
    recovery.archive({ expectedOwnerFingerprint: finding.ownerFingerprint, approval: 'archive' })

    expect(recovery.restore({
      recoveryId: 'restore-a',
      expectedOwnerFingerprint: finding.ownerFingerprint,
      approval: 'restore',
    })).toEqual({ ownerFingerprint: finding.ownerFingerprint })
    expect(recovery.inspect()).toMatchObject({
      state: 'held',
      ownerFingerprint: finding.ownerFingerprint,
      archivedRecoveries: 1,
    })
    expect(() => writer(root, 'competitor')).toThrow('WRITER_LOCK_HELD')
    original.close()
    expect(readFileSync(
      join(root, '.writer-lock-recovery', 'recovery-restore-a', 'owner.json'),
      'utf8',
    )).toContain('restorable')
  })

  it('never restores over a new writer', () => {
    const root = tempRoot()
    writer(root, 'old')
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')
    const safe = ports()
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: safe.authorization,
      quiescence: safe.quiescence,
      newId: () => 'occupied',
    })
    recovery.archive({ expectedOwnerFingerprint: finding.ownerFingerprint, approval: 'yes' })
    const current = writer(root, 'current')

    expect(() => recovery.restore({
      recoveryId: 'occupied',
      expectedOwnerFingerprint: finding.ownerFingerprint,
      approval: 'yes',
    })).toThrow('WRITER_LOCK_HELD')
    current.close()
  })

  it('reports quiescence release failure as code-only incomplete recovery', () => {
    const root = tempRoot()
    writer(root, 'release-failure')
    const finding = inspectMediaInboxWriterLock({ inboxRoot: root })
    if (finding.state !== 'held') throw new Error('fixture lock missing')
    const failing = ports({ releaseFails: true })
    const recovery = makeMediaInboxWriterRecovery({
      inboxRoot: root,
      authorization: failing.authorization,
      quiescence: failing.quiescence,
      newId: () => 'release-failure',
    })

    expect(() => recovery.archive({
      expectedOwnerFingerprint: finding.ownerFingerprint,
      approval: 'yes',
    })).toThrow('RECOVERY_INCOMPLETE')
    expect(recovery.inspect()).toEqual({ state: 'absent', archivedRecoveries: 1 })
  })
})

// Self-healing the writer lock at startup.
//
// A lock left by a crashed run took attachments and voice out until somebody
// deleted a file over SSH. The proof that recovery is safe is the recorded pid:
// a fresh process has not opened the inbox, so a dead owner means no writer.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  inspectMediaInboxWriterLock,
  makeDeadWriterQuiescence,
  makeMediaInboxWriterRecovery,
  unattendedRecoveryAuthorization,
} from './telegram-attachment-inbox-recovery.js'
import { makeSingletonTelegramAttachmentInbox } from './telegram-attachment-inbox.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-inbox-selfheal-')))
  roots.push(root)
  return root
}

/** Leaves a held lock behind, exactly as a crashed run does. */
function crashedWriter(root: string, pid: number): void {
  makeSingletonTelegramAttachmentInbox({
    inboxRoot: root,
    allowedChatId: 42,
    maxAttachmentBytes: 1024,
    download: { async download() { throw new Error('unused') } },
    nowIso: () => '2026-08-07T06:00:00.000Z',
    newNonce: () => `writer-${pid}`,
    pid,
  })
}

function recovery(root: string, alive: ReadonlySet<number>) {
  return makeMediaInboxWriterRecovery({
    inboxRoot: root,
    authorization: unattendedRecoveryAuthorization,
    quiescence: makeDeadWriterQuiescence({
      inboxRoot: root,
      isProcessAlive: (pid) => alive.has(pid),
    }),
  })
}

describe('abandoned writer lock', () => {
  it('is archived when the process that held it is gone', () => {
    const root = tempRoot()
    crashedWriter(root, 4242)
    const held = inspectMediaInboxWriterLock({ inboxRoot: root })
    expect(held.state).toBe('held')

    const archived = recovery(root, new Set()).archive({
      expectedOwnerFingerprint: held.state === 'held' ? held.ownerFingerprint : '',
      approval: null,
    })

    expect(archived.recoveryId.length).toBeGreaterThan(0)
    expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('absent')
    // And the next start can take the inbox for itself.
    expect(() => crashedWriter(root, 4243)).not.toThrow()
  })

  it('is left alone while its owner is still running', () => {
    const root = tempRoot()
    crashedWriter(root, 4242)
    const held = inspectMediaInboxWriterLock({ inboxRoot: root })

    expect(() => recovery(root, new Set([4242])).archive({
      expectedOwnerFingerprint: held.state === 'held' ? held.ownerFingerprint : '',
      approval: null,
    })).toThrow('RUNTIME_NOT_QUIESCENT')
    expect(inspectMediaInboxWriterLock({ inboxRoot: root }).state).toBe('held')
  })

  it('refuses when the lock belongs to this very process', () => {
    const root = tempRoot()
    crashedWriter(root, process.pid)
    const held = inspectMediaInboxWriterLock({ inboxRoot: root })

    // Nothing about "dead" can be true of the process asking the question.
    expect(() => recovery(root, new Set()).archive({
      expectedOwnerFingerprint: held.state === 'held' ? held.ownerFingerprint : '',
      approval: null,
    })).toThrow('RUNTIME_NOT_QUIESCENT')
  })

  it('refuses when the lock changed between inspection and recovery', () => {
    const root = tempRoot()
    crashedWriter(root, 4242)
    const stale = inspectMediaInboxWriterLock({ inboxRoot: root })
    const staleFingerprint = stale.state === 'held' ? stale.ownerFingerprint : ''
    recovery(root, new Set()).archive({ expectedOwnerFingerprint: staleFingerprint, approval: null })
    crashedWriter(root, 4243)

    expect(() => recovery(root, new Set()).archive({
      expectedOwnerFingerprint: staleFingerprint,
      approval: null,
    })).toThrow('WRITER_LOCK_CHANGED')
  })
})

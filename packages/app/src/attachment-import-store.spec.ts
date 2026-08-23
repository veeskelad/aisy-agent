import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AttachmentImportAuditEvent,
  AttachmentImportWalV1,
  ProjectFileManifestV1,
} from '@aisy/core'
import {
  AttachmentImportStoreError,
  makeNodeAttachmentImportPersistence,
} from './attachment-import-store.js'

const OPERATION_ID = 'a'.repeat(64)
const SHA = 'b'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-attachment-store-')))
  roots.push(root)
  return root
}

const manifest: ProjectFileManifestV1 = {
  schemaVersion: 1,
  operationId: OPERATION_ID,
  fileId: 'upload-1',
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  source: 'telegram',
  originalName: 'report.bin',
  relativePath: 'imports/upload-1',
  sha256: SHA,
  sizeBytes: 12,
  provenance: 'untrusted',
  provenanceRef: 'telegram:update:1',
  createdAt: '2026-07-27T04:00:00.000Z',
  importedFromFileId: 'upload-1',
  published: false,
}

const wal: AttachmentImportWalV1 = {
  schemaVersion: 1,
  operationId: OPERATION_ID,
  operatorId: manifest.operatorId,
  profileId: manifest.profileId,
  projectId: manifest.projectId,
  projectKind: 'project',
  sessionId: manifest.sessionId,
  fileId: manifest.fileId,
  destination: 'project-file',
  phase: 'PREPARED',
  manifest,
  createdAt: manifest.createdAt,
  updatedAt: manifest.createdAt,
}

const audit: AttachmentImportAuditEvent = {
  eventId: OPERATION_ID,
  kind: 'attachment.imported',
  operationId: OPERATION_ID,
  operatorId: manifest.operatorId,
  profileId: manifest.profileId,
  projectId: manifest.projectId,
  sessionId: manifest.sessionId,
  fileId: manifest.fileId,
  relativePath: manifest.relativePath,
  sha256: manifest.sha256,
  provenance: 'untrusted',
  ts: manifest.createdAt,
}

const inbox = { loadInboxRecord: async () => ({ schemaVersion: 1 }) }

describe('makeNodeAttachmentImportPersistence', () => {
  it('persists WAL, manifest publication and audit idempotently across restart', async () => {
    const stateRoot = tempRoot()
    const first = makeNodeAttachmentImportPersistence({ stateRoot, inbox })

    await first.createWal(wal)
    await first.createWal(wal)
    await first.createPendingManifest(manifest)
    await first.createPendingManifest(manifest)
    const next = { ...wal, phase: 'MANIFEST_PENDING' as const }
    await first.advanceWal({
      operationId: OPERATION_ID,
      expectedPhase: 'PREPARED',
      next,
    })
    await first.publishManifest(OPERATION_ID)
    await first.publishManifest(OPERATION_ID)
    await first.appendAuditOnce(audit)
    await first.appendAuditOnce(audit)

    const restarted = makeNodeAttachmentImportPersistence({ stateRoot, inbox })
    await expect(restarted.loadWal(OPERATION_ID)).resolves.toEqual(next)
    await expect(restarted.loadManifest(OPERATION_ID)).resolves.toEqual({
      ...manifest,
      published: true,
    })
    await restarted.deleteWal(OPERATION_ID)
    await expect(restarted.loadWal(OPERATION_ID)).resolves.toBeNull()
  })

  it('returns only exact idempotent creates and fails closed on conflicts', async () => {
    const stateRoot = tempRoot()
    const store = makeNodeAttachmentImportPersistence({ stateRoot, inbox })
    await store.createWal(wal)

    await expect(store.createWal({
      ...wal,
      updatedAt: '2026-07-27T04:00:01.000Z',
    })).rejects.toEqual(
      new AttachmentImportStoreError('STATE_CONFLICT'),
    )
    await expect(store.advanceWal({
      operationId: OPERATION_ID,
      expectedPhase: 'PUBLISHED',
      next: { ...wal, phase: 'AUDITED' },
    })).rejects.toEqual(new AttachmentImportStoreError('STATE_CONFLICT'))
  })

  it('keeps a durable effect visible when the process fails immediately after it', async () => {
    const stateRoot = tempRoot()
    const store = makeNodeAttachmentImportPersistence({
      stateRoot,
      inbox,
      faultAt: (point) => {
        if (point === 'after-create-wal') throw new Error('simulated process crash')
      },
    })

    await expect(store.createWal(wal)).rejects.toThrow('simulated process crash')
    const restarted = makeNodeAttachmentImportPersistence({ stateRoot, inbox })
    await expect(restarted.loadWal(OPERATION_ID)).resolves.toEqual(wal)
  })

  it('rejects a symlinked control record instead of following it', async () => {
    const stateRoot = tempRoot()
    const outside = join(tempRoot(), 'outside.json')
    writeFileSync(outside, JSON.stringify(wal))
    makeNodeAttachmentImportPersistence({ stateRoot, inbox })
    symlinkSync(outside, join(stateRoot, 'wal', `${OPERATION_ID}.json`))

    const restarted = makeNodeAttachmentImportPersistence({ stateRoot, inbox })
    await expect(restarted.loadWal(OPERATION_ID)).rejects.toEqual(
      new AttachmentImportStoreError('STATE_CORRUPT'),
    )
  })
})

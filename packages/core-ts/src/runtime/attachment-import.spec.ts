import { describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator, type TurnContextLease } from './context-lease.js'
import {
  AttachmentImportError,
  makeAttachmentImportService,
  parseInboxAttachment,
  type AttachmentImportAuditEvent,
  type AttachmentImportFilePort,
  type AttachmentImportPersistencePort,
  type AttachmentImportWalV1,
  type InboxAttachmentV1,
  type ProjectFileManifestV1,
} from './attachment-import.js'

const SHA = 'a'.repeat(64)
const INBOX: InboxAttachmentV1 = {
  schemaVersion: 1,
  fileId: 'upload-1',
  operatorId: 'telegram:42',
  profileId: 'default',
  sessionId: 'session-a',
  source: 'telegram',
  originalName: '../../report.pdf',
  sha256: SHA,
  sizeBytes: 12,
  provenanceRef: 'telegram:update:105',
  receivedAt: '2026-07-27T01:00:00.000Z',
}

type Fault =
  | 'after-create-wal'
  | 'after-stage'
  | 'after-pending-manifest'
  | 'after-MANIFEST_PENDING'
  | 'after-install'
  | 'after-FILE_INSTALLED'
  | 'after-publish'
  | 'after-PUBLISHED'
  | 'after-audit'
  | 'after-AUDITED'
  | 'after-delete-wal'

function harness(options: {
  inbox?: InboxAttachmentV1
  collision?: boolean
  wrongHash?: boolean
  targetUnavailable?: boolean
  maxAttachmentBytes?: number
  fault?: Fault
} = {}) {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: '/Users/operator/projects/project-a',
    generation: 7,
  })
  let wal: AttachmentImportWalV1 | null = null
  let manifest: ProjectFileManifestV1 | null = null
  let fault = options.fault
  let installed: { operationId: string; sha256: string; sizeBytes: number } | null = null
  let staged = false
  const audit = new Map<string, AttachmentImportAuditEvent>()
  const calls: string[] = []
  const crash = (point: Fault): void => {
    if (fault !== point) return
    fault = undefined
    throw new Error(`crash:${point}`)
  }
  const persistence: AttachmentImportPersistencePort = {
    async loadInbox() { calls.push('load-inbox'); return structuredClone(options.inbox ?? INBOX) },
    async loadWal() { calls.push('load-wal'); return structuredClone(wal) },
    async loadManifest() { calls.push('load-manifest'); return structuredClone(manifest) },
    async createWal(value) {
      calls.push('create-wal')
      if (wal !== null && JSON.stringify(wal) !== JSON.stringify(value)) throw new Error('wal conflict')
      wal = structuredClone(value)
      crash('after-create-wal')
    },
    async advanceWal(input) {
      calls.push(`advance:${input.next.phase}`)
      if (wal?.operationId !== input.operationId || wal.phase !== input.expectedPhase) {
        throw new Error('wal phase conflict')
      }
      wal = structuredClone(input.next)
      crash(`after-${input.next.phase}` as Fault)
    },
    async createPendingManifest(value) {
      calls.push('pending-manifest')
      if (manifest !== null && JSON.stringify(manifest) !== JSON.stringify(value)) {
        throw new Error('manifest conflict')
      }
      manifest = structuredClone(value)
      crash('after-pending-manifest')
    },
    async publishManifest(operationId) {
      calls.push('publish')
      if (manifest?.operationId !== operationId) throw new Error('manifest missing')
      manifest = { ...manifest, published: true }
      crash('after-publish')
    },
    async appendAuditOnce(event) {
      calls.push('audit')
      const existing = audit.get(event.eventId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('audit conflict')
      audit.set(event.eventId, structuredClone(event))
      crash('after-audit')
    },
    async deleteWal() {
      calls.push('delete-wal')
      wal = null
      crash('after-delete-wal')
    },
  }
  const files: AttachmentImportFilePort = {
    async verifyInbox() {
      calls.push('verify-inbox')
      return { sha256: options.wrongHash ? 'b'.repeat(64) : SHA, sizeBytes: 12 }
    },
    async stage() {
      calls.push('stage')
      staged = true
      crash('after-stage')
    },
    async install(input) {
      calls.push('install')
      if (options.collision) return 'collision'
      if (installed !== null) {
        return installed.operationId === input.operationId && installed.sha256 === input.sha256 &&
          installed.sizeBytes === input.sizeBytes ? 'already-installed' : 'collision'
      }
      installed = {
        operationId: input.operationId,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
      }
      crash('after-install')
      return 'installed'
    },
    async verifyInstalled(input) {
      calls.push('verify-installed')
      return installed?.sha256 === input.sha256 && installed.sizeBytes === input.sizeBytes
    },
  }
  const service = makeAttachmentImportService({
    leases,
    persistence,
    files,
    assertTargetUsable: () => {
      calls.push('target')
      if (options.targetUnavailable) throw new AttachmentImportError('TARGET_UNAVAILABLE')
    },
    maxAttachmentBytes: options.maxAttachmentBytes ?? 1024 * 1024,
    nowIso: () => '2026-07-27T01:01:00.000Z',
  })
  return {
    audit,
    calls,
    clearFault: () => { fault = undefined },
    inboxPresent: () => true,
    installed: () => installed,
    lease,
    leases,
    manifest: () => manifest,
    service,
    setManifest: (value: ProjectFileManifestV1 | null) => { manifest = structuredClone(value) },
    setWal: (value: AttachmentImportWalV1 | null) => { wal = structuredClone(value) },
    staged: () => staged,
    wal: () => wal,
  }
}

describe('attachment import state machine', () => {
  it('strictly parses exact inbox records for external persistence adapters', () => {
    expect(parseInboxAttachment(INBOX)).toEqual(INBOX)
    expect(parseInboxAttachment({ ...INBOX, trusted: true })).toBeNull()
    expect(parseInboxAttachment({ ...INBOX, sizeBytes: -1 })).toBeNull()
  })

  it('publishes a code-owned destination and untrusted manifest without using originalName as a path', async () => {
    const h = harness()

    const result = await h.service.importAttachment(h.lease, INBOX.fileId, 'knowledge')

    expect(result).toMatchObject({
      projectId: h.lease.projectId,
      sessionId: h.lease.sessionId,
      originalName: '../../report.pdf',
      relativePath: 'knowledge/imports/upload-1',
      provenance: 'untrusted',
      published: true,
    })
    expect(result.operationId).toMatch(/^[a-f0-9]{64}$/)
    expect(h.manifest()?.published).toBe(true)
    expect(h.wal()).toBeNull()
    expect(h.audit.size).toBe(1)
    expect(h.inboxPresent()).toBe(true)
  })

  it('recovers idempotently after every durable boundary and keeps the inbox', async () => {
    const faults: Fault[] = [
      'after-create-wal', 'after-stage', 'after-pending-manifest',
      'after-MANIFEST_PENDING', 'after-install', 'after-FILE_INSTALLED',
      'after-publish', 'after-PUBLISHED', 'after-audit', 'after-AUDITED',
      'after-delete-wal',
    ]
    for (const fault of faults) {
      const h = harness({ fault })
      await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
        .rejects.toThrow(`crash:${fault}`)
      h.clearFault()
      const recovered = await h.service.importAttachment(h.lease, INBOX.fileId, 'project-file')
      expect(recovered).toMatchObject({ relativePath: 'imports/upload-1', published: true })
      expect(h.manifest()?.published).toBe(true)
      expect(h.wal()).toBeNull()
      expect(h.audit.size).toBe(1)
      expect(h.inboxPresent()).toBe(true)
    }
  })

  it('serializes concurrent retries into one manifest and one audit event', async () => {
    const h = harness()

    const [first, second] = await Promise.all([
      h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'),
      h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'),
    ])

    expect(second).toEqual(first)
    expect(h.audit.size).toBe(1)
    expect(h.calls.filter(call => call === 'publish')).toHaveLength(1)
  })

  it('rejects foreign session before attachment file I/O', async () => {
    const h = harness({ inbox: { ...INBOX, sessionId: 'session-b' } })

    await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'BINDING_MISMATCH',
      }))
    expect(h.calls).toEqual(['target', 'load-inbox'])
    expect(h.staged()).toBe(false)
  })

  it('rejects archived target before inbox or file I/O', async () => {
    const h = harness({ targetUnavailable: true })

    await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'TARGET_UNAVAILABLE',
      }))
    expect(h.calls).toEqual(['target'])
  })

  it('rejects hash mismatch and collision without publication', async () => {
    const mismatch = harness({ wrongHash: true })
    await expect(mismatch.service.importAttachment(mismatch.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'HASH_MISMATCH',
      }))
    expect(mismatch.manifest()).toBeNull()

    const collision = harness({ collision: true })
    await expect(collision.service.importAttachment(collision.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'COLLISION',
      }))
    expect(collision.manifest()?.published).toBe(false)
    expect(collision.audit.size).toBe(0)
  })

  it('enforces the composition-owned size cap before attachment file I/O', async () => {
    const h = harness({ maxAttachmentBytes: 11 })

    await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'LIMIT_EXCEEDED',
      }))
    expect(h.calls).toEqual(['target', 'load-inbox'])
  })

  it('does not trust an AUDITED WAL without the published manifest', async () => {
    const h = harness()
    const completed = await h.service.importAttachment(h.lease, INBOX.fileId, 'project-file')
    h.setWal({
      schemaVersion: 1,
      operationId: completed.operationId,
      operatorId: completed.operatorId,
      profileId: completed.profileId,
      projectId: completed.projectId,
      projectKind: 'project',
      sessionId: completed.sessionId,
      fileId: completed.fileId,
      destination: 'project-file',
      phase: 'AUDITED',
      manifest: { ...completed, published: false },
      createdAt: completed.createdAt,
      updatedAt: completed.createdAt,
    })
    h.setManifest(null)

    await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'WAL_CONFLICT',
      }))
    expect(h.wal()?.phase).toBe('AUDITED')
  })

  it('rejects stale lease before persistence and file I/O', async () => {
    const h = harness()
    await h.leases.quiesceAndClose(h.lease)

    await expect(h.service.importAttachment(h.lease, INBOX.fileId, 'project-file'))
      .rejects.toMatchObject({ code: 'STALE_CONTEXT' })
    expect(h.calls).toEqual([])
  })

  it('rejects Workspace import before any I/O', async () => {
    const h = harness()
    const workspace = Object.freeze<TurnContextLease>({
      ...h.lease,
      projectId: 'workspace-a',
      projectKind: 'workspace',
      root: '/Users/operator/workspace',
      leaseId: 'workspace-lease',
    })

    await expect(h.service.importAttachment(workspace, INBOX.fileId, 'project-file'))
      .rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'TARGET_UNAVAILABLE',
      }))
    expect(h.calls).toEqual([])
  })
})

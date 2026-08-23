import { createHash } from 'node:crypto'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const INBOX_KEYS = new Set([
  'schemaVersion', 'fileId', 'operatorId', 'profileId', 'sessionId', 'source',
  'originalName', 'sha256', 'sizeBytes', 'provenanceRef', 'receivedAt',
])
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'operationId', 'fileId', 'operatorId', 'profileId', 'projectId',
  'sessionId', 'source', 'originalName', 'relativePath', 'sha256', 'sizeBytes',
  'provenance', 'provenanceRef', 'createdAt', 'importedFromFileId', 'published',
])
const WAL_KEYS = new Set([
  'schemaVersion', 'operationId', 'operatorId', 'profileId', 'projectId',
  'projectKind', 'sessionId', 'fileId', 'destination', 'phase', 'manifest',
  'createdAt', 'updatedAt',
])

export type AttachmentSource = 'telegram' | 'local' | 'generated' | 'import'
export type AttachmentDestination = 'project-file' | 'knowledge'
export type AttachmentImportPhase =
  | 'PREPARED'
  | 'MANIFEST_PENDING'
  | 'FILE_INSTALLED'
  | 'PUBLISHED'
  | 'AUDITED'

export interface InboxAttachmentV1 {
  schemaVersion: 1
  fileId: string
  operatorId: string
  profileId: string
  sessionId: string
  source: AttachmentSource
  originalName: string
  sha256: string
  sizeBytes: number
  provenanceRef: string
  receivedAt: string
}

export interface ProjectFileManifestV1 {
  schemaVersion: 1
  operationId: string
  fileId: string
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
  source: AttachmentSource
  originalName: string
  relativePath: string
  sha256: string
  sizeBytes: number
  provenance: 'untrusted'
  provenanceRef: string
  createdAt: string
  importedFromFileId: string
  published: boolean
}

export interface AttachmentImportWalV1 {
  schemaVersion: 1
  operationId: string
  operatorId: string
  profileId: string
  projectId: string
  projectKind: 'project'
  sessionId: string
  fileId: string
  destination: AttachmentDestination
  phase: AttachmentImportPhase
  manifest: ProjectFileManifestV1
  createdAt: string
  updatedAt: string
}

export interface AttachmentImportAuditEvent {
  eventId: string
  kind: 'attachment.imported'
  operationId: string
  operatorId: string
  profileId: string
  projectId: string
  sessionId: string
  fileId: string
  relativePath: string
  sha256: string
  provenance: 'untrusted'
  ts: string
}

export interface AttachmentImportPersistencePort {
  loadInbox(fileId: string): Promise<unknown | null>
  loadWal(operationId: string): Promise<unknown | null>
  loadManifest(operationId: string): Promise<unknown | null>
  createWal(wal: AttachmentImportWalV1): Promise<void>
  advanceWal(input: {
    operationId: string
    expectedPhase: AttachmentImportPhase
    next: AttachmentImportWalV1
  }): Promise<void>
  createPendingManifest(manifest: ProjectFileManifestV1): Promise<void>
  publishManifest(operationId: string): Promise<void>
  appendAuditOnce(event: AttachmentImportAuditEvent): Promise<void>
  deleteWal(operationId: string): Promise<void>
}

export interface AttachmentImportFilePort {
  verifyInbox(inbox: InboxAttachmentV1): Promise<{ sha256: string; sizeBytes: number }>
  stage(input: {
    operationId: string
    inbox: InboxAttachmentV1
    relativePath: string
  }): Promise<void>
  install(input: {
    operationId: string
    lease: TurnContextLease
    relativePath: string
    sha256: string
    sizeBytes: number
  }): Promise<'installed' | 'already-installed' | 'collision'>
  verifyInstalled(input: {
    lease: TurnContextLease
    relativePath: string
    sha256: string
    sizeBytes: number
  }): Promise<boolean>
}

export interface AttachmentImportService {
  importAttachment(
    lease: TurnContextLease,
    fileId: string,
    destination: AttachmentDestination,
  ): Promise<ProjectFileManifestV1>
}

export class AttachmentImportError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'TARGET_UNAVAILABLE'
    | 'INBOX_NOT_FOUND'
    | 'INBOX_INVALID'
    | 'BINDING_MISMATCH'
    | 'WAL_CONFLICT'
    | 'COLLISION'
    | 'HASH_MISMATCH'
    | 'LIMIT_EXCEEDED') {
    super(code)
    this.name = 'AttachmentImportError'
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length === keys.size && Object.keys(value).every(key => keys.has(key))
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') &&
    ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
}

function validInbox(value: unknown): value is InboxAttachmentV1 {
  if (!object(value) || !exactKeys(value, INBOX_KEYS)) return false
  return value.schemaVersion === 1 && typeof value.fileId === 'string' && ID.test(value.fileId) &&
    boundedText(value.operatorId, 1024) && boundedText(value.profileId, 1024) &&
    boundedText(value.sessionId, 1024) &&
    ['telegram', 'local', 'generated', 'import'].includes(String(value.source)) &&
    boundedText(value.originalName, 1024) && typeof value.sha256 === 'string' &&
    HASH.test(value.sha256) && Number.isSafeInteger(value.sizeBytes) &&
    (value.sizeBytes as number) >= 0 && boundedText(value.provenanceRef, 4096) &&
    validIso(value.receivedAt)
}

/** Strict parser for code-owned inbox records at the Telegram/file ingress boundary. */
export function parseInboxAttachment(value: unknown): InboxAttachmentV1 | null {
  return validInbox(value) ? structuredClone(value) : null
}

function validManifest(value: unknown): value is ProjectFileManifestV1 {
  if (!object(value) || !exactKeys(value, MANIFEST_KEYS)) return false
  return value.schemaVersion === 1 && typeof value.operationId === 'string' &&
    HASH.test(value.operationId) && typeof value.fileId === 'string' && ID.test(value.fileId) &&
    boundedText(value.operatorId, 1024) && boundedText(value.profileId, 1024) &&
    boundedText(value.projectId, 1024) && boundedText(value.sessionId, 1024) &&
    ['telegram', 'local', 'generated', 'import'].includes(String(value.source)) &&
    boundedText(value.originalName, 1024) && boundedText(value.relativePath, 1024) &&
    typeof value.sha256 === 'string' && HASH.test(value.sha256) &&
    Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0 &&
    value.provenance === 'untrusted' && boundedText(value.provenanceRef, 4096) &&
    validIso(value.createdAt) && value.importedFromFileId === value.fileId &&
    typeof value.published === 'boolean'
}

/** Strict parser used by manifest-aware read adapters outside the core state machine. */
export function parseProjectFileManifest(value: unknown): ProjectFileManifestV1 | null {
  return validManifest(value) ? structuredClone(value) : null
}

/** Strict parser for durable WAL adapters that must reject torn or widened state. */
export function parseAttachmentImportWal(value: unknown): AttachmentImportWalV1 | null {
  return validWal(value) ? structuredClone(value) : null
}

function validWal(value: unknown): value is AttachmentImportWalV1 {
  if (!object(value) || !exactKeys(value, WAL_KEYS) || !validManifest(value.manifest)) return false
  return value.schemaVersion === 1 && typeof value.operationId === 'string' &&
    HASH.test(value.operationId) && value.operationId === value.manifest.operationId &&
    boundedText(value.operatorId, 1024) && boundedText(value.profileId, 1024) &&
    boundedText(value.projectId, 1024) && value.projectKind === 'project' &&
    boundedText(value.sessionId, 1024) && typeof value.fileId === 'string' &&
    ID.test(value.fileId) && value.fileId === value.manifest.fileId &&
    ['project-file', 'knowledge'].includes(String(value.destination)) &&
    ['PREPARED', 'MANIFEST_PENDING', 'FILE_INSTALLED', 'PUBLISHED', 'AUDITED']
      .includes(String(value.phase)) && validIso(value.createdAt) && validIso(value.updatedAt) &&
    value.createdAt === value.manifest.createdAt && value.manifest.published === false &&
    value.operatorId === value.manifest.operatorId && value.profileId === value.manifest.profileId &&
    value.projectId === value.manifest.projectId && value.sessionId === value.manifest.sessionId
}

function bindingMatches(wal: AttachmentImportWalV1, lease: TurnContextLease): boolean {
  return wal.operatorId === lease.operatorId && wal.profileId === lease.profileId &&
    wal.projectId === lease.projectId && wal.projectKind === lease.projectKind &&
    wal.sessionId === lease.sessionId
}

function relativePath(fileId: string, destination: AttachmentDestination): string {
  return destination === 'knowledge'
    ? `knowledge/imports/${fileId}`
    : `imports/${fileId}`
}

function operationId(
  lease: TurnContextLease,
  inbox: InboxAttachmentV1,
  destination: AttachmentDestination,
  path: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    'aisy.attachment-import.v1', lease.operatorId, lease.profileId, lease.projectId,
    lease.sessionId, inbox.fileId, inbox.sha256, destination, path,
  ])).digest('hex')
}

function sameManifestIdentity(
  manifest: ProjectFileManifestV1,
  lease: TurnContextLease,
  inbox: InboxAttachmentV1,
  id: string,
  path: string,
): boolean {
  return manifest.operationId === id && manifest.fileId === inbox.fileId &&
    manifest.operatorId === lease.operatorId && manifest.profileId === lease.profileId &&
    manifest.projectId === lease.projectId && manifest.sessionId === lease.sessionId &&
    manifest.source === inbox.source && manifest.originalName === inbox.originalName &&
    manifest.relativePath === path && manifest.sha256 === inbox.sha256 &&
    manifest.sizeBytes === inbox.sizeBytes && manifest.provenance === 'untrusted' &&
    manifest.provenanceRef === inbox.provenanceRef &&
    manifest.importedFromFileId === inbox.fileId
}

export function makeAttachmentImportService(deps: {
  leases: ContextLeaseCoordinator
  persistence: AttachmentImportPersistencePort
  files: AttachmentImportFilePort
  assertTargetUsable(lease: TurnContextLease): Promise<void> | void
  maxAttachmentBytes: number
  nowIso(): string
}): AttachmentImportService {
  if (!Number.isSafeInteger(deps.maxAttachmentBytes) || deps.maxAttachmentBytes < 1) {
    throw new AttachmentImportError('INVALID_REQUEST')
  }
  const tails = new Map<string, Promise<void>>()
  const serialize = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    tails.set(key, tail)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

  const advance = async (
    wal: AttachmentImportWalV1,
    phase: AttachmentImportPhase,
  ): Promise<AttachmentImportWalV1> => {
    const next: AttachmentImportWalV1 = {
      ...wal,
      phase,
      updatedAt: deps.nowIso(),
    }
    if (!validWal(next)) throw new AttachmentImportError('WAL_CONFLICT')
    await deps.persistence.advanceWal({
      operationId: wal.operationId,
      expectedPhase: wal.phase,
      next,
    })
    return next
  }

  return Object.freeze<AttachmentImportService>({
    async importAttachment(lease, fileId, destination) {
      if (lease.projectKind !== 'project' || !ID.test(fileId) ||
        (destination !== 'project-file' && destination !== 'knowledge')) {
        throw new AttachmentImportError(
          lease.projectKind !== 'project' ? 'TARGET_UNAVAILABLE' : 'INVALID_REQUEST',
        )
      }
      const leaseOperation = deps.leases.reserveOperation(lease)
      try {
        leaseOperation.beginIo()
        const scope = `${lease.operatorId}\0${lease.profileId}\0${lease.projectId}`
        return await serialize(scope, async () => {
          await deps.assertTargetUsable(lease)
          const rawInbox = await deps.persistence.loadInbox(fileId)
          if (rawInbox === null) throw new AttachmentImportError('INBOX_NOT_FOUND')
          if (!validInbox(rawInbox)) throw new AttachmentImportError('INBOX_INVALID')
          const inbox = { ...rawInbox }
          if (inbox.operatorId !== lease.operatorId || inbox.profileId !== lease.profileId ||
            inbox.sessionId !== lease.sessionId) {
            throw new AttachmentImportError('BINDING_MISMATCH')
          }
          if (inbox.sizeBytes > deps.maxAttachmentBytes) {
            throw new AttachmentImportError('LIMIT_EXCEEDED')
          }
          const verifiedInbox = await deps.files.verifyInbox(inbox)
          if (verifiedInbox.sha256 !== inbox.sha256 ||
            verifiedInbox.sizeBytes !== inbox.sizeBytes) {
            throw new AttachmentImportError('HASH_MISMATCH')
          }
          const destinationPath = relativePath(fileId, destination)
          const id = operationId(lease, inbox, destination, destinationPath)
          const createdAt = deps.nowIso()
          const manifest: ProjectFileManifestV1 = {
            schemaVersion: 1,
            operationId: id,
            fileId,
            operatorId: lease.operatorId,
            profileId: lease.profileId,
            projectId: lease.projectId,
            sessionId: lease.sessionId,
            source: inbox.source,
            originalName: inbox.originalName,
            relativePath: destinationPath,
            sha256: inbox.sha256,
            sizeBytes: inbox.sizeBytes,
            provenance: 'untrusted',
            provenanceRef: inbox.provenanceRef,
            createdAt,
            importedFromFileId: fileId,
            published: false,
          }
          let wal: AttachmentImportWalV1 = {
            schemaVersion: 1,
            operationId: id,
            operatorId: lease.operatorId,
            profileId: lease.profileId,
            projectId: lease.projectId,
            projectKind: 'project',
            sessionId: lease.sessionId,
            fileId,
            destination,
            phase: 'PREPARED',
            manifest,
            createdAt,
            updatedAt: createdAt,
          }
          const existing = await deps.persistence.loadWal(id)
          if (existing === null) {
            const completed = await deps.persistence.loadManifest(id)
            if (completed !== null) {
              if (!validManifest(completed) || completed.published !== true ||
                !sameManifestIdentity(completed, lease, inbox, id, destinationPath) ||
                !await deps.files.verifyInstalled({
                  lease,
                  relativePath: destinationPath,
                  sha256: inbox.sha256,
                  sizeBytes: inbox.sizeBytes,
                })) throw new AttachmentImportError('WAL_CONFLICT')
              return structuredClone(completed)
            }
            await deps.persistence.createWal(wal)
          } else {
            if (!validWal(existing) || !bindingMatches(existing, lease) ||
              existing.destination !== destination || existing.fileId !== fileId ||
              !sameManifestIdentity(existing.manifest, lease, inbox, id, destinationPath)) {
              throw new AttachmentImportError('WAL_CONFLICT')
            }
            wal = structuredClone(existing)
          }

          while (true) {
            if (wal.phase === 'PREPARED') {
              await deps.files.stage({ operationId: id, inbox, relativePath: destinationPath })
              await deps.persistence.createPendingManifest(wal.manifest)
              wal = await advance(wal, 'MANIFEST_PENDING')
              continue
            }
            if (wal.phase === 'MANIFEST_PENDING') {
              const installed = await deps.files.install({
                operationId: id,
                lease,
                relativePath: destinationPath,
                sha256: inbox.sha256,
                sizeBytes: inbox.sizeBytes,
              })
              if (installed === 'collision') throw new AttachmentImportError('COLLISION')
              if (!await deps.files.verifyInstalled({
                lease,
                relativePath: destinationPath,
                sha256: inbox.sha256,
                sizeBytes: inbox.sizeBytes,
              })) throw new AttachmentImportError('HASH_MISMATCH')
              wal = await advance(wal, 'FILE_INSTALLED')
              continue
            }
            if (wal.phase === 'FILE_INSTALLED') {
              await deps.persistence.publishManifest(id)
              wal = await advance(wal, 'PUBLISHED')
              continue
            }
            if (wal.phase === 'PUBLISHED') {
              await deps.persistence.appendAuditOnce({
                eventId: id,
                kind: 'attachment.imported',
                operationId: id,
                operatorId: lease.operatorId,
                profileId: lease.profileId,
                projectId: lease.projectId,
                sessionId: lease.sessionId,
                fileId,
                relativePath: destinationPath,
                sha256: inbox.sha256,
                provenance: 'untrusted',
                ts: wal.manifest.createdAt,
              })
              wal = await advance(wal, 'AUDITED')
              continue
            }
            const published = await deps.persistence.loadManifest(id)
            if (!validManifest(published) || published.published !== true ||
              !sameManifestIdentity(published, lease, inbox, id, destinationPath) ||
              !await deps.files.verifyInstalled({
                lease,
                relativePath: destinationPath,
                sha256: inbox.sha256,
                sizeBytes: inbox.sizeBytes,
              })) throw new AttachmentImportError('WAL_CONFLICT')
            await deps.persistence.deleteWal(id)
            return structuredClone(published)
          }
        })
      } finally {
        leaseOperation.complete()
      }
    },
  })
}

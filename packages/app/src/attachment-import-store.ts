import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  parseAttachmentImportWal,
  parseProjectFileManifest,
  type AttachmentImportAuditEvent,
  type AttachmentImportPersistencePort,
  type AttachmentImportPhase,
  type AttachmentImportWalV1,
  type ProjectFileManifestV1,
  type TurnContextLease,
} from '@aisy/core'
import type { AttachmentInboxRecordReader } from './attachment-import-sidecar.js'

const HASH = /^[a-f0-9]{64}$/
const MAX_STATE_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_FILES = 50_000
const MANIFEST_TEMP = /^[a-f0-9]{64}\.json\.(?:tmp|create)-\d+-[a-f0-9-]{36}$/

export type AttachmentImportStoreFault =
  | 'after-create-wal'
  | 'after-advance-wal'
  | 'after-pending-manifest'
  | 'after-publish-manifest'
  | 'after-audit'
  | 'after-delete-wal'

export class AttachmentImportStoreError extends Error {
  constructor(public readonly code: 'INVALID_ID' | 'STATE_CONFLICT' | 'STATE_CORRUPT') {
    super(code)
    this.name = 'AttachmentImportStoreError'
  }
}

export interface PublishedAttachmentManifestReader {
  findPublishedManifest(
    lease: TurnContextLease,
    relativePath: string,
  ): Promise<ProjectFileManifestV1 | null>
  listPublishedManifests(lease: TurnContextLease): Promise<ProjectFileManifestV1[]>
}

export type NodeAttachmentImportPersistence =
  AttachmentImportPersistencePort & PublishedAttachmentManifestReader

function safeHash(value: string): void {
  if (!HASH.test(value)) throw new AttachmentImportStoreError('INVALID_ID')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function ensureDirectory(path: string): void {
  const canonical = resolve(path)
  let ancestor = canonical
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new AttachmentImportStoreError('STATE_CORRUPT')
    ancestor = parent
  }
  const ancestorInfo = lstatSync(ancestor)
  if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink() ||
    realpathSync(ancestor) !== ancestor) {
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  }
  mkdirSync(canonical, { recursive: true, mode: 0o700 })
  const finalInfo = lstatSync(canonical)
  if (!finalInfo.isDirectory() || finalInfo.isSymbolicLink() ||
    realpathSync(canonical) !== canonical) {
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  }
  chmodSync(canonical, 0o700)
}

function readBoundedJson(path: string): unknown {
  const noFollow = constants.O_NOFOLLOW
  if (typeof noFollow !== 'number') {
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  }
  const flags = constants.O_RDONLY | noFollow
  let descriptor: number
  try {
    descriptor = openSync(path, flags)
  } catch {
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_STATE_BYTES) {
      throw new AttachmentImportStoreError('STATE_CORRUPT')
    }
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof AttachmentImportStoreError) throw error
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  } finally {
    closeSync(descriptor)
  }
}

function encoded(value: unknown): string {
  const content = JSON.stringify(value, null, 2) + '\n'
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    throw new AttachmentImportStoreError('STATE_CORRUPT')
  }
  return content
}

function saveAtomic(path: string, value: unknown): void {
  const directory = dirname(path)
  ensureDirectory(directory)
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, encoded(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, path)
    syncPath(directory)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function createOnce(path: string, value: unknown): 'created' | 'exists' {
  const directory = dirname(path)
  ensureDirectory(directory)
  const temporary = `${path}.create-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, encoded(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    try {
      linkSync(temporary, path)
      syncPath(directory)
      return 'created'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      throw error
    }
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary)
      syncPath(directory)
    }
  }
}

function createIdempotent(path: string, value: unknown): void {
  if (createOnce(path, value) === 'created') return
  if (!isDeepStrictEqual(readBoundedJson(path), value)) {
    throw new AttachmentImportStoreError('STATE_CONFLICT')
  }
}

export function makeNodeAttachmentImportPersistence(input: {
  stateRoot: string
  inbox: AttachmentInboxRecordReader
  faultAt?: (point: AttachmentImportStoreFault) => void
}): NodeAttachmentImportPersistence {
  const root = resolve(input.stateRoot)
  const walRoot = join(root, 'wal')
  const manifestRoot = join(root, 'manifests')
  const auditRoot = join(root, 'audit')
  for (const directory of [root, walRoot, manifestRoot, auditRoot]) ensureDirectory(directory)

  const walPath = (operationId: string): string => {
    safeHash(operationId)
    return join(walRoot, `${operationId}.json`)
  }
  const manifestPath = (operationId: string): string => {
    safeHash(operationId)
    return join(manifestRoot, `${operationId}.json`)
  }
  const auditPath = (eventId: string): string => {
    safeHash(eventId)
    return join(auditRoot, `${eventId}.json`)
  }
  const load = (path: string): unknown | null => {
    if (!entryExists(path)) return null
    return readBoundedJson(path)
  }
  const publishedFor = (lease: TurnContextLease): ProjectFileManifestV1[] => {
    const entries = readdirSync(manifestRoot)
    if (entries.length > MAX_MANIFEST_FILES) {
      throw new AttachmentImportStoreError('STATE_CORRUPT')
    }
    const manifests: ProjectFileManifestV1[] = []
    for (const entry of entries.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) {
        if (MANIFEST_TEMP.test(entry)) continue
        throw new AttachmentImportStoreError('STATE_CORRUPT')
      }
      const manifest = parseProjectFileManifest(readBoundedJson(join(manifestRoot, entry)))
      if (manifest === null || entry !== `${manifest.operationId}.json`) {
        throw new AttachmentImportStoreError('STATE_CORRUPT')
      }
      if (manifest.published && manifest.operatorId === lease.operatorId &&
        manifest.profileId === lease.profileId && manifest.projectId === lease.projectId) {
        manifests.push(manifest)
      }
    }
    return manifests
  }

  return Object.freeze<NodeAttachmentImportPersistence>({
    loadInbox(fileId) {
      return input.inbox.loadInboxRecord(fileId)
    },

    async loadWal(operationId) {
      return load(walPath(operationId))
    },

    async loadManifest(operationId) {
      return load(manifestPath(operationId))
    },

    async createWal(wal: AttachmentImportWalV1) {
      const validated = parseAttachmentImportWal(wal)
      if (validated === null) throw new AttachmentImportStoreError('STATE_CORRUPT')
      createIdempotent(walPath(validated.operationId), validated)
      input.faultAt?.('after-create-wal')
    },

    async advanceWal({ operationId, expectedPhase, next }: {
      operationId: string
      expectedPhase: AttachmentImportPhase
      next: AttachmentImportWalV1
    }) {
      const path = walPath(operationId)
      const current = parseAttachmentImportWal(load(path))
      const validatedNext = parseAttachmentImportWal(next)
      if (current === null || validatedNext === null || current.operationId !== operationId ||
        current.phase !== expectedPhase || validatedNext.operationId !== operationId) {
        throw new AttachmentImportStoreError('STATE_CONFLICT')
      }
      saveAtomic(path, validatedNext)
      input.faultAt?.('after-advance-wal')
    },

    async createPendingManifest(manifest: ProjectFileManifestV1) {
      const validated = parseProjectFileManifest(manifest)
      if (validated === null || validated.published) {
        throw new AttachmentImportStoreError('STATE_CORRUPT')
      }
      createIdempotent(manifestPath(validated.operationId), validated)
      input.faultAt?.('after-pending-manifest')
    },

    async publishManifest(operationId: string) {
      const path = manifestPath(operationId)
      const manifest = parseProjectFileManifest(load(path))
      if (manifest === null || manifest.operationId !== operationId) {
        throw new AttachmentImportStoreError('STATE_CONFLICT')
      }
      if (!manifest.published) saveAtomic(path, { ...manifest, published: true })
      input.faultAt?.('after-publish-manifest')
    },

    async appendAuditOnce(event: AttachmentImportAuditEvent) {
      createIdempotent(auditPath(event.eventId), event)
      input.faultAt?.('after-audit')
    },

    async deleteWal(operationId: string) {
      const path = walPath(operationId)
      if (entryExists(path)) {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
          throw new AttachmentImportStoreError('STATE_CORRUPT')
        }
        unlinkSync(path)
        syncPath(walRoot)
      }
      input.faultAt?.('after-delete-wal')
    },

    async findPublishedManifest(lease, relativePath) {
      const matches = publishedFor(lease)
        .filter(manifest => manifest.relativePath === relativePath)
      if (matches.length === 0) return null
      const first = matches[0]!
      if (matches.some(manifest => manifest.sha256 !== first.sha256 ||
        manifest.sizeBytes !== first.sizeBytes || manifest.fileId !== first.fileId)) {
        throw new AttachmentImportStoreError('STATE_CONFLICT')
      }
      return structuredClone(first)
    },

    async listPublishedManifests(lease) {
      return publishedFor(lease).map(manifest => structuredClone(manifest))
    },
  })
}

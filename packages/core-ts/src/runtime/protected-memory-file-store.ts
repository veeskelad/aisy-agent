import { createHash, randomUUID } from 'node:crypto'
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
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { ProtectedMemoryDeletionFilePort } from './protected-memory-deletion.js'
import type { ProtectedMemoryPublicationFilePort } from './protected-memory-publication.js'

const HASH = /^[a-f0-9]{64}$/
const SOURCE_PATH = /^memory\/facts\/[a-f0-9]{64}\.md$/
const MAX_FACT_BYTES = 1_048_576

export type ProtectedMemoryFileFault =
  | 'after-stage-link'
  | 'after-stage'
  | 'after-link'
  | 'after-unlink-stage'
  | 'after-remove-target'

export class ProtectedMemoryFileStoreError extends Error {
  constructor(public readonly code:
    | 'INVALID_REQUEST'
    | 'UNSAFE_PATH'
    | 'STATE_CONFLICT'
    | 'CROSS_DEVICE',
  ) {
    super(code)
    this.name = 'ProtectedMemoryFileStoreError'
  }
}

export interface ProtectedMemoryFileStore
  extends ProtectedMemoryPublicationFilePort, ProtectedMemoryDeletionFilePort {}

interface InspectedFile {
  contentHash: string
  dev: number
  ino: number
  nlink: number
  sizeBytes: number
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  }
  return constants.O_NOFOLLOW
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | noFollow())
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertCanonicalDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) {
    throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  }
}

function ensurePrivateDirectory(path: string): void {
  const canonical = resolve(path)
  let ancestor = canonical
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
    ancestor = parent
  }
  assertCanonicalDirectory(ancestor)
  const suffix = relative(ancestor, canonical)
  if (suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  }
  let current = ancestor
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    assertCanonicalDirectory(current)
    chmodSync(current, 0o700)
  }
  assertCanonicalDirectory(canonical)
  chmodSync(canonical, 0o700)
}

function inspectFile(path: string, allowedLinks: ReadonlySet<number>): InspectedFile {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow())
  } catch {
    throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || !allowedLinks.has(info.nlink) || info.size > MAX_FACT_BYTES ||
      (info.mode & 0o077) !== 0) {
      throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
    }
    const content = readFileSync(descriptor)
    if (content.byteLength !== info.size) {
      throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
    }
    return {
      contentHash: sha256(content),
      dev: info.dev,
      ino: info.ino,
      nlink: info.nlink,
      sizeBytes: info.size,
    }
  } finally {
    closeSync(descriptor)
  }
}

function matches(file: InspectedFile, contentHash: string, sizeBytes: number): boolean {
  return file.contentHash === contentHash && file.sizeBytes === sizeBytes
}

function assertRequest(input: {
  operationId?: string
  sourcePath: string
  contentHash: string
  sizeBytes: number
}): void {
  if ((input.operationId !== undefined && !HASH.test(input.operationId)) ||
    !SOURCE_PATH.test(input.sourcePath) || !HASH.test(input.contentHash) ||
    !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 ||
    input.sizeBytes > MAX_FACT_BYTES) {
    throw new ProtectedMemoryFileStoreError('INVALID_REQUEST')
  }
}

export function makeProtectedMemoryFileStore(input: {
  contentRoot: string
  stagingRoot: string
  faultAt?: (point: ProtectedMemoryFileFault) => void
}): ProtectedMemoryFileStore {
  const contentRoot = resolve(input.contentRoot)
  if (!existsSync(contentRoot)) throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  assertCanonicalDirectory(contentRoot)
  const targetRoot = join(contentRoot, 'memory', 'facts')
  const stagingRoot = resolve(input.stagingRoot)
  if (targetRoot === stagingRoot) throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
  ensurePrivateDirectory(targetRoot)
  ensurePrivateDirectory(stagingRoot)
  if (statSync(targetRoot).dev !== statSync(stagingRoot).dev) {
    throw new ProtectedMemoryFileStoreError('CROSS_DEVICE')
  }

  const stagePath = (operationId: string): string => join(stagingRoot, `${operationId}.fact`)
  const stageTemporaryPrefix = (operationId: string): string => `${operationId}.tmp-`
  const temporaryEntries = (operationId: string): string[] => readdirSync(stagingRoot)
    .filter((entry) => entry.startsWith(stageTemporaryPrefix(operationId)))
    .sort()
  const cleanupTemporaryEntries = (
    operationId: string,
  ): boolean => {
    let changed = false
    for (const entry of temporaryEntries(operationId)) {
      const path = join(stagingRoot, entry)
      const info = inspectFile(path, new Set([1, 2]))
      if (info.nlink !== 1) throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
      unlinkSync(path)
      changed = true
    }
    if (changed) syncPath(stagingRoot)
    return changed
  }
  const recoverStaged = (
    operationId: string,
    contentHash: string,
    sizeBytes: number,
  ): boolean => {
    const path = stagePath(operationId)
    if (!exists(path)) {
      cleanupTemporaryEntries(operationId)
      return false
    }
    let current = inspectFile(path, new Set([1, 2]))
    if (current.nlink === 2) {
      const linkedTemporary = temporaryEntries(operationId).find((entry) => {
        const candidate = inspectFile(join(stagingRoot, entry), new Set([1, 2]))
        return candidate.dev === current.dev && candidate.ino === current.ino
      })
      if (!linkedTemporary) throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
      unlinkSync(join(stagingRoot, linkedTemporary))
      syncPath(stagingRoot)
      current = inspectFile(path, new Set([1]))
    }
    cleanupTemporaryEntries(operationId)
    if (!matches(current, contentHash, sizeBytes)) {
      throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
    }
    return true
  }
  const targetPath = (sourcePath: string): string => {
    const target = resolve(contentRoot, sourcePath)
    if (target !== join(targetRoot, sourcePath.slice('memory/facts/'.length))) {
      throw new ProtectedMemoryFileStoreError('UNSAFE_PATH')
    }
    return target
  }

  return Object.freeze<ProtectedMemoryFileStore>({
    async stage(request) {
      const sizeBytes = request.content.byteLength
      assertRequest({ ...request, sizeBytes })
      assertCanonicalDirectory(stagingRoot)
      if (sha256(request.content) !== request.contentHash) {
        throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
      }
      const path = stagePath(request.operationId)
      if (recoverStaged(request.operationId, request.contentHash, sizeBytes)) return
      const temporary = join(
        stagingRoot,
        `${stageTemporaryPrefix(request.operationId)}${process.pid}-${randomUUID()}`,
      )
      let descriptor: number | null = null
      try {
        descriptor = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
          0o600,
        )
        writeFileSync(descriptor, request.content)
        fsyncSync(descriptor)
      } catch (error) {
        if (exists(temporary)) unlinkSync(temporary)
        throw error
      } finally {
        if (descriptor !== null) closeSync(descriptor)
      }
      try {
        linkSync(temporary, path)
      } catch (error) {
        unlinkSync(temporary)
        syncPath(stagingRoot)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' &&
          recoverStaged(request.operationId, request.contentHash, sizeBytes)) return
        throw error
      }
      syncPath(stagingRoot)
      input.faultAt?.('after-stage-link')
      unlinkSync(temporary)
      syncPath(stagingRoot)
      if (!matches(inspectFile(path, new Set([1])), request.contentHash, sizeBytes)) {
        throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
      }
      input.faultAt?.('after-stage')
    },

    async install(request) {
      assertRequest({ ...request })
      assertCanonicalDirectory(targetRoot)
      assertCanonicalDirectory(stagingRoot)
      const staged = stagePath(request.operationId)
      const target = targetPath(request.sourcePath)
      if (exists(target)) {
        const targetInfo = inspectFile(target, new Set([1, 2]))
        if (!matches(targetInfo, request.contentHash, request.sizeBytes)) return 'collision'
        if (!exists(staged)) {
          return targetInfo.nlink === 1 ? 'already-installed' : 'collision'
        }
        const stagedInfo = inspectFile(staged, new Set([1, 2]))
        if (targetInfo.dev !== stagedInfo.dev || targetInfo.ino !== stagedInfo.ino ||
          targetInfo.nlink !== 2 || stagedInfo.nlink !== 2) return 'collision'
        unlinkSync(staged)
        syncPath(stagingRoot)
        input.faultAt?.('after-unlink-stage')
        return matches(inspectFile(target, new Set([1])), request.contentHash, request.sizeBytes)
          ? 'already-installed'
          : 'collision'
      }
      if (!exists(staged)) return 'collision'
      const stagedInfo = inspectFile(staged, new Set([1]))
      if (!matches(stagedInfo, request.contentHash, request.sizeBytes)) return 'collision'
      try {
        linkSync(staged, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          throw new ProtectedMemoryFileStoreError('CROSS_DEVICE')
        }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'collision'
        throw error
      }
      syncPath(target)
      syncPath(targetRoot)
      input.faultAt?.('after-link')
      unlinkSync(staged)
      syncPath(stagingRoot)
      input.faultAt?.('after-unlink-stage')
      return matches(inspectFile(target, new Set([1])), request.contentHash, request.sizeBytes)
        ? 'installed'
        : 'collision'
    },

    async verifyInstalled(request) {
      try {
        assertRequest({ ...request })
        assertCanonicalDirectory(targetRoot)
        const target = targetPath(request.sourcePath)
        return exists(target) && matches(
          inspectFile(target, new Set([1])),
          request.contentHash,
          request.sizeBytes,
        )
      } catch {
        return false
      }
    },

    async removeInstalled(request) {
      assertRequest({ ...request })
      assertCanonicalDirectory(targetRoot)
      const target = targetPath(request.sourcePath)
      if (!exists(target)) return
      const current = inspectFile(target, new Set([1]))
      if (!matches(current, request.contentHash, request.sizeBytes)) {
        throw new ProtectedMemoryFileStoreError('STATE_CONFLICT')
      }
      unlinkSync(target)
      syncPath(targetRoot)
      input.faultAt?.('after-remove-target')
    },

    async verifyAbsent(request) {
      try {
        if (!SOURCE_PATH.test(request.sourcePath)) return false
        assertCanonicalDirectory(targetRoot)
        return !exists(targetPath(request.sourcePath))
      } catch {
        return false
      }
    },
  })
}

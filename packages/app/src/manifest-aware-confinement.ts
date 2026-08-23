import { createHash } from 'node:crypto'
import {
  ConfinementError,
  type AttachmentImportFilePort,
  type ConfinementPort,
  type ContextLeaseCoordinator,
  type ProjectFileManifestV1,
  type TurnContextLease,
} from '@aisy/core'
import type { PublishedAttachmentManifestReader } from './attachment-import-store.js'

type PathKind =
  | 'root'
  | 'imports-directory'
  | 'knowledge-directory'
  | 'knowledge-imports-directory'
  | 'import-file'
  | 'other'

interface ClassifiedPath {
  kind: PathKind
  canonical: string
  parts: string[]
}

function classify(path: string, allowRoot: boolean): ClassifiedPath {
  if (path === '.' || path === '') {
    if (!allowRoot) throw new ConfinementError('INVALID_PATH')
    return { kind: 'root', canonical: '.', parts: [] }
  }
  if (path.startsWith('/') || path.includes('\0')) throw new ConfinementError('INVALID_PATH')
  const parts = path.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' ||
    [...part].some(character => character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127))) {
    throw new ConfinementError('INVALID_PATH')
  }
  const canonical = parts.join('/')
  if (parts[0] === 'imports') {
    if (parts.length === 1) return { kind: 'imports-directory', canonical, parts }
    if (parts.length === 2) return { kind: 'import-file', canonical, parts }
    throw new ConfinementError('INVALID_PATH')
  }
  if (parts[0] === 'knowledge') {
    if (parts.length === 1) return { kind: 'knowledge-directory', canonical, parts }
    if (parts[1] === 'imports') {
      if (parts.length === 2) return { kind: 'knowledge-imports-directory', canonical, parts }
      if (parts.length === 3) return { kind: 'import-file', canonical, parts }
      throw new ConfinementError('INVALID_PATH')
    }
  }
  return { kind: 'other', canonical, parts }
}

function hasReservedTemporary(parts: readonly string[]): boolean {
  return parts.some(part => part.startsWith('.aisy-import-') && part.endsWith('.tmp'))
}

function prefixFor(path: ClassifiedPath): 'imports/' | 'knowledge/imports/' | null {
  if (path.kind === 'imports-directory') return 'imports/'
  if (path.kind === 'knowledge-imports-directory') return 'knowledge/imports/'
  return null
}

export function makeManifestAwareConfinementPort(input: {
  delegate: ConfinementPort
  leases: ContextLeaseCoordinator
  manifests: PublishedAttachmentManifestReader
  files: AttachmentImportFilePort
}): ConfinementPort {
  const withLease = async <T>(lease: TurnContextLease, work: () => Promise<T>): Promise<T> => {
    const operation = input.leases.reserveOperation(lease)
    try {
      operation.beginIo()
      return await work()
    } finally {
      operation.complete()
    }
  }
  const published = async (
    lease: TurnContextLease,
    pathPrefix?: string,
  ): Promise<ProjectFileManifestV1[]> => {
    const manifests = (await input.manifests.listPublishedManifests(lease))
      .filter(manifest => pathPrefix === undefined || manifest.relativePath.startsWith(pathPrefix))
    for (const manifest of manifests) {
      if (!await input.files.verifyInstalled({
        lease,
        relativePath: manifest.relativePath,
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
      })) throw new ConfinementError('PATH_CHANGED')
    }
    return manifests
  }

  return Object.freeze<ConfinementPort>({
    async readText(lease, path, maxBytes) {
      const classified = classify(path, false)
      if (hasReservedTemporary(classified.parts)) throw new ConfinementError('INVALID_PATH')
      if (classified.kind !== 'import-file') {
        if (classified.kind !== 'other') throw new ConfinementError('INVALID_PATH')
        return input.delegate.readText(lease, classified.canonical, maxBytes)
      }
      return withLease(lease, async () => {
        const manifest = await input.manifests.findPublishedManifest(lease, classified.canonical)
        if (manifest === null) throw new ConfinementError('NOT_FOUND')
        const text = await input.delegate.readText(lease, classified.canonical, maxBytes)
        const bytes = Buffer.from(text, 'utf8')
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        if (bytes.byteLength !== manifest.sizeBytes || sha256 !== manifest.sha256) {
          throw new ConfinementError('PATH_CHANGED')
        }
        return text
      })
    },

    writeText(lease, path, text, maxBytes) {
      const classified = classify(path, false)
      if (hasReservedTemporary(classified.parts) || classified.kind !== 'other') {
        return Promise.reject(new ConfinementError('INVALID_PATH'))
      }
      return input.delegate.writeText(lease, classified.canonical, text, maxBytes)
    },

    editText(lease, path, oldText, newText, options) {
      const classified = classify(path, false)
      if (hasReservedTemporary(classified.parts) || classified.kind !== 'other') {
        return Promise.reject(new ConfinementError('INVALID_PATH'))
      }
      return input.delegate.editText(
        lease,
        classified.canonical,
        oldText,
        newText,
        options,
      )
    },

    async list(lease, path = '.', maxEntries) {
      const classified = classify(path, true)
      if (hasReservedTemporary(classified.parts) || classified.kind === 'import-file') {
        throw new ConfinementError('INVALID_PATH')
      }
      if (classified.kind === 'other') {
        const entries = await input.delegate.list(lease, classified.canonical, maxEntries)
        return entries.filter(entry => !entry.startsWith('.aisy-import-'))
      }
      return withLease(lease, async () => {
        const entries = await input.delegate.list(lease, classified.canonical, maxEntries)
        if (classified.kind === 'root') {
          const manifests = await published(lease)
          return entries.filter(entry => {
            if (entry.startsWith('.aisy-import-')) return false
            if (entry === 'imports') {
              return manifests.some(manifest => manifest.relativePath.startsWith('imports/'))
            }
            return true
          })
        }
        if (classified.kind === 'knowledge-directory') {
          const manifests = await published(lease, 'knowledge/imports/')
          return entries.filter(entry => entry !== 'imports' || manifests.length > 0)
        }
        const prefix = prefixFor(classified)
        if (prefix === null) throw new ConfinementError('INVALID_PATH')
        const visible = new Set((await published(lease, prefix))
          .map(manifest => manifest.relativePath.slice(prefix.length)))
        return entries.filter(entry => visible.has(entry))
      })
    },

    scan(lease, path = '.', limits) {
      const classified = classify(path, true)
      if (hasReservedTemporary(classified.parts) || classified.kind !== 'other') {
        return Promise.reject(new ConfinementError('INVALID_PATH'))
      }
      return input.delegate.scan(lease, classified.canonical, limits)
    },
  })
}

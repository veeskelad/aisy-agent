import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import { types as utilTypes } from 'node:util'

const ROOT_DOMAIN = 'aisy.docker-sidecar.root-identity.v1\0'
const RELATIVE_NAME_DOMAIN = 'aisy.docker-sidecar.relative-name.v1\0'
const MAX_PATH_BYTES = 16 * 1024
const rootEvidenceBrand: unique symbol = Symbol('aisy.docker-sidecar-root-evidence')
const rootEvidence = new WeakSet<object>()
const hiddenRoots = new WeakMap<object, Readonly<{ canonicalRoot: string; device: bigint; inode: bigint }>>()

export type DockerSidecarFilesystemEvidenceKindV1 = 'whisper-input' | 'bash-workspace'

export interface DockerSidecarFilesystemEvidenceV1 {
  readonly [rootEvidenceBrand]: true
  readonly version: 1
  readonly kind: DockerSidecarFilesystemEvidenceKindV1
  readonly rootIdentityHash: string
  readonly relativeNameHash: string | null
}

export class DockerSidecarFilesystemEvidenceError extends Error {
  readonly code = 'DOCKER_SIDECAR_FILESYSTEM_EVIDENCE_INVALID' as const
  constructor() {
    super('DOCKER_SIDECAR_FILESYSTEM_EVIDENCE_INVALID')
    this.name = 'DockerSidecarFilesystemEvidenceError'
  }
}

function invalid(): never {
  throw new DockerSidecarFilesystemEvidenceError()
}

function filesystemInput(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      invalid()
    }
    const source = Object.getOwnPropertyDescriptors(value)
    const keys = Object.keys(source).sort()
    const allowed = keys.join(',') === 'kind,root' || keys.join(',') === 'kind,relativeName,root'
    if (!allowed) invalid()
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = source[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) invalid()
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
    }
    return result
  } catch (error) {
    if (error instanceof DockerSidecarFilesystemEvidenceError) throw error
    invalid()
  }
}

function path(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || normalize(value) !== value ||
    value.includes('\0') || value.includes('\n') || value.includes('\r') || value.includes(',') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) invalid()
  return value
}

function relativeName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') ||
    value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) invalid()
  const parts = value.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' ||
    [...part].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) invalid()
  return value
}

function digest(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(domain)
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes).update('\0')
  }
  return hash.digest('hex')
}

export function inspectNodeDockerSidecarFilesystemEvidence(input: Readonly<{
  readonly kind: DockerSidecarFilesystemEvidenceKindV1
  readonly root: string
  readonly relativeName?: string
}>): DockerSidecarFilesystemEvidenceV1 {
  try {
    const record = filesystemInput(input)
    const kind = record.kind
    if (kind !== 'whisper-input' && kind !== 'bash-workspace') invalid()
    if ((kind === 'whisper-input') !== Object.hasOwn(record, 'relativeName')) invalid()
    const requestedRoot = path(record.root)
    const before = lstatSync(requestedRoot, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) invalid()
    const canonicalRoot = realpathSync.native(requestedRoot)
    if (canonicalRoot !== requestedRoot) invalid()
    const after = lstatSync(requestedRoot, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev ||
      before.ino !== after.ino) invalid()
    const selectedRelative = kind === 'whisper-input' ? relativeName(record.relativeName) : null
    const evidence: DockerSidecarFilesystemEvidenceV1 = Object.freeze({
      [rootEvidenceBrand]: true as const,
      version: 1,
      kind,
      rootIdentityHash: digest(ROOT_DOMAIN, [canonicalRoot, String(after.dev), String(after.ino)]),
      relativeNameHash: selectedRelative === null
        ? null
        : digest(RELATIVE_NAME_DOMAIN, [selectedRelative]),
    })
    rootEvidence.add(evidence)
    hiddenRoots.set(evidence, Object.freeze({ canonicalRoot, device: after.dev, inode: after.ino }))
    return evidence
  } catch (error) {
    if (error instanceof DockerSidecarFilesystemEvidenceError) throw error
    invalid()
  }
}

export function isDockerSidecarFilesystemEvidence(
  value: unknown,
): value is DockerSidecarFilesystemEvidenceV1 {
  return value !== null && typeof value === 'object' && !utilTypes.isProxy(value) && rootEvidence.has(value)
}

export function matchesCurrentNodeDockerSidecarFilesystemEvidence(
  value: DockerSidecarFilesystemEvidenceV1,
): boolean {
  try {
    if (!isDockerSidecarFilesystemEvidence(value)) return false
    const hidden = hiddenRoots.get(value)
    if (hidden === undefined) return false
    const info = lstatSync(hidden.canonicalRoot, { bigint: true })
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === hidden.device &&
      info.ino === hidden.inode && realpathSync.native(hidden.canonicalRoot) === hidden.canonicalRoot
  } catch {
    return false
  }
}

/** Internal raw root access remains gated by genuine evidence and is not part of diagnostics. */
export function resolveNodeDockerSidecarFilesystemRoot(
  value: DockerSidecarFilesystemEvidenceV1,
): string {
  if (!matchesCurrentNodeDockerSidecarFilesystemEvidence(value)) invalid()
  const hidden = hiddenRoots.get(value)
  if (hidden === undefined) invalid()
  return hidden.canonicalRoot
}

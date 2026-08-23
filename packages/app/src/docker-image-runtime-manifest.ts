import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  isDockerEnginePinnedImageInspectEvidence,
  type DockerEnginePinnedEndpointIdentityV1,
  type DockerEnginePinnedImageInspectEvidenceV1,
} from './docker-engine-pinned-session.js'

const CONFIG_HASH_DOMAIN = 'aisy.docker-image-runtime-config.v1\0'
const MANIFEST_HASH_DOMAIN = 'aisy.docker-image-runtime-manifest.v1\0'
const SHA256_ID = /^sha256:[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const PORT = /^(0|[1-9][0-9]{0,4})\/(tcp|udp|sctp)$/
const SAFE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'NODE_ENV',
  'PYTHONNOUSERSITE', 'PYTHONDONTWRITEBYTECODE', 'PYTHONSAFEPATH',
  'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'OMP_NUM_THREADS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
])
const MAX_NODES = 16_384
const MAX_TEXT_BYTES = 256 * 1024
const MAX_CANONICAL_BYTES = 256 * 1024
const MAX_STRING_BYTES = 16 * 1024
const MAX_ENV = 128
const MAX_LABELS = 128
const MAX_ARGS = 64
const MAX_MAP_KEYS = 128
const MAX_DEPTH = 32
const jsonStringify = JSON.stringify

const manifestBrand: unique symbol = Symbol('aisy.docker-image-runtime-manifest')
const manifests = new WeakSet<object>()

export type DockerImageRuntimePlatformV1 = 'amd64' | 'arm64'

export interface DockerImageRuntimeHealthcheckV1 {
  readonly test: readonly string[]
  readonly intervalNanoseconds: number
  readonly timeoutNanoseconds: number
  readonly startPeriodNanoseconds: number
  readonly startIntervalNanoseconds: number
  readonly retries: number
}

export interface DockerImageRuntimeConfigV1 {
  readonly user: string
  readonly env: readonly string[]
  readonly entrypoint: readonly string[]
  readonly cmd: readonly string[]
  readonly workingDir: string
  readonly labels: Readonly<Record<string, string>>
  readonly volumes: readonly string[]
  readonly exposedPorts: readonly string[]
  readonly healthcheck: DockerImageRuntimeHealthcheckV1 | null
  readonly stopSignal: string
  readonly shell: readonly string[]
  readonly onBuild: readonly string[]
}

export interface DockerImageRuntimeManifestV1 {
  readonly [manifestBrand]: true
  readonly version: 1
  readonly kind: 'aisy-docker-image-runtime-manifest-v1'
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  readonly imageReference: string
  readonly imageId: string
  readonly os: 'linux'
  readonly architecture: DockerImageRuntimePlatformV1
  readonly config: DockerImageRuntimeConfigV1
  readonly configHash: string
  readonly manifestHash: string
}

export class DockerImageRuntimeManifestError extends Error {
  readonly code = 'DOCKER_IMAGE_RUNTIME_MANIFEST_INVALID' as const
  constructor() {
    super('DOCKER_IMAGE_RUNTIME_MANIFEST_INVALID')
    this.name = 'DockerImageRuntimeManifestError'
  }
}

interface Budget { nodes: number; textBytes: number; canonicalBytes: number }

function invalid(): DockerImageRuntimeManifestError {
  return new DockerImageRuntimeManifestError()
}

function charge(value: string, budget: Budget): string {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_STRING_BYTES || bytes > MAX_TEXT_BYTES - budget.textBytes) throw invalid()
  budget.textBytes += bytes
  return value
}

function plain(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
  } catch {
    return false
  }
}

function descriptors(value: object, arrayLength = false): PropertyDescriptorMap {
  try {
    if (utilTypes.isProxy(value) || Object.getOwnPropertySymbols(value).length !== 0) throw invalid()
    const result = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(result).some(key => typeof key !== 'string' || (() => {
      const item = result[key as string]
      if (key === 'length' && arrayLength) {
        return item === undefined || !('value' in item) || item.enumerable !== false ||
          item.configurable !== false
      }
      return item === undefined || !('value' in item) || item.enumerable !== true
    })())) throw invalid()
    return result
  } catch {
    throw invalid()
  }
}

function visit(budget: Budget): void {
  budget.nodes += 1
  if (budget.nodes > MAX_NODES) throw invalid()
}

function scalarString(value: unknown, budget: Budget): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalid()
  return charge(value, budget)
}

function stringArray(value: unknown, budget: Budget, maximum = MAX_ARGS): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum) throw invalid()
  const source = descriptors(value, true)
  const keys = Object.keys(source).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid()
  const result: string[] = []
  for (const key of keys) {
    visit(budget)
    result.push(scalarString(source[key]!.value, budget))
  }
  return Object.freeze(result)
}

function stringMap(value: unknown, budget: Budget): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return Object.freeze({})
  if (!plain(value)) throw invalid()
  const source = descriptors(value)
  const keys = Object.keys(source).sort()
  if (keys.length > MAX_LABELS) throw invalid()
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of keys) {
    visit(budget)
    const item = source[key]!.value
    if (typeof item !== 'string') throw invalid()
    Object.defineProperty(result, charge(key, budget), {
      value: charge(item, budget), enumerable: true, configurable: false, writable: false,
    })
  }
  return Object.freeze(result)
}

function keySet(value: unknown, budget: Budget, kind: 'volume' | 'port'): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([])
  if (!plain(value)) throw invalid()
  const source = descriptors(value)
  const keys = Object.keys(source).sort()
  if (keys.length > MAX_MAP_KEYS) throw invalid()
  for (const key of keys) {
    visit(budget)
    charge(key, budget)
    const item = source[key]!.value
    if (!plain(item) || Object.keys(descriptors(item)).length !== 0) throw invalid()
    if (kind === 'port') {
      const match = PORT.exec(key)
      if (match === null || Number(match[1]) > 65_535) throw invalid()
    } else if (!key.startsWith('/') || key.includes('\0')) throw invalid()
  }
  return Object.freeze(keys)
}

function natural(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) throw invalid()
  return Number(value)
}

function healthcheck(value: unknown, budget: Budget): DockerImageRuntimeHealthcheckV1 | null {
  if (value === undefined || value === null) return null
  if (!plain(value)) throw invalid()
  const source = descriptors(value)
  const allowed = new Set([
    'Test', 'Interval', 'Timeout', 'StartPeriod', 'StartInterval', 'Retries',
  ])
  if (Object.keys(source).some(key => !allowed.has(key))) throw invalid()
  return Object.freeze({
    test: stringArray(source.Test?.value, budget, MAX_ARGS),
    intervalNanoseconds: natural(source.Interval?.value),
    timeoutNanoseconds: natural(source.Timeout?.value),
    startPeriodNanoseconds: natural(source.StartPeriod?.value),
    startIntervalNanoseconds: natural(source.StartInterval?.value),
    retries: natural(source.Retries?.value),
  })
}

function normalizeConfig(value: unknown, budget: Budget): DockerImageRuntimeConfigV1 {
  if (!plain(value)) throw invalid()
  const source = descriptors(value)
  const allowed = new Set([
    'User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'Labels', 'Volumes',
    'ExposedPorts', 'Healthcheck', 'StopSignal', 'Shell', 'OnBuild',
  ])
  if (Object.keys(source).some(key => !allowed.has(key))) throw invalid()

  const inherited = stringArray(source.Env?.value, budget, MAX_ENV)
  const inheritedNames = new Set<string>()
  for (const entry of inherited) {
    const separator = entry.indexOf('=')
    if (separator < 1) throw invalid()
    const name = entry.slice(0, separator)
    if (!SAFE_ENV_NAMES.has(name) || inheritedNames.has(name)) throw invalid()
    inheritedNames.add(name)
  }

  const labels = stringMap(source.Labels?.value, budget)
  if (Object.keys(labels).some(key => key.startsWith('com.aisy.'))) throw invalid()

  return Object.freeze({
    user: scalarString(source.User?.value, budget),
    env: inherited,
    entrypoint: stringArray(source.Entrypoint?.value, budget),
    cmd: stringArray(source.Cmd?.value, budget),
    workingDir: scalarString(source.WorkingDir?.value, budget),
    labels,
    volumes: keySet(source.Volumes?.value, budget, 'volume'),
    exposedPorts: keySet(source.ExposedPorts?.value, budget, 'port'),
    healthcheck: healthcheck(source.Healthcheck?.value, budget),
    stopSignal: scalarString(source.StopSignal?.value, budget),
    shell: stringArray(source.Shell?.value, budget),
    onBuild: stringArray(source.OnBuild?.value, budget),
  })
}

function canonical(value: unknown, budget: Budget): string {
  const encode = (current: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw invalid()
    visit(budget)
    if (current === null) return 'null'
    if (typeof current === 'string') return jsonStringify(current)
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) throw invalid()
      return String(current)
    }
    if (typeof current !== 'object' || utilTypes.isProxy(current)) throw invalid()
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) throw invalid()
      const source = descriptors(current, true)
      const keys = Object.keys(source).filter(key => key !== 'length')
      if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) {
        throw invalid()
      }
      return `[${keys.map(key => encode(source[key]!.value, depth + 1)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) throw invalid()
    const source = descriptors(current)
    const keys = Object.keys(source).sort()
    return `{${keys.map(key => `${jsonStringify(key)}:${encode(source[key]!.value, depth + 1)}`).join(',')}}`
  }
  const result = encode(value, 0)
  const bytes = Buffer.byteLength(result, 'utf8')
  if (bytes > MAX_CANONICAL_BYTES || bytes > MAX_CANONICAL_BYTES - budget.canonicalBytes) {
    throw invalid()
  }
  budget.canonicalBytes += bytes
  return result
}

function digest(domain: string, body: string): string {
  return createHash('sha256').update(domain).update(body).digest('hex')
}

function endpointSnapshot(
  value: DockerEnginePinnedEndpointIdentityV1,
  budget: Budget,
): DockerEnginePinnedEndpointIdentityV1 {
  if (!plain(value)) throw invalid()
  const source = descriptors(value)
  const keys = Object.keys(source).sort()
  if (keys.join(',') !== 'apiVersion,endpointBindingHash,serverId,serverVersion,version') {
    throw invalid()
  }
  const endpointBindingHash = scalarString(source.endpointBindingHash?.value, budget)
  const serverId = scalarString(source.serverId?.value, budget)
  const serverVersion = scalarString(source.serverVersion?.value, budget)
  if (source.version?.value !== 1 || source.apiVersion?.value !== '1.54' ||
    !HASH.test(endpointBindingHash) || serverId.length === 0 || serverVersion.length === 0) {
    throw invalid()
  }
  return Object.freeze({
    version: 1,
    endpointBindingHash,
    serverId,
    serverVersion,
    apiVersion: '1.54',
  })
}

export function createDockerImageRuntimeManifest(
  evidence: DockerEnginePinnedImageInspectEvidenceV1,
): DockerImageRuntimeManifestV1 {
  try {
    if (!isDockerEnginePinnedImageInspectEvidence(evidence)) throw invalid()
    const budget: Budget = { nodes: 0, textBytes: 0, canonicalBytes: 0 }
    const document = evidence.document
    if (!plain(document)) throw invalid()
    const source = descriptors(document)
    const imageReference = charge(evidence.requestedDigest, budget)
    const imageId = scalarString(source.Id?.value, budget)
    const os = source.Os?.value
    const architecture = source.Architecture?.value
    if (!SHA256_ID.test(imageId) || os !== 'linux' ||
      (architecture !== 'amd64' && architecture !== 'arm64')) throw invalid()

    const repoDigests = stringArray(source.RepoDigests?.value, budget, MAX_MAP_KEYS)
    const uniqueDigests = new Set(repoDigests)
    if (uniqueDigests.size !== repoDigests.length ||
      repoDigests.filter(item => item === imageReference).length !== 1) {
      throw invalid()
    }

    const config = normalizeConfig(source.Config?.value, budget)
    const endpointIdentity = endpointSnapshot(evidence.endpointIdentity, budget)
    const configHash = digest(CONFIG_HASH_DOMAIN, canonical(config, budget))
    const body = Object.freeze({
      version: 1 as const,
      kind: 'aisy-docker-image-runtime-manifest-v1' as const,
      endpointIdentity,
      imageReference,
      imageId,
      os: 'linux' as const,
      architecture,
      config,
      configHash,
    })
    const manifestHash = digest(MANIFEST_HASH_DOMAIN, canonical(body, budget))
    const manifest: DockerImageRuntimeManifestV1 = Object.freeze({
      [manifestBrand]: true as const,
      ...body,
      manifestHash,
    })
    manifests.add(manifest)
    return manifest
  } catch {
    throw invalid()
  }
}

export function isDockerImageRuntimeManifest(
  value: unknown,
): value is DockerImageRuntimeManifestV1 {
  return value !== null && typeof value === 'object' && !utilTypes.isProxy(value) &&
    manifests.has(value)
}

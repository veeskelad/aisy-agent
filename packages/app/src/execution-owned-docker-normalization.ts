import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  type OwnedDockerLabelsV1,
  type OwnedDockerObservedResourceV1,
} from './execution-owned-docker-resources.js'

const HASH = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{64}$/
const IMAGE_CONFIG_ID = /^sha256:[a-f0-9]{64}$/
const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const MAX_CANONICAL_DEPTH = 32
const MAX_CANONICAL_NODES = 50_000
/** Matches the CLI inspect response cap while keeping exported unknown APIs self-contained. */
const MAX_NORMALIZATION_TEXT_BYTES = 1024 * 1024
const MAX_CANONICAL_BYTES = 1024 * 1024
const MAX_NETWORK_ENDPOINTS = 4_096
const jsonStringify = JSON.stringify

export const OWNED_DOCKER_LABEL_KEYS_V1 = Object.freeze({
  version: 'com.aisy.resource.version',
  installationId: 'com.aisy.resource.installation',
  ownerBindingHash: 'com.aisy.resource.owner',
  sessionBindingHash: 'com.aisy.resource.session',
  operationBindingHash: 'com.aisy.resource.operation',
  sidecarKind: 'com.aisy.resource.kind',
  role: 'com.aisy.resource.role',
  policyHash: 'com.aisy.resource.policy',
} as const)

export const OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1 = Object.freeze(
  Object.values(OWNED_DOCKER_LABEL_KEYS_V1),
)

const OWNERSHIP_LABEL_NAMES = new Set<string>(OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1)

export type OwnedDockerNormalizationErrorCode = 'OWNED_DOCKER_NORMALIZATION_INVALID'

export class OwnedDockerNormalizationError extends Error {
  constructor(readonly code: OwnedDockerNormalizationErrorCode) {
    super(code)
    this.name = 'OwnedDockerNormalizationError'
  }
}

/** Exact post-normalization Docker inspect semantics expected for a container. */
export interface ExpectedOwnedDockerContainerProjectionV1 {
  readonly version: 1
  readonly resourceKind: 'container'
  readonly imageId: string
  readonly config: Readonly<Record<string, unknown>>
  readonly hostConfig: Readonly<Record<string, unknown>>
  readonly mounts: readonly unknown[]
}

/** Exact immutable network semantics; live endpoint membership is separate. */
export interface ExpectedOwnedDockerNetworkProjectionV1 {
  readonly version: 1
  readonly resourceKind: 'network'
  readonly driver: string
  readonly internal: boolean
  readonly attachable: boolean
  readonly ingress: boolean
  readonly enableIpv6: boolean
  readonly options: Readonly<Record<string, unknown>>
  readonly ipam: Readonly<Record<string, unknown>>
  readonly labels: Readonly<Record<string, string>>
}

type JsonScalar = null | boolean | number | string
type JsonValue = JsonScalar | readonly JsonValue[] | JsonRecord
interface JsonRecord { readonly [key: string]: JsonValue }
interface NormalizationBudget {
  nodes: number
  textBytes: number
  canonicalBytes: number
}

function invalid(): OwnedDockerNormalizationError {
  return new OwnedDockerNormalizationError('OWNED_DOCKER_NORMALIZATION_INVALID')
}

function makeBudget(): NormalizationBudget {
  return { nodes: 0, textBytes: 0, canonicalBytes: 0 }
}

function chargeText(value: string, budget: NormalizationBudget): void {
  const remaining = MAX_NORMALIZATION_TEXT_BYTES - budget.textBytes
  if (value.length > remaining) throw invalid()
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > remaining) throw invalid()
  budget.textBytes += bytes
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false
  try { return Object.getPrototypeOf(value) === Object.prototype } catch { return false }
}

function snapshotJson(value: unknown, budget: NormalizationBudget): JsonValue {
  const visit = (current: unknown, depth: number): JsonValue => {
    budget.nodes += 1
    if (depth > MAX_CANONICAL_DEPTH || budget.nodes > MAX_CANONICAL_NODES ||
      utilTypes.isProxy(current)) throw invalid()
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') {
      chargeText(current, budget)
      return current
    }
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (Array.isArray(current)) {
      let descriptors: Record<string, PropertyDescriptor>
      try {
        if (Object.getPrototypeOf(current) !== Array.prototype || Object.getOwnPropertySymbols(current).length !== 0) {
          throw invalid()
        }
        descriptors = Object.getOwnPropertyDescriptors(current)
      } catch {
        throw invalid()
      }
      const keys = Object.keys(descriptors).filter(key => key !== 'length')
      if (keys.length > MAX_CANONICAL_NODES - budget.nodes || keys.length !== current.length ||
        keys.some((key, index) => key !== String(index))) throw invalid()
      const result = keys.map(key => {
        chargeText(key, budget)
        const descriptor = descriptors[key]
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
        return visit(descriptor.value, depth + 1)
      })
      return Object.freeze(result)
    }
    if (!isPlainRecord(current)) throw invalid()
    let descriptors: Record<string, PropertyDescriptor>
    try {
      if (Object.getOwnPropertySymbols(current).length !== 0) throw invalid()
      descriptors = Object.getOwnPropertyDescriptors(current)
    } catch {
      throw invalid()
    }
    const result: Record<string, unknown> = {}
    const keys = Object.keys(descriptors).sort()
    if (keys.length > MAX_CANONICAL_NODES - budget.nodes) throw invalid()
    for (const key of keys) {
      chargeText(key, budget)
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
      defineValue(result, key, visit(descriptor.value, depth + 1))
    }
    return Object.freeze(result) as JsonRecord
  }
  return visit(value, 0)
}

function exactRecord(value: unknown, keys: readonly string[], budget: NormalizationBudget): JsonRecord {
  const snapshot = snapshotJson(value, budget)
  if (!isPlainRecord(snapshot)) throw invalid()
  const actual = Object.keys(snapshot).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalid()
  return snapshot
}

function engineDocument(value: unknown, requiredKeys: readonly string[], budget: NormalizationBudget): JsonRecord {
  const snapshot = snapshotJson(value, budget)
  if (!isPlainRecord(snapshot) || requiredKeys.some(key => !Object.hasOwn(snapshot, key))) throw invalid()
  return snapshot
}

function canonical(value: JsonValue, budget: NormalizationBudget): string {
  const serialize = (current: JsonValue): string => {
    if (current === null) return 'null'
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (typeof current === 'number' || typeof current === 'string') {
      const scalar = jsonStringify(current)
      if (scalar === undefined) throw invalid()
      return scalar
    }
    if (Array.isArray(current)) {
      const items: string[] = []
      for (let index = 0; index < current.length; index += 1) {
        items.push(serialize(current[index]!))
      }
      return `[${items.join(',')}]`
    }
    const descriptors = Object.getOwnPropertyDescriptors(current)
    const members: string[] = []
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw invalid()
      }
      members.push(`${jsonStringify(key)}:${serialize(descriptor.value as JsonValue)}`)
    }
    return `{${members.join(',')}}`
  }
  const result = serialize(value)
  const remaining = MAX_CANONICAL_BYTES - budget.canonicalBytes
  if (result.length > remaining) throw invalid()
  const bytes = Buffer.byteLength(result, 'utf8')
  if (bytes > remaining) throw invalid()
  budget.canonicalBytes += bytes
  return result
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stringMap(value: JsonValue): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) throw invalid()
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw invalid()
    defineValue(result, key, item)
  }
  return Object.freeze(result) as Readonly<Record<string, string>>
}

function projectionLabels(
  value: JsonValue,
  ownership: 'required' | 'forbidden',
): Readonly<Record<string, string>> {
  const labels = stringMap(value)
  let ownershipCount = 0
  const projected: Record<string, unknown> = {}
  for (const [key, labelValue] of Object.entries(labels)) {
    if (key.startsWith('com.aisy.')) {
      if (!OWNERSHIP_LABEL_NAMES.has(key)) throw invalid()
      ownershipCount += 1
      continue
    }
    defineValue(projected, key, labelValue)
  }
  if ((ownership === 'required' && ownershipCount !== OWNERSHIP_LABEL_NAMES.size) ||
    (ownership === 'forbidden' && ownershipCount !== 0)) throw invalid()
  return Object.freeze(projected) as Readonly<Record<string, string>>
}

function containerProjectionHash(input: Readonly<{
  imageId: unknown
  config: JsonValue
  hostConfig: JsonValue
  mounts: JsonValue
  ownership: 'required' | 'forbidden'
}>, budget: NormalizationBudget): string {
  const { imageId, config, hostConfig, mounts } = input
  if (typeof imageId !== 'string' || !IMAGE_CONFIG_ID.test(imageId) ||
    !isPlainRecord(config) || !isPlainRecord(hostConfig) || !Array.isArray(mounts) ||
    !Object.hasOwn(config, 'Labels')) throw invalid()
  const projectedConfig: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    defineValue(projectedConfig, key, key === 'Labels' ? projectionLabels(value, input.ownership) : value)
  }
  const frozenConfig = Object.freeze(projectedConfig) as JsonRecord
  const configHash = digest(canonical(frozenConfig, budget))
  const hostConfigHash = digest(canonical(hostConfig, budget))
  const mountsHash = digest(canonical(mounts, budget))
  return digest(canonical(Object.freeze({
    version: 1,
    resourceKind: 'container',
    imageId,
    configHash,
    hostConfigHash,
    mountsHash,
  }), budget))
}

function networkProjectionHash(input: Readonly<{
  driver: unknown
  internal: unknown
  attachable: unknown
  ingress: unknown
  enableIpv6: unknown
  options: JsonValue
  ipam: JsonValue
  labels: JsonValue
  ownership: 'required' | 'forbidden'
}>, budget: NormalizationBudget): string {
  const { options, ipam } = input
  if (typeof input.driver !== 'string' || typeof input.internal !== 'boolean' ||
    typeof input.attachable !== 'boolean' || typeof input.ingress !== 'boolean' ||
    typeof input.enableIpv6 !== 'boolean' || !isPlainRecord(options) || !isPlainRecord(ipam)) throw invalid()
  const optionsHash = digest(canonical(options, budget))
  const ipamHash = digest(canonical(ipam, budget))
  const labelsHash = digest(canonical(projectionLabels(input.labels, input.ownership) as JsonRecord, budget))
  return digest(canonical(Object.freeze({
    version: 1,
    resourceKind: 'network',
    driver: input.driver,
    internal: input.internal,
    attachable: input.attachable,
    ingress: input.ingress,
    enableIpv6: input.enableIpv6,
    optionsHash,
    ipamHash,
    labelsHash,
  }), budget))
}

export function hashExpectedOwnedDockerContainerProjection(
  input: ExpectedOwnedDockerContainerProjectionV1,
): string {
  try {
    const budget = makeBudget()
    const record = exactRecord(input, [
      'version', 'resourceKind', 'imageId', 'config', 'hostConfig', 'mounts',
    ], budget)
    if (record['version'] !== 1 || record['resourceKind'] !== 'container') throw invalid()
    return containerProjectionHash({
      imageId: record['imageId'],
      config: record['config']!,
      hostConfig: record['hostConfig']!,
      mounts: record['mounts']!,
      ownership: 'forbidden',
    }, budget)
  } catch {
    throw invalid()
  }
}

export function hashExpectedOwnedDockerNetworkProjection(
  input: ExpectedOwnedDockerNetworkProjectionV1,
): string {
  try {
    const budget = makeBudget()
    const record = exactRecord(input, [
      'version', 'resourceKind', 'driver', 'internal', 'attachable', 'ingress',
      'enableIpv6', 'options', 'ipam', 'labels',
    ], budget)
    if (record['version'] !== 1 || record['resourceKind'] !== 'network') throw invalid()
    return networkProjectionHash({
      driver: record['driver'],
      internal: record['internal'],
      attachable: record['attachable'],
      ingress: record['ingress'],
      enableIpv6: record['enableIpv6'],
      options: record['options']!,
      ipam: record['ipam']!,
      labels: record['labels']!,
      ownership: 'forbidden',
    }, budget)
  } catch {
    throw invalid()
  }
}

function labelsFrom(value: JsonValue): OwnedDockerLabelsV1 {
  const labels = stringMap(value)
  for (const key of Object.keys(labels)) {
    if (key.startsWith('com.aisy.') && !OWNERSHIP_LABEL_NAMES.has(key)) throw invalid()
  }
  const keys = OWNED_DOCKER_LABEL_KEYS_V1
  if ([keys.installationId, keys.ownerBindingHash, keys.sessionBindingHash,
    keys.operationBindingHash, keys.policyHash].some(key => !HASH.test(labels[key] ?? '')) ||
    labels[keys.version] !== '1') throw invalid()
  const sidecarKind = labels[keys.sidecarKind]
  const role = labels[keys.role]
  if (sidecarKind !== 'restricted-clone' && sidecarKind !== 'whisper' &&
    sidecarKind !== 'lease-bound-docker-bash') throw invalid()
  if (role !== 'worker' && role !== 'gateway' && role !== 'network') throw invalid()
  if ((role === 'network' || role === 'gateway') && sidecarKind !== 'restricted-clone') throw invalid()
  return Object.freeze({
    version: '1',
    installationId: labels[keys.installationId]!,
    ownerBindingHash: labels[keys.ownerBindingHash]!,
    sessionBindingHash: labels[keys.sessionBindingHash]!,
    operationBindingHash: labels[keys.operationBindingHash]!,
    sidecarKind,
    role,
    policyHash: labels[keys.policyHash]!,
  })
}

export function normalizeOwnedDockerContainerInspect(document: unknown): OwnedDockerObservedResourceV1 {
  try {
    const budget = makeBudget()
    const record = engineDocument(document, [
      'Id', 'Name', 'Image', 'Config', 'HostConfig', 'Mounts',
    ], budget)
    const objectId = record['Id']
    const rawName = record['Name']
    const imageId = record['Image']
    const config = record['Config']
    const hostConfig = record['HostConfig']
    const mounts = record['Mounts']
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId) || typeof rawName !== 'string' ||
      typeof imageId !== 'string' || !IMAGE_CONFIG_ID.test(imageId) ||
      !rawName.startsWith('/') || !RESOURCE_NAME.test(rawName.slice(1)) || !isPlainRecord(config) ||
      !isPlainRecord(hostConfig) || !Array.isArray(mounts)) throw invalid()
    const labels = labelsFrom(config['Labels']!)
    if (labels.role === 'network') throw invalid()
    return Object.freeze({
      version: 1,
      objectId,
      resourceKind: 'container',
      name: rawName.slice(1),
      labels,
      projectionHash: containerProjectionHash({
        imageId, config, hostConfig, mounts, ownership: 'required',
      }, budget),
      networkEndpointCount: null,
    })
  } catch {
    throw invalid()
  }
}

export function normalizeOwnedDockerNetworkInspect(document: unknown): OwnedDockerObservedResourceV1 {
  try {
    const budget = makeBudget()
    const record = engineDocument(document, [
      'Id', 'Name', 'Driver', 'Internal', 'Attachable', 'Ingress', 'EnableIPv6',
      'Options', 'IPAM', 'Labels', 'Containers',
    ], budget)
    const objectId = record['Id']
    const name = record['Name']
    const driver = record['Driver']
    const internal = record['Internal']
    const attachable = record['Attachable']
    const ingress = record['Ingress']
    const enableIpv6 = record['EnableIPv6']
    const options = record['Options']
    const ipam = record['IPAM']
    const containers = record['Containers']
    if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId) || typeof name !== 'string' ||
      !RESOURCE_NAME.test(name) || typeof driver !== 'string' || typeof internal !== 'boolean' ||
      typeof attachable !== 'boolean' || typeof ingress !== 'boolean' || typeof enableIpv6 !== 'boolean' ||
      !isPlainRecord(options) || !isPlainRecord(ipam) || !isPlainRecord(containers)) throw invalid()
    const endpointIds = Object.keys(containers)
    if (endpointIds.length > MAX_NETWORK_ENDPOINTS || endpointIds.some(id => !OBJECT_ID.test(id))) throw invalid()
    const labels = labelsFrom(record['Labels']!)
    if (labels.role !== 'network') throw invalid()
    return Object.freeze({
      version: 1,
      objectId,
      resourceKind: 'network',
      name,
      labels,
      projectionHash: networkProjectionHash({
        driver,
        internal,
        attachable,
        ingress,
        enableIpv6,
        options,
        ipam,
        labels: record['Labels']!,
        ownership: 'required',
      }, budget),
      networkEndpointCount: endpointIds.length,
    })
  } catch {
    throw invalid()
  }
}

function expectedLabelsFrom(value: unknown, budget: NormalizationBudget): OwnedDockerLabelsV1 {
  const record = exactRecord(value, [
    'version', 'installationId', 'ownerBindingHash', 'sessionBindingHash',
    'operationBindingHash', 'sidecarKind', 'role', 'policyHash',
  ], budget)
  if (record['version'] !== '1' ||
    typeof record['installationId'] !== 'string' || !HASH.test(record['installationId']) ||
    typeof record['ownerBindingHash'] !== 'string' || !HASH.test(record['ownerBindingHash']) ||
    typeof record['sessionBindingHash'] !== 'string' || !HASH.test(record['sessionBindingHash']) ||
    typeof record['operationBindingHash'] !== 'string' || !HASH.test(record['operationBindingHash']) ||
    typeof record['policyHash'] !== 'string' || !HASH.test(record['policyHash']) ||
    (record['sidecarKind'] !== 'restricted-clone' && record['sidecarKind'] !== 'whisper' &&
      record['sidecarKind'] !== 'lease-bound-docker-bash') ||
    (record['role'] !== 'worker' && record['role'] !== 'gateway' && record['role'] !== 'network') ||
    ((record['role'] === 'network' || record['role'] === 'gateway') &&
      record['sidecarKind'] !== 'restricted-clone')) throw invalid()
  return Object.freeze({
    version: '1',
    installationId: record['installationId'],
    ownerBindingHash: record['ownerBindingHash'],
    sessionBindingHash: record['sessionBindingHash'],
    operationBindingHash: record['operationBindingHash'],
    sidecarKind: record['sidecarKind'],
    role: record['role'],
    policyHash: record['policyHash'],
  })
}

/** Descriptor-only snapshot for an expected ledger/scan ownership proof. */
export function snapshotExpectedOwnedDockerResource(
  value: unknown,
): OwnedDockerObservedResourceV1 {
  try {
    const budget = makeBudget()
    const record = exactRecord(value, [
      'version', 'objectId', 'resourceKind', 'name', 'labels', 'projectionHash',
      'networkEndpointCount',
    ], budget)
    const objectId = record['objectId']
    const resourceKind = record['resourceKind']
    const name = record['name']
    const projectionHash = record['projectionHash']
    const networkEndpointCount = record['networkEndpointCount']
    if (record['version'] !== 1 || typeof objectId !== 'string' || !OBJECT_ID.test(objectId) ||
      (resourceKind !== 'container' && resourceKind !== 'network') ||
      typeof name !== 'string' || !RESOURCE_NAME.test(name) ||
      typeof projectionHash !== 'string' || !HASH.test(projectionHash) ||
      (resourceKind === 'container' && networkEndpointCount !== null) ||
      (resourceKind === 'network' && (!Number.isSafeInteger(networkEndpointCount) ||
        Number(networkEndpointCount) < 0 || Number(networkEndpointCount) > MAX_NETWORK_ENDPOINTS))) {
      throw invalid()
    }
    const labels = expectedLabelsFrom(record['labels'], budget)
    if ((labels.role === 'network') !== (resourceKind === 'network')) throw invalid()
    return Object.freeze({
      version: 1,
      objectId,
      resourceKind,
      name,
      labels,
      projectionHash,
      networkEndpointCount: networkEndpointCount as number | null,
    })
  } catch {
    throw invalid()
  }
}

export function ownedDockerObservedResourcesEqual(
  left: OwnedDockerObservedResourceV1,
  right: OwnedDockerObservedResourceV1,
): boolean {
  const a = left.labels
  const b = right.labels
  return left.version === right.version && left.objectId === right.objectId &&
    left.resourceKind === right.resourceKind && left.name === right.name &&
    left.projectionHash === right.projectionHash &&
    left.networkEndpointCount === right.networkEndpointCount &&
    a.version === b.version && a.installationId === b.installationId &&
    a.ownerBindingHash === b.ownerBindingHash && a.sessionBindingHash === b.sessionBindingHash &&
    a.operationBindingHash === b.operationBindingHash && a.sidecarKind === b.sidecarKind &&
    a.role === b.role && a.policyHash === b.policyHash
}

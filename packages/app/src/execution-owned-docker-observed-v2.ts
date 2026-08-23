import { types as utilTypes } from 'node:util'

import {
  normalizeOwnedDockerContainerInspectProjectionV2,
} from './docker-container-selected-projection.js'
import {
  normalizeOwnedDockerContainerInspect,
  normalizeOwnedDockerNetworkInspect,
  snapshotExpectedOwnedDockerResource,
} from './execution-owned-docker-normalization.js'
import {
  type OwnedDockerCreateProjectionContractV1,
  type OwnedDockerObservedResourceV2,
} from './execution-owned-docker-resources.js'

const HASH = /^[a-f0-9]{64}$/

function invalid(): Error {
  return new Error('OWNED_DOCKER_OBSERVED_V2_INVALID')
}

/**
 * Preserve the immutable full-inspect V1 hash and add the reviewed selected
 * V2 create projection from the same genuine container inspect document.
 */
export function normalizeOwnedDockerContainerInspectV2(
  document: unknown,
): OwnedDockerObservedResourceV2 {
  const legacy = normalizeOwnedDockerContainerInspect(document)
  const selected = normalizeOwnedDockerContainerInspectProjectionV2(document)
  if (selected.sidecarKind !== legacy.labels.sidecarKind || selected.role !== legacy.labels.role) {
    throw invalid()
  }
  return Object.freeze({
    version: 2,
    objectId: legacy.objectId,
    resourceKind: 'container',
    name: legacy.name,
    labels: legacy.labels,
    createProjectionContract: 'container-selected-v2',
    createProjectionHash: selected.projectionHash,
    projectionHashV1: legacy.projectionHash,
    networkEndpointCount: null,
  })
}

/** Networks retain their full V1 projection as both create and bound evidence. */
export function normalizeOwnedDockerNetworkInspectV2(
  document: unknown,
): OwnedDockerObservedResourceV2 {
  const legacy = normalizeOwnedDockerNetworkInspect(document)
  return Object.freeze({
    version: 2,
    objectId: legacy.objectId,
    resourceKind: 'network',
    name: legacy.name,
    labels: legacy.labels,
    createProjectionContract: 'network-full-v1',
    createProjectionHash: legacy.projectionHash,
    projectionHashV1: legacy.projectionHash,
    networkEndpointCount: legacy.networkEndpointCount,
  })
}

function descriptors(value: unknown): PropertyDescriptorMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const result = Object.getOwnPropertyDescriptors(value)
  const expected = [
    'version', 'objectId', 'resourceKind', 'name', 'labels', 'createProjectionContract',
    'createProjectionHash', 'projectionHashV1', 'networkEndpointCount',
  ].sort()
  const actual = Reflect.ownKeys(result)
  if (actual.some(key => typeof key !== 'string') || actual.length !== expected.length ||
    (actual as string[]).sort().some((key, index) => key !== expected[index])) throw invalid()
  for (const descriptor of Object.values(result)) {
    if (!('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
  }
  return result
}

/** Descriptor-only snapshot for a V4 ledger/recovery ownership proof. */
export function snapshotExpectedOwnedDockerResourceV2(
  value: unknown,
): OwnedDockerObservedResourceV2 {
  try {
    const values = descriptors(value)
    const projectionHashV1 = values['projectionHashV1']!.value as unknown
    const createProjectionContract = values['createProjectionContract']!.value as unknown
    const createProjectionHash = values['createProjectionHash']!.value as unknown
    if (typeof projectionHashV1 !== 'string' || !HASH.test(projectionHashV1) ||
      typeof createProjectionHash !== 'string' || !HASH.test(createProjectionHash) ||
      (createProjectionContract !== 'container-selected-v2' &&
        createProjectionContract !== 'network-full-v1')) throw invalid()
    const legacy = snapshotExpectedOwnedDockerResource({
      version: 1,
      objectId: values['objectId']!.value,
      resourceKind: values['resourceKind']!.value,
      name: values['name']!.value,
      labels: values['labels']!.value,
      projectionHash: projectionHashV1,
      networkEndpointCount: values['networkEndpointCount']!.value,
    })
    if (values['version']!.value !== 2 ||
      (legacy.resourceKind === 'container') !== (createProjectionContract === 'container-selected-v2') ||
      (createProjectionContract === 'network-full-v1' && createProjectionHash !== projectionHashV1)) {
      throw invalid()
    }
    return Object.freeze({
      version: 2,
      objectId: legacy.objectId,
      resourceKind: legacy.resourceKind,
      name: legacy.name,
      labels: legacy.labels,
      createProjectionContract: createProjectionContract as OwnedDockerCreateProjectionContractV1,
      createProjectionHash,
      projectionHashV1,
      networkEndpointCount: legacy.networkEndpointCount,
    })
  } catch {
    throw invalid()
  }
}

export function ownedDockerObservedResourcesV2Equal(
  left: OwnedDockerObservedResourceV2,
  right: OwnedDockerObservedResourceV2,
): boolean {
  const a = left.labels
  const b = right.labels
  return left.version === right.version && left.objectId === right.objectId &&
    left.resourceKind === right.resourceKind && left.name === right.name &&
    left.createProjectionContract === right.createProjectionContract &&
    left.createProjectionHash === right.createProjectionHash &&
    left.projectionHashV1 === right.projectionHashV1 &&
    left.networkEndpointCount === right.networkEndpointCount &&
    a.version === b.version && a.installationId === b.installationId &&
    a.ownerBindingHash === b.ownerBindingHash && a.sessionBindingHash === b.sessionBindingHash &&
    a.operationBindingHash === b.operationBindingHash && a.sidecarKind === b.sidecarKind &&
    a.role === b.role && a.policyHash === b.policyHash
}

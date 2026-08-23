// Dormant Docker CLI adapter for the ADR-0089 semantic ownership port. It
// never logs Docker output and never treats a generic CLI failure as absence.

import { isRestrictedCloneDockerVersionCompatible } from '@aisy/core'

import {
  type OwnedDockerCommandPort,
  type OwnedDockerInspectResult,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerRemoveResult,
  type OwnedDockerResourceKind,
  type OwnedDockerScanResult,
} from './execution-owned-docker-resources.js'
import {
  hashExpectedOwnedDockerContainerProjection as hashNormalizedContainerProjection,
  hashExpectedOwnedDockerNetworkProjection as hashNormalizedNetworkProjection,
  OWNED_DOCKER_LABEL_KEYS_V1,
  type ExpectedOwnedDockerContainerProjectionV1,
  type ExpectedOwnedDockerNetworkProjectionV1,
} from './execution-owned-docker-normalization.js'
import {
  normalizeOwnedDockerContainerInspectV2,
  normalizeOwnedDockerNetworkInspectV2,
} from './execution-owned-docker-observed-v2.js'
import {
  makeNodeDockerCommandPort,
  type DockerCommandPort,
  type DockerCommandResult,
} from './restricted-clone-docker-supervisor.js'

const HASH = /^[a-f0-9]{64}$/
const OBJECT_ID = /^[a-f0-9]{64}$/
const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const SERVER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const MAX_CONTROL_BYTES = 256 * 1024
const MAX_LIST_BYTES = 256 * 1024
const MAX_INSPECT_BYTES = 1024 * 1024
const MAX_SCAN_RESOURCES = 4096
const COMMAND_TIMEOUT_MS = 10_000
const LABEL_KEYS = OWNED_DOCKER_LABEL_KEYS_V1

const CONTAINER_INSPECT_FORMAT =
  '[{{json .Id}},{{json .Name}},{{json .Image}},{{json .Config}},{{json .HostConfig}},{{json .Mounts}}]'
const NETWORK_INSPECT_FORMAT =
  '[{{json .Id}},{{json .Name}},{{json .Driver}},{{json .Internal}},{{json .Attachable}},{{json .Ingress}},{{json .EnableIPv6}},{{json .Options}},{{json .IPAM}},{{json .Labels}},{{json .Containers}}]'
const ID_FORMAT = '{{json .ID}}'

export type OwnedDockerCliAdapterErrorCode = 'OWNED_DOCKER_CLI_INPUT_INVALID'

export class OwnedDockerCliAdapterError extends Error {
  constructor(readonly code: OwnedDockerCliAdapterErrorCode) {
    super(code)
    this.name = 'OwnedDockerCliAdapterError'
  }
}

export interface OwnedDockerCliEndpointBindingV1 {
  readonly version: 1
  /** Hash of the separately attested executable/socket endpoint binding. */
  readonly endpointBindingHash: string
  readonly serverVersion: string
  readonly serverId: string
}

export interface OwnedDockerCliCommandResult extends DockerCommandResult {
  /** May only be set from a typed Docker Engine 404, never from stderr text. */
  readonly dockerErrorCode?: 'object-not-found'
}

export interface OwnedDockerCliCommandPort extends Omit<DockerCommandPort, 'run'> {
  run(args: readonly string[], options: Readonly<{
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
  }>): Promise<OwnedDockerCliCommandResult>
}

/**
 * MUTATING TRUST BOUNDARY. This semantic port is coordinator-only and must
 * never be exposed to a child, sidecar, tool, model-facing registry or plugin.
 * A same-installation inspect followed by remove is merely a coordinator
 * implementation detail; it is not public removal authority.
 */
export interface ExecutionOwnedDockerCliAdapter extends OwnedDockerCommandPort {
  readonly endpointBindingHash: string
}

/**
 * Exact post-normalization Docker inspect semantics expected for a container.
 * The caller must omit the generated name and all eight ownership labels.
 * Sensitive values may be present here transiently; this builder returns only
 * an opaque hash and never includes them in an error.
 *
 * Raw create argv is not sufficient: image defaults, daemon defaults, mount
 * normalization and array ordering must match the pinned daemon's inspect
 * representation exactly.
 */
export type { ExpectedOwnedDockerContainerProjectionV1 }

/** Exact immutable network semantics; live endpoint membership is separate. */
export type { ExpectedOwnedDockerNetworkProjectionV1 }

interface CommandOutcome {
  readonly result: OwnedDockerCliCommandResult
  readonly clean: boolean
}

function commandResult(value: unknown): OwnedDockerCliCommandResult | null {
  const record = plainRecord(value)
  if (record === null) return null
  const descriptors = Object.getOwnPropertyDescriptors(record)
  const allowed = new Set([
    'exitCode', 'stdout', 'stderr', 'timedOut', 'aborted', 'overflow', 'dockerErrorCode',
  ])
  if (!['exitCode', 'stdout', 'stderr'].every(key => key in descriptors) ||
    Object.keys(descriptors).some(key => !allowed.has(key))) return null
  for (const descriptor of Object.values(descriptors)) {
    if (!('value' in descriptor) || descriptor.enumerable !== true) return null
  }
  if (!Number.isSafeInteger(record['exitCode']) || Number(record['exitCode']) < 0 ||
    Number(record['exitCode']) > 255 || typeof record['stdout'] !== 'string' ||
    typeof record['stderr'] !== 'string' ||
    ['timedOut', 'aborted', 'overflow'].some(key =>
      record[key] !== undefined && typeof record[key] !== 'boolean') ||
    (record['dockerErrorCode'] !== undefined && record['dockerErrorCode'] !== 'object-not-found')) {
    return null
  }
  return record as unknown as OwnedDockerCliCommandResult
}

function certainObjectNotFound(outcome: CommandOutcome | null, maximumBytes: number): boolean {
  if (outcome === null) return false
  const result = outcome.result
  return result.dockerErrorCode === 'object-not-found' && result.exitCode === 1 &&
    result.stdout === '' && result.timedOut !== true && result.aborted !== true &&
    result.overflow !== true &&
    Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8') <= maximumBytes
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : null
}

function exactInput(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = plainRecord(value)
  if (record === null || Object.getOwnPropertySymbols(record).length !== 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(record)
  const actual = Object.keys(descriptors).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null
  for (const key of actual) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return null
  }
  return record
}

function parseJson(text: string, maximumBytes: number): unknown {
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw new Error()
  return JSON.parse(text)
}

function parseJsonString(text: string): string {
  const value = parseJson(text.trim(), MAX_CONTROL_BYTES)
  if (typeof value !== 'string') throw new Error()
  return value
}

export function hashExpectedOwnedDockerContainerProjection(
  input: ExpectedOwnedDockerContainerProjectionV1,
): string {
  try {
    return hashNormalizedContainerProjection(input)
  } catch {
    throw new OwnedDockerCliAdapterError('OWNED_DOCKER_CLI_INPUT_INVALID')
  }
}

export function hashExpectedOwnedDockerNetworkProjection(
  input: ExpectedOwnedDockerNetworkProjectionV1,
): string {
  try {
    return hashNormalizedNetworkProjection(input)
  } catch {
    throw new OwnedDockerCliAdapterError('OWNED_DOCKER_CLI_INPUT_INVALID')
  }
}

function containerObserved(raw: string): OwnedDockerObservedResourceV2 {
  const envelope = parseJson(raw.trim(), MAX_INSPECT_BYTES)
  if (!Array.isArray(envelope) || envelope.length !== 6) throw new Error()
  return normalizeOwnedDockerContainerInspectV2({
    Id: envelope[0],
    Name: envelope[1],
    Image: envelope[2],
    Config: envelope[3],
    HostConfig: envelope[4],
    Mounts: envelope[5],
  })
}

function networkObserved(raw: string): OwnedDockerObservedResourceV2 {
  const envelope = parseJson(raw.trim(), MAX_INSPECT_BYTES)
  if (!Array.isArray(envelope) || envelope.length !== 11) throw new Error()
  return normalizeOwnedDockerNetworkInspectV2({
    Id: envelope[0],
    Name: envelope[1],
    Driver: envelope[2],
    Internal: envelope[3],
    Attachable: envelope[4],
    Ingress: envelope[5],
    EnableIPv6: envelope[6],
    Options: envelope[7],
    IPAM: envelope[8],
    Labels: envelope[9],
    Containers: envelope[10],
  })
}

function inspectArgs(resourceKind: OwnedDockerResourceKind, target: string): readonly string[] {
  return resourceKind === 'container'
    ? ['inspect', '--type=container', `--format=${CONTAINER_INSPECT_FORMAT}`, target]
    : ['inspect', '--type=network', `--format=${NETWORK_INSPECT_FORMAT}`, target]
}

function listArgs(input: {
  resourceKind: OwnedDockerResourceKind
  filter: string
}): readonly string[] {
  return input.resourceKind === 'container'
    ? ['container', 'ls', '--all', '--no-trunc', `--filter=${input.filter}`, `--format=${ID_FORMAT}`]
    : ['network', 'ls', '--no-trunc', `--filter=${input.filter}`, `--format=${ID_FORMAT}`]
}

function parseIdLines(raw: string): readonly string[] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_LIST_BYTES) throw new Error()
  if (raw === '') return []
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > MAX_SCAN_RESOURCES) throw new Error()
  const ids = lines.map(line => parseJsonString(line))
  if (ids.some(id => !OBJECT_ID.test(id)) || new Set(ids).size !== ids.length) throw new Error()
  return Object.freeze(ids)
}

function validBinding(value: unknown): value is OwnedDockerCliEndpointBindingV1 {
  const record = exactInput(value, ['version', 'endpointBindingHash', 'serverVersion', 'serverId'])
  return record !== null && record['version'] === 1 &&
    typeof record['endpointBindingHash'] === 'string' && HASH.test(record['endpointBindingHash']) &&
    typeof record['serverVersion'] === 'string' && SERVER_VERSION.test(record['serverVersion']) &&
    isRestrictedCloneDockerVersionCompatible(record['serverVersion']) &&
    typeof record['serverId'] === 'string' && SERVER_ID.test(record['serverId'])
}

export function makeExecutionOwnedDockerCliAdapter(input: Readonly<{
  runner: OwnedDockerCliCommandPort
  installationId: string
  binding: OwnedDockerCliEndpointBindingV1
}>): ExecutionOwnedDockerCliAdapter {
  const inputRecord = exactInput(input, ['runner', 'installationId', 'binding'])
  if (inputRecord === null || typeof inputRecord['runner'] !== 'object' || inputRecord['runner'] === null ||
    typeof (inputRecord['runner'] as OwnedDockerCliCommandPort).run !== 'function' ||
    typeof inputRecord['installationId'] !== 'string' || !HASH.test(inputRecord['installationId']) ||
    !validBinding(inputRecord['binding'])) throw new OwnedDockerCliAdapterError('OWNED_DOCKER_CLI_INPUT_INVALID')
  const runner = inputRecord['runner'] as OwnedDockerCliCommandPort
  const installationId = inputRecord['installationId']
  const binding = Object.freeze({ ...inputRecord['binding'] }) as OwnedDockerCliEndpointBindingV1
  const removable = new Set<string>()

  const run = async (args: readonly string[], maxOutputBytes: number): Promise<CommandOutcome | null> => {
    try {
      const result = commandResult(await runner.run(args, { timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes }))
      if (result === null) return null
      const bytes = Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8')
      return {
        result,
        clean: result.exitCode === 0 && result.timedOut !== true && result.aborted !== true &&
          result.overflow !== true && result.stderr === '' && bytes <= maxOutputBytes,
      }
    } catch {
      return null
    }
  }

  const inspect = async (
    resourceKind: OwnedDockerResourceKind,
    target: string,
  ): Promise<OwnedDockerInspectResult> => {
    const outcome = await run(inspectArgs(resourceKind, target), MAX_INSPECT_BYTES)
    if (outcome?.clean === true) {
      try {
        const resource = resourceKind === 'container'
          ? containerObserved(outcome.result.stdout)
          : networkObserved(outcome.result.stdout)
        if (resource.labels.installationId === installationId) {
          removable.add(`${resourceKind}:${resource.objectId}`)
        }
        return { kind: 'found', resource }
      } catch {
        return { kind: 'ambiguous' }
      }
    }
    if (certainObjectNotFound(outcome, MAX_INSPECT_BYTES)) return { kind: 'absent' }
    return { kind: 'ambiguous' }
  }

  const adapter: ExecutionOwnedDockerCliAdapter = {
    endpointBindingHash: binding.endpointBindingHash,

    async probe() {
      const version = await run(['version', '--format={{json .Server.Version}}'], MAX_CONTROL_BYTES)
      const serverId = await run(['info', '--format={{json .ID}}'], MAX_CONTROL_BYTES)
      if (version?.clean !== true || serverId?.clean !== true) return { kind: 'ambiguous' }
      try {
        const actualVersion = parseJsonString(version.result.stdout)
        return isRestrictedCloneDockerVersionCompatible(actualVersion) &&
          actualVersion === binding.serverVersion && parseJsonString(serverId.result.stdout) === binding.serverId
          ? { kind: 'compatible' }
          : { kind: 'incompatible' }
      } catch {
        return { kind: 'ambiguous' }
      }
    },

    async scanInstallation(requestedInstallationId): Promise<OwnedDockerScanResult> {
      if (!HASH.test(requestedInstallationId) || requestedInstallationId !== installationId) {
        return { kind: 'ambiguous' }
      }
      const filter = `label=${LABEL_KEYS.installationId}=${installationId}`
      const containerList = await run(listArgs({ resourceKind: 'container', filter }), MAX_LIST_BYTES)
      const networkList = await run(listArgs({ resourceKind: 'network', filter }), MAX_LIST_BYTES)
      if (containerList?.clean !== true || networkList?.clean !== true) return { kind: 'ambiguous' }
      try {
        const containers = parseIdLines(containerList.result.stdout)
        const networks = parseIdLines(networkList.result.stdout)
        if (containers.length + networks.length > MAX_SCAN_RESOURCES ||
          new Set([...containers, ...networks]).size !== containers.length + networks.length) {
          return { kind: 'ambiguous' }
        }
        const resources: OwnedDockerObservedResourceV2[] = []
        for (const [resourceKind, ids] of [
          ['container', containers], ['network', networks],
        ] as const) {
          for (const objectId of ids) {
            const found = await adapter.inspectById({ resourceKind, objectId })
            if (found.kind !== 'found' || found.resource.labels.installationId !== installationId) {
              return { kind: 'ambiguous' }
            }
            resources.push(found.resource)
          }
        }
        return { kind: 'ok', resources: Object.freeze(resources) }
      } catch {
        return { kind: 'ambiguous' }
      }
    },

    inspectById(request): Promise<OwnedDockerInspectResult> {
      const record = exactInput(request, ['resourceKind', 'objectId'])
      if (record === null || (record['resourceKind'] !== 'container' && record['resourceKind'] !== 'network') ||
        typeof record['objectId'] !== 'string' || !OBJECT_ID.test(record['objectId'])) {
        return Promise.resolve({ kind: 'ambiguous' })
      }
      return inspect(record['resourceKind'], record['objectId'])
    },

    inspectByName(request): Promise<OwnedDockerInspectResult> {
      const record = exactInput(request, ['resourceKind', 'name'])
      if (record === null || (record['resourceKind'] !== 'container' && record['resourceKind'] !== 'network') ||
        typeof record['name'] !== 'string' || !RESOURCE_NAME.test(record['name'])) {
        return Promise.resolve({ kind: 'ambiguous' })
      }
      return inspect(record['resourceKind'], record['name'])
    },

    async removeById(request): Promise<OwnedDockerRemoveResult> {
      const record = exactInput(request, ['resourceKind', 'objectId'])
      if (record === null || (record['resourceKind'] !== 'container' && record['resourceKind'] !== 'network') ||
        typeof record['objectId'] !== 'string' || !OBJECT_ID.test(record['objectId']) ||
        !removable.has(`${record['resourceKind']}:${record['objectId']}`)) {
        return { kind: 'ambiguous' }
      }
      const args = record['resourceKind'] === 'container'
        ? ['container', 'rm', '--force', '--volumes', record['objectId']]
        : ['network', 'rm', record['objectId']]
      const outcome = await run(args, MAX_CONTROL_BYTES)
      if (outcome?.clean === true) {
        removable.delete(`${record['resourceKind']}:${record['objectId']}`)
        return { kind: 'removed' }
      }
      if (certainObjectNotFound(outcome, MAX_CONTROL_BYTES)) {
        removable.delete(`${record['resourceKind']}:${record['objectId']}`)
        return { kind: 'absent' }
      }
      return { kind: 'ambiguous' }
    },
  }
  return Object.freeze(adapter)
}

export function makeNodeExecutionOwnedDockerCliAdapter(input: Readonly<{
  dockerExecutable: string
  dockerHost?: string
  installationId: string
  binding: OwnedDockerCliEndpointBindingV1
}>): ExecutionOwnedDockerCliAdapter {
  // The current Node runner deliberately does not infer typed Docker errors
  // from stderr. Until it gains Engine-aware 404 classification, missing-object
  // inspect/remove results remain `ambiguous` and therefore fail closed.
  const runner = makeNodeDockerCommandPort({
    dockerExecutable: input.dockerExecutable,
    ...(input.dockerHost === undefined ? {} : { dockerHost: input.dockerHost }),
  })
  return makeExecutionOwnedDockerCliAdapter({ runner, installationId: input.installationId, binding: input.binding })
}

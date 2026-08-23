import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { lstatSync, realpathSync } from 'node:fs'
import {
  Agent,
  request,
  type ClientRequest,
  type ClientRequestArgs,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import type { Duplex } from 'node:stream'
import { types as utilTypes } from 'node:util'

import {
  isRestrictedCloneDockerVersionCompatible,
  isRestrictedCloneImageDigest,
} from '@aisy/core'

import {
  OWNED_DOCKER_LABEL_KEYS_V1,
} from './execution-owned-docker-normalization.js'
import {
  normalizeOwnedDockerContainerInspectV2,
  normalizeOwnedDockerNetworkInspectV2,
  ownedDockerObservedResourcesV2Equal,
  snapshotExpectedOwnedDockerResourceV2,
} from './execution-owned-docker-observed-v2.js'
import {
  dockerCodeOwnedContainerCreateSealMatchesObservedResource,
  dockerCodeOwnedContainerCreateSealMatchesWireRequest,
  type DockerCodeOwnedContainerCreateSealV1,
} from './docker-code-owned-container-create-plan.js'
import {
  assertOwnedDockerRecoveryAuthority,
  beginOwnedDockerRecoveryDispatch,
  captureOwnedDockerRecoveryAuthorityEpoch,
  commitOwnedDockerRecoveryActivationOutcomeV1,
  consumeOwnedDockerAttemptedContainerRecoveryPermitV1,
  consumeOwnedDockerAttemptedCreatePermitV1,
  consumeOwnedDockerBoundContainerUsePermitV1,
  consumeOwnedDockerRecoveryActivationPermitV1,
  consumeOwnedDockerRecoveryBoundContainerCleanupPermitV1,
  isOwnedDockerRecoveryLedger,
  mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1,
  mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1,
  mintOwnedDockerAttestedCreateOutcomeV1,
  mintOwnedDockerAttestedRecoveryActivationOutcomeV1,
  mintOwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1,
  type OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1,
  type OwnedDockerAttestedCreateDispatchOutcomeV1,
  type OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1,
  type OwnedDockerAttemptedContainerRecoveryPermitV1,
  type OwnedDockerAttemptedCreatePermitV1,
  type OwnedDockerBoundContainerUsePermitV1,
  type OwnedDockerBoundUseDescriptorV2,
  type OwnedDockerLedgerOperationV4,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerRecoveryLedger,
  type OwnedDockerRecoveryActivationPermitV1,
  type OwnedDockerRecoveryBoundContainerCleanupPermitV1,
} from './execution-owned-docker-resources.js'

export const PINNED_DOCKER_ENGINE_API_VERSION = 'v1.54' as const
export const PINNED_DOCKER_ENGINE_API_IDENTITY = '1.54' as const

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_MAX_JSON_NODES = 4_096
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_JSON_NODES = 16_384
const MAX_JSON_DEPTH = 64
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024
const MAX_RESPONSE_HEADERS = 64
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_REQUEST_JSON_NODES = 50_000
const MAX_CREATE_WARNINGS = 64
const MAX_CREATE_WARNING_BYTES = 1024
const MAX_BOUND_USE_WALL_TIME_MS = 30 * 60 * 1000
const MAX_BOUND_USE_OUTPUT_BYTES = 8 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const IMMUTABLE_CONTAINER_ID = /^[a-f0-9]{64}$/
const CREATE_CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const OBJECT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const SERVER_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/
const API_VERSION = /^1\.(0|[1-9][0-9]{0,2})$/
const SANDBOX_PROFILE_HASH_DOMAIN = 'aisy.docker-sandbox.isolation-profile.v1\0'
const SANDBOX_RUNTIME_EVIDENCE_HASH_DOMAIN = 'aisy.docker-sandbox.runtime-evidence.v1\0'
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get
const abortSignalAnyIntrinsic = AbortSignal.any
const eventTargetAddEventListenerIntrinsic = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListenerIntrinsic = EventTarget.prototype.removeEventListener
const jsonParse = JSON.parse
const jsonStringify = JSON.stringify

const pinnedSessionBrand: unique symbol = Symbol('aisy.docker-engine-pinned-session')
const pinnedSessions = new WeakSet<object>()
const pinnedImageInspectEvidenceBrand: unique symbol = Symbol(
  'aisy.docker-engine-pinned-image-inspect-evidence',
)
const pinnedImageInspectEvidence = new WeakSet<object>()
const pinnedSandboxRuntimeEvidenceBrand: unique symbol = Symbol(
  'aisy.docker-engine-pinned-sandbox-runtime-evidence',
)
const pinnedSandboxRuntimeEvidence = new WeakSet<object>()
const recoveryBrokerBrand: unique symbol = Symbol('aisy.owned-docker-engine-recovery-broker')
const recoveryBrokers = new WeakSet<object>()
const attemptedCreateRecoveryBrokerBrand: unique symbol = Symbol(
  'aisy.owned-docker-engine-attempted-create-recovery-broker',
)
const attemptedCreateRecoveryBrokers = new WeakSet<object>()
const preparedContainerCreateBrand: unique symbol = Symbol(
  'aisy.docker-engine-pinned-prepared-container-create',
)
const preparedContainerCreates = new WeakSet<object>()
const boundContainerUseBrokerBrand: unique symbol = Symbol(
  'aisy.docker-engine-bound-container-use-broker',
)
const boundContainerUseBrokers = new WeakSet<object>()

export type DockerEnginePinnedSessionErrorCode =
  | 'DOCKER_ENGINE_PINNED_INPUT_INVALID'
  | 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH'
  | 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'
  | 'DOCKER_ENGINE_PINNED_AMBIGUOUS'
  | 'DOCKER_ENGINE_PINNED_SESSION_CLOSED'
  | 'DOCKER_ENGINE_PINNED_COMMAND_ALREADY_USED'

export class DockerEnginePinnedSessionError extends Error {
  constructor(readonly code: DockerEnginePinnedSessionErrorCode) {
    super(code)
    this.name = 'DockerEnginePinnedSessionError'
  }
}

export interface DockerEnginePinnedEndpointIdentityV1 {
  readonly version: 1
  readonly endpointBindingHash: string
  readonly serverId: string
  readonly serverVersion: string
  readonly apiVersion: typeof PINNED_DOCKER_ENGINE_API_IDENTITY
}

export type DockerEnginePinnedJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DockerEnginePinnedJsonValue[]
  | DockerEnginePinnedJsonObject

export type DockerEnginePinnedJsonObject = Readonly<{
  [key: string]: DockerEnginePinnedJsonValue
}>

export type DockerEnginePinnedInspectResult =
  | Readonly<{
    outcome: 'found'
    statusCode: 200
    document: DockerEnginePinnedJsonObject
  }>
  | Readonly<{
    outcome: 'not-found'
    statusCode: 404
  }>

export interface DockerEnginePinnedImageInspectEvidenceV1 {
  readonly [pinnedImageInspectEvidenceBrand]: true
  readonly version: 1
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  readonly requestedDigest: string
  readonly document: DockerEnginePinnedJsonObject
}

export interface DockerEnginePinnedSandboxRuntimeEvidenceV1 {
  readonly [pinnedSandboxRuntimeEvidenceBrand]: true
  readonly version: 1
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  readonly runtime: 'runc' | 'runsc'
  readonly securityLevel: 'full' | 'degraded-no-gvisor'
  readonly userNamespaceMode: 'rootless' | 'userns-remap'
  readonly isolationProfileSha256: string
  readonly runtimeEvidenceHash: string
}

export type DockerEnginePinnedImageInspectResult =
  | Readonly<{
    outcome: 'found'
    statusCode: 200
    evidence: DockerEnginePinnedImageInspectEvidenceV1
  }>
  | Readonly<{
    outcome: 'not-found'
    statusCode: 404
  }>

export interface DockerEnginePinnedSession {
  readonly [pinnedSessionBrand]: true
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  inspectContainer(
    reference: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEnginePinnedInspectResult>
  inspectNetwork(
    reference: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEnginePinnedInspectResult>
  inspectImageRuntime(
    requestedDigest: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEnginePinnedImageInspectResult>
  attestSandboxRuntime(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEnginePinnedSandboxRuntimeEvidenceV1>
  close(): Promise<void>
}

export type DockerEnginePinnedContainerPlatform = 'linux/amd64' | 'linux/arm64'

export type DockerEnginePinnedPreparedContainerCreateErrorCode =
  | 'DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID'
  | 'DOCKER_ENGINE_PREPARED_CREATE_ENDPOINT_MISMATCH'
  | 'DOCKER_ENGINE_PREPARED_CREATE_DAEMON_INCOMPATIBLE'
  | 'DOCKER_ENGINE_PREPARED_CREATE_RUNTIME_MISMATCH'
  | 'DOCKER_ENGINE_PREPARED_CREATE_DAEMON_AMBIGUOUS'
  | 'DOCKER_ENGINE_PREPARED_CREATE_ABORTED'
  | 'DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS'
  | 'DOCKER_ENGINE_PREPARED_CREATE_INSPECT_MISMATCH'
  | 'DOCKER_ENGINE_PREPARED_CREATE_CLOSED'
  | 'DOCKER_ENGINE_PREPARED_CREATE_ALREADY_USED'

export class DockerEnginePinnedPreparedContainerCreateError extends Error {
  constructor(readonly code: DockerEnginePinnedPreparedContainerCreateErrorCode) {
    super(code)
    this.name = 'DockerEnginePinnedPreparedContainerCreateError'
  }
}

export type DockerEnginePinnedPreparedContainerCreateResult =
  | Readonly<{
    outcome: 'created'
    statusCode: 201
    resource: OwnedDockerObservedResourceV2
    attestedOutcome: OwnedDockerAttestedCreateDispatchOutcomeV1
  }>
  | Readonly<{
    outcome: 'image-not-found'
    statusCode: 404
  }>
  | Readonly<{
    outcome: 'conflict'
    statusCode: 409
  }>

export interface DockerEnginePinnedPreparedContainerCreate {
  readonly [preparedContainerCreateBrand]: true
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  createAndInspect(
    input: Readonly<{
      seal: DockerCodeOwnedContainerCreateSealV1
      permit: OwnedDockerAttemptedCreatePermitV1
      platform: DockerEnginePinnedContainerPlatform
      bodyJson: DockerEnginePinnedJsonObject
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEnginePinnedPreparedContainerCreateResult>
  close(): Promise<void>
}

export interface NodeDockerEnginePinnedSessionOptions {
  readonly socketPath: string
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxJsonNodes?: number
}

export interface NodeDockerEnginePinnedPreparedContainerCreateOptions
  extends NodeDockerEnginePinnedSessionOptions {
  readonly expectedRuntimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
  readonly maxRequestBytes?: number
  readonly signal?: AbortSignal
}

export type DockerEngineBoundContainerUseBrokerErrorCode =
  | 'DOCKER_ENGINE_BOUND_USE_INPUT_INVALID'
  | 'DOCKER_ENGINE_BOUND_USE_ENDPOINT_MISMATCH'
  | 'DOCKER_ENGINE_BOUND_USE_PREFLIGHT_FAILED'
  | 'DOCKER_ENGINE_BOUND_USE_ABORTED'
  | 'DOCKER_ENGINE_BOUND_USE_AUTHORITY_LOST'
  | 'DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN'
  | 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED'
  | 'DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED'
  | 'DOCKER_ENGINE_BOUND_USE_CLOSED'
  | 'DOCKER_ENGINE_BOUND_USE_ALREADY_USED'

export class DockerEngineBoundContainerUseBrokerError extends Error {
  constructor(readonly code: DockerEngineBoundContainerUseBrokerErrorCode) {
    super(code)
    this.name = 'DockerEngineBoundContainerUseBrokerError'
  }
}

export interface NodeDockerEngineBoundContainerUseBrokerOptions
  extends NodeDockerEnginePinnedSessionOptions {
  readonly wallTimeMs: number
  readonly maxOutputBytes: number
}

export interface DockerEngineBoundContainerUseResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface NodeDockerEngineBoundContainerUseBroker {
  readonly [boundContainerUseBrokerBrand]: true
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  run(
    permit: OwnedDockerBoundContainerUsePermitV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEngineBoundContainerUseResult>
  close(): Promise<void>
}

export type OwnedDockerEngineRecoveryBrokerErrorCode =
  | 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID'
  | 'OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH'
  | 'OWNED_DOCKER_RECOVERY_BROKER_DAEMON_INCOMPATIBLE'
  | 'OWNED_DOCKER_RECOVERY_BROKER_DAEMON_AMBIGUOUS'
  | 'OWNED_DOCKER_RECOVERY_BROKER_ABORTED'
  | 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST'
  | 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'
  | 'OWNED_DOCKER_RECOVERY_BROKER_NETWORK_NOT_EMPTY'
  | 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS'
  | 'OWNED_DOCKER_RECOVERY_BROKER_CLOSED'
  | 'OWNED_DOCKER_RECOVERY_BROKER_ALREADY_USED'

export class OwnedDockerEngineRecoveryBrokerError extends Error {
  constructor(readonly code: OwnedDockerEngineRecoveryBrokerErrorCode) {
    super(code)
    this.name = 'OwnedDockerEngineRecoveryBrokerError'
  }
}

export interface NodeOwnedDockerEngineRecoveryBrokerOptions
  extends NodeDockerEnginePinnedSessionOptions {
  readonly authority: OwnedDockerRecoveryLedger
}

export interface NodeOwnedDockerEngineRecoveryBroker {
  readonly [recoveryBrokerBrand]: true
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  removeExact(
    expected: OwnedDockerObservedResourceV2,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<'removed' | 'absent'>
  removeBoundContainer(
    permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1>
  activateAfterInstallationZero(
    permit: OwnedDockerRecoveryActivationPermitV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<void>
  close(): Promise<void>
}

export type OwnedDockerEngineAttemptedCreateRecoveryBrokerErrorCode =
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ENDPOINT_MISMATCH'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_INCOMPATIBLE'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_AMBIGUOUS'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_CLOSED'
  | 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ALREADY_USED'

export class OwnedDockerEngineAttemptedCreateRecoveryBrokerError extends Error {
  constructor(readonly code: OwnedDockerEngineAttemptedCreateRecoveryBrokerErrorCode) {
    super(code)
    this.name = 'OwnedDockerEngineAttemptedCreateRecoveryBrokerError'
  }
}

export interface NodeOwnedDockerEngineAttemptedCreateRecoveryBrokerOptions
  extends NodeDockerEnginePinnedSessionOptions {
  readonly authority: OwnedDockerRecoveryLedger
}

export interface NodeOwnedDockerEngineAttemptedCreateRecoveryBroker {
  readonly [attemptedCreateRecoveryBrokerBrand]: true
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  inspectExact(
    permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1>
  close(): Promise<void>
}

interface SocketAnchor {
  readonly canonicalPath: string
  readonly dev: string
  readonly ino: string
  readonly uid: string
  readonly gid: string
  readonly mode: string
  readonly bindingHash: string
}

interface Policy {
  readonly socketPath: string
  readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxJsonNodes: number
}

interface BoundContainerUsePolicy extends Policy {
  readonly wallTimeMs: number
  readonly maxOutputBytes: number
}

interface RawResponse {
  readonly statusCode: number
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

function intrinsicSignalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false
  if (abortSignalAbortedGetter === undefined) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  const value = Reflect.apply(abortSignalAbortedGetter, signal, []) as unknown
  if (typeof value !== 'boolean') throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  return value
}

function addIntrinsicAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (signal === undefined) return
  Reflect.apply(eventTargetAddEventListenerIntrinsic, signal, [
    'abort', listener, Object.freeze({ once: true }),
  ])
}

function removeIntrinsicAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  if (signal === undefined) return
  Reflect.apply(eventTargetRemoveEventListenerIntrinsic, signal, ['abort', listener])
}

function pinnedRequestSignal(
  options: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  if (options === undefined) return undefined
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => key !== 'signal') || ownKeys.length > 1 ||
    ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const signal = descriptors['signal']?.value as unknown
  if (signal === undefined) return undefined
  try {
    if (signal === null || typeof signal !== 'object' || abortSignalAbortedGetter === undefined ||
      typeof Reflect.apply(abortSignalAbortedGetter, signal, []) !== 'boolean') {
      throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
    }
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  return signal as AbortSignal
}

function fail(code: DockerEnginePinnedSessionErrorCode): DockerEnginePinnedSessionError {
  return new DockerEnginePinnedSessionError(code)
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number | null {
  const candidate = value ?? fallback
  return Number.isSafeInteger(candidate) && candidate > 0 && candidate <= maximum
    ? candidate
    : null
}

function validSocketPath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && value !== '/' &&
    !value.endsWith('/') && !value.includes('\0')
}

function readSocketAnchor(socketPath: string): SocketAnchor {
  try {
    const configuredStats = lstatSync(socketPath, { bigint: true })
    const canonicalPath = realpathSync.native(socketPath)
    const canonicalStats = lstatSync(canonicalPath, { bigint: true })
    if (canonicalPath !== socketPath || !configuredStats.isSocket() || !canonicalStats.isSocket() ||
      configuredStats.dev !== canonicalStats.dev || configuredStats.ino !== canonicalStats.ino ||
      (configuredStats.mode & 0o002n) !== 0n) {
      throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
    }
    const anchor = {
      version: 1,
      canonicalPath,
      dev: configuredStats.dev.toString(10),
      ino: configuredStats.ino.toString(10),
      uid: configuredStats.uid.toString(10),
      gid: configuredStats.gid.toString(10),
      mode: configuredStats.mode.toString(8),
    }
    return Object.freeze({
      ...anchor,
      bindingHash: createHash('sha256').update(JSON.stringify(anchor)).digest('hex'),
    })
  } catch (error) {
    if (error instanceof DockerEnginePinnedSessionError) throw error
    throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
  }
}

export function computeDockerEngineUnixSocketBindingHash(socketPath: string): string {
  if (typeof socketPath !== 'string' || !validSocketPath(socketPath)) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  return readSocketAnchor(socketPath).bindingHash
}

function exactIdentity(value: DockerEnginePinnedEndpointIdentityV1): DockerEnginePinnedEndpointIdentityV1 {
  let descriptors: PropertyDescriptorMap
  try {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
      throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const expected = ['version', 'endpointBindingHash', 'serverId', 'serverVersion', 'apiVersion'] as const
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== expected.length || ownKeys.some(key => typeof key !== 'string') ||
    expected.some(key => {
      const descriptor = descriptors[key]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const version = descriptors['version']!.value as unknown
  const endpointBindingHash = descriptors['endpointBindingHash']!.value as unknown
  const serverId = descriptors['serverId']!.value as unknown
  const serverVersion = descriptors['serverVersion']!.value as unknown
  const apiVersion = descriptors['apiVersion']!.value as unknown
  if (version !== 1 || typeof endpointBindingHash !== 'string' || !HASH.test(endpointBindingHash) ||
    typeof serverId !== 'string' || !SERVER_ID.test(serverId) ||
    typeof serverVersion !== 'string' || !SERVER_VERSION.test(serverVersion) ||
    !isRestrictedCloneDockerVersionCompatible(serverVersion) ||
    apiVersion !== PINNED_DOCKER_ENGINE_API_IDENTITY) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  return Object.freeze({
    version: 1,
    endpointBindingHash,
    serverId,
    serverVersion,
    apiVersion: PINNED_DOCKER_ENGINE_API_IDENTITY,
  })
}

function makePolicy(options: NodeDockerEnginePinnedSessionOptions): Policy {
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const required = ['socketPath', 'endpointIdentity'] as const
  const optional = ['timeoutMs', 'maxResponseBytes', 'maxJsonNodes'] as const
  const allowed = new Set<string>([...required, ...optional])
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => descriptors[key] === undefined) ||
    ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const socketPath = descriptors['socketPath']!.value as unknown
  const endpointIdentity = descriptors['endpointIdentity']!.value as unknown
  const timeoutValue = descriptors['timeoutMs']?.value as unknown
  const responseBytesValue = descriptors['maxResponseBytes']?.value as unknown
  const jsonNodesValue = descriptors['maxJsonNodes']?.value as unknown
  if (typeof socketPath !== 'string' || !validSocketPath(socketPath) ||
    (descriptors['timeoutMs'] !== undefined && typeof timeoutValue !== 'number') ||
    (descriptors['maxResponseBytes'] !== undefined && typeof responseBytesValue !== 'number') ||
    (descriptors['maxJsonNodes'] !== undefined && typeof jsonNodesValue !== 'number')) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  const timeoutMs = boundedInteger(
    descriptors['timeoutMs'] === undefined ? undefined : timeoutValue as number,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  const maxResponseBytes = boundedInteger(
    descriptors['maxResponseBytes'] === undefined ? undefined : responseBytesValue as number,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  )
  const maxJsonNodes = boundedInteger(
    descriptors['maxJsonNodes'] === undefined ? undefined : jsonNodesValue as number,
    DEFAULT_MAX_JSON_NODES,
    MAX_JSON_NODES,
  )
  if (timeoutMs === null || maxResponseBytes === null || maxJsonNodes === null) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  return Object.freeze({
    socketPath,
    endpointIdentity: exactIdentity(endpointIdentity as DockerEnginePinnedEndpointIdentityV1),
    timeoutMs,
    maxResponseBytes,
    maxJsonNodes,
  })
}

function boundUseFail(
  code: DockerEngineBoundContainerUseBrokerErrorCode,
): DockerEngineBoundContainerUseBrokerError {
  return new DockerEngineBoundContainerUseBrokerError(code)
}

function makeBoundContainerUsePolicy(
  options: NodeDockerEngineBoundContainerUseBrokerOptions,
): BoundContainerUsePolicy {
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
  }
  const required = ['socketPath', 'endpointIdentity', 'wallTimeMs', 'maxOutputBytes'] as const
  const optional = ['timeoutMs', 'maxResponseBytes', 'maxJsonNodes'] as const
  const allowed = new Set<string>([...required, ...optional])
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => descriptors[key] === undefined) ||
    ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
  }
  const wallTimeMs = descriptors['wallTimeMs']!.value as unknown
  const maxOutputBytes = descriptors['maxOutputBytes']!.value as unknown
  if (typeof wallTimeMs !== 'number' || typeof maxOutputBytes !== 'number' ||
    boundedInteger(wallTimeMs, wallTimeMs, MAX_BOUND_USE_WALL_TIME_MS) === null ||
    boundedInteger(maxOutputBytes, maxOutputBytes, MAX_BOUND_USE_OUTPUT_BYTES) === null) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
  }
  let base: Policy
  try {
    base = makePolicy(Object.freeze({
      socketPath: descriptors['socketPath']!.value,
      endpointIdentity: descriptors['endpointIdentity']!.value,
      ...(descriptors['timeoutMs'] === undefined
        ? {} : { timeoutMs: descriptors['timeoutMs']!.value }),
      ...(descriptors['maxResponseBytes'] === undefined
        ? {} : { maxResponseBytes: descriptors['maxResponseBytes']!.value }),
      ...(descriptors['maxJsonNodes'] === undefined
        ? {} : { maxJsonNodes: descriptors['maxJsonNodes']!.value }),
    }) as NodeDockerEnginePinnedSessionOptions)
  } catch {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
  }
  return Object.freeze({ ...base, wallTimeMs, maxOutputBytes })
}

class SingleSocketAgent extends Agent {
  #issued = false

  constructor(private readonly pinnedSocket: Socket) {
    super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 1 })
  }

  override createConnection(
    _options: ClientRequestArgs,
    _callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex {
    if (this.#issued) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    this.#issued = true
    return this.pinnedSocket
  }
}

class PinnedGeneration {
  readonly agent: SingleSocketAgent
  private clientDrain = false
  private broken = false

  constructor(
    readonly socket: Socket,
    readonly anchor: SocketAnchor,
    private readonly policy: Policy,
  ) {
    this.agent = new SingleSocketAgent(socket)
    socket.on('error', () => { if (!this.clientDrain) this.broken = true })
    socket.on('end', () => { if (!this.clientDrain) this.broken = true })
    socket.on('close', () => { if (!this.clientDrain) this.broken = true })
  }

  assertUsable(): void {
    if (this.broken || this.socket.destroyed || this.socket.readableEnded ||
      readSocketAnchor(this.policy.socketPath).bindingHash !== this.anchor.bindingHash) {
      throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    }
  }

  poison(): void {
    if (this.clientDrain) return
    this.broken = true
    this.agent.destroy()
    this.socket.destroy()
  }

  drain(): void {
    if (this.clientDrain) return
    this.clientDrain = true
    this.agent.destroy()
    this.socket.destroy()
  }

  async drainAndWait(): Promise<void> {
    if (this.socket.closed) {
      this.drain()
      return
    }
    const closed = new Promise<void>(resolve => {
      this.socket.once('close', () => resolve())
    })
    this.drain()
    await closed
  }
}

function connectPinned(
  policy: Policy,
  anchor: SocketAnchor,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<PinnedGeneration> {
  return new Promise((resolve, reject) => {
    const isAborted = (): boolean => intrinsicSignalAborted(signal)
    if (isAborted() || deadline <= Date.now()) {
      reject(fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
      return
    }
    const socket = createConnection({ path: policy.socketPath })
    let settled = false
    const finish = (error?: DockerEnginePinnedSessionError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      socket.off('close', onClose)
      removeIntrinsicAbortListener(signal, onAbort)
      if (error !== undefined) {
        socket.destroy()
        reject(error)
      }
    }
    const onConnect = (): void => {
      try {
        const connectedAnchor = readSocketAnchor(policy.socketPath)
        if (connectedAnchor.bindingHash !== anchor.bindingHash) {
          finish(fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH'))
          return
        }
        finish()
        resolve(new PinnedGeneration(socket, anchor, policy))
      } catch {
        finish(fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH'))
      }
    }
    const onError = (): void => finish(fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
    const onClose = (): void => finish(fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
    const onAbort = (): void => finish(fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
    const timer = setTimeout(
      () => finish(fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')),
      Math.max(1, deadline - Date.now()),
    )
    timer.unref()
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('close', onClose)
    addIntrinsicAbortListener(signal, onAbort)
    if (isAborted()) onAbort()
  })
}

function responseContentLength(response: IncomingMessage): number | null {
  const raw = response.headers['content-length']
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  return value
}

function headerHasToken(value: string | readonly string[] | undefined, token: string): boolean {
  const values = typeof value === 'string' ? [value] : value ?? []
  return values.some(item => item.split(',').some(part => part.trim().toLowerCase() === token))
}

function exchange(
  generation: PinnedGeneration,
  policy: Policy,
  path: string,
  method: 'GET' | 'DELETE' | 'POST' = 'GET',
  requestBody?: Buffer,
  overrides?: Readonly<{
    maxResponseBytes?: number
    timeoutMs?: number
    accept?: string
  }>,
): Promise<RawResponse> {
  const maxResponseBytes = overrides?.maxResponseBytes ?? policy.maxResponseBytes
  const timeoutMs = overrides?.timeoutMs ?? policy.timeoutMs
  const accept = overrides?.accept ?? 'application/json'
  if ((method !== 'POST' && requestBody !== undefined) ||
    (requestBody !== undefined && requestBody.byteLength > MAX_REQUEST_BYTES) ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_BOUND_USE_OUTPUT_BYTES ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
    timeoutMs > MAX_BOUND_USE_WALL_TIME_MS || typeof accept !== 'string' || accept.length === 0) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  generation.assertUsable()
  return new Promise((resolve, reject) => {
    let clientRequest: ClientRequest | null = null
    let settled = false
    const chunks: Buffer[] = []
    let received = 0
    const finish = (value: RawResponse | null, error?: DockerEnginePinnedSessionError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) {
        generation.poison()
        reject(error)
      } else if (value !== null) {
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      clientRequest?.destroy()
      finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
    }, timeoutMs)
    timer.unref()

    try {
      const headers: Record<string, string | number> = {
        accept,
        connection: 'keep-alive',
      }
      if (requestBody !== undefined) {
        headers['content-type'] = 'application/json'
        headers['content-length'] = requestBody.byteLength
      }
      clientRequest = request({
        method,
        socketPath: policy.socketPath,
        path,
        agent: generation.agent,
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        headers,
      }, response => {
        if (response.rawHeaders.length % 2 !== 0 ||
          response.rawHeaders.length / 2 > MAX_RESPONSE_HEADERS) {
          response.destroy()
          finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
          return
        }
        if (headerHasToken(response.headers.connection, 'close')) {
          response.destroy()
          finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
          return
        }
        let contentLength: number | null
        try {
          contentLength = responseContentLength(response)
        } catch {
          response.destroy()
          finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
          return
        }
        if (contentLength !== null && contentLength > maxResponseBytes) {
          response.destroy()
          finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
          return
        }
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += bytes.byteLength
          if (received > maxResponseBytes) {
            response.destroy()
            clientRequest?.destroy()
            finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
            return
          }
          chunks.push(bytes)
        })
        response.once('aborted', () => finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')))
        response.once('error', () => finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')))
        response.once('end', () => {
          if (settled) return
          if (response.rawTrailers.length % 2 !== 0 ||
            response.rawTrailers.length / 2 > MAX_RESPONSE_HEADERS ||
            !response.complete || (contentLength !== null && contentLength !== received) ||
            response.statusCode === undefined) {
            finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
            return
          }
          try {
            generation.assertUsable()
          } catch {
            finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
            return
          }
          finish(Object.freeze({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks, received),
          }))
        })
      })
      // Do not let Node silently truncate: validate the complete raw header block above.
      clientRequest.maxHeadersCount = 0
      clientRequest.once('socket', socket => {
        if (socket !== generation.socket) {
          clientRequest?.destroy()
          finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
        }
      })
      clientRequest.once('error', () => finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')))
      clientRequest.end(requestBody)
    } catch {
      clientRequest?.destroy()
      finish(null, fail('DOCKER_ENGINE_PINNED_AMBIGUOUS'))
    }
  })
}

function isJsonResponse(response: RawResponse): boolean {
  const contentType = response.headers['content-type']
  return typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function parseBoundedObject(response: RawResponse, maxNodes: number): DockerEnginePinnedJsonObject {
  if (!isJsonResponse(response)) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  }
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: parsed, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > maxNodes || current.depth > MAX_JSON_DEPTH) {
      throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    }
    if (current.value !== null && typeof current.value === 'object') {
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>)
      if (children.length + pending.length > maxNodes - nodes) {
        throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
      }
      for (const value of children) pending.push({ value, depth: current.depth + 1 })
      Object.freeze(current.value)
    }
  }
  return Object.freeze(parsed as DockerEnginePinnedJsonObject)
}

function apiMinor(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = API_VERSION.exec(value)
  return match === null ? null : Number(match[1])
}

function attestVersion(document: DockerEnginePinnedJsonObject, policy: Policy): void {
  const version = document['Version']
  const maximum = apiMinor(document['ApiVersion'])
  const minimum = apiMinor(document['MinAPIVersion'])
  if (typeof version !== 'string' || !SERVER_VERSION.test(version) ||
    !isRestrictedCloneDockerVersionCompatible(version)) {
    throw fail('DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE')
  }
  if (version !== policy.endpointIdentity.serverVersion) {
    throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
  }
  if (maximum === null || minimum === null || minimum > 54 || maximum < 54) {
    throw fail('DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE')
  }
}

function attestInfo(document: DockerEnginePinnedJsonObject, policy: Policy): void {
  if (document['ID'] !== policy.endpointIdentity.serverId ||
    document['ServerVersion'] !== policy.endpointIdentity.serverVersion) {
    throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
  }
}

function framedDigest(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(domain)
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes).update('\0')
  }
  return hash.digest('hex')
}

function sandboxRuntimeEvidence(
  document: DockerEnginePinnedJsonObject,
  policy: Policy,
): DockerEnginePinnedSandboxRuntimeEvidenceV1 {
  attestInfo(document, policy)
  const securityOptions = document['SecurityOptions']
  const runtimes = document['Runtimes']
  if (!Array.isArray(securityOptions) || securityOptions.length === 0 ||
    securityOptions.length > 64 || securityOptions.some(value =>
      typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512) ||
    runtimes === null || typeof runtimes !== 'object' || Array.isArray(runtimes) ||
    utilTypes.isProxy(runtimes) || Object.getPrototypeOf(runtimes) !== Object.prototype) {
    throw fail('DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE')
  }
  const runtimeDescriptors = Object.getOwnPropertyDescriptors(runtimes)
  const hasRuntime = (name: 'runc' | 'runsc'): boolean => {
    const descriptor = runtimeDescriptors[name]
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      return false
    }
    const value = descriptor.value as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
  }
  const hasSeccomp = securityOptions.includes('name=seccomp,profile=builtin')
  const rootless = securityOptions.includes('name=rootless')
  const usernsRemap = securityOptions.includes('name=userns')
  if (!hasSeccomp || (!rootless && !usernsRemap) || (!hasRuntime('runsc') && !hasRuntime('runc'))) {
    throw fail('DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE')
  }
  const runtime = hasRuntime('runsc') ? 'runsc' as const : 'runc' as const
  const securityLevel = runtime === 'runsc' ? 'full' as const : 'degraded-no-gvisor' as const
  const userNamespaceMode = rootless ? 'rootless' as const : 'userns-remap' as const
  const isolationProfileSha256 = framedDigest(SANDBOX_PROFILE_HASH_DOMAIN, [
    'version=1', `runtime=${runtime}`, `securityLevel=${securityLevel}`,
    `userNamespaceMode=${userNamespaceMode}`, 'network=none', 'readonlyRootfs=true',
    'privileged=false', 'capDrop=ALL', 'noNewPrivileges=true', 'seccomp=builtin',
    'ipc=none', 'cgroupns=private', 'userns=daemon-owned',
  ])
  const runtimeEvidenceHash = framedDigest(SANDBOX_RUNTIME_EVIDENCE_HASH_DOMAIN, [
    policy.endpointIdentity.endpointBindingHash,
    policy.endpointIdentity.serverId,
    policy.endpointIdentity.serverVersion,
    policy.endpointIdentity.apiVersion,
    isolationProfileSha256,
  ])
  const evidence: DockerEnginePinnedSandboxRuntimeEvidenceV1 = Object.freeze({
    [pinnedSandboxRuntimeEvidenceBrand]: true as const,
    version: 1,
    endpointIdentity: policy.endpointIdentity,
    runtime,
    securityLevel,
    userNamespaceMode,
    isolationProfileSha256,
    runtimeEvidenceHash,
  })
  pinnedSandboxRuntimeEvidence.add(evidence)
  return evidence
}

async function attestSandboxRuntime(
  policy: Policy,
  signal: AbortSignal | undefined,
): Promise<DockerEnginePinnedSandboxRuntimeEvidenceV1> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  const deadline = Date.now() + policy.timeoutMs
  if (isAborted()) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  const anchor = readSocketAnchor(policy.socketPath)
  if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
    throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
  }
  const generation = await connectPinned(policy, anchor, signal, deadline)
  let timeout: ReturnType<typeof setTimeout> | null = null
  const abort = (): void => generation.poison()
  try {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      generation.poison()
      throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    }
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')

    const version = await exchange(generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`)
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await exchange(generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`)
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    const evidence = sandboxRuntimeEvidence(parseBoundedObject(info, policy.maxJsonNodes), policy)
    generation.assertUsable()
    await new Promise<void>(resolve => setImmediate(resolve))
    generation.assertUsable()
    return evidence
  } catch (error) {
    if (error instanceof DockerEnginePinnedSessionError) throw error
    throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
    generation.drain()
  }
}

function inspect(
  policy: Policy,
  kind: 'containers' | 'networks',
  reference: string,
  signal: AbortSignal | undefined,
): Promise<DockerEnginePinnedInspectResult>
function inspect(
  policy: Policy,
  kind: 'images',
  reference: string,
  signal: AbortSignal | undefined,
): Promise<DockerEnginePinnedImageInspectResult>
async function inspect(
  policy: Policy,
  kind: 'containers' | 'networks' | 'images',
  reference: string,
  signal: AbortSignal | undefined,
): Promise<DockerEnginePinnedInspectResult | DockerEnginePinnedImageInspectResult> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  const deadline = Date.now() + policy.timeoutMs
  const validReference = kind === 'images'
    ? typeof reference === 'string' && isRestrictedCloneImageDigest(reference) &&
      Buffer.byteLength(reference, 'utf8') <= 512
    : typeof reference === 'string' && reference !== '.' && reference !== '..' &&
      OBJECT_REFERENCE.test(reference)
  if (!validReference) {
    throw fail('DOCKER_ENGINE_PINNED_INPUT_INVALID')
  }
  if (isAborted()) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  const anchor = readSocketAnchor(policy.socketPath)
  if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
    throw fail('DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH')
  }
  const generation = await connectPinned(policy, anchor, signal, deadline)
  let timeout: ReturnType<typeof setTimeout> | null = null
  const abort = (): void => generation.poison()
  try {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      generation.poison()
      throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    }
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')

    const version = await exchange(generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`)
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await exchange(generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`)
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestInfo(parseBoundedObject(info, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const suffix = kind === 'containers' || kind === 'images' ? '/json' : ''
    const command = await exchange(
      generation,
      policy,
      `/${PINNED_DOCKER_ENGINE_API_VERSION}/${kind}/${encodeURIComponent(reference)}${suffix}`,
    )
    generation.assertUsable()
    await new Promise<void>(resolve => setImmediate(resolve))
    generation.assertUsable()
    if (command.statusCode === 404) {
      return Object.freeze({ outcome: 'not-found' as const, statusCode: 404 as const })
    }
    if (command.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    const document = parseBoundedObject(command, policy.maxJsonNodes)
    if (kind === 'images') {
      const evidence = Object.freeze({
        [pinnedImageInspectEvidenceBrand]: true as const,
        version: 1 as const,
        endpointIdentity: policy.endpointIdentity,
        requestedDigest: reference,
        document,
      })
      pinnedImageInspectEvidence.add(evidence)
      return Object.freeze({
        outcome: 'found' as const,
        statusCode: 200 as const,
        evidence,
      })
    }
    return Object.freeze({ outcome: 'found' as const, statusCode: 200 as const, document })
  } catch (error) {
    if (error instanceof DockerEnginePinnedSessionError) throw error
    throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
    generation.drain()
  }
}

export function isDockerEnginePinnedSession(value: unknown): value is DockerEnginePinnedSession {
  return typeof value === 'object' && value !== null && pinnedSessions.has(value)
}

export function isDockerEnginePinnedImageInspectEvidence(
  value: unknown,
): value is DockerEnginePinnedImageInspectEvidenceV1 {
  return typeof value === 'object' && value !== null && pinnedImageInspectEvidence.has(value)
}

export function isDockerEnginePinnedSandboxRuntimeEvidence(
  value: unknown,
): value is DockerEnginePinnedSandboxRuntimeEvidenceV1 {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    pinnedSandboxRuntimeEvidence.has(value)
}

export function makeNodeDockerEnginePinnedSession(
  options: NodeDockerEnginePinnedSessionOptions,
): DockerEnginePinnedSession {
  const policy = makePolicy(options)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null

  const finishInFlight = (): void => {
    inFlight -= 1
    if (lifecycle === 'closing' && inFlight === 0) {
      lifecycle = 'closed'
      resolveClose?.()
      resolveClose = null
    }
  }
  const begin = (): void => {
    if (lifecycle !== 'open') throw fail('DOCKER_ENGINE_PINNED_SESSION_CLOSED')
    if (commandUsed) throw fail('DOCKER_ENGINE_PINNED_COMMAND_ALREADY_USED')
    commandUsed = true
    inFlight += 1
  }
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    begin()
    try {
      return await operation()
    } finally {
      finishInFlight()
    }
  }

  const session = {
    [pinnedSessionBrand]: true as const,
    endpointIdentity: policy.endpointIdentity,
    async inspectContainer(reference: string, requestOptions?: Readonly<{ signal?: AbortSignal }>) {
      const signal = pinnedRequestSignal(requestOptions)
      return run(() => inspect(policy, 'containers', reference, signal))
    },
    async inspectNetwork(reference: string, requestOptions?: Readonly<{ signal?: AbortSignal }>) {
      const signal = pinnedRequestSignal(requestOptions)
      return run(() => inspect(policy, 'networks', reference, signal))
    },
    async inspectImageRuntime(
      requestedDigest: string,
      requestOptions?: Readonly<{ signal?: AbortSignal }>,
    ) {
      const signal = pinnedRequestSignal(requestOptions)
      return run(() => inspect(policy, 'images', requestedDigest, signal))
    },
    async attestSandboxRuntime(requestOptions?: Readonly<{ signal?: AbortSignal }>) {
      const signal = pinnedRequestSignal(requestOptions)
      return run(() => attestSandboxRuntime(policy, signal))
    },
    close(): Promise<void> {
      if (lifecycle === 'closed') return closePromise ?? Promise.resolve()
      if (lifecycle === 'open') lifecycle = 'closing'
      if (inFlight === 0) {
        lifecycle = 'closed'
        closePromise ??= Promise.resolve()
        return closePromise
      }
      closePromise ??= new Promise<void>(resolve => { resolveClose = resolve })
      return closePromise
    },
  }
  Object.freeze(session)
  pinnedSessions.add(session)
  return session
}

function boundUseSignal(
  options: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  try {
    return pinnedRequestSignal(options)
  } catch {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_INPUT_INVALID')
  }
}

function boundUseDescriptorMatchesObserved(
  descriptor: OwnedDockerBoundUseDescriptorV2,
  observed: OwnedDockerObservedResourceV2,
): boolean {
  const left = descriptor.labels
  const right = observed.labels
  return descriptor.resourceKind === 'container' && observed.resourceKind === 'container' &&
    descriptor.objectId === observed.objectId && descriptor.name === observed.name &&
    descriptor.createProjectionContract === observed.createProjectionContract &&
    descriptor.createProjectionHash === observed.createProjectionHash &&
    descriptor.boundProjectionHashV1 === observed.projectionHashV1 &&
    observed.networkEndpointCount === null && left.version === right.version &&
    left.installationId === right.installationId &&
    left.ownerBindingHash === right.ownerBindingHash &&
    left.sessionBindingHash === right.sessionBindingHash &&
    left.operationBindingHash === right.operationBindingHash &&
    left.sidecarKind === right.sidecarKind && left.role === right.role &&
    left.policyHash === right.policyHash
}

function boundUseObserved(
  response: RawResponse,
  policy: BoundContainerUsePolicy,
  descriptor: OwnedDockerBoundUseDescriptorV2,
): DockerEnginePinnedJsonObject {
  if (response.statusCode !== 200) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN')
  }
  let document: DockerEnginePinnedJsonObject
  let observed: OwnedDockerObservedResourceV2
  try {
    document = parseBoundedObject(response, policy.maxJsonNodes)
    observed = normalizeOwnedDockerContainerInspectV2(document)
  } catch {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN')
  }
  if (!boundUseDescriptorMatchesObserved(descriptor, observed)) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN')
  }
  return document
}

function boundUseState(document: DockerEnginePinnedJsonObject): Readonly<Record<string, unknown>> {
  const state = document['State']
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
    Object.getPrototypeOf(state) !== Object.prototype) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN')
  }
  return state as Readonly<Record<string, unknown>>
}

function assertBoundUseCreated(document: DockerEnginePinnedJsonObject): void {
  const state = boundUseState(document)
  if (state['Status'] !== 'created' || state['Running'] !== false || state['Dead'] !== false ||
    state['OOMKilled'] !== false || state['ExitCode'] !== 0 || state['Error'] !== '') {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN')
  }
}

function waitExitCode(response: RawResponse, maxJsonNodes: number): number {
  if (response.statusCode !== 200) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
  }
  let document: DockerEnginePinnedJsonObject
  try {
    document = parseBoundedObject(response, maxJsonNodes)
  } catch {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
  }
  const keys = Object.keys(document)
  const status = document['StatusCode']
  const error = document['Error']
  if (keys.some(key => key !== 'StatusCode' && key !== 'Error') ||
    !Number.isSafeInteger(status) || Number(status) < 0 || Number(status) > 255 ||
    (error !== undefined && error !== null && (
      typeof error !== 'object' || Array.isArray(error) ||
      Object.keys(error).some(key => key !== 'Message') ||
      typeof (error as Readonly<Record<string, unknown>>)['Message'] !== 'string' ||
      (error as Readonly<Record<string, unknown>>)['Message'] !== ''
    ))) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
  }
  return Number(status)
}

function assertBoundUseTerminal(
  document: DockerEnginePinnedJsonObject,
  expectedExitCode: number,
): void {
  const state = boundUseState(document)
  if (state['Status'] !== 'exited' || state['Running'] !== false || state['Dead'] !== false ||
    state['OOMKilled'] !== false || state['ExitCode'] !== expectedExitCode || state['Error'] !== '') {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
  }
}

function rawStreamResponse(response: RawResponse): boolean {
  const contentType = response.headers['content-type']
  return typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/vnd.docker.raw-stream'
}

function decodeBoundUseLogs(
  response: RawResponse,
): Readonly<{ stdout: string; stderr: string }> {
  if (response.statusCode !== 200 || !rawStreamResponse(response)) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED')
  }
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let offset = 0
  while (offset < response.body.byteLength) {
    if (response.body.byteLength - offset < 8) {
      throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED')
    }
    const stream = response.body[offset]
    if ((stream !== 1 && stream !== 2) || response.body[offset + 1] !== 0 ||
      response.body[offset + 2] !== 0 || response.body[offset + 3] !== 0) {
      throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED')
    }
    const length = response.body.readUInt32BE(offset + 4)
    offset += 8
    if (length > response.body.byteLength - offset) {
      throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED')
    }
    const payload = response.body.subarray(offset, offset + length)
    ;(stream === 1 ? stdout : stderr).push(payload)
    offset += length
  }
  const stdoutBytes = Buffer.concat(stdout)
  const stderrBytes = Buffer.concat(stderr)
  if (!isUtf8(stdoutBytes) || !isUtf8(stderrBytes)) {
    throw boundUseFail('DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED')
  }
  return Object.freeze({
    stdout: stdoutBytes.toString('utf8'),
    stderr: stderrBytes.toString('utf8'),
  })
}

function mapBoundUseFailure(
  error: unknown,
  startDispatched: boolean,
  terminalProven: boolean,
  signal: AbortSignal | undefined,
): DockerEngineBoundContainerUseBrokerError {
  if (startDispatched) {
    return boundUseFail(terminalProven
      ? 'DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED'
      : 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
  }
  if (error instanceof DockerEngineBoundContainerUseBrokerError) return error
  if (intrinsicSignalAborted(signal)) return boundUseFail('DOCKER_ENGINE_BOUND_USE_ABORTED')
  if (error instanceof DockerEnginePinnedSessionError &&
    error.code === 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH') {
    return boundUseFail('DOCKER_ENGINE_BOUND_USE_ENDPOINT_MISMATCH')
  }
  return boundUseFail('DOCKER_ENGINE_BOUND_USE_PREFLIGHT_FAILED')
}

export function isNodeDockerEngineBoundContainerUseBroker(
  value: unknown,
): value is NodeDockerEngineBoundContainerUseBroker {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    boundContainerUseBrokers.has(value)
}

export function makeNodeDockerEngineBoundContainerUseBroker(
  options: NodeDockerEngineBoundContainerUseBrokerOptions,
): NodeDockerEngineBoundContainerUseBroker {
  const policy = makeBoundContainerUsePolicy(options)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null

  const finish = (): void => {
    inFlight -= 1
    if (lifecycle === 'closing' && inFlight === 0) {
      lifecycle = 'closed'
      resolveClose?.()
      resolveClose = null
    }
  }
  const begin = (): void => {
    if (lifecycle !== 'open') throw boundUseFail('DOCKER_ENGINE_BOUND_USE_CLOSED')
    if (commandUsed) throw boundUseFail('DOCKER_ENGINE_BOUND_USE_ALREADY_USED')
    commandUsed = true
    inFlight += 1
  }

  const broker: NodeDockerEngineBoundContainerUseBroker = {
    [boundContainerUseBrokerBrand]: true as const,
    endpointIdentity: policy.endpointIdentity,
    async run(permit, requestOptions) {
      const signal = boundUseSignal(requestOptions)
      begin()
      let generation: PinnedGeneration | null = null
      let timeout: ReturnType<typeof setTimeout> | null = null
      let startDispatched = false
      let terminalProven = false
      const abort = (): void => generation?.poison()
      try {
        if (intrinsicSignalAborted(signal)) {
          throw boundUseFail('DOCKER_ENGINE_BOUND_USE_ABORTED')
        }
        const anchor = readSocketAnchor(policy.socketPath)
        if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
          throw boundUseFail('DOCKER_ENGINE_BOUND_USE_ENDPOINT_MISMATCH')
        }
        const connectDeadline = Date.now() + policy.timeoutMs
        generation = await connectPinned(policy, anchor, signal, connectDeadline)
        timeout = setTimeout(abort, policy.wallTimeMs + policy.timeoutMs * 5)
        timeout.unref()
        addIntrinsicAbortListener(signal, abort)

        const version = await exchange(
          generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`,
        )
        if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
        attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
        generation.assertUsable()

        const info = await exchange(
          generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`,
        )
        if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
        attestInfo(parseBoundedObject(info, policy.maxJsonNodes), policy)
        generation.assertUsable()

        let descriptor: OwnedDockerBoundUseDescriptorV2
        try {
          descriptor = consumeOwnedDockerBoundContainerUsePermitV1(permit, policy.endpointIdentity)
        } catch {
          throw boundUseFail('DOCKER_ENGINE_BOUND_USE_AUTHORITY_LOST')
        }
        if (descriptor.resourceKind !== 'container' || !IMMUTABLE_CONTAINER_ID.test(descriptor.objectId)) {
          throw boundUseFail('DOCKER_ENGINE_BOUND_USE_AUTHORITY_LOST')
        }
        const objectPath = `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/${descriptor.objectId}`
        const initial = await exchange(generation, policy, `${objectPath}/json`)
        generation.assertUsable()
        assertBoundUseCreated(boundUseObserved(initial, policy, descriptor))

        startDispatched = true
        const started = await exchange(generation, policy, `${objectPath}/start`, 'POST')
        generation.assertUsable()
        if (started.statusCode !== 204 || started.body.byteLength !== 0) {
          throw boundUseFail('DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED')
        }

        const waited = await exchange(
          generation,
          policy,
          `${objectPath}/wait?condition=not-running`,
          'POST',
          undefined,
          { timeoutMs: policy.wallTimeMs, maxResponseBytes: policy.maxResponseBytes },
        )
        generation.assertUsable()
        const exitCode = waitExitCode(waited, policy.maxJsonNodes)

        const finalInspect = await exchange(generation, policy, `${objectPath}/json`)
        generation.assertUsable()
        assertBoundUseTerminal(boundUseObserved(finalInspect, policy, descriptor), exitCode)
        terminalProven = true

        const logs = await exchange(
          generation,
          policy,
          `${objectPath}/logs?follow=0&stdout=1&stderr=1&timestamps=0&tail=all`,
          'GET',
          undefined,
          {
            maxResponseBytes: policy.maxOutputBytes,
            timeoutMs: policy.timeoutMs,
            accept: 'application/vnd.docker.raw-stream',
          },
        )
        generation.assertUsable()
        const output = decodeBoundUseLogs(logs)
        return Object.freeze({ ...output, exitCode })
      } catch (error) {
        throw mapBoundUseFailure(error, startDispatched, terminalProven, signal)
      } finally {
        if (timeout !== null) clearTimeout(timeout)
        removeIntrinsicAbortListener(signal, abort)
        await generation?.drainAndWait()
        finish()
      }
    },
    close(): Promise<void> {
      if (lifecycle === 'closed') return closePromise ?? Promise.resolve()
      if (lifecycle === 'open') lifecycle = 'closing'
      if (inFlight === 0) {
        lifecycle = 'closed'
        closePromise ??= Promise.resolve()
        return closePromise
      }
      closePromise ??= new Promise<void>(resolve => { resolveClose = resolve })
      return closePromise
    },
  }
  Object.freeze(broker)
  boundContainerUseBrokers.add(broker)
  return broker
}

function preparedCreateFail(
  code: DockerEnginePinnedPreparedContainerCreateErrorCode,
): DockerEnginePinnedPreparedContainerCreateError {
  return new DockerEnginePinnedPreparedContainerCreateError(code)
}

function endpointIdentityEqual(
  left: DockerEnginePinnedEndpointIdentityV1,
  right: DockerEnginePinnedEndpointIdentityV1,
): boolean {
  return left.version === right.version &&
    left.endpointBindingHash === right.endpointBindingHash && left.serverId === right.serverId &&
    left.serverVersion === right.serverVersion && left.apiVersion === right.apiVersion
}

function runtimeEvidenceEqual(
  left: DockerEnginePinnedSandboxRuntimeEvidenceV1,
  right: DockerEnginePinnedSandboxRuntimeEvidenceV1,
): boolean {
  return left.version === right.version && endpointIdentityEqual(
    left.endpointIdentity, right.endpointIdentity,
  ) && left.runtime === right.runtime && left.securityLevel === right.securityLevel &&
    left.userNamespaceMode === right.userNamespaceMode &&
    left.isolationProfileSha256 === right.isolationProfileSha256 &&
    left.runtimeEvidenceHash === right.runtimeEvidenceHash
}

function preparedCreateSignal(
  options: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  try {
    return pinnedRequestSignal(options)
  } catch {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
}

function preparedCreateCompositeSignal(
  factorySignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = factorySignal === undefined
    ? (requestSignal === undefined ? [] : [requestSignal])
    : (requestSignal === undefined ? [factorySignal] : [factorySignal, requestSignal])
  if (signals.length === 0) return undefined
  try {
    if (typeof abortSignalAnyIntrinsic !== 'function') {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    const composite = Reflect.apply(abortSignalAnyIntrinsic, AbortSignal, [signals]) as unknown
    if (composite === null || typeof composite !== 'object' || utilTypes.isProxy(composite) ||
      abortSignalAbortedGetter === undefined ||
      typeof Reflect.apply(abortSignalAbortedGetter, composite, []) !== 'boolean') {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    return composite as AbortSignal
  } catch (error) {
    if (error instanceof DockerEnginePinnedPreparedContainerCreateError) throw error
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
}

function makePreparedContainerCreatePolicy(
  options: NodeDockerEnginePinnedPreparedContainerCreateOptions,
): Readonly<{
  policy: Policy
  expectedRuntimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
  maxRequestBytes: number
  signal: AbortSignal | undefined
}> {
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const required = ['socketPath', 'endpointIdentity', 'expectedRuntimeEvidence'] as const
  const optional = [
    'timeoutMs', 'maxResponseBytes', 'maxJsonNodes', 'maxRequestBytes', 'signal',
  ] as const
  const allowed = new Set<string>([...required, ...optional])
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => descriptors[key] === undefined) || ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const expectedRuntimeEvidence = descriptors['expectedRuntimeEvidence']!.value as unknown
  const maxRequestValue = descriptors['maxRequestBytes']?.value as unknown
  if (!isDockerEnginePinnedSandboxRuntimeEvidence(expectedRuntimeEvidence) ||
    (descriptors['maxRequestBytes'] !== undefined && typeof maxRequestValue !== 'number')) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const maxRequestBytes = boundedInteger(
    descriptors['maxRequestBytes'] === undefined ? undefined : maxRequestValue as number,
    MAX_REQUEST_BYTES,
    MAX_REQUEST_BYTES,
  )
  if (maxRequestBytes === null) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  let policy: Policy
  let signal: AbortSignal | undefined
  try {
    policy = makePolicy({
      socketPath: descriptors['socketPath']!.value as string,
      endpointIdentity: descriptors['endpointIdentity']!.value as DockerEnginePinnedEndpointIdentityV1,
      ...(descriptors['timeoutMs'] === undefined
        ? {} : { timeoutMs: descriptors['timeoutMs'].value as number }),
      ...(descriptors['maxResponseBytes'] === undefined
        ? {} : { maxResponseBytes: descriptors['maxResponseBytes'].value as number }),
      ...(descriptors['maxJsonNodes'] === undefined
        ? {} : { maxJsonNodes: descriptors['maxJsonNodes'].value as number }),
    })
    signal = preparedCreateSignal(descriptors['signal'] === undefined
      ? undefined
      : Object.freeze({ signal: descriptors['signal'].value as AbortSignal }))
  } catch {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  if (!endpointIdentityEqual(expectedRuntimeEvidence.endpointIdentity, policy.endpointIdentity)) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ENDPOINT_MISMATCH')
  }
  return Object.freeze({ policy, expectedRuntimeEvidence, maxRequestBytes, signal })
}

interface CreateRequestBudget {
  nodes: number
  textBytes: number
}

function snapshotPreparedCreateBody(
  value: unknown,
  maxRequestBytes: number,
): Readonly<{ document: DockerEnginePinnedJsonObject; bytes: Buffer }> {
  const budget: CreateRequestBudget = { nodes: 0, textBytes: 0 }
  const charge = (text: string): string => {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > maxRequestBytes - budget.textBytes) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    budget.textBytes += bytes
    return text
  }
  const visit = (current: unknown, depth: number): DockerEnginePinnedJsonValue => {
    budget.nodes += 1
    if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_REQUEST_JSON_NODES || utilTypes.isProxy(current)) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'string') return charge(current)
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
      return current
    }
    if (Array.isArray(current)) {
      let descriptors: PropertyDescriptorMap
      try {
        if (Object.getPrototypeOf(current) !== Array.prototype ||
          Object.getOwnPropertySymbols(current).length !== 0) {
          throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
        }
        descriptors = Object.getOwnPropertyDescriptors(current) as unknown as PropertyDescriptorMap
      } catch {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
      const keys = Object.keys(descriptors).filter(key => key !== 'length')
      if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
      return Object.freeze(keys.map(key => {
        const descriptor = descriptors[key]
        if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
          throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
        }
        return visit(descriptor.value, depth + 1)
      }))
    }
    if (current === null || typeof current !== 'object') {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    let descriptors: PropertyDescriptorMap
    try {
      const prototype = Object.getPrototypeOf(current)
      if ((prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(current).length !== 0) {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
      descriptors = Object.getOwnPropertyDescriptors(current)
    } catch {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    const result: Record<string, DockerEnginePinnedJsonValue> = Object.create(null) as Record<
      string, DockerEnginePinnedJsonValue
    >
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
      Object.defineProperty(result, charge(key), {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      })
    }
    return Object.freeze(result)
  }
  const document = visit(value, 0)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const encode = (current: DockerEnginePinnedJsonValue): string => {
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean') {
      const scalar = jsonStringify(current)
      if (scalar === undefined) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      return scalar
    }
    if (Array.isArray(current)) return `[${current.map(encode).join(',')}]`
    const record = current as DockerEnginePinnedJsonObject
    return `{${Object.keys(record).sort().map(key =>
      `${jsonStringify(key)}:${encode(record[key]!)}`).join(',')}}`
  }
  const serialized = encode(document)
  const bytes = Buffer.from(serialized, 'utf8')
  if (bytes.byteLength === 0 || bytes.byteLength > maxRequestBytes) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  return Object.freeze({ document: document as DockerEnginePinnedJsonObject, bytes })
}

function preparedCreateInput(
  value: unknown,
  maxRequestBytes: number,
): Readonly<{
  seal: DockerCodeOwnedContainerCreateSealV1
  permit: OwnedDockerAttemptedCreatePermitV1
  platform: DockerEnginePinnedContainerPlatform
  sourceBody: DockerEnginePinnedJsonObject
  body: Buffer
}> {
  let descriptors: PropertyDescriptorMap
  try {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const expected = ['seal', 'permit', 'platform', 'bodyJson'] as const
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.length !== expected.length || ownKeys.some(key => typeof key !== 'string') ||
    expected.some(key => {
      const descriptor = descriptors[key]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const platform = descriptors['platform']!.value as unknown
  if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  const body = snapshotPreparedCreateBody(descriptors['bodyJson']!.value, maxRequestBytes)
  const image = body.document['Image']
  if (typeof image !== 'string' || !isRestrictedCloneImageDigest(image)) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
  }
  return Object.freeze({
    seal: descriptors['seal']!.value as DockerCodeOwnedContainerCreateSealV1,
    permit: descriptors['permit']!.value as OwnedDockerAttemptedCreatePermitV1,
    platform,
    sourceBody: descriptors['bodyJson']!.value as DockerEnginePinnedJsonObject,
    body: body.bytes,
  })
}

function parseContainerCreate201(response: RawResponse, maxJsonNodes: number): string {
  const document = parseBoundedObject(response, maxJsonNodes)
  const descriptors = Object.getOwnPropertyDescriptors(document)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 2 || keys.some(key => key !== 'Id' && key !== 'Warnings')) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS')
  }
  const id = descriptors['Id']?.value as unknown
  const warnings = descriptors['Warnings']?.value as unknown
  if (typeof id !== 'string' || !IMMUTABLE_CONTAINER_ID.test(id) ||
    (warnings !== null && (!Array.isArray(warnings) || warnings.length > MAX_CREATE_WARNINGS ||
      warnings.some(warning => typeof warning !== 'string' ||
        Buffer.byteLength(warning, 'utf8') > MAX_CREATE_WARNING_BYTES)))) {
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS')
  }
  return id
}

async function runPreparedContainerCreate(
  generation: PinnedGeneration,
  policy: Policy,
  input: Readonly<{
    seal: DockerCodeOwnedContainerCreateSealV1
    permit: OwnedDockerAttemptedCreatePermitV1
    platform: DockerEnginePinnedContainerPlatform
    sourceBody: DockerEnginePinnedJsonObject
    body: Buffer
  }>,
  signal: AbortSignal | undefined,
): Promise<DockerEnginePinnedPreparedContainerCreateResult> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  if (isAborted()) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')
  const deadline = Date.now() + policy.timeoutMs
  let postStarted = false
  const abort = (): void => generation.poison()
  const timer = setTimeout(abort, policy.timeoutMs)
  timer.unref()
  addIntrinsicAbortListener(signal, abort)
  try {
    generation.assertUsable()
    if (isAborted() || deadline <= Date.now()) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')
    }
    let descriptor
    try {
      descriptor = consumeOwnedDockerAttemptedCreatePermitV1(input.permit)
      if (!dockerCodeOwnedContainerCreateSealMatchesWireRequest(
        input.seal,
        descriptor,
        input.platform,
        input.sourceBody,
      ) || !CREATE_CONTAINER_NAME.test(descriptor.name)) {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
      }
    } catch (error) {
      if (error instanceof DockerEnginePinnedPreparedContainerCreateError) throw error
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID')
    }
    postStarted = true
    const created = await exchange(
      generation,
      policy,
      `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/create?name=${encodeURIComponent(descriptor.name)}` +
        `&platform=${encodeURIComponent(input.platform)}`,
      'POST',
      input.body,
    )
    generation.assertUsable()
    if (created.statusCode === 404) {
      return Object.freeze({ outcome: 'image-not-found' as const, statusCode: 404 as const })
    }
    if (created.statusCode === 409) {
      return Object.freeze({ outcome: 'conflict' as const, statusCode: 409 as const })
    }
    if (created.statusCode !== 201) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS')
    }
    const objectId = parseContainerCreate201(created, policy.maxJsonNodes)
    const inspected = await exchange(
      generation,
      policy,
      `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/${objectId}/json`,
    )
    generation.assertUsable()
    await new Promise<void>(resolve => setImmediate(resolve))
    generation.assertUsable()
    if (inspected.statusCode !== 200) {
      throw preparedCreateFail(inspected.statusCode === 404
        ? 'DOCKER_ENGINE_PREPARED_CREATE_INSPECT_MISMATCH'
        : 'DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS')
    }
    let resource: OwnedDockerObservedResourceV2
    try {
      resource = normalizeOwnedDockerContainerInspectV2(
        parseBoundedObject(inspected, policy.maxJsonNodes),
      )
    } catch {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INSPECT_MISMATCH')
    }
    if (resource.objectId !== objectId || resource.name !== descriptor.name ||
      !dockerCodeOwnedContainerCreateSealMatchesObservedResource(input.seal, descriptor, resource)) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_INSPECT_MISMATCH')
    }
    return Object.freeze({
      outcome: 'created' as const,
      statusCode: 201 as const,
      resource,
      attestedOutcome: mintOwnedDockerAttestedCreateOutcomeV1(resource),
    })
  } catch (error) {
    if (error instanceof DockerEnginePinnedPreparedContainerCreateError) throw error
    if (postStarted) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_AMBIGUOUS')
    if (isAborted()) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_DAEMON_AMBIGUOUS')
  } finally {
    clearTimeout(timer)
    removeIntrinsicAbortListener(signal, abort)
  }
}

export function isDockerEnginePinnedPreparedContainerCreate(
  value: unknown,
): value is DockerEnginePinnedPreparedContainerCreate {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    preparedContainerCreates.has(value)
}

export async function prepareNodeDockerEnginePinnedContainerCreate(
  options: NodeDockerEnginePinnedPreparedContainerCreateOptions,
): Promise<DockerEnginePinnedPreparedContainerCreate> {
  const prepared = makePreparedContainerCreatePolicy(options)
  const { policy, expectedRuntimeEvidence, signal } = prepared
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  const deadline = Date.now() + policy.timeoutMs
  if (isAborted()) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')
  let generation: PinnedGeneration | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  const abort = (): void => generation?.poison()
  try {
    const anchor = readSocketAnchor(policy.socketPath)
    if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ENDPOINT_MISMATCH')
    }
    generation = await connectPinned(policy, anchor, signal, deadline)
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')

    const version = await exchange(
      generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`,
    )
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await exchange(
      generation, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`,
    )
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    const actualRuntimeEvidence = sandboxRuntimeEvidence(
      parseBoundedObject(info, policy.maxJsonNodes), policy,
    )
    if (!runtimeEvidenceEqual(actualRuntimeEvidence, expectedRuntimeEvidence)) {
      throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_RUNTIME_MISMATCH')
    }
    generation.assertUsable()
    await new Promise<void>(resolve => setImmediate(resolve))
    generation.assertUsable()
  } catch (error) {
    generation?.drain()
    if (error instanceof DockerEnginePinnedPreparedContainerCreateError) throw error
    if (isAborted()) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ABORTED')
    if (error instanceof DockerEnginePinnedSessionError) {
      if (error.code === 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH') {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ENDPOINT_MISMATCH')
      }
      if (error.code === 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE') {
        throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_DAEMON_INCOMPATIBLE')
      }
    }
    throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_DAEMON_AMBIGUOUS')
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
  }
  if (generation === null) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_DAEMON_AMBIGUOUS')

  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null
  const finish = (): void => {
    inFlight -= 1
    generation!.drain()
    lifecycle = 'closed'
    resolveClose?.()
    resolveClose = null
  }
  const begin = (): void => {
    if (commandUsed) throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_ALREADY_USED')
    if (lifecycle !== 'open') throw preparedCreateFail('DOCKER_ENGINE_PREPARED_CREATE_CLOSED')
    commandUsed = true
    inFlight += 1
  }
  const transport: DockerEnginePinnedPreparedContainerCreate = {
    [preparedContainerCreateBrand]: true as const,
    endpointIdentity: policy.endpointIdentity,
    async createAndInspect(input, requestOptions) {
      const requestSignal = preparedCreateSignal(requestOptions)
      const operationSignal = preparedCreateCompositeSignal(signal, requestSignal)
      begin()
      try {
        const request = preparedCreateInput(input, prepared.maxRequestBytes)
        return await runPreparedContainerCreate(generation!, policy, request, operationSignal)
      } finally {
        finish()
      }
    },
    close(): Promise<void> {
      if (lifecycle === 'closed') return closePromise ?? Promise.resolve()
      if (lifecycle === 'open') {
        lifecycle = 'closing'
        generation!.drain()
      }
      if (inFlight === 0) {
        lifecycle = 'closed'
        closePromise ??= Promise.resolve()
        return closePromise
      }
      closePromise ??= new Promise<void>(resolve => { resolveClose = resolve })
      return closePromise
    },
  }
  Object.freeze(transport)
  preparedContainerCreates.add(transport)
  return transport
}

function recoveryBrokerFail(
  code: OwnedDockerEngineRecoveryBrokerErrorCode,
): OwnedDockerEngineRecoveryBrokerError {
  return new OwnedDockerEngineRecoveryBrokerError(code)
}

function makeRecoveryBrokerPolicy(options: NodeOwnedDockerEngineRecoveryBrokerOptions): Readonly<{
  policy: Policy
  authority: OwnedDockerRecoveryLedger
  authorityEpoch: number
}> {
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  const required = ['socketPath', 'endpointIdentity', 'authority'] as const
  const optional = ['timeoutMs', 'maxResponseBytes', 'maxJsonNodes'] as const
  const allowed = new Set<string>([...required, ...optional])
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => descriptors[key] === undefined) ||
    ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  const authority = descriptors['authority']!.value as unknown
  if (!isOwnedDockerRecoveryLedger(authority)) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  let policy: Policy
  try {
    policy = makePolicy({
      socketPath: descriptors['socketPath']!.value as string,
      endpointIdentity: descriptors['endpointIdentity']!.value as DockerEnginePinnedEndpointIdentityV1,
      ...(descriptors['timeoutMs'] === undefined
        ? {} : { timeoutMs: descriptors['timeoutMs'].value as number }),
      ...(descriptors['maxResponseBytes'] === undefined
        ? {} : { maxResponseBytes: descriptors['maxResponseBytes'].value as number }),
      ...(descriptors['maxJsonNodes'] === undefined
        ? {} : { maxJsonNodes: descriptors['maxJsonNodes'].value as number }),
    })
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  const authorityIdentity = authority.activation.endpointIdentity
  if (authority.mode !== 'recovery' || authorityIdentity.version !== 1 ||
    authorityIdentity.endpointBindingHash !== policy.endpointIdentity.endpointBindingHash ||
    authorityIdentity.serverId !== policy.endpointIdentity.serverId ||
    authorityIdentity.serverVersion !== policy.endpointIdentity.serverVersion ||
    authorityIdentity.apiVersion !== policy.endpointIdentity.apiVersion) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH')
  }
  let authorityEpoch: number
  try {
    authorityEpoch = captureOwnedDockerRecoveryAuthorityEpoch(authority)
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
  }
  return Object.freeze({
    policy,
    authority,
    authorityEpoch,
  })
}

function recoverySignal(options: Readonly<{ signal?: AbortSignal }> | undefined): AbortSignal | undefined {
  if (options === undefined) return undefined
  let descriptors: PropertyDescriptorMap
  try {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
      Object.getPrototypeOf(options) !== Object.prototype) {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(options)
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some(key => key !== 'signal') || ownKeys.length > 1 ||
    ownKeys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
  const signal = descriptors['signal']?.value as unknown
  if (signal === undefined) return undefined
  try {
    if (signal === null || typeof signal !== 'object' || utilTypes.isProxy(signal) ||
      abortSignalAbortedGetter === undefined || typeof abortSignalAnyIntrinsic !== 'function') {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    const signalDescriptors = Object.getOwnPropertyDescriptors(signal) as Record<
      PropertyKey,
      PropertyDescriptor
    >
    const signalKeys = Reflect.ownKeys(signalDescriptors)
    if (signalKeys.some(key => typeof key === 'string') || signalKeys.some(key => {
      const descriptor = signalDescriptors[key]
      return descriptor === undefined || !('value' in descriptor)
    })) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    const aborted = Reflect.apply(abortSignalAbortedGetter, signal, []) as unknown
    if (typeof aborted !== 'boolean') {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    const composite = Reflect.apply(abortSignalAnyIntrinsic, AbortSignal, [[signal]]) as unknown
    if (composite === null || typeof composite !== 'object' || utilTypes.isProxy(composite) ||
      typeof Reflect.apply(abortSignalAbortedGetter, composite, []) !== 'boolean') {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    return composite as AbortSignal
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
  }
}

function assertRecoveryAuthority(authority: OwnedDockerRecoveryLedger, authorityEpoch: number): void {
  try {
    assertOwnedDockerRecoveryAuthority(authority, authorityEpoch)
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
  }
}

function beginRecoveryDispatch(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
): () => void {
  try {
    return beginOwnedDockerRecoveryDispatch(authority, authorityEpoch)
  } catch {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
  }
}

async function awaitWithRecoveryAuthority<T>(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  operation: () => Promise<T>,
): Promise<T> {
  assertRecoveryAuthority(authority, authorityEpoch)
  try {
    const value = await operation()
    assertRecoveryAuthority(authority, authorityEpoch)
    return value
  } catch (error) {
    assertRecoveryAuthority(authority, authorityEpoch)
    throw error
  }
}

function mapRecoveryFailure(error: unknown, deleteStarted: boolean): OwnedDockerEngineRecoveryBrokerError {
  if (error instanceof OwnedDockerEngineRecoveryBrokerError) return error
  if (deleteStarted) {
    return recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS')
  }
  if (error instanceof DockerEnginePinnedSessionError) {
    if (error.code === 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH') {
      return recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH')
    }
    if (error.code === 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE') {
      return recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_DAEMON_INCOMPATIBLE')
    }
  }
  return recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_DAEMON_AMBIGUOUS')
}

function assertExpectedRecoveryBinding(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  expected: OwnedDockerObservedResourceV2,
): void {
  assertRecoveryAuthority(authority, authorityEpoch)
  let operations: readonly OwnedDockerLedgerOperationV4[]
  try {
    operations = authority.listOperations()
  } catch {
    assertRecoveryAuthority(authority, authorityEpoch)
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
  }
  assertRecoveryAuthority(authority, authorityEpoch)
  const matches = operations.flatMap(operation => operation.resources
    .filter(resource => operation.installationId === authority.activation.installationId &&
      operation.installationId === expected.labels.installationId &&
      operation.ownerBindingHash === expected.labels.ownerBindingHash &&
      operation.sessionBindingHash === expected.labels.sessionBindingHash &&
      operation.operationBindingHash === expected.labels.operationBindingHash &&
      operation.sidecarKind === expected.labels.sidecarKind &&
      operation.policyHash === expected.labels.policyHash &&
      resource.role === expected.labels.role && resource.resourceKind === expected.resourceKind &&
      resource.name === expected.name &&
      resource.createProjectionContract === expected.createProjectionContract &&
      resource.createProjectionHash === expected.createProjectionHash &&
      resource.boundProjectionHashV1 === expected.projectionHashV1 &&
      resource.objectId === expected.objectId)
    .map(resource => ({ resource })))
  if (matches.length !== 1 || matches[0]!.resource.phase !== 'bound') {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN')
  }
}

function parseExactEmptyArray(response: RawResponse): void {
  if (!isJsonResponse(response)) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  let value: unknown
  try {
    value = jsonParse(response.body.toString('utf8'))
  } catch {
    throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
  }
  if (!Array.isArray(value) || value.length !== 0 || Object.getPrototypeOf(value) !== Array.prototype) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN')
  }
}

async function assertInstallationWideZero(
  generation: PinnedGeneration,
  policy: Policy,
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  installationId: string,
  onProvenZero?: () => void,
): Promise<void> {
  const filters = encodeURIComponent(jsonStringify({
    label: [`${OWNED_DOCKER_LABEL_KEYS_V1.installationId}=${installationId}`],
  }))
  for (const path of [
    `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/json?all=1&filters=${filters}`,
    `/${PINNED_DOCKER_ENGINE_API_VERSION}/networks?filters=${filters}`,
  ]) {
    const response = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation, policy, path),
    )
    generation.assertUsable()
    if (response.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    parseExactEmptyArray(response)
  }
  // The activation commit must happen in this same synchronous continuation:
  // no timer, reconnect, close/drain or caller-controlled await may interpose
  // after the final network-zero response was validated.
  onProvenZero?.()
}

async function removeExactOwnedDockerResource(
  policy: Policy,
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  expectedInput: OwnedDockerObservedResourceV2 | (() => OwnedDockerObservedResourceV2),
  signal: AbortSignal | undefined,
  requireInstallationZero = false,
): Promise<'removed' | 'absent'> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  let expected: OwnedDockerObservedResourceV2 | null = null
  if (typeof expectedInput !== 'function') {
    try {
      expected = snapshotExpectedOwnedDockerResourceV2(expectedInput)
    } catch {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID')
    }
    assertRecoveryAuthority(authority, authorityEpoch)
    assertExpectedRecoveryBinding(authority, authorityEpoch, expected)
  }
  assertRecoveryAuthority(authority, authorityEpoch)
  if (isAborted()) {
    throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ABORTED')
  }
  const deadline = Date.now() + policy.timeoutMs
  let generation: PinnedGeneration | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let deleteStarted = false
  const abort = (): void => generation?.poison()
  try {
    const anchor = readSocketAnchor(policy.socketPath)
    if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH')
    }
    generation = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => connectPinned(policy, anchor, signal, deadline),
    )
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ABORTED')

    const version = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`),
    )
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`),
    )
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestInfo(parseBoundedObject(info, policy.maxJsonNodes), policy)
    generation.assertUsable()

    if (expected === null) {
      try {
        if (typeof expectedInput !== 'function') {
          throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
        }
        expected = snapshotExpectedOwnedDockerResourceV2(expectedInput())
      } catch {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST')
      }
      assertExpectedRecoveryBinding(authority, authorityEpoch, expected)
    }

    const collection = expected.resourceKind === 'container' ? 'containers' : 'networks'
    const suffix = expected.resourceKind === 'container' ? '/json' : ''
    const objectPath = `/${PINNED_DOCKER_ENGINE_API_VERSION}/${collection}/${expected.objectId}${suffix}`
    const inspected = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, objectPath),
    )
    generation.assertUsable()
    await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => new Promise<void>(resolve => setImmediate(resolve)),
    )
    generation.assertUsable()
    let outcome: 'removed' | 'absent'
    if (inspected.statusCode === 404) {
      outcome = 'absent'
    } else {
      if (inspected.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
      let observed: OwnedDockerObservedResourceV2
      try {
        const document = parseBoundedObject(inspected, policy.maxJsonNodes)
        observed = expected.resourceKind === 'container'
          ? normalizeOwnedDockerContainerInspectV2(document)
          : normalizeOwnedDockerNetworkInspectV2(document)
      } catch {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN')
      }
      if (!ownedDockerObservedResourcesV2Equal(observed, expected)) {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN')
      }
      if (observed.resourceKind === 'network' && observed.networkEndpointCount !== 0) {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_NETWORK_NOT_EMPTY')
      }

      assertRecoveryAuthority(authority, authorityEpoch)
      deleteStarted = true
      const removePath = expected.resourceKind === 'container'
        ? `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/${expected.objectId}?v=1&force=1`
        : `/${PINNED_DOCKER_ENGINE_API_VERSION}/networks/${expected.objectId}`
      const removed = await awaitWithRecoveryAuthority(
        authority,
        authorityEpoch,
        () => exchange(generation!, policy, removePath, 'DELETE'),
      )
      generation.assertUsable()
      if ((removed.statusCode !== 204 && removed.statusCode !== 404) ||
        (removed.statusCode === 204 && removed.body.byteLength !== 0)) {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS')
      }

      const absent = await awaitWithRecoveryAuthority(
        authority,
        authorityEpoch,
        () => exchange(generation!, policy, objectPath),
      )
      generation.assertUsable()
      await awaitWithRecoveryAuthority(
        authority,
        authorityEpoch,
        () => new Promise<void>(resolve => setImmediate(resolve)),
      )
      generation.assertUsable()
      if (absent.statusCode !== 404) {
        throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS')
      }
      outcome = 'removed'
    }
    if (requireInstallationZero) {
      await assertInstallationWideZero(
        generation,
        policy,
        authority,
        authorityEpoch,
        expected.labels.installationId,
      )
    }
    return outcome
  } catch (error) {
    assertRecoveryAuthority(authority, authorityEpoch)
    if (isAborted()) {
      throw recoveryBrokerFail(deleteStarted
        ? 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS'
        : 'OWNED_DOCKER_RECOVERY_BROKER_ABORTED')
    }
    throw mapRecoveryFailure(error, deleteStarted)
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
    await generation?.drainAndWait()
  }
}

async function proveInstallationZeroAndActivate(
  policy: Policy,
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  permit: OwnedDockerRecoveryActivationPermitV1,
  signal: AbortSignal | undefined,
): Promise<void> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  assertRecoveryAuthority(authority, authorityEpoch)
  if (isAborted()) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ABORTED')
  const deadline = Date.now() + policy.timeoutMs
  let generation: PinnedGeneration | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let committed = false
  const abort = (): void => generation?.poison()
  try {
    const anchor = readSocketAnchor(policy.socketPath)
    if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
      throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH')
    }
    generation = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => connectPinned(policy, anchor, signal, deadline),
    )
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ABORTED')

    const version = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`),
    )
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await awaitWithRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`),
    )
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestInfo(parseBoundedObject(info, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const installationId = consumeOwnedDockerRecoveryActivationPermitV1(
      permit,
      authority,
      authorityEpoch,
      policy.endpointIdentity,
    )
    await assertInstallationWideZero(
      generation,
      policy,
      authority,
      authorityEpoch,
      installationId,
      () => {
        const outcome = mintOwnedDockerAttestedRecoveryActivationOutcomeV1(permit)
        commitOwnedDockerRecoveryActivationOutcomeV1(permit, outcome)
        committed = true
      },
    )
  } catch (error) {
    if (committed) throw error
    assertRecoveryAuthority(authority, authorityEpoch)
    if (isAborted()) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ABORTED')
    throw mapRecoveryFailure(error, false)
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
    await generation?.drainAndWait()
  }
}

export function isNodeOwnedDockerEngineRecoveryBroker(
  value: unknown,
): value is NodeOwnedDockerEngineRecoveryBroker {
  return typeof value === 'object' && value !== null && recoveryBrokers.has(value)
}

export function makeNodeOwnedDockerEngineRecoveryBroker(
  options: NodeOwnedDockerEngineRecoveryBrokerOptions,
): NodeOwnedDockerEngineRecoveryBroker {
  const { policy, authority, authorityEpoch } = makeRecoveryBrokerPolicy(options)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null

  const finishInFlight = (): void => {
    inFlight -= 1
    if (lifecycle === 'closing' && inFlight === 0) {
      lifecycle = 'closed'
      resolveClose?.()
      resolveClose = null
    }
  }
  const begin = (): void => {
    if (lifecycle !== 'open') throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_CLOSED')
    if (commandUsed) throw recoveryBrokerFail('OWNED_DOCKER_RECOVERY_BROKER_ALREADY_USED')
    commandUsed = true
    inFlight += 1
  }
  const broker = {
    [recoveryBrokerBrand]: true as const,
    endpointIdentity: policy.endpointIdentity,
    async removeExact(
      expected: OwnedDockerObservedResourceV2,
      requestOptions?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<'removed' | 'absent'> {
      begin()
      let releaseDispatch: (() => void) | null = null
      try {
        releaseDispatch = beginRecoveryDispatch(authority, authorityEpoch)
        return await awaitWithRecoveryAuthority(
          authority,
          authorityEpoch,
          () => removeExactOwnedDockerResource(
            policy,
            authority,
            authorityEpoch,
            expected,
            recoverySignal(requestOptions),
          ),
        )
      } finally {
        releaseDispatch?.()
        finishInFlight()
      }
    },
    async removeBoundContainer(
      permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
      requestOptions?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1> {
      begin()
      let releaseDispatch: (() => void) | null = null
      try {
        releaseDispatch = beginRecoveryDispatch(authority, authorityEpoch)
        const outcome = await awaitWithRecoveryAuthority(
          authority,
          authorityEpoch,
          () => removeExactOwnedDockerResource(
            policy,
            authority,
            authorityEpoch,
            () => consumeOwnedDockerRecoveryBoundContainerCleanupPermitV1(
              permit,
              authority,
              authorityEpoch,
              policy.endpointIdentity,
            ),
            recoverySignal(requestOptions),
            true,
          ),
        )
        return mintOwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1(permit, outcome)
      } finally {
        releaseDispatch?.()
        finishInFlight()
      }
    },
    async activateAfterInstallationZero(
      permit: OwnedDockerRecoveryActivationPermitV1,
      requestOptions?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<void> {
      begin()
      try {
        await proveInstallationZeroAndActivate(
          policy,
          authority,
          authorityEpoch,
          permit,
          recoverySignal(requestOptions),
        )
      } finally {
        finishInFlight()
      }
    },
    close(): Promise<void> {
      if (lifecycle === 'closed') return closePromise ?? Promise.resolve()
      if (lifecycle === 'open') lifecycle = 'closing'
      if (inFlight === 0) {
        lifecycle = 'closed'
        closePromise ??= Promise.resolve()
        return closePromise
      }
      closePromise ??= new Promise<void>(resolve => { resolveClose = resolve })
      return closePromise
    },
  }
  Object.freeze(broker)
  recoveryBrokers.add(broker)
  return broker
}

function attemptedCreateRecoveryFail(
  code: OwnedDockerEngineAttemptedCreateRecoveryBrokerErrorCode,
): OwnedDockerEngineAttemptedCreateRecoveryBrokerError {
  return new OwnedDockerEngineAttemptedCreateRecoveryBrokerError(code)
}

function makeAttemptedCreateRecoveryBrokerPolicy(
  options: NodeOwnedDockerEngineAttemptedCreateRecoveryBrokerOptions,
): Readonly<{
  policy: Policy
  authority: OwnedDockerRecoveryLedger
  authorityEpoch: number
}> {
  try {
    return makeRecoveryBrokerPolicy(options)
  } catch (error) {
    if (error instanceof OwnedDockerEngineRecoveryBrokerError) {
      if (error.code === 'OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH') {
        throw attemptedCreateRecoveryFail(
          'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ENDPOINT_MISMATCH',
        )
      }
      if (error.code === 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST') {
        throw attemptedCreateRecoveryFail(
          'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
        )
      }
    }
    throw attemptedCreateRecoveryFail(
      'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
    )
  }
}

function attemptedCreateRecoverySignal(
  options: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  try {
    return recoverySignal(options)
  } catch {
    throw attemptedCreateRecoveryFail(
      'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
    )
  }
}

function assertAttemptedCreateRecoveryAuthority(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
): void {
  try {
    assertOwnedDockerRecoveryAuthority(authority, authorityEpoch)
  } catch {
    throw attemptedCreateRecoveryFail(
      'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
    )
  }
}

function beginAttemptedCreateRecoveryDispatch(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
): () => void {
  try {
    return beginOwnedDockerRecoveryDispatch(authority, authorityEpoch)
  } catch {
    throw attemptedCreateRecoveryFail(
      'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
    )
  }
}

async function awaitWithAttemptedCreateRecoveryAuthority<T>(
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  operation: () => Promise<T>,
): Promise<T> {
  assertAttemptedCreateRecoveryAuthority(authority, authorityEpoch)
  try {
    const value = await operation()
    assertAttemptedCreateRecoveryAuthority(authority, authorityEpoch)
    return value
  } catch (error) {
    assertAttemptedCreateRecoveryAuthority(authority, authorityEpoch)
    throw error
  }
}

function attemptedRecoveryDescriptorMatchesObserved(
  descriptor: ReturnType<typeof consumeOwnedDockerAttemptedContainerRecoveryPermitV1>,
  observed: OwnedDockerObservedResourceV2,
): boolean {
  const expectedLabels = descriptor.labels
  const actualLabels = observed.labels
  return descriptor.role === 'worker' && descriptor.resourceKind === 'container' &&
    observed.resourceKind === 'container' && observed.networkEndpointCount === null &&
    observed.name === descriptor.name &&
    observed.createProjectionContract === descriptor.createProjectionContract &&
    observed.createProjectionHash === descriptor.createProjectionHash &&
    actualLabels.version === expectedLabels.version &&
    actualLabels.installationId === expectedLabels.installationId &&
    actualLabels.ownerBindingHash === expectedLabels.ownerBindingHash &&
    actualLabels.sessionBindingHash === expectedLabels.sessionBindingHash &&
    actualLabels.operationBindingHash === expectedLabels.operationBindingHash &&
    actualLabels.sidecarKind === expectedLabels.sidecarKind &&
    actualLabels.role === expectedLabels.role &&
    actualLabels.policyHash === expectedLabels.policyHash
}

function mapAttemptedCreateRecoveryFailure(
  error: unknown,
): OwnedDockerEngineAttemptedCreateRecoveryBrokerError {
  if (error instanceof OwnedDockerEngineAttemptedCreateRecoveryBrokerError) return error
  if (error instanceof DockerEnginePinnedSessionError) {
    if (error.code === 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH') {
      return attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ENDPOINT_MISMATCH',
      )
    }
    if (error.code === 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE') {
      return attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_INCOMPATIBLE',
      )
    }
  }
  return attemptedCreateRecoveryFail(
    'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_AMBIGUOUS',
  )
}

async function inspectExactAttemptedContainer(
  policy: Policy,
  authority: OwnedDockerRecoveryLedger,
  authorityEpoch: number,
  permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
  signal: AbortSignal | undefined,
): Promise<OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1> {
  const isAborted = (): boolean => intrinsicSignalAborted(signal)
  if (isAborted()) {
    throw attemptedCreateRecoveryFail(
      'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
    )
  }
  const deadline = Date.now() + policy.timeoutMs
  let generation: PinnedGeneration | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  const abort = (): void => generation?.poison()
  try {
    const anchor = readSocketAnchor(policy.socketPath)
    if (anchor.bindingHash !== policy.endpointIdentity.endpointBindingHash) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ENDPOINT_MISMATCH',
      )
    }
    generation = await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => connectPinned(policy, anchor, signal, deadline),
    )
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    timeout = setTimeout(abort, remainingMs)
    timeout.unref()
    addIntrinsicAbortListener(signal, abort)
    if (isAborted()) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
      )
    }

    const version = await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/version`),
    )
    if (version.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestVersion(parseBoundedObject(version, policy.maxJsonNodes), policy)
    generation.assertUsable()

    const info = await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(generation!, policy, `/${PINNED_DOCKER_ENGINE_API_VERSION}/info`),
    )
    if (info.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    attestInfo(parseBoundedObject(info, policy.maxJsonNodes), policy)
    generation.assertUsable()

    let descriptor: ReturnType<typeof consumeOwnedDockerAttemptedContainerRecoveryPermitV1>
    try {
      descriptor = consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
        permit,
        authority,
        authorityEpoch,
      )
    } catch {
      assertAttemptedCreateRecoveryAuthority(authority, authorityEpoch)
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
      )
    }
    if (descriptor.resourceKind !== 'container' || descriptor.role !== 'worker' ||
      !CREATE_CONTAINER_NAME.test(descriptor.name)) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }
    generation.assertUsable()
    if (isAborted() || deadline <= Date.now()) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
      )
    }

    const byName = await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(
        generation!,
        policy,
        `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/${encodeURIComponent(descriptor.name)}/json`,
      ),
    )
    generation.assertUsable()
    await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => new Promise<void>(resolve => setImmediate(resolve)),
    )
    generation.assertUsable()
    if (byName.statusCode === 404) {
      try {
        return mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
      } catch {
        throw attemptedCreateRecoveryFail(
          'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
        )
      }
    }
    if (byName.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    let named: OwnedDockerObservedResourceV2
    try {
      named = normalizeOwnedDockerContainerInspectV2(
        parseBoundedObject(byName, policy.maxJsonNodes),
      )
    } catch {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }
    if (!attemptedRecoveryDescriptorMatchesObserved(descriptor, named)) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }

    const byId = await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => exchange(
        generation!,
        policy,
        `/${PINNED_DOCKER_ENGINE_API_VERSION}/containers/${named.objectId}/json`,
      ),
    )
    generation.assertUsable()
    await awaitWithAttemptedCreateRecoveryAuthority(
      authority,
      authorityEpoch,
      () => new Promise<void>(resolve => setImmediate(resolve)),
    )
    generation.assertUsable()
    if (byId.statusCode === 404) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }
    if (byId.statusCode !== 200) throw fail('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    let immutable: OwnedDockerObservedResourceV2
    try {
      immutable = normalizeOwnedDockerContainerInspectV2(
        parseBoundedObject(byId, policy.maxJsonNodes),
      )
    } catch {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }
    if (!ownedDockerObservedResourcesV2Equal(named, immutable) ||
      !attemptedRecoveryDescriptorMatchesObserved(descriptor, immutable)) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
      )
    }
    try {
      return mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1(permit, immutable)
    } catch {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
      )
    }
  } catch (error) {
    assertAttemptedCreateRecoveryAuthority(authority, authorityEpoch)
    if (isAborted()) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
      )
    }
    throw mapAttemptedCreateRecoveryFailure(error)
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    removeIntrinsicAbortListener(signal, abort)
    generation?.drain()
  }
}

export function isNodeOwnedDockerEngineAttemptedCreateRecoveryBroker(
  value: unknown,
): value is NodeOwnedDockerEngineAttemptedCreateRecoveryBroker {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    attemptedCreateRecoveryBrokers.has(value)
}

export function makeNodeOwnedDockerEngineAttemptedCreateRecoveryBroker(
  options: NodeOwnedDockerEngineAttemptedCreateRecoveryBrokerOptions,
): NodeOwnedDockerEngineAttemptedCreateRecoveryBroker {
  const { policy, authority, authorityEpoch } = makeAttemptedCreateRecoveryBrokerPolicy(options)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null

  const finishInFlight = (): void => {
    inFlight -= 1
    if (lifecycle === 'closing' && inFlight === 0) {
      lifecycle = 'closed'
      resolveClose?.()
      resolveClose = null
    }
  }
  const begin = (): void => {
    if (lifecycle !== 'open') {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_CLOSED',
      )
    }
    if (commandUsed) {
      throw attemptedCreateRecoveryFail(
        'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ALREADY_USED',
      )
    }
    commandUsed = true
    inFlight += 1
  }
  const broker: NodeOwnedDockerEngineAttemptedCreateRecoveryBroker = {
    [attemptedCreateRecoveryBrokerBrand]: true as const,
    endpointIdentity: policy.endpointIdentity,
    async inspectExact(permit, requestOptions) {
      const signal = attemptedCreateRecoverySignal(requestOptions)
      begin()
      let releaseDispatch: (() => void) | null = null
      try {
        releaseDispatch = beginAttemptedCreateRecoveryDispatch(authority, authorityEpoch)
        return await awaitWithAttemptedCreateRecoveryAuthority(
          authority,
          authorityEpoch,
          () => inspectExactAttemptedContainer(
            policy,
            authority,
            authorityEpoch,
            permit,
            signal,
          ),
        )
      } finally {
        releaseDispatch?.()
        finishInFlight()
      }
    },
    close(): Promise<void> {
      if (lifecycle === 'closed') return closePromise ?? Promise.resolve()
      if (lifecycle === 'open') lifecycle = 'closing'
      if (inFlight === 0) {
        lifecycle = 'closed'
        closePromise ??= Promise.resolve()
        return closePromise
      }
      closePromise ??= new Promise<void>(resolve => { resolveClose = resolve })
      return closePromise
    },
  }
  Object.freeze(broker)
  attemptedCreateRecoveryBrokers.add(broker)
  return broker
}

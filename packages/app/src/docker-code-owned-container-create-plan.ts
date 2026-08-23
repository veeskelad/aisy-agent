import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2,
  DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2,
  hashExpectedOwnedDockerContainerProjectionV2,
  normalizeOwnedDockerContainerInspectProjectionV2,
  type ExpectedOwnedDockerContainerProjectionV2,
} from './docker-container-selected-projection.js'
import {
  DockerEnginePinnedPreparedContainerCreateError,
  isDockerEnginePinnedSandboxRuntimeEvidence,
  prepareNodeDockerEnginePinnedContainerCreate,
  type DockerEnginePinnedContainerPlatform,
  type DockerEnginePinnedPreparedContainerCreate,
  type DockerEnginePinnedSandboxRuntimeEvidenceV1,
} from './docker-engine-pinned-session.js'
import {
  isDockerImageRuntimeManifest,
  type DockerImageRuntimeManifestV1,
} from './docker-image-runtime-manifest.js'
import {
  isDockerSidecarSemanticDraft,
  type DockerSidecarSemanticDraftV1,
} from './docker-sidecar-code-owned-plans.js'
import {
  isDockerSidecarFilesystemEvidence,
  matchesCurrentNodeDockerSidecarFilesystemEvidence,
  resolveNodeDockerSidecarFilesystemRoot,
  type DockerSidecarFilesystemEvidenceV1,
} from './docker-sidecar-filesystem-evidence.js'
import {
  isOwnedDockerActiveEpoch,
  isOwnedDockerOperationHandle,
  ownedDockerActiveEpochMatchesEndpointIdentity,
  type OwnedDockerActiveEpoch,
  type OwnedDockerBoundResourceHandle,
  type OwnedDockerCreateDescriptorV2,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerOperationHandle,
} from './execution-owned-docker-resources.js'
import {
  OWNED_DOCKER_LABEL_KEYS_V1,
  OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1,
} from './execution-owned-docker-normalization.js'
import {
  snapshotExpectedOwnedDockerResourceV2,
} from './execution-owned-docker-observed-v2.js'

const REQUEST_HASH_DOMAIN = 'aisy.docker-sidecar.create-request-template.v1\0'
const PLAN_HASH_DOMAIN = 'aisy.docker-sidecar.container-create-plan.v1\0'
const SEALED_REQUEST_HASH_DOMAIN = 'aisy.docker-sidecar.sealed-container-create-request.v1\0'
const HASH = /^[a-f0-9]{64}$/
const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const MAX_COMMAND_BYTES = 128 * 1024
const TMPFS = 'rw,nosuid,nodev,noexec,size=67108864,mode=0700'
const planBrand: unique symbol = Symbol('aisy.docker-container-create-plan')
const plans = new WeakSet<object>()
const consumedPlans = new WeakSet<object>()
const sealBrand: unique symbol = Symbol('aisy.docker-container-create-seal')
const seals = new WeakSet<object>()
const claimedSeals = new WeakSet<object>()
const createBrokerBrand: unique symbol = Symbol('aisy.docker-container-create-broker')
const createBrokers = new WeakSet<object>()
const planState = new WeakMap<object, Readonly<{
  filesystem: DockerSidecarFilesystemEvidenceV1
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
  platform: DockerEnginePinnedContainerPlatform
  requestTemplate: Readonly<Record<string, unknown>>
}>>()
const sealState = new WeakMap<object, Readonly<{
  plan: DockerCodeOwnedContainerCreatePlanV1
  operation: OwnedDockerOperationHandle
  descriptor: OwnedDockerCreateDescriptorV2
  request: Readonly<{
    name: string
    platform: DockerEnginePinnedContainerPlatform
    body: Readonly<Record<string, unknown>>
  }>
}>>()
const jsonStringify = JSON.stringify

export type DockerCodeOwnedContainerCreatePlanSidecarKindV1 =
  | 'whisper'
  | 'lease-bound-docker-bash'

export interface DockerCodeOwnedContainerCreatePlanV1 {
  readonly [planBrand]: true
  readonly version: 1
  readonly kind: 'aisy-docker-container-create-plan-v1'
  readonly sidecarKind: DockerCodeOwnedContainerCreatePlanSidecarKindV1
  readonly role: 'worker'
  readonly endpointIdentity: DockerImageRuntimeManifestV1['endpointIdentity']
  readonly semanticDraftHash: string
  readonly imageManifestHash: string
  readonly imageReference: string
  readonly imageId: string
  readonly runtime: DockerEnginePinnedSandboxRuntimeEvidenceV1['runtime']
  readonly securityLevel: DockerEnginePinnedSandboxRuntimeEvidenceV1['securityLevel']
  readonly isolationProfileSha256: string
  readonly runtimeEvidenceHash: string
  readonly selectedProjectionHash: string
  readonly createRequestTemplateHash: string
  readonly createPlanHash: string
}

export interface DockerCodeOwnedContainerCreateSealV1 {
  readonly [sealBrand]: true
  readonly version: 1
  readonly kind: 'aisy-docker-container-create-seal-v1'
  readonly sidecarKind: DockerCodeOwnedContainerCreatePlanSidecarKindV1
  readonly role: 'worker'
  readonly createPlanHash: string
  readonly selectedProjectionHash: string
  readonly sealedRequestHash: string
}

export type NodeDockerCodeOwnedContainerCreateBrokerErrorCode =
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ENDPOINT_MISMATCH'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_PREFLIGHT_FAILED'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ABORTED'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_AUTHORITY_LOST'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CLOSED'
  | 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ALREADY_USED'

export class NodeDockerCodeOwnedContainerCreateBrokerError extends Error {
  constructor(readonly code: NodeDockerCodeOwnedContainerCreateBrokerErrorCode) {
    super(code)
    this.name = 'NodeDockerCodeOwnedContainerCreateBrokerError'
  }
}

export interface NodeDockerCodeOwnedContainerCreateBroker {
  readonly [createBrokerBrand]: true
  create(options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{
    kind: 'created-and-bound'
  }>>
  close(): Promise<void>
}

export class DockerCodeOwnedContainerCreatePlanError extends Error {
  readonly code = 'DOCKER_CODE_OWNED_CONTAINER_CREATE_PLAN_INVALID' as const
  constructor() {
    super('DOCKER_CODE_OWNED_CONTAINER_CREATE_PLAN_INVALID')
    this.name = 'DockerCodeOwnedContainerCreatePlanError'
  }
}

type Canonical = null | boolean | number | string | readonly Canonical[] | CanonicalRecord
interface CanonicalRecord { readonly [key: string]: Canonical }

function invalid(): never {
  throw new DockerCodeOwnedContainerCreatePlanError()
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
      invalid()
    }
    const source = Object.getOwnPropertyDescriptors(value)
    const actual = Object.keys(source).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid()
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of expected) {
      const descriptor = source[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) invalid()
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
    }
    return result
  } catch (error) {
    if (error instanceof DockerCodeOwnedContainerCreatePlanError) throw error
    invalid()
  }
}

function command(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_COMMAND_BYTES) invalid()
  return value
}

function canonical(value: Canonical): string {
  const encode = (current: Canonical): string => {
    if (current === null) return 'null'
    if (typeof current === 'string') return jsonStringify(current)
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) invalid()
      return String(current)
    }
    if (Array.isArray(current)) return `[${current.map(encode).join(',')}]`
    const record = current as CanonicalRecord
    return `{${Object.keys(record).sort().map(key =>
      `${jsonStringify(key)}:${encode(record[key]!)}`).join(',')}}`
  }
  return encode(value)
}

function digest(domain: string, value: Canonical): string {
  return createHash('sha256').update(domain).update(canonical(value)).digest('hex')
}

function freezeMap(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      value: value[key]!, enumerable: true, configurable: false, writable: false,
    })
  }
  return Object.freeze(result)
}

function resolvedEnvironment(
  manifest: DockerImageRuntimeManifestV1,
  overrides: Readonly<Record<string, string>>,
): readonly string[] {
  const values = new Map<string, string>()
  for (const entry of manifest.config.env) {
    const separator = entry.indexOf('=')
    if (separator < 1) invalid()
    values.set(entry.slice(0, separator), entry.slice(separator + 1))
  }
  for (const [name, value] of Object.entries(overrides)) values.set(name, value)
  return Object.freeze([...values].sort(([left], [right]) => Buffer.compare(
    Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'),
  ))
    .map(([name, value]) => `${name}=${value}`))
}

function imageInvariant(manifest: DockerImageRuntimeManifestV1): void {
  if (!isDockerImageRuntimeManifest(manifest) || manifest.config.volumes.length !== 0 ||
    manifest.config.exposedPorts.length !== 0 || manifest.config.onBuild.length !== 0 ||
    Object.keys(manifest.config.labels).some(key => key.startsWith('com.aisy.'))) invalid()
}

function sameEndpoint(
  left: DockerEnginePinnedSandboxRuntimeEvidenceV1['endpointIdentity'],
  right: DockerImageRuntimeManifestV1['endpointIdentity'],
): boolean {
  return left.version === right.version &&
    left.endpointBindingHash === right.endpointBindingHash &&
    left.serverId === right.serverId && left.serverVersion === right.serverVersion &&
    left.apiVersion === right.apiVersion
}

function selectRuntimeEvidence(
  value: unknown,
  manifest: DockerImageRuntimeManifestV1,
): DockerEnginePinnedSandboxRuntimeEvidenceV1 {
  if (!isDockerEnginePinnedSandboxRuntimeEvidence(value) ||
    !sameEndpoint(value.endpointIdentity, manifest.endpointIdentity)) invalid()
  return value
}

function commonHostConfig(input: Readonly<{
  memoryBytes: number
  cpuMillicores: number
  pids: number
  runtime: string
  nofile: 256 | 1024
  log: Readonly<{ type: 'none' | 'local'; config: Readonly<Record<string, string>> }>
}>): ExpectedOwnedDockerContainerProjectionV2['hostConfig'] {
  return Object.freeze({
    networkMode: 'none',
    readonlyRootfs: true,
    privileged: false,
    capAdd: Object.freeze([]),
    capDrop: Object.freeze(['ALL']),
    securityOpt: Object.freeze(['no-new-privileges=true', 'seccomp=builtin']),
    groupAdd: Object.freeze([]) as readonly [],
    sysctls: Object.freeze({}) as Readonly<Record<string, never>>,
    maskedPaths: DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2,
    readonlyPaths: DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2,
    ipcMode: 'none',
    pidMode: '',
    utsMode: '',
    cgroupnsMode: 'private',
    usernsMode: '',
    pidsLimit: input.pids,
    memory: input.memoryBytes,
    memorySwap: input.memoryBytes,
    nanoCpus: input.cpuMillicores * 1_000_000,
    runtime: input.runtime,
    restartPolicy: Object.freeze({ name: 'no', maximumRetryCount: 0 }),
    autoRemove: false,
    logConfig: Object.freeze({ type: input.log.type, config: freezeMap(input.log.config) }),
    tmpfs: freezeMap({ '/tmp': TMPFS }),
    ulimits: Object.freeze([Object.freeze({ name: 'nofile', soft: input.nofile, hard: input.nofile })]),
    devices: Object.freeze([]) as readonly [],
    deviceRequests: Object.freeze([]) as readonly [],
    portBindings: Object.freeze({}) as Readonly<Record<string, never>>,
    publishAllPorts: false,
    oomKillDisable: false,
    oomScoreAdj: 0,
    shmSize: 64 * 1024 * 1024,
    init: false,
  })
}

function requestTemplate(projection: ExpectedOwnedDockerContainerProjectionV2): Readonly<Record<string, unknown>> {
  const config = projection.config
  const host = projection.hostConfig
  const mount = projection.mounts[0]!
  return Object.freeze({
    Image: config.image,
    User: config.user,
    Env: config.env,
    Entrypoint: config.entrypoint,
    Cmd: config.cmd,
    WorkingDir: config.workingDir,
    OpenStdin: config.openStdin,
    StdinOnce: config.stdinOnce,
    Tty: config.tty,
    Labels: config.labels,
    Healthcheck: Object.freeze({ Test: Object.freeze(['NONE']) }),
    StopSignal: config.stopSignal,
    HostConfig: Object.freeze({
      NetworkMode: host.networkMode,
      ReadonlyRootfs: host.readonlyRootfs,
      Privileged: host.privileged,
      CapAdd: host.capAdd,
      CapDrop: host.capDrop,
      SecurityOpt: host.securityOpt,
      GroupAdd: host.groupAdd,
      Sysctls: host.sysctls,
      MaskedPaths: host.maskedPaths,
      ReadonlyPaths: host.readonlyPaths,
      IpcMode: host.ipcMode,
      PidMode: host.pidMode,
      UTSMode: host.utsMode,
      CgroupnsMode: host.cgroupnsMode,
      UsernsMode: host.usernsMode,
      PidsLimit: host.pidsLimit,
      Memory: host.memory,
      MemorySwap: host.memorySwap,
      NanoCpus: host.nanoCpus,
      Runtime: host.runtime,
      RestartPolicy: Object.freeze({ Name: 'no', MaximumRetryCount: 0 }),
      AutoRemove: false,
      LogConfig: Object.freeze({ Type: host.logConfig.type, Config: host.logConfig.config }),
      Tmpfs: host.tmpfs,
      Ulimits: Object.freeze([Object.freeze({ Name: 'nofile', Soft: host.ulimits[0]!.soft,
        Hard: host.ulimits[0]!.hard })]),
      Devices: host.devices,
      DeviceRequests: host.deviceRequests,
      PortBindings: host.portBindings,
      PublishAllPorts: false,
      OomKillDisable: false,
      OomScoreAdj: 0,
      ShmSize: host.shmSize,
      Init: false,
      Mounts: Object.freeze([Object.freeze({
        Type: 'bind', Source: mount.source, Target: mount.destination, ReadOnly: mount.readOnly,
        BindOptions: Object.freeze({ Propagation: mount.propagation }),
      })]),
    }),
  })
}

function makePlan(input: Readonly<{
  semanticDraft: DockerSidecarSemanticDraftV1
  imageManifest: DockerImageRuntimeManifestV1
  filesystem: DockerSidecarFilesystemEvidenceV1
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
  projection: ExpectedOwnedDockerContainerProjectionV2
}>): DockerCodeOwnedContainerCreatePlanV1 {
  const selectedProjectionHash = hashExpectedOwnedDockerContainerProjectionV2(input.projection)
  const template = requestTemplate(input.projection)
  const createRequestTemplateHash = digest(REQUEST_HASH_DOMAIN, template as unknown as Canonical)
  const createPlanHash = digest(PLAN_HASH_DOMAIN, Object.freeze({
    version: 1,
    sidecarKind: input.projection.sidecarKind,
    role: 'worker',
    endpointBindingHash: input.imageManifest.endpointIdentity.endpointBindingHash,
    semanticDraftHash: input.semanticDraft.semanticDraftHash,
    imageManifestHash: input.imageManifest.manifestHash,
    runtimeEvidenceHash: input.runtimeEvidence.runtimeEvidenceHash,
    isolationProfileSha256: input.runtimeEvidence.isolationProfileSha256,
    selectedProjectionHash,
    createRequestTemplateHash,
  }))
  const plan: DockerCodeOwnedContainerCreatePlanV1 = Object.freeze({
    [planBrand]: true as const,
    version: 1,
    kind: 'aisy-docker-container-create-plan-v1',
    sidecarKind: input.projection.sidecarKind,
    role: 'worker',
    endpointIdentity: input.imageManifest.endpointIdentity,
    semanticDraftHash: input.semanticDraft.semanticDraftHash,
    imageManifestHash: input.imageManifest.manifestHash,
    imageReference: input.imageManifest.imageReference,
    imageId: input.imageManifest.imageId,
    runtime: input.runtimeEvidence.runtime,
    securityLevel: input.runtimeEvidence.securityLevel,
    isolationProfileSha256: input.runtimeEvidence.isolationProfileSha256,
    runtimeEvidenceHash: input.runtimeEvidence.runtimeEvidenceHash,
    selectedProjectionHash,
    createRequestTemplateHash,
    createPlanHash,
  })
  plans.add(plan)
  planState.set(plan, Object.freeze({
    filesystem: input.filesystem,
    runtimeEvidence: input.runtimeEvidence,
    platform: `linux/${input.imageManifest.architecture}` as DockerEnginePinnedContainerPlatform,
    requestTemplate: template,
  }))
  return plan
}

function commitment(
  draft: DockerSidecarSemanticDraftV1,
  kind: DockerCodeOwnedContainerCreatePlanSidecarKindV1,
): Record<string, unknown> {
  if (!isDockerSidecarSemanticDraft(draft) || draft.sidecarKind !== kind) invalid()
  return draft.sidecarCommitment as Record<string, unknown>
}

export function createWhisperDockerContainerCreatePlan(input: Readonly<{
  readonly semanticDraft: DockerSidecarSemanticDraftV1
  readonly imageManifest: DockerImageRuntimeManifestV1
  readonly filesystem: DockerSidecarFilesystemEvidenceV1
  readonly runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>): DockerCodeOwnedContainerCreatePlanV1 {
  try {
    const record = exact(input, ['semanticDraft', 'imageManifest', 'filesystem', 'runtimeEvidence'])
    const draft = record.semanticDraft as DockerSidecarSemanticDraftV1
    const manifest = record.imageManifest as DockerImageRuntimeManifestV1
    const filesystem = record.filesystem as DockerSidecarFilesystemEvidenceV1
    const selectedRuntimeEvidence = selectRuntimeEvidence(record.runtimeEvidence, manifest)
    const values = commitment(draft, 'whisper')
    imageInvariant(manifest)
    if (!isDockerSidecarFilesystemEvidence(filesystem) || filesystem.kind !== 'whisper-input' ||
      !matchesCurrentNodeDockerSidecarFilesystemEvidence(filesystem) ||
      values['inputRootIdentityHash'] !== filesystem.rootIdentityHash ||
      values['inputRelativeNameHash'] !== filesystem.relativeNameHash) invalid()
    const limits = values['limits'] as Record<string, number>
    const root = resolveNodeDockerSidecarFilesystemRoot(filesystem)
    if (manifest.config.entrypoint.length === 0 || !manifest.config.entrypoint[0]!.startsWith('/') ||
      manifest.config.workingDir.length === 0 || !manifest.config.workingDir.startsWith('/')) invalid()
    const projection: ExpectedOwnedDockerContainerProjectionV2 = Object.freeze({
      version: 2,
      resourceKind: 'container',
      sidecarKind: 'whisper',
      role: 'worker',
      imageId: manifest.imageId,
      config: Object.freeze({
        image: manifest.imageReference,
        user: '65532:65532',
        env: resolvedEnvironment(manifest, {
          LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1', PYTHONSAFEPATH: '1', HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: String(Math.max(1,
            Math.floor(limits['cpuMillicores']! / 1_000))),
        }),
        entrypoint: manifest.config.entrypoint,
        cmd: manifest.config.cmd,
        workingDir: manifest.config.workingDir,
        openStdin: true,
        stdinOnce: false,
        tty: false,
        labels: manifest.config.labels,
        healthcheckDisabled: true,
        stopSignal: 'SIGTERM',
      }),
      hostConfig: commonHostConfig({
        memoryBytes: limits['memoryBytes']!, cpuMillicores: limits['cpuMillicores']!,
        pids: limits['pids']!, runtime: selectedRuntimeEvidence.runtime, nofile: 256,
        log: { type: 'none', config: {} },
      }),
      mounts: Object.freeze([Object.freeze({
        type: 'bind', source: root, destination: '/input', readOnly: true, propagation: 'rprivate',
      })]),
    })
    return makePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      runtimeEvidence: selectedRuntimeEvidence, projection,
    })
  } catch (error) {
    if (error instanceof DockerCodeOwnedContainerCreatePlanError) throw error
    invalid()
  }
}

export function createLeaseBoundDockerBashContainerCreatePlan(input: Readonly<{
  readonly semanticDraft: DockerSidecarSemanticDraftV1
  readonly imageManifest: DockerImageRuntimeManifestV1
  readonly filesystem: DockerSidecarFilesystemEvidenceV1
  readonly command: string
  readonly runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>): DockerCodeOwnedContainerCreatePlanV1 {
  try {
    const record = exact(input, [
      'semanticDraft', 'imageManifest', 'filesystem', 'command', 'runtimeEvidence',
    ])
    const draft = record.semanticDraft as DockerSidecarSemanticDraftV1
    const manifest = record.imageManifest as DockerImageRuntimeManifestV1
    const filesystem = record.filesystem as DockerSidecarFilesystemEvidenceV1
    const selectedRuntimeEvidence = selectRuntimeEvidence(record.runtimeEvidence, manifest)
    const values = commitment(draft, 'lease-bound-docker-bash')
    imageInvariant(manifest)
    const selectedCommand = command(record.command)
    const commandBytes = Buffer.byteLength(selectedCommand, 'utf8')
    const commandHash = createHash('sha256').update(selectedCommand).digest('hex')
    if (!isDockerSidecarFilesystemEvidence(filesystem) || filesystem.kind !== 'bash-workspace' ||
      !matchesCurrentNodeDockerSidecarFilesystemEvidence(filesystem) ||
      values['workspaceIdentityHash'] !== filesystem.rootIdentityHash ||
      values['instructionSha256'] !== commandHash || values['instructionBytes'] !== commandBytes ||
      values['isolationProfileSha256'] !== selectedRuntimeEvidence.isolationProfileSha256 ||
      !HASH.test(commandHash)) invalid()
    const limits = values['limits'] as Record<string, number>
    const root = resolveNodeDockerSidecarFilesystemRoot(filesystem)
    const projection: ExpectedOwnedDockerContainerProjectionV2 = Object.freeze({
      version: 2,
      resourceKind: 'container',
      sidecarKind: 'lease-bound-docker-bash',
      role: 'worker',
      imageId: manifest.imageId,
      config: Object.freeze({
        image: manifest.imageReference,
        user: '65532:65532',
        env: resolvedEnvironment(manifest, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
        entrypoint: Object.freeze(['/bin/sh']),
        cmd: Object.freeze(['-lc', selectedCommand]),
        workingDir: '/work',
        openStdin: false,
        stdinOnce: false,
        tty: false,
        labels: manifest.config.labels,
        healthcheckDisabled: true,
        stopSignal: 'SIGTERM',
      }),
      hostConfig: commonHostConfig({
        memoryBytes: limits['memoryBytes']!, cpuMillicores: limits['cpuMillicores']!,
        pids: limits['pids']!, runtime: selectedRuntimeEvidence.runtime, nofile: 1024,
        log: { type: 'local', config: {
          'max-size': String(limits['maximumOutputBytes']!), 'max-file': '1', compress: 'false',
        } },
      }),
      mounts: Object.freeze([Object.freeze({
        type: 'bind', source: root, destination: '/work', readOnly: false, propagation: 'rprivate',
      })]),
    })
    return makePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      runtimeEvidence: selectedRuntimeEvidence, projection,
    })
  } catch (error) {
    if (error instanceof DockerCodeOwnedContainerCreatePlanError) throw error
    invalid()
  }
}

export function isDockerCodeOwnedContainerCreatePlan(
  value: unknown,
): value is DockerCodeOwnedContainerCreatePlanV1 {
  return value !== null && typeof value === 'object' && !utilTypes.isProxy(value) && plans.has(value)
}

function ownershipLabels(
  descriptor: OwnedDockerCreateDescriptorV2,
): Readonly<Record<string, string>> {
  const keys = OWNED_DOCKER_LABEL_KEYS_V1
  const values = descriptor.labels
  const result = freezeMap({
    [keys.version]: values.version,
    [keys.installationId]: values.installationId,
    [keys.ownerBindingHash]: values.ownerBindingHash,
    [keys.sessionBindingHash]: values.sessionBindingHash,
    [keys.operationBindingHash]: values.operationBindingHash,
    [keys.sidecarKind]: values.sidecarKind,
    [keys.role]: values.role,
    [keys.policyHash]: values.policyHash,
  })
  if (Object.keys(result).length !== OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1.length ||
    OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1.some(key => !Object.hasOwn(result, key))) invalid()
  return result
}

function sealRequestBody(
  template: Readonly<Record<string, unknown>>,
  descriptor: OwnedDockerCreateDescriptorV2,
): Readonly<Record<string, unknown>> {
  const templateLabels = template['Labels']
  if (templateLabels === null || typeof templateLabels !== 'object' || Array.isArray(templateLabels) ||
    utilTypes.isProxy(templateLabels) || Object.keys(templateLabels).some(key => key.startsWith('com.aisy.'))) {
    invalid()
  }
  const labels = freezeMap({
    ...(templateLabels as Readonly<Record<string, string>>),
    ...ownershipLabels(descriptor),
  })
  const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, descriptorValue] of Object.entries(Object.getOwnPropertyDescriptors(template))) {
    if (!('value' in descriptorValue) || descriptorValue.enumerable !== true) invalid()
    Object.defineProperty(body, key, {
      value: key === 'Labels' ? labels : descriptorValue.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(body)
}

function exactPreparedDescriptor(
  plan: DockerCodeOwnedContainerCreatePlanV1,
  operation: OwnedDockerOperationHandle,
): OwnedDockerCreateDescriptorV2 {
  if (!isOwnedDockerOperationHandle(operation) || operation.resources.length !== 1) invalid()
  const descriptor = operation.resources[0]
  if (descriptor === undefined) invalid()
  const values = exact(descriptor, [
    'version', 'operationBindingHash', 'role', 'resourceKind', 'name', 'labels',
    'createProjectionContract', 'createProjectionHash',
  ])
  const labels = exact(values.labels, [
    'version', 'installationId', 'ownerBindingHash', 'sessionBindingHash',
    'operationBindingHash', 'sidecarKind', 'role', 'policyHash',
  ])
  if (values.version !== 2 || values.role !== 'worker' || values.resourceKind !== 'container' ||
    values.createProjectionContract !== 'container-selected-v2' ||
    values.createProjectionHash !== plan.selectedProjectionHash ||
    values.operationBindingHash !== operation.operationBindingHash ||
    typeof values.name !== 'string' || !RESOURCE_NAME.test(values.name) ||
    labels.version !== '1' || labels.operationBindingHash !== operation.operationBindingHash ||
    labels.sidecarKind !== plan.sidecarKind || labels.role !== 'worker' ||
    labels.policyHash !== plan.createPlanHash ||
    ['installationId', 'ownerBindingHash', 'sessionBindingHash', 'operationBindingHash', 'policyHash']
      .some(key => typeof labels[key] !== 'string' || !HASH.test(labels[key] as string))) invalid()
  return descriptor
}

/**
 * Publish exactly one prepared ledger intent and seal its code-owned create
 * request. The raw request stays module-private until a narrow pinned broker is
 * introduced; this function itself performs no Docker I/O.
 */
export function sealDockerCodeOwnedContainerCreatePlan(input: Readonly<{
  readonly plan: DockerCodeOwnedContainerCreatePlanV1
  readonly activeEpoch: OwnedDockerActiveEpoch
}>): DockerCodeOwnedContainerCreateSealV1 {
  try {
    const record = exact(input, ['plan', 'activeEpoch'])
    const plan = record.plan as DockerCodeOwnedContainerCreatePlanV1
    const activeEpoch = record.activeEpoch as OwnedDockerActiveEpoch
    if (!isDockerCodeOwnedContainerCreatePlan(plan) || consumedPlans.has(plan) ||
      !isOwnedDockerActiveEpoch(activeEpoch) ||
      !ownedDockerActiveEpochMatchesEndpointIdentity(activeEpoch, plan.endpointIdentity)) invalid()
    const hidden = planState.get(plan)
    if (hidden === undefined || !matchesCurrentNodeDockerSidecarFilesystemEvidence(hidden.filesystem) ||
      !isDockerEnginePinnedSandboxRuntimeEvidence(hidden.runtimeEvidence) ||
      digest(REQUEST_HASH_DOMAIN, hidden.requestTemplate as unknown as Canonical) !==
        plan.createRequestTemplateHash) invalid()

    // Burn before the only call that may allocate a durable operation.
    consumedPlans.add(plan)
    const operation = activeEpoch.prepare(Object.freeze({
      version: 2 as const,
      sidecarKind: plan.sidecarKind,
      policyHash: plan.createPlanHash,
      resources: Object.freeze([Object.freeze({
        version: 2 as const,
        role: 'worker' as const,
        resourceKind: 'container' as const,
        createProjectionContract: 'container-selected-v2' as const,
        createProjectionHash: plan.selectedProjectionHash,
      })]),
    }))
    const descriptor = exactPreparedDescriptor(plan, operation)
    const body = sealRequestBody(hidden.requestTemplate, descriptor)
    const request = Object.freeze({ name: descriptor.name, platform: hidden.platform, body })
    const sealedRequestHash = digest(SEALED_REQUEST_HASH_DOMAIN, request as unknown as Canonical)
    const seal: DockerCodeOwnedContainerCreateSealV1 = Object.freeze({
      [sealBrand]: true as const,
      version: 1,
      kind: 'aisy-docker-container-create-seal-v1',
      sidecarKind: plan.sidecarKind,
      role: 'worker',
      createPlanHash: plan.createPlanHash,
      selectedProjectionHash: plan.selectedProjectionHash,
      sealedRequestHash,
    })
    seals.add(seal)
    sealState.set(seal, Object.freeze({ plan, operation, descriptor, request }))
    return seal
  } catch (error) {
    if (error instanceof DockerCodeOwnedContainerCreatePlanError) throw error
    invalid()
  }
}

export function isDockerCodeOwnedContainerCreateSeal(
  value: unknown,
): value is DockerCodeOwnedContainerCreateSealV1 {
  return value !== null && typeof value === 'object' && !utilTypes.isProxy(value) &&
    seals.has(value) && sealState.has(value)
}

function descriptorLabelsMatchObserved(
  descriptor: OwnedDockerCreateDescriptorV2,
  observed: OwnedDockerObservedResourceV2,
): boolean {
  const expected = descriptor.labels
  const actual = observed.labels
  return actual.version === expected.version && actual.installationId === expected.installationId &&
    actual.ownerBindingHash === expected.ownerBindingHash &&
    actual.sessionBindingHash === expected.sessionBindingHash &&
    actual.operationBindingHash === expected.operationBindingHash &&
    actual.sidecarKind === expected.sidecarKind && actual.role === expected.role &&
    actual.policyHash === expected.policyHash
}

/** @internal Used only by the pinned create transport after consuming its attempted permit. */
export function dockerCodeOwnedContainerCreateSealMatchesWireRequest(
  seal: unknown,
  descriptor: unknown,
  platform: unknown,
  body: unknown,
): boolean {
  try {
    if (!isDockerCodeOwnedContainerCreateSeal(seal)) return false
    const state = sealState.get(seal)
    if (state === undefined || descriptor !== state.descriptor || platform !== state.request.platform ||
      body !== state.request.body || state.request.name !== state.descriptor.name) return false
    return digest(SEALED_REQUEST_HASH_DOMAIN, state.request as unknown as Canonical) ===
      seal.sealedRequestHash && canonical(state.request.body as unknown as Canonical).length > 0
  } catch {
    return false
  }
}

/** @internal Matches normalized post-create evidence without exposing sealed request bytes. */
export function dockerCodeOwnedContainerCreateSealMatchesObservedResource(
  seal: unknown,
  descriptor: unknown,
  observed: unknown,
): boolean {
  try {
    if (!isDockerCodeOwnedContainerCreateSeal(seal)) return false
    const state = sealState.get(seal)
    if (state === undefined || descriptor !== state.descriptor) return false
    const resource = snapshotExpectedOwnedDockerResourceV2(observed)
    return resource.resourceKind === 'container' && resource.networkEndpointCount === null &&
      resource.name === state.request.name &&
      resource.createProjectionContract === 'container-selected-v2' &&
      resource.createProjectionHash === seal.selectedProjectionHash &&
      descriptorLabelsMatchObserved(state.descriptor, resource)
  } catch {
    return false
  }
}

interface CreateBrokerPolicy {
  readonly seal: DockerCodeOwnedContainerCreateSealV1
  readonly socketPath: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxJsonNodes?: number
  readonly maxRequestBytes?: number
}

function brokerFail(
  code: NodeDockerCodeOwnedContainerCreateBrokerErrorCode,
): NodeDockerCodeOwnedContainerCreateBrokerError {
  return new NodeDockerCodeOwnedContainerCreateBrokerError(code)
}

function snapshotCreateBrokerPolicy(value: unknown): CreateBrokerPolicy {
  let descriptors: PropertyDescriptorMap
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
      throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  }
  const required = ['seal', 'socketPath'] as const
  const optional = ['timeoutMs', 'maxResponseBytes', 'maxJsonNodes', 'maxRequestBytes'] as const
  const allowed = new Set<string>([...required, ...optional])
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => descriptors[key] === undefined) || keys.some(key => {
      const descriptor = descriptors[key as string]
      return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
    })) throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  const seal = descriptors['seal']!.value as unknown
  const socketPath = descriptors['socketPath']!.value as unknown
  if (!isDockerCodeOwnedContainerCreateSeal(seal) || claimedSeals.has(seal) ||
    typeof socketPath !== 'string' || socketPath.length === 0 || socketPath.includes('\0')) {
    throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  }
  const policy: Record<string, unknown> = { seal, socketPath }
  for (const key of optional) {
    const candidate = descriptors[key]?.value as unknown
    if (candidate === undefined) continue
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
    }
    policy[key] = candidate
  }
  return Object.freeze(policy) as unknown as CreateBrokerPolicy
}

function snapshotBrokerSignal(
  value: Readonly<{ signal?: AbortSignal }> | undefined,
): AbortSignal | undefined {
  if (value === undefined) return undefined
  let descriptors: PropertyDescriptorMap
  try {
    if (value === null || typeof value !== 'object' || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
      throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
    }
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  }
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => key !== 'signal') || keys.length > 1 || keys.some(key => {
    const descriptor = descriptors[key as string]
    return descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true
  })) throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  return descriptors['signal']?.value as AbortSignal | undefined
}

function runtimeStillMatches(
  plan: DockerCodeOwnedContainerCreatePlanV1,
  evidence: DockerEnginePinnedSandboxRuntimeEvidenceV1,
): boolean {
  return isDockerEnginePinnedSandboxRuntimeEvidence(evidence) &&
    evidence.runtime === plan.runtime && evidence.securityLevel === plan.securityLevel &&
    evidence.isolationProfileSha256 === plan.isolationProfileSha256 &&
    evidence.runtimeEvidenceHash === plan.runtimeEvidenceHash &&
    sameEndpoint(evidence.endpointIdentity, plan.endpointIdentity)
}

function mapPreparedCreateFailure(
  error: unknown,
): NodeDockerCodeOwnedContainerCreateBrokerError {
  if (error instanceof NodeDockerCodeOwnedContainerCreateBrokerError) return error
  if (error instanceof DockerEnginePinnedPreparedContainerCreateError) {
    if (error.code === 'DOCKER_ENGINE_PREPARED_CREATE_ENDPOINT_MISMATCH') {
      return brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ENDPOINT_MISMATCH')
    }
    if (error.code === 'DOCKER_ENGINE_PREPARED_CREATE_ABORTED') {
      return brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ABORTED')
    }
    return brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_PREFLIGHT_FAILED')
  }
  return brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_PREFLIGHT_FAILED')
}

export function isNodeDockerCodeOwnedContainerCreateBroker(
  value: unknown,
): value is NodeDockerCodeOwnedContainerCreateBroker {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    createBrokers.has(value)
}

export function makeNodeDockerCodeOwnedContainerCreateBroker(
  input: Readonly<{
    seal: DockerCodeOwnedContainerCreateSealV1
    socketPath: string
    timeoutMs?: number
    maxResponseBytes?: number
    maxJsonNodes?: number
    maxRequestBytes?: number
  }>,
): NodeDockerCodeOwnedContainerCreateBroker {
  const policy = snapshotCreateBrokerPolicy(input)
  const state = sealState.get(policy.seal)
  const initialPlanHidden = state === undefined ? undefined : planState.get(state.plan)
  if (state === undefined || initialPlanHidden === undefined) {
    throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_INPUT_INVALID')
  }
  claimedSeals.add(policy.seal)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let commandUsed = false
  let inFlight = 0
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null
  let boundHandle: OwnedDockerBoundResourceHandle | null = null

  const finish = (): void => {
    inFlight -= 1
    if (lifecycle === 'closing' && inFlight === 0) {
      lifecycle = 'closed'
      resolveClose?.()
      resolveClose = null
    }
  }
  const begin = (): void => {
    if (lifecycle !== 'open') throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CLOSED')
    if (commandUsed) throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ALREADY_USED')
    commandUsed = true
    inFlight += 1
  }

  const broker: NodeDockerCodeOwnedContainerCreateBroker = {
    [createBrokerBrand]: true as const,
    async create(requestOptions?: Readonly<{ signal?: AbortSignal }>) {
      const signal = snapshotBrokerSignal(requestOptions)
      begin()
      let prepared: DockerEnginePinnedPreparedContainerCreate | null = null
      let dispatchStarted = false
      try {
        try {
          prepared = await prepareNodeDockerEnginePinnedContainerCreate({
            socketPath: policy.socketPath,
            endpointIdentity: state.plan.endpointIdentity,
            expectedRuntimeEvidence: initialPlanHidden.runtimeEvidence,
            ...(policy.timeoutMs === undefined ? {} : { timeoutMs: policy.timeoutMs }),
            ...(policy.maxResponseBytes === undefined ? {} : { maxResponseBytes: policy.maxResponseBytes }),
            ...(policy.maxJsonNodes === undefined ? {} : { maxJsonNodes: policy.maxJsonNodes }),
            ...(policy.maxRequestBytes === undefined ? {} : { maxRequestBytes: policy.maxRequestBytes }),
            ...(signal === undefined ? {} : { signal }),
          })
        } catch (error) {
          throw mapPreparedCreateFailure(error)
        }
        const planHidden = planState.get(state.plan)
        if (planHidden === undefined || !runtimeStillMatches(state.plan, planHidden.runtimeEvidence) ||
          !matchesCurrentNodeDockerSidecarFilesystemEvidence(planHidden.filesystem) ||
          digest(REQUEST_HASH_DOMAIN, planHidden.requestTemplate as unknown as Canonical) !==
            state.plan.createRequestTemplateHash ||
          digest(SEALED_REQUEST_HASH_DOMAIN, state.request as unknown as Canonical) !==
            policy.seal.sealedRequestHash ||
          canonical(state.request.body as unknown as Canonical).length === 0) {
          throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_AUTHORITY_LOST')
        }
        let callbackCalls = 0
        try {
          boundHandle = await state.operation.create('worker', async (descriptor, permit) => {
            callbackCalls += 1
            dispatchStarted = true
            if (callbackCalls !== 1 || descriptor !== state.descriptor) {
              return Object.freeze({ kind: 'create-ambiguous' as const })
            }
            try {
              const result = await prepared!.createAndInspect(Object.freeze({
                seal: policy.seal,
                permit,
                platform: state.request.platform,
                bodyJson: state.request.body as never,
              }))
              return result.outcome === 'created'
                ? result.attestedOutcome
                : Object.freeze({ kind: 'create-ambiguous' as const })
            } catch {
              return Object.freeze({ kind: 'create-ambiguous' as const })
            }
          })
        } catch {
          throw brokerFail(dispatchStarted
            ? 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED'
            : 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_AUTHORITY_LOST')
        }
        if (callbackCalls !== 1 || boundHandle === null) {
          throw brokerFail('DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED')
        }
        return Object.freeze({ kind: 'created-and-bound' as const })
      } finally {
        await prepared?.close()
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
  createBrokers.add(broker)
  return broker
}

export function dockerCodeOwnedContainerCreatePlanSelectedProjectionMatchesInspect(
  plan: DockerCodeOwnedContainerCreatePlanV1,
  inspect: unknown,
): boolean {
  try {
    if (!isDockerCodeOwnedContainerCreatePlan(plan)) return false
    const hidden = planState.get(plan)
    if (hidden === undefined || !matchesCurrentNodeDockerSidecarFilesystemEvidence(hidden.filesystem)) {
      return false
    }
    const observed = normalizeOwnedDockerContainerInspectProjectionV2(inspect)
    return observed.sidecarKind === plan.sidecarKind && observed.role === plan.role &&
      observed.imageId === plan.imageId && observed.projectionHash === plan.selectedProjectionHash
  } catch {
    return false
  }
}

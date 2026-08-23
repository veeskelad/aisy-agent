import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

const HASH_DOMAIN = 'aisy.owned-docker.semantic-draft.v1\0'
const MAX_DEPTH = 32
const MAX_NODES = 50_000
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_CANONICAL_BYTES = 1024 * 1024
const jsonStringify = JSON.stringify
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const LANGUAGE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/

const FORBIDDEN_KEYS = new Set([
  'url', 'command', 'path', 'credential', 'secret', 'token', 'signal', 'callback', 'method', 'body',
  'prepareinput', 'projectionhash', 'policyhash',
])

const semanticDraftBrand: unique symbol = Symbol('aisy.docker-sidecar-semantic-draft')
const semanticDrafts = new WeakSet<object>()

export type DockerSidecarSemanticKindV1 =
  | 'restricted-clone'
  | 'whisper'
  | 'lease-bound-docker-bash'

export type DockerSidecarSemanticRoleV1 = 'worker' | 'gateway' | 'network'
export type DockerSidecarSemanticResourceKindV1 = 'container' | 'network'

export type DockerSidecarSemanticEvidenceRequirementV1 =
  | 'image-runtime-manifest'
  | 'engine-create-inspect-manifest'
  | 'ipam-reservation-manifest'
  | 'endpoint-membership-manifest'
  | 'archive-stream-manifest'

export type DockerSidecarSemanticUseStepV1 =
  | 'attest-network'
  | 'attest-gateway'
  | 'attest-worker'
  | 'start-attached-worker'
  | 'attest-stopped-worker'
  | 'attest-daemon-isolation'
  | 'start-worker'
  | 'wait-worker'
  | 'read-worker-output'
  | 'attach-gateway-network'
  | 'start-gateway'
  | 'wait-gateway-ready'
  | 'attest-endpoint-membership'
  | 'stream-archive'

export interface DockerSidecarSemanticLedgerResourceV1 {
  readonly version: 1
  readonly role: DockerSidecarSemanticRoleV1
  readonly resourceKind: DockerSidecarSemanticResourceKindV1
}

export type DockerSidecarSafeCommitmentValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly DockerSidecarSafeCommitmentValueV1[]
  | { readonly [key: string]: DockerSidecarSafeCommitmentValueV1 }

interface SemanticDraftInputBaseV1 {
  readonly version: 1
  readonly sidecarKind: DockerSidecarSemanticKindV1
  readonly ledgerResources: readonly DockerSidecarSemanticLedgerResourceV1[]
  readonly createOrder: readonly DockerSidecarSemanticRoleV1[]
  readonly useSteps: readonly DockerSidecarSemanticUseStepV1[]
  readonly evidenceRequirements: readonly DockerSidecarSemanticEvidenceRequirementV1[]
  readonly sidecarCommitment: Readonly<Record<string, DockerSidecarSafeCommitmentValueV1>>
}

export interface WhisperDockerSemanticDraftInputV1 extends SemanticDraftInputBaseV1 {
  readonly sidecarKind: 'whisper'
  readonly ledgerResources: readonly [
    Readonly<{ version: 1; role: 'worker'; resourceKind: 'container' }>,
  ]
  readonly createOrder: readonly ['worker']
  readonly useSteps: readonly ['attest-worker', 'start-attached-worker', 'attest-stopped-worker']
  readonly evidenceRequirements: readonly [
    'image-runtime-manifest',
    'engine-create-inspect-manifest',
  ]
}

export interface LeaseBoundDockerBashSemanticDraftInputV1 extends SemanticDraftInputBaseV1 {
  readonly sidecarKind: 'lease-bound-docker-bash'
  readonly ledgerResources: readonly [
    Readonly<{ version: 1; role: 'worker'; resourceKind: 'container' }>,
  ]
  readonly createOrder: readonly ['worker']
  readonly useSteps: readonly [
    'attest-daemon-isolation',
    'attest-worker',
    'start-worker',
    'wait-worker',
    'attest-stopped-worker',
    'read-worker-output',
  ]
  readonly evidenceRequirements: readonly [
    'image-runtime-manifest',
    'engine-create-inspect-manifest',
  ]
}

export interface RestrictedCloneDockerSemanticDraftInputV1 extends SemanticDraftInputBaseV1 {
  readonly sidecarKind: 'restricted-clone'
  readonly ledgerResources: readonly [
    Readonly<{ version: 1; role: 'worker'; resourceKind: 'container' }>,
    Readonly<{ version: 1; role: 'gateway'; resourceKind: 'container' }>,
    Readonly<{ version: 1; role: 'network'; resourceKind: 'network' }>,
  ]
  readonly createOrder: readonly ['network', 'gateway', 'worker']
  readonly useSteps: readonly [
    'attest-network',
    'attest-gateway',
    'attest-worker',
    'attach-gateway-network',
    'attest-endpoint-membership',
    'start-gateway',
    'wait-gateway-ready',
    'start-worker',
    'wait-worker',
    'attest-stopped-worker',
    'stream-archive',
  ]
  readonly evidenceRequirements: readonly [
    'image-runtime-manifest',
    'engine-create-inspect-manifest',
    'ipam-reservation-manifest',
    'endpoint-membership-manifest',
    'archive-stream-manifest',
  ]
}

export type DockerSidecarSemanticDraftInputV1 =
  | WhisperDockerSemanticDraftInputV1
  | LeaseBoundDockerBashSemanticDraftInputV1
  | RestrictedCloneDockerSemanticDraftInputV1

export interface DockerSidecarSemanticDraftV1 {
  readonly [semanticDraftBrand]: true
  readonly version: 1
  readonly sidecarKind: DockerSidecarSemanticKindV1
  readonly ledgerResources: readonly DockerSidecarSemanticLedgerResourceV1[]
  readonly createOrder: readonly DockerSidecarSemanticRoleV1[]
  readonly useSteps: readonly DockerSidecarSemanticUseStepV1[]
  readonly evidenceRequirements: readonly DockerSidecarSemanticEvidenceRequirementV1[]
  readonly sidecarCommitment: Readonly<Record<string, DockerSidecarSafeCommitmentValueV1>>
  readonly semanticDraftHash: string
}

export type DockerSidecarSemanticDraftErrorCode = 'DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID'

export class DockerSidecarSemanticDraftError extends Error {
  constructor(readonly code: DockerSidecarSemanticDraftErrorCode) {
    super(code)
    this.name = 'DockerSidecarSemanticDraftError'
  }
}

type JsonScalar = null | boolean | number | string
type JsonValue = JsonScalar | readonly JsonValue[] | JsonRecord
interface JsonRecord { readonly [key: string]: JsonValue }
interface Budget { nodes: number; textBytes: number }
interface SemanticContract {
  readonly ledgerResources: readonly DockerSidecarSemanticLedgerResourceV1[]
  readonly createOrder: readonly DockerSidecarSemanticRoleV1[]
  readonly useSteps: readonly DockerSidecarSemanticUseStepV1[]
  readonly evidenceRequirements: readonly DockerSidecarSemanticEvidenceRequirementV1[]
}

function freezeResource(
  role: DockerSidecarSemanticRoleV1,
  resourceKind: DockerSidecarSemanticResourceKindV1,
): DockerSidecarSemanticLedgerResourceV1 {
  return Object.freeze({ resourceKind, role, version: 1 })
}

const CONTRACTS: Readonly<Record<DockerSidecarSemanticKindV1, SemanticContract>> = Object.freeze({
  whisper: Object.freeze({
    ledgerResources: Object.freeze([freezeResource('worker', 'container')]),
    createOrder: Object.freeze(['worker']),
    useSteps: Object.freeze(['attest-worker', 'start-attached-worker', 'attest-stopped-worker']),
    evidenceRequirements: Object.freeze([
      'image-runtime-manifest', 'engine-create-inspect-manifest',
    ]),
  } as const satisfies SemanticContract),
  'lease-bound-docker-bash': Object.freeze({
    ledgerResources: Object.freeze([freezeResource('worker', 'container')]),
    createOrder: Object.freeze(['worker']),
    useSteps: Object.freeze([
      'attest-daemon-isolation', 'attest-worker', 'start-worker', 'wait-worker',
      'attest-stopped-worker', 'read-worker-output',
    ]),
    evidenceRequirements: Object.freeze([
      'image-runtime-manifest', 'engine-create-inspect-manifest',
    ]),
  } as const satisfies SemanticContract),
  'restricted-clone': Object.freeze({
    ledgerResources: Object.freeze([
      freezeResource('worker', 'container'),
      freezeResource('gateway', 'container'),
      freezeResource('network', 'network'),
    ]),
    createOrder: Object.freeze(['network', 'gateway', 'worker']),
    useSteps: Object.freeze([
      'attest-network', 'attest-gateway', 'attest-worker', 'attach-gateway-network',
      'attest-endpoint-membership', 'start-gateway', 'wait-gateway-ready',
      'start-worker', 'wait-worker', 'attest-stopped-worker', 'stream-archive',
    ]),
    evidenceRequirements: Object.freeze([
      'image-runtime-manifest', 'engine-create-inspect-manifest', 'ipam-reservation-manifest',
      'endpoint-membership-manifest', 'archive-stream-manifest',
    ]),
  } as const satisfies SemanticContract),
})

function invalid(): DockerSidecarSemanticDraftError {
  return new DockerSidecarSemanticDraftError('DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID')
}

function chargeText(value: string, budget: Budget): void {
  const remaining = MAX_TEXT_BYTES - budget.textBytes
  if (value.length > remaining) throw invalid()
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > remaining) throw invalid()
  budget.textBytes += bytes
}

function snapshot(value: unknown, budget: Budget, depth = 0): JsonValue {
  budget.nodes += 1
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES || utilTypes.isProxy(value)) throw invalid()
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    chargeText(value, budget)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw invalid()
    return value
  }
  if (typeof value !== 'object') throw invalid()

  let descriptors: Record<string, PropertyDescriptor>
  try {
    if (Object.getOwnPropertySymbols(value).length !== 0) throw invalid()
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw invalid()
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid()
    const keys = Object.keys(descriptors).filter(key => key !== 'length')
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid()
    return Object.freeze(keys.map(key => {
      chargeText(key, budget)
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
      return snapshot(descriptor.value, budget, depth + 1)
    }))
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(descriptors).sort()) {
    chargeText(key, budget)
    const descriptor = descriptors[key]
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
    Object.defineProperty(result, key, {
      value: snapshot(descriptor.value, budget, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(result)
}

function exactRecord(value: unknown, keys: readonly string[], budget: Budget): JsonRecord {
  const result = snapshot(value, budget)
  if (result === null || typeof result !== 'object' || Array.isArray(result)) throw invalid()
  const actual = Object.keys(result)
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid()
  }
  return result as JsonRecord
}

function rejectForbiddenKeys(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenKeys(item)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw invalid()
    rejectForbiddenKeys(item)
  }
}

function exactSnapshotRecord(value: JsonValue, keys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const actual = Object.keys(value)
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid()
  }
  return value as JsonRecord
}

function exactLiteral(value: JsonValue | undefined, expected: JsonScalar): void {
  if (value !== expected) throw invalid()
}

function exactInteger(value: JsonValue | undefined, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) ||
    value < minimum || value > maximum) throw invalid()
  return value
}

function exactSha256(value: JsonValue | undefined): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid()
}

function validateWhisperCommitment(value: JsonValue): void {
  const commitment = exactSnapshotRecord(value, [
    'requestBindingHash', 'inputRootIdentityHash', 'inputRelativeNameHash', 'audioSha256',
    'audioBytes', 'language', 'protocolVersion', 'sandbox', 'limits',
  ])
  exactSha256(commitment['requestBindingHash'])
  exactSha256(commitment['inputRootIdentityHash'])
  exactSha256(commitment['inputRelativeNameHash'])
  exactSha256(commitment['audioSha256'])
  const audioBytes = exactInteger(commitment['audioBytes'], 1, 256 * 1024 * 1024)
  const language = commitment['language']
  if (language !== null && (typeof language !== 'string' || !LANGUAGE_PATTERN.test(language))) {
    throw invalid()
  }
  exactLiteral(commitment['protocolVersion'], 1)

  const sandbox = exactSnapshotRecord(commitment['sandbox']!, [
    'capabilities', 'filesystem', 'ipc', 'network', 'privilege', 'workspace',
  ])
  exactLiteral(sandbox['capabilities'], 'none')
  exactLiteral(sandbox['filesystem'], 'read-only-root')
  exactLiteral(sandbox['ipc'], 'none')
  exactLiteral(sandbox['network'], 'none')
  exactLiteral(sandbox['privilege'], 'non-root')
  exactLiteral(sandbox['workspace'], 'read-only')

  const limits = exactSnapshotRecord(commitment['limits']!, [
    'memoryBytes', 'cpuMillicores', 'pids', 'wallTimeMs', 'maximumInputBytes',
    'maximumOutputBytes',
  ])
  exactInteger(limits['memoryBytes'], 3 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024)
  exactInteger(limits['cpuMillicores'], 2_000, 8_000)
  exactInteger(limits['pids'], 64, 256)
  exactInteger(limits['wallTimeMs'], 1_000, 600_000)
  const maximumInputBytes = exactInteger(limits['maximumInputBytes'], 1, 256 * 1024 * 1024)
  exactLiteral(limits['maximumOutputBytes'], 2 * 1024 * 1024)
  if (audioBytes > maximumInputBytes) throw invalid()
}

function validateBashCommitment(value: JsonValue): void {
  const commitment = exactSnapshotRecord(value, [
    'leaseBindingHash', 'operationBindingHash', 'workspaceIdentityHash', 'instructionSha256',
    'instructionBytes', 'isolationProfileSha256', 'sandbox', 'limits',
  ])
  exactSha256(commitment['leaseBindingHash'])
  exactSha256(commitment['operationBindingHash'])
  exactSha256(commitment['workspaceIdentityHash'])
  exactSha256(commitment['instructionSha256'])
  exactInteger(commitment['instructionBytes'], 1, 128 * 1024)
  exactSha256(commitment['isolationProfileSha256'])

  const sandbox = exactSnapshotRecord(commitment['sandbox']!, [
    'capabilities', 'daemonIsolation', 'filesystem', 'ipc', 'network', 'privilege', 'workspace',
  ])
  exactLiteral(sandbox['capabilities'], 'none')
  exactLiteral(sandbox['daemonIsolation'], 'userns-or-rootless')
  exactLiteral(sandbox['filesystem'], 'read-only-root')
  exactLiteral(sandbox['ipc'], 'none')
  exactLiteral(sandbox['network'], 'none')
  exactLiteral(sandbox['privilege'], 'non-root')
  exactLiteral(sandbox['workspace'], 'read-write')

  const limits = exactSnapshotRecord(commitment['limits']!, [
    'memoryBytes', 'cpuMillicores', 'pids', 'wallTimeMs', 'maximumOutputBytes',
  ])
  exactInteger(limits['memoryBytes'], 64 * 1024 * 1024, 8 * 1024 * 1024 * 1024)
  exactInteger(limits['cpuMillicores'], 50, 8_000)
  exactInteger(limits['pids'], 8, 1_024)
  exactInteger(limits['wallTimeMs'], 1_000, 1_800_000)
  exactInteger(limits['maximumOutputBytes'], 1_024, 8 * 1024 * 1024)
}

function validateCloneCommitment(value: JsonValue): void {
  const commitment = exactSnapshotRecord(value, ['clone', 'network', 'isolation', 'limits', 'archive'])

  const clone = exactSnapshotRecord(commitment['clone']!, [
    'visibility', 'transport', 'redirects', 'authentication', 'hooks', 'submodules', 'lfsSmudge',
  ])
  exactLiteral(clone['visibility'], 'public')
  exactLiteral(clone['transport'], 'https')
  exactLiteral(clone['redirects'], false)
  exactLiteral(clone['authentication'], 'none')
  exactLiteral(clone['hooks'], false)
  exactLiteral(clone['submodules'], false)
  exactLiteral(clone['lfsSmudge'], false)

  const network = exactSnapshotRecord(commitment['network']!, [
    'driver', 'mode', 'internal', 'parentInterface', 'directExternalRoute', 'gatewayAttachment',
    'staticReservations', 'exactMembershipRequired', 'destinationPort', 'tlsHostnameSha256',
    'reviewedIpSetHash', 'reviewedIpCount', 'reviewedIpv4Count', 'reviewedIpv6Count',
    'tlsCertificateVerification', 'tlsSniRequired',
  ])
  exactLiteral(network['driver'], 'ipvlan')
  exactLiteral(network['mode'], 'l2')
  exactLiteral(network['internal'], true)
  exactLiteral(network['parentInterface'], false)
  exactLiteral(network['directExternalRoute'], false)
  exactLiteral(network['gatewayAttachment'], 'external-bridge-and-internal-ipvlan')
  const reservations = exactSnapshotRecord(network['staticReservations']!, ['count', 'roles'])
  exactLiteral(reservations['count'], 2)
  const roles = reservations['roles']
  if (!Array.isArray(roles) || roles.length !== 2 || roles[0] !== 'gateway' || roles[1] !== 'worker') {
    throw invalid()
  }
  exactLiteral(network['exactMembershipRequired'], true)
  exactLiteral(network['destinationPort'], 443)
  exactSha256(network['tlsHostnameSha256'])
  exactSha256(network['reviewedIpSetHash'])
  const reviewedIpCount = exactInteger(network['reviewedIpCount'], 1, 16)
  const reviewedIpv4Count = exactInteger(network['reviewedIpv4Count'], 0, 16)
  const reviewedIpv6Count = exactInteger(network['reviewedIpv6Count'], 0, 16)
  if (reviewedIpv4Count + reviewedIpv6Count !== reviewedIpCount) throw invalid()
  exactLiteral(network['tlsCertificateVerification'], true)
  exactLiteral(network['tlsSniRequired'], true)

  const isolation = exactSnapshotRecord(commitment['isolation']!, [
    'lifecycle', 'rootFilesystem', 'user', 'capabilities', 'noNewPrivileges', 'privileged',
    'hostNetwork', 'dockerSocket', 'inheritedAuthentication', 'workspace',
  ])
  exactLiteral(isolation['lifecycle'], 'one-shot-destroy-before-return')
  exactLiteral(isolation['rootFilesystem'], 'read-only')
  exactLiteral(isolation['user'], 'non-root')
  exactLiteral(isolation['capabilities'], 'none')
  exactLiteral(isolation['noNewPrivileges'], true)
  exactLiteral(isolation['privileged'], false)
  exactLiteral(isolation['hostNetwork'], false)
  exactLiteral(isolation['dockerSocket'], false)
  exactLiteral(isolation['inheritedAuthentication'], false)
  exactLiteral(isolation['workspace'], 'quota-tmpfs')

  const limits = exactSnapshotRecord(commitment['limits']!, [
    'wallTimeMs', 'workspaceBytes', 'memoryBytes', 'cpuMillicores', 'pids', 'outputBytes',
  ])
  exactInteger(limits['wallTimeMs'], 1_000, 600_000)
  const workspaceBytes = exactInteger(limits['workspaceBytes'], 1024 * 1024, 10 * 1024 * 1024 * 1024)
  exactInteger(limits['memoryBytes'], 64 * 1024 * 1024, 4 * 1024 * 1024 * 1024)
  exactInteger(limits['cpuMillicores'], 100, 4_000)
  exactInteger(limits['pids'], 8, 256)
  exactInteger(limits['outputBytes'], 0, 1024 * 1024)

  const archive = exactSnapshotRecord(commitment['archive']!, [
    'streamMaximumBytes', 'extractedMaximumBytes', 'entryMaximumBytes', 'entryCountMaximum',
    'destinationState', 'sourceTree', 'confinementScanBeforePublication', 'rejectLinks',
    'rejectSpecialFiles', 'rejectRootEscape',
  ])
  const streamMaximumBytes = exactInteger(archive['streamMaximumBytes'], 1, 12 * 1024 * 1024 * 1024)
  const extractedMaximumBytes = exactInteger(archive['extractedMaximumBytes'], 1, Number.MAX_SAFE_INTEGER)
  const entryMaximumBytes = exactInteger(archive['entryMaximumBytes'], 1, Number.MAX_SAFE_INTEGER)
  exactInteger(archive['entryCountMaximum'], 1, 1_000_000)
  if (streamMaximumBytes < extractedMaximumBytes || extractedMaximumBytes > workspaceBytes ||
    entryMaximumBytes > extractedMaximumBytes) throw invalid()
  exactLiteral(archive['destinationState'], 'existing-empty-staging')
  exactLiteral(archive['sourceTree'], 'repository-only')
  exactLiteral(archive['confinementScanBeforePublication'], true)
  exactLiteral(archive['rejectLinks'], true)
  exactLiteral(archive['rejectSpecialFiles'], true)
  exactLiteral(archive['rejectRootEscape'], true)
}

function validateCommitment(sidecarKind: DockerSidecarSemanticKindV1, value: JsonValue): void {
  if (sidecarKind === 'whisper') validateWhisperCommitment(value)
  else if (sidecarKind === 'lease-bound-docker-bash') validateBashCommitment(value)
  else validateCloneCommitment(value)
}

function canonical(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' || typeof value === 'string') return jsonStringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return `{${Object.keys(descriptors).sort().map(key => {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) throw invalid()
    return `${jsonStringify(key)}:${canonical(descriptor.value as JsonValue)}`
  }).join(',')}}`
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return canonical(left) === canonical(right)
}

function validateContract(record: JsonRecord): Readonly<{
  sidecarKind: DockerSidecarSemanticKindV1
  contract: SemanticContract
}> {
  const sidecarKind = record['sidecarKind']
  if (sidecarKind !== 'whisper' && sidecarKind !== 'lease-bound-docker-bash' &&
    sidecarKind !== 'restricted-clone') throw invalid()
  const contract = CONTRACTS[sidecarKind]
  if (!sameJson(record['ledgerResources']!, contract.ledgerResources as unknown as JsonValue) ||
    !sameJson(record['createOrder']!, contract.createOrder as JsonValue) ||
    !sameJson(record['useSteps']!, contract.useSteps as JsonValue) ||
    !sameJson(record['evidenceRequirements']!, contract.evidenceRequirements as JsonValue)) throw invalid()
  return Object.freeze({ sidecarKind, contract })
}

export function makeDockerSidecarSemanticDraft(
  input: DockerSidecarSemanticDraftInputV1,
): DockerSidecarSemanticDraftV1 {
  try {
    const budget: Budget = { nodes: 0, textBytes: 0 }
    const record = exactRecord(input, [
      'version', 'sidecarKind', 'ledgerResources', 'createOrder', 'useSteps',
      'evidenceRequirements', 'sidecarCommitment',
    ], budget)
    if (record['version'] !== 1) throw invalid()
    const { sidecarKind, contract } = validateContract(record)
    const commitment = record['sidecarCommitment']
    if (commitment === null || typeof commitment !== 'object' || Array.isArray(commitment)) throw invalid()
    rejectForbiddenKeys(commitment)
    validateCommitment(sidecarKind, commitment)
    const canonicalRecord = Object.freeze({
      version: 1 as const,
      sidecarKind,
      ledgerResources: contract.ledgerResources,
      createOrder: contract.createOrder,
      useSteps: contract.useSteps,
      evidenceRequirements: contract.evidenceRequirements,
      sidecarCommitment: commitment as JsonRecord,
    })
    const canonicalDraft = canonical(canonicalRecord as unknown as JsonValue)
    if (Buffer.byteLength(canonicalDraft, 'utf8') > MAX_CANONICAL_BYTES) throw invalid()
    const semanticDraftHash = createHash('sha256')
      .update(HASH_DOMAIN)
      .update(canonicalDraft)
      .digest('hex')
    const draft = Object.freeze({
      [semanticDraftBrand]: true as const,
      ...canonicalRecord,
      semanticDraftHash,
    })
    semanticDrafts.add(draft)
    return draft
  } catch {
    throw invalid()
  }
}

export function isDockerSidecarSemanticDraft(value: unknown): value is DockerSidecarSemanticDraftV1 {
  return typeof value === 'object' && value !== null && semanticDrafts.has(value)
}

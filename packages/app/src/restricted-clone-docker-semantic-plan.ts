import { types as utilTypes } from 'node:util'

import {
  DockerSidecarSemanticDraftError,
  makeDockerSidecarSemanticDraft,
  type DockerSidecarSemanticDraftV1,
  type RestrictedCloneDockerSemanticDraftInputV1,
} from './docker-sidecar-code-owned-plans.js'

export interface RestrictedCloneDockerSemanticLimitsV1 {
  readonly wallTimeMs: number
  readonly workspaceBytes: number
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly outputBytes: number
}

export interface RestrictedCloneDockerArchiveBoundsV1 {
  readonly streamMaximumBytes: number
  readonly extractedMaximumBytes: number
  readonly entryMaximumBytes: number
  readonly entryCountMaximum: number
}

export interface RestrictedCloneDockerSemanticPlanInputV1 {
  readonly version: 1
  readonly tlsHostnameSha256: string
  readonly reviewedIpSetHash: string
  readonly reviewedIpCount: number
  readonly reviewedIpv4Count: number
  readonly reviewedIpv6Count: number
  readonly limits: RestrictedCloneDockerSemanticLimitsV1
  readonly archive: RestrictedCloneDockerArchiveBoundsV1
}

const SHA256 = /^[a-f0-9]{64}$/
const MAX_REVIEWED_IPS = 16
const MAX_ARCHIVE_STREAM_BYTES = 12 * 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 1_000_000

const LIMIT_BOUNDS = Object.freeze({
  wallTimeMs: Object.freeze([1_000, 600_000] as const),
  workspaceBytes: Object.freeze([1_048_576, 10_737_418_240] as const),
  memoryBytes: Object.freeze([67_108_864, 4_294_967_296] as const),
  cpuMillicores: Object.freeze([100, 4_000] as const),
  pids: Object.freeze([8, 256] as const),
  outputBytes: Object.freeze([0, 1_048_576] as const),
})

type DataDescriptors = Record<string, PropertyDescriptor & { readonly value: unknown }>

function invalid(): DockerSidecarSemanticDraftError {
  return new DockerSidecarSemanticDraftError('DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID')
}

function exactDataDescriptors(value: unknown, keys: readonly string[]): DataDescriptors {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    utilTypes.isProxy(value)) throw invalid()
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Object.keys(descriptors).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) throw invalid()
    for (const key of actual) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw invalid()
      }
    }
    return descriptors as DataDescriptors
  } catch {
    throw invalid()
  }
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) ||
    (value as number) < minimum || (value as number) > maximum) throw invalid()
  return value as number
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid()
  return value
}

function snapshotLimits(value: unknown): RestrictedCloneDockerSemanticLimitsV1 {
  const fields = exactDataDescriptors(value, Object.keys(LIMIT_BOUNDS))
  return Object.freeze({
    wallTimeMs: integer(fields['wallTimeMs']!.value, ...LIMIT_BOUNDS.wallTimeMs),
    workspaceBytes: integer(fields['workspaceBytes']!.value, ...LIMIT_BOUNDS.workspaceBytes),
    memoryBytes: integer(fields['memoryBytes']!.value, ...LIMIT_BOUNDS.memoryBytes),
    cpuMillicores: integer(fields['cpuMillicores']!.value, ...LIMIT_BOUNDS.cpuMillicores),
    pids: integer(fields['pids']!.value, ...LIMIT_BOUNDS.pids),
    outputBytes: integer(fields['outputBytes']!.value, ...LIMIT_BOUNDS.outputBytes),
  })
}

function snapshotArchive(
  value: unknown,
  workspaceBytes: number,
): RestrictedCloneDockerArchiveBoundsV1 {
  const fields = exactDataDescriptors(value, [
    'streamMaximumBytes', 'extractedMaximumBytes', 'entryMaximumBytes', 'entryCountMaximum',
  ])
  const archive = Object.freeze({
    streamMaximumBytes: integer(fields['streamMaximumBytes']!.value, 1, MAX_ARCHIVE_STREAM_BYTES),
    extractedMaximumBytes: integer(
      fields['extractedMaximumBytes']!.value, 1, Number.MAX_SAFE_INTEGER,
    ),
    entryMaximumBytes: integer(fields['entryMaximumBytes']!.value, 1, Number.MAX_SAFE_INTEGER),
    entryCountMaximum: integer(fields['entryCountMaximum']!.value, 1, MAX_ARCHIVE_ENTRIES),
  })
  if (archive.streamMaximumBytes < archive.extractedMaximumBytes ||
    archive.extractedMaximumBytes > workspaceBytes ||
    archive.entryMaximumBytes > archive.extractedMaximumBytes) throw invalid()
  return archive
}

export function makeRestrictedCloneDockerSemanticPlan(
  input: RestrictedCloneDockerSemanticPlanInputV1,
): DockerSidecarSemanticDraftV1 {
  const fields = exactDataDescriptors(input, [
    'version', 'tlsHostnameSha256', 'reviewedIpSetHash', 'reviewedIpCount',
    'reviewedIpv4Count', 'reviewedIpv6Count', 'limits', 'archive',
  ])
  if (fields['version']!.value !== 1) throw invalid()
  const tlsHostnameSha256 = sha256(fields['tlsHostnameSha256']!.value)
  const reviewedIpSetHash = sha256(fields['reviewedIpSetHash']!.value)
  const reviewedIpCount = integer(fields['reviewedIpCount']!.value, 1, MAX_REVIEWED_IPS)
  const reviewedIpv4Count = integer(fields['reviewedIpv4Count']!.value, 0, MAX_REVIEWED_IPS)
  const reviewedIpv6Count = integer(fields['reviewedIpv6Count']!.value, 0, MAX_REVIEWED_IPS)
  if (reviewedIpv4Count + reviewedIpv6Count !== reviewedIpCount) throw invalid()
  const limits = snapshotLimits(fields['limits']!.value)
  const archive = snapshotArchive(fields['archive']!.value, limits.workspaceBytes)

  const draft: RestrictedCloneDockerSemanticDraftInputV1 = {
    version: 1,
    sidecarKind: 'restricted-clone',
    ledgerResources: [
      { version: 1, role: 'worker', resourceKind: 'container' },
      { version: 1, role: 'gateway', resourceKind: 'container' },
      { version: 1, role: 'network', resourceKind: 'network' },
    ],
    createOrder: ['network', 'gateway', 'worker'],
    useSteps: [
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
    ],
    evidenceRequirements: [
      'image-runtime-manifest',
      'engine-create-inspect-manifest',
      'ipam-reservation-manifest',
      'endpoint-membership-manifest',
      'archive-stream-manifest',
    ],
    sidecarCommitment: {
      clone: {
        visibility: 'public',
        transport: 'https',
        redirects: false,
        authentication: 'none',
        hooks: false,
        submodules: false,
        lfsSmudge: false,
      },
      network: {
        driver: 'ipvlan',
        mode: 'l2',
        internal: true,
        parentInterface: false,
        directExternalRoute: false,
        gatewayAttachment: 'external-bridge-and-internal-ipvlan',
        staticReservations: {
          count: 2,
          roles: ['gateway', 'worker'],
        },
        exactMembershipRequired: true,
        destinationPort: 443,
        tlsHostnameSha256,
        reviewedIpSetHash,
        reviewedIpCount,
        reviewedIpv4Count,
        reviewedIpv6Count,
        tlsCertificateVerification: true,
        tlsSniRequired: true,
      },
      isolation: {
        lifecycle: 'one-shot-destroy-before-return',
        rootFilesystem: 'read-only',
        user: 'non-root',
        capabilities: 'none',
        noNewPrivileges: true,
        privileged: false,
        hostNetwork: false,
        dockerSocket: false,
        inheritedAuthentication: false,
        workspace: 'quota-tmpfs',
      },
      limits: { ...limits },
      archive: {
        ...archive,
        destinationState: 'existing-empty-staging',
        sourceTree: 'repository-only',
        confinementScanBeforePublication: true,
        rejectLinks: true,
        rejectSpecialFiles: true,
        rejectRootEscape: true,
      },
    },
  }
  return makeDockerSidecarSemanticDraft(draft)
}

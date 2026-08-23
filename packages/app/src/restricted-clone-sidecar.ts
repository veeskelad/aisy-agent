import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  isPublicRestrictedCloneAddress,
  type RestrictedCloneTarget,
} from '@aisy/core'
import type { RestrictedProjectCloneTransport } from './project-provisioner.js'

export const RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION = 1 as const

export interface RestrictedCloneSidecarLimits {
  readonly wallTimeMs: number
  readonly diskBytes: number
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly outputBytes: number
}

export interface RestrictedCloneSidecarRequest {
  readonly protocolVersion: typeof RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION
  readonly executionId: string
  readonly policyHash: string
  readonly imageDigest: string
  readonly staging: Readonly<{
    source: string
    identity: string
    mode: 'supervisor-export-only'
  }>
  readonly target: Readonly<{
    url: string
    hostname: string
    port: 443
    addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[]
  }>
  readonly sandbox: Readonly<{
    lifecycle: 'one-shot-destroy-before-return'
    rootFilesystem: 'read-only'
    user: 'non-root'
    capabilities: readonly []
    noNewPrivileges: true
    privileged: false
    hostNetwork: false
    dockerSocket: false
    directExternalRoute: false
    environment: 'allowlisted-non-secret'
    inheritedCredentials: false
    workspace: Readonly<{
      mode: 'quota-tmpfs-export'
      target: '/workspace'
      exportSource: '/workspace/repo/.'
      sizeBytes: number
    }>
    network: Readonly<{
      mode: 'isolated-egress-gateway-only'
      tlsServerName: string
      allowedEndpoints: readonly Readonly<{ address: string; port: 443 }>[]
    }>
    limits: RestrictedCloneSidecarLimits
  }>
  readonly git: Readonly<{
    allowedProtocols: readonly ['https']
    followRedirects: false
    hooksPath: '/dev/null'
    credentialHelper: 'disabled'
    terminalPrompt: false
    recurseSubmodules: false
    lfsSmudge: false
  }>
}

export interface RestrictedCloneSidecarAttestation {
  readonly protocolVersion: typeof RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION
  readonly executionId: string
  readonly policyHash: string
  readonly imageDigest: string
  readonly stagingIdentity: string
  readonly outcome: 'succeeded' | 'failed' | 'timed-out' | 'quota-exceeded' | 'cancelled'
  readonly exitCode: number | null
  readonly outputBytes: number
  readonly sandboxDestroyed: true
  readonly applied: Readonly<{
    network: 'isolated-egress-gateway-only'
    credentials: 'none'
    hostNetwork: false
    dockerSocket: false
    privileged: false
  }>
}

export interface RestrictedCloneSidecarSupervisor {
  run(
    request: RestrictedCloneSidecarRequest,
    signal?: AbortSignal,
  ): Promise<RestrictedCloneSidecarAttestation>
}

export type RestrictedCloneSidecarErrorCode =
  | 'CLONE_SIDECAR_POLICY_INVALID'
  | 'CLONE_SIDECAR_STAGING_DENIED'
  | 'CLONE_SIDECAR_CANCELLED'
  | 'CLONE_SIDECAR_SUPERVISOR_FAILED'
  | 'CLONE_SIDECAR_ATTESTATION_DENIED'
  | 'CLONE_SIDECAR_EXECUTION_FAILED'

export class RestrictedCloneSidecarError extends Error {
  constructor(public readonly code: RestrictedCloneSidecarErrorCode) {
    super(code)
    this.name = 'RestrictedCloneSidecarError'
  }
}

export interface RestrictedCloneStagingInspection {
  readonly canonicalRoot: string
  readonly identity: string
}

const DEFAULT_LIMITS: RestrictedCloneSidecarLimits = Object.freeze({
  wallTimeMs: 300_000,
  diskBytes: 1_073_741_824,
  memoryBytes: 536_870_912,
  cpuMillicores: 1_000,
  pids: 64,
  outputBytes: 65_536,
})

const LIMIT_BOUNDS = Object.freeze({
  wallTimeMs: [1_000, 600_000],
  diskBytes: [1_048_576, 10_737_418_240],
  memoryBytes: [67_108_864, 4_294_967_296],
  cpuMillicores: [100, 4_000],
  pids: [8, 256],
  outputBytes: [0, 1_048_576],
} satisfies Record<keyof RestrictedCloneSidecarLimits, readonly [number, number]>)

const EXECUTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const IMAGE_DIGEST = /^[^\s\u0000-\u001f\u007f@]+@sha256:[a-f0-9]{64}$/
const SHA256 = /^[a-f0-9]{64}$/

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested)
    Object.freeze(value)
  }
  return value
}

function cleanLimits(input?: Partial<RestrictedCloneSidecarLimits>): RestrictedCloneSidecarLimits {
  const limits = { ...DEFAULT_LIMITS, ...input }
  for (const [key, [minimum, maximum]] of Object.entries(LIMIT_BOUNDS) as
    [keyof RestrictedCloneSidecarLimits, readonly [number, number]][]) {
    const value = limits[key]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
    }
  }
  return Object.freeze(limits)
}

function cleanImageDigest(value: string): string {
  if (value.length > 512 || !IMAGE_DIGEST.test(value)) {
    throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
  }
  return value
}

function copyTarget(target: RestrictedCloneTarget): RestrictedCloneSidecarRequest['target'] {
  let parsed: URL
  try {
    parsed = new URL(target.url)
  } catch {
    throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
  }
  const parsedHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' ||
    parsed.port !== '' || parsed.search !== '' || parsed.hash !== '' || parsed.pathname === '/' ||
    parsed.href !== target.url || parsedHostname !== target.hostname || target.port !== 443 ||
    target.addresses.length === 0 ||
    target.transportPolicy.connectOnlyToReviewedAddresses !== true ||
    target.transportPolicy.preserveTlsServerName !== true ||
    target.transportPolicy.followRedirects !== false) {
    throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
  }
  const seen = new Set<string>()
  const addresses = target.addresses.map((entry) => {
    if (!isPublicRestrictedCloneAddress(entry)) {
      throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
    }
    const identity = `${entry.family}:${entry.address}`
    if (seen.has(identity)) throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
    seen.add(identity)
    return { address: entry.address, family: entry.family }
  })
  addresses.sort((left, right) => left.family - right.family || left.address.localeCompare(right.address))
  return freezeDeep({
    url: target.url,
    hostname: target.hostname,
    port: 443 as const,
    addresses,
  })
}

function inspectNodeStaging(path: string): RestrictedCloneStagingInspection {
  const canonicalRoot = resolve(path)
  const stat = lstatSync(canonicalRoot, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(canonicalRoot) !== canonicalRoot) {
    throw new RestrictedCloneSidecarError('CLONE_SIDECAR_STAGING_DENIED')
  }
  return { canonicalRoot, identity: `${stat.dev.toString()}:${stat.ino.toString()}` }
}

function exactAttestationKeys(value: unknown): value is RestrictedCloneSidecarAttestation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const expected = [
    'applied', 'executionId', 'exitCode', 'imageDigest', 'outcome', 'outputBytes',
    'policyHash', 'protocolVersion', 'sandboxDestroyed', 'stagingIdentity',
  ]
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function attestationMatches(
  value: unknown,
  request: RestrictedCloneSidecarRequest,
): value is RestrictedCloneSidecarAttestation {
  if (!exactAttestationKeys(value)) return false
  const applied = value.applied
  if (applied === null || typeof applied !== 'object' || Array.isArray(applied) ||
    Object.keys(applied).sort().join(',') !==
      'credentials,dockerSocket,hostNetwork,network,privileged') return false
  return value.protocolVersion === request.protocolVersion &&
    value.executionId === request.executionId &&
    value.policyHash === request.policyHash && SHA256.test(value.policyHash) &&
    value.imageDigest === request.imageDigest &&
    value.stagingIdentity === request.staging.identity &&
    ['succeeded', 'failed', 'timed-out', 'quota-exceeded', 'cancelled'].includes(value.outcome) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    Number.isSafeInteger(value.outputBytes) && value.outputBytes >= 0 &&
    value.outputBytes <= request.sandbox.limits.outputBytes &&
    value.sandboxDestroyed === true &&
    applied.network === 'isolated-egress-gateway-only' && applied.credentials === 'none' &&
    applied.hostNetwork === false && applied.dockerSocket === false && applied.privileged === false
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new RestrictedCloneSidecarError('CLONE_SIDECAR_CANCELLED')
  }
}

export function makeRestrictedCloneSidecarTransport(deps: {
  projectsRoot: string
  imageDigest: string
  supervisor: RestrictedCloneSidecarSupervisor
  newId: () => string
  limits?: Partial<RestrictedCloneSidecarLimits>
  inspectStaging?: (path: string) => RestrictedCloneStagingInspection
  audit?: (event: Readonly<{
    type: 'clone-sidecar-started' | 'clone-sidecar-succeeded' | 'clone-sidecar-denied'
    executionId: string
    policyHash?: string
    code?: RestrictedCloneSidecarErrorCode
  }>) => void
}): RestrictedProjectCloneTransport {
  const projectsRoot = resolve(deps.projectsRoot)
  const imageDigest = cleanImageDigest(deps.imageDigest)
  const limits = cleanLimits(deps.limits)
  const inspectStaging = deps.inspectStaging ?? inspectNodeStaging
  const emit = (event: Parameters<NonNullable<typeof deps.audit>>[0]) => {
    try { deps.audit?.(Object.freeze(event)) } catch { /* derived observability */ }
  }

  return {
    async clone(input): Promise<void> {
      cancelled(input.signal)
      const executionId = deps.newId()
      if (!EXECUTION_ID.test(executionId)) {
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID')
      }
      let before: RestrictedCloneStagingInspection
      try {
        before = inspectStaging(input.stagingRoot)
      } catch (error) {
        if (error instanceof RestrictedCloneSidecarError) throw error
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_STAGING_DENIED')
      }
      if (before.canonicalRoot !== resolve(input.stagingRoot) ||
        dirname(before.canonicalRoot) !== projectsRoot ||
        !basename(before.canonicalRoot).startsWith('.aisy-staging-') ||
        before.identity.trim().length === 0) {
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_STAGING_DENIED')
      }
      const target = copyTarget(input.target)
      const policy = freezeDeep({
        imageDigest,
        staging: {
          source: before.canonicalRoot,
          identity: before.identity,
          mode: 'supervisor-export-only' as const,
        },
        target,
        sandbox: {
          lifecycle: 'one-shot-destroy-before-return' as const,
          rootFilesystem: 'read-only' as const,
          user: 'non-root' as const,
          capabilities: [] as const,
          noNewPrivileges: true as const,
          privileged: false as const,
          hostNetwork: false as const,
          dockerSocket: false as const,
          directExternalRoute: false as const,
          environment: 'allowlisted-non-secret' as const,
          inheritedCredentials: false as const,
          workspace: {
            mode: 'quota-tmpfs-export' as const,
            target: '/workspace' as const,
            exportSource: '/workspace/repo/.' as const,
            sizeBytes: limits.diskBytes,
          },
          network: {
            mode: 'isolated-egress-gateway-only' as const,
            tlsServerName: target.hostname,
            allowedEndpoints: target.addresses.map(({ address }) => ({ address, port: 443 as const })),
          },
          limits,
        },
        git: {
          allowedProtocols: ['https'] as const,
          followRedirects: false as const,
          hooksPath: '/dev/null' as const,
          credentialHelper: 'disabled' as const,
          terminalPrompt: false as const,
          recurseSubmodules: false as const,
          lfsSmudge: false as const,
        },
      })
      const policyHash = hash(policy)
      const request = freezeDeep({
        protocolVersion: RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION,
        executionId,
        policyHash,
        ...policy,
      } satisfies RestrictedCloneSidecarRequest)
      emit({ type: 'clone-sidecar-started', executionId, policyHash })

      let attestation: RestrictedCloneSidecarAttestation
      try {
        attestation = await deps.supervisor.run(
          request,
          ...(input.signal === undefined ? [] : [input.signal]),
        )
      } catch {
        if (input.signal?.aborted === true) {
          emit({ type: 'clone-sidecar-denied', executionId, code: 'CLONE_SIDECAR_CANCELLED' })
          throw new RestrictedCloneSidecarError('CLONE_SIDECAR_CANCELLED')
        }
        emit({ type: 'clone-sidecar-denied', executionId, code: 'CLONE_SIDECAR_SUPERVISOR_FAILED' })
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_SUPERVISOR_FAILED')
      }
      let attested = false
      try { attested = attestationMatches(attestation, request) } catch { attested = false }
      if (!attested) {
        emit({ type: 'clone-sidecar-denied', executionId, code: 'CLONE_SIDECAR_ATTESTATION_DENIED' })
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_ATTESTATION_DENIED')
      }
      cancelled(input.signal)
      let after: RestrictedCloneStagingInspection
      try {
        after = inspectStaging(input.stagingRoot)
      } catch {
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_STAGING_DENIED')
      }
      if (after.canonicalRoot !== before.canonicalRoot || after.identity !== before.identity) {
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_STAGING_DENIED')
      }
      if (attestation.outcome !== 'succeeded' || attestation.exitCode !== 0) {
        emit({ type: 'clone-sidecar-denied', executionId, code: 'CLONE_SIDECAR_EXECUTION_FAILED' })
        throw new RestrictedCloneSidecarError('CLONE_SIDECAR_EXECUTION_FAILED')
      }
      emit({ type: 'clone-sidecar-succeeded', executionId, policyHash })
    },
  }
}

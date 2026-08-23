import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DockerSidecarSemanticDraftError } from './docker-sidecar-code-owned-plans.js'
import {
  makeRestrictedCloneDockerSemanticPlan,
  type RestrictedCloneDockerSemanticPlanInputV1,
} from './restricted-clone-docker-semantic-plan.js'

const TLS_HOSTNAME_SHA256 = 'a'.repeat(64)
const REVIEWED_IP_SET_HASH = 'b'.repeat(64)

function planInput(): RestrictedCloneDockerSemanticPlanInputV1 {
  return {
    version: 1,
    tlsHostnameSha256: TLS_HOSTNAME_SHA256,
    reviewedIpSetHash: REVIEWED_IP_SET_HASH,
    reviewedIpCount: 3,
    reviewedIpv4Count: 2,
    reviewedIpv6Count: 1,
    limits: {
      wallTimeMs: 300_000,
      workspaceBytes: 1_073_741_824,
      memoryBytes: 536_870_912,
      cpuMillicores: 1_000,
      pids: 64,
      outputBytes: 65_536,
    },
    archive: {
      streamMaximumBytes: 4_294_967_296,
      extractedMaximumBytes: 1_073_741_824,
      entryMaximumBytes: 1_073_741_824,
      entryCountMaximum: 100_000,
    },
  }
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: 'DockerSidecarSemanticDraftError',
    code: 'DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID',
    message: 'DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID',
  } satisfies Partial<DockerSidecarSemanticDraftError>))
}

describe('restricted clone Docker semantic plan', () => {
  it('builds the exact code-owned graph and privacy-narrowed commitment', () => {
    const plan = makeRestrictedCloneDockerSemanticPlan(planInput())

    expect(plan.sidecarKind).toBe('restricted-clone')
    expect(plan.ledgerResources).toEqual([
      { version: 1, role: 'worker', resourceKind: 'container' },
      { version: 1, role: 'gateway', resourceKind: 'container' },
      { version: 1, role: 'network', resourceKind: 'network' },
    ])
    expect(plan.createOrder).toEqual(['network', 'gateway', 'worker'])
    expect(plan.useSteps).toEqual([
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
    ])
    expect(plan.evidenceRequirements).toEqual([
      'image-runtime-manifest',
      'engine-create-inspect-manifest',
      'ipam-reservation-manifest',
      'endpoint-membership-manifest',
      'archive-stream-manifest',
    ])
    expect(plan.sidecarCommitment).toEqual({
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
        staticReservations: { count: 2, roles: ['gateway', 'worker'] },
        exactMembershipRequired: true,
        destinationPort: 443,
        tlsHostnameSha256: TLS_HOSTNAME_SHA256,
        reviewedIpSetHash: REVIEWED_IP_SET_HASH,
        reviewedIpCount: 3,
        reviewedIpv4Count: 2,
        reviewedIpv6Count: 1,
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
      limits: planInput().limits,
      archive: {
        ...planInput().archive,
        destinationState: 'existing-empty-staging',
        sourceTree: 'repository-only',
        confinementScanBeforePublication: true,
        rejectLinks: true,
        rejectSpecialFiles: true,
        rejectRootEscape: true,
      },
    })
    expect(Object.keys(plan.sidecarCommitment['network'] as object)).not.toContain('tlsHost')
    expect(Object.keys(plan.sidecarCommitment['network'] as object)).not.toContain('reviewedIps')
  })

  it('rejects hostile descriptors and proxies without invoking caller code', () => {
    let getterCalls = 0
    const accessor = planInput() as unknown as Record<string, unknown>
    Object.defineProperty(accessor, 'archive', {
      enumerable: true,
      get() {
        getterCalls += 1
        return planInput().archive
      },
    })
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(
      accessor as unknown as RestrictedCloneDockerSemanticPlanInputV1,
    ))
    expect(getterCalls).toBe(0)

    let trapCalls = 0
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        trapCalls += 1
        return Object.prototype
      },
      ownKeys() {
        trapCalls += 1
        return []
      },
    })
    const proxied = planInput() as unknown as Record<string, unknown>
    proxied['limits'] = proxy
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(
      proxied as unknown as RestrictedCloneDockerSemanticPlanInputV1,
    ))
    expect(trapCalls).toBe(0)
  })

  it('rejects malformed hashes, inconsistent membership and unsafe bounds', () => {
    const malformedHash = planInput() as unknown as Record<string, unknown>
    malformedHash['tlsHostnameSha256'] = 'A'.repeat(64)
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(
      malformedHash as unknown as RestrictedCloneDockerSemanticPlanInputV1,
    ))

    const inconsistent = planInput() as unknown as Record<string, unknown>
    inconsistent['reviewedIpv6Count'] = 2
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(
      inconsistent as unknown as RestrictedCloneDockerSemanticPlanInputV1,
    ))

    const oversizedExtraction = planInput()
    ;(oversizedExtraction.archive as unknown as Record<string, unknown>)['extractedMaximumBytes'] =
      oversizedExtraction.limits.workspaceBytes + 1
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(oversizedExtraction))

    const oversizedEntry = planInput()
    ;(oversizedEntry.archive as unknown as Record<string, unknown>)['entryMaximumBytes'] =
      oversizedEntry.archive.extractedMaximumBytes + 1
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(oversizedEntry))

    const extra = { ...planInput(), extra: true }
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(
      extra as unknown as RestrictedCloneDockerSemanticPlanInputV1,
    ))
  })

  it('enforces exact code-owned archive ceilings and stream capacity', () => {
    const boundary = planInput()
    ;(boundary.archive as unknown as Record<string, unknown>)['streamMaximumBytes'] =
      12 * 1024 * 1024 * 1024
    ;(boundary.archive as unknown as Record<string, unknown>)['entryCountMaximum'] = 1_000_000
    expect(makeRestrictedCloneDockerSemanticPlan(boundary).sidecarCommitment['archive'])
      .toEqual(expect.objectContaining({
        streamMaximumBytes: 12 * 1024 * 1024 * 1024,
        entryCountMaximum: 1_000_000,
      }))

    const oversizedStream = planInput()
    ;(oversizedStream.archive as unknown as Record<string, unknown>)['streamMaximumBytes'] =
      12 * 1024 * 1024 * 1024 + 1
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(oversizedStream))

    const excessiveEntries = planInput()
    ;(excessiveEntries.archive as unknown as Record<string, unknown>)['entryCountMaximum'] =
      1_000_001
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(excessiveEntries))

    const insufficientStream = planInput()
    ;(insufficientStream.archive as unknown as Record<string, unknown>)['streamMaximumBytes'] =
      insufficientStream.archive.extractedMaximumBytes - 1
    expectInvalid(() => makeRestrictedCloneDockerSemanticPlan(insufficientStream))
  })

  it('snapshots caller input and deeply freezes the result', () => {
    const input = planInput()
    const plan = makeRestrictedCloneDockerSemanticPlan(input)
    ;(input.limits as unknown as Record<string, unknown>)['wallTimeMs'] = 1_000
    ;(input.archive as unknown as Record<string, unknown>)['entryCountMaximum'] = 1

    expect((plan.sidecarCommitment['limits'] as Record<string, unknown>)['wallTimeMs'])
      .toBe(300_000)
    expect((plan.sidecarCommitment['archive'] as Record<string, unknown>)['entryCountMaximum'])
      .toBe(100_000)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.ledgerResources)).toBe(true)
    expect(Object.isFrozen(plan.useSteps)).toBe(true)
    expect(Object.isFrozen(plan.sidecarCommitment)).toBe(true)
    expect(Object.isFrozen(plan.sidecarCommitment['network'])).toBe(true)
    expect(Object.isFrozen(plan.sidecarCommitment['limits'])).toBe(true)
    expect(Object.isFrozen(plan.sidecarCommitment['archive'])).toBe(true)
  })

  it('remains dormant and absent from the production binary composition', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(production).not.toContain('restricted-clone-docker-semantic-plan')
  })
})

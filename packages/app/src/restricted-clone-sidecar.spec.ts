import { describe, expect, it, vi } from 'vitest'
import type { RestrictedCloneTarget } from '@aisy/core'
import {
  makeRestrictedCloneSidecarTransport,
  RestrictedCloneSidecarError,
  type RestrictedCloneSidecarAttestation,
  type RestrictedCloneSidecarRequest,
} from './restricted-clone-sidecar.js'

const PROJECTS_ROOT = '/srv/aisy/projects'
const STAGING_ROOT = `${PROJECTS_ROOT}/.aisy-staging-recovery-1`
const IMAGE = `registry.example/aisy/git-clone@sha256:${'a'.repeat(64)}`

function target(): RestrictedCloneTarget {
  return {
    url: 'https://git.example.org/team/repo.git',
    hostname: 'git.example.org',
    port: 443,
    addresses: [
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ],
    transportPolicy: {
      connectOnlyToReviewedAddresses: true,
      preserveTlsServerName: true,
      followRedirects: false,
    },
  }
}

function attestation(
  request: RestrictedCloneSidecarRequest,
  overrides: Partial<RestrictedCloneSidecarAttestation> = {},
): RestrictedCloneSidecarAttestation {
  return {
    protocolVersion: 1,
    executionId: request.executionId,
    policyHash: request.policyHash,
    imageDigest: request.imageDigest,
    stagingIdentity: request.staging.identity,
    outcome: 'succeeded',
    exitCode: 0,
    outputBytes: 0,
    sandboxDestroyed: true,
    applied: {
      network: 'isolated-egress-gateway-only',
      credentials: 'none',
      hostNetwork: false,
      dockerSocket: false,
      privileged: false,
    },
    ...overrides,
  }
}

function runtime(input: {
  run?: (request: RestrictedCloneSidecarRequest) => Promise<RestrictedCloneSidecarAttestation>
  inspect?: (path: string) => { canonicalRoot: string; identity: string }
  audit?: (event: Readonly<Record<string, unknown>>) => void
} = {}) {
  const requests: RestrictedCloneSidecarRequest[] = []
  const run = vi.fn(input.run ?? (async (request: RestrictedCloneSidecarRequest) => {
    requests.push(request)
    return attestation(request)
  }))
  const inspect = vi.fn(input.inspect ?? ((path: string) => ({
    canonicalRoot: path,
    identity: 'device-7:inode-42',
  })))
  const transport = makeRestrictedCloneSidecarTransport({
    projectsRoot: PROJECTS_ROOT,
    imageDigest: IMAGE,
    supervisor: { run },
    newId: () => 'clone-execution-1',
    inspectStaging: inspect,
    ...(input.audit === undefined ? {} : { audit: input.audit }),
  })
  return { inspect, requests, run, transport }
}

describe('restricted clone sidecar transport', () => {
  it('builds a frozen credential-free one-shot policy with exact reviewed egress', async () => {
    const events: Readonly<Record<string, unknown>>[] = []
    const { requests, transport } = runtime({ audit: (event) => events.push(event) })

    await transport.clone({ target: target(), stagingRoot: STAGING_ROOT })

    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.sandbox.network.allowedEndpoints)).toBe(true)
    expect(request.imageDigest).toBe(IMAGE)
    expect(request.staging).toEqual({
      source: STAGING_ROOT,
      identity: 'device-7:inode-42',
      mode: 'supervisor-export-only',
    })
    expect(request.sandbox).toMatchObject({
      lifecycle: 'one-shot-destroy-before-return',
      rootFilesystem: 'read-only',
      user: 'non-root',
      capabilities: [],
      noNewPrivileges: true,
      privileged: false,
      hostNetwork: false,
      dockerSocket: false,
      directExternalRoute: false,
      environment: 'allowlisted-non-secret',
      inheritedCredentials: false,
      workspace: {
        mode: 'quota-tmpfs-export',
        target: '/workspace',
        exportSource: '/workspace/repo/.',
        sizeBytes: 1_073_741_824,
      },
      network: {
        mode: 'isolated-egress-gateway-only',
        tlsServerName: 'git.example.org',
        allowedEndpoints: [
          { address: '93.184.216.34', port: 443 },
          { address: '2001:4860:4860::8888', port: 443 },
        ],
      },
    })
    expect(request.git).toEqual({
      allowedProtocols: ['https'],
      followRedirects: false,
      hooksPath: '/dev/null',
      credentialHelper: 'disabled',
      terminalPrompt: false,
      recurseSubmodules: false,
      lfsSmudge: false,
    })
    expect(request.policyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(request)).not.toContain('token')
    expect(JSON.stringify(request)).not.toContain('password')
    expect(events).toEqual([
      expect.objectContaining({ type: 'clone-sidecar-started', executionId: 'clone-execution-1' }),
      expect.objectContaining({ type: 'clone-sidecar-succeeded', executionId: 'clone-execution-1' }),
    ])
    expect(events.every((event) => !('stagingRoot' in event) && !('url' in event))).toBe(true)
  })

  it('rejects a non-digest image before a supervisor can be composed', () => {
    expect(() => makeRestrictedCloneSidecarTransport({
      projectsRoot: PROJECTS_ROOT,
      imageDigest: 'registry.example/aisy/git-clone:latest',
      supervisor: { run: vi.fn() },
      newId: () => 'clone-execution-1',
      inspectStaging: () => ({ canonicalRoot: STAGING_ROOT, identity: '1:2' }),
    })).toThrowError(new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID'))
  })

  it('rejects staging outside the exact projects root before supervisor execution', async () => {
    const { run, transport } = runtime()

    await expect(transport.clone({
      target: target(),
      stagingRoot: '/srv/aisy/other/.aisy-staging-recovery-1',
    })).rejects.toMatchObject({ code: 'CLONE_SIDECAR_STAGING_DENIED' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects a weakened upstream transport policy before supervisor execution', async () => {
    const weakened = target()
    ;(weakened.transportPolicy as { followRedirects: boolean }).followRedirects = true
    const { run, transport } = runtime()

    await expect(transport.clone({ target: weakened, stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_POLICY_INVALID' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rechecks public address policy instead of trusting a forged TypeScript target', async () => {
    const forged = target() as {
      addresses: Array<{ address: string; family: 4 | 6 }>
    } & RestrictedCloneTarget
    forged.addresses.splice(0, forged.addresses.length, { address: '10.0.0.7', family: 4 })
    const { run, transport } = runtime()

    await expect(transport.clone({ target: forged, stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_POLICY_INVALID' })
    expect(run).not.toHaveBeenCalled()
  })

  it('fails closed when supervisor attestation does not match the exact policy hash', async () => {
    const { transport } = runtime({
      run: async (request) => attestation(request, { policyHash: 'b'.repeat(64) }),
    })

    await expect(transport.clone({ target: target(), stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_ATTESTATION_DENIED' })
  })

  it('fails closed on extra supervisor output fields', async () => {
    const { transport } = runtime({
      run: async (request) => ({ ...attestation(request), rawLog: 'unexpected' } as RestrictedCloneSidecarAttestation),
    })

    await expect(transport.clone({ target: target(), stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_ATTESTATION_DENIED' })
  })

  it('requires a destroyed sandbox even when Git reports success', async () => {
    const { transport } = runtime({
      run: async (request) => ({
        ...attestation(request),
        sandboxDestroyed: false,
      } as unknown as RestrictedCloneSidecarAttestation),
    })

    await expect(transport.clone({ target: target(), stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_ATTESTATION_DENIED' })
  })

  it('maps a quota failure to a stable redacted execution error', async () => {
    const events: Readonly<Record<string, unknown>>[] = []
    const { transport } = runtime({
      run: async (request) => attestation(request, {
        outcome: 'quota-exceeded',
        exitCode: null,
      }),
      audit: (event) => events.push(event),
    })

    await expect(transport.clone({ target: target(), stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_EXECUTION_FAILED' })
    expect(events.at(-1)).toEqual({
      type: 'clone-sidecar-denied',
      executionId: 'clone-execution-1',
      code: 'CLONE_SIDECAR_EXECUTION_FAILED',
    })
  })

  it('detects staging directory replacement across the sidecar run', async () => {
    let inspection = 0
    const { transport } = runtime({
      inspect: (path) => ({ canonicalRoot: path, identity: `device-7:inode-${++inspection}` }),
    })

    await expect(transport.clone({ target: target(), stagingRoot: STAGING_ROOT }))
      .rejects.toMatchObject({ code: 'CLONE_SIDECAR_STAGING_DENIED' })
  })

  it('does not start a supervisor for an already-cancelled operation', async () => {
    const controller = new AbortController()
    controller.abort()
    const { run, transport } = runtime()

    await expect(transport.clone({
      target: target(),
      stagingRoot: STAGING_ROOT,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CLONE_SIDECAR_CANCELLED' })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects invalid resource limits during composition', () => {
    expect(() => makeRestrictedCloneSidecarTransport({
      projectsRoot: PROJECTS_ROOT,
      imageDigest: IMAGE,
      supervisor: { run: vi.fn() },
      newId: () => 'clone-execution-1',
      limits: { pids: 10_000 },
      inspectStaging: () => ({ canonicalRoot: STAGING_ROOT, identity: '1:2' }),
    })).toThrowError(new RestrictedCloneSidecarError('CLONE_SIDECAR_POLICY_INVALID'))
  })
})

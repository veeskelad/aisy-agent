import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  DockerSidecarSemanticDraftError,
  isDockerSidecarSemanticDraft,
  makeDockerSidecarSemanticDraft,
  type DockerSidecarSemanticDraftInputV1,
  type LeaseBoundDockerBashSemanticDraftInputV1,
  type RestrictedCloneDockerSemanticDraftInputV1,
  type WhisperDockerSemanticDraftInputV1,
} from './docker-sidecar-code-owned-plans.js'

const HASH = 'a'.repeat(64)

function whisperCommitment(): Record<string, unknown> {
  return {
    requestBindingHash: HASH,
    inputRootIdentityHash: HASH,
    inputRelativeNameHash: HASH,
    audioSha256: HASH,
    audioBytes: 1024,
    language: 'en',
    protocolVersion: 1,
    sandbox: {
      capabilities: 'none',
      filesystem: 'read-only-root',
      ipc: 'none',
      network: 'none',
      privilege: 'non-root',
      workspace: 'read-only',
    },
    limits: {
      memoryBytes: 3 * 1024 * 1024 * 1024,
      cpuMillicores: 2_000,
      pids: 64,
      wallTimeMs: 60_000,
      maximumInputBytes: 16 * 1024 * 1024,
      maximumOutputBytes: 2 * 1024 * 1024,
    },
  }
}

function bashCommitment(): Record<string, unknown> {
  return {
    leaseBindingHash: HASH,
    operationBindingHash: HASH,
    workspaceIdentityHash: HASH,
    instructionSha256: HASH,
    instructionBytes: 1024,
    isolationProfileSha256: HASH,
    sandbox: {
      capabilities: 'none',
      daemonIsolation: 'userns-or-rootless',
      filesystem: 'read-only-root',
      ipc: 'none',
      network: 'none',
      privilege: 'non-root',
      workspace: 'read-write',
    },
    limits: {
      memoryBytes: 512 * 1024 * 1024,
      cpuMillicores: 1_000,
      pids: 64,
      wallTimeMs: 60_000,
      maximumOutputBytes: 1024 * 1024,
    },
  }
}

function cloneCommitment(): Record<string, unknown> {
  return {
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
      tlsHostnameSha256: HASH,
      reviewedIpSetHash: HASH,
      reviewedIpCount: 2,
      reviewedIpv4Count: 1,
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
    limits: {
      wallTimeMs: 60_000,
      workspaceBytes: 512 * 1024 * 1024,
      memoryBytes: 512 * 1024 * 1024,
      cpuMillicores: 1_000,
      pids: 64,
      outputBytes: 1024 * 1024,
    },
    archive: {
      streamMaximumBytes: 512 * 1024 * 1024,
      extractedMaximumBytes: 256 * 1024 * 1024,
      entryMaximumBytes: 64 * 1024 * 1024,
      entryCountMaximum: 100_000,
      destinationState: 'existing-empty-staging',
      sourceTree: 'repository-only',
      confinementScanBeforePublication: true,
      rejectLinks: true,
      rejectSpecialFiles: true,
      rejectRootEscape: true,
    },
  }
}

function whisperInput(
  sidecarCommitment: Record<string, unknown> = whisperCommitment(),
): WhisperDockerSemanticDraftInputV1 {
  return {
    version: 1,
    sidecarKind: 'whisper',
    ledgerResources: [{ version: 1, role: 'worker', resourceKind: 'container' }],
    createOrder: ['worker'],
    useSteps: ['attest-worker', 'start-attached-worker', 'attest-stopped-worker'],
    evidenceRequirements: ['image-runtime-manifest', 'engine-create-inspect-manifest'],
    sidecarCommitment,
  } as WhisperDockerSemanticDraftInputV1
}

function bashInput(
  sidecarCommitment: Record<string, unknown> = bashCommitment(),
): LeaseBoundDockerBashSemanticDraftInputV1 {
  return {
    version: 1,
    sidecarKind: 'lease-bound-docker-bash',
    ledgerResources: [{ version: 1, role: 'worker', resourceKind: 'container' }],
    createOrder: ['worker'],
    useSteps: [
      'attest-daemon-isolation', 'attest-worker', 'start-worker', 'wait-worker',
      'attest-stopped-worker', 'read-worker-output',
    ],
    evidenceRequirements: ['image-runtime-manifest', 'engine-create-inspect-manifest'],
    sidecarCommitment,
  } as LeaseBoundDockerBashSemanticDraftInputV1
}

function cloneInput(
  sidecarCommitment: Record<string, unknown> = cloneCommitment(),
): RestrictedCloneDockerSemanticDraftInputV1 {
  return {
    version: 1,
    sidecarKind: 'restricted-clone',
    ledgerResources: [
      { version: 1, role: 'worker', resourceKind: 'container' },
      { version: 1, role: 'gateway', resourceKind: 'container' },
      { version: 1, role: 'network', resourceKind: 'network' },
    ],
    createOrder: ['network', 'gateway', 'worker'],
    useSteps: [
      'attest-network', 'attest-gateway', 'attest-worker', 'attach-gateway-network',
      'attest-endpoint-membership', 'start-gateway', 'wait-gateway-ready',
      'start-worker', 'wait-worker', 'attest-stopped-worker', 'stream-archive',
    ],
    evidenceRequirements: [
      'image-runtime-manifest', 'engine-create-inspect-manifest',
      'ipam-reservation-manifest', 'endpoint-membership-manifest',
      'archive-stream-manifest',
    ],
    sidecarCommitment,
  } as RestrictedCloneDockerSemanticDraftInputV1
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: 'DockerSidecarSemanticDraftError',
    code: 'DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID',
    message: 'DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID',
  } satisfies Partial<DockerSidecarSemanticDraftError>))
}

describe('code-owned Docker sidecar semantic drafts', () => {
  it('accepts only the exact code-owned graph for every sidecar kind', () => {
    const whisper = makeDockerSidecarSemanticDraft(whisperInput())
    const bash = makeDockerSidecarSemanticDraft(bashInput())
    const clone = makeDockerSidecarSemanticDraft(cloneInput())

    expect(whisper.createOrder).toEqual(['worker'])
    expect(bash.useSteps).toEqual([
      'attest-daemon-isolation', 'attest-worker', 'start-worker', 'wait-worker',
      'attest-stopped-worker', 'read-worker-output',
    ])
    expect(clone.createOrder).toEqual(['network', 'gateway', 'worker'])
    expect(clone.useSteps).toEqual([
      'attest-network', 'attest-gateway', 'attest-worker', 'attach-gateway-network',
      'attest-endpoint-membership', 'start-gateway', 'wait-gateway-ready',
      'start-worker', 'wait-worker', 'attest-stopped-worker', 'stream-archive',
    ])
    expect(clone.ledgerResources.map(item => item.role)).toEqual(['worker', 'gateway', 'network'])
    expect(clone.evidenceRequirements).toEqual([
      'image-runtime-manifest', 'engine-create-inspect-manifest',
      'ipam-reservation-manifest', 'endpoint-membership-manifest',
      'archive-stream-manifest',
    ])
    for (const draft of [whisper, bash, clone]) {
      expect(draft.semanticDraftHash).toMatch(/^[a-f0-9]{64}$/)
      expect(isDockerSidecarSemanticDraft(draft)).toBe(true)
      expect(Object.isFrozen(draft)).toBe(true)
      expect(Object.isFrozen(draft.ledgerResources)).toBe(true)
      expect(Object.isFrozen(draft.sidecarCommitment)).toBe(true)
    }
  })

  it('hashes a canonical descriptor snapshot independent of caller key order', () => {
    const commitment = whisperCommitment()
    const reordered = {
      limits: commitment['limits'],
      sandbox: commitment['sandbox'],
      protocolVersion: commitment['protocolVersion'],
      language: commitment['language'],
      audioBytes: commitment['audioBytes'],
      audioSha256: commitment['audioSha256'],
      inputRelativeNameHash: commitment['inputRelativeNameHash'],
      inputRootIdentityHash: commitment['inputRootIdentityHash'],
      requestBindingHash: commitment['requestBindingHash'],
    }
    const left = makeDockerSidecarSemanticDraft(whisperInput(commitment))
    const right = makeDockerSidecarSemanticDraft(whisperInput(reordered))
    expect(left.semanticDraftHash).toBe(right.semanticDraftHash)
    expect(left).toEqual(right)
    expect(Object.isFrozen(left.sidecarCommitment['sandbox'])).toBe(true)
  })

  it('does not invoke inherited toJSON hooks while hashing', () => {
    const baseline = makeDockerSidecarSemanticDraft(whisperInput())
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    let polluted: ReturnType<typeof makeDockerSidecarSemanticDraft> | undefined
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          calls += 1
          return 'polluted-object'
        },
      })
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          calls += 1
          return 'polluted-array'
        },
      })
      polluted = makeDockerSidecarSemanticDraft(whisperInput())
    } finally {
      if (objectDescriptor === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor)
      if (arrayDescriptor === undefined) delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor)
    }
    expect(calls).toBe(0)
    expect(polluted?.semanticDraftHash).toBe(baseline.semanticDraftHash)
  })

  it('uses WeakSet authenticity rather than a forgeable structural brand', () => {
    const draft = makeDockerSidecarSemanticDraft(whisperInput())
    expect(isDockerSidecarSemanticDraft({ ...draft })).toBe(false)
    expect(isDockerSidecarSemanticDraft(structuredClone({
      version: draft.version,
      semanticDraftHash: draft.semanticDraftHash,
    }))).toBe(false)
  })

  it('rejects graph drift and unknown top-level fields', () => {
    const wrongOrder = cloneInput() as unknown as Record<string, unknown>
    wrongOrder['createOrder'] = ['worker', 'gateway', 'network']
    expectInvalid(() => makeDockerSidecarSemanticDraft(
      wrongOrder as unknown as DockerSidecarSemanticDraftInputV1,
    ))

    const unknown = { ...whisperInput(), extra: true }
    expectInvalid(() => makeDockerSidecarSemanticDraft(
      unknown as unknown as DockerSidecarSemanticDraftInputV1,
    ))
  })

  it('rejects accessors without invoking them', () => {
    let calls = 0
    const commitment: Record<string, unknown> = {}
    Object.defineProperty(commitment, 'nested', {
      enumerable: true,
      get() {
        calls += 1
        return 'unsafe'
      },
    })
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput(commitment)))
    expect(calls).toBe(0)
  })

  it('rejects nested proxies and symbols', () => {
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
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({ nested: proxy })))
    expect(trapCalls).toBe(0)

    const symbolic: Record<string | symbol, unknown> = { safe: true }
    symbolic[Symbol('hidden')] = true
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({ nested: symbolic })))
  })

  it('rejects every raw authority or transport key at any commitment depth', () => {
    const forbidden = [
      'url', 'command', 'path', 'credential', 'secret', 'token', 'signal', 'callback',
      'method', 'body', 'prepareInput', 'projectionHash', 'policyHash',
    ]
    for (const key of forbidden) {
      expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
        outer: [{ [key]: 'not-allowed' }],
      })))
      expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
        outer: { [key.toUpperCase()]: 'not-allowed' },
      })))
    }
  })

  it('rejects raw alias keys through every direct generic-factory path', () => {
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      ...whisperCommitment(), payload: 'arbitrary-runtime-authority',
    })))
    expectInvalid(() => makeDockerSidecarSemanticDraft(bashInput({
      ...bashCommitment(), value: 'arbitrary-runtime-authority',
    })))
    expectInvalid(() => makeDockerSidecarSemanticDraft(cloneInput({
      ...cloneCommitment(), payload: 'https://unreviewed.example/repository.git',
    })))
  })

  it('rejects allowed fields moved into the wrong commitment object', () => {
    const whisper = whisperCommitment()
    const { audioSha256: _audioSha256, ...withoutAudioHash } = whisper
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      ...withoutAudioHash,
      limits: {
        ...(whisper['limits'] as Record<string, unknown>),
        audioSha256: HASH,
      },
    })))

    const clone = cloneCommitment()
    const network = clone['network'] as Record<string, unknown>
    const { tlsHostnameSha256: _tlsHostnameSha256, ...withoutTlsHostnameHash } = network
    expectInvalid(() => makeDockerSidecarSemanticDraft(cloneInput({
      ...clone,
      network: withoutTlsHostnameHash,
      isolation: {
        ...(clone['isolation'] as Record<string, unknown>),
        tlsHostnameSha256: HASH,
      },
    })))
  })

  it('rejects invalid fixed literals and meaningful numeric relationships', () => {
    const whisper = whisperCommitment()
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      ...whisper,
      sandbox: {
        ...(whisper['sandbox'] as Record<string, unknown>),
        network: 'bridge',
      },
    })))
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      ...whisper,
      limits: {
        ...(whisper['limits'] as Record<string, unknown>),
        memoryBytes: 3 * 1024 * 1024 * 1024 - 1,
      },
    })))
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      ...whisper,
      audioBytes: 2048,
      limits: {
        ...(whisper['limits'] as Record<string, unknown>),
        maximumInputBytes: 1024,
      },
    })))

    const bash = bashCommitment()
    expectInvalid(() => makeDockerSidecarSemanticDraft(bashInput({
      ...bash,
      instructionBytes: 0,
    })))

    const clone = cloneCommitment()
    expectInvalid(() => makeDockerSidecarSemanticDraft(cloneInput({
      ...clone,
      network: {
        ...(clone['network'] as Record<string, unknown>),
        reviewedIpCount: 3,
      },
    })))
    expectInvalid(() => makeDockerSidecarSemanticDraft(cloneInput({
      ...clone,
      archive: {
        ...(clone['archive'] as Record<string, unknown>),
        entryMaximumBytes: 257 * 1024 * 1024,
      },
    })))
  })

  it('rejects non-JSON numbers and non-plain values instead of coercing them', () => {
    for (const value of [NaN, Infinity, -Infinity, -0, 1.5, 2n, new Date(0)]) {
      expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({ value })))
    }
  })

  it('enforces depth, node and UTF-8 text bounds', () => {
    let deep: Record<string, unknown> = {}
    for (let index = 0; index < 40; index += 1) deep = { nested: deep }
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput(deep)))

    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      nodes: Array.from({ length: 50_000 }, () => null),
    })))

    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      text: 'я'.repeat(524_289),
    })))
  })

  it('enforces canonical-byte bounds for escape-heavy content', () => {
    expectInvalid(() => makeDockerSidecarSemanticDraft(whisperInput({
      escaped: '\u0000'.repeat(180_000),
    })))
  })

  it('remains dormant and absent from the production binary composition', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(production).not.toContain('docker-sidecar-code-owned-plans')
  })
})

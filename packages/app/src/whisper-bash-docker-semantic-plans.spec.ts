import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DockerSidecarSemanticDraftError } from './docker-sidecar-code-owned-plans.js'
import {
  makeLeaseBoundDockerBashSemanticPlan,
  makeWhisperDockerSemanticPlan,
  type LeaseBoundDockerBashSemanticPlanInputV1,
  type WhisperDockerSemanticPlanInputV1,
} from './whisper-bash-docker-semantic-plans.js'

const hashes = {
  first: '1'.repeat(64),
  second: '2'.repeat(64),
  third: '3'.repeat(64),
  fourth: '4'.repeat(64),
}

function whisperInput(): WhisperDockerSemanticPlanInputV1 {
  return {
    requestBindingHash: hashes.first,
    inputRootIdentityHash: hashes.second,
    inputRelativeNameHash: hashes.third,
    audioSha256: hashes.fourth,
    audioBytes: 65_536,
    language: 'ru',
    protocolVersion: 1,
    limits: {
      memoryBytes: 3 * 1024 * 1024 * 1024,
      cpuMillicores: 2_000,
      pids: 64,
      wallTimeMs: 600_000,
      maximumInputBytes: 256 * 1024 * 1024,
      maximumOutputBytes: 2 * 1024 * 1024,
    },
  }
}

function bashInput(): LeaseBoundDockerBashSemanticPlanInputV1 {
  return {
    leaseBindingHash: hashes.first,
    operationBindingHash: hashes.second,
    workspaceIdentityHash: hashes.third,
    instructionSha256: hashes.fourth,
    instructionBytes: 4_096,
    isolationProfileSha256: '5'.repeat(64),
    limits: {
      memoryBytes: 512 * 1024 * 1024,
      cpuMillicores: 1_000,
      pids: 128,
      wallTimeMs: 120_000,
      maximumOutputBytes: 1024 * 1024,
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

function nestedKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  return Object.entries(value).flatMap(([key, item]) => [key, ...nestedKeys(item)])
}

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) return sourceFiles(location)
    return entry.isFile() && entry.name.endsWith('.ts') ? [location] : []
  })
}

describe('Whisper and lease-bound Bash Docker semantic plans', () => {
  it('produces the exact Whisper roster, actions, evidence and safe commitment', () => {
    const plan = makeWhisperDockerSemanticPlan(whisperInput())

    expect(plan).toMatchObject({
      version: 1,
      sidecarKind: 'whisper',
      ledgerResources: [{ version: 1, role: 'worker', resourceKind: 'container' }],
      createOrder: ['worker'],
      useSteps: ['attest-worker', 'start-attached-worker', 'attest-stopped-worker'],
      evidenceRequirements: ['image-runtime-manifest', 'engine-create-inspect-manifest'],
      sidecarCommitment: {
        requestBindingHash: hashes.first,
        inputRootIdentityHash: hashes.second,
        inputRelativeNameHash: hashes.third,
        audioSha256: hashes.fourth,
        audioBytes: 65_536,
        language: 'ru',
        protocolVersion: 1,
        sandbox: {
          capabilities: 'none', filesystem: 'read-only-root', ipc: 'none', network: 'none',
          privilege: 'non-root', workspace: 'read-only',
        },
        limits: {
          memoryBytes: 3 * 1024 * 1024 * 1024, cpuMillicores: 2_000, pids: 64,
          wallTimeMs: 600_000, maximumInputBytes: 256 * 1024 * 1024,
          maximumOutputBytes: 2 * 1024 * 1024,
        },
      },
    })
    expect(plan.sidecarCommitment).toEqual({
      requestBindingHash: hashes.first,
      inputRootIdentityHash: hashes.second,
      inputRelativeNameHash: hashes.third,
      audioSha256: hashes.fourth,
      audioBytes: 65_536,
      language: 'ru',
      protocolVersion: 1,
      sandbox: {
        capabilities: 'none', filesystem: 'read-only-root', ipc: 'none', network: 'none',
        privilege: 'non-root', workspace: 'read-only',
      },
      limits: {
        memoryBytes: 3 * 1024 * 1024 * 1024, cpuMillicores: 2_000, pids: 64,
        wallTimeMs: 600_000, maximumInputBytes: 256 * 1024 * 1024,
        maximumOutputBytes: 2 * 1024 * 1024,
      },
    })
    expect(plan.semanticDraftHash)
      .toBe('3d7fd81a3b95ca196d60ad51f1b4cd0f3c1704146d508201e8d924d713e61302')
  })

  it('produces the exact Bash roster, actions, evidence and safe commitment', () => {
    const plan = makeLeaseBoundDockerBashSemanticPlan(bashInput())

    expect(plan).toMatchObject({
      version: 1,
      sidecarKind: 'lease-bound-docker-bash',
      ledgerResources: [{ version: 1, role: 'worker', resourceKind: 'container' }],
      createOrder: ['worker'],
      useSteps: [
        'attest-daemon-isolation', 'attest-worker', 'start-worker', 'wait-worker',
        'attest-stopped-worker', 'read-worker-output',
      ],
      evidenceRequirements: ['image-runtime-manifest', 'engine-create-inspect-manifest'],
      sidecarCommitment: {
        leaseBindingHash: hashes.first,
        operationBindingHash: hashes.second,
        workspaceIdentityHash: hashes.third,
        instructionSha256: hashes.fourth,
        instructionBytes: 4_096,
        isolationProfileSha256: '5'.repeat(64),
        sandbox: {
          capabilities: 'none', daemonIsolation: 'userns-or-rootless',
          filesystem: 'read-only-root', ipc: 'none', network: 'none',
          privilege: 'non-root', workspace: 'read-write',
        },
        limits: {
          memoryBytes: 512 * 1024 * 1024, cpuMillicores: 1_000, pids: 128,
          wallTimeMs: 120_000, maximumOutputBytes: 1024 * 1024,
        },
      },
    })
    expect(plan.sidecarCommitment).toEqual({
      leaseBindingHash: hashes.first,
      operationBindingHash: hashes.second,
      workspaceIdentityHash: hashes.third,
      instructionSha256: hashes.fourth,
      instructionBytes: 4_096,
      isolationProfileSha256: '5'.repeat(64),
      sandbox: {
        capabilities: 'none', daemonIsolation: 'userns-or-rootless',
        filesystem: 'read-only-root', ipc: 'none', network: 'none',
        privilege: 'non-root', workspace: 'read-write',
      },
      limits: {
        memoryBytes: 512 * 1024 * 1024, cpuMillicores: 1_000, pids: 128,
        wallTimeMs: 120_000, maximumOutputBytes: 1024 * 1024,
      },
    })
    expect(plan.semanticDraftHash)
      .toBe('2ebad754b3ac253eb2d452be8927e93ea39e9b4ac6d7521cf294b0381c2ffe93')
  })

  it('enforces the ADR-0072 Whisper baseline until measurement evidence exists', () => {
    const baseline = makeWhisperDockerSemanticPlan(whisperInput())
    expect(baseline.sidecarCommitment['limits']).toEqual({
      memoryBytes: 3 * 1024 * 1024 * 1024,
      cpuMillicores: 2_000,
      pids: 64,
      wallTimeMs: 600_000,
      maximumInputBytes: 256 * 1024 * 1024,
      maximumOutputBytes: 2 * 1024 * 1024,
    })

    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(),
      limits: { ...whisperInput().limits, memoryBytes: 3 * 1024 * 1024 * 1024 - 1 },
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), limits: { ...whisperInput().limits, cpuMillicores: 1_999 },
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), limits: { ...whisperInput().limits, pids: 63 },
    }))
  })

  it('takes mutation-resistant snapshots and derives stable hashes', () => {
    const input = whisperInput()
    const first = makeWhisperDockerSemanticPlan(input)
    const mutableLimits = input.limits as { memoryBytes: number }
    const mutableInput = input as unknown as { language: string | null }
    mutableLimits.memoryBytes = 256 * 1024 * 1024
    mutableInput.language = 'en'
    const second = makeWhisperDockerSemanticPlan(whisperInput())

    expect(first).toEqual(second)
    expect(first.semanticDraftHash).toBe(second.semanticDraftHash)
    expect(first.sidecarCommitment).toMatchObject({ language: 'ru' })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.sidecarCommitment)).toBe(true)
    expect(Object.isFrozen(first.sidecarCommitment['sandbox'])).toBe(true)
    expect(Object.isFrozen(first.sidecarCommitment['limits'])).toBe(true)
  })

  it('rejects invalid shapes, ranges, hashes and language fail-closed', () => {
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), extra: true,
    } as unknown as WhisperDockerSemanticPlanInputV1))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), audioBytes: 257 * 1024 * 1024,
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), audioBytes: 0,
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), language: 'RU',
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), requestBindingHash: 'not-a-hash',
    }))
    expectInvalid(() => makeWhisperDockerSemanticPlan({
      ...whisperInput(), limits: { ...whisperInput().limits, maximumOutputBytes: 1 },
    }))
    expectInvalid(() => makeLeaseBoundDockerBashSemanticPlan({
      ...bashInput(), instructionBytes: 0,
    }))
    expectInvalid(() => makeLeaseBoundDockerBashSemanticPlan({
      ...bashInput(), limits: { ...bashInput().limits, pids: 1_025 },
    }))
  })

  it('rejects hostile descriptors and proxies without invoking caller code', () => {
    let calls = 0
    const accessor = whisperInput() as unknown as Record<string, unknown>
    Object.defineProperty(accessor, 'language', {
      enumerable: true,
      get() {
        calls += 1
        return 'ru'
      },
    })
    expectInvalid(() => makeWhisperDockerSemanticPlan(
      accessor as unknown as WhisperDockerSemanticPlanInputV1,
    ))
    expect(calls).toBe(0)

    let trapCalls = 0
    const proxy = new Proxy(bashInput(), {
      getPrototypeOf() {
        trapCalls += 1
        return Object.prototype
      },
      ownKeys() {
        trapCalls += 1
        return []
      },
    })
    expectInvalid(() => makeLeaseBoundDockerBashSemanticPlan(proxy))
    expect(trapCalls).toBe(0)

    const nestedAccessor = bashInput() as unknown as Record<string, unknown>
    Object.defineProperty(nestedAccessor, 'limits', {
      enumerable: true,
      get() {
        calls += 1
        return bashInput().limits
      },
    })
    expectInvalid(() => makeLeaseBoundDockerBashSemanticPlan(
      nestedAccessor as unknown as LeaseBoundDockerBashSemanticPlanInputV1,
    ))
    expect(calls).toBe(0)

    const symbolic = whisperInput() as unknown as Record<string | symbol, unknown>
    symbolic[Symbol('hidden')] = true
    expectInvalid(() => makeWhisperDockerSemanticPlan(
      symbolic as unknown as WhisperDockerSemanticPlanInputV1,
    ))

    const nonPlain = Object.assign(Object.create(null), whisperInput())
    expectInvalid(() => makeWhisperDockerSemanticPlan(
      nonPlain as WhisperDockerSemanticPlanInputV1,
    ))

    const hidden = whisperInput() as unknown as Record<string, unknown>
    Object.defineProperty(hidden, 'extra', { value: true, enumerable: false })
    expectInvalid(() => makeWhisperDockerSemanticPlan(
      hidden as unknown as WhisperDockerSemanticPlanInputV1,
    ))
  })

  it('emits no raw authority or transport fields in either commitment', () => {
    const denied = new Set([
      'url', 'command', 'path', 'credential', 'secret', 'token', 'signal', 'callback',
      'method', 'body', 'prepareinput', 'projectionhash', 'policyhash',
    ])
    for (const plan of [
      makeWhisperDockerSemanticPlan(whisperInput()),
      makeLeaseBoundDockerBashSemanticPlan(bashInput()),
    ]) {
      expect(nestedKeys(plan.sidecarCommitment)
        .filter(key => denied.has(key.toLowerCase()))).toEqual([])
    }
  })

  it('remains dormant with no production importer', () => {
    const source = readFileSync(
      new URL('./whisper-bash-docker-semantic-plans.ts', import.meta.url), 'utf8',
    )
    expect(source).not.toMatch(
      /node:(?:child_process|fs|http|https|net|tls)|\.\/whisper-docker-sidecar|\.\/lease-bound-docker-bash|\.\/execution-owned-docker/,
    )

    const importers = sourceFiles(new URL('.', import.meta.url))
      .filter(location => !location.pathname.endsWith('.spec.ts') &&
        !location.pathname.endsWith('/whisper-bash-docker-semantic-plans.ts'))
      .filter(location => readFileSync(location, 'utf8')
        .includes('whisper-bash-docker-semantic-plans'))
    expect(importers).toEqual([])
  })
})

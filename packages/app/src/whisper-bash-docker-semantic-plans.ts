import { types as utilTypes } from 'node:util'

import {
  DockerSidecarSemanticDraftError,
  makeDockerSidecarSemanticDraft,
  type DockerSidecarSafeCommitmentValueV1,
  type LeaseBoundDockerBashSemanticDraftInputV1,
  type WhisperDockerSemanticDraftInputV1,
} from './docker-sidecar-code-owned-plans.js'

const HASH = /^[a-f0-9]{64}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/

const WHISPER_MAXIMUM_INPUT_BYTES = 256 * 1024 * 1024
const WHISPER_MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024
const WHISPER_MINIMUM_MEMORY_BYTES = 3 * 1024 * 1024 * 1024
const WHISPER_MINIMUM_CPU_MILLICORES = 2_000
const WHISPER_MINIMUM_PIDS = 64
const WHISPER_MAXIMUM_MEMORY_BYTES = 16 * 1024 * 1024 * 1024

const BASH_MAXIMUM_INSTRUCTION_BYTES = 128 * 1024
const BASH_MINIMUM_MEMORY_BYTES = 64 * 1024 * 1024
const BASH_MAXIMUM_MEMORY_BYTES = 8 * 1024 * 1024 * 1024
const BASH_MAXIMUM_OUTPUT_BYTES = 8 * 1024 * 1024
const BASH_MAXIMUM_WALL_TIME_MS = 30 * 60 * 1000

export interface WhisperDockerSemanticPlanLimitsV1 {
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly wallTimeMs: number
  readonly maximumInputBytes: number
  readonly maximumOutputBytes: number
}

export interface WhisperDockerSemanticPlanInputV1 {
  readonly requestBindingHash: string
  readonly inputRootIdentityHash: string
  readonly inputRelativeNameHash: string
  readonly audioSha256: string
  readonly audioBytes: number
  readonly language: string | null
  readonly protocolVersion: 1
  readonly limits: WhisperDockerSemanticPlanLimitsV1
}

export interface LeaseBoundDockerBashSemanticPlanLimitsV1 {
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly wallTimeMs: number
  readonly maximumOutputBytes: number
}

export interface LeaseBoundDockerBashSemanticPlanInputV1 {
  readonly leaseBindingHash: string
  readonly operationBindingHash: string
  readonly workspaceIdentityHash: string
  readonly instructionSha256: string
  readonly instructionBytes: number
  readonly isolationProfileSha256: string
  readonly limits: LeaseBoundDockerBashSemanticPlanLimitsV1
}

function invalid(): never {
  throw new DockerSidecarSemanticDraftError('DOCKER_SIDECAR_SEMANTIC_DRAFT_INVALID')
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (utilTypes.isProxy(value) || value === null || typeof value !== 'object' ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const actual = Object.keys(descriptors).sort()
    const expected = [...keys].sort()
    if (actual.length !== expected.length || actual.some((key, index) =>
      key !== expected[index])) invalid()
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        invalid()
      }
      Object.defineProperty(result, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      })
    }
    return Object.freeze(result)
  } catch {
    invalid()
  }
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  return value
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  const result = integer(value)
  if (result < minimum || result > maximum) invalid()
  return result
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}

function whisperDraft(
  sidecarCommitment: Readonly<Record<string, DockerSidecarSafeCommitmentValueV1>>,
) {
  return makeDockerSidecarSemanticDraft({
    version: 1,
    sidecarKind: 'whisper',
    ledgerResources: [{ version: 1, role: 'worker', resourceKind: 'container' }],
    createOrder: ['worker'],
    useSteps: ['attest-worker', 'start-attached-worker', 'attest-stopped-worker'],
    evidenceRequirements: ['image-runtime-manifest', 'engine-create-inspect-manifest'],
    sidecarCommitment,
  } satisfies WhisperDockerSemanticDraftInputV1)
}

function bashDraft(
  sidecarCommitment: Readonly<Record<string, DockerSidecarSafeCommitmentValueV1>>,
) {
  return makeDockerSidecarSemanticDraft({
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
  } satisfies LeaseBoundDockerBashSemanticDraftInputV1)
}

export function makeWhisperDockerSemanticPlan(
  input: WhisperDockerSemanticPlanInputV1,
) {
  const record = snapshotExactRecord(input, [
    'requestBindingHash', 'inputRootIdentityHash', 'inputRelativeNameHash', 'audioSha256',
    'audioBytes', 'language', 'protocolVersion', 'limits',
  ])
  const limits = snapshotExactRecord(record['limits'], [
    'memoryBytes', 'cpuMillicores', 'pids', 'wallTimeMs',
    'maximumInputBytes', 'maximumOutputBytes',
  ])
  const audioBytes = boundedInteger(record['audioBytes'], 1, WHISPER_MAXIMUM_INPUT_BYTES)
  const maximumInputBytes = boundedInteger(
    limits['maximumInputBytes'], 1, WHISPER_MAXIMUM_INPUT_BYTES,
  )
  if (audioBytes > maximumInputBytes || record['protocolVersion'] !== 1 ||
    (record['language'] !== null &&
      (typeof record['language'] !== 'string' || !LANGUAGE.test(record['language'])))) invalid()

  return whisperDraft({
    requestBindingHash: hash(record['requestBindingHash']),
    inputRootIdentityHash: hash(record['inputRootIdentityHash']),
    inputRelativeNameHash: hash(record['inputRelativeNameHash']),
    audioSha256: hash(record['audioSha256']),
    audioBytes,
    language: record['language'],
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
      memoryBytes: boundedInteger(
        limits['memoryBytes'], WHISPER_MINIMUM_MEMORY_BYTES, WHISPER_MAXIMUM_MEMORY_BYTES,
      ),
      cpuMillicores: boundedInteger(
        limits['cpuMillicores'], WHISPER_MINIMUM_CPU_MILLICORES, 8_000,
      ),
      pids: boundedInteger(limits['pids'], WHISPER_MINIMUM_PIDS, 256),
      wallTimeMs: boundedInteger(limits['wallTimeMs'], 1_000, 600_000),
      maximumInputBytes,
      maximumOutputBytes: boundedInteger(
        limits['maximumOutputBytes'],
        WHISPER_MAXIMUM_OUTPUT_BYTES,
        WHISPER_MAXIMUM_OUTPUT_BYTES,
      ),
    },
  })
}

export function makeLeaseBoundDockerBashSemanticPlan(
  input: LeaseBoundDockerBashSemanticPlanInputV1,
) {
  const record = snapshotExactRecord(input, [
    'leaseBindingHash', 'operationBindingHash', 'workspaceIdentityHash', 'instructionSha256',
    'instructionBytes', 'isolationProfileSha256', 'limits',
  ])
  const limits = snapshotExactRecord(record['limits'], [
    'memoryBytes', 'cpuMillicores', 'pids', 'wallTimeMs', 'maximumOutputBytes',
  ])

  return bashDraft({
    leaseBindingHash: hash(record['leaseBindingHash']),
    operationBindingHash: hash(record['operationBindingHash']),
    workspaceIdentityHash: hash(record['workspaceIdentityHash']),
    instructionSha256: hash(record['instructionSha256']),
    instructionBytes: boundedInteger(record['instructionBytes'], 1, BASH_MAXIMUM_INSTRUCTION_BYTES),
    isolationProfileSha256: hash(record['isolationProfileSha256']),
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
      memoryBytes: boundedInteger(
        limits['memoryBytes'], BASH_MINIMUM_MEMORY_BYTES, BASH_MAXIMUM_MEMORY_BYTES,
      ),
      cpuMillicores: boundedInteger(limits['cpuMillicores'], 50, 8_000),
      pids: boundedInteger(limits['pids'], 8, 1_024),
      wallTimeMs: boundedInteger(limits['wallTimeMs'], 1_000, BASH_MAXIMUM_WALL_TIME_MS),
      maximumOutputBytes: boundedInteger(
        limits['maximumOutputBytes'], 1_024, BASH_MAXIMUM_OUTPUT_BYTES,
      ),
    },
  })
}

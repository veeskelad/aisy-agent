import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'

import {
  TranscriptionError,
  type TranscriptionAudioRequest,
  type TranscriptionErrorCode,
  type TranscriptionTranscript,
  type Transcriber,
} from './transcription-contract.js'

const PROTOCOL_VERSION = 1
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 16 * 1024
const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const MAX_INSPECT_BYTES = 128 * 1024
const CONTAINER_USER = '65532:65532'
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:=-]{0,511}@sha256:[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LANGUAGE = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/

export type WhisperSidecarErrorCode = TranscriptionErrorCode

const WORKER_CODES = new Set<WhisperSidecarErrorCode>([
  'INVALID_REQUEST', 'INVALID_PATH', 'SYMLINK_DENIED', 'SPECIAL_FILE_DENIED',
  'HARDLINK_DENIED', 'CROSS_DEVICE_DENIED', 'LIMIT_EXCEEDED', 'NOT_FOUND',
  'NOT_DIRECTORY', 'NOT_REGULAR', 'HASH_MISMATCH', 'IO_FAILED',
  'UNSUPPORTED_PLATFORM', 'MODEL_UNAVAILABLE', 'TRANSCRIPTION_FAILED',
  'INTERNAL_ERROR',
])

export class WhisperSidecarError extends TranscriptionError {
  constructor(code: WhisperSidecarErrorCode) {
    super(code)
    this.name = 'WhisperSidecarError'
  }
}

export interface WhisperDockerCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly overflow?: boolean
}

export interface WhisperDockerCommandPort {
  run(args: readonly string[], options: Readonly<{
    timeoutMs: number
    maxOutputBytes: number
    stdin?: string
    signal?: AbortSignal
  }>): Promise<WhisperDockerCommandResult>
}

/** @deprecated Use TranscriptionAudioRequest. */
export type WhisperAudioRequest = TranscriptionAudioRequest
/** @deprecated Use TranscriptionTranscript. */
export type WhisperTranscript = TranscriptionTranscript
/** @deprecated Use Transcriber. */
export type WhisperTranscriber = Transcriber

export interface WhisperDockerLimits {
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly wallTimeMs: number
}

export interface WhisperDockerArgv {
  readonly version: string[]
  readonly create: string[]
  readonly inspect: string[]
  readonly start: string[]
  readonly cleanup: string[]
  readonly containerName: string
}

interface ValidatedRequest {
  readonly hostRoot: string
  readonly relativePath: string
  readonly expectedSha256: string
  readonly expectedSizeBytes: number
  readonly maxBytes: number
  readonly language?: string
  readonly signal?: AbortSignal
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key))
}

function natural(value: unknown, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? value as number
    : null
}

function validateLimits(value: WhisperDockerLimits): WhisperDockerLimits {
  if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes < 256 * 1024 * 1024 ||
    value.memoryBytes > 16 * 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(value.cpuMillicores) || value.cpuMillicores < 100 || value.cpuMillicores > 8_000 ||
    !Number.isSafeInteger(value.pids) || value.pids < 8 || value.pids > 256 ||
    !Number.isSafeInteger(value.wallTimeMs) || value.wallTimeMs < 1_000 || value.wallTimeMs > 600_000) {
    throw new WhisperSidecarError('INVALID_REQUEST')
  }
  return Object.freeze({ ...value })
}

function validateRoot(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value.includes('\0') || value.includes(',')) {
    throw new WhisperSidecarError('INVALID_PATH')
  }
  try {
    const canonical = resolve(value)
    if (!existsSync(canonical)) throw new WhisperSidecarError('NOT_FOUND')
    const info = lstatSync(canonical)
    if (info.isSymbolicLink()) throw new WhisperSidecarError('SYMLINK_DENIED')
    if (!info.isDirectory() || realpathSync(canonical) !== canonical) {
      throw new WhisperSidecarError('NOT_DIRECTORY')
    }
    return canonical
  } catch (error) {
    if (error instanceof WhisperSidecarError) throw error
    throw new WhisperSidecarError('IO_FAILED')
  }
}

function validateRelativePath(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096 ||
    value.includes('\0') || value.startsWith('/') || value.includes('\\')) {
    throw new WhisperSidecarError('INVALID_PATH')
  }
  const parts = value.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..' ||
    [...part].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new WhisperSidecarError('INVALID_PATH')
  }
  return value
}

function validateRequest(value: WhisperAudioRequest): ValidatedRequest {
  const input = record(value)
  if (input === null || Object.keys(input).some(key => ![
    'audioRoot', 'relativePath', 'expectedSha256', 'expectedSizeBytes',
    'maxBytes', 'language', 'signal',
  ].includes(key)) || typeof input['audioRoot'] !== 'string' ||
    typeof input['relativePath'] !== 'string' || typeof input['expectedSha256'] !== 'string' ||
    !HASH.test(input['expectedSha256']) || typeof input['expectedSizeBytes'] !== 'number' ||
    typeof input['maxBytes'] !== 'number' || (input['language'] !== undefined &&
      (typeof input['language'] !== 'string' || !LANGUAGE.test(input['language'].toLowerCase()))) ||
    (input['signal'] !== undefined && !(input['signal'] instanceof AbortSignal))) {
    throw new WhisperSidecarError('INVALID_REQUEST')
  }
  const expectedSizeBytes = natural(input['expectedSizeBytes'], 256 * 1024 * 1024)
  const maxBytes = natural(input['maxBytes'], 256 * 1024 * 1024)
  if (expectedSizeBytes === null || maxBytes === null || expectedSizeBytes > maxBytes || maxBytes < 1) {
    throw new WhisperSidecarError('LIMIT_EXCEEDED')
  }
  return Object.freeze<ValidatedRequest>({
    hostRoot: validateRoot(input['audioRoot']),
    relativePath: validateRelativePath(input['relativePath']),
    expectedSha256: input['expectedSha256'],
    expectedSizeBytes,
    maxBytes,
    ...(typeof input['language'] === 'string' ? { language: input['language'].toLowerCase() } : {}),
    ...(input['signal'] instanceof AbortSignal ? { signal: input['signal'] } : {}),
  })
}

function policyHash(imageDigest: string, limits: WhisperDockerLimits, request: ValidatedRequest): string {
  return createHash('sha256').update(JSON.stringify({
    imageDigest,
    limits,
    audio: {
      root: request.hostRoot,
      path: request.relativePath,
      sha256: request.expectedSha256,
      sizeBytes: request.expectedSizeBytes,
      maxBytes: request.maxBytes,
    },
  })).digest('hex')
}

export function whisperDockerArgv(input: {
  imageDigest: string
  requestId: string
  request: ValidatedRequest
  limits: WhisperDockerLimits
}): WhisperDockerArgv {
  if (!IMAGE.test(input.imageDigest) || !ID.test(input.requestId)) {
    throw new WhisperSidecarError('INVALID_REQUEST')
  }
  const limits = validateLimits(input.limits)
  const hash = policyHash(input.imageDigest, limits, input.request)
  const suffix = createHash('sha256').update(`${input.requestId}\0${hash}`).digest('hex').slice(0, 20)
  const containerName = `aisy-whisper-${suffix}`
  const create = [
    'container', 'create', '--interactive', '--pull=never', `--name=${containerName}`,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
    '--ipc=none', `--pids-limit=${limits.pids}`, `--memory=${limits.memoryBytes}`,
    `--memory-swap=${limits.memoryBytes}`, `--cpus=${(limits.cpuMillicores / 1000).toFixed(3)}`,
    `--user=${CONTAINER_USER}`, '--ulimit=nofile=256:256', '--stop-timeout=1',
    `--label=com.aisy.whisper.request=${input.requestId}`,
    `--label=com.aisy.whisper.policy=${hash}`,
    '--env=LANG=C.UTF-8', '--env=LC_ALL=C.UTF-8', '--env=PYTHONNOUSERSITE=1',
    '--env=PYTHONDONTWRITEBYTECODE=1', '--env=PYTHONSAFEPATH=1',
    `--mount=type=bind,source=${input.request.hostRoot},target=/input,readonly,bind-propagation=rprivate`,
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=0700',
    input.imageDigest,
  ]
  return Object.freeze({
    version: ['version', '--format={{.Server.Version}}'],
    create,
    inspect: ['container', 'inspect', containerName],
    start: ['container', 'start', '--attach', '--interactive', containerName],
    cleanup: ['container', 'rm', '--force', '--volumes', containerName],
    containerName,
  })
}

function parseDockerVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(value)
  return match !== null && Number(match[1]) >= 24
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as string[]
    : null
}

function inspectObject(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_INSPECT_BYTES) {
    throw new WhisperSidecarError('SANDBOX_DENIED')
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const item = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed
    const object = record(item)
    if (object === null) throw new Error('invalid')
    return object
  } catch {
    throw new WhisperSidecarError('SANDBOX_DENIED')
  }
}

function inspectRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record(parent[key])
  if (value === null) throw new WhisperSidecarError('SANDBOX_DENIED')
  return value
}

function validateInspect(input: {
  raw: string
  imageDigest: string
  requestId: string
  policyHash: string
  request: ValidatedRequest
  limits: WhisperDockerLimits
}): void {
  const root = inspectObject(input.raw)
  const config = inspectRecord(root, 'Config')
  const host = inspectRecord(root, 'HostConfig')
  const labels = record(config['Labels'])
  const environment = stringArray(config['Env'])
  const capDrop = stringArray(host['CapDrop'])
  const security = stringArray(host['SecurityOpt'])
  const mounts = Array.isArray(root['Mounts']) ? root['Mounts'] : null
  const mount = mounts?.length === 1 ? record(mounts[0]) : null
  const tmpfs = record(host['Tmpfs'])
  const tmpOptions = typeof tmpfs?.['/tmp'] === 'string'
    ? new Set((tmpfs['/tmp'] as string).split(','))
    : null
  const requiredEnv = new Set([
    'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PYTHONNOUSERSITE=1',
    'PYTHONDONTWRITEBYTECODE=1', 'PYTHONSAFEPATH=1',
  ])
  const envSafe = environment !== null && [...requiredEnv].every(value => environment.includes(value)) &&
    environment.every(value => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK|AWS_|GITHUB_|GITLAB_)/i.test(value.split('=', 1)[0] ?? ''))
  const valid = config['Image'] === input.imageDigest && config['User'] === CONTAINER_USER &&
    config['OpenStdin'] === true && envSafe && labels !== null &&
    labels['com.aisy.whisper.request'] === input.requestId &&
    labels['com.aisy.whisper.policy'] === input.policyHash &&
    host['NetworkMode'] === 'none' && host['ReadonlyRootfs'] === true &&
    host['Privileged'] === false && capDrop?.length === 1 && capDrop[0] === 'ALL' &&
    security?.includes('no-new-privileges=true') === true &&
    security.includes('seccomp=builtin') && host['IpcMode'] === 'none' &&
    host['Memory'] === input.limits.memoryBytes && host['MemorySwap'] === input.limits.memoryBytes &&
    host['NanoCpus'] === input.limits.cpuMillicores * 1_000_000 &&
    host['PidsLimit'] === input.limits.pids && host['Binds'] === null &&
    tmpOptions !== null && ['rw', 'nosuid', 'nodev', 'noexec', 'size=67108864', 'mode=0700']
      .every(option => tmpOptions.has(option)) && mount !== null &&
    mount['Type'] === 'bind' && mount['Source'] === input.request.hostRoot &&
    mount['Destination'] === '/input' && mount['RW'] === false &&
    mount['Propagation'] === 'rprivate'
  if (!valid) throw new WhisperSidecarError('SANDBOX_DENIED')
}

function containerState(raw: string): { exitCode: number; oomKilled: boolean } {
  const state = inspectRecord(inspectObject(raw), 'State')
  if (state['Running'] !== false || !Number.isSafeInteger(state['ExitCode']) ||
    typeof state['OOMKilled'] !== 'boolean') {
    throw new WhisperSidecarError('SANDBOX_DENIED')
  }
  return { exitCode: state['ExitCode'] as number, oomKilled: state['OOMKilled'] }
}

function parseResponse(raw: string, requestId: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new WhisperSidecarError('PROTOCOL_ERROR')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new WhisperSidecarError('PROTOCOL_ERROR') }
  const envelope = record(parsed)
  if (envelope === null || envelope['version'] !== PROTOCOL_VERSION ||
    envelope['requestId'] !== requestId || typeof envelope['ok'] !== 'boolean') {
    throw new WhisperSidecarError('PROTOCOL_ERROR')
  }
  if (envelope['ok'] === false) {
    if (!exactKeys(envelope, ['version', 'requestId', 'ok', 'error'])) {
      throw new WhisperSidecarError('PROTOCOL_ERROR')
    }
    const error = record(envelope['error'])
    if (error === null || !exactKeys(error, ['code']) || typeof error['code'] !== 'string' ||
      !WORKER_CODES.has(error['code'] as WhisperSidecarErrorCode)) {
      throw new WhisperSidecarError('PROTOCOL_ERROR')
    }
    throw new WhisperSidecarError(error['code'] as WhisperSidecarErrorCode)
  }
  if (!exactKeys(envelope, ['version', 'requestId', 'ok', 'data'])) {
    throw new WhisperSidecarError('PROTOCOL_ERROR')
  }
  const data = record(envelope['data'])
  if (data === null) throw new WhisperSidecarError('PROTOCOL_ERROR')
  return data
}

function parseTranscript(data: Record<string, unknown>): WhisperTranscript {
  if (Object.keys(data).some(key => !['text', 'language', 'durationMs'].includes(key)) ||
    typeof data['text'] !== 'string' || data['text'].length === 0 || data['text'].includes('\0') ||
    Buffer.byteLength(data['text'], 'utf8') > MAX_TRANSCRIPT_BYTES ||
    (data['language'] !== undefined && (typeof data['language'] !== 'string' ||
      !LANGUAGE.test(data['language']))) ||
    (data['durationMs'] !== undefined && natural(data['durationMs'], 86_400_000) === null)) {
    throw new WhisperSidecarError('PROTOCOL_ERROR')
  }
  return Object.freeze({
    text: data['text'],
    provenance: 'untrusted' as const,
    channel: 'voice' as const,
    ...(typeof data['language'] === 'string' ? { language: data['language'] } : {}),
    ...(typeof data['durationMs'] === 'number' ? { durationMs: data['durationMs'] } : {}),
  })
}

export function makeDockerWhisperTranscriber(input: {
  docker: WhisperDockerCommandPort
  imageDigest: string
  limits: WhisperDockerLimits
  newRequestId(): string
}): WhisperTranscriber {
  if (!IMAGE.test(input.imageDigest)) throw new WhisperSidecarError('INVALID_REQUEST')
  const limits = validateLimits(input.limits)
  let active = false

  return Object.freeze({
    async transcribe(rawRequest: WhisperAudioRequest): Promise<WhisperTranscript> {
      if (active) throw new WhisperSidecarError('QUOTA_EXCEEDED')
      active = true
      try {
      const request = validateRequest(rawRequest)
      let requestId: string
      try { requestId = input.newRequestId() } catch {
        throw new WhisperSidecarError('INVALID_REQUEST')
      }
      if (!ID.test(requestId)) throw new WhisperSidecarError('INVALID_REQUEST')
      if (request.signal?.aborted === true) throw new WhisperSidecarError('ABORTED')
      const argv = whisperDockerArgv({ imageDigest: input.imageDigest, requestId, request, limits })
      const hash = policyHash(input.imageDigest, limits, request)
      const workerRequest = JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId,
        op: 'transcribe',
        root: '/input',
        path: request.relativePath,
        expectedSha256: request.expectedSha256,
        expectedSizeBytes: request.expectedSizeBytes,
        maxBytes: request.maxBytes,
        ...(request.language === undefined ? {} : { language: request.language }),
      })
      if (Buffer.byteLength(workerRequest, 'utf8') > MAX_REQUEST_BYTES) {
        throw new WhisperSidecarError('LIMIT_EXCEEDED')
      }

      const run = async (
        args: readonly string[],
        options: Parameters<WhisperDockerCommandPort['run']>[1],
      ): Promise<WhisperDockerCommandResult> => {
        try { return await input.docker.run(args, options) } catch {
          return { exitCode: -1, stdout: '', stderr: '' }
        }
      }
      const cleanupOwned = async (): Promise<void> => {
        const cleanup = await run(argv.cleanup, {
          timeoutMs: 15_000, maxOutputBytes: MAX_DIAGNOSTIC_BYTES,
        })
        if (cleanup.exitCode !== 0 || cleanup.timedOut === true || cleanup.overflow === true) {
          throw new WhisperSidecarError('CLEANUP_FAILED')
        }
      }

      const version = await run(argv.version, {
        timeoutMs: 10_000, maxOutputBytes: 4096, ...(request.signal ? { signal: request.signal } : {}),
      })
      if (version.aborted === true) throw new WhisperSidecarError('ABORTED')
      if (version.exitCode !== 0 || !parseDockerVersion(version.stdout)) {
        throw new WhisperSidecarError('DOCKER_INCOMPATIBLE')
      }
      const created = await run(argv.create, {
        timeoutMs: 30_000, maxOutputBytes: MAX_DIAGNOSTIC_BYTES,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      if (created.exitCode !== 0 || created.timedOut === true || created.overflow === true) {
        if (created.aborted === true || created.timedOut === true || created.overflow === true ||
          created.exitCode === -1) {
          const recoveryInspect = await run(argv.inspect, {
            timeoutMs: 10_000, maxOutputBytes: MAX_INSPECT_BYTES,
          })
          if (recoveryInspect.exitCode === 0 && recoveryInspect.timedOut !== true &&
            recoveryInspect.overflow !== true) {
            try {
              validateInspect({ raw: recoveryInspect.stdout, imageDigest: input.imageDigest, requestId, policyHash: hash, request, limits })
            } catch {
              throw new WhisperSidecarError('CLEANUP_FAILED')
            }
            await cleanupOwned()
          } else if (recoveryInspect.exitCode === -1 || recoveryInspect.timedOut === true ||
            recoveryInspect.overflow === true) {
            throw new WhisperSidecarError('CLEANUP_FAILED')
          }
        }
        if (created.aborted === true) throw new WhisperSidecarError('ABORTED')
        throw new WhisperSidecarError('PROCESS_FAILED')
      }

      let outcome: WhisperTranscript | WhisperSidecarError
      try {
        const inspected = await run(argv.inspect, {
          timeoutMs: 10_000, maxOutputBytes: MAX_INSPECT_BYTES,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        if (inspected.aborted === true) throw new WhisperSidecarError('ABORTED')
        if (inspected.exitCode !== 0 || inspected.timedOut === true || inspected.overflow === true) {
          throw new WhisperSidecarError('SANDBOX_DENIED')
        }
        validateInspect({ raw: inspected.stdout, imageDigest: input.imageDigest, requestId, policyHash: hash, request, limits })
        const started = await run(argv.start, {
          timeoutMs: limits.wallTimeMs,
          maxOutputBytes: MAX_RESPONSE_BYTES,
          stdin: workerRequest,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        if (started.aborted === true) throw new WhisperSidecarError('ABORTED')
        if (started.timedOut === true) throw new WhisperSidecarError('TIMEOUT')
        if (started.overflow === true) throw new WhisperSidecarError('PROTOCOL_ERROR')
        const stoppedInspect = await run(argv.inspect, {
          timeoutMs: 10_000, maxOutputBytes: MAX_INSPECT_BYTES,
        })
        if (stoppedInspect.exitCode !== 0) throw new WhisperSidecarError('SANDBOX_DENIED')
        validateInspect({ raw: stoppedInspect.stdout, imageDigest: input.imageDigest, requestId, policyHash: hash, request, limits })
        const state = containerState(stoppedInspect.stdout)
        if (state.oomKilled) throw new WhisperSidecarError('QUOTA_EXCEEDED')
        if (state.exitCode !== started.exitCode || ![0, 2].includes(started.exitCode)) {
          throw new WhisperSidecarError('PROCESS_FAILED')
        }
        outcome = parseTranscript(parseResponse(started.stdout, requestId))
      } catch (error) {
        outcome = error instanceof WhisperSidecarError
          ? error
          : new WhisperSidecarError('PROCESS_FAILED')
      }

      await cleanupOwned()
      if (outcome instanceof WhisperSidecarError) throw outcome
      return outcome
      } finally {
        active = false
      }
    },
  })
}

export function makeNodeWhisperDockerCommandPort(input: {
  dockerExecutable: string
}): WhisperDockerCommandPort {
  if (!isAbsolute(input.dockerExecutable) || normalize(input.dockerExecutable) !== input.dockerExecutable) {
    throw new WhisperSidecarError('INVALID_REQUEST')
  }
  return Object.freeze<WhisperDockerCommandPort>({
    run(args, options): Promise<WhisperDockerCommandResult> {
      return new Promise(resolveResult => {
        let child: ChildProcessWithoutNullStreams
        try {
          child = spawn(input.dockerExecutable, [...args], {
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          })
        } catch {
          resolveResult({ exitCode: -1, stdout: '', stderr: '' })
          return
        }
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let settled = false
        let timedOut = false
        let aborted = false
        let overflow = false
        const finish = (exitCode: number): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolveResult({
            exitCode,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: '',
            ...(timedOut ? { timedOut: true } : {}),
            ...(aborted ? { aborted: true } : {}),
            ...(overflow ? { overflow: true } : {}),
          })
        }
        const terminate = (): void => { child.kill('SIGKILL') }
        const timer = setTimeout(() => { timedOut = true; terminate() }, options.timeoutMs)
        timer.unref()
        const onAbort = (): void => { aborted = true; terminate() }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          stdoutBytes += buffer.byteLength
          if (stdoutBytes > options.maxOutputBytes) { overflow = true; terminate(); return }
          stdout.push(buffer)
        })
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderrBytes += Buffer.byteLength(chunk)
          if (stderrBytes > MAX_DIAGNOSTIC_BYTES) { overflow = true; terminate() }
        })
        child.on('error', () => finish(-1))
        child.on('close', code => finish(code ?? -1))
        child.stdin.on('error', () => terminate())
        child.stdin.end(options.stdin ?? '')
        if (options.signal?.aborted === true) onAbort()
      })
    },
  })
}

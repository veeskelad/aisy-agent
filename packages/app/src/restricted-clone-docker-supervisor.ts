import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import {
  isRestrictedCloneDockerVersionCompatible,
  isRestrictedCloneImageDigest,
} from '@aisy/core'
import {
  RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION,
  type RestrictedCloneSidecarAttestation,
  type RestrictedCloneSidecarRequest,
  type RestrictedCloneSidecarSupervisor,
} from './restricted-clone-sidecar.js'

export interface DockerCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  readonly aborted?: boolean
  readonly overflow?: boolean
}

export interface DockerCommandPort {
  run(args: readonly string[], options: Readonly<{
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
  }>): Promise<DockerCommandResult>
}

export type RestrictedCloneDockerSupervisorErrorCode =
  | 'CLONE_DOCKER_POLICY_INVALID'
  | 'CLONE_DOCKER_RUNTIME_INCOMPATIBLE'
  | 'CLONE_DOCKER_COMMAND_FAILED'
  | 'CLONE_DOCKER_INSPECT_DENIED'
  | 'CLONE_DOCKER_STAGING_DENIED'
  | 'CLONE_DOCKER_CLEANUP_FAILED'

export class RestrictedCloneDockerSupervisorError extends Error {
  constructor(public readonly code: RestrictedCloneDockerSupervisorErrorCode) {
    super(code)
    this.name = 'RestrictedCloneDockerSupervisorError'
  }
}

export interface RestrictedCloneDockerNames {
  readonly network: string
  readonly gateway: string
  readonly worker: string
}

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_DOCKER_OUTPUT_BYTES = 64 * 1024
const CLEANUP_TIMEOUT_MS = 15_000
const READY_POLL_MS = 50
const GATEWAY_MEMORY_BYTES = 96 * 1024 * 1024
const GATEWAY_PIDS = 32
const CONTAINER_USER = '65532:65532'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validImage(value: string): boolean {
  return isRestrictedCloneImageDigest(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as string[]
    : null
}

function keyed(value: unknown): Record<string, unknown> {
  const parsed = record(value)
  if (parsed === null) throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  return parsed
}

function requireCanonicalRequest(request: RestrictedCloneSidecarRequest): void {
  const policy = {
    imageDigest: request.imageDigest,
    staging: request.staging,
    target: request.target,
    sandbox: request.sandbox,
    git: request.git,
  }
  const endpoints = request.sandbox.network.allowedEndpoints
  if (request.protocolVersion !== RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION ||
    !EXECUTION_ID.test(request.executionId) || !SHA256.test(request.policyHash) ||
    !validImage(request.imageDigest) || digest(JSON.stringify(policy)) !== request.policyHash ||
    request.staging.mode !== 'supervisor-export-only' ||
    request.sandbox.lifecycle !== 'one-shot-destroy-before-return' ||
    request.sandbox.rootFilesystem !== 'read-only' || request.sandbox.user !== 'non-root' ||
    request.sandbox.capabilities.length !== 0 || request.sandbox.noNewPrivileges !== true ||
    request.sandbox.privileged !== false || request.sandbox.hostNetwork !== false ||
    request.sandbox.dockerSocket !== false || request.sandbox.directExternalRoute !== false ||
    request.sandbox.environment !== 'allowlisted-non-secret' ||
    request.sandbox.inheritedCredentials !== false ||
    request.sandbox.workspace.mode !== 'quota-tmpfs-export' ||
    request.sandbox.workspace.target !== '/workspace' ||
    request.sandbox.workspace.exportSource !== '/workspace/repo/.' ||
    request.sandbox.workspace.sizeBytes !== request.sandbox.limits.diskBytes ||
    request.sandbox.network.mode !== 'isolated-egress-gateway-only' ||
    request.sandbox.network.tlsServerName !== request.target.hostname ||
    endpoints.length !== request.target.addresses.length ||
    endpoints.some((entry, index) => entry.address !== request.target.addresses[index]?.address ||
      entry.port !== 443) ||
    request.git.allowedProtocols.length !== 1 || request.git.allowedProtocols[0] !== 'https' ||
    request.git.followRedirects !== false || request.git.hooksPath !== '/dev/null' ||
    request.git.credentialHelper !== 'disabled' || request.git.terminalPrompt !== false ||
    request.git.recurseSubmodules !== false || request.git.lfsSmudge !== false) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_POLICY_INVALID')
  }
}

export function restrictedCloneDockerNames(request: Pick<
  RestrictedCloneSidecarRequest,
  'executionId' | 'policyHash'
>): RestrictedCloneDockerNames {
  const suffix = digest(`${request.executionId}\0${request.policyHash}`).slice(0, 20)
  return Object.freeze({
    network: `aisy-clone-net-${suffix}`,
    gateway: `aisy-clone-egress-${suffix}`,
    worker: `aisy-clone-worker-${suffix}`,
  })
}

function commonContainerArgs(input: {
  name: string
  network: string
  image: string
  memoryBytes: number
  cpuMillicores: number
  pids: number
  labels: readonly string[]
  environment: readonly string[]
  tmpfs: readonly string[]
  runtime?: string
}): string[] {
  return [
    'container', 'create',
    '--pull=never',
    `--name=${input.name}`,
    `--network=${input.network}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges=true',
    '--security-opt=seccomp=builtin',
    '--ipc=none',
    '--pids-limit=' + input.pids,
    '--memory=' + input.memoryBytes,
    '--memory-swap=' + input.memoryBytes,
    '--cpus=' + (input.cpuMillicores / 1000).toFixed(3),
    '--user=' + CONTAINER_USER,
    '--ulimit=nofile=1024:1024',
    '--stop-timeout=1',
    ...input.labels.map(label => `--label=${label}`),
    ...input.environment.map(value => `--env=${value}`),
    ...input.tmpfs.map(value => `--tmpfs=${value}`),
    ...(input.runtime === undefined ? [] : [`--runtime=${input.runtime}`]),
    input.image,
  ]
}

export function restrictedCloneDockerArgv(input: {
  request: RestrictedCloneSidecarRequest
  gatewayImageDigest: string
  runtime?: string
}): Readonly<{
  networkCreate: string[]
  gatewayCreate: string[]
  gatewayConnect: string[]
  workerCreate: string[]
}> {
  requireCanonicalRequest(input.request)
  if (!validImage(input.gatewayImageDigest) ||
    (input.runtime !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.runtime))) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_POLICY_INVALID')
  }
  const names = restrictedCloneDockerNames(input.request)
  const labels = [
    `com.aisy.clone.execution=${input.request.executionId}`,
    `com.aisy.clone.policy=${input.request.policyHash}`,
  ]
  const gatewayMaxBytes = Math.min(
    input.request.sandbox.limits.diskBytes * 4,
    42_949_672_960,
  )
  return Object.freeze({
    networkCreate: [
      'network', 'create', '--driver=ipvlan', '--internal',
      ...labels.map(label => `--label=${label}`), names.network,
    ],
    gatewayCreate: commonContainerArgs({
      name: names.gateway,
      network: 'name=bridge,gw-priority=1',
      image: input.gatewayImageDigest,
      memoryBytes: GATEWAY_MEMORY_BYTES,
      cpuMillicores: 250,
      pids: GATEWAY_PIDS,
      labels,
      environment: [
        `AISY_EGRESS_HOST=${input.request.target.hostname}`,
        `AISY_EGRESS_IPS_JSON=${JSON.stringify(input.request.target.addresses.map(item => item.address))}`,
        `AISY_EGRESS_MAX_BYTES=${gatewayMaxBytes}`,
      ],
      tmpfs: [
        '/tmp:rw,nosuid,nodev,noexec,size=8388608,mode=0700',
      ],
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    }),
    gatewayConnect: [
      'network', 'connect', '--alias=egress', names.network, names.gateway,
    ],
    workerCreate: commonContainerArgs({
      name: names.worker,
      network: names.network,
      image: input.request.imageDigest,
      memoryBytes: input.request.sandbox.limits.memoryBytes,
      cpuMillicores: input.request.sandbox.limits.cpuMillicores,
      pids: input.request.sandbox.limits.pids,
      labels,
      environment: [
        `AISY_EXECUTION_ID=${input.request.executionId}`,
        `AISY_POLICY_HASH=${input.request.policyHash}`,
        `AISY_CLONE_URL=${input.request.target.url}`,
        'AISY_HTTPS_PROXY=http://egress:3128',
        `AISY_WALL_TIME_MS=${input.request.sandbox.limits.wallTimeMs}`,
      ],
      tmpfs: [
        `/workspace:rw,nosuid,nodev,noexec,size=${input.request.sandbox.limits.diskBytes},mode=0700`,
        '/run/aisy:rw,nosuid,nodev,noexec,size=1048576,mode=0700',
        '/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=0700',
      ],
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
    }),
  })
}

function optionSet(value: unknown): Set<string> | null {
  if (typeof value !== 'string') return null
  return new Set(value.split(',').filter(Boolean))
}

function hasTmpfs(
  hostConfig: Record<string, unknown>,
  path: string,
  expected: readonly string[],
): boolean {
  const tmpfs = record(hostConfig['Tmpfs'])
  const options = tmpfs === null ? null : optionSet(tmpfs[path])
  return options !== null && expected.every(item => options.has(item))
}

function validEnvironment(value: unknown, required: readonly string[]): boolean {
  const environment = asStringArray(value)
  if (environment === null) return false
  const values = new Map<string, string>()
  for (const entry of environment) {
    const separator = entry.indexOf('=')
    if (separator <= 0) return false
    const key = separator < 0 ? entry : entry.slice(0, separator)
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK|AWS_|GITHUB_|GITLAB_)/i.test(key) ||
      values.has(key)) return false
    values.set(key, entry)
  }
  return required.every(entry => {
    const separator = entry.indexOf('=')
    return separator > 0 && values.get(entry.slice(0, separator)) === entry
  })
}

function validateContainerInspect(input: {
  raw: unknown
  image: string
  network: string
  executionId: string
  policyHash: string
  requiredEnvironment: readonly string[]
  memoryBytes: number
  cpuMillicores: number
  pids: number
  workspaceBytes?: number
}): void {
  const root = keyed(input.raw)
  const config = keyed(root['Config'])
  const host = keyed(root['HostConfig'])
  const capDrop = asStringArray(host['CapDrop'])
  const security = asStringArray(host['SecurityOpt'])
  const binds = host['Binds']
  const mounts = root['Mounts']
  const labels = record(config['Labels'])
  const environment = asStringArray(config['Env'])
  const expectedNanoCpus = input.cpuMillicores * 1_000_000
  const basic = config['Image'] === input.image && config['User'] === CONTAINER_USER &&
    environment !== null && validEnvironment(environment, input.requiredEnvironment) &&
    host['NetworkMode'] === input.network &&
    host['ReadonlyRootfs'] === true && host['Privileged'] === false &&
    capDrop !== null && capDrop.length === 1 && capDrop[0] === 'ALL' &&
    security !== null && security.includes('no-new-privileges=true') &&
    security.includes('seccomp=builtin') && host['IpcMode'] === 'none' &&
    host['Memory'] === input.memoryBytes && host['MemorySwap'] === input.memoryBytes &&
    host['NanoCpus'] === expectedNanoCpus && host['PidsLimit'] === input.pids &&
    (binds === null || (Array.isArray(binds) && binds.length === 0)) &&
    Array.isArray(mounts) && mounts.length === 0 && labels !== null &&
    labels['com.aisy.clone.execution'] === input.executionId &&
    labels['com.aisy.clone.policy'] === input.policyHash
  if (!basic || (input.workspaceBytes !== undefined && !hasTmpfs(host, '/workspace', [
    'rw', 'nosuid', 'nodev', 'noexec', `size=${input.workspaceBytes}`, 'mode=0700',
  ]))) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  }
}

interface ContainerState {
  readonly running: boolean
  readonly exitCode: number
  readonly oomKilled: boolean
}

function parseContainerState(raw: unknown): ContainerState {
  const root = keyed(raw)
  const state = keyed(root['State'])
  if (typeof state['Running'] !== 'boolean' || !Number.isSafeInteger(state['ExitCode']) ||
    typeof state['OOMKilled'] !== 'boolean') {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  }
  return {
    running: state['Running'],
    exitCode: state['ExitCode'] as number,
    oomKilled: state['OOMKilled'],
  }
}

function validateGatewayNetworks(raw: unknown, names: RestrictedCloneDockerNames): void {
  const root = keyed(raw)
  const networkSettings = keyed(root['NetworkSettings'])
  const networks = keyed(networkSettings['Networks'])
  const keys = new Set(Object.keys(networks))
  if (keys.size !== 2 || !keys.has('bridge') || !keys.has(names.network)) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  }
}

function parseInspect(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCKER_OUTPUT_BYTES) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  }
  try { return JSON.parse(text) } catch {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED')
  }
}

function requireCompatibleDockerVersion(value: string): void {
  if (!isRestrictedCloneDockerVersionCompatible(value)) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_RUNTIME_INCOMPATIBLE')
  }
}

export function makeNodeDockerCommandPort(options: {
  dockerExecutable: string
  dockerHost?: string
}): DockerCommandPort {
  if (!isAbsolute(options.dockerExecutable) || normalize(options.dockerExecutable) !== options.dockerExecutable ||
    (options.dockerHost !== undefined && !/^unix:\/\/\/.+/.test(options.dockerHost))) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_POLICY_INVALID')
  }
  return Object.freeze({
    run(
      args: readonly string[],
      commandOptions: Readonly<{
        timeoutMs: number
        maxOutputBytes: number
        signal?: AbortSignal
      }>,
    ): Promise<DockerCommandResult> {
      return new Promise<DockerCommandResult>(resolve => {
        execFile(options.dockerExecutable, [...args], {
          cwd: '/',
          shell: false,
          timeout: commandOptions.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: commandOptions.maxOutputBytes,
          signal: commandOptions.signal,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            HOME: '/nonexistent',
            DOCKER_CONFIG: '/nonexistent',
            ...(options.dockerHost === undefined ? {} : { DOCKER_HOST: options.dockerHost }),
          },
        }, (error, stdout, stderr) => {
          const details = error as NodeJS.ErrnoException & { killed?: boolean }
          const exitCode = typeof details?.code === 'number' ? details.code : error ? 1 : 0
          resolve({
            exitCode,
            stdout: String(stdout),
            stderr: String(stderr),
            ...(details?.killed === true ? { timedOut: true } : {}),
            ...(commandOptions.signal?.aborted === true ? { aborted: true } : {}),
            ...(details?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { overflow: true } : {}),
          })
        })
      })
    },
  })
}

export function makeRestrictedCloneDockerSupervisor(deps: {
  docker: DockerCommandPort
  gatewayImageDigest: string
  runtime?: string
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  listStaging?: (path: string) => string[]
}): RestrictedCloneSidecarSupervisor {
  if (!validImage(deps.gatewayImageDigest)) {
    throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_POLICY_INVALID')
  }
  const nowMs = deps.nowMs ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const listStaging: (path: string) => string[] = deps.listStaging ??
    ((path: string) => readdirSync(path))

  const supervisor: RestrictedCloneSidecarSupervisor = {
    async run(
      request: RestrictedCloneSidecarRequest,
      signal?: AbortSignal,
    ): Promise<RestrictedCloneSidecarAttestation> {
      requireCanonicalRequest(request)
      const names = restrictedCloneDockerNames(request)
      const argv = restrictedCloneDockerArgv({
        request,
        gatewayImageDigest: deps.gatewayImageDigest,
        ...(deps.runtime === undefined ? {} : { runtime: deps.runtime }),
      })
      const deadline = nowMs() + request.sandbox.limits.wallTimeMs
      let networkCreated = false
      let gatewayCreated = false
      let workerCreated = false
      let policyApplied = false
      let outcome: RestrictedCloneSidecarAttestation['outcome'] = 'failed'
      let exitCode: number | null = null
      let failure: unknown

      const remaining = (): number => {
        if (signal?.aborted === true) {
          outcome = 'cancelled'
          throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
        }
        const value = deadline - nowMs()
        if (value <= 0) {
          outcome = 'timed-out'
          throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
        }
        return value
      }
      const run = async (args: readonly string[], allowNonZero = false): Promise<DockerCommandResult> => {
        const result = await deps.docker.run(args, {
          timeoutMs: remaining(),
          maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        })
        if (result.aborted === true) outcome = 'cancelled'
        if (result.timedOut === true) outcome = 'timed-out'
        if (result.aborted === true || result.timedOut === true || result.overflow === true ||
          (!allowNonZero && result.exitCode !== 0) ||
          Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8') >
            MAX_DOCKER_OUTPUT_BYTES) {
          throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
        }
        return result
      }
      const inspect = async (name: string): Promise<unknown> => {
        const result = await run(['container', 'inspect', '--format={{json .}}', name])
        return parseInspect(result.stdout.trim())
      }
      const cleanup = async (): Promise<boolean> => {
        let clean = true
        const remove = async (args: readonly string[]): Promise<void> => {
          const result = await deps.docker.run(args, {
            timeoutMs: CLEANUP_TIMEOUT_MS,
            maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
          }).catch(() => null)
          if (result === null || result.exitCode !== 0 || result.overflow === true) clean = false
        }
        if (workerCreated) await remove(['container', 'rm', '--force', '--volumes', names.worker])
        if (gatewayCreated) await remove(['container', 'rm', '--force', '--volumes', names.gateway])
        if (networkCreated) await remove(['network', 'rm', names.network])
        return clean
      }

      try {
        if (listStaging(request.staging.source).length !== 0) {
          throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_STAGING_DENIED')
        }
        const version = await run(['version', '--format={{.Server.Version}}'])
        requireCompatibleDockerVersion(version.stdout)
        await run(argv.networkCreate)
        networkCreated = true
        await run(argv.gatewayCreate)
        gatewayCreated = true
        validateContainerInspect({
          raw: await inspect(names.gateway),
          image: deps.gatewayImageDigest,
          network: 'bridge',
          executionId: request.executionId,
          policyHash: request.policyHash,
          requiredEnvironment: [
            `AISY_EGRESS_HOST=${request.target.hostname}`,
            `AISY_EGRESS_IPS_JSON=${JSON.stringify(request.target.addresses.map(item => item.address))}`,
            `AISY_EGRESS_MAX_BYTES=${Math.min(
              request.sandbox.limits.diskBytes * 4,
              42_949_672_960,
            )}`,
          ],
          memoryBytes: GATEWAY_MEMORY_BYTES,
          cpuMillicores: 250,
          pids: GATEWAY_PIDS,
        })
        await run(argv.gatewayConnect)
        validateGatewayNetworks(await inspect(names.gateway), names)
        await run(['container', 'start', names.gateway])
        let gatewayReady = false
        while (!gatewayReady) {
          const probe = await run([
            'container', 'exec', names.gateway,
            'python3', '/opt/aisy/restricted_clone_egress.py', 'healthcheck',
          ], true)
          if (probe.exitCode === 0) gatewayReady = true
          else {
            const state = parseContainerState(await inspect(names.gateway))
            if (!state.running) {
              exitCode = state.exitCode
              throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
            }
            await sleep(Math.min(READY_POLL_MS, remaining()))
          }
        }

        await run(argv.workerCreate)
        workerCreated = true
        validateContainerInspect({
          raw: await inspect(names.worker),
          image: request.imageDigest,
          network: names.network,
          executionId: request.executionId,
          policyHash: request.policyHash,
          requiredEnvironment: [
            `AISY_EXECUTION_ID=${request.executionId}`,
            `AISY_POLICY_HASH=${request.policyHash}`,
            `AISY_CLONE_URL=${request.target.url}`,
            'AISY_HTTPS_PROXY=http://egress:3128',
            `AISY_WALL_TIME_MS=${request.sandbox.limits.wallTimeMs}`,
          ],
          memoryBytes: request.sandbox.limits.memoryBytes,
          cpuMillicores: request.sandbox.limits.cpuMillicores,
          pids: request.sandbox.limits.pids,
          workspaceBytes: request.sandbox.limits.diskBytes,
        })
        policyApplied = true
        await run(['container', 'start', names.worker])
        let workerReady = false
        while (!workerReady) {
          const probe = await run([
            'container', 'exec', names.worker,
            'python3', '/opt/aisy/restricted_clone_worker.py', 'status',
          ], true)
          if (probe.exitCode === 0) workerReady = true
          else if (probe.exitCode === 2) {
            exitCode = 2
            outcome = 'failed'
            break
          } else {
            const state = parseContainerState(await inspect(names.worker))
            if (!state.running) {
              exitCode = state.exitCode
              outcome = state.oomKilled ? 'quota-exceeded' : 'failed'
              break
            }
            await sleep(Math.min(READY_POLL_MS, remaining()))
          }
        }
        if (workerReady) {
          await run([
            'container', 'cp',
            `${names.worker}:${request.sandbox.workspace.exportSource}`,
            request.staging.source,
          ])
          if (listStaging(request.staging.source).length === 0) {
            throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_STAGING_DENIED')
          }
          outcome = 'succeeded'
          exitCode = 0
        }
      } catch (error) {
        failure = error
      }

      const cleaned = await cleanup()
      if (!cleaned) throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_CLEANUP_FAILED')
      if (!policyApplied) {
        if (failure instanceof RestrictedCloneDockerSupervisorError) throw failure
        throw new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
      }
      if (failure !== undefined && outcome === 'failed' && exitCode === null) {
        throw failure instanceof RestrictedCloneDockerSupervisorError
          ? failure
          : new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_COMMAND_FAILED')
      }
      return Object.freeze({
        protocolVersion: RESTRICTED_CLONE_SIDECAR_PROTOCOL_VERSION,
        executionId: request.executionId,
        policyHash: request.policyHash,
        imageDigest: request.imageDigest,
        stagingIdentity: request.staging.identity,
        outcome,
        exitCode,
        outputBytes: 0,
        sandboxDestroyed: true,
        applied: Object.freeze({
          network: 'isolated-egress-gateway-only' as const,
          credentials: 'none' as const,
          hostNetwork: false as const,
          dockerSocket: false as const,
          privileged: false as const,
        }),
      })
    },
  }
  return Object.freeze(supervisor)
}

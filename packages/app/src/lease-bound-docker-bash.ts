import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import {
  ContextLeaseError,
  isRestrictedCloneImageDigest,
  type ContextLeaseCoordinator,
  type TurnContextLease,
} from '@aisy/core'
import {
  makeNodeDockerCommandPort,
  type DockerCommandPort,
  type DockerCommandResult,
} from './restricted-clone-docker-supervisor.js'

export type LeaseBoundDockerBashErrorCode =
  | 'BASH_POLICY_INVALID'
  | 'BASH_ROOT_CHANGED'
  | 'BASH_USERNS_REQUIRED'
  | 'BASH_CREATE_FAILED'
  | 'BASH_INSPECT_DENIED'
  | 'BASH_TIMEOUT'
  | 'BASH_ABORTED'
  | 'BASH_OUTPUT_LIMIT'
  | 'BASH_RESOURCE_LIMIT'
  | 'BASH_EXECUTION_FAILED'
  | 'BASH_CLEANUP_FAILED'

export class LeaseBoundDockerBashError extends Error {
  constructor(public readonly code: LeaseBoundDockerBashErrorCode) {
    super(code)
    this.name = 'LeaseBoundDockerBashError'
  }
}

export interface LeaseBoundDockerBashPolicy {
  readonly imageDigest: string
  readonly runtime: string
  readonly memoryBytes: number
  readonly cpuMillicores: number
  readonly pids: number
  readonly wallTimeMs: number
  readonly maxOutputBytes: number
}

export interface LeaseBoundDockerBashRootIdentity {
  readonly canonicalRoot: string
  readonly identity: string
}

export interface LeaseBoundDockerBashEvent {
  readonly kind:
    | 'sandbox.bash.started'
    | 'sandbox.bash.completed'
    | 'sandbox.bash.denied'
    | 'sandbox.bash.cleanup_failed'
  readonly leaseId: string
  readonly projectId: string
  readonly sessionId: string
  readonly generation: number
  readonly operationId: string
  readonly executionId: string
  readonly code?: LeaseBoundDockerBashErrorCode
}

export interface LeaseBoundDockerBashArgv {
  readonly info: readonly string[]
  readonly create: readonly string[]
  readonly inspect: readonly string[]
  readonly start: readonly string[]
  readonly wait: readonly string[]
  readonly logs: readonly string[]
  readonly cleanup: readonly string[]
  readonly name: string
}

export interface NodeLeaseBoundDockerBashOptions {
  readonly leases: ContextLeaseCoordinator
  readonly dockerExecutable: string
  readonly dockerHost?: string
  readonly policy: LeaseBoundDockerBashPolicy
  readonly emit?: (event: LeaseBoundDockerBashEvent) => void
}

const RUNTIME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTAINER_USER = '65532:65532'
const INFO_TIMEOUT_MS = 10_000
const CONTROL_OUTPUT_BYTES = 128 * 1024
const MAX_COMMAND_BYTES = 128 * 1024
const MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_WALL_TIME_MS = 30 * 60 * 1000

function deny(code: LeaseBoundDockerBashErrorCode): never {
  throw new LeaseBoundDockerBashError(code)
}

function validInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function validatePolicy(policy: LeaseBoundDockerBashPolicy): void {
  if (!isRestrictedCloneImageDigest(policy.imageDigest) || !RUNTIME.test(policy.runtime) ||
    !validInteger(policy.memoryBytes, 64 * 1024 * 1024, MAX_MEMORY_BYTES) ||
    !validInteger(policy.cpuMillicores, 50, 8_000) ||
    !validInteger(policy.pids, 8, 1_024) ||
    !validInteger(policy.wallTimeMs, 1_000, MAX_WALL_TIME_MS) ||
    !validInteger(policy.maxOutputBytes, 1_024, MAX_OUTPUT_BYTES)) {
    deny('BASH_POLICY_INVALID')
  }
}

function validateRoot(root: string): void {
  if (!root.startsWith('/') || root === '/' || root.includes('\0') ||
    root.includes('\n') || root.includes('\r') || root.includes(',')) {
    deny('BASH_POLICY_INVALID')
  }
}

export function inspectNodeLeaseBoundDockerBashRoot(
  root: string,
): LeaseBoundDockerBashRootIdentity {
  validateRoot(root)
  try {
    const before = lstatSync(root, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) deny('BASH_ROOT_CHANGED')
    const canonicalRoot = realpathSync.native(root)
    const after = lstatSync(root, { bigint: true })
    if (!after.isDirectory() || after.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino) {
      deny('BASH_ROOT_CHANGED')
    }
    return {
      canonicalRoot,
      identity: `${after.dev}:${after.ino}`,
    }
  } catch (error) {
    if (error instanceof LeaseBoundDockerBashError) throw error
    deny('BASH_ROOT_CHANGED')
  }
}

function validateCommand(command: string): void {
  if (command.length === 0 || command.includes('\0') ||
    Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    deny('BASH_POLICY_INVALID')
  }
}

function executionName(lease: TurnContextLease, operationId: string): string {
  const suffix = createHash('sha256')
    .update(`${lease.leaseId}\0${operationId}\0${lease.generation}`)
    .digest('hex')
    .slice(0, 24)
  return `aisy-bash-${suffix}`
}

export function leaseBoundDockerBashArgv(input: {
  lease: TurnContextLease
  operationId: string
  command: string
  policy: LeaseBoundDockerBashPolicy
}): LeaseBoundDockerBashArgv {
  validatePolicy(input.policy)
  validateRoot(input.lease.root)
  validateCommand(input.command)
  const name = executionName(input.lease, input.operationId)
  const cpu = (input.policy.cpuMillicores / 1_000).toFixed(3)
  return Object.freeze({
    name,
    info: ['info', '--format={{json .SecurityOptions}}'],
    create: [
      'container', 'create',
      '--pull=never',
      `--name=${name}`,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true',
      '--security-opt=seccomp=builtin',
      '--ipc=none',
      `--pids-limit=${input.policy.pids}`,
      `--memory=${input.policy.memoryBytes}`,
      `--memory-swap=${input.policy.memoryBytes}`,
      `--cpus=${cpu}`,
      `--user=${CONTAINER_USER}`,
      '--ulimit=nofile=1024:1024',
      '--stop-timeout=1',
      '--log-driver=local',
      `--log-opt=max-size=${input.policy.maxOutputBytes}`,
      '--log-opt=max-file=1',
      '--log-opt=compress=false',
      `--mount=type=bind,src=${input.lease.root},dst=/work,rw`,
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=0700',
      '--workdir=/work',
      `--runtime=${input.policy.runtime}`,
      `--label=com.aisy.bash.execution=${name}`,
      input.policy.imageDigest,
      'sh', '-lc', input.command,
    ],
    inspect: ['container', 'inspect', `--format={{json .}}`, name],
    start: ['container', 'start', name],
    wait: ['container', 'wait', name],
    logs: ['container', 'logs', name],
    cleanup: ['container', 'rm', '--force', '--volumes', name],
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function keyed(value: unknown): Record<string, unknown> {
  const parsed = record(value)
  if (parsed === null) deny('BASH_INSPECT_DENIED')
  return parsed
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value as string[]
    : null
}

function parseJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > CONTROL_OUTPUT_BYTES) deny('BASH_INSPECT_DENIED')
  try {
    return JSON.parse(text)
  } catch {
    deny('BASH_INSPECT_DENIED')
  }
}

function requireDaemonIsolation(raw: string): void {
  const options = strings(parseJson(raw))
  if (options === null || !options.some(option =>
    option === 'name=userns' || option === 'name=rootless' ||
    option.startsWith('name=userns,') || option.startsWith('name=rootless,'))) {
    deny('BASH_USERNS_REQUIRED')
  }
}

function optionSet(value: unknown): Set<string> | null {
  if (typeof value !== 'string') return null
  return new Set(value.split(',').filter(Boolean))
}

function requireInspect(input: {
  raw: string
  lease: TurnContextLease
  command: string
  policy: LeaseBoundDockerBashPolicy
}): void {
  const root = keyed(parseJson(input.raw))
  const config = keyed(root['Config'])
  const host = keyed(root['HostConfig'])
  const mounts = root['Mounts']
  const security = strings(host['SecurityOpt'])
  const capDrop = strings(host['CapDrop'])
  const command = strings(config['Cmd'])
  const tmpfs = record(host['Tmpfs'])
  const tmpOptions = tmpfs === null ? null : optionSet(tmpfs['/tmp'])
  const logConfig = record(host['LogConfig'])
  const logOptions = logConfig === null ? null : record(logConfig['Config'])
  const restart = record(host['RestartPolicy'])
  const devices = host['Devices']
  const noDevices = devices === null || (Array.isArray(devices) && devices.length === 0)
  const expectedNanoCpus = input.policy.cpuMillicores * 1_000_000
  const exactMount = Array.isArray(mounts) && mounts.length === 1 && (() => {
    const mount = record(mounts[0])
    return mount !== null && mount['Type'] === 'bind' &&
      mount['Source'] === input.lease.root && mount['Destination'] === '/work' &&
      mount['RW'] === true
  })()
  if (config['Image'] !== input.policy.imageDigest || config['User'] !== CONTAINER_USER ||
    command === null || command.length !== 3 || command[0] !== 'sh' ||
    command[1] !== '-lc' || command[2] !== input.command ||
    host['NetworkMode'] !== 'none' || host['ReadonlyRootfs'] !== true ||
    host['Privileged'] !== false || host['IpcMode'] !== 'none' ||
    (host['PidMode'] !== '' && host['PidMode'] !== undefined) ||
    (host['UTSMode'] !== '' && host['UTSMode'] !== undefined) || host['CgroupnsMode'] === 'host' ||
    host['PidsLimit'] !== input.policy.pids || host['Memory'] !== input.policy.memoryBytes ||
    host['MemorySwap'] !== input.policy.memoryBytes || host['NanoCpus'] !== expectedNanoCpus ||
    host['Runtime'] !== input.policy.runtime || capDrop === null || capDrop.length !== 1 ||
    capDrop[0] !== 'ALL' || security === null ||
    !security.includes('no-new-privileges=true') || !security.includes('seccomp=builtin') ||
    logConfig?.['Type'] !== 'local' ||
    logOptions?.['max-size'] !== String(input.policy.maxOutputBytes) ||
    logOptions?.['max-file'] !== '1' || logOptions?.['compress'] !== 'false' ||
    restart?.['Name'] !== 'no' ||
    !noDevices || !exactMount || tmpOptions === null ||
    !['rw', 'nosuid', 'nodev', 'noexec', 'size=67108864', 'mode=0700']
      .every(option => tmpOptions.has(option))) {
    deny('BASH_INSPECT_DENIED')
  }
}

function requireWaitExitCode(raw: string): number {
  if (!/^(?:0|[1-9][0-9]{0,2})\n?$/.test(raw)) deny('BASH_EXECUTION_FAILED')
  const exitCode = Number(raw.trim())
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    deny('BASH_EXECUTION_FAILED')
  }
  return exitCode
}

function requireCompletedState(raw: string, attestedExitCode: number): number {
  const root = keyed(parseJson(raw))
  const state = keyed(root['State'])
  if (state['OOMKilled'] === true) deny('BASH_RESOURCE_LIMIT')
  const exitCode = state['ExitCode']
  if (state['Running'] !== false || state['Status'] !== 'exited' || state['Dead'] === true ||
    (typeof state['Error'] === 'string' && state['Error'].length > 0) ||
    !Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255 ||
    attestedExitCode !== exitCode) {
    deny('BASH_EXECUTION_FAILED')
  }
  return exitCode as number
}

function resultFailure(result: DockerCommandResult): LeaseBoundDockerBashErrorCode | null {
  if (result.aborted === true) return 'BASH_ABORTED'
  if (result.timedOut === true) return 'BASH_TIMEOUT'
  if (result.overflow === true) return 'BASH_OUTPUT_LIMIT'
  return null
}

export function makeLeaseBoundDockerBash(input: {
  readonly leases: ContextLeaseCoordinator
  readonly docker: DockerCommandPort
  readonly policy: LeaseBoundDockerBashPolicy
  readonly inspectRoot: (root: string) => LeaseBoundDockerBashRootIdentity
  readonly emit?: (event: LeaseBoundDockerBashEvent) => void
}): (
  lease: TurnContextLease,
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  validatePolicy(input.policy)
  const event = (
    kind: LeaseBoundDockerBashEvent['kind'],
    lease: TurnContextLease,
    operationId: string,
    executionId: string,
    code?: LeaseBoundDockerBashErrorCode,
  ): void => {
    try {
      input.emit?.({
        kind,
        leaseId: lease.leaseId,
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        generation: lease.generation,
        operationId,
        executionId,
        ...(code === undefined ? {} : { code }),
      })
    } catch {
      // Observability is non-load-bearing for the sandbox boundary.
    }
  }

  return async (lease, command) => {
    const operation = input.leases.reserveOperation(lease)
    let argv: LeaseBoundDockerBashArgv | undefined
    let created = false
    let failure: LeaseBoundDockerBashErrorCode | undefined
    try {
      argv = leaseBoundDockerBashArgv({ lease, operationId: operation.operationId, command, policy: input.policy })
      operation.beginIo()
      const before = input.inspectRoot(lease.root)
      if (before.canonicalRoot !== lease.root || before.identity.length === 0) {
        deny('BASH_ROOT_CHANGED')
      }
      event('sandbox.bash.started', lease, operation.operationId, argv.name)
      const security = await input.docker.run(argv.info, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        signal: input.leases.signal(lease),
      })
      const securityFailure = resultFailure(security)
      if (securityFailure !== null) deny(securityFailure)
      if (security.exitCode !== 0) deny('BASH_USERNS_REQUIRED')
      requireDaemonIsolation(security.stdout)

      const create = await input.docker.run(argv.create, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        signal: input.leases.signal(lease),
      })
      const createFailure = resultFailure(create)
      if (createFailure !== null) deny(createFailure)
      if (create.exitCode !== 0) deny('BASH_CREATE_FAILED')
      created = true

      const inspect = await input.docker.run(argv.inspect, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        signal: input.leases.signal(lease),
      })
      const inspectFailure = resultFailure(inspect)
      if (inspectFailure !== null || inspect.exitCode !== 0) {
        deny(inspectFailure ?? 'BASH_INSPECT_DENIED')
      }
      requireInspect({ raw: inspect.stdout, lease, command, policy: input.policy })
      const after = input.inspectRoot(lease.root)
      if (after.canonicalRoot !== before.canonicalRoot || after.identity !== before.identity) {
        deny('BASH_ROOT_CHANGED')
      }

      const run = await input.docker.run(argv.start, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        signal: input.leases.signal(lease),
      })
      const runFailure = resultFailure(run)
      if (runFailure !== null || run.exitCode !== 0) {
        deny(runFailure ?? 'BASH_EXECUTION_FAILED')
      }
      const waited = await input.docker.run(argv.wait, {
        timeoutMs: input.policy.wallTimeMs,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
        signal: input.leases.signal(lease),
      })
      const waitFailure = resultFailure(waited)
      if (waitFailure !== null || waited.exitCode !== 0 || waited.stderr.length !== 0) {
        deny(waitFailure ?? 'BASH_EXECUTION_FAILED')
      }
      const waitedExitCode = requireWaitExitCode(waited.stdout)
      const finalInspect = await input.docker.run(argv.inspect, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: CONTROL_OUTPUT_BYTES,
      })
      const finalInspectFailure = resultFailure(finalInspect)
      if (finalInspectFailure !== null || finalInspect.exitCode !== 0) {
        deny('BASH_EXECUTION_FAILED')
      }
      requireInspect({ raw: finalInspect.stdout, lease, command, policy: input.policy })
      const exitCode = requireCompletedState(finalInspect.stdout, waitedExitCode)
      const logs = await input.docker.run(argv.logs, {
        timeoutMs: INFO_TIMEOUT_MS,
        maxOutputBytes: input.policy.maxOutputBytes,
      })
      const logsFailure = resultFailure(logs)
      if (logsFailure !== null || logs.exitCode !== 0) {
        deny(logsFailure ?? 'BASH_EXECUTION_FAILED')
      }
      return { stdout: logs.stdout, stderr: logs.stderr, exitCode }
    } catch (error) {
      if (error instanceof ContextLeaseError) {
        failure = 'BASH_ABORTED'
        throw error
      }
      failure = error instanceof LeaseBoundDockerBashError
        ? error.code
        : 'BASH_CREATE_FAILED'
      throw new LeaseBoundDockerBashError(failure)
    } finally {
      let cleanupFailed = false
      if (created && argv !== undefined) {
        try {
          const cleanup = await input.docker.run(argv.cleanup, {
            timeoutMs: INFO_TIMEOUT_MS,
            maxOutputBytes: CONTROL_OUTPUT_BYTES,
          })
          cleanupFailed = cleanup.exitCode !== 0 || resultFailure(cleanup) !== null
        } catch {
          cleanupFailed = true
        }
      }
      if (argv !== undefined) {
        if (cleanupFailed) {
          event('sandbox.bash.cleanup_failed', lease, operation.operationId, argv.name, 'BASH_CLEANUP_FAILED')
        } else if (failure !== undefined) {
          event('sandbox.bash.denied', lease, operation.operationId, argv.name, failure)
        } else {
          event('sandbox.bash.completed', lease, operation.operationId, argv.name)
        }
      }
      operation.complete()
      if (cleanupFailed) throw new LeaseBoundDockerBashError('BASH_CLEANUP_FAILED')
    }
  }
}

export function makeNodeLeaseBoundDockerBash(
  input: NodeLeaseBoundDockerBashOptions,
): (
  lease: TurnContextLease,
  command: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const docker = makeNodeDockerCommandPort({
    dockerExecutable: input.dockerExecutable,
    ...(input.dockerHost === undefined ? {} : { dockerHost: input.dockerHost }),
  })
  return makeLeaseBoundDockerBash({
    leases: input.leases,
    docker,
    policy: input.policy,
    inspectRoot: inspectNodeLeaseBoundDockerBashRoot,
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  })
}

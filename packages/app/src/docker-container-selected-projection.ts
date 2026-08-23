import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'

import {
  OWNED_DOCKER_LABEL_KEYS_V1,
  OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1,
} from './execution-owned-docker-normalization.js'

const HASH_DOMAIN = 'aisy.owned-docker.container-selected-projection.v2\0'
const IMAGE_CONFIG_ID = /^sha256:[a-f0-9]{64}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_ITEMS = 4_096
const MAX_CANONICAL_BYTES = 1024 * 1024
const OWNERSHIP_LABELS = new Set<string>(OWNED_DOCKER_OWNERSHIP_LABEL_NAMES_V1)
const jsonStringify = JSON.stringify
export const DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2 = Object.freeze([
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
  '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware',
].sort())
export const DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2 = Object.freeze([
  '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger',
].sort())

export type DockerContainerSelectedProjectionSidecarKindV2 =
  | 'whisper'
  | 'lease-bound-docker-bash'

export type DockerContainerSelectedProjectionRoleV2 = 'worker'

export interface DockerContainerSelectedProjectionConfigV2 {
  readonly image: string
  readonly user: string
  readonly env: readonly string[]
  readonly entrypoint: readonly string[]
  readonly cmd: readonly string[]
  readonly workingDir: string
  readonly openStdin: boolean
  readonly stdinOnce: boolean
  readonly tty: boolean
  readonly labels: Readonly<Record<string, string>>
  readonly healthcheckDisabled: true
  readonly stopSignal: string
}

export interface DockerContainerSelectedProjectionRestartPolicyV2 {
  readonly name: 'no'
  readonly maximumRetryCount: 0
}

export interface DockerContainerSelectedProjectionLogConfigV2 {
  readonly type: 'local' | 'none'
  readonly config: Readonly<Record<string, string>>
}

export interface DockerContainerSelectedProjectionUlimitV2 {
  readonly name: 'nofile'
  readonly soft: number
  readonly hard: number
}

export interface DockerContainerSelectedProjectionHostConfigV2 {
  readonly networkMode: 'none'
  readonly readonlyRootfs: true
  readonly privileged: false
  readonly capAdd: readonly string[]
  readonly capDrop: readonly string[]
  readonly securityOpt: readonly string[]
  readonly groupAdd: readonly []
  readonly sysctls: Readonly<Record<string, never>>
  readonly maskedPaths: readonly string[]
  readonly readonlyPaths: readonly string[]
  readonly ipcMode: 'none'
  readonly pidMode: ''
  readonly utsMode: ''
  readonly cgroupnsMode: 'private'
  readonly usernsMode: ''
  readonly pidsLimit: number
  readonly memory: number
  readonly memorySwap: number
  readonly nanoCpus: number
  readonly runtime: string
  readonly restartPolicy: DockerContainerSelectedProjectionRestartPolicyV2
  readonly autoRemove: false
  readonly logConfig: DockerContainerSelectedProjectionLogConfigV2
  readonly tmpfs: Readonly<Record<string, string>>
  readonly ulimits: readonly DockerContainerSelectedProjectionUlimitV2[]
  readonly devices: readonly []
  readonly deviceRequests: readonly []
  readonly portBindings: Readonly<Record<string, never>>
  readonly publishAllPorts: false
  readonly oomKillDisable: false
  readonly oomScoreAdj: 0
  readonly shmSize: number
  readonly init: false
}

export interface DockerContainerSelectedProjectionMountV2 {
  readonly type: 'bind'
  readonly source: string
  readonly destination: '/input' | '/work'
  readonly readOnly: boolean
  readonly propagation: 'rprivate'
}

export interface ExpectedOwnedDockerContainerProjectionV2 {
  readonly version: 2
  readonly resourceKind: 'container'
  readonly sidecarKind: DockerContainerSelectedProjectionSidecarKindV2
  readonly role: DockerContainerSelectedProjectionRoleV2
  readonly imageId: string
  readonly config: DockerContainerSelectedProjectionConfigV2
  readonly hostConfig: DockerContainerSelectedProjectionHostConfigV2
  readonly mounts: readonly DockerContainerSelectedProjectionMountV2[]
}

export interface ObservedOwnedDockerContainerProjectionV2 {
  readonly version: 2
  readonly resourceKind: 'container'
  readonly sidecarKind: DockerContainerSelectedProjectionSidecarKindV2
  readonly role: DockerContainerSelectedProjectionRoleV2
  readonly imageId: string
  readonly projectionHash: string
}

export class DockerContainerSelectedProjectionError extends Error {
  readonly code = 'DOCKER_CONTAINER_SELECTED_PROJECTION_INVALID' as const
  constructor() {
    super('DOCKER_CONTAINER_SELECTED_PROJECTION_INVALID')
    this.name = 'DockerContainerSelectedProjectionError'
  }
}

interface Budget { textBytes: number }
type Canonical = null | boolean | number | string | readonly Canonical[] | CanonicalRecord
interface CanonicalRecord { readonly [key: string]: Canonical }

function invalid(): DockerContainerSelectedProjectionError {
  return new DockerContainerSelectedProjectionError()
}

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
      return false
    }
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function properties(value: object, array = false): PropertyDescriptorMap {
  try {
    if (utilTypes.isProxy(value) || Object.getOwnPropertySymbols(value).length !== 0) throw invalid()
    const result = Object.getOwnPropertyDescriptors(value)
    for (const key of Reflect.ownKeys(result)) {
      if (typeof key !== 'string') throw invalid()
      const descriptor = result[key]
      if (descriptor === undefined || !('value' in descriptor) ||
        (array && key === 'length' ? descriptor.enumerable !== false : descriptor.enumerable !== true)) {
        throw invalid()
      }
    }
    return result
  } catch {
    throw invalid()
  }
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw invalid()
  const source = properties(value)
  const actual = Object.keys(source).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid()
  }
  return Object.fromEntries(expected.map(key => [key, source[key]!.value]))
}

function document(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) throw invalid()
  const source = properties(value)
  if (keys.some(key => !Object.hasOwn(source, key))) throw invalid()
  return Object.fromEntries(keys.map(key => [key, source[key]!.value]))
}

function charge(value: string, budget: Budget): string {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_TEXT_BYTES - budget.textBytes) throw invalid()
  budget.textBytes += bytes
  return value
}

function string(value: unknown, budget: Budget): string {
  if (typeof value !== 'string' || value.includes('\0')) throw invalid()
  return charge(value, budget)
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Object.is(value, -0)) throw invalid()
  return Number(value)
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid()
  return value
}

function stringArray(value: unknown, budget: Budget, nullable = false): readonly string[] {
  if (nullable && value === null) return Object.freeze([])
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_ITEMS) throw invalid()
  const source = properties(value, true)
  const keys = Object.keys(source).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid()
  return Object.freeze(keys.map(key => string(source[key]!.value, budget)))
}

function exactStringSet(
  value: unknown,
  expected: readonly string[],
  budget: Budget,
): readonly string[] {
  const items = stringArray(value, budget)
  const selected = [...items].sort()
  if (new Set(selected).size !== selected.length || selected.length !== expected.length ||
    selected.some((item, index) => item !== expected[index])) throw invalid()
  return Object.freeze(selected)
}

function stringMap(
  value: unknown,
  budget: Budget,
  nullable = false,
): Readonly<Record<string, string>> {
  if (nullable && value === null) return Object.freeze({})
  if (!plain(value)) throw invalid()
  const source = properties(value)
  const keys = Object.keys(source).sort()
  if (keys.length > MAX_ITEMS) throw invalid()
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const key of keys) {
    Object.defineProperty(result, charge(key, budget), {
      value: string(source[key]!.value, budget), enumerable: true, configurable: false, writable: false,
    })
  }
  return Object.freeze(result)
}

function withoutOwnershipLabels(
  value: unknown,
  budget: Budget,
  ownership: 'forbidden' | 'required',
): Readonly<Record<string, string>> {
  const labels = stringMap(value, budget, true)
  let count = 0
  const selected: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, label] of Object.entries(labels)) {
    if (key.startsWith('com.aisy.')) {
      if (!OWNERSHIP_LABELS.has(key)) throw invalid()
      count += 1
      continue
    }
    Object.defineProperty(selected, key, {
      value: label, enumerable: true, configurable: false, writable: false,
    })
  }
  if ((ownership === 'forbidden' && count !== 0) ||
    (ownership === 'required' && count !== OWNERSHIP_LABELS.size)) throw invalid()
  return Object.freeze(selected)
}

function sidecarIdentity(
  labels: Readonly<Record<string, string>>,
): Readonly<{ sidecarKind: DockerContainerSelectedProjectionSidecarKindV2; role: DockerContainerSelectedProjectionRoleV2 }> {
  const keys = OWNED_DOCKER_LABEL_KEYS_V1
  const sidecarKind = labels[keys.sidecarKind]
  const role = labels[keys.role]
  if ((sidecarKind !== 'whisper' && sidecarKind !== 'lease-bound-docker-bash') || role !== 'worker') {
    throw invalid()
  }
  for (const key of [keys.installationId, keys.ownerBindingHash, keys.sessionBindingHash,
    keys.operationBindingHash, keys.policyHash]) {
    if (!HASH.test(labels[key] ?? '')) throw invalid()
  }
  if (labels[keys.version] !== '1') throw invalid()
  return Object.freeze({ sidecarKind, role })
}

function normalizeHealthcheckDisabled(value: unknown, budget: Budget): true {
  const record = exact(value, ['Test'])
  const test = stringArray(record.Test, budget)
  if (test.length !== 1 || test[0] !== 'NONE') throw invalid()
  return true
}

function normalizeRestartPolicy(value: unknown): DockerContainerSelectedProjectionRestartPolicyV2 {
  const record = exact(value, ['Name', 'MaximumRetryCount'])
  if (record.Name !== 'no' || record.MaximumRetryCount !== 0) throw invalid()
  return Object.freeze({ name: 'no', maximumRetryCount: 0 })
}

function normalizeLogConfig(value: unknown, budget: Budget): DockerContainerSelectedProjectionLogConfigV2 {
  const record = exact(value, ['Type', 'Config'])
  if (record.Type !== 'local' && record.Type !== 'none') throw invalid()
  return Object.freeze({ type: record.Type, config: stringMap(record.Config, budget, true) })
}

function normalizeUlimits(value: unknown, budget: Budget): readonly DockerContainerSelectedProjectionUlimitV2[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 1) throw invalid()
  const source = properties(value, true)
  const item = exact(source['0']!.value, ['Name', 'Soft', 'Hard'])
  if (string(item.Name, budget) !== 'nofile') throw invalid()
  return Object.freeze([Object.freeze({
    name: 'nofile' as const,
    soft: integer(item.Soft, 1),
    hard: integer(item.Hard, 1),
  })])
}

function requireEmptyArray(value: unknown): readonly [] {
  if (value !== null && (!Array.isArray(value) || utilTypes.isProxy(value) || value.length !== 0)) {
    throw invalid()
  }
  if (Array.isArray(value)) properties(value, true)
  return Object.freeze([])
}

function requireEmptyRecord(value: unknown): Readonly<Record<string, never>> {
  if (value === null) return Object.freeze({})
  if (!plain(value) || Object.keys(properties(value)).length !== 0) throw invalid()
  return Object.freeze({})
}

function normalizeConfig(
  value: unknown,
  budget: Budget,
  ownership: 'forbidden' | 'required',
): DockerContainerSelectedProjectionConfigV2 {
  const record = document(value, [
    'Image', 'User', 'Env', 'Entrypoint', 'Cmd', 'WorkingDir', 'OpenStdin', 'StdinOnce',
    'Tty', 'Labels', 'Healthcheck', 'StopSignal',
  ])
  return Object.freeze({
    image: string(record.Image, budget),
    user: string(record.User, budget),
    env: stringArray(record.Env, budget, true),
    entrypoint: stringArray(record.Entrypoint, budget, true),
    cmd: stringArray(record.Cmd, budget, true),
    workingDir: string(record.WorkingDir, budget),
    openStdin: boolean(record.OpenStdin),
    stdinOnce: boolean(record.StdinOnce),
    tty: boolean(record.Tty),
    labels: withoutOwnershipLabels(record.Labels, budget, ownership),
    healthcheckDisabled: normalizeHealthcheckDisabled(record.Healthcheck, budget),
    stopSignal: string(record.StopSignal, budget),
  })
}

function normalizeHostConfig(
  value: unknown,
  budget: Budget,
): DockerContainerSelectedProjectionHostConfigV2 {
  const record = document(value, [
    'NetworkMode', 'ReadonlyRootfs', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt',
    'GroupAdd', 'Sysctls', 'MaskedPaths', 'ReadonlyPaths', 'IpcMode', 'PidMode', 'UTSMode',
    'CgroupnsMode', 'UsernsMode', 'PidsLimit', 'Memory',
    'MemorySwap', 'NanoCpus', 'Runtime', 'RestartPolicy', 'AutoRemove', 'LogConfig', 'Tmpfs',
    'Ulimits', 'Devices', 'DeviceRequests', 'PortBindings', 'PublishAllPorts', 'OomKillDisable',
    'OomScoreAdj', 'ShmSize', 'Init',
  ])
  if (record.ReadonlyRootfs !== true || record.Privileged !== false || record.IpcMode !== 'none' ||
    record.PidMode !== '' || record.UTSMode !== '' || record.CgroupnsMode !== 'private' ||
    record.UsernsMode !== '' || record.AutoRemove !== false || record.PublishAllPorts !== false ||
    record.OomKillDisable !== false || record.OomScoreAdj !== 0 || record.Init !== false) throw invalid()
  const capAdd = stringArray(record.CapAdd, budget, true)
  const capDrop = stringArray(record.CapDrop, budget, true)
  const securityOpt = stringArray(record.SecurityOpt, budget, true)
  if (capAdd.length !== 0 || capDrop.length !== 1 || capDrop[0] !== 'ALL' ||
    securityOpt.length !== 2 || securityOpt[0] !== 'no-new-privileges=true' ||
    securityOpt[1] !== 'seccomp=builtin') throw invalid()
  const memory = integer(record.Memory, 1)
  const memorySwap = integer(record.MemorySwap, 1)
  if (memorySwap !== memory) throw invalid()
  return Object.freeze({
    networkMode: record.NetworkMode === 'none' ? 'none' : (() => { throw invalid() })(),
    readonlyRootfs: true,
    privileged: false,
    capAdd,
    capDrop,
    securityOpt,
    groupAdd: requireEmptyArray(record.GroupAdd),
    sysctls: requireEmptyRecord(record.Sysctls),
    maskedPaths: exactStringSet(record.MaskedPaths, DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2, budget),
    readonlyPaths: exactStringSet(record.ReadonlyPaths, DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2, budget),
    ipcMode: 'none',
    pidMode: '',
    utsMode: '',
    cgroupnsMode: 'private',
    usernsMode: '',
    pidsLimit: integer(record.PidsLimit, 1),
    memory,
    memorySwap,
    nanoCpus: integer(record.NanoCpus, 1),
    runtime: string(record.Runtime, budget),
    restartPolicy: normalizeRestartPolicy(record.RestartPolicy),
    autoRemove: false,
    logConfig: normalizeLogConfig(record.LogConfig, budget),
    tmpfs: stringMap(record.Tmpfs, budget, true),
    ulimits: normalizeUlimits(record.Ulimits, budget),
    devices: requireEmptyArray(record.Devices),
    deviceRequests: requireEmptyArray(record.DeviceRequests),
    portBindings: requireEmptyRecord(record.PortBindings),
    publishAllPorts: false,
    oomKillDisable: false,
    oomScoreAdj: 0,
    shmSize: integer(record.ShmSize, 1),
    init: false,
  })
}

function normalizeMounts(value: unknown, budget: Budget): readonly DockerContainerSelectedProjectionMountV2[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 1) throw invalid()
  const source = properties(value, true)
  const keys = Object.keys(source).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid()
  return Object.freeze(keys.map(key => {
    const mount = document(source[key]!.value, ['Type', 'Source', 'Destination', 'RW', 'Propagation'])
    const destination = mount.Destination
    if (mount.Type !== 'bind' || (destination !== '/input' && destination !== '/work') ||
      typeof mount.RW !== 'boolean' || mount.Propagation !== 'rprivate') throw invalid()
    const sourcePath = string(mount.Source, budget)
    if (!sourcePath.startsWith('/') || sourcePath === '/') throw invalid()
    return Object.freeze({
      type: 'bind' as const,
      source: sourcePath,
      destination,
      readOnly: !mount.RW,
      propagation: 'rprivate' as const,
    })
  }))
}

function canonical(value: Canonical): string {
  const encode = (current: Canonical): string => {
    if (current === null) return 'null'
    if (typeof current === 'string') return jsonStringify(current)
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (typeof current === 'number') return String(current)
    if (Array.isArray(current)) return `[${current.map(encode).join(',')}]`
    const record = current as CanonicalRecord
    return `{${Object.keys(record).sort().map(key =>
      `${jsonStringify(key)}:${encode(record[key]!)}`).join(',')}}`
  }
  const result = encode(value)
  if (Buffer.byteLength(result, 'utf8') > MAX_CANONICAL_BYTES) throw invalid()
  return result
}

function hashProjection(input: ExpectedOwnedDockerContainerProjectionV2): string {
  return createHash('sha256').update(HASH_DOMAIN)
    .update(canonical(input as unknown as Canonical)).digest('hex')
}

function validateSelectedSidecarPolicy(input: ExpectedOwnedDockerContainerProjectionV2): void {
  const host = input.hostConfig
  const config = input.config
  const mount = input.mounts[0]
  if (input.role !== 'worker' || host.networkMode !== 'none' || input.mounts.length !== 1 ||
    mount === undefined || config.user !== '65532:65532' || host.memory < 64 * 1024 * 1024 ||
    host.memory > 16 * 1024 * 1024 * 1024 || host.memorySwap !== host.memory ||
    host.nanoCpus < 50_000_000 || host.nanoCpus > 8_000_000_000 ||
    host.pidsLimit < 8 || host.pidsLimit > 1_024 || host.shmSize !== 64 * 1024 * 1024 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(host.runtime) || config.stopSignal !== 'SIGTERM') {
    throw invalid()
  }
  const tmpfsKeys = Object.keys(host.tmpfs)
  if (tmpfsKeys.length !== 1 || tmpfsKeys[0] !== '/tmp' ||
    host.tmpfs['/tmp'] !== 'rw,nosuid,nodev,noexec,size=67108864,mode=0700') throw invalid()
  const ulimit = host.ulimits[0]
  if (ulimit === undefined || ulimit.soft !== ulimit.hard) throw invalid()

  if (input.sidecarKind === 'whisper') {
    if (mount.destination !== '/input' || mount.readOnly !== true || config.openStdin !== true ||
      config.stdinOnce !== false || config.tty !== false || host.logConfig.type !== 'none' ||
      Object.keys(host.logConfig.config).length !== 0 || ulimit.soft !== 256) throw invalid()
    return
  }
  if (mount.destination !== '/work' || mount.readOnly !== false || config.openStdin !== false ||
    config.stdinOnce !== false || config.tty !== false || config.workingDir !== '/work' ||
    config.entrypoint.length !== 1 || config.entrypoint[0] !== '/bin/sh' ||
    config.cmd.length !== 2 || config.cmd[0] !== '-lc' || host.logConfig.type !== 'local' ||
    Object.keys(host.logConfig.config).sort().join(',') !== 'compress,max-file,max-size' ||
    host.logConfig.config['max-file'] !== '1' || host.logConfig.config.compress !== 'false' ||
    !/^(?:[1-9][0-9]{3,6})$/.test(host.logConfig.config['max-size'] ?? '') ||
    ulimit.soft !== 1024) throw invalid()
}

function normalizeExpectedConfig(
  value: unknown,
  budget: Budget,
): DockerContainerSelectedProjectionConfigV2 {
  const record = exact(value, [
    'image', 'user', 'env', 'entrypoint', 'cmd', 'workingDir', 'openStdin', 'stdinOnce', 'tty',
    'labels', 'healthcheckDisabled', 'stopSignal',
  ])
  if (record.healthcheckDisabled !== true) throw invalid()
  return Object.freeze({
    image: string(record.image, budget),
    user: string(record.user, budget),
    env: stringArray(record.env, budget),
    entrypoint: stringArray(record.entrypoint, budget),
    cmd: stringArray(record.cmd, budget),
    workingDir: string(record.workingDir, budget),
    openStdin: boolean(record.openStdin),
    stdinOnce: boolean(record.stdinOnce),
    tty: boolean(record.tty),
    labels: withoutOwnershipLabels(record.labels, budget, 'forbidden'),
    healthcheckDisabled: true,
    stopSignal: string(record.stopSignal, budget),
  })
}

function normalizeExpectedHostConfig(
  value: unknown,
  budget: Budget,
): DockerContainerSelectedProjectionHostConfigV2 {
  const record = exact(value, [
    'networkMode', 'readonlyRootfs', 'privileged', 'capAdd', 'capDrop', 'securityOpt', 'ipcMode',
    'groupAdd', 'sysctls', 'maskedPaths', 'readonlyPaths', 'pidMode', 'utsMode', 'cgroupnsMode',
    'usernsMode', 'pidsLimit', 'memory', 'memorySwap',
    'nanoCpus', 'runtime', 'restartPolicy', 'autoRemove', 'logConfig', 'tmpfs', 'ulimits',
    'devices', 'deviceRequests', 'portBindings', 'publishAllPorts', 'oomKillDisable',
    'oomScoreAdj', 'shmSize', 'init',
  ])
  if (record.readonlyRootfs !== true || record.privileged !== false || record.ipcMode !== 'none' ||
    record.pidMode !== '' || record.utsMode !== '' || record.cgroupnsMode !== 'private' ||
    record.usernsMode !== '' || record.autoRemove !== false || record.publishAllPorts !== false ||
    record.oomKillDisable !== false || record.oomScoreAdj !== 0 || record.init !== false) {
    throw invalid()
  }
  const capAdd = stringArray(record.capAdd, budget)
  const capDrop = stringArray(record.capDrop, budget)
  const securityOpt = stringArray(record.securityOpt, budget)
  if (capAdd.length !== 0 || capDrop.length !== 1 || capDrop[0] !== 'ALL' ||
    securityOpt.length !== 2 || securityOpt[0] !== 'no-new-privileges=true' ||
    securityOpt[1] !== 'seccomp=builtin') throw invalid()
  const restart = exact(record.restartPolicy, ['name', 'maximumRetryCount'])
  if (restart.name !== 'no' || restart.maximumRetryCount !== 0) throw invalid()
  const log = exact(record.logConfig, ['type', 'config'])
  if (log.type !== 'local' && log.type !== 'none') throw invalid()
  if (!Array.isArray(record.ulimits) || utilTypes.isProxy(record.ulimits) ||
    Object.getPrototypeOf(record.ulimits) !== Array.prototype || record.ulimits.length !== 1) throw invalid()
  const ulimitSource = properties(record.ulimits, true)
  const ulimit = exact(ulimitSource['0']!.value, ['name', 'soft', 'hard'])
  if (ulimit.name !== 'nofile') throw invalid()
  const memory = integer(record.memory, 1)
  const memorySwap = integer(record.memorySwap, 1)
  if (memorySwap !== memory) throw invalid()
  return Object.freeze({
    networkMode: record.networkMode === 'none' ? 'none' : (() => { throw invalid() })(),
    readonlyRootfs: true,
    privileged: false,
    capAdd,
    capDrop,
    securityOpt,
    groupAdd: requireEmptyArray(record.groupAdd),
    sysctls: requireEmptyRecord(record.sysctls),
    maskedPaths: exactStringSet(record.maskedPaths, DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2, budget),
    readonlyPaths: exactStringSet(record.readonlyPaths, DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2, budget),
    ipcMode: 'none',
    pidMode: '',
    utsMode: '',
    cgroupnsMode: 'private',
    usernsMode: '',
    pidsLimit: integer(record.pidsLimit, 1),
    memory,
    memorySwap,
    nanoCpus: integer(record.nanoCpus, 1),
    runtime: string(record.runtime, budget),
    restartPolicy: Object.freeze({ name: 'no', maximumRetryCount: 0 }),
    autoRemove: false,
    logConfig: Object.freeze({ type: log.type, config: stringMap(log.config, budget) }),
    tmpfs: stringMap(record.tmpfs, budget),
    ulimits: Object.freeze([Object.freeze({
      name: 'nofile', soft: integer(ulimit.soft, 1), hard: integer(ulimit.hard, 1),
    })]),
    devices: requireEmptyArray(record.devices),
    deviceRequests: requireEmptyArray(record.deviceRequests),
    portBindings: requireEmptyRecord(record.portBindings),
    publishAllPorts: false,
    oomKillDisable: false,
    oomScoreAdj: 0,
    shmSize: integer(record.shmSize, 1),
    init: false,
  })
}

function normalizeExpectedMounts(
  value: unknown,
  budget: Budget,
): readonly DockerContainerSelectedProjectionMountV2[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 1) throw invalid()
  const source = properties(value, true)
  const keys = Object.keys(source).filter(key => key !== 'length')
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid()
  return Object.freeze(keys.map(key => {
    const mount = exact(source[key]!.value, [
      'type', 'source', 'destination', 'readOnly', 'propagation',
    ])
    if (mount.type !== 'bind' || (mount.destination !== '/input' && mount.destination !== '/work') ||
      typeof mount.readOnly !== 'boolean' || mount.propagation !== 'rprivate') throw invalid()
    const sourcePath = string(mount.source, budget)
    if (!sourcePath.startsWith('/') || sourcePath === '/') throw invalid()
    return Object.freeze({
      type: 'bind' as const,
      source: sourcePath,
      destination: mount.destination,
      readOnly: mount.readOnly,
      propagation: 'rprivate' as const,
    })
  }))
}

function expectedProjection(value: unknown): ExpectedOwnedDockerContainerProjectionV2 {
  const budget: Budget = { textBytes: 0 }
  const record = exact(value, [
    'version', 'resourceKind', 'sidecarKind', 'role', 'imageId', 'config', 'hostConfig', 'mounts',
  ])
  if (record.version !== 2 || record.resourceKind !== 'container' ||
    (record.sidecarKind !== 'whisper' && record.sidecarKind !== 'lease-bound-docker-bash') ||
    record.role !== 'worker' ||
    typeof record.imageId !== 'string' || !IMAGE_CONFIG_ID.test(record.imageId)) throw invalid()
  const projection = Object.freeze({
    version: 2,
    resourceKind: 'container',
    sidecarKind: record.sidecarKind,
    role: record.role,
    imageId: record.imageId,
    config: normalizeExpectedConfig(record.config, budget),
    hostConfig: normalizeExpectedHostConfig(record.hostConfig, budget),
    mounts: normalizeExpectedMounts(record.mounts, budget),
  })
  validateSelectedSidecarPolicy(projection)
  return projection
}

export function hashExpectedOwnedDockerContainerProjectionV2(value: unknown): string {
  try {
    return hashProjection(expectedProjection(value))
  } catch {
    throw invalid()
  }
}

export function normalizeOwnedDockerContainerInspectProjectionV2(
  value: unknown,
): ObservedOwnedDockerContainerProjectionV2 {
  try {
    const budget: Budget = { textBytes: 0 }
    const record = document(value, ['Image', 'Config', 'HostConfig', 'Mounts'])
    if (typeof record.Image !== 'string' || !IMAGE_CONFIG_ID.test(record.Image)) throw invalid()
    const rawConfig = document(record.Config, ['Labels'])
    const labels = stringMap(rawConfig.Labels, budget, true)
    const identity = sidecarIdentity(labels)
    const projection = Object.freeze({
      version: 2 as const,
      resourceKind: 'container' as const,
      ...identity,
      imageId: record.Image,
      config: normalizeConfig(record.Config, budget, 'required'),
      hostConfig: normalizeHostConfig(record.HostConfig, budget),
      mounts: normalizeMounts(record.Mounts, budget),
    })
    validateSelectedSidecarPolicy(projection)
    return Object.freeze({
      version: 2,
      resourceKind: 'container',
      sidecarKind: identity.sidecarKind,
      role: identity.role,
      imageId: record.Image,
      projectionHash: hashProjection(projection),
    })
  } catch {
    throw invalid()
  }
}

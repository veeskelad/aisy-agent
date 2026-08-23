import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeDockerEngineUnixSocketBindingHash,
  isNodeOwnedDockerEngineRecoveryBroker,
  makeNodeOwnedDockerEngineRecoveryBroker,
  OwnedDockerEngineRecoveryBrokerError,
  PINNED_DOCKER_ENGINE_API_IDENTITY,
  type DockerEnginePinnedEndpointIdentityV1,
} from './docker-engine-pinned-session.js'
import {
  normalizeOwnedDockerContainerInspectV2,
} from './execution-owned-docker-observed-v2.js'
import {
  captureOwnedDockerRecoveryAuthorityEpoch,
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
  reconcileOwnedDockerResources,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerCreateDescriptorV2,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerRecoveryBoundContainerCleanupPermitV1,
  type OwnedDockerRecoveryLedger,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const CONTAINER_ID = '1'.repeat(64)
const MASKED_PATHS = [
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
  '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware',
].sort()
const READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']
const HASHES = Object.freeze({
  installation: 'a'.repeat(64),
  owner: 'b'.repeat(64),
  session: 'c'.repeat(64),
  operation: 'd'.repeat(64),
  policy: 'e'.repeat(64),
})
const INSTALLATION_FILTER = encodeURIComponent(JSON.stringify({
  label: [`com.aisy.resource.installation=${HASHES.installation}`],
}))
const cleanups: Array<() => Promise<void>> = []
let bootstrapActivationDepth = 0

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function fixture(handler: Handler): Promise<Readonly<{
  root: string
  socketPath: string
  server: Server
}>> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-recovery-broker-')))
  const socketPath = join(root, 'engine.sock')
  const server = createServer((request, response) => {
    if (bootstrapActivationDepth > 0) {
      if (routeAttestation(request, response)) return
      if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
        json(response, [])
        return
      }
    }
    handler(request, response)
  })
  await listen(server, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  return Object.freeze({ root, socketPath, server })
}

function json(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function versionDocument(): Record<string, unknown> {
  return { Version: SERVER_VERSION, ApiVersion: '1.55', MinAPIVersion: '1.40' }
}

function infoDocument(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { ID: SERVER_ID, ServerVersion: SERVER_VERSION, ...overrides }
}

function labels(): Record<string, string> {
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': HASHES.installation,
    'com.aisy.resource.owner': HASHES.owner,
    'com.aisy.resource.session': HASHES.session,
    'com.aisy.resource.operation': HASHES.operation,
    'com.aisy.resource.kind': 'lease-bound-docker-bash',
    'com.aisy.resource.role': 'worker',
    'com.aisy.resource.policy': HASHES.policy,
  }
}

function labelsFromExpected(expected: OwnedDockerObservedResourceV2): Record<string, string> {
  const value = expected.labels
  return {
    'com.aisy.resource.version': value.version,
    'com.aisy.resource.installation': value.installationId,
    'com.aisy.resource.owner': value.ownerBindingHash,
    'com.aisy.resource.session': value.sessionBindingHash,
    'com.aisy.resource.operation': value.operationBindingHash,
    'com.aisy.resource.kind': value.sidecarKind,
    'com.aisy.resource.role': value.role,
    'com.aisy.resource.policy': value.policyHash,
  }
}

function containerDocument(expected?: OwnedDockerObservedResourceV2): Record<string, unknown> {
  return {
    Id: expected?.objectId ?? CONTAINER_ID,
    Name: `/${expected?.name ?? 'aisy-bash-worker-1234567890abcdef12345678'}`,
    Image: `sha256:${'4'.repeat(64)}`,
    Config: {
      Image: `example.invalid/worker@sha256:${'3'.repeat(64)}`,
      User: '65532:65532',
      Env: ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8'],
      Entrypoint: ['/bin/sh'],
      Cmd: ['-lc', 'printf dormant-bash'],
      WorkingDir: '/work',
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: expected === undefined ? labels() : labelsFromExpected(expected),
      Healthcheck: { Test: ['NONE'] },
      StopSignal: 'SIGTERM',
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      GroupAdd: [],
      Sysctls: {},
      MaskedPaths: [...MASKED_PATHS],
      ReadonlyPaths: [...READONLY_PATHS],
      IpcMode: 'none',
      PidMode: '',
      UTSMode: '',
      CgroupnsMode: 'private',
      UsernsMode: '',
      PidsLimit: 64,
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Runtime: 'runc',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      LogConfig: { Type: 'local', Config: { 'max-file': '1', 'max-size': '1048576', compress: 'false' } },
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700' },
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
      PublishAllPorts: false,
      OomKillDisable: false,
      OomScoreAdj: 0,
      ShmSize: 64 * 1024 * 1024,
      Init: false,
    },
    Mounts: [{
      Type: 'bind',
      Source: '/private/var/aisy/workspace',
      Destination: '/work',
      RW: true,
      Propagation: 'rprivate',
      Name: '',
    }],
  }
}

function identity(socketPath: string): DockerEnginePinnedEndpointIdentityV1 {
  return {
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: PINNED_DOCKER_ENGINE_API_IDENTITY,
  }
}

function emptyLedgerAuthority(
  socketPath: string,
  installationId = HASHES.installation,
): OwnedDockerRecoveryLedger {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-recovery-authority-')))
  const root = join(base, 'ledger')
  const endpointIdentity = identity(socketPath)
  const activation = initializeOwnedDockerResourceLedger({
    root,
    installationId,
    endpointIdentity,
  })
  const authority = openActivatedOwnedDockerResourceLedger({ root, activation })
  cleanups.push(async () => {
    authority.close()
    rmSync(base, { recursive: true, force: true })
  })
  return authority
}

function broker(socketPath: string, authority: OwnedDockerRecoveryLedger) {
  return makeNodeOwnedDockerEngineRecoveryBroker({
    socketPath,
    endpointIdentity: identity(socketPath),
    authority,
    timeoutMs: 1_000,
  })
}

async function activateEmptyAuthority(
  authority: OwnedDockerRecoveryLedger,
  socketPath: string,
  docker: OwnedDockerAttestedCommandPort,
) {
  bootstrapActivationDepth += 1
  try {
    return await authority.activateAfterInstallationZero(docker, broker(socketPath, authority))
  } finally {
    bootstrapActivationDepth -= 1
  }
}

class BindingDocker implements OwnedDockerAttestedCommandPort {
  readonly resources = new Map<string, OwnedDockerObservedResourceV2>()
  removalAmbiguous = false

  constructor(readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1) {}

  add(
    descriptor: OwnedDockerCreateDescriptorV2,
    objectId: string,
    projectionHashV1: string,
    endpoints = 0,
  ): void {
    this.resources.set(objectId, Object.freeze({
      version: 2,
      objectId,
      resourceKind: descriptor.resourceKind,
      name: descriptor.name,
      labels: descriptor.labels,
      createProjectionContract: descriptor.createProjectionContract,
      createProjectionHash: descriptor.createProjectionHash,
      projectionHashV1,
      networkEndpointCount: descriptor.resourceKind === 'network' ? endpoints : null,
    }))
  }

  async probe() { return { kind: 'compatible' as const } }
  async scanInstallation(installationId: string) {
    return { kind: 'ok' as const, resources: [...this.resources.values()]
      .filter(resource => resource.labels.installationId === installationId) }
  }
  async inspectById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    const resource = this.resources.get(input.objectId)
    return resource === undefined ? { kind: 'absent' as const } : { kind: 'found' as const, resource }
  }
  async inspectByName(input: { resourceKind: OwnedDockerResourceKind; name: string }) {
    const resource = [...this.resources.values()].find(item =>
      item.resourceKind === input.resourceKind && item.name === input.name)
    return resource === undefined ? { kind: 'absent' as const } : { kind: 'found' as const, resource }
  }
  async removeById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    if (this.removalAmbiguous) return { kind: 'ambiguous' as const }
    return this.resources.delete(input.objectId)
      ? { kind: 'removed' as const } : { kind: 'absent' as const }
  }
}

async function ledgerAuthority(
  socketPath: string,
  operationCount = 1,
): Promise<OwnedDockerRecoveryLedger> {
  const authority = emptyLedgerAuthority(socketPath)
  const docker = new BindingDocker(identity(socketPath))
  await reconcileOwnedDockerResources({ ledger: authority, docker })
  const active = (await activateEmptyAuthority(authority, socketPath, docker)).activeEpoch
  const containerProjection = normalizeOwnedDockerContainerInspectV2(containerDocument())
  for (let index = 0; index < operationCount; index += 1) {
    const operation = active.prepare({
      version: 2,
      sidecarKind: 'lease-bound-docker-bash',
      policyHash: HASHES.policy,
      resources: [{
        version: 2,
        role: 'worker',
        resourceKind: 'container',
        createProjectionContract: 'container-selected-v2',
        createProjectionHash: containerProjection.createProjectionHash,
      }],
    })
    await operation.create('worker', async descriptor => {
      docker.add(
        descriptor,
        String(index + 1).repeat(64),
        containerProjection.projectionHashV1,
      )
    })
  }
  docker.removalAmbiguous = true
  await expect(reconcileOwnedDockerResources({ ledger: authority, docker }))
    .rejects.toMatchObject({ code: 'OWNED_DOCKER_REMOVAL_AMBIGUOUS' })
  return authority
}

function expectedResource(
  authority: OwnedDockerRecoveryLedger,
  role: 'worker' = 'worker',
): OwnedDockerObservedResourceV2 {
  const operations = authority.listOperations()
  const matches = operations.flatMap(operation => operation.resources
    .filter(resource => resource.role === role && resource.phase === 'bound')
    .map(resource => ({ operation, resource })))
  const objectId = matches[0]?.resource.objectId
  const projectionHashV1 = matches[0]?.resource.boundProjectionHashV1
  if (matches.length !== 1 || objectId === null || objectId === undefined ||
    projectionHashV1 === null || projectionHashV1 === undefined) {
    throw new Error('invalid bound authority fixture')
  }
  const { operation, resource } = matches[0]!
  return Object.freeze({
    version: 2,
    objectId,
    resourceKind: resource.resourceKind,
    name: resource.name,
    labels: Object.freeze({
      version: '1',
      installationId: operation.installationId,
      ownerBindingHash: operation.ownerBindingHash,
      sessionBindingHash: operation.sessionBindingHash,
      operationBindingHash: operation.operationBindingHash,
      sidecarKind: operation.sidecarKind,
      role: resource.role,
      policyHash: operation.policyHash,
    }),
    createProjectionContract: resource.createProjectionContract,
    createProjectionHash: resource.createProjectionHash,
    projectionHashV1,
    networkEndpointCount: null,
  })
}

async function plannedAuthority(
  socketPath: string,
  phase: 'prepared' | 'attempted',
): Promise<Readonly<{
  authority: OwnedDockerRecoveryLedger
  expected: OwnedDockerObservedResourceV2
}>> {
  const authority = emptyLedgerAuthority(socketPath)
  const docker = emptyDocker(socketPath)
  await reconcileOwnedDockerResources({ ledger: authority, docker })
  const active = (await activateEmptyAuthority(authority, socketPath, docker)).activeEpoch
  const projection = normalizeOwnedDockerContainerInspectV2(containerDocument())
  const operation = active.prepare({
    version: 2,
    sidecarKind: 'lease-bound-docker-bash',
    policyHash: HASHES.policy,
    resources: [{
      version: 2,
      role: 'worker',
      resourceKind: 'container',
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: projection.createProjectionHash,
    }],
  })
  if (phase === 'attempted') {
    await expect(operation.create('worker', async () => {
      throw new Error('create response lost')
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
  }
  const operationRow = authority.listOperations()[0]!
  const resource = operationRow.resources[0]!
  const expected = Object.freeze({
    version: 2 as const,
    objectId: CONTAINER_ID,
    resourceKind: resource.resourceKind,
    name: resource.name,
    labels: Object.freeze({
      version: '1' as const,
      installationId: operationRow.installationId,
      ownerBindingHash: operationRow.ownerBindingHash,
      sessionBindingHash: operationRow.sessionBindingHash,
      operationBindingHash: operationRow.operationBindingHash,
      sidecarKind: operationRow.sidecarKind,
      role: resource.role,
      policyHash: operationRow.policyHash,
    }),
    createProjectionContract: resource.createProjectionContract,
    createProjectionHash: resource.createProjectionHash,
    projectionHashV1: projection.projectionHashV1,
    networkEndpointCount: null,
  })
  const ambiguousScan: OwnedDockerAttestedCommandPort = {
    ...emptyDocker(socketPath),
    async scanInstallation() { return { kind: 'ambiguous' as const } },
  }
  await expect(reconcileOwnedDockerResources({ ledger: authority, docker: ambiguousScan }))
    .rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
  return Object.freeze({ authority, expected })
}

function emptyDocker(socketPath: string): OwnedDockerAttestedCommandPort {
  return {
    endpointIdentity: identity(socketPath),
    async probe() { return { kind: 'compatible' as const } },
    async scanInstallation() { return { kind: 'ok' as const, resources: [] } },
    async inspectById() { return { kind: 'absent' as const } },
    async inspectByName() { return { kind: 'absent' as const } },
    async removeById() { return { kind: 'absent' as const } },
  }
}

function routeAttestation(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url === '/v1.54/version') {
    json(response, versionDocument())
    return true
  }
  if (request.url === '/v1.54/info') {
    json(response, infoDocument())
    return true
  }
  return false
}

function productionTypeScriptSources(
  directory: URL,
  prefix = '',
): ReadonlyArray<Readonly<{ name: string; source: string }>> {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) {
      return entry.name === '__test_support__' ? [] : productionTypeScriptSources(url, name)
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) return []
    return [{ name, source: readFileSync(url, 'utf8') }]
  })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('parent-owned Docker Engine recovery broker', () => {
  it('atomically activates inside the final pinned installation-zero proof', async () => {
    const wire: string[] = []
    const sockets = new Set<Socket>()
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      wire.push(`${request.method ?? ''} ${request.url ?? ''}`)
      sockets.add(request.socket)
      if (routeAttestation(request, response)) return
      json(response, [])
    })
    authority = emptyLedgerAuthority(endpoint.socketPath)
    const docker = emptyDocker(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    const result = await authority.activateAfterInstallationZero(
      docker,
      recovery,
    )

    expect(() => captureOwnedDockerRecoveryAuthorityEpoch(authority)).toThrowError(
      expect.objectContaining({ code: 'OWNED_DOCKER_RECOVERY_REQUIRED' }),
    )
    expect(result).toMatchObject({
      kind: 'reconciled-and-activated', clearedOperations: 0, removedResources: 0,
    })
    expect(result.activeEpoch.epoch).toBe(1)
    expect(sockets.size).toBe(1)
    expect(wire).toEqual([
      'GET /v1.54/version',
      'GET /v1.54/info',
      `GET /v1.54/containers/json?all=1&filters=${INSTALLATION_FILTER}`,
      `GET /v1.54/networks?filters=${INSTALLATION_FILTER}`,
    ])
  })

  it.each([
    ['containers', 'non-empty', [{}]],
    ['containers', 'malformed', { unexpected: true }],
    ['networks', 'non-empty', [{}]],
    ['networks', 'malformed', { unexpected: true }],
  ] as const)('keeps recovery mode when %s installation list is %s', async (stage, _name, body) => {
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      json(response, request.url?.includes(`/${stage}`) ? body : [])
    })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(authority.activateAfterInstallationZero(
      emptyDocker(endpoint.socketPath),
      recovery,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(captureOwnedDockerRecoveryAuthorityEpoch(authority)).toBe(0)
  })

  it('burns a genuine activation permit in a genuine cross-ledger broker', async () => {
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      json(response, [])
    })
    const first = emptyLedgerAuthority(endpoint.socketPath)
    const second = emptyLedgerAuthority(endpoint.socketPath, 'f'.repeat(64))
    const firstEpoch = captureOwnedDockerRecoveryAuthorityEpoch(first)
    const secondEpoch = captureOwnedDockerRecoveryAuthorityEpoch(second)
    const crossLedgerBroker = broker(endpoint.socketPath, second)

    await expect(first.activateAfterInstallationZero(
      emptyDocker(endpoint.socketPath),
      crossLedgerBroker,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(captureOwnedDockerRecoveryAuthorityEpoch(first)).toBe(firstEpoch)
    expect(captureOwnedDockerRecoveryAuthorityEpoch(second)).toBe(secondEpoch)
  })

  it('rejects a structural broker copy before issuing a permit or socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      json(response, [])
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const copy = { ...recovery }

    await expect(authority.activateAfterInstallationZero(
      emptyDocker(endpoint.socketPath),
      copy,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
    expect(connections).toBe(0)
    expect(captureOwnedDockerRecoveryAuthorityEpoch(authority)).toBe(0)
  })

  it('does only version/info preflight for a forged activation permit', async () => {
    const wire: string[] = []
    const endpoint = await fixture((request, response) => {
      wire.push(`${request.method ?? ''} ${request.url ?? ''}`)
      if (routeAttestation(request, response)) return
      json(response, [])
    })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.activateAfterInstallationZero(
      Object.freeze({ version: 1 }) as never,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_DAEMON_AMBIGUOUS' })
    expect(wire).toEqual(['GET /v1.54/version', 'GET /v1.54/info'])
    expect(captureOwnedDockerRecoveryAuthorityEpoch(authority)).toBe(0)
  })

  it('keeps recovery and performs zero socket I/O for a pre-aborted activation', async () => {
    let connections = 0
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      json(response, [])
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const controller = new AbortController()
    controller.abort()

    await expect(authority.activateAfterInstallationZero(
      emptyDocker(endpoint.socketPath),
      recovery,
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(connections).toBe(0)
    expect(captureOwnedDockerRecoveryAuthorityEpoch(authority)).toBe(0)
  })

  it('rejects endpoint drift at the synchronous activation commit', async () => {
    let docker!: {
      endpointIdentity: DockerEnginePinnedEndpointIdentityV1
    } & OwnedDockerAttestedCommandPort
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if (request.url?.includes('/networks?')) {
        docker.endpointIdentity = { ...docker.endpointIdentity, serverId: 'docker-engine-replaced' }
      }
      json(response, [])
    })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    docker = emptyDocker(endpoint.socketPath) as {
      endpointIdentity: DockerEnginePinnedEndpointIdentityV1
    } & OwnedDockerAttestedCommandPort
    const recovery = broker(endpoint.socketPath, authority)

    await expect(authority.activateAfterInstallationZero(
      docker,
      recovery,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(captureOwnedDockerRecoveryAuthorityEpoch(authority)).toBe(0)
  })

  it('holds an installation-wide barrier through the final zero response', async () => {
    let networkReceived!: () => void
    let releaseNetwork!: () => void
    const received = new Promise<void>(resolve => { networkReceived = resolve })
    const release = new Promise<void>(resolve => { releaseNetwork = resolve })
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if (request.url?.includes('/networks?')) {
        networkReceived()
        void release.then(() => json(response, []))
        return
      }
      json(response, [])
    })
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const docker = emptyDocker(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const concurrent = broker(endpoint.socketPath, authority)
    const activating = authority.activateAfterInstallationZero(
      docker,
      recovery,
    )
    await received

    expect(() => authority.close()).toThrowError(expect.objectContaining({
      code: 'OWNED_DOCKER_LEDGER_BUSY',
    }))
    await expect(reconcileOwnedDockerResources({ ledger: authority, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    await expect(authority.activateAfterInstallationZero(
      docker,
      concurrent,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })

    releaseNetwork()
    await expect(activating).resolves.toMatchObject({ kind: 'reconciled-and-activated' })
  })

  it('removes an exact container and proves absence in one socket and exact wire order', async () => {
    const wire: Array<Readonly<{
      method: string | undefined
      url: string | undefined
    }>> = []
    const sockets = new Set<Socket>()
    let connections = 0
    let removed = false
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      wire.push({ method: request.method, url: request.url })
      sockets.add(request.socket)
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        removed = true
        response.writeHead(204)
        response.end()
        return
      }
      if (removed) return json(response, { message: 'gone' }, 404)
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const recovery = broker(endpoint.socketPath, authority)
    const expected = expectedResource(authority)

    await expect(recovery.removeExact(expected)).resolves.toBe('removed')
    await expect(recovery.removeExact(expected)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_ALREADY_USED',
    })

    expect(wire).toEqual([
      { method: 'GET', url: '/v1.54/version' },
      { method: 'GET', url: '/v1.54/info' },
      { method: 'GET', url: `/v1.54/containers/${CONTAINER_ID}/json` },
      { method: 'DELETE', url: `/v1.54/containers/${CONTAINER_ID}?v=1&force=1` },
      { method: 'GET', url: `/v1.54/containers/${CONTAINER_ID}/json` },
    ])
    expect(connections).toBe(1)
    expect(sockets.size).toBe(1)
  })

  it('returns absent from the first typed 404 without DELETE', async () => {
    const methods: string[] = []
    const endpoint = await fixture((request, response) => {
      methods.push(request.method ?? '')
      if (routeAttestation(request, response)) return
      json(response, { message: 'localized' }, 404)
    })
    const authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(expectedResource(authority))).resolves.toBe('absent')
    expect(methods).toEqual(['GET', 'GET', 'GET'])
  })

  it('clears one bound worker only after exact removal and installation-wide zero proof', async () => {
    const wire: string[] = []
    let removed = false
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      wire.push(`${request.method ?? ''} ${request.url ?? ''}`)
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        removed = true
        response.writeHead(204)
        response.end()
        return
      }
      if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
        return json(response, [])
      }
      if (removed) return json(response, { message: 'gone' }, 404)
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const operationBindingHash = authority.listOperations()[0]!.operationBindingHash
    const recovery = broker(endpoint.socketPath, authority)

    await expect(authority.recoverBoundContainer(
      operationBindingHash,
      (expected, permit) => {
        expect(expected).toEqual(expectedResource(authority))
        return recovery.removeBoundContainer(permit)
      },
    )).resolves.toEqual({ kind: 'completed', clearedOperations: 1, removedResources: 1 })

    expect(authority.listOperations()).toEqual([])
    expect(wire).toEqual([
      'GET /v1.54/version',
      'GET /v1.54/info',
      `GET /v1.54/containers/${CONTAINER_ID}/json`,
      `DELETE /v1.54/containers/${CONTAINER_ID}?v=1&force=1`,
      `GET /v1.54/containers/${CONTAINER_ID}/json`,
      `GET /v1.54/containers/json?all=1&filters=${INSTALLATION_FILTER}`,
      `GET /v1.54/networks?filters=${INSTALLATION_FILTER}`,
    ])
    const docker = emptyDocker(endpoint.socketPath)
    await expect(reconcileOwnedDockerResources({ ledger: authority, docker }))
      .resolves.toMatchObject({ kind: 'completed' })
    await expect(activateEmptyAuthority(authority, endpoint.socketPath, docker))
      .resolves.toMatchObject({ kind: 'reconciled-and-activated' })
  })

  it('recovers crash after DELETE before durable clear without a second DELETE', async () => {
    const methods: string[] = []
    let removed = false
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      methods.push(request.method ?? '')
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        removed = true
        response.writeHead(204)
        response.end()
        return
      }
      if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
        return json(response, [])
      }
      if (removed) return json(response, { message: 'gone' }, 404)
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const operationBindingHash = authority.listOperations()[0]!.operationBindingHash
    const first = broker(endpoint.socketPath, authority)

    await expect(authority.recoverBoundContainer(
      operationBindingHash,
      async (_expected, permit) => {
        await first.removeBoundContainer(permit)
        throw new Error('simulated parent crash before durable clear')
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_REMOVAL_AMBIGUOUS' })
    expect(authority.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
    })

    const second = broker(endpoint.socketPath, authority)
    await expect(authority.recoverBoundContainer(
      operationBindingHash,
      (_expected, permit) => second.removeBoundContainer(permit),
    )).resolves.toEqual({ kind: 'completed', clearedOperations: 1, removedResources: 0 })
    expect(methods.filter(method => method === 'DELETE')).toHaveLength(1)
    expect(authority.listOperations()).toEqual([])
  })

  it.each(['non-empty', 'malformed'] as const)(
    'keeps bound intent when final installation-wide zero proof is %s', async mode => {
    let removed = false
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        removed = true
        response.writeHead(204)
        response.end()
        return
      }
      if (request.url?.includes('/containers/json?')) {
        if (mode === 'malformed') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{')
          return
        }
        return json(response, [{ Id: 'foreign' }])
      }
      if (request.url?.includes('/networks?')) return json(response, [])
      if (removed) return json(response, { message: 'gone' }, 404)
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const operationBindingHash = authority.listOperations()[0]!.operationBindingHash
    const recovery = broker(endpoint.socketPath, authority)

    await expect(authority.recoverBoundContainer(
      operationBindingHash,
      (_expected, permit) => recovery.removeBoundContainer(permit),
    )).rejects.toMatchObject({
      code: 'OWNED_DOCKER_REMOVAL_AMBIGUOUS',
    })
    expect(authority.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
    })
    },
  )

  it('rejects forged cleanup permits and outcomes without durable clear', async () => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (routeAttestation(request, response)) return
      json(response, { message: 'must not reach object I/O' }, 500)
    })
    const authority = await ledgerAuthority(endpoint.socketPath)
    const operationBindingHash = authority.listOperations()[0]!.operationBindingHash
    const recovery = broker(endpoint.socketPath, authority)
    const forgedPermit = Object.freeze({
      version: 1,
      operationBindingHash,
      role: 'worker',
      objectId: CONTAINER_ID,
    }) as unknown as OwnedDockerRecoveryBoundContainerCleanupPermitV1

    await expect(recovery.removeBoundContainer(forgedPermit)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST',
    })
    expect(urls).toEqual(['/v1.54/version', '/v1.54/info'])
    await expect(authority.recoverBoundContainer(
      operationBindingHash,
      async () => ({ version: 1, kind: 'removed' }) as never,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
    expect(authority.listOperations()[0]!.resources[0]!.phase).toBe('bound')
  })

  it('allows only one destructive installation cleanup dispatch at a time', async () => {
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath, 2)
    const [firstOperation, secondOperation] = authority.listOperations()
    let rejectFirst!: (error: Error) => void
    const first = authority.recoverBoundContainer(
      firstOperation!.operationBindingHash,
      () => new Promise((_resolve, reject) => { rejectFirst = reject }),
    )
    await new Promise<void>(resolve => setImmediate(resolve))

    await expect(authority.recoverBoundContainer(
      secondOperation!.operationBindingHash,
      async () => ({ version: 1, kind: 'removed' }) as never,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    const firstRejected = expect(first).rejects.toMatchObject({
      code: 'OWNED_DOCKER_REMOVAL_AMBIGUOUS',
    })
    rejectFirst(new Error('finish first cleanup dispatch'))
    await firstRejected
    expect(authority.listOperations()).toHaveLength(2)
  })

  it('refuses restricted-clone v4 prepare without ledger or Engine mutation', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = emptyLedgerAuthority(endpoint.socketPath)
    const docker = emptyDocker(endpoint.socketPath)
    await reconcileOwnedDockerResources({ ledger: authority, docker })
    const active = (await activateEmptyAuthority(authority, endpoint.socketPath, docker)).activeEpoch
    endpoint.server.on('connection', () => { connections += 1 })
    const before = authority.listOperations()

    expect(() => active.prepare({
      version: 2,
      sidecarKind: 'restricted-clone',
      policyHash: HASHES.policy,
      resources: [
        { version: 2, role: 'worker', resourceKind: 'container',
          createProjectionContract: 'container-selected-v2', createProjectionHash: '1'.repeat(64) },
        { version: 2, role: 'gateway', resourceKind: 'container',
          createProjectionContract: 'container-selected-v2', createProjectionHash: '2'.repeat(64) },
        { version: 2, role: 'network', resourceKind: 'network',
          createProjectionContract: 'network-full-v1', createProjectionHash: '3'.repeat(64) },
      ],
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    expect(authority.listOperations()).toEqual(before)
    expect(connections).toBe(0)
  })

  it('refuses an ownership mismatch without DELETE', async () => {
    const methods: string[] = []
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      methods.push(request.method ?? '')
      if (routeAttestation(request, response)) return
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const expected = expectedResource(authority)
    const mismatched = { ...expected, name: 'different-owned-name' }
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(mismatched)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN',
    })
    expect(methods).not.toContain('DELETE')
  })

  it('requires one exact bound ledger row and never mutates either ledger', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const source = await ledgerAuthority(endpoint.socketPath)
    const expected = expectedResource(source)
    const empty = emptyLedgerAuthority(endpoint.socketPath)
    const foreign = emptyLedgerAuthority(endpoint.socketPath, 'f'.repeat(64))
    endpoint.server.on('connection', () => { connections += 1 })
    const emptyBefore = empty.listOperations()
    const foreignBefore = foreign.listOperations()

    await expect(broker(endpoint.socketPath, empty).removeExact(expected))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN' })
    await expect(broker(endpoint.socketPath, foreign).removeExact(expected))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN' })

    expect(empty.listOperations()).toEqual(emptyBefore)
    expect(foreign.listOperations()).toEqual(foreignBefore)
    expect(connections).toBe(0)
  })

  it('rejects every mismatched ledger identity field before socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const expected = expectedResource(authority)
    const before = authority.listOperations()
    const withLabels = (
      labelsOverride: Partial<OwnedDockerObservedResourceV2['labels']>,
    ): OwnedDockerObservedResourceV2 => ({
      ...expected,
      labels: { ...expected.labels, ...labelsOverride },
    })
    const mismatches: readonly OwnedDockerObservedResourceV2[] = [
      withLabels({ ownerBindingHash: '1'.repeat(64) }),
      withLabels({ sessionBindingHash: '2'.repeat(64) }),
      withLabels({ operationBindingHash: '3'.repeat(64) }),
      withLabels({ policyHash: '4'.repeat(64) }),
      { ...expected, name: 'aisy-different-resource' },
      { ...expected, createProjectionHash: '5'.repeat(64) },
      { ...expected, projectionHashV1: '7'.repeat(64) },
      { ...expected, objectId: '6'.repeat(64) },
    ]
    for (const mismatch of mismatches) {
      await expect(broker(endpoint.socketPath, authority).removeExact(mismatch))
        .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN' })
    }

    expect(authority.listOperations()).toEqual(before)
    expect(connections).toBe(0)
  })

  it.each(['prepared', 'attempted'] as const)(
    'rejects an exact-looking %s ledger row before socket I/O',
    async phase => {
      let connections = 0
      const endpoint = await fixture((_request, response) => json(response, versionDocument()))
      const planned = await plannedAuthority(endpoint.socketPath, phase)
      endpoint.server.on('connection', () => { connections += 1 })
      const before = planned.authority.listOperations()

      await expect(broker(endpoint.socketPath, planned.authority).removeExact(planned.expected))
        .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_OWNERSHIP_UNPROVEN' })

      expect(planned.authority.listOperations()).toEqual(before)
      expect(connections).toBe(0)
    },
  )

  it('treats a lost DELETE response as removal ambiguity and never reconnects', async () => {
    let connections = 0
    const methods: string[] = []
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      methods.push(request.method ?? '')
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        request.socket.destroy()
        return
      }
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(expectedResource(authority)))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS' })
    expect(methods).toEqual(['GET', 'GET', 'GET', 'DELETE'])
    expect(connections).toBe(1)
  })

  it.each([
    ['inspect', 500, 'OWNED_DOCKER_RECOVERY_BROKER_DAEMON_AMBIGUOUS'],
    ['delete', 409, 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS'],
  ] as const)('normalizes an unexpected %s status to a stable code', async (stage, status, code) => {
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if ((stage === 'inspect' && request.method === 'GET') ||
        (stage === 'delete' && request.method === 'DELETE')) return json(response, {}, status)
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(expectedResource(authority)))
      .rejects.toMatchObject({ code, message: code })
  })

  it('rejects endpoint identity drift before inspect or DELETE', async () => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      json(response, infoDocument({ ID: 'replacement-engine' }))
    })
    const authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(expectedResource(authority)))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH' })
    expect(urls).toEqual(['/v1.54/version', '/v1.54/info'])
  })

  it('rejects a real authority bound to a different endpoint without socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })

    expect(() => makeNodeOwnedDockerEngineRecoveryBroker({
      socketPath: endpoint.socketPath,
      endpointIdentity: { ...identity(endpoint.socketPath), serverId: 'different-engine' },
      authority,
    })).toThrowError(expect.objectContaining({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_ENDPOINT_MISMATCH',
    }))
    expect(connections).toBe(0)
  })

  it('rejects socket inode replacement without contacting the replacement', async () => {
    let endpoint!: Awaited<ReturnType<typeof fixture>>
    let replacementRequests = 0
    let authority!: OwnedDockerRecoveryLedger
    const replace = async (): Promise<void> => {
      unlinkSync(endpoint.socketPath)
      const replacement = createServer((_request, response) => {
        replacementRequests += 1
        json(response, versionDocument())
      })
      await listen(replacement, endpoint.socketPath)
      cleanups.push(async () => {
        replacement.closeAllConnections()
        if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()))
      })
    }
    endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') {
        void replace().then(() => json(response, infoDocument()))
        return
      }
      json(response, containerDocument(expectedResource(authority)))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(expectedResource(authority)))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_DAEMON_AMBIGUOUS' })
    expect(replacementRequests).toBe(0)
  })

  it('rejects a pre-aborted signal without socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const controller = new AbortController()
    controller.abort()
    const authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const recovery = broker(endpoint.socketPath, authority)

    await expect(recovery.removeExact(
      expectedResource(authority),
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_ABORTED' })
    expect(connections).toBe(0)
  })

  it('treats abort after DELETE starts as removal ambiguity', async () => {
    let deleteReceived!: () => void
    const received = new Promise<void>(resolve => { deleteReceived = resolve })
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        deleteReceived()
        return
      }
      json(response, containerDocument(expectedResource(authority)))
    })
    const controller = new AbortController()
    authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const pending = recovery.removeExact(
      expectedResource(authority),
      { signal: controller.signal },
    )
    await received

    controller.abort()

    await expect(pending).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS',
    })
  })

  it('rejects a real but closed recovery authority before socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const expected = expectedResource(authority)
    authority.close()
    endpoint.server.on('connection', () => { connections += 1 })

    await expect(recovery.removeExact(expected))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST' })
    expect(connections).toBe(0)
  })

  it('rejects a stale broker after recovery activation without socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    const stale = broker(endpoint.socketPath, authority)
    const expected = expectedResource(authority)
    const docker = emptyDocker(endpoint.socketPath)
    await reconcileOwnedDockerResources({ ledger: authority, docker })
    await activateEmptyAuthority(authority, endpoint.socketPath, docker)
    endpoint.server.on('connection', () => { connections += 1 })

    await expect(stale.removeExact(expected))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST' })
    expect(connections).toBe(0)
  })

  it.each(['version', 'inspect', 'delete'] as const)(
    'blocks activation and ledger close while a recovery dispatch waits at %s',
    async stage => {
      let stageReceived!: () => void
      let releaseStage!: () => void
      const received = new Promise<void>(resolve => { stageReceived = resolve })
      const release = new Promise<void>(resolve => { releaseStage = resolve })
      let removed = false
      let authority!: OwnedDockerRecoveryLedger
      const endpoint = await fixture((request, response) => {
        if (request.url === '/v1.54/version') {
          if (stage === 'version') {
            stageReceived()
            void release.then(() => json(response, versionDocument()))
            return
          }
          return json(response, versionDocument())
        }
        if (request.url === '/v1.54/info') return json(response, infoDocument())
        if (request.method === 'DELETE') {
          if (stage === 'delete') {
            stageReceived()
            void release.then(() => {
              removed = true
              response.writeHead(204)
              response.end()
            })
            return
          }
          removed = true
          response.writeHead(204)
          response.end()
          return
        }
        if (removed) return json(response, {}, 404)
        if (stage === 'inspect') {
          stageReceived()
          void release.then(() => json(response, containerDocument(expectedResource(authority))))
          return
        }
        json(response, containerDocument(expectedResource(authority)))
      })
      authority = await ledgerAuthority(endpoint.socketPath)
      const recovery = broker(endpoint.socketPath, authority)
      const operation = recovery.removeExact(expectedResource(authority))
      await received

      await expect(reconcileOwnedDockerResources({
        ledger: authority,
        docker: emptyDocker(endpoint.socketPath),
      })).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
      expect(() => authority.close()).toThrowError(expect.objectContaining({
        code: 'OWNED_DOCKER_LEDGER_BUSY',
      }))

      releaseStage()
      await expect(operation).resolves.toBe('removed')
      const docker = emptyDocker(endpoint.socketPath)
      await expect(reconcileOwnedDockerResources({ ledger: authority, docker }))
        .resolves.toMatchObject({ kind: 'completed' })
      await expect(activateEmptyAuthority(authority, endpoint.socketPath, docker))
        .resolves.toMatchObject({ kind: 'reconciled-and-activated' })
      expect(() => broker(endpoint.socketPath, authority)).toThrowError(expect.objectContaining({
        code: 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST',
      }))
    },
  )

  it('snapshots hostile expected/options without coercion or socket I/O', async () => {
    let connections = 0
    let getterCalls = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const realAuthority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const expected = expectedResource(realAuthority)
    const accessor = { ...expected } as Record<string, unknown>
    Object.defineProperty(accessor, 'objectId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return CONTAINER_ID
      },
    })
    const recovery = broker(endpoint.socketPath, realAuthority)

    await expect(recovery.removeExact(
      accessor as unknown as OwnedDockerObservedResourceV2,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID' })

    const requestOptions = {} as Record<string, unknown>
    Object.defineProperty(requestOptions, 'signal', {
      enumerable: true,
      get() {
        getterCalls += 1
        return new AbortController().signal
      },
    })
    const second = broker(endpoint.socketPath, realAuthority)
    await expect(second.removeExact(
      expected,
      requestOptions as Readonly<{ signal?: AbortSignal }>,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID' })

    const factoryOptions = {
      endpointIdentity: identity(endpoint.socketPath),
      authority: realAuthority,
    } as Record<string, unknown>
    Object.defineProperty(factoryOptions, 'socketPath', {
      enumerable: true,
      get() {
        getterCalls += 1
        return endpoint.socketPath
      },
    })
    expect(() => makeNodeOwnedDockerEngineRecoveryBroker(
      factoryOptions as unknown as Parameters<typeof makeNodeOwnedDockerEngineRecoveryBroker>[0],
    )).toThrowError(expect.objectContaining({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID',
    }))

    const fakeAccessor = {} as Record<string, unknown>
    Object.defineProperty(fakeAccessor, 'assertOwned', {
      enumerable: true,
      get() {
        getterCalls += 1
        return () => undefined
      },
    })
    const fakeAuthorities = [
      { assertOwned: () => undefined },
      { assertOwned: async () => undefined },
      { ...realAuthority, extra: true },
      fakeAccessor,
      new Proxy(realAuthority, {}),
    ]
    for (const authority of fakeAuthorities) {
      expect(() => makeNodeOwnedDockerEngineRecoveryBroker({
        socketPath: endpoint.socketPath,
        endpointIdentity: identity(endpoint.socketPath),
        authority: authority as unknown as OwnedDockerRecoveryLedger,
      })).toThrowError(expect.objectContaining({
        code: 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID',
      }))
    }
    expect(getterCalls).toBe(0)
    expect(connections).toBe(0)
  })

  it('rejects forged or overridden AbortSignals without invoking hostile code', async () => {
    let connections = 0
    let hostileCalls = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    endpoint.server.on('connection', () => { connections += 1 })
    const expected = expectedResource(authority)
    const ownAborted = new AbortController().signal
    Object.defineProperty(ownAborted, 'aborted', {
      get() {
        hostileCalls += 1
        return false
      },
    })
    const ownAdd = new AbortController().signal
    Object.defineProperty(ownAdd, 'addEventListener', {
      value() { hostileCalls += 1 },
    })
    const ownRemove = new AbortController().signal
    Object.defineProperty(ownRemove, 'removeEventListener', {
      value() { hostileCalls += 1 },
    })
    const symbolAccessor = new AbortController().signal
    Object.defineProperty(symbolAccessor, Symbol('hostile'), {
      get() {
        hostileCalls += 1
        return false
      },
    })
    const proxied = new Proxy(new AbortController().signal, {
      ownKeys(target) {
        hostileCalls += 1
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        hostileCalls += 1
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      getPrototypeOf(target) {
        hostileCalls += 1
        return Reflect.getPrototypeOf(target)
      },
    })
    const hostileSignals = [
      Object.create(AbortSignal.prototype) as AbortSignal,
      ownAborted,
      ownAdd,
      ownRemove,
      symbolAccessor,
      proxied,
    ]

    for (const signal of hostileSignals) {
      await expect(broker(endpoint.socketPath, authority).removeExact(expected, { signal }))
        .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_INPUT_INVALID' })
    }

    expect(hostileCalls).toBe(0)
    expect(connections).toBe(0)
    expect(() => authority.close()).not.toThrow()
  })

  it('lets lost authority dominate a hostile AbortSignal without invoking traps', async () => {
    let connections = 0
    let trapCalls = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const expected = expectedResource(authority)
    endpoint.server.on('connection', () => { connections += 1 })
    const signal = new Proxy(new AbortController().signal, {
      ownKeys(target) {
        trapCalls += 1
        return Reflect.ownKeys(target)
      },
    })
    authority.close()

    await expect(recovery.removeExact(expected, { signal }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_RECOVERY_BROKER_AUTHORITY_LOST' })
    expect(trapCalls).toBe(0)
    expect(connections).toBe(0)
  })

  it('is branded, one-shot, single-flight, close-draining and not wired into production', async () => {
    let releaseInspect!: () => void
    let inspectReceived!: () => void
    const received = new Promise<void>(resolve => { inspectReceived = resolve })
    const release = new Promise<void>(resolve => { releaseInspect = resolve })
    let removed = false
    let authority!: OwnedDockerRecoveryLedger
    const endpoint = await fixture((request, response) => {
      if (routeAttestation(request, response)) return
      if (request.method === 'DELETE') {
        removed = true
        response.writeHead(204)
        response.end()
        return
      }
      if (removed) return json(response, {}, 404)
      inspectReceived()
      void release.then(() => json(response, containerDocument(expectedResource(authority))))
    })
    authority = await ledgerAuthority(endpoint.socketPath)
    const recovery = broker(endpoint.socketPath, authority)
    const expected = expectedResource(authority)
    const structuralFake = {
      endpointIdentity: identity(endpoint.socketPath),
      removeExact: recovery.removeExact,
      close: recovery.close,
    }

    expect(isNodeOwnedDockerEngineRecoveryBroker(recovery)).toBe(true)
    expect(isNodeOwnedDockerEngineRecoveryBroker(structuralFake)).toBe(false)
    expect(Object.isFrozen(recovery)).toBe(true)
    const admitted = recovery.removeExact(expected)
    await received
    await expect(recovery.removeExact(expected)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_ALREADY_USED',
    })
    const closing = recovery.close()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    releaseInspect()
    await expect(admitted).resolves.toBe('removed')
    await expect(closing).resolves.toBeUndefined()
    await expect(recovery.close()).resolves.toBeUndefined()
    await expect(recovery.removeExact(expected)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_RECOVERY_BROKER_CLOSED',
    })

    const source = readFileSync(new URL('./docker-engine-pinned-session.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/node:child_process|\bdocker\s+(?:inspect|rm|network)\b/)
    const productionSources = productionTypeScriptSources(new URL('.', import.meta.url))
    const productionImporters = productionSources
      .filter(({ name }) => name !== 'docker-engine-pinned-session.ts')
      .filter(({ source: value }) => value.includes('makeNodeOwnedDockerEngineRecoveryBroker'))
      .map(({ name }) => name)
    expect(productionImporters).toEqual(['owned-docker-parent-recovery-manager.ts'])

    const activationAuthorityNames = [
      'consumeOwnedDockerRecoveryActivationPermitV1',
      'mintOwnedDockerAttestedRecoveryActivationOutcomeV1',
      'commitOwnedDockerRecoveryActivationOutcomeV1',
    ]
    const unauthorizedActivationImporters = productionSources
      .filter(({ name }) => name !== 'docker-engine-pinned-session.ts' &&
        name !== 'execution-owned-docker-resources.ts')
      .filter(({ source: value }) =>
        activationAuthorityNames.some(authorityName => value.includes(authorityName)))
      .map(({ name }) => name)
    expect(unauthorizedActivationImporters).toEqual([])
    const liveComposition = productionSources.find(({ name }) => name === 'bin/aisy.ts')?.source
    expect(liveComposition).toBeDefined()
    expect(liveComposition).not.toMatch(
      /makeNodeOwnedDockerEngineRecoveryBroker|makeNodeOwnedDockerParentRecoveryManager|activateAfterInstallationZero/,
    )
  })

  it('uses code-only errors', () => {
    const code = 'OWNED_DOCKER_RECOVERY_BROKER_REMOVAL_AMBIGUOUS' as const
    const error = new OwnedDockerEngineRecoveryBrokerError(code)
    expect(error.message).toBe(code)
    expect(Object.keys(error)).toEqual(['code', 'name'])
  })
})
